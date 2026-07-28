import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import { getPool } from "../../db/index.js";
import { loadModelConfig, type ThreadStageConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { callWithBackoff } from "../../llm/backoff.js";
import { normalizeRef } from "../../lib/refs.js";
import { parseGroupingDigest } from "../editor-pass-1/index.js";
import { buildThreadSystemPrompt, buildThreadUserPrompt } from "./prompt.js";

const BIO_PATH = path.join(import.meta.dirname, "..", "..", "..", "docs", "bio.md");
const BIO_FALLBACK =
  "(Reader bio unavailable. Group stories by whether they form one ongoing situation, using general editorial judgment.)";

function loadBio(): string {
  try {
    const content = readFileSync(BIO_PATH, "utf-8").trim();
    return content.length > 0 ? content : BIO_FALLBACK;
  } catch {
    return BIO_FALLBACK;
  }
}

/** A scored grouping-pass-1 row, as offered to the thread pass. */
export interface ThreadCandidate {
  ref: string; // C<clusterIndex> or S<preprocessedItemId>
  itemType: "cluster" | "singleton";
  clusterIndex: number | null;
  preprocessedItemId: number | null;
  score: number;
  sourceCount: number;
  title: string;
  summary: string;
}

export interface ParsedThread {
  title: string;
  summary: string;
  refs: string[];
}

/**
 * Parses the thread pass output: one `title;;summary;;refs` line per thread.
 *
 * A ref claimed by more than one thread stays with the first — an item must not
 * appear twice in the paper, which is the whole point of the pass. Refs that
 * aren't in the candidate set are dropped (the model occasionally invents one).
 * Threads left with fewer than two members are discarded, and their remaining
 * members fall back to standing alone. Exported for testing.
 */
export function parseThreadOutput(
  text: string,
  validRefs: Set<string>,
): ParsedThread[] {
  const trimmed = text.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];

  const claimed = new Set<string>();
  const threads: ParsedThread[] = [];

  for (const rawLine of trimmed.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^none$/i.test(line)) continue;

    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue;

    const title = line.slice(0, first).trim();
    const summary = line.slice(first + 2, last).trim();
    const refsPart = line.slice(last + 2);

    if (!title) continue;

    const refs: string[] = [];
    for (const token of refsPart.split(/[\s,]+/)) {
      const ref = normalizeRef(token);
      if (!ref || !validRefs.has(ref) || claimed.has(ref)) continue;
      claimed.add(ref);
      refs.push(ref);
    }

    if (refs.length >= 2) {
      threads.push({ title, summary, refs });
    } else {
      // Release the members so they can stand alone or join a later thread.
      for (const ref of refs) claimed.delete(ref);
    }
  }

  return threads;
}

/**
 * A thread's numbers come from its members, never from the model:
 *   relevance = max member score      (a thread is as important as its best story)
 *   sources   = sum member sourceCount (cross-source pickup adds up)
 *
 * This is what lets the editor's existing formula rank threads against
 * un-threaded rows without changing: combined = relevance + W * ln(sources).
 * Exported for testing.
 */
export function deriveThreadScores(members: ThreadCandidate[]): {
  score: number;
  sourceCount: number;
} {
  let score = 0;
  let sourceCount = 0;
  for (const m of members) {
    if (m.score > score) score = m.score;
    sourceCount += m.sourceCount;
  }
  return { score, sourceCount };
}

function formatCandidateBlocks(candidates: ThreadCandidate[]): string {
  return candidates
    .map((c) => {
      const detail = c.summary.trim();
      const sources = c.sourceCount > 1 ? ` (${c.sourceCount} sources)` : "";
      return detail
        ? `[${c.ref}]${sources} ${c.title}\n    ${detail}`
        : `[${c.ref}]${sources} ${c.title}`;
    })
    .join("\n");
}

const SUMMARY_CAP = 300;

