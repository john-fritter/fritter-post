/**
 * Step 6, novelty: how new is each story to someone who read the last papers?
 *
 * Grades the top scored rows against what recent editions printed: new,
 * development, minor, routine or rerun. Minor and routine are reduced (a lower
 * score and a tier cap); a rerun is withheld. Fails open: an ungraded row is
 * left alone. Runs inside the score stage, before threading. Formerly the
 * "rerun check". Writes `rerun_runs` / `rerun_assessments`.
 *
 * See docs/design.md, "novelty".
 */

import "dotenv/config";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { applyModelOverrides, type ModelOverrides } from "../../config/overrides.js";
import { callLLM } from "../../llm/index.js";
import { callWithBackoff } from "../../llm/backoff.js";
import { englishBody, englishTitle, excerpt } from "../../lib/text.js";
import { parseGroupingDigest } from "../score/index.js";
import { loadThreadCandidates, type ThreadCandidate } from "../thread/index.js";
import {
  buildNoveltySystemPrompt,
  buildNoveltyUserPrompt,
  parseNoveltyGrades,
  type NoveltyCandidateBlock,
  type NoveltyGrade,
} from "./prompt.js";
import { adjustedScore, chunk, effectOf, groupPriors, type PieceTier } from "./select.js";

// The reader's day, as the publisher computes it: a paper is dated by where
// its reader is, and "printed before today" means before that day.
const PAPER_TIMEZONE = process.env["PAPER_TIMEZONE"] ?? "America/Los_Angeles";

/** What the check did to one row that it kept but reduced. */
export interface NoveltyReduction {
  grade: NoveltyGrade;
  penalty: number;
  maxTier: PieceTier | null;
}

export interface NoveltyRunSummary {
  rerunRunId: number | null;
  candidatesIn: number;
  /** Printed pieces retrieved across every candidate. */
  pairsJudged: number;
  /** Candidates with at least one printed piece above the floor, so graded. */
  rowsJudged: number;
  /** Row keys (C<n> / S<id>) to withhold from threading and the pile. */
  dropped: Set<string>;
  /** Rows kept but reduced: graded minor or routine. */
  reduced: Map<string, NoveltyReduction>;
  calls: number;
  failedCalls: number;
}

interface PriorPiece {
  rowKey: string;
  priorPieceId: string;
  publishedOn: string;
  headline: string | null;
  body: string;
  similarity: number;
}

interface Assessment {
  rowKey: string;
  grade: NoveltyGrade | null;
  news: string | null;
  closest: PriorPiece;
  priorsShown: number;
  generationLogId: bigint | null;
}

function localDay(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: PAPER_TIMEZONE }).format(new Date());
}

const EMPTY: Omit<NoveltyRunSummary, "rerunRunId"> = {
  candidatesIn: 0,
  pairsJudged: 0,
  rowsJudged: 0,
  dropped: new Set(),
  reduced: new Map(),
  calls: 0,
  failedCalls: 0,
};

/**
 * Grades the top-scoring rows of a grouping-pass-1 run against the pieces the
 * paper printed in its last `lookback_editions` editions. See prompt.ts for why
 * it grades rather than decides, and select.ts for what each grade does.
 *
 * Retrieval is the lineage pass's: max pairwise cosine between any article
 * behind the row and any article behind a printed piece, over the embeddings
 * grouping has already stored. The judgment is an LLM's, because embeddings
 * cannot tell a restatement from a development -- they read alike by
 * construction.
 *
 * Fails open at every level. No prior papers, a failed call, an unreadable
 * line: the row stays, unreduced, and the paper is what it would have been
 * before this check existed.
 */
