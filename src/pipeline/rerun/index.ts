import "dotenv/config";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { applyModelOverrides, type ModelOverrides } from "../../config/overrides.js";
import { callLLM } from "../../llm/index.js";
import { callWithBackoff } from "../../llm/backoff.js";
import { excerpt } from "../../lib/text.js";
import { parseGroupingDigest } from "../editor-pass-1/index.js";
import { loadThreadCandidates, type ThreadCandidate } from "../thread/index.js";
import { buildRerunSystemPrompt, buildRerunUserPrompt, parseRerunVerdicts, type RerunVerdict } from "./prompt.js";
import { chunk, rowsToDrop } from "./select.js";

// The reader's day, as the publisher computes it: a paper is dated by where
// its reader is, and "printed before today" means before that day.
const PAPER_TIMEZONE = process.env["PAPER_TIMEZONE"] ?? "America/Los_Angeles";

export interface RerunRunSummary {
  rerunRunId: number | null;
  candidatesIn: number;
  pairsJudged: number;
  /** Row keys (C<n> / S<id>) to withhold from threading and the pile. */
  dropped: Set<string>;
  calls: number;
  failedCalls: number;
}

interface PriorPair {
  rowKey: string;
  priorPieceId: string;
  priorPublishedOn: string;
  priorHeadline: string | null;
  priorBody: string;
  similarity: number;
}

interface JudgedRow extends PriorPair {
  verdict: RerunVerdict | null;
  reason: string | null;
  generationLogId: bigint | null;
}

function localDay(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: PAPER_TIMEZONE }).format(new Date());
}

/**
 * Checks the top-scoring rows of a grouping-pass-1 run against the pieces the
 * paper printed in its last `lookback_editions` editions, and returns the rows
 * that are news the reader has already been given. See prompt.ts for why.
 *
 * Retrieval is the lineage pass's: max pairwise cosine between any article
 * behind the row and any article behind a printed piece, over the embeddings
 * grouping has already stored. The judgment is an LLM's, because embeddings
 * cannot tell a restatement from a development -- they read alike by
 * construction.
 *
 * Fails open at every level. No prior papers, a failed call, an unreadable
 * line: the row stays, and the paper is what it would have been before this
 * check existed.
 */
