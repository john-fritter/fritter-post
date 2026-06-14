import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";

interface EditorPileRow {
  id: number;
}

interface GroupingPass1RunInfo {
  id: number;
  grouping_run_id: number;
  completed_at: string | null;
}

interface GroupingPass1ResultRow {
  item_type: string;
  cluster_index: number | null;
  preprocessed_item_id: string | null;
  score: number;
  reason: string;
}

export interface GroupingPileSummary {
  pileId: number;
  groupingPass1RunId: number;
  groupingRunId: number;
  pileTarget: number;
  clustersInPile: number;
  singletonsInPile: number;
  itemsBelowLine: number;
  scoreCutoff: number | null;
}

export async function assembleGroupingPile(
  groupingPass1RunId: number,
): Promise<GroupingPileSummary> {
  const pool = getPool();

  // 1. Load the grouping-pass-1 run.
  const { rows: runRows } = await pool.query<GroupingPass1RunInfo>(
    "SELECT id, grouping_run_id, completed_at FROM grouping_pass1_runs WHERE id = $1",
    [groupingPass1RunId],
  );
  const run = runRows[0];
  if (!run) throw new Error(`Grouping-pass-1 run #${groupingPass1RunId} not found`);
  if (!run.completed_at) throw new Error(`Grouping-pass-1 run #${groupingPass1RunId} is not completed`);

  const groupingRunId = run.grouping_run_id;

  // 2. Load all scored results, sorted by score desc.
  const { rows: resultRows } = await pool.query<GroupingPass1ResultRow>(
    `SELECT item_type, cluster_index, preprocessed_item_id, score, reason
     FROM grouping_pass1_results
     WHERE run_id = $1
     ORDER BY score DESC, id ASC`,
    [groupingPass1RunId],
  );

  // 3. Apply pile target.
  const modelConfig = loadModelConfig();
  const pileTarget = modelConfig.grouping.pile_target;

  const inPile = resultRows.slice(0, pileTarget);
  const belowLine = resultRows.slice(pileTarget);

  const lastInPile = inPile.length > 0 ? inPile[inPile.length - 1] : null;
  const scoreCutoff: number | null = lastInPile ? lastInPile.score : null;

  const clustersInPile = inPile.filter((r) => r.item_type === "cluster").length;
  const singletonsInPile = inPile.filter((r) => r.item_type === "singleton").length;

  // 4. Create editor_piles row. singleton_pile_target is repurposed as the
  //    general pile target. clusters_included and singletons_in_pile track the
  //    in-pile breakdown. singletons_below_line counts all items (both types)
  //    that didn't make the cut.
  const { rows: pileRows } = await pool.query<EditorPileRow>(
    `INSERT INTO editor_piles
       (grouping_run_id, grouping_pass1_run_id, singleton_pile_target,
        clusters_included, singletons_in_pile, singletons_below_line, score_cutoff)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      groupingRunId,
      groupingPass1RunId,
      pileTarget,
      clustersInPile,
      singletonsInPile,
      belowLine.length,
      scoreCutoff,
    ],
  );
  const pileId = pileRows[0]!.id;

  const INSERT_CHUNK = 500;

  type ScoredResult = GroupingPass1ResultRow & { inPile: boolean };
  const allResults: ScoredResult[] = [
    ...inPile.map((r) => ({ ...r, inPile: true })),
    ...belowLine.map((r) => ({ ...r, inPile: false })),
  ];

  const allClusterResults = allResults.filter((r) => r.item_type === "cluster");
  const allSingletonResults = allResults.filter((r) => r.item_type === "singleton");

  // 5. Insert cluster pile items: 5 params each (pile_id, cluster_index, in_pile, score, reason).
  for (let i = 0; i < allClusterResults.length; i += INSERT_CHUNK) {
    const chunk = allClusterResults.slice(i, i + INSERT_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk
      .map((_, j) => {
        const base = j * 5;
        return `($${base + 1}, 'cluster', $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      })
      .join(", ");
    const params: Array<number | string | boolean> = [];
    for (const r of chunk) {
      params.push(pileId, r.cluster_index!, r.inPile, r.score, r.reason);
    }
    await pool.query(
      `INSERT INTO editor_pile_items (pile_id, item_type, cluster_index, in_pile, score, reason)
       VALUES ${placeholders}`,
      params,
    );
  }

  // 6. Insert singleton pile items: 5 params each (pile_id, preprocessed_item_id, in_pile, score, reason).
  for (let i = 0; i < allSingletonResults.length; i += INSERT_CHUNK) {
    const chunk = allSingletonResults.slice(i, i + INSERT_CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk
      .map((_, j) => {
        const base = j * 5;
        return `($${base + 1}, 'singleton', $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      })
      .join(", ");
    const params: Array<number | string | boolean> = [];
    for (const r of chunk) {
      params.push(pileId, Number(r.preprocessed_item_id!), r.inPile, r.score, r.reason);
    }
    await pool.query(
      `INSERT INTO editor_pile_items (pile_id, item_type, preprocessed_item_id, in_pile, score, reason)
       VALUES ${placeholders}`,
      params,
    );
  }

  return {
    pileId,
    groupingPass1RunId,
    groupingRunId,
    pileTarget,
    clustersInPile,
    singletonsInPile,
    itemsBelowLine: belowLine.length,
    scoreCutoff,
  };
}