export async function runNovelty(options: {
  groupingPass1RunId: number;
  /**
   * The paper day to check as of (YYYY-MM-DD); only papers before it count as
   * printed. Defaults to today in the reader's timezone. Set for a backtest over
   * an old run, which would otherwise be judged against the papers made from it.
   */
  asOf?: string;
  /** Model comparison only: replaces the judge's model settings for this run. */
  overrides?: ModelOverrides;
}): Promise<NoveltyRunSummary> {
  const pool = getPool();
  const cfg = applyModelOverrides(loadModelConfig().novelty, options.overrides);
  const { groupingPass1RunId } = options;

  if (!cfg.enabled) return { rerunRunId: null, ...EMPTY, dropped: new Set(), reduced: new Map() };

  const candidates = await loadThreadCandidates(groupingPass1RunId, cfg.candidate_target, cfg.candidate_cap);
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
  const itemsOf = (c: ThreadCandidate): number[] =>
    c.itemType === "cluster" ? (members.get(c.clusterIndex!) ?? []) : [c.preprocessedItemId!];
  const rowKeys: string[] = [];
  const itemIds: number[] = [];
  for (const c of candidates) {
    for (const id of itemsOf(c)) {
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

  const priors: PriorPiece[] = pairRows.map((r) => ({
    rowKey: r.row_key,
    priorPieceId: r.prior_piece_id,
    publishedOn: r.prior_published_on,
    headline: r.prior_headline,
    body: r.prior_body,
    similarity: r.similarity,
  }));
  const priorsByRow = groupPriors(priors, cfg.bodies_shown);
  // Judge in score order, so a partial failure costs the bottom of the paper.
  const judgedKeys = candidates.map((c) => c.ref).filter((k) => priorsByRow.has(k));

  console.log(
    `[novelty] run #${rerunRunId}: ${candidates.length} rows checked, ${judgedKeys.length} with ` +
      `printed pieces above ${cfg.candidate_floor} in the last ${cfg.lookback_editions} edition(s) ` +
      `(${priors.length} pieces)`,
  );

  const candidateText = await buildCandidateTexts(
    judgedKeys.map((k) => byKey.get(k)!),
    itemsOf,
    cfg.candidate_cap,
    cfg.candidate_articles,
  );

  const batches = chunk(judgedKeys, cfg.batch_size);
  const limit = pLimit(cfg.concurrency);
  let failedCalls = 0;

  const assessments: Assessment[] = (
    await Promise.all(
      batches.map((batch) =>
        limit(async (): Promise<Assessment[]> => {
          const blocks: NoveltyCandidateBlock[] = batch.map((key) => ({
            date: today,
            title: byKey.get(key)!.title,
            text: candidateText.get(key) ?? "",
            printed: priorsByRow.get(key)!.map((p) => ({
              date: p.publishedOn,
              headline: p.headline,
              body: p.withBody || !p.headline ? excerpt(p.body, cfg.body_cap) : "",
            })),
          }));
          const base = (key: string, i: number) => {
            const list = priorsByRow.get(key)!;
            const closest = [...list].sort((a, b) => b.similarity - a.similarity)[0]!;
            return { rowKey: key, closest, priorsShown: list.length, index: i };
          };
          try {
            const result = await callWithBackoff(
              () =>
                callLLM({
                  stage: "novelty",
                  stageRunId: rerunRunId,
                  model: cfg.model,
                  systemPrompt: buildNoveltySystemPrompt(),
                  userPrompt: buildNoveltyUserPrompt(blocks),
                  temperature: cfg.temperature,
                  maxTokens: cfg.max_tokens,
                  reasoningEffort: cfg.reasoning_effort,
                  provider: cfg.provider,
                  timeoutMs: cfg.timeout_ms,
                  stream: cfg.stream,
                }),
              cfg,
              "novelty",
            );
            const grades = parseNoveltyGrades(result.text, batch.length);
            return batch.map((key, i) => ({
              ...base(key, i),
              grade: grades.get(i)?.grade ?? null,
              news: grades.get(i)?.news ?? null,
              generationLogId: result.generationLogId,
            }));
          } catch (err) {
            // Fail open: these rows stay in the paper, ungraded and unreduced.
            failedCalls++;
            console.warn(
              `[novelty] judge call failed, ${batch.length} row(s) kept ungraded: ` +
                (err instanceof Error ? err.message : String(err)),
            );
            return batch.map((key, i) => ({ ...base(key, i), grade: null, news: null, generationLogId: null }));
          }
        }),
      ),
    )
  ).flat();

  const dropped = new Set<string>();
  const reduced = new Map<string, NoveltyReduction>();
  for (const a of assessments) {
    const effect = effectOf(a.grade, cfg.grades);
    if (effect.withhold) dropped.add(a.rowKey);
    else if (effect.penalty > 0 || effect.maxTier !== null) {
      reduced.set(a.rowKey, { grade: a.grade!, penalty: effect.penalty, maxTier: effect.maxTier });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const a of assessments) {
      const c = byKey.get(a.rowKey)!;
      const effect = effectOf(a.grade, cfg.grades);
      await client.query(
        `INSERT INTO rerun_assessments
           (rerun_run_id, row_key, row_title, grade, news, prior_paper_piece_id,
            prior_published_on, prior_headline, similarity, priors_shown,
            score_before, penalty, max_tier, generation_log_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          rerunRunId, a.rowKey, c.title, a.grade, a.news, a.closest.priorPieceId,
          a.closest.publishedOn, a.closest.headline, a.closest.similarity, a.priorsShown,
          c.score, effect.penalty, effect.maxTier, a.generationLogId,
        ],
      );
    }
    await client.query(
      `UPDATE rerun_runs SET completed_at = NOW(), pairs_judged = $1, rows_judged = $2,
              rows_dropped = $3, rows_reduced = $4, calls = $5, failed_calls = $6
       WHERE id = $7`,
      [priors.length, assessments.length, dropped.size, reduced.size, batches.length, failedCalls, rerunRunId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const byGrade = new Map<string, number>();
  for (const a of assessments) byGrade.set(a.grade ?? "ungraded", (byGrade.get(a.grade ?? "ungraded") ?? 0) + 1);
  for (const a of assessments) {
    if (a.grade !== "rerun" && !reduced.has(a.rowKey)) continue;
    const c = byKey.get(a.rowKey)!;
    const r = reduced.get(a.rowKey);
    const what = a.grade === "rerun"
      ? "withheld"
      : `${a.grade}, score ${c.score}→${adjustedScore(c.score, r!.penalty)}` +
        (r!.maxTier ? `, at most ${r!.maxTier}` : "");
    console.log(
      `[novelty] ${a.rowKey} "${c.title}" — ${what}; printed ${a.closest.publishedOn}: ` +
        `"${a.closest.headline ?? "(line)"}" (${a.news ?? "no sentence given"})`,
    );
  }
  console.log(
    `[novelty] run #${rerunRunId} complete: ${[...byGrade].map(([g, n]) => `${g}=${n}`).join(" ")}; ` +
      `${dropped.size} withheld, ${reduced.size} reduced, ${batches.length} call(s), failed_calls=${failedCalls}`,
  );

  return {
    rerunRunId,
    candidatesIn: candidates.length,
    pairsJudged: priors.length,
    rowsJudged: assessments.length,
    dropped,
    reduced,
    calls: batches.length,
    failedCalls,
  };
}

/**
 * The text the judge reads for each candidate. A singleton is its own body. A
 * cluster is its members' articles, not its describe-pass summary: the summary
 * is a two-sentence label generated from every member, so it compresses away
 * exactly the detail that makes today different -- and judged against 1,200
 * characters of the printed piece, its "single most important fact" was usually
 * the background both share. Eleven of the 34 drops the 2026-10-01 audit called
 * wrong were clusters, the highest-ranked ones among them. The summary is the
 * fallback only when no member carries any text.
 */
async function buildCandidateTexts(
  candidates: ThreadCandidate[],
  itemsOf: (c: ThreadCandidate) => number[],
  cap: number,
  articlesPerCluster: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const clusterIds = candidates.filter((c) => c.itemType === "cluster").flatMap(itemsOf);
  const items = new Map<number, { source: string; title: string; body: string }>();
  if (clusterIds.length > 0) {
    const { rows } = await getPool().query<{
      id: string;
      source_name: string;
      title: string;
      english_title: string | null;
      body_text: string | null;
      english_body: string | null;
    }>(
      `SELECT id::text AS id, source_name, title, english_title, body_text, english_body
       FROM preprocessed_items WHERE id = ANY($1::bigint[])`,
      [clusterIds],
    );
    for (const r of rows) {
      items.set(Number(r.id), { source: r.source_name, title: englishTitle(r), body: englishBody(r).trim() });
    }
  }
  for (const c of candidates) {
    if (c.itemType !== "cluster") {
      out.set(c.ref, c.summary);
      continue;
    }
    const chosen = itemsOf(c)
      .map((id) => items.get(id))
      .filter((i): i is { source: string; title: string; body: string } => i !== undefined && i.body.length > 0)
      .sort((a, b) => b.body.length - a.body.length)
      .slice(0, articlesPerCluster);
    if (chosen.length === 0) {
      out.set(c.ref, c.summary);
      continue;
    }
    const each = Math.floor(cap / chosen.length);
    out.set(
      c.ref,
      chosen.map((i) => `[${i.source}] ${i.title}\n${excerpt(i.body, each)}`).join("\n"),
    );
  }
  return out;
}
