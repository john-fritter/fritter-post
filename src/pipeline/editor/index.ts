import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { outletCountsByCluster } from "../../db/outlets.js";
import { loadModelConfig, type EditorTieBreakConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { callWithBackoff } from "../../llm/backoff.js";
import { normalizeRef } from "../../lib/refs.js";
import { englishTitle, englishBodyExcerpt, excerpt } from "../../lib/text.js";
import { parseGroupingDigest } from "../editor-pass-1/index.js";

export type EditorTier = "feature" | "standard" | "brief" | "cut";

const BIO_PATH = path.join(import.meta.dirname, "..", "..", "..", "docs", "bio.md");
const BIO_FALLBACK =
  "(Reader bio unavailable. Apply generic editorial judgment: rank by newsworthiness and likely reader interest.)";

function loadBio(): string {
  try {
    const content = readFileSync(BIO_PATH, "utf-8").trim();
    return content.length > 0 ? content : BIO_FALLBACK;
  } catch {
    return BIO_FALLBACK;
  }
}

interface DigestCluster {
  index: number;
  title: string;
  summary: string;
  itemCount: number;
  /** The preprocessed items behind it, kept so prominence can be counted by
   *  outlet rather than by row. See src/db/outlets.ts. */
  memberIds: number[];
}

interface EditorPileItem {
  ref: string;
  itemType: "cluster" | "singleton" | "thread";
  clusterIndex: number | null;
  preprocessedItemId: number | null;
  threadId: number | null;
  score: number;       // grouping-pass-1 relevance score (0–100); max(member) for a thread
  sourceCount: number; // distinct outlets in a cluster; 1 for singleton; sum(members) for a thread
  title: string;
  bodyText: string;    // cluster/thread summary or singleton body excerpt, for tie-break prompt
}

// Text caps come from editor.tie_break.body_cap in models.yaml.

/**
 * combined = relevance + W * ln(sources), where sources is how many
 * newsrooms reported the story — distinct outlets, not member rows.
 * ln(1) = 0, so a single-source item gets no lift.
 * A 53-source cluster gets roughly +35 at W=9.
 */
export function combinedScore(score: number, sourceCount: number, sourceWeight: number): number {
  return score + sourceWeight * Math.log(sourceCount);
}

/**
 * Assign a tier by 0-based rank in the combined-score sort.
 * Features fill first, then standard, then brief. The last tier absorbs the
 * shortfall when the pile has fewer than featureCount + standardCount items.
 */
export function assignTier(rank0: number, featureCount: number, standardCount: number): EditorTier {
  if (rank0 < featureCount) return "feature";
  if (rank0 < featureCount + standardCount) return "standard";
  return "brief";
}

/**
 * Parse the tie-break LLM output: one ref per line, in ranked order.
 * Returns a Map from ref → 0-based rank within the group.
 * Refs absent from the output are not in the map — callers treat them as Infinity.
 */
export function parseTieBreakOutput(text: string, groupRefs: string[]): Map<string, number> {
  const refSet = new Set(groupRefs);
  const tieRanks = new Map<string, number>();
  let rank = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const ref = normalizeRef(line);
    if (ref && refSet.has(ref) && !tieRanks.has(ref)) {
      tieRanks.set(ref, rank++);
    }
  }
  return tieRanks;
}

/**
 * Sort items by (combined desc, tieRank asc, ref asc).
 * Items not in tieRanksByRef get effective tieRank Infinity — they sort to the
 * end of their tied group, with ref as the final deterministic fallback.
 * Items with unique combined scores never compare tieRanks (the first term
 * resolves), so absent tie ranks are harmless for non-tied items.
 */
export function applySortWithTieRanks<T extends { ref: string; combined: number }>(
  items: T[],
  tieRanksByRef: Map<string, number>,
): T[] {
  return [...items].sort(
    (a, b) =>
      b.combined - a.combined ||
      (tieRanksByRef.get(a.ref) ?? Infinity) - (tieRanksByRef.get(b.ref) ?? Infinity) ||
      a.ref.localeCompare(b.ref),
  );
}