/** Loads the top-scoring grouping-pass-1 rows, resolved to titles and summaries. */
export async function loadThreadCandidates(
  groupingPass1RunId: number,
  candidateTarget: number,
): Promise<ThreadCandidate[]> {
  const pool = getPool();

  const { rows: runRows } = await pool.query<{ grouping_run_id: number }>(
    "SELECT grouping_run_id FROM grouping_pass1_runs WHERE id = $1",
    [groupingPass1RunId],
  );
  const groupingRunId = runRows[0]?.grouping_run_id;
  if (groupingRunId === undefined) {
    throw new Error(`Grouping-pass-1 run #${groupingPass1RunId} not found`);
  }

  const { rows: digestRows } = await pool.query<{ digest: string | null }>(
    "SELECT digest FROM grouping_runs WHERE id = $1",
    [groupingRunId],
  );
  const digest = digestRows[0]?.digest;
  if (!digest) throw new Error(`Grouping run #${groupingRunId} has no digest`);

  const clusterByIndex = new Map(
    parseGroupingDigest(digest).map((c) => [c.clusterIndex, c]),
  );

  const { rows } = await pool.query<{
    item_type: string;
    cluster_index: number | null;
    preprocessed_item_id: string | null;
    score: number;
    source_count: number;
    title: string | null;
    body_text: string | null;
  }>(
    `SELECT r.item_type, r.cluster_index, r.preprocessed_item_id,
            r.score, r.source_count, pi.title, pi.body_text
     FROM grouping_pass1_results r
     LEFT JOIN preprocessed_items pi ON pi.id = r.preprocessed_item_id
     WHERE r.run_id = $1
     ORDER BY r.score DESC, r.id ASC
     LIMIT $2`,
    [groupingPass1RunId, candidateTarget],
  );

  const candidates: ThreadCandidate[] = [];
  for (const row of rows) {
    if (row.item_type === "cluster") {
      const detail = clusterByIndex.get(row.cluster_index!);
      if (!detail) {
        console.warn(
          `[thread] cluster_index ${row.cluster_index} not in digest — skipping`,
        );
        continue;
      }
      candidates.push({
        ref: `C${row.cluster_index}`,
        itemType: "cluster",
        clusterIndex: row.cluster_index,
        preprocessedItemId: null,
        score: row.score,
        sourceCount: row.source_count,
        title: detail.title,
        summary: detail.summary.slice(0, SUMMARY_CAP),
      });
    } else {
      candidates.push({
        ref: `S${row.preprocessed_item_id}`,
        itemType: "singleton",
        clusterIndex: null,
        preprocessedItemId: Number(row.preprocessed_item_id),
        score: row.score,
        sourceCount: row.source_count,
        title: row.title ?? `[item ${row.preprocessed_item_id}]`,
        summary: (row.body_text ?? "").slice(0, SUMMARY_CAP),
      });
    }
  }

  return candidates;
}

export interface ThreadRunSummary {
  threadRunId: number;
  candidatesIn: number;
  threadsFormed: number;
  rowsAbsorbed: number;
  calls: number;
  failedCalls: number;
}

export interface RunThreadingOptions {
  groupingPass1RunId: number;
  modelOverride?: string;
}

/**
 * Groups the top-scoring grouping-pass-1 rows into ongoing situations.
 *
 * One LLM call covers the whole candidate set. That is deliberate: a thread's
 * members are spread across the score range (run #43's Oregon fires scored 78,
 * 85, 80, 80 and 60), so chunking by score would hide members from each other
 * and defeat the pass. `candidate_target` is therefore bounded by what one call
 * can hold, not by cost.
 *
 * A failed call yields zero threads, which is the pass not running rather than
 * a wrong answer — the pile simply keeps its un-threaded rows. That is recorded
 * in failed_calls so a report can say so.
 */
