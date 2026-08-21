/**
 * The writers stage: packets in, the paper's own prose out.
 *
 * One call per feature and standard piece; briefs go in batches, because 75
 * separate calls would each re-send the bio and the standing memo and the
 * scaffolding would outweigh the writing.
 *
 * **A failed call is a row, not an exception.** The paper is a daily artifact
 * with a deadline; one writer call that times out must cost one piece, not the
 * edition. Failures are written as `status='failed'` pieces with the reason, the
 * run continues, and `writer_runs.failed_calls` says how much of the paper is
 * missing without anyone reading stdout. Every call goes through
 * `callWithBackoff` — this is a batched, concurrent stage, which is exactly the
 * shape CLAUDE.md says needs it.
 *
 * What this stage does *not* do: judge. It does not decide what runs, in what
 * order, at what length, or from which sources — the prefilter, grouping-pass-1,
 * the editor and the assembler settled all of that. It writes.
 */

import "dotenv/config";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig, type WritersStageConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { callWithBackoff } from "../../llm/backoff.js";
import { buildEditorRunPackets, loadWriterDocs, type RenderedPacket } from "./packets.js";
import {
  buildBriefBatchUserPrompt,
  type BriefBatchKind,
  parseBriefBatchOutput,
  parseWriterOutput,
} from "./prompt.js";
import type { WriterPacket } from "./assembler.js";

/**
 * Stops a run that is failing because the provider is down rather than because
 * any piece is hard.
 *
 * Run #4 met an outage: `zai-org/glm-5.2` broke streams call after call, and
 * because `callWithBackoff` retries broken streams, 103 logical calls became
 * **807 provider attempts, 775 of them errors**. The run took 31 minutes to
 * produce 17 pieces, and the repair pass took another 34 to add 22 more. Every
 * one of those attempts was polite, bounded, and pointless: nothing about the
 * hundredth request was going to succeed where the first ninety-nine did not.
 *
 * So the stage watches for the pattern. After a run of consecutive failures it
 * stops asking, records the rest as failed pieces, and says what to do — the
 * repair pass already exists and re-writes exactly the missing ones. An hour of
 * hammering is replaced by a minute and a clear message.
 *
 * Consecutive, not a rate: one hard piece failing among successes is a piece
 * problem, and a hundred failing in a row is an outage. Only the second is worth
 * abandoning a run over.
 */
export class FailureBreaker {
  private consecutive = 0;
  private tripped = false;

  constructor(private readonly threshold: number) {}

  record(ok: boolean): void {
    if (this.threshold <= 0) return;
    if (ok) {
      this.consecutive = 0;
      return;
    }
    this.consecutive++;
    if (this.consecutive >= this.threshold) this.tripped = true;
  }

  get isOpen(): boolean {
    return this.tripped;
  }

  get consecutiveFailures(): number {
    return this.consecutive;
  }
}

/** Words, counted the way a reader would — for the report, never enforced mid-call. */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

interface WrittenPiece {
  storyId: number | null;
  rank: number;
  tier: string;
  ref: string;
  sectionRef: string | null;
  sectionTitle: string | null;
  sectionRole: string | null;
  sectionRank: number;
  headline: string | null;
  body: string | null;
  wordCount: number;
  materialLevel: string;
  sourceCount: number;
  articlesUsed: number;
  status: "ok" | "failed";
  detail: string | null;
  generationLogId: bigint | null;
}

/**
 * Writes one piece to the database as soon as its call returns.
 *
 * The run used to hold every piece in memory and insert them all after the last
 * call finished, which meant anything that killed the process first — a SIGTERM,
 * a crash, an operator stopping a run that looked stuck — threw away every
 * completed call. Run #29 made 94 attempts, 90 of them successful, and persisted
 * **zero** rows: the tokens were spent, the writing existed, and none of it could
 * be recovered, not even by `--repair`, because there were no failed rows to
 * repair and no run to repair them into.
 *
 * That is the same rule the stage already applies to a failed call — a row, not
 * an exception — extended to the process itself. A killed run should cost the
 * calls still in flight, never the calls already answered.
 *
 * Insert order no longer matters: every reader of `writer_pieces` sorts by rank
 * and section_rank explicitly.
 */