function buildTieBreakSystemPrompt(): string {
  return `You are ordering a small group of news items for a specific reader. The items have been scored identically by a formula — your job is to decide which the reader should see first.

Output the item refs in ranked order, best first, one per line. Every ref must appear exactly once. No prose, no numbering, no explanation — just the refs.`;
}

function buildTieBreakUserPrompt(bio: string, items: EditorPileItem[]): string {
  const lines = items.map((item) => {
    const body = item.bodyText.length > 0 ? ` — ${item.bodyText}` : "";
    return `[${item.ref}] ${item.title}${body}`;
  });
  return ["The reader:", "", bio, "", "---", "", "Rank these items best-first:", "", ...lines].join("\n");
}

async function callTieBreakForGroup(
  group: EditorPileItem[],
  groupIndex: number,
  bio: string,
  runId: number,
  tieCfg: EditorTieBreakConfig,
): Promise<{ ranks: Map<string, number>; failed: boolean }> {
  const groupRefs = group.map((item) => item.ref);
  try {
    // **The tie-break is batched and concurrent, so it needs the backoff.**
    // It ran on a raw `callLLM` for its whole life, at `concurrency: 10` —
    // level with grouping-pass-1, the highest in the pipeline — and run #125
    // paid for it: 12 of 25 tie groups lost their call to a single 429 and
    // fell back to ref order, one attempt each, no retry. The same run is its
    // own control. Grouping's attach pass met the identical 429 storm from the
    // identical provider minutes earlier, retried under this wrapper, and
    // finished with `attach_failed_calls=0`.
    //
    // The failure is also the quiet kind this rule exists for: the catch
    // returns an empty map, which is exactly what a group the model declined
    // to order returns, and the stage logs a warning and reports success.
    const result = await callWithBackoff(
      () =>
        callLLM({
          stage: "editor-tie-break",
          stageRunId: runId,
          model: tieCfg.model,
          systemPrompt: buildTieBreakSystemPrompt(),
          userPrompt: buildTieBreakUserPrompt(bio, group),
          temperature: tieCfg.temperature,
          maxTokens: tieCfg.max_tokens,
          reasoningEffort: tieCfg.reasoning_effort,
          provider: tieCfg.provider,
          timeoutMs: tieCfg.timeout_ms,
          stream: tieCfg.stream,
        }),
      tieCfg,
      `editor tie-break ${groupIndex}`,
    );

    const tieRanks = parseTieBreakOutput(result.text, groupRefs);
    const missing = groupRefs.filter((r) => !tieRanks.has(r));
    if (missing.length > 0) {
      console.warn(
        `[editor] tie-break group ${groupIndex}: LLM omitted ${missing.length} ref(s), falling back to ref order for: ${missing.join(", ")}`,
      );
    } else {
      console.log(`[editor] tie-break group ${groupIndex}: ranked ${groupRefs.length} items`);
    }
    // A model that answered but omitted refs gave a partial ordering, which is
    // a worse answer, not a lost call. Only a thrown call counts as failed.
    return { ranks: tieRanks, failed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[editor] tie-break group ${groupIndex}: call failed (${msg}) — falling back to ref order for all ${group.length} items`,
    );
    // empty → all items get Infinity → fall back to ref order
    return { ranks: new Map(), failed: true };
  }
}

export interface EditorRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  pileId: number;
  groupingRunId: number | null;
  modelUsed: string;
  itemsIn: number;
  itemsFeature: number;
  itemsStandard: number;
  itemsBrief: number;
  itemsCut: number;
}

interface EditorRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  pile_id: number;
  grouping_run_id: number | null;
  model_used: string;
  items_in: number;
  items_feature: number;
  items_standard: number;
  items_brief: number;
  items_cut: number;
}

const FORMULA_MODEL_SENTINEL = "formula:combined-score";

export async function runEditor(
  options: {
    pileId?: number;
  } = {},
): Promise<EditorRun> {
  const pool = getPool();

  // 1. Find editor pile (explicit id or latest).
  let pileId: number;
  if (options.pileId !== undefined) {
    pileId = options.pileId;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM editor_piles ORDER BY created_at DESC LIMIT 1",
    );
    if (!rows[0]) throw new Error("No editor piles found");
    pileId = rows[0].id;
  }

  // 2. Load the pile and confirm it has a grouping run.
  const { rows: pileRows } = await pool.query<{
    id: number;
    grouping_run_id: number | null;
  }>(
    "SELECT id, grouping_run_id FROM editor_piles WHERE id = $1",
    [pileId],
  );
  const pile = pileRows[0];
  if (!pile) throw new Error(`Editor pile #${pileId} not found`);
  const groupingRunId = pile.grouping_run_id;
  if (groupingRunId === null) {
    throw new Error(`Editor pile #${pileId} references no grouping run`);
  }

  // 3. Resolve cluster details from the grouping run's digest.
  const { rows: groupingRows } = await pool.query<{ digest: string | null }>(
    "SELECT digest FROM grouping_runs WHERE id = $1",
    [groupingRunId],
  );
  const digest = groupingRows[0]?.digest;
  if (!digest) throw new Error(`Grouping run #${groupingRunId} has no digest`);

  const digestClusters: DigestCluster[] = parseGroupingDigest(digest).map((c) => ({
    index: c.clusterIndex,
    title: c.title,
    summary: c.summary,
    itemCount: c.memberIds.length,
    memberIds: c.memberIds,
  }));
  const clusterByIndex = new Map(digestClusters.map((c) => [c.index, c]));

  // 4. Load formula config. Needed before the item list is built because the
  //    tie-break text cap comes from it.
  const { editor: cfg } = loadModelConfig();
  const W = cfg.source_weight;
  const featureCount = cfg.tiers.feature;
  const standardCount = cfg.tiers.standard;
  const bodyCap = cfg.tie_break.body_cap;

  // 5. Load in-pile items. The singleton query joins preprocessed_items for the
  //    title and body the tie-break prompt needs, in both the original and the
  //    preprocessor's English translation.
  const { rows: clusterPileRows } = await pool.query<{
    cluster_index: number;
    score: number;
  }>(
    `SELECT cluster_index, score FROM editor_pile_items
     WHERE pile_id = $1 AND item_type = 'cluster' AND in_pile = true`,
    [pileId],
  );

  const { rows: singletonPileRows } = await pool.query<{
    preprocessed_item_id: string;
    score: number;
    title: string;
    body_text: string | null;
    english_title: string | null;
    english_body: string | null;
  }>(
    `SELECT epi.preprocessed_item_id, epi.score, pi.title, pi.body_text,
            pi.english_title, pi.english_body
     FROM editor_pile_items epi
     JOIN preprocessed_items pi ON pi.id = epi.preprocessed_item_id
     WHERE epi.pile_id = $1 AND epi.item_type = 'singleton' AND epi.in_pile = true`,
    [pileId],
  );

  // 6. Build combined item list.

  // Prominence is distinct outlets, not member rows — the same reason as in
  // grouping-pass-1, and it has to be applied here too because the editor
  // re-derives the count from the digest rather than reading the stored one.
  const clusterOutletCounts = await outletCountsByCluster(
    new Map(
      clusterPileRows
        .map((row) => [row.cluster_index, clusterByIndex.get(row.cluster_index)?.memberIds ?? []] as const)
        .filter(([, ids]) => ids.length > 0),
    ),
  );

  const clusterItems: EditorPileItem[] = clusterPileRows
    .map((row): EditorPileItem | null => {
      const detail = clusterByIndex.get(row.cluster_index);
      if (!detail) {
        console.warn(
          `[editor] pile cluster_index ${row.cluster_index} not found in digest — skipping`,
        );
        return null;
      }
      return {
        ref: `C${row.cluster_index}`,
        itemType: "cluster",
        clusterIndex: row.cluster_index,
        preprocessedItemId: null,
        threadId: null,
        score: row.score,
        sourceCount: clusterOutletCounts.get(row.cluster_index) ?? detail.itemCount,
        title: detail.title,
        bodyText: excerpt(detail.summary, bodyCap),
      };
    })
    .filter((c): c is EditorPileItem => c !== null);

  // The tie-break is a bio-aware judgment, so it reads the English translation
  // where the preprocessor made one. Run #47 asked this call to rank Russian
  // and Chinese headlines against English ones in their original scripts.
  const singletonItems: EditorPileItem[] = singletonPileRows.map((row) => ({
    ref: `S${row.preprocessed_item_id}`,
    itemType: "singleton" as const,
    clusterIndex: null,
    preprocessedItemId: Number(row.preprocessed_item_id),
    threadId: null,
    score: row.score,
    sourceCount: 1,
    title: englishTitle(row),
    bodyText: englishBodyExcerpt(row, bodyCap),
  }));

  // Threads carry their own title, summary, score and source count — the thread
  // pass derived them from the members it absorbed, so nothing here needs to
  // resolve them from the digest.
  const { rows: threadPileRows } = await pool.query<{
    thread_id: string;
    thread_index: number;
    title: string;
    summary: string | null;
    score: number;
    source_count: number;
  }>(
    `SELECT epi.thread_id, t.thread_index, t.title, t.summary, t.score, t.source_count
     FROM editor_pile_items epi
     JOIN threads t ON t.id = epi.thread_id
     WHERE epi.pile_id = $1 AND epi.item_type = 'thread' AND epi.in_pile = true`,
    [pileId],
  );

  const threadItems: EditorPileItem[] = threadPileRows.map((row) => ({
    ref: `T${row.thread_index}`,
    itemType: "thread" as const,
    clusterIndex: null,
    preprocessedItemId: null,
    threadId: Number(row.thread_id),
    score: row.score,
    sourceCount: row.source_count,
    title: row.title,
    bodyText: excerpt(row.summary, bodyCap),
  }));

  const pileItems: EditorPileItem[] = [...threadItems, ...clusterItems, ...singletonItems];

  if (pileItems.length === 0) {
    throw new Error(`Editor pile #${pileId} has no in-pile items`);
  }

  // 7. Compute combined scores and identify tied groups (2+ items with the
  //    same combined score).
  const scoredItems = pileItems.map((item) => ({
    ...item,
    combined: combinedScore(item.score, item.sourceCount, W),
  }));

  const byScore = new Map<number, typeof scoredItems>();
  for (const item of scoredItems) {
    const group = byScore.get(item.combined) ?? [];
    group.push(item);
    byScore.set(item.combined, group);
  }
  const tiedGroups = [...byScore.values()].filter((g) => g.length >= 2);

  console.log(
    `[editor] pile #${pileId}: ${threadItems.length} threads, ${clusterItems.length} clusters, ` +
      `${singletonItems.length} singletons, ${pileItems.length} items total — ` +
      `formula W=${W}, tiers=${featureCount}/${standardCount}/..., ` +
      `${tiedGroups.length} tied group(s)`,
  );

  // 8. Create editor_runs row now so the tie-break LLM calls can log against runId.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO editor_runs (started_at, pile_id, grouping_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3, $4)
     RETURNING id`,
    [pileId, groupingRunId, FORMULA_MODEL_SENTINEL, pileItems.length],
  );
  const runId = runRows[0]!.id;

  try {
    // 9. Run bio-aware tie-break calls for each tied group, concurrently.
    const tieRanksByRef = new Map<string, number>();
    let tieBreakCallsMade = false;
    let tieBreakCalls = 0;
    let tieBreakFailedCalls = 0;

    if (tiedGroups.length > 0) {
      const tieCfg = cfg.tie_break;
      const bio = loadBio();
      const limit = pLimit(tieCfg.concurrency);

      const groupResults = await Promise.all(
        tiedGroups.map((group, idx) =>
          limit(() => callTieBreakForGroup(group, idx, bio, runId, tieCfg)),
        ),
      );

      for (const groupResult of groupResults) {
        for (const [ref, rank] of groupResult.ranks) {
          tieRanksByRef.set(ref, rank);
        }
      }
      tieBreakCalls = groupResults.length;
      tieBreakFailedCalls = groupResults.filter((r) => r.failed).length;
      tieBreakCallsMade = true;

      // Said out loud, because a fallback to ref order is alphabetical and
      // therefore arbitrary, and at a tier boundary it decides whether a story
      // is a feature or a standard.
      if (tieBreakFailedCalls > 0) {
        const lost = groupResults
          .map((r, i) => (r.failed ? tiedGroups[i]!.length : 0))
          .reduce((a, b) => a + b, 0);
        console.warn(
          `[editor] tie-break: ${tieBreakFailedCalls}/${tieBreakCalls} call(s) failed ` +
            `after backoff — ${lost} item(s) ranked by ref order rather than by ` +
            `reader relevance`,
        );
      }
    }

    // 10. Update model_used if tie-break calls were made.
    if (tieBreakCallsMade) {
      const sentinel = `formula:combined-score+tie-rank:${cfg.tie_break.model}`;
      await pool.query(`UPDATE editor_runs SET model_used = $1 WHERE id = $2`, [sentinel, runId]);
    }

    // 11. Final sort: combined desc → tie-rank asc → ref asc.
    const sorted = applySortWithTieRanks(scoredItems, tieRanksByRef);

    // 12. Assign tiers and persist stories in rank order (1-based).
    const tierCounts: Record<EditorTier, number> = { feature: 0, standard: 0, brief: 0, cut: 0 };
    const INSERT_CHUNK = 500;
    for (let i = 0; i < sorted.length; i += INSERT_CHUNK) {
      const chunk = sorted.slice(i, i + INSERT_CHUNK);
      const placeholders = chunk
        .map((_r, j) => {
          const base = j * 8;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
        })
        .join(", ");
      const params: Array<number | string | null> = [];
      chunk.forEach((r, j) => {
        const rank = i + j + 1;
        const tier = assignTier(rank - 1, featureCount, standardCount);
        tierCounts[tier]++;
        const tieRank = tieRanksByRef.get(r.ref);
        const reason =
          `combined=${r.combined.toFixed(2)} (score=${r.score}, sources=${r.sourceCount})` +
          (tieRank !== undefined ? ` tie-rank:${tieRank}` : "");
        params.push(
          runId,
          r.itemType,
          r.clusterIndex,
          r.preprocessedItemId,
          r.threadId,
          tier,
          rank,
          reason,
        );
      });
      await pool.query(
        `INSERT INTO editor_stories
           (run_id, item_type, cluster_index, preprocessed_item_id, thread_id, tier, rank, reason)
         VALUES ${placeholders}`,
        params,
      );
    }

    // 13. Finalize run with per-tier counts.
    await pool.query(
      `UPDATE editor_runs
       SET completed_at           = NOW(),
           items_feature          = $1,
           items_standard         = $2,
           items_brief            = $3,
           items_cut              = $4,
           tie_break_calls        = $5,
           tie_break_failed_calls = $6
       WHERE id = $7`,
      [
        tierCounts.feature,
        tierCounts.standard,
        tierCounts.brief,
        tierCounts.cut,
        tieBreakCalls,
        tieBreakFailedCalls,
        runId,
      ],
    );

    console.log(
      `[editor] run #${runId}: feature=${tierCounts.feature}, standard=${tierCounts.standard}, brief=${tierCounts.brief}`,
    );

    return await fetchEditorRun(pool, runId);
  } catch (err) {
    await pool.query(
      `UPDATE editor_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId],
    );
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Editor run #${runId} failed: ${msg}`);
  }
}

async function fetchEditorRun(pool: import("pg").Pool, runId: number): Promise<EditorRun> {
  const { rows } = await pool.query<EditorRunRow>("SELECT * FROM editor_runs WHERE id = $1", [runId]);
  const r = rows[0]!;
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    pileId: r.pile_id,
    groupingRunId: r.grouping_run_id,
    modelUsed: r.model_used,
    itemsIn: r.items_in,
    itemsFeature: r.items_feature,
    itemsStandard: r.items_standard,
    itemsBrief: r.items_brief,
    itemsCut: r.items_cut,
  };
}