export async function runThreading(
  options: RunThreadingOptions,
): Promise<ThreadRunSummary> {
  const pool = getPool();
  const { thread: config } = loadModelConfig();
  const model = options.modelOverride ?? config.model;
  const { groupingPass1RunId } = options;

  const candidates = await loadThreadCandidates(
    groupingPass1RunId,
    config.candidate_target,
  );

  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO thread_runs (grouping_pass1_run_id, model_used, candidates_in)
     VALUES ($1, $2, $3) RETURNING id`,
    [groupingPass1RunId, model, candidates.length],
  );
  const threadRunId = runRows[0]!.id;

  console.log(
    `[thread] run #${threadRunId}: ${candidates.length} candidates ` +
      `(target=${config.candidate_target}), model=${model}`,
  );

  if (candidates.length < 2) {
    await pool.query(
      `UPDATE thread_runs SET completed_at = NOW(), threads_formed = 0,
              rows_absorbed = 0, calls = 0, failed_calls = 0
       WHERE id = $1`,
      [threadRunId],
    );
    console.log("[thread] fewer than 2 candidates — nothing to thread");
    return {
      threadRunId,
      candidatesIn: candidates.length,
      threadsFormed: 0,
      rowsAbsorbed: 0,
      calls: 0,
      failedCalls: 0,
    };
  }

  const candidateByRef = new Map(candidates.map((c) => [c.ref, c]));
  const validRefs = new Set(candidateByRef.keys());

  let parsed: ParsedThread[] = [];
  let failedCalls = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let generationLogId: bigint | null = null;

  try {
    const result = await callWithBackoff(
      () =>
        callLLM({
          stage: "thread",
          stageRunId: threadRunId,
          model,
          systemPrompt: buildThreadSystemPrompt(),
          userPrompt: buildThreadUserPrompt(
            loadBio(),
            formatCandidateBlocks(candidates),
          ),
          temperature: config.temperature,
          maxTokens: config.max_tokens,
          reasoningEffort: config.reasoning_effort,
          provider: config.provider,
          timeoutMs: config.timeout_ms,
          stream: config.stream,
        }),
      config,
      "thread",
    );
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
    generationLogId = result.generationLogId;
    parsed = parseThreadOutput(result.text, validRefs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failedCalls = 1;
    console.warn(
      `[thread] LLM call failed after retries — no threads formed, pile keeps ` +
        `its un-threaded rows: ${msg}`,
    );
  }

  let rowsAbsorbed = 0;
  for (let i = 0; i < parsed.length; i++) {
    const t = parsed[i]!;
    const members = t.refs
      .map((ref) => candidateByRef.get(ref))
      .filter((c): c is ThreadCandidate => c !== undefined);
    if (members.length < 2) continue;

    const { score, sourceCount } = deriveThreadScores(members);

    const { rows: threadRows } = await pool.query<{ id: string }>(
      `INSERT INTO threads (thread_run_id, thread_index, title, summary, score, source_count)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [threadRunId, i, t.title, t.summary, score, sourceCount],
    );
    const threadId = threadRows[0]!.id;

    for (const m of members) {
      await pool.query(
        `INSERT INTO thread_members
           (thread_id, item_type, cluster_index, preprocessed_item_id, score, source_count)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [threadId, m.itemType, m.clusterIndex, m.preprocessedItemId, m.score, m.sourceCount],
      );
    }

    rowsAbsorbed += members.length;
    console.log(
      `[thread] T${i}: ${members.length} members, score=${score}, ` +
        `sources=${sourceCount} — ${t.title}`,
    );
  }

  await pool.query(
    `UPDATE thread_runs
     SET completed_at = NOW(), threads_formed = $1, rows_absorbed = $2,
         calls = $3, failed_calls = $4, input_tokens = $5, output_tokens = $6,
         generation_log_id = $7
     WHERE id = $8`,
    [
      parsed.length,
      rowsAbsorbed,
      1,
      failedCalls,
      inputTokens,
      outputTokens,
      generationLogId,
      threadRunId,
    ],
  );

  console.log(
    `[thread] run #${threadRunId} complete: ${parsed.length} thread(s) formed, ` +
      `${rowsAbsorbed} rows absorbed, ${rowsAbsorbed - parsed.length} pile slot(s) freed, ` +
      `failed_calls=${failedCalls}`,
  );
  if (failedCalls > 0) {
    console.warn(
      `[thread] WARNING: the thread pass did not run. The pile will contain ` +
        `un-threaded rows and may repeat one situation across several items.`,
    );
  }

  return {
    threadRunId,
    candidatesIn: candidates.length,
    threadsFormed: parsed.length,
    rowsAbsorbed,
    calls: 1,
    failedCalls,
  };
}
