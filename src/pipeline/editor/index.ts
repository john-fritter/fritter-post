import "dotenv/config";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { parseGroupingDigest } from "../editor-pass-1/index.js";

export type EditorTier = "feature" | "standard" | "brief" | "cut";

interface DigestCluster {
  index: number;
  title: string;
  itemCount: number;
}

interface EditorPileItem {
  ref: string;
  itemType: "cluster" | "singleton";
  clusterIndex: number | null;
  preprocessedItemId: number | null;
  score: number;       // grouping-pass-1 relevance score (0–100)
  sourceCount: number; // cluster member count; 1 for singleton
}

/**
 * combined = relevance + W * ln(sources)
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
    itemCount: c.memberIds.length,
  }));
  const clusterByIndex = new Map(digestClusters.map((c) => [c.index, c]));

  // 4. Load in-pile items.
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
  }>(
    `SELECT epi.preprocessed_item_id, epi.score
     FROM editor_pile_items epi
     WHERE epi.pile_id = $1 AND epi.item_type = 'singleton' AND epi.in_pile = true`,
    [pileId],
  );

  // 5. Build combined item list.
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
        score: row.score,
        sourceCount: detail.itemCount,
      };
    })
    .filter((c): c is EditorPileItem => c !== null);

  const singletonItems: EditorPileItem[] = singletonPileRows.map((row) => ({
    ref: `S${row.preprocessed_item_id}`,
    itemType: "singleton" as const,
    clusterIndex: null,
    preprocessedItemId: Number(row.preprocessed_item_id),
    score: row.score,
    sourceCount: 1,
  }));

  const pileItems: EditorPileItem[] = [...clusterItems, ...singletonItems];

  if (pileItems.length === 0) {
    throw new Error(`Editor pile #${pileId} has no in-pile items`);
  }

  // 6. Load formula config.
  const { editor: cfg } = loadModelConfig();
  const W = cfg.source_weight;
  const featureCount = cfg.tiers.feature;
  const standardCount = cfg.tiers.standard;

  // 7. Sort by combined score descending; tiebreak by relevance descending,
  //    then ref ascending for determinism.
  const sorted = pileItems
    .map((item) => ({ ...item, combined: combinedScore(item.score, item.sourceCount, W) }))
    .sort(
      (a, b) =>
        b.combined - a.combined ||
        b.score - a.score ||
        a.ref.localeCompare(b.ref),
    );

  console.log(
    `[editor] pile #${pileId}: ${clusterItems.length} clusters, ${singletonItems.length} singletons, ` +
      `${pileItems.length} items total — formula W=${W}, tiers=${featureCount}/${standardCount}/...`,
  );

  // 8. Create editor_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO editor_runs (started_at, pile_id, grouping_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3, $4)
     RETURNING id`,
    [pileId, groupingRunId, FORMULA_MODEL_SENTINEL, pileItems.length],
  );
  const runId = runRows[0]!.id;

  try {
    // 9. Assign tiers and persist stories in rank order (1-based).
    const tierCounts: Record<EditorTier, number> = { feature: 0, standard: 0, brief: 0, cut: 0 };
    const INSERT_CHUNK = 500;
    for (let i = 0; i < sorted.length; i += INSERT_CHUNK) {
      const chunk = sorted.slice(i, i + INSERT_CHUNK);
      const placeholders = chunk
        .map((_r, j) => {
          const base = j * 7;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        })
        .join(", ");
      const params: Array<number | string | null> = [];
      chunk.forEach((r, j) => {
        const rank = i + j + 1;
        const tier = assignTier(rank - 1, featureCount, standardCount);
        tierCounts[tier]++;
        const reason = `combined=${r.combined.toFixed(2)} (score=${r.score}, sources=${r.sourceCount})`;
        params.push(runId, r.itemType, r.clusterIndex, r.preprocessedItemId, tier, rank, reason);
      });
      await pool.query(
        `INSERT INTO editor_stories
           (run_id, item_type, cluster_index, preprocessed_item_id, tier, rank, reason)
         VALUES ${placeholders}`,
        params,
      );
    }

    // 10. Finalize run with per-tier counts.
    await pool.query(
      `UPDATE editor_runs
       SET completed_at   = NOW(),
           items_feature  = $1,
           items_standard = $2,
           items_brief    = $3,
           items_cut      = $4
       WHERE id = $5`,
      [tierCounts.feature, tierCounts.standard, tierCounts.brief, tierCounts.cut, runId],
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
