import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";

interface EditorPass1RunRow {
  id: number;
  triage_run_id: number;
  completed_at: string | null;
}

interface TriageDigestRow {
  digest: string | null;
}

interface EditorPass1ResultRow {
  preprocessed_item_id: string;
  score: number;
  reason: string;
}

interface EditorPileRow {
  id: number;
}

function parseClusters(digest: string): number {
  const stripped = digest.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  // JSON format (old digests start with '{').
  if (stripped.startsWith("{")) {
    try {
      const parsed = JSON.parse(stripped) as { clusters?: unknown[] };
      if (!Array.isArray(parsed.clusters)) return 0;
      return parsed.clusters.length;
    } catch {
      return 0;
    }
  }

  // Flat line format: label;;summary;;id,id,... — count lines with two distinct ;; occurrences.
  let count = 0;
  for (const rawLine of digest.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const first = line.indexOf(";;");
    if (first === -1) continue;
    if (line.lastIndexOf(";;") !== first) count++;
  }
  return count;
}

export interface PileSummary {
  pileId: number;
  editorPass1RunId: number;
  triageRunId: number;
  clustersIncluded: number;
  singletonPileTarget: number;
  singletonsTotalEligible: number;
  singletonsInPile: number;
  singletonsBelowLine: number;
  scoreCutoff: number | null;
}

export async function assemblePile(editorPass1RunId: number): Promise<PileSummary> {
  const pool = getPool();

  // 1. Load the editor-pass-1 run.
  const { rows: runRows } = await pool.query<EditorPass1RunRow>(
    "SELECT id, triage_run_id, completed_at FROM editor_pass_1_runs WHERE id = $1",
    [editorPass1RunId],
  );
  const run = runRows[0];
  if (!run) throw new Error(`Editor-pass-1 run #${editorPass1RunId} not found`);
  if (!run.completed_at) throw new Error(`Editor-pass-1 run #${editorPass1RunId} is not completed`);

  const triageRunId = run.triage_run_id;

  // 2. Count clusters from the triage digest.
  const { rows: triageRows } = await pool.query<TriageDigestRow>(
    "SELECT digest FROM triage_runs WHERE id = $1",
    [triageRunId],
  );
  const triageRun = triageRows[0];
  if (!triageRun?.digest) throw new Error(`Triage run #${triageRunId} has no digest`);

  const clustersIncluded = parseClusters(triageRun.digest);

  // 3. Load scored singletons, sorted by score desc.
  const { rows: resultRows } = await pool.query<EditorPass1ResultRow>(
    `SELECT preprocessed_item_id, score, reason
     FROM editor_pass_1_results
     WHERE run_id = $1
     ORDER BY score DESC, preprocessed_item_id ASC`,
    [editorPass1RunId],
  );

  // 4. Apply the configured pile target (software sort+slice — no model involved).
  const modelConfig = loadModelConfig();
  const pileTarget = modelConfig.editor_pass_1.singleton_pile_target;

  const inPile = resultRows.slice(0, pileTarget);
  const belowLine = resultRows.slice(pileTarget);

  const lastInPile = inPile.length > 0 ? inPile[inPile.length - 1] : null;
  const scoreCutoff: number | null = lastInPile ? lastInPile.score : null;

  // 5. Create editor_piles row.
  const { rows: pileRows } = await pool.query<EditorPileRow>(
    `INSERT INTO editor_piles
       (editor_pass_1_run_id, triage_run_id, singleton_pile_target,
        clusters_included, singletons_in_pile, singletons_below_line, score_cutoff)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      editorPass1RunId,
      triageRunId,
      pileTarget,
      clustersIncluded,
      inPile.length,
      belowLine.length,
      scoreCutoff,
    ],
  );
  const pileId = pileRows[0]!.id;

  const INSERT_CHUNK = 500;

  // 6. Insert cluster entries (all in_pile = true).
  for (let i = 0; i < clustersIncluded; i += INSERT_CHUNK) {
    const end = Math.min(i + INSERT_CHUNK, clustersIncluded);
    const indices: number[] = [];
    for (let k = i; k < end; k++) indices.push(k);
    if (indices.length === 0) continue;

    const placeholders = indices
      .map((_idx, j) => {
        const base = j * 4;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
      })
      .join(", ");
    const params: Array<number | string | boolean> = [];
    for (const idx of indices) {
      params.push(pileId, "cluster", idx, true);
    }
    await pool.query(
      `INSERT INTO editor_pile_items (pile_id, item_type, cluster_index, in_pile) VALUES ${placeholders}`,
      params,
    );
  }

  // 7. Insert singleton entries (in-pile and below-line together, differentiated by in_pile).
  type ScoredSingleton = EditorPass1ResultRow & { inPile: boolean };
  const allSingletons: ScoredSingleton[] = [
    ...inPile.map((r: EditorPass1ResultRow) => ({ ...r, inPile: true })),
    ...belowLine.map((r: EditorPass1ResultRow) => ({ ...r, inPile: false })),
  ];

  for (let i = 0; i < allSingletons.length; i += INSERT_CHUNK) {
    const chunk = allSingletons.slice(i, i + INSERT_CHUNK);
    if (chunk.length === 0) continue;

    const placeholders = chunk
      .map((_s: ScoredSingleton, j: number) => {
        const base = j * 6;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      })
      .join(", ");
    const params: Array<number | string | boolean> = [];
    for (const s of chunk) {
      params.push(pileId, "singleton", Number(s.preprocessed_item_id), s.inPile, s.score, s.reason);
    }
    await pool.query(
      `INSERT INTO editor_pile_items
         (pile_id, item_type, preprocessed_item_id, in_pile, score, reason)
       VALUES ${placeholders}`,
      params,
    );
  }

  return {
    pileId,
    editorPass1RunId,
    triageRunId,
    clustersIncluded,
    singletonPileTarget: pileTarget,
    singletonsTotalEligible: resultRows.length,
    singletonsInPile: inPile.length,
    singletonsBelowLine: belowLine.length,
    scoreCutoff,
  };
}

// --- GROUPING PILE ASSEMBLY ---

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

  // 4. Create editor_piles row. triage_run_id and editor_pass_1_run_id are
  //    intentionally null for grouping-path piles (migration 021 made them nullable).
  //    singleton_pile_target is repurposed as the general pile target.
  //    clusters_included and singletons_in_pile track the in-pile breakdown.
  //    singletons_below_line counts all items (both types) that didn't make the cut.
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