async function persistPiece(runId: number, piece: WrittenPiece): Promise<void> {
  await getPool().query(
    `INSERT INTO writer_pieces
       (run_id, editor_story_id, rank, tier, ref, headline, body, word_count,
        material_level, source_count, articles_used, status, detail, generation_log_id,
        section_ref, section_title, section_role, section_rank)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
    [
      runId,
      piece.storyId,
      piece.rank,
      piece.tier,
      piece.ref,
      piece.headline,
      piece.body,
      piece.wordCount,
      piece.materialLevel,
      piece.sourceCount,
      piece.articlesUsed,
      piece.status,
      piece.detail,
      piece.generationLogId !== null ? piece.generationLogId.toString() : null,
      piece.sectionRef,
      piece.sectionTitle,
      piece.sectionRole,
      piece.sectionRank,
    ],
  );
}

function failedPiece(
  packet: WriterPacket,
  storyId: number | null,
  detail: string,
  generationLogId: bigint | null = null,
): WrittenPiece {
  return {
    storyId,
    rank: packet.rank,
    tier: packet.tier,
    ref: packet.ref,
    sectionRef: packet.section?.ref ?? null,
    sectionTitle: packet.section?.title ?? null,
    sectionRole: packet.section?.role ?? null,
    sectionRank: packet.section?.rank ?? 0,
    headline: null,
    body: null,
    wordCount: 0,
    materialLevel: packet.materialLevel,
    sourceCount: packet.sourceCount,
    articlesUsed: packet.articles.length,
    status: "failed",
    detail,
    generationLogId,
  };
}

async function writeOnePiece(
  rendered: RenderedPacket,
  storyId: number | null,
  runId: number,
  cfg: WritersStageConfig,
  breaker: FailureBreaker,
): Promise<{ piece: WrittenPiece; inputTokens: number; outputTokens: number; failed: boolean }> {
  const { packet } = rendered;
  if (breaker.isOpen) {
    return {
      piece: failedPiece(packet, storyId, "not attempted: run aborted after repeated provider failures"),
      inputTokens: 0,
      outputTokens: 0,
      failed: false,
    };
  }
  try {
    const result = await callWithBackoff(
      () =>
        callLLM({
          stage: "writers",
          stageRunId: runId,
          model: cfg.model,
          systemPrompt: rendered.systemPrompt,
          userPrompt: rendered.userPrompt,
          temperature: cfg.temperature,
          maxTokens: cfg.max_tokens,
          reasoningEffort: cfg.reasoning_effort,
          provider: cfg.provider,
          timeoutMs: cfg.timeout_ms,
          stream: cfg.stream,
        }),
      { retry_max_attempts: cfg.retry_max_attempts, retry_base_ms: cfg.retry_base_ms },
      `writers ${packet.ref}`,
    );

    breaker.record(true);

    const parsed = parseWriterOutput(result.text);
    if (!parsed) {
      console.warn(`[writers] ${packet.ref}: output had no recognizable headline line`);
      return {
        piece: failedPiece(packet, storyId, "unparseable output", result.generationLogId),
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        failed: false, // the call succeeded; the output did not
      };
    }

    return {
      piece: {
        storyId,
        rank: packet.rank,
        tier: packet.tier,
        ref: packet.ref,
        sectionRef: packet.section?.ref ?? null,
        sectionTitle: packet.section?.title ?? null,
        sectionRole: packet.section?.role ?? null,
        sectionRank: packet.section?.rank ?? 0,
        // A section line has no headline on either path. The individual prompt
        // asks for one because every other tier needs it; a line that is one
        // sentence would just repeat itself, which is what all 7 of run #34's
        // batched lines did before the batch contract dropped the field.
        headline: packet.section?.role === "line" ? null : parsed.headline,
        body: parsed.body,
        wordCount: countWords(parsed.body),
        materialLevel: packet.materialLevel,
        sourceCount: packet.sourceCount,
        articlesUsed: packet.articles.length,
        status: "ok",
        detail: null,
        generationLogId: result.generationLogId,
      },
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      failed: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    breaker.record(false);
    console.warn(`[writers] ${packet.ref}: call failed — ${msg}`);
    return {
      piece: failedPiece(packet, storyId, msg),
      inputTokens: 0,
      outputTokens: 0,
      failed: true,
    };
  }
}

/**
 * Splits a paper's packets into the three call shapes.
 *
 * Everything longer than a paragraph gets its own call. Briefs and section
 * lines both batch, but never in the same call: a brief is a short paragraph
 * and a line is one sentence, and run #8 sent them together and got briefs back
 * for both — lines at 40 to 47 words against a 15-30 target. One call, one
 * register.
 *
 * **A sidebar is never batched, whatever tier it lands on.** Only
 * `buildWriterUserPrompt` renders `sectionInstruction`, so a batched sidebar is
 * written with no idea it belongs to a section and no idea what the lead
 * covers — and the batch prompt tells it the opposite of the truth, that the
 * items around it are unrelated. Run #10's T4 sent three sidebars through the
 * brief batch and got three unrelated briefs filed under a heading, which is
 * the exact failure sections exist to prevent. A standard-tier thread yields at
 * most `max_sidebars` of them, so the cost is a few calls per paper.
 */
export function partitionByCallShape<T extends { packet: WriterPacket }>(
  packets: T[],
): { longform: T[]; briefs: T[]; lines: T[] } {
  const role = (p: T) => p.packet.section?.role ?? null;
  const isLine = (p: T) => role(p) === "line";
  const batchable = (p: T) => p.packet.tier === "brief" && role(p) !== "sidebar";
  return {
    longform: packets.filter((p) => !isLine(p) && !batchable(p)),
    briefs: packets.filter((p) => !isLine(p) && batchable(p)),
    lines: packets.filter(isLine),
  };
}

async function writeBriefBatch(
  batch: Array<{ rendered: RenderedPacket; storyId: number | null }>,
  batchIndex: number,
  bio: string,
  runId: number,
  cfg: WritersStageConfig,
  breaker: FailureBreaker,
  kind: BriefBatchKind = "brief",
): Promise<{ pieces: WrittenPiece[]; inputTokens: number; outputTokens: number; failed: boolean }> {
  const label = kind === "line" ? "line" : "brief";
  const packets = batch.map((b) => b.rendered.packet);
  const refs = packets.map((p) => p.ref);
  // The system prompt is identical for every piece; take the first.
  const systemPrompt = batch[0]!.rendered.systemPrompt;

  if (breaker.isOpen) {
    return {
      pieces: batch.map(({ rendered, storyId }) =>
        failedPiece(rendered.packet, storyId, "not attempted: run aborted after repeated provider failures"),
      ),
      inputTokens: 0,
      outputTokens: 0,
      failed: false,
    };
  }

  try {
    const result = await callWithBackoff(
      () =>
        callLLM({
          stage: "writers-briefs",
          stageRunId: runId,
          model: cfg.model,
          systemPrompt,
          userPrompt: buildBriefBatchUserPrompt(bio, packets, kind),
          temperature: cfg.temperature,
          maxTokens: cfg.max_tokens,
          reasoningEffort: cfg.reasoning_effort,
          provider: cfg.provider,
          timeoutMs: cfg.timeout_ms,
          stream: cfg.stream,
        }),
      { retry_max_attempts: cfg.retry_max_attempts, retry_base_ms: cfg.retry_base_ms },
      `writers ${label}s ${batchIndex}`,
    );

    breaker.record(true);

    const parsed = parseBriefBatchOutput(result.text, refs, kind);
    let missing = refs.filter((r) => !parsed.has(r));
    let inputTokens = result.inputTokens ?? 0;
    let outputTokens = result.outputTokens ?? 0;

    // One bounded second pass for whatever the batch dropped. Run #3 lost a
    // brief this way — the call succeeded and nine of ten briefs came back — and
    // re-asking for the stragglers alone costs one small call rather than a hole
    // in the paper. Only once: if the model will not write it twice, that is an
    // answer.
    if (missing.length > 0) {
      console.warn(
        `[writers] ${label} batch ${batchIndex}: ${missing.length} of ${refs.length} ${label}(s) missing — re-asking for those`,
      );
      const stragglers = packets.filter((p) => missing.includes(p.ref));
      try {
        const retry = await callWithBackoff(
          () =>
            callLLM({
              stage: "writers-briefs",
              stageRunId: runId,
              model: cfg.model,
              systemPrompt,
              userPrompt: buildBriefBatchUserPrompt(bio, stragglers, kind),
              temperature: cfg.temperature,
              maxTokens: cfg.max_tokens,
              reasoningEffort: cfg.reasoning_effort,
              provider: cfg.provider,
              timeoutMs: cfg.timeout_ms,
              stream: cfg.stream,
            }),
          { retry_max_attempts: cfg.retry_max_attempts, retry_base_ms: cfg.retry_base_ms },
          `writers ${label}s ${batchIndex} straggler`,
        );
        inputTokens += retry.inputTokens ?? 0;
        outputTokens += retry.outputTokens ?? 0;
        for (const [ref, brief] of parseBriefBatchOutput(retry.text, missing, kind)) {
          parsed.set(ref, brief);
        }
        missing = refs.filter((r) => !parsed.has(r));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[writers] ${label} batch ${batchIndex}: straggler call failed — ${msg}`);
      }
    }

    const pieces = batch.map(({ rendered, storyId }) => {
      const brief = parsed.get(rendered.packet.ref);
      if (!brief) {
        return failedPiece(
          rendered.packet,
          storyId,
          "not present in the batch output",
          result.generationLogId,
        );
      }
      return {
        storyId,
        rank: rendered.packet.rank,
        tier: rendered.packet.tier,
        ref: rendered.packet.ref,
        sectionRef: rendered.packet.section?.ref ?? null,
        sectionTitle: rendered.packet.section?.title ?? null,
        sectionRole: rendered.packet.section?.role ?? null,
        sectionRank: rendered.packet.section?.rank ?? 0,
        headline: brief.headline,
        body: brief.body,
        wordCount: countWords(brief.body),
        materialLevel: rendered.packet.materialLevel,
        sourceCount: rendered.packet.sourceCount,
        articlesUsed: rendered.packet.articles.length,
        status: "ok" as const,
        detail: null,
        generationLogId: result.generationLogId,
      };
    });

    return { pieces, inputTokens, outputTokens, failed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    breaker.record(false);
    console.warn(`[writers] ${label} batch ${batchIndex}: call failed — ${msg}`);
    // A failed batch costs its briefs, not the paper.
    return {
      pieces: batch.map(({ rendered, storyId }) => failedPiece(rendered.packet, storyId, msg)),
      inputTokens: 0,
      outputTokens: 0,
      failed: true,
    };
  }
}

