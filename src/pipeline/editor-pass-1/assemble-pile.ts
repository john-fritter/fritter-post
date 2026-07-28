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
  threadRunId: number | null;
  pileTarget: number;
  clustersInPile: number;
  singletonsInPile: number;
  threadsInPile: number;
  itemsBelowLine: number;
  scoreCutoff: number | null;
}

interface ThreadInfo {
  id: string;
  score: number;
  memberKeys: string[];
}

type PileCandidate = {
  kind: "thread" | "row";
  threadId: string | null;
  score: number;
  row: GroupingPass1ResultRow | null;
};

/** Stable identity for a scored row, used to match thread members against it. */
function resultKey(r: {
  item_type: string;
  cluster_index: number | null;
  preprocessed_item_id: string | null;
}): string {
  return r.item_type === "cluster"
    ? `C${r.cluster_index}`
    : `S${Number(r.preprocessed_item_id)}`;
}

async function loadThreads(threadRunId: number): Promise<ThreadInfo[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    score: number;
    item_type: string;
    cluster_index: number | null;
    preprocessed_item_id: string | null;
  }>(
    `SELECT t.id, t.score, m.item_type, m.cluster_index, m.preprocessed_item_id
     FROM threads t
     JOIN thread_members m ON m.thread_id = t.id
     WHERE t.thread_run_id = $1
     ORDER BY t.thread_index ASC`,
    [threadRunId],
  );

  const byId = new Map<string, ThreadInfo>();
  for (const row of rows) {
    let info = byId.get(row.id);
    if (!info) {
      info = { id: row.id, score: row.score, memberKeys: [] };
      byId.set(row.id, info);
    }
    info.memberKeys.push(resultKey(row));
  }
  return [...byId.values()];
}

export async function assembleGroupingPile(
  groupingPass1RunId: number,
  threadRunId?: number,
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

  // 2b. Load threads and the rows they absorbed. A threaded row must not also
  //     appear on its own — that repetition is what the thread pass exists to
  //     remove — so members are withheld and the thread stands in for them.
  const threads = threadRunId !== undefined ? await loadThreads(threadRunId) : [];
  const absorbed = new Set<string>();
  for (const t of threads) {
    for (const key of t.memberKeys) absorbed.add(key);
  }

  const unthreaded = resultRows.filter((r) => !absorbed.has(resultKey(r)));

  // 3. Rank threads and un-threaded rows together on the pass-1 score, then
  //    apply the pile target. A thread carries max(member score), so it sorts
  //    where its strongest member would have.
  const modelConfig = loadModelConfig();
  const pileTarget = modelConfig.grouping.pile_target;

  const ranked: PileCandidate[] = [
    ...threads.map((t) => ({
      kind: "thread" as const,
      threadId: t.id,
      score: t.score,
      row: null,
    })),
    ...unthreaded.map((r) => ({
      kind: "row" as const,
      threadId: null,
      score: r.score,
      row: r,
    })),
  ].sort((a, b) => b.score - a.score);

  const inPileCandidates = ranked.slice(0, pileTarget);
  const belowLineCandidates = ranked.slice(pileTarget);

  const threadsInPile = inPileCandidates.filter((c) => c.kind === "thread");
  const inPile = inPileCandidates
    .filter((c) => c.kind === "row")
    .map((c) => c.row!);
  const belowLine = belowLineCandidates
    .filter((c) => c.kind === "row")
    .map((c) => c.row!);

  if (threads.length > 0) {
    console.log(
      `[pile] ${threads.length} thread(s) from run #${threadRunId} absorbed ` +
        `${absorbed.size} row(s); ${threadsInPile.length} thread(s) in pile`,
    );
  }

  const lastCandidate =
    inPileCandidates.length > 0
      ? inPileCandidates[inPileCandidates.length - 1]
      : null;
  const scoreCutoff: number | null = lastCandidate ? lastCandidate.score : null;

  const clustersInPile = inPile.filter((r) => r.item_type === "cluster").length;
  const singletonsInPile = inPile.filter((r) => r.item_type === "singleton").length;

  // 4. Create editor_piles row. singleton_pile_target is repurposed as the
  //    general pile target. clusters_included and singletons_in_pile track the
  //    in-pile breakdown. singletons_below_line counts all items (both types)
  //    that didn't make the cut.
  const { rows: pileRows } = await pool.query<EditorPileRow>(
    `INSERT INTO editor_piles
       (grouping_run_id, grouping_pass1_run_id, thread_run_id, singleton_pile_target,
        clusters_included, singletons_in_pile, singletons_below_line, score_cutoff)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      groupingRunId,
      groupingPass1RunId,
      threadRunId ?? null,
      pileTarget,
      clustersInPile,
      singletonsInPile,
      belowLine.length,
      scoreCutoff,
    ],
  );
  const pileId = pileRows[0]!.id;

  // 4b. Insert thread pile items. Threads below the line are not persisted as
  //     pile rows — the threads table already records them, and an out-of-pile
  //     thread has no editor meaning.
  for (const c of threadsInPile) {
    await pool.query(
      `INSERT INTO editor_pile_items (pile_id, item_type, thread_id, in_pile, score, reason)
       VALUES ($1, 'thread', $2, true, $3, $4)`,
      [pileId, c.threadId, c.score, "thread: max(member score)"],
    );
  }

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
    threadRunId: threadRunId ?? null,
    pileTarget,
    clustersInPile,
    singletonsInPile,
    threadsInPile: threadsInPile.length,
    itemsBelowLine: belowLine.length,
    scoreCutoff,
  };
}
