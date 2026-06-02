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
  bucket: string;
  score: number;
  reason: string;
}

interface EditorPileRow {
  id: number;
}

function parseClusters(digest: string): number {
  try {
    const stripped = digest.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    const parsed = JSON.parse(stripped) as { clusters?: unknown[] };
    if (!Array.isArray(parsed.clusters)) return 0;
    return parsed.clusters.length;
  } catch {
    return 0;
  }
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

  // 3. Load scored singletons (research + footer only, sorted by score desc).
  const { rows: resultRows } = await pool.query<EditorPass1ResultRow>(
    `SELECT preprocessed_item_id, bucket, score, reason
     FROM editor_pass_1_results
     WHERE run_id = $1 AND bucket IN ('research', 'footer')
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
        const base = j * 7;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      })
      .join(", ");
    const params: Array<number | string | boolean> = [];
    for (const s of chunk) {
      params.push(pileId, "singleton", Number(s.preprocessed_item_id), s.inPile, s.bucket, s.score, s.reason);
    }
    await pool.query(
      `INSERT INTO editor_pile_items
         (pile_id, preprocessed_item_id, in_pile, bucket, score, reason)
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