export interface WriterRunSummary {
  runId: number;
  editorRunId: number;
  piecesIn: number;
  piecesWritten: number;
  piecesFailed: number;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Re-writes only the failed pieces of an existing run, updating them in place.
 *
 * A paper is one run. Run #3 finished with 147 of 150 pieces and three holes,
 * and the choice was between publishing the holes or re-writing 150 pieces to
 * fill three. Neither is right for a daily artifact, so a repair pass re-asks
 * for exactly what is missing and updates those rows — the run stays one paper,
 * and the cost is proportional to the damage.
 */
export async function repairWriterRun(runId: number): Promise<WriterRunSummary> {
  const pool = getPool();
  const cfg = loadModelConfig().writers;

  const { rows: runRows } = await pool.query<{ editor_run_id: number; pieces_in: number }>(
    "SELECT editor_run_id, pieces_in FROM writer_runs WHERE id = $1",
    [runId],
  );
  const run = runRows[0];
  if (!run) throw new Error(`Writer run #${runId} not found`);

  const { rows: failedRows } = await pool.query<{ rank: number; ref: string }>(
    "SELECT rank, ref FROM writer_pieces WHERE run_id = $1 AND status = 'failed' ORDER BY rank",
    [runId],
  );
  if (failedRows.length === 0) {
    console.log(`[writers] run #${runId}: nothing to repair`);
    return fetchRunSummary(pool, runId);
  }

  const failedRefs = new Set(failedRows.map((r) => r.ref));
  const all = await buildEditorRunPackets(run.editor_run_id);
  const targets = all.filter((p) => failedRefs.has(p.packet.ref));

  console.log(
    `[writers] repairing run #${runId}: ${targets.length} of ${failedRows.length} failed piece(s) resolved to packets`,
  );

  const { bio } = loadWriterDocs();
  const limiter = pLimit(cfg.concurrency);
  const breaker = new FailureBreaker(cfg.abort_after_consecutive_failures);

  // **Every repaired piece is an individual call, briefs included.** This used to
  // send a brief through `writeBriefBatch` as a batch of one, which kept the
  // batch's own failure mode: the parser is keyed on the ref, so a model that
  // does not echo `S60468;;` exactly produces no row at all and the piece fails
  // again for the same reason it failed the first time. Run #31's S60468
  // survived two repair passes that way, both recording "not present in the
  // batch output".
  //
  // Every packet carries a full individual prompt from `buildWriterUserPrompt`
  // whatever its tier, complete with its target length and its section
  // instruction, and `parseWriterOutput` reads that back forgivingly with no ref
  // to echo. The batch exists to amortise the bio and the standing memo across
  // 75 briefs; at one piece there is nothing to amortise and only the risk left.
  const results = await Promise.all(
    targets.map((rendered) =>
      limiter(() =>
        writeOnePiece(rendered, rendered.packet.storyId ?? null, runId, cfg, breaker),
      ),
    ),
  );

  let repaired = 0;
  for (const { piece } of results) {
    if (piece.status !== "ok") {
      console.warn(`[writers] repair ${piece.ref}: still failing — ${piece.detail ?? ""}`);
      continue;
    }
    await pool.query(
      `UPDATE writer_pieces
       SET headline = $1, body = $2, word_count = $3, status = 'ok', detail = NULL,
           generation_log_id = $4
       WHERE run_id = $5 AND ref = $6`,
      [
        piece.headline,
        piece.body,
        piece.wordCount,
        piece.generationLogId !== null ? piece.generationLogId.toString() : null,
        runId,
        piece.ref,
      ],
    );
    repaired++;
  }

  const { rows: counts } = await pool.query<{ ok: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE status = 'ok') AS ok,
            count(*) FILTER (WHERE status = 'failed') AS failed
     FROM writer_pieces WHERE run_id = $1`,
    [runId],
  );
  await pool.query(
    `UPDATE writer_runs SET pieces_written = $1, pieces_failed = $2 WHERE id = $3`,
    [Number(counts[0]!.ok), Number(counts[0]!.failed), runId],
  );

  console.log(
    `[writers] repair of run #${runId}: ${repaired} piece(s) recovered, ${counts[0]!.failed} still missing`,
  );
  if (breaker.isOpen) {
    console.warn(
      `[writers] repair ABORTED after ${cfg.abort_after_consecutive_failures} consecutive failures — ` +
        `the provider is still failing. Try again later; repair is safe to re-run.`,
    );
  }

