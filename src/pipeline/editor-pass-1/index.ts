import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM, type LLMProvider } from "../../llm/index.js";
import { callWithBackoff } from "../../llm/backoff.js";
import { getClusteringItems } from "../preprocessor/assembler.js";
import { englishTitle, englishBodyExcerpt, excerpt } from "../../lib/text.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type EditorPass1BatchItem,
} from "./prompt.js";

const BIO_PATH = path.join(import.meta.dirname, "..", "..", "..", "docs", "bio.md");

const BIO_FALLBACK =
  "(Reader bio not yet written. Apply generic editorial judgment when scoring: " +
  "score routine sports results, celebrity tabloid items, routine financial market " +
  "noise, and generic wire filler near zero. Score substantive news from credible " +
  "sources higher. Use the full 0–100 range.)";

function loadBio(): string {
  try {
    const content = readFileSync(BIO_PATH, "utf-8").trim();
    return content.length > 0 ? content : BIO_FALLBACK;
  } catch {
    return BIO_FALLBACK;
  }
}

export interface EditorPass1ItemResult {
  id: number;
  /** interest + consequence, 0-100. The authoritative value everything downstream reads. */
  score: number;
  /** Bio-relevance axis, 0-50. Null when the line was fail-safed. */
  interest: number | null;
  /** Event-weight axis, 0-50. Null when the line was fail-safed. */
  consequence: number | null;
  reason: string;
}

/** Axis bound. Two axes of 0-50 sum to the same 0-100 scale the pipeline already uses. */
const AXIS_MAX = 50;

/** Sum used when a line is missing or unparseable — the midpoint, as before. */
/**
 * The score an item carries when it could not be scored.
 *
 * **Was 50, which is a fabricated judgment, not an absent one.** 50 sits in the
 * middle of the 0–100 range and therefore *competes* — run #42's pile cutoff was
 * 54 and four unscored clusters fell below it; run #40's cutoff was 49 and an
 * unscored row went into the paper. Whether an unjudged item reached the reader
 * was decided by where the day's cutoff happened to land.
 *
 * 0 says what is true: no judgment was made. The pile ranks by score and takes
 * the top `pile_target`, so an unscored row is taken only when there are not
 * enough judged rows to fill the paper — which, at ~480 scored rows for 150
 * slots, is never in normal operation. It also means a total provider outage
 * still produces a paper rather than an empty one, because every row is then
 * equally unscored and the pile fills as before.
 *
 * The alternative was excluding unscored rows outright. That is right in normal
 * operation and catastrophic in the outage case, and 0 gets the first without
 * buying the second.
 */
const FAIL_SAFE_SCORE = 0;

function clampAxis(value: number): number {
  return Math.max(0, Math.min(AXIS_MAX, value));
}

export interface EditorPass1BatchParseResult {
  mode: "line";
  results: EditorPass1ItemResult[];
  parsedLineCount: number;
  failSafeCount: number;
}

export function parseBatchOutput(
  text: string,
  expectedIds?: number[],
): EditorPass1BatchParseResult | null {
  if (expectedIds === undefined) return null;

  const expected = new Set(expectedIds);
  const parsed = new Map<number, EditorPass1ItemResult>();

  // Format: id;;interest;;consequence;;reason
  // The reason is last so any ;; inside it cannot shift a numeric column.
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !/^\d+/.test(line)) continue;

    const firstDelimiter = line.indexOf(";;");
    if (firstDelimiter === -1) continue;
    const secondDelimiter = line.indexOf(";;", firstDelimiter + 2);
    if (secondDelimiter === -1) continue;
    const thirdDelimiter = line.indexOf(";;", secondDelimiter + 2);
    if (thirdDelimiter === -1) continue;

    const idField = line.slice(0, firstDelimiter).trim();
    const interestField = line.slice(firstDelimiter + 2, secondDelimiter).trim();
    const consequenceField = line.slice(secondDelimiter + 2, thirdDelimiter).trim();
    const reason = line.slice(thirdDelimiter + 2).trim();

    if (!/^\d+$/.test(idField)) continue;
    if (!/^-?\d+$/.test(interestField)) continue;
    if (!/^-?\d+$/.test(consequenceField)) continue;
    if (reason.length === 0) continue;

    const id = Number.parseInt(idField, 10);
    if (!expected.has(id) || parsed.has(id)) continue;

    const interest = clampAxis(Number.parseInt(interestField, 10));
    const consequence = clampAxis(Number.parseInt(consequenceField, 10));
    parsed.set(id, { id, score: interest + consequence, interest, consequence, reason });
  }

  const results = expectedIds.map((id) =>
    parsed.get(id) ?? {
      id,
      score: FAIL_SAFE_SCORE,
      interest: null,
      consequence: null,
      reason: "fail-safe: missing/invalid line",
    },
  );

  return {
    mode: "line",
    results,
    parsedLineCount: parsed.size,
    failSafeCount: expectedIds.length - parsed.size,
  };
}