export async function runRerunCheck(options: {
  groupingPass1RunId: number;
  /**
   * The paper day to check as of (YYYY-MM-DD); only papers before it count as
   * printed. Defaults to today in the reader's timezone. Set for a backtest over
   * an old run, which would otherwise be judged against the papers made from it.
   */
  asOf?: string;
  /** Model comparison only: replaces the judge's model settings for this run. */
  overrides?: ModelOverrides;
}): Promise<RerunRunSummary> {
  const pool = getPool();
  const cfg = applyModelOverrides(loadModelConfig().rerun, options.overrides);
  const { groupingPass1RunId } = options;

  if (!cfg.enabled) {
    return { rerunRunId: null, candidatesIn: 0, pairsJudged: 0, dropped: new Set(), calls: 0, failedCalls: 0 };
  }

  const candidates = await loadThreadCandidates(groupingPass1RunId, cfg.candidate_target, cfg.body_cap);
  const byKey = new Map<string, ThreadCandidate>(candidates.map((c) => [c.ref, c]));

  // Articles behind each row: a singleton is its own item, a cluster its digest
  // members.
  const { rows: digestRows } = await pool.query<{ digest: string | null }>(
    `SELECT g.digest FROM grouping_pass1_runs r JOIN grouping_runs g ON g.id = r.grouping_run_id
     WHERE r.id = $1`,
    [groupingPass1RunId],
  );
  const members = new Map(
    parseGroupingDigest(digestRows[0]?.digest ?? "").map((c) => [c.clusterIndex, c.memberIds]),
  );
  const rowKeys: string[] = [];
  const itemIds: number[] = [];
  for (const c of candidates) {
    const ids =
      c.itemType === "cluster" ? (members.get(c.clusterIndex!) ?? []) : [c.preprocessedItemId!];
    for (const id of ids) {
      rowKeys.push(c.ref);
      itemIds.push(id);
    }
  }

  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO rerun_runs (grouping_pass1_run_id, model_used, candidates_in)
     VALUES ($1, $2, $3) RETURNING id`,
    [groupingPass1RunId, cfg.model, candidates.length],
  );
  const rerunRunId = runRows[0]!.id;
  const today = options.asOf ?? localDay();

  const { rows: pairRows } = await pool.query<{
    row_key: string;
    prior_piece_id: string;
    prior_published_on: string;
    prior_headline: string | null;
    prior_body: string;
    similarity: number;
  }>(
    `
    WITH today AS (
      SELECT * FROM unnest($1::text[], $2::bigint[]) AS t(row_key, item_id)
    ),
    prior AS (
      SELECT pp.id AS piece_id, pp.headline, pp.body, p.published_on,
             ps.preprocessed_item_id AS item_id
      FROM paper_pieces pp
      JOIN papers p ON p.id = pp.paper_id
      JOIN paper_sources ps ON ps.paper_piece_id = pp.id
      WHERE p.id IN (
              SELECT id FROM papers WHERE published_on < $3::date
              ORDER BY published_on DESC LIMIT $4
            )
        AND ps.preprocessed_item_id IS NOT NULL
    ),
    pairs AS (
      SELECT t.row_key, pr.piece_id, pr.headline, pr.body, pr.published_on,
             max(1 - (te.embedding <=> pe.embedding)) AS similarity
      FROM today t
      JOIN item_embeddings te ON te.preprocessed_item_id = t.item_id
      CROSS JOIN prior pr
      JOIN item_embeddings pe ON pe.preprocessed_item_id = pr.item_id
      GROUP BY t.row_key, pr.piece_id, pr.headline, pr.body, pr.published_on
    ),
    ranked AS (
      SELECT *, row_number() OVER (
               PARTITION BY row_key ORDER BY similarity DESC, published_on DESC, piece_id
             ) AS rn
      FROM pairs
    )
    SELECT row_key, piece_id::text AS prior_piece_id,
           to_char(published_on, 'YYYY-MM-DD') AS prior_published_on,
           headline AS prior_headline, body AS prior_body,
           similarity::float8 AS similarity
    FROM ranked
    WHERE rn <= $5 AND similarity >= $6
    ORDER BY row_key, rn
    `,
    [rowKeys, itemIds, today, cfg.lookback_editions, cfg.top_k, cfg.candidate_floor],
  );

  const pairs: PriorPair[] = pairRows.map((r) => ({
    rowKey: r.row_key,
    priorPieceId: r.prior_piece_id,
    priorPublishedOn: r.prior_published_on,
    priorHeadline: r.prior_headline,
    priorBody: r.prior_body,
    similarity: r.similarity,
  }));

  console.log(
    `[rerun] run #${rerunRunId}: ${candidates.length} rows checked, ` +
      `${pairs.length} pair(s) above ${cfg.candidate_floor} in the last ${cfg.lookback_editions} edition(s)`,
  );

  const batches = chunk(pairs, cfg.batch_size);
  const limit = pLimit(cfg.concurrency);
  let failedCalls = 0;

  const judged: JudgedRow[] = (
    await Promise.all(
      batches.map((batch) =>
        limit(async (): Promise<JudgedRow[]> => {
          try {
            const result = await callWithBackoff(
              () =>
                callLLM({
                  stage: "rerun",
                  stageRunId: rerunRunId,
                  model: cfg.model,
                  systemPrompt: buildRerunSystemPrompt(),
                  userPrompt: buildRerunUserPrompt(
                    batch.map((p) => {
                      const c = byKey.get(p.rowKey)!;
                      return {
                        candidateTitle: c.title,
                        candidateText: c.summary,
                        candidateDate: today,
                        priorHeadline: p.priorHeadline ?? "(a one-sentence item; it follows)",
                        priorBody: excerpt(p.priorBody, cfg.body_cap),
                        priorDate: p.priorPublishedOn,
                      };
                    }),
                  ),
                  temperature: cfg.temperature,
                  maxTokens: cfg.max_tokens,
                  reasoningEffort: cfg.reasoning_effort,
                  provider: cfg.provider,
                  timeoutMs: cfg.timeout_ms,
                  stream: cfg.stream,
                }),
              cfg,
              "rerun",
            );
            const verdicts = parseRerunVerdicts(result.text, batch.length);
            return batch.map((p, i) => ({
              ...p,
              verdict: verdicts.get(i)?.verdict ?? null,
              reason: verdicts.get(i)?.reason ?? null,
              generationLogId: result.generationLogId,
            }));
          } catch (err) {
            // Fail open: these rows stay in the paper, unjudged.
            failedCalls++;
            console.warn(
              `[rerun] judge call failed, ${batch.length} pair(s) kept unjudged: ` +
                (err instanceof Error ? err.message : String(err)),
            );
            return batch.map((p) => ({ ...p, verdict: null, reason: null, generationLogId: null }));
          }
        }),
      ),
    )
  ).flat();

  const dropped = rowsToDrop(judged);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const j of judged) {
      await client.query(
        `INSERT INTO rerun_verdicts
           (rerun_run_id, row_key, row_title, prior_paper_piece_id, prior_published_on,
            prior_headline, similarity, verdict, reason, generation_log_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          rerunRunId, j.rowKey, byKey.get(j.rowKey)!.title, j.priorPieceId, j.priorPublishedOn,
          j.priorHeadline, j.similarity, j.verdict, j.reason, j.generationLogId,
        ],
      );
    }
    await client.query(
      `UPDATE rerun_runs SET completed_at = NOW(), pairs_judged = $1, rows_dropped = $2,
              calls = $3, failed_calls = $4
       WHERE id = $5`,
      [judged.length, dropped.size, batches.length, failedCalls, rerunRunId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  for (const key of dropped) {
    const why = judged.find((j) => j.rowKey === key && j.verdict === "rerun")!;
    console.log(
      `[rerun] dropped ${key} "${byKey.get(key)!.title}" — printed ${why.priorPublishedOn}: ` +
        `"${why.priorHeadline ?? "(line)"}" (${why.reason ?? "no reason given"})`,
    );
  }
  console.log(
    `[rerun] run #${rerunRunId} complete: ${dropped.size} of ${candidates.length} row(s) withheld ` +
      `as reruns, ${batches.length} call(s), failed_calls=${failedCalls}`,
  );

  return {
    rerunRunId,
    candidatesIn: candidates.length,
    pairsJudged: judged.length,
    dropped,
    calls: batches.length,
    failedCalls,
  };
}