  return fetchRunSummary(pool, runId);
}

async function fetchRunSummary(
  pool: import("pg").Pool,
  runId: number,
): Promise<WriterRunSummary> {
  const { rows } = await pool.query<{
    id: number;
    editor_run_id: number;
    pieces_in: number;
    pieces_written: number;
    pieces_failed: number;
    calls: number;
    failed_calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
  }>("SELECT * FROM writer_runs WHERE id = $1", [runId]);
  const r = rows[0]!;
  return {
    runId: r.id,
    editorRunId: r.editor_run_id,
    piecesIn: r.pieces_in,
    piecesWritten: r.pieces_written,
    piecesFailed: r.pieces_failed,
    calls: r.calls,
    failedCalls: r.failed_calls,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
  };
}

export interface RunWritersOptions {
  editorRunId: number;
  /** Restrict to one tier, for a first cautious run. */
  tier?: string;
  /** Cap the number of pieces written. */
  limit?: number;
}

export async function runWriters(options: RunWritersOptions): Promise<WriterRunSummary> {
  const pool = getPool();
  const cfg = loadModelConfig().writers;
  const { editorRunId, tier, limit } = options;

  const all = await buildEditorRunPackets(editorRunId);
  let selected = tier ? all.filter((p) => p.packet.tier === tier) : all;
  if (limit !== undefined) selected = selected.slice(0, limit);

  if (selected.length === 0) {
    throw new Error(`Editor run #${editorRunId} yielded no packets to write`);
  }

  const { bio } = loadWriterDocs();

  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO writer_runs (started_at, editor_run_id, model_used, pieces_in)
     VALUES (NOW(), $1, $2, $3) RETURNING id`,
    [editorRunId, cfg.model, selected.length],
  );
  const runId = runRows[0]!.id;

  const { longform, briefs, lines } = partitionByCallShape(selected);

  console.log(
    `[writers] run #${runId}: ${selected.length} piece(s) from editor run #${editorRunId} — ` +
      `${longform.length} individual call(s), ${briefs.length} brief(s) and ${lines.length} ` +
      `section line(s) in batches of ${cfg.brief_batch_size}`,
  );

  const storyIdOf = (rendered: RenderedPacket) => rendered.packet.storyId ?? null;

  const limiter = pLimit(cfg.concurrency);
  const breaker = new FailureBreaker(cfg.abort_after_consecutive_failures);
  const pieces: WrittenPiece[] = [];
  let calls = 0;
  let failedCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const longformResults = await Promise.all(
    longform.map((rendered) =>
      limiter(async () => {
        const result = await writeOnePiece(rendered, storyIdOf(rendered), runId, cfg, breaker);
        await persistPiece(runId, result.piece);
        return result;
      }),
    ),
  );
  for (const r of longformResults) {
    pieces.push(r.piece);
    calls++;
    if (r.failed) failedCalls++;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
  }

  type BriefBatch = {
    items: Array<{ rendered: RenderedPacket; storyId: number | null }>;
    kind: BriefBatchKind;
  };
  const batches: BriefBatch[] = [];
  for (const [kind, pool] of [
    ["brief", briefs],
    ["line", lines],
  ] as Array<[BriefBatchKind, RenderedPacket[]]>) {
    for (let i = 0; i < pool.length; i += cfg.brief_batch_size) {
      batches.push({
        kind,
        items: pool.slice(i, i + cfg.brief_batch_size).map((rendered) => ({
          rendered,
          storyId: storyIdOf(rendered),
        })),
      });
    }
  }

  const batchResults = await Promise.all(
    batches.map((batch, i) =>
      limiter(async () => {
        const result = await writeBriefBatch(batch.items, i, bio, runId, cfg, breaker, batch.kind);
        for (const piece of result.pieces) await persistPiece(runId, piece);
        return result;
      }),
    ),
  );
  for (const r of batchResults) {
    pieces.push(...r.pieces);
    calls++;
    if (r.failed) failedCalls++;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
  }

  const written = pieces.filter((p) => p.status === "ok").length;
  const failed = pieces.length - written;

  await pool.query(
    `UPDATE writer_runs
     SET completed_at = NOW(), pieces_written = $1, pieces_failed = $2,
         calls = $3, failed_calls = $4, input_tokens = $5, output_tokens = $6
     WHERE id = $7`,
    [written, failed, calls, failedCalls, inputTokens, outputTokens, runId],
  );

  console.log(
    `[writers] run #${runId} complete: ${written} written, ${failed} failed, ` +
      `${calls} call(s), ${failedCalls} failed call(s)`,
  );
  if (breaker.isOpen) {
    console.warn(
      `[writers] ABORTED: ${cfg.abort_after_consecutive_failures} consecutive call failures — ` +
        `the provider is failing, not the material. ${written} piece(s) written. ` +
        `Run \`npm run write -- --repair ${runId}\` once it recovers; it re-writes only what is missing.`,
    );
  }
  if (failed > 0) {
    console.warn(`[writers] WARNING: ${failed} piece(s) have no text — the paper is short by that many`);
  }

  return {
    runId,
    editorRunId,
    piecesIn: selected.length,
    piecesWritten: written,
    piecesFailed: failed,
    calls,
    failedCalls,
    inputTokens,
    outputTokens,
  };
}