// --- GROUPING PASS-1 ---

export interface GroupingPass1Run {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  groupingRunId: number;
  modelUsed: string;
  itemsIn: number;
}

interface GroupingDigestRow {
  id: number;
  preprocessor_run_id: number;
  digest: string | null;
  completed_at: string | null;
}

interface GroupingPass1RunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  grouping_run_id: number;
  model_used: string;
  items_in: number;
}

export interface ParsedGroupingCluster {
  clusterIndex: number;
  title: string;
  summary: string;
  memberIds: number[];
}

export function parseGroupingDigest(digest: string): ParsedGroupingCluster[] {
  const clusters: ParsedGroupingCluster[] = [];
  let clusterIndex = 0;
  for (const rawLine of digest.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue;
    const title = line.slice(0, first).trim();
    const summary = line.slice(first + 2, last).trim();
    const idPart = line.slice(last + 2).trim();
    const memberIds: number[] = [];
    for (const tok of idPart.split(",")) {
      const t = tok.trim();
      if (/^\d+$/.test(t)) memberIds.push(parseInt(t, 10));
    }
    if (title && memberIds.length > 0) {
      clusters.push({ clusterIndex, title, summary, memberIds });
      clusterIndex++;
    }
  }
  return clusters;
}

/**
 * Scores one batch, and says whether it had to fall back.
 *
 * **This stage is batched, concurrent, and had no retry at all.** CLAUDE.md has
 * said since 2026-07-25 that any such stage needs `callWithBackoff`, because the
 * failure mode is quiet — a rate-limited call returns a degraded-but-valid-
 * looking result and the run reports success while losing work. Grouping-pass-1
 * was the stage that rule was written about and the one place it was never
 * applied: `callWithBackoff` was not even imported. At `concurrency: 10`, the
 * highest in the pipeline, one 429 on the first and only attempt defaulted a
 * whole batch of 40 items.
 *
 * Run #42 is what that costs: one 429 sent clusters C80–C83 into the pile
 * competition carrying a fabricated score. They happened to fall below that
 * run's cutoff of 54. Run #40's cutoff was 49, and a fail-safed row went into
 * the paper unjudged.
 */
