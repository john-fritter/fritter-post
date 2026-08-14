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
  parseBriefBatchOutput,
  parseWriterOutput,
} from "./prompt.js";
import type { WriterPacket } from "./assembler.js";

/** Words, counted the way a reader would — for the report, never enforced mid-call. */
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

interface WrittenPiece {
  storyId: number | null;
  rank: number;
  tier: string;
  ref: string;
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
): Promise<{ piece: WrittenPiece; inputTokens: number; outputTokens: number; failed: boolean }> {
  const { packet } = rendered;
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
        headline: parsed.headline,
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
    console.warn(`[writers] ${packet.ref}: call failed — ${msg}`);
    return {
      piece: failedPiece(packet, storyId, msg),
      inputTokens: 0,
      outputTokens: 0,
      failed: true,
    };
  }
}

async function writeBriefBatch(
  batch: Array<{ rendered: RenderedPacket; storyId: number | null }>,
  batchIndex: number,
  bio: string,
  runId: number,
  cfg: WritersStageConfig,
): Promise<{ pieces: WrittenPiece[]; inputTokens: number; outputTokens: number; failed: boolean }> {
  const packets = batch.map((b) => b.rendered.packet);
  const refs = packets.map((p) => p.ref);
  // The system prompt is identical for every piece; take the first.
  const systemPrompt = batch[0]!.rendered.systemPrompt;

  try {
    const result = await callWithBackoff(
      () =>
        callLLM({
          stage: "writers-briefs",
          stageRunId: runId,
          model: cfg.model,
          systemPrompt,
          userPrompt: buildBriefBatchUserPrompt(bio, packets),
          temperature: cfg.temperature,
          maxTokens: cfg.max_tokens,
          reasoningEffort: cfg.reasoning_effort,
          provider: cfg.provider,
          timeoutMs: cfg.timeout_ms,
          stream: cfg.stream,
        }),
      { retry_max_attempts: cfg.retry_max_attempts, retry_base_ms: cfg.retry_base_ms },
      `writers briefs ${batchIndex}`,
    );

    const parsed = parseBriefBatchOutput(result.text, refs);
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
        `[writers] brief batch ${batchIndex}: ${missing.length} of ${refs.length} brief(s) missing — re-asking for those`,
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
              userPrompt: buildBriefBatchUserPrompt(bio, stragglers),
              temperature: cfg.temperature,
              maxTokens: cfg.max_tokens,
              reasoningEffort: cfg.reasoning_effort,
              provider: cfg.provider,
              timeoutMs: cfg.timeout_ms,
              stream: cfg.stream,
            }),
          { retry_max_attempts: cfg.retry_max_attempts, retry_base_ms: cfg.retry_base_ms },
          `writers briefs ${batchIndex} straggler`,
        );
        inputTokens += retry.inputTokens ?? 0;
        outputTokens += retry.outputTokens ?? 0;
        for (const [ref, brief] of parseBriefBatchOutput(retry.text, missing)) {
          parsed.set(ref, brief);
        }
        missing = refs.filter((r) => !parsed.has(r));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[writers] brief batch ${batchIndex}: straggler call failed — ${msg}`);
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
    console.warn(`[writers] brief batch ${batchIndex}: call failed — ${msg}`);
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

  // Briefs are re-asked individually here rather than in a batch: a repair is a
  // handful of pieces, and one call each removes the batch's own failure mode.
  const results = await Promise.all(
    targets.map((rendered) =>
      limiter(async () => {
        if (rendered.packet.tier !== "brief") {
          return writeOnePiece(rendered, rendered.packet.storyId ?? null, runId, cfg);
        }
        const batch = [{ rendered, storyId: rendered.packet.storyId ?? null }];
        const batchResult = await writeBriefBatch(batch, 0, bio, runId, cfg);
        return {
          piece: batchResult.pieces[0]!,
          inputTokens: batchResult.inputTokens,
          outputTokens: batchResult.outputTokens,
          failed: batchResult.failed,
        };
      }),
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

  const longform = selected.filter((p) => p.packet.tier !== "brief");
  const briefs = selected.filter((p) => p.packet.tier === "brief");

  console.log(
    `[writers] run #${runId}: ${selected.length} piece(s) from editor run #${editorRunId} — ` +
      `${longform.length} individual call(s), ${briefs.length} brief(s) in batches of ${cfg.brief_batch_size}`,
  );

  const storyIdOf = (rendered: RenderedPacket) => rendered.packet.storyId ?? null;

  const limiter = pLimit(cfg.concurrency);
  const pieces: WrittenPiece[] = [];
  let calls = 0;
  let failedCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const longformResults = await Promise.all(
    longform.map((rendered) =>
      limiter(() => writeOnePiece(rendered, storyIdOf(rendered), runId, cfg)),
    ),
  );
  for (const r of longformResults) {
    pieces.push(r.piece);
    calls++;
    if (r.failed) failedCalls++;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
  }

  const batches: Array<Array<{ rendered: RenderedPacket; storyId: number | null }>> = [];
  for (let i = 0; i < briefs.length; i += cfg.brief_batch_size) {
    batches.push(
      briefs.slice(i, i + cfg.brief_batch_size).map((rendered) => ({
        rendered,
        storyId: storyIdOf(rendered),
      })),
    );
  }

  const batchResults = await Promise.all(
    batches.map((batch, i) => limiter(() => writeBriefBatch(batch, i, bio, runId, cfg))),
  );
  for (const r of batchResults) {
    pieces.push(...r.pieces);
    calls++;
    if (r.failed) failedCalls++;
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
  }

  pieces.sort((a, b) => a.rank - b.rank);

  for (const piece of pieces) {
    await pool.query(
      `INSERT INTO writer_pieces
         (run_id, editor_story_id, rank, tier, ref, headline, body, word_count,
          material_level, source_count, articles_used, status, detail, generation_log_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
      ],
    );
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