async function processGroupingBatch(
  items: EditorPass1BatchItem[],
  batchIndex: number,
  batchCount: number,
  runId: number,
  model: string,
  temperature: number,
  maxTokens: number,
  systemPrompt: string,
  reasoningEffort: string | undefined,
  provider: LLMProvider | undefined,
  timeoutMs: number | undefined,
  stream: boolean | undefined,
  retryConfig: { retry_max_attempts?: number; retry_base_ms?: number },
  label = "",
): Promise<{ results: EditorPass1ItemResult[]; failed: boolean }> {
  try {
    const llmResult = await callWithBackoff(
      () => callLLM({
      stage: "grouping-pass-1",
      stageRunId: runId,
      model,
      systemPrompt,
      userPrompt: buildUserPrompt(items),
      temperature,
      maxTokens,
      reasoningEffort,
      provider,
      timeoutMs,
      stream,
      }),
      retryConfig,
      `grouping-pass-1 batch ${batchIndex + 1}/${batchCount}${label}`,
    );

    const expectedIds = items.map((item) => item.id);
    const parsed = parseBatchOutput(llmResult.text, expectedIds);
    if (parsed === null) {
      console.warn(
        `[grouping-pass-1] batch ${batchIndex + 1}/${batchCount}: parse failed — defaulting all ${items.length} items to score=50`,
      );
      return {
        results: items.map((item) => ({
          id: item.id,
          score: FAIL_SAFE_SCORE,
          interest: null,
          consequence: null,
          reason: "fail-safe: batch parse error",
        })),
        failed: true,
      };
    }

    const log =
      `[grouping-pass-1] batch ${batchIndex + 1}/${batchCount}: ` +
      `parsed-lines=${parsed.parsedLineCount}/${items.length}; ` +
      `fail-safe-defaulted=${parsed.failSafeCount}`;
    if (parsed.failSafeCount > 0) {
      console.warn(log);
    } else {
      console.log(log);
    }

    return { results: parsed.results, failed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[grouping-pass-1] batch ${batchIndex + 1}/${batchCount}${label}: LLM call failed ` +
        `after retries (${msg}) — ${items.length} item(s) unscored`,
    );
    return {
      results: items.map((item) => ({
        id: item.id,
        score: FAIL_SAFE_SCORE,
        interest: null,
        consequence: null,
        reason: "fail-safe: LLM error",
      })),
      failed: true,
    };
  }
}


/**
 * Scores every batch, then re-asks for **every item that came back unscored**.
 *
 * **The re-ask is per item, not per failed batch**, and that distinction is the
 * whole point. There are three ways an item ends up unscored and only one of
 * them fails the batch:
 *
 *   `LLM error`          the call threw after retries. Batch fails.
 *   `batch parse error`  nothing in the response parsed. Batch fails.
 *   `missing/invalid line`  the call **succeeded** and the model simply did not
 *                        emit a line for that item, or emitted a malformed one.
 *                        The batch reports success.
 *
 * The third is the common one and the easy one to miss. Run #39's batch 7 of 8
 * parsed 39 of 40 lines: one item was silently defaulted inside an otherwise
 * clean run, and a whole-batch straggler would not have looked at it. Any of the
 * 40 could have been the day's biggest story.
 *
 * So the marker is the item, not the call. Every fail-safe path leaves
 * `interest` null — that is what makes `interest IS NULL` a reliable query — so
 * that is what gets re-asked.
 *
 * Sequential, and in small chunks. A batch lost to a 429 storm was queued behind
 * nine siblings at `concurrency: 10`, so asking again during the storm repeats
 * the conditions that caused it. Chunking small also removes the third failure
 * mode's hiding place: at `straggler_batch_size` items a dropped line is a much
 * smaller share of the response, and in the usual case — one or two stragglers —
 * the re-ask is a single cheap call.
 *
 * Bounded at one pass. An item still unscored afterwards keeps `FAIL_SAFE_SCORE`
 * and is counted, not hidden.
 */
export async function scoreBatches(
  batches: EditorPass1BatchItem[][],
  limit: ReturnType<typeof pLimit>,
  call: (
    batch: EditorPass1BatchItem[],
    batchIdx: number,
    batchCount: number,
    label: string,
  ) => Promise<{ results: EditorPass1ItemResult[]; failed: boolean }>,
  stragglerBatchSize: number,
): Promise<{ results: EditorPass1ItemResult[]; unscored: number }> {
  const first = (await Promise.all(
    batches.map((batch, idx) => limit(() => call(batch, idx, batches.length, ""))),
  )) as Array<{ results: EditorPass1ItemResult[]; failed: boolean }>;

  // Order is load-bearing: results are matched back to items downstream, so a
  // reordering here would attach scores to the wrong stories, silently.
  const ordered: EditorPass1ItemResult[] = first.flatMap((entry) => entry.results);
  const byId = new Map(ordered.map((r) => [r.id, r]));
  const itemById = new Map(batches.flat().map((i) => [i.id, i]));

  const unscoredIds = () =>
    ordered.filter((r) => r.interest === null).map((r) => r.id);

  const needed = unscoredIds();
  if (needed.length === 0) return { results: ordered, unscored: 0 };

  console.warn(
    `[grouping-pass-1] stragglers: ${needed.length} item(s) came back unscored — ` +
      `re-asking sequentially in chunks of ${stragglerBatchSize}`,
  );

  const chunks: EditorPass1BatchItem[][] = [];
  for (let i = 0; i < needed.length; i += stragglerBatchSize) {
    chunks.push(
      needed
        .slice(i, i + stragglerBatchSize)
        .map((id) => itemById.get(id))
        .filter((i): i is EditorPass1BatchItem => i !== undefined),
    );
  }

  for (const [idx, chunk] of chunks.entries()) {
    if (chunk.length === 0) continue;
    const retry = await call(chunk, idx, chunks.length, " [straggler]");
    for (const result of retry.results) {
      // Only a real score replaces a fail-safe. A straggler that fails again
      // must not overwrite one reason with another and look like progress.
      if (result.interest === null) continue;
      const existing = byId.get(result.id);
      if (existing === undefined) continue;
      Object.assign(existing, result);
    }
  }

  const stillUnscored = unscoredIds().length;
  console.log(
    `[grouping-pass-1] stragglers: recovered ${needed.length - stillUnscored} of ` +
      `${needed.length}, ${stillUnscored} still unscored`,
  );

  return { results: ordered, unscored: stillUnscored };
}

export async function runGroupingPass1(
  options: { groupingRunId?: number; modelOverride?: string } = {},
): Promise<GroupingPass1Run> {
  const pool = getPool();

  // 1. Find grouping run (explicit id or latest completed).
  let groupingRunId: number;
  if (options.groupingRunId !== undefined) {
    groupingRunId = options.groupingRunId;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM grouping_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
    );
    if (!rows[0]) throw new Error("No completed grouping runs found");
    groupingRunId = rows[0].id;
  }

  // 2. Load grouping run and parse its digest.
  const { rows: grRows } = await pool.query<GroupingDigestRow>(
    "SELECT id, preprocessor_run_id, digest, completed_at FROM grouping_runs WHERE id = $1",
    [groupingRunId],
  );
  const groupingRun = grRows[0];
  if (!groupingRun) throw new Error(`Grouping run #${groupingRunId} not found`);
  if (!groupingRun.completed_at) throw new Error(`Grouping run #${groupingRunId} is not completed`);
  if (!groupingRun.digest) throw new Error(`Grouping run #${groupingRunId} has no digest`);

  const preprocessorRunId = groupingRun.preprocessor_run_id;
  const clusters = parseGroupingDigest(groupingRun.digest);
  const clusteredIds = new Set<number>(clusters.flatMap((c) => c.memberIds));

  // 3. Load model config (scoring reuses editor_pass_1 model settings).
  const modelConfig = loadModelConfig();
  const stageConfig = modelConfig.editor_pass_1;
  const model = options.modelOverride ?? stageConfig.model;
  const { temperature, max_tokens: maxTokens, batch_size: batchSize, concurrency } = stageConfig;
  const bodyCap = stageConfig.body_cap;
  const summaryCap = stageConfig.summary_cap;
  const stragglerBatchSize = stageConfig.straggler_batch_size;
  const reasoningEffort = stageConfig.reasoning_effort;
  const provider = stageConfig.provider;
  const timeoutMs = stageConfig.timeout_ms;
  const stream = stageConfig.stream;

  // 4. Load all items the grouping run processed; identify singletons.
  const allItems = await getClusteringItems(preprocessorRunId);
  const singletons = allItems.filter((item) => !clusteredIds.has(Number(item.id)));

  const totalItems = clusters.length + singletons.length;
  console.log(
    `[grouping-pass-1] grouping run #${groupingRunId}: ` +
      `${clusters.length} clusters, ${singletons.length} singletons = ${totalItems} total to score`,
  );

  // 5. Load bio and build system prompt.
  const systemPrompt = buildSystemPrompt(loadBio());

  // 6. Create grouping_pass1_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO grouping_pass1_runs (started_at, grouping_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3) RETURNING id`,
    [groupingRunId, model, totalItems],
  );
  const runId = runRows[0]!.id;

  try {
    // 7. Score clusters. Cluster index (0-based) serves as the scoring id.
    // Singletons use preprocessed_item_id (large BIGSERIAL) — no collision
    // possible within a batch type since clusters and singletons are scored
    // in separate passes.
    const clusterBatchItems: EditorPass1BatchItem[] = clusters.map((c) => ({
      id: c.clusterIndex,
      source: "cluster",
      type: "cluster",
      title: c.title,
      body_excerpt: excerpt(c.summary, summaryCap),
    }));

    const clusterBatches: EditorPass1BatchItem[][] = [];
    for (let i = 0; i < clusterBatchItems.length; i += batchSize) {
      clusterBatches.push(clusterBatchItems.slice(i, i + batchSize));
    }

    const clusterLimit = pLimit(concurrency);
    const clusterScored = await scoreBatches(
      clusterBatches,
      clusterLimit,
      (batch, batchIdx, batchCount, label) =>
        processGroupingBatch(
          batch, batchIdx, batchCount,
          runId, model, temperature, maxTokens,
          systemPrompt, reasoningEffort, provider, timeoutMs, stream,
          stageConfig, label,
        ),
      stragglerBatchSize,
    );
    const clusterResults = clusterScored.results;

    // 8. Score singletons.
    //
    // English text, capped by config. Clusters above are scored on a full
    // describe-pass summary; before body_cap existed singletons got title +
    // 50 characters, and that asymmetry — real material for one row type, a
    // headline for the other — is what collapsed singleton scores onto a
    // handful of values and put 85% of run #47's paper into a tie group.
    const singletonBatchItems: EditorPass1BatchItem[] = singletons.map((item) => ({
      id: Number(item.id),
      source: item.source_name,
      type: item.source_type,
      title: englishTitle(item),
      body_excerpt: englishBodyExcerpt(item, bodyCap),
    }));

    const singletonBatches: EditorPass1BatchItem[][] = [];
    for (let i = 0; i < singletonBatchItems.length; i += batchSize) {
      singletonBatches.push(singletonBatchItems.slice(i, i + batchSize));
    }

    const singletonLimit = pLimit(concurrency);
    const singletonScored = await scoreBatches(
      singletonBatches,
      singletonLimit,
      (batch, batchIdx, batchCount, label) =>
        processGroupingBatch(
          batch, batchIdx, batchCount,
          runId, model, temperature, maxTokens,
          systemPrompt, reasoningEffort, provider, timeoutMs, stream,
          stageConfig, label,
        ),
      stragglerBatchSize,
    );
    const singletonResults = singletonScored.results;

    // **An unscored row is visible, not silent.** It carries FAIL_SAFE_SCORE and
    // a null interest axis, so `interest IS NULL` finds it — but nobody queries a
    // database to find out a stage went wrong, so say it here too.
    const totalUnscored = clusterScored.unscored + singletonScored.unscored;
    if (totalUnscored > 0) {
      console.warn(
        `[grouping-pass-1] WARNING: ${totalUnscored} item(s) could not be scored ` +
          `after the straggler re-ask. They carry score=${FAIL_SAFE_SCORE} and a null ` +
          `interest axis, which keeps them out of the pile unless it is short of ` +
          `judged candidates. Find them with: interest IS NULL.`,
      );
    }

    // 9. Persist results.
    const INSERT_CHUNK = 500;

    // Cluster rows: 7 params each (run_id, cluster_index, source_count, score,
    // interest, consequence, reason). The axes are nullable — a fail-safed row
    // has a score but no breakdown.
    for (let i = 0; i < clusterResults.length; i += INSERT_CHUNK) {
      const chunk = clusterResults.slice(i, i + INSERT_CHUNK);
      if (chunk.length === 0) continue;
      const placeholders = chunk
        .map((_, j) => {
          const base = j * 7;
          return `($${base + 1}, 'cluster', $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        })
        .join(", ");
      const params: Array<number | string | null> = [];
      for (const r of chunk) {
        const sourceCount = clusters[r.id]!.memberIds.length;
        params.push(runId, r.id, sourceCount, r.score, r.interest, r.consequence, r.reason);
      }
      await pool.query(
        `INSERT INTO grouping_pass1_results
           (run_id, item_type, cluster_index, source_count, score, interest, consequence, reason)
         VALUES ${placeholders}`,
        params,
      );
    }

    // Singleton rows: 6 params each (run_id, preprocessed_item_id, score,
    // interest, consequence, reason). source_count is literal 1.
    for (let i = 0; i < singletonResults.length; i += INSERT_CHUNK) {
      const chunk = singletonResults.slice(i, i + INSERT_CHUNK);
      if (chunk.length === 0) continue;
      const placeholders = chunk
        .map((_, j) => {
          const base = j * 6;
          return `($${base + 1}, 'singleton', $${base + 2}, 1, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        })
        .join(", ");
      const params: Array<number | string | null> = [];
      for (const r of chunk) {
        params.push(runId, r.id, r.score, r.interest, r.consequence, r.reason);
      }
      await pool.query(
        `INSERT INTO grouping_pass1_results
           (run_id, item_type, preprocessed_item_id, source_count, score, interest, consequence, reason)
         VALUES ${placeholders}`,
        params,
      );
    }

    // 10. Finalize run.
    await pool.query(
      `UPDATE grouping_pass1_runs SET completed_at = NOW() WHERE id = $1`,
      [runId],
    );

    return await fetchGroupingPass1Run(pool, runId);
  } catch (err) {
    await pool.query(
      `UPDATE grouping_pass1_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId],
    );
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Grouping-pass-1 run #${runId} failed: ${msg}`);
  }
}

async function fetchGroupingPass1Run(
  pool: import("pg").Pool,
  runId: number,
): Promise<GroupingPass1Run> {
  const { rows } = await pool.query<GroupingPass1RunRow>(
    "SELECT * FROM grouping_pass1_runs WHERE id = $1",
    [runId],
  );
  const r = rows[0]!;
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    groupingRunId: r.grouping_run_id,
    modelUsed: r.model_used,
    itemsIn: r.items_in,
  };
}
