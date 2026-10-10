/**
 * The paper's price: finding its calls and freezing them.
 *
 * A paper's model calls are found through its lineage, not by date: the paper
 * names its writer and editor runs, the editor run its pile, and the pile the
 * score, novelty, thread and cluster runs it was built from. Each of those is
 * the `stage_run_id` its calls were logged under. A call that went into a run
 * this paper did not use (an aborted morning, a write run replaced by another)
 * is not this paper's, and is not counted.
 *
 * Called by the publisher after continuity, so the publish step's own calls
 * are in; and by `npm run price` for papers published before this existed.
 * Writing replaces the paper's rows, so it is safe to run again.
 */

import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import {
  LOG_STAGE_STEP,
  PRICE_STEPS,
  costUsd,
  findPrice,
  stepDuration,
  type PriceStep,
} from "./price.js";

export interface PriceRecordSummary {
  paperId: number;
  totalUsd: number;
  calls: number;
  /** Models with calls and no price entry. Their calls cost nothing above. */
  unpricedModels: string[];
  /** Steps whose time could not be found. */
  untimedSteps: PriceStep[];
}

interface Lineage {
  paperId: number;
  paperStartedAt: Date;
  paperCompletedAt: Date | null;
  storyCount: number;
  writerRunId: number;
  editorRunId: number;
  pass1RunId: number | null;
  threadRunId: number | null;
  rerunRunId: number | null;
  groupingRunId: number | null;
  prefilterRunId: number | null;
  preprocessorRunId: number | null;
  collectorRunId: number | null;
}

type Span = { startedAt: Date | null; completedAt: Date | null };

interface StepFacts {
  span: Span;
  itemsOut: number | null;
  sources?: number | null;
}

async function loadLineage(paperId: number): Promise<Lineage> {
  const pool = getPool();
  const { rows } = await pool.query<{
    started_at: Date; completed_at: Date | null; story_count: number;
    writer_run_id: number; editor_run_id: number;
    pass1: number | null; thread: number | null; rerun: number | null;
    grouping: number | null; preprocessor: number | null; grouping_started: Date | null;
    collector: number | null; preprocess_started: Date | null;
  }>(
    `SELECT p.started_at, p.completed_at, p.story_count, p.writer_run_id, p.editor_run_id,
            pl.grouping_pass1_run_id AS pass1, pl.thread_run_id AS thread,
            pl.rerun_run_id AS rerun,
            g.id AS grouping, g.preprocessor_run_id AS preprocessor,
            g.started_at AS grouping_started,
            pr.collector_run_id AS collector, pr.started_at AS preprocess_started
       FROM papers p
       JOIN editor_runs e ON e.id = p.editor_run_id
       LEFT JOIN editor_piles pl ON pl.id = e.pile_id
       LEFT JOIN grouping_runs g ON g.id = COALESCE(pl.grouping_run_id, e.grouping_run_id)
       LEFT JOIN preprocessor_runs pr ON pr.id = g.preprocessor_run_id
      WHERE p.id = $1`,
    [paperId],
  );
  const r = rows[0];
  if (!r) throw new Error(`Paper #${paperId} not found`);

  // Cluster reads the latest screen run completed for its preprocess run
  // (getClusteringItems), so that is the one that fed this paper: the latest
  // completed before the cluster run started.
  let prefilterRunId: number | null = null;
  if (r.preprocessor !== null) {
    const { rows: pf } = await pool.query<{ id: number }>(
      `SELECT id FROM prefilter_runs
        WHERE preprocessor_run_id = $1 AND completed_at IS NOT NULL
          AND ($2::timestamptz IS NULL OR completed_at <= $2)
        ORDER BY completed_at DESC LIMIT 1`,
      [r.preprocessor, r.grouping_started],
    );
    prefilterRunId = pf[0]?.id ?? null;
  }

  // A preprocess run records its collector run only when it was handed one;
  // NULL means it read whatever had been collected, so take the last full
  // collection before it started.
  let collectorRunId = r.collector;
  if (collectorRunId === null && r.preprocess_started !== null) {
    const { rows: cr } = await pool.query<{ id: number }>(
      `SELECT id FROM collector_runs
        WHERE completed_at IS NOT NULL AND completed_at <= $1 AND source_filter IS NULL
        ORDER BY completed_at DESC LIMIT 1`,
      [r.preprocess_started],
    );
    collectorRunId = cr[0]?.id ?? null;
  }

  return {
    paperId,
    paperStartedAt: r.started_at,
    paperCompletedAt: r.completed_at,
    storyCount: r.story_count,
    writerRunId: r.writer_run_id,
    editorRunId: r.editor_run_id,
    pass1RunId: r.pass1,
    threadRunId: r.thread,
    rerunRunId: r.rerun,
    groupingRunId: r.grouping,
    prefilterRunId,
    preprocessorRunId: r.preprocessor,
    collectorRunId,
  };
}

/** The (stage label, stage_run_id) pairs this paper's calls were logged under. */
function logKeys(l: Lineage): Array<[string, number]> {
  const keys: Array<[string, number | null]> = [
    ["preprocess", l.preprocessorRunId],
    ["screen", l.prefilterRunId],
    ["cluster", l.groupingRunId],
    ["score", l.pass1RunId],
    ["novelty", l.rerunRunId],
    ["thread", l.threadRunId],
    ["rank-tie-break", l.editorRunId],
    ["write", l.writerRunId],
    ["write-briefs", l.writerRunId],
    ["continuity", l.paperId],
  ];
  return keys.filter((k): k is [string, number] => k[1] !== null);
}

/** The run id each runner stage records as its stage_run_id. */
function runnerKeys(l: Lineage): Array<[PriceStep, number | null]> {
  return [
    ["collect", l.collectorRunId],
    ["preprocess", l.preprocessorRunId],
    ["screen", l.prefilterRunId],
    ["cluster", l.groupingRunId],
    ["score", l.pass1RunId],
    ["rank", l.editorRunId],
    ["write", l.writerRunId],
    ["publish", l.paperId],
  ];
}

type RunnerRow = { startedAt: Date; completedAt: Date; metrics: Record<string, unknown> | null };

/** The runner's finished row for each step, where the paper came from a runner. */
async function loadRunnerRows(l: Lineage): Promise<Map<PriceStep, RunnerRow>> {
  const pool = getPool();
  const keys = runnerKeys(l).filter((k): k is [PriceStep, number] => k[1] !== null);
  const { rows } = await pool.query<{
    stage: PriceStep; started_at: Date; completed_at: Date; metrics: Record<string, unknown> | null;
  }>(
    `SELECT DISTINCT ON (s.stage) s.stage, s.started_at, s.completed_at, s.metrics
       FROM pipeline_stage_runs s
       JOIN unnest($1::text[], $2::int[]) AS k(stage, run_id)
         ON s.stage = k.stage AND s.stage_run_id = k.run_id
      WHERE s.completed_at IS NOT NULL AND s.status IN ('ok', 'warn', 'abort')
      ORDER BY s.stage, s.id DESC`,
    [keys.map((k) => k[0]), keys.map((k) => k[1])],
  );
  const out = new Map<PriceStep, RunnerRow>();
  for (const r of rows) {
    out.set(r.stage, { startedAt: r.started_at, completedAt: r.completed_at, metrics: r.metrics });
  }

  // Fetch writes no run row, so the runner records no id for it. It is the
  // fetch stage of a pipeline run whose lineage names this editor run.
  const { rows: fetchRows } = await pool.query<{
    started_at: Date; completed_at: Date; metrics: Record<string, unknown> | null;
  }>(
    `SELECT s.started_at, s.completed_at, s.metrics
       FROM pipeline_stage_runs s
       JOIN pipeline_runs r ON r.id = s.pipeline_run_id
      WHERE s.stage = 'fetch' AND r.editor_run_id = $1
        AND s.completed_at IS NOT NULL AND s.status IN ('ok', 'warn', 'abort')
      ORDER BY s.id DESC LIMIT 1`,
    [l.editorRunId],
  );
  const f = fetchRows[0];
  if (f) out.set("fetch", { startedAt: f.started_at, completedAt: f.completed_at, metrics: f.metrics });
  return out;
}

/** What each step produced and when it ran, from the stage run tables. */
async function loadStepFacts(l: Lineage, publishEnd: Date): Promise<Map<PriceStep, StepFacts>> {
  const pool = getPool();
  const one = async <T extends object>(sql: string, id: number | null): Promise<T | null> => {
    if (id === null) return null;
    const { rows } = await pool.query<T & object>(sql, [id]);
    return rows[0] ?? null;
  };
  type Times = { started_at: Date | null; completed_at: Date | null };
  const span = (t: Times | null): Span => ({
    startedAt: t?.started_at ?? null,
    completedAt: t?.completed_at ?? null,
  });

  const collector = await one<Times & { sources_succeeded: number }>(
    "SELECT started_at, completed_at, sources_succeeded FROM collector_runs WHERE id = $1",
    l.collectorRunId,
  );
  const pre = await one<Times & { raw_items_considered: number; items_kept: number }>(
    `SELECT started_at, completed_at, raw_items_considered, items_kept
       FROM preprocessor_runs WHERE id = $1`,
    l.preprocessorRunId,
  );
  const screen = await one<Times & { items_kept: number }>(
    "SELECT started_at, completed_at, items_kept FROM prefilter_runs WHERE id = $1",
    l.prefilterRunId,
  );
  const cluster = await one<Times & { cluster_count: number | null; singleton_count: number | null }>(
    "SELECT started_at, completed_at, cluster_count, singleton_count FROM grouping_runs WHERE id = $1",
    l.groupingRunId,
  );
  const pass1 = await one<Times>(
    "SELECT started_at, completed_at FROM grouping_pass1_runs WHERE id = $1",
    l.pass1RunId,
  );
  const thread = await one<Times>("SELECT started_at, completed_at FROM thread_runs WHERE id = $1", l.threadRunId);
  const rerun = await one<Times>("SELECT started_at, completed_at FROM rerun_runs WHERE id = $1", l.rerunRunId);
  const rank = await one<Times & { items_in: number; ranked: number }>(
    `SELECT started_at, completed_at, items_in,
            items_feature + items_standard + items_brief AS ranked
       FROM editor_runs WHERE id = $1`,
    l.editorRunId,
  );
  const write = await one<Times & { pieces_written: number }>(
    "SELECT started_at, completed_at, pieces_written FROM writer_runs WHERE id = $1",
    l.writerRunId,
  );

  // Score's run row closes before its novelty and thread passes finish; the
  // step ends with the last of the three.
  const scoreEnds = [pass1, thread, rerun]
    .map((t) => t?.completed_at ?? null)
    .filter((d): d is Date => d !== null);
  const scoreEnd = scoreEnds.length > 0 ? new Date(Math.max(...scoreEnds.map((d) => d.getTime()))) : null;

  const events =
    cluster?.cluster_count != null && cluster.singleton_count != null
      ? cluster.cluster_count + cluster.singleton_count
      : null;

  return new Map<PriceStep, StepFacts>([
    ["collect", { span: span(collector), itemsOut: pre?.raw_items_considered ?? null, sources: collector?.sources_succeeded ?? null }],
    ["preprocess", { span: span(pre), itemsOut: pre?.items_kept ?? null }],
    ["screen", { span: span(screen), itemsOut: screen?.items_kept ?? null }],
    ["cluster", { span: span(cluster), itemsOut: events }],
    ["score", { span: { startedAt: pass1?.started_at ?? null, completedAt: scoreEnd }, itemsOut: rank?.items_in ?? null }],
    ["rank", { span: span(rank), itemsOut: rank?.ranked ?? null }],
    ["fetch", { span: { startedAt: null, completedAt: null }, itemsOut: null }],
    ["write", { span: span(write), itemsOut: write?.pieces_written ?? null }],
    ["publish", { span: { startedAt: l.paperStartedAt, completedAt: publishEnd }, itemsOut: l.storyCount }],
  ]);
}

interface CallGroup {
  stage: string;
  model: string;
  calls: number;
  failed: number;
  noUsage: number;
  inputTokens: number;
  outputTokens: number;
  modelMs: number;
}

async function loadCalls(l: Lineage): Promise<CallGroup[]> {
  const keys = logKeys(l);
  const { rows } = await getPool().query<{
    stage: string; model: string; calls: string; failed: string; no_usage: string;
    input_tokens: string; output_tokens: string; model_ms: string;
  }>(
    `SELECT g.stage, g.model,
            COUNT(*)::text AS calls,
            COUNT(*) FILTER (WHERE g.error IS NOT NULL)::text AS failed,
            COUNT(*) FILTER (WHERE g.input_tokens IS NULL AND g.output_tokens IS NULL)::text AS no_usage,
            COALESCE(SUM(g.input_tokens), 0)::text AS input_tokens,
            COALESCE(SUM(g.output_tokens), 0)::text AS output_tokens,
            COALESCE(SUM(g.duration_ms), 0)::text AS model_ms
       FROM generation_logs g
       JOIN unnest($1::text[], $2::int[]) AS k(stage, run_id)
         ON g.stage = k.stage AND g.stage_run_id = k.run_id
      GROUP BY g.stage, g.model`,
    [keys.map((k) => k[0]), keys.map((k) => k[1])],
  );
  return rows.map((r) => ({
    stage: r.stage,
    model: r.model,
    calls: Number(r.calls),
    failed: Number(r.failed),
    noUsage: Number(r.no_usage),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    modelMs: Number(r.model_ms),
  }));
}

/**
 * Compute and freeze a paper's price.
 *
 * `publishEnd` is when the publish step finished. The publisher passes "now",
 * after continuity; a backfill leaves it out and the runner's row, or the
 * paper's own completed_at, stands in.
 */
export async function recordPaperPrice(
  paperId: number,
  options: { publishEnd?: Date } = {},
): Promise<PriceRecordSummary> {
  const pool = getPool();
  const pricing = loadModelConfig().pricing;
  const lineage = await loadLineage(paperId);

  const publishEnd = options.publishEnd ?? lineage.paperCompletedAt ?? lineage.paperStartedAt;
  const runner = await loadRunnerRows(lineage);
  // During the publisher's own run its runner row is still open, so the end it
  // was handed is the honest one.
  if (options.publishEnd) runner.delete("publish");
  const facts = await loadStepFacts(lineage, publishEnd);
  const calls = await loadCalls(lineage);

  // Fetch has no run table; what it read is on the runner's row.
  const fetchOk = runner.get("fetch")?.metrics?.["ok"];
  const fetchFacts = facts.get("fetch")!;
  if (typeof fetchOk === "number") fetchFacts.itemsOut = fetchOk;

  // Calls grouped by (step, model). Two log labels can share a step (write
  // and write-briefs), so this is a second grouping, not the query's.
  const byStepModel = new Map<string, CallGroup & { step: PriceStep }>();
  const unplaced: string[] = [];
  for (const c of calls) {
    const step = LOG_STAGE_STEP[c.stage];
    if (!step) {
      unplaced.push(c.stage);
      continue;
    }
    const key = `${step}\u0000${c.model}`;
    const prev = byStepModel.get(key);
    if (!prev) {
      byStepModel.set(key, { ...c, step });
    } else {
      prev.calls += c.calls;
      prev.failed += c.failed;
      prev.noUsage += c.noUsage;
      prev.inputTokens += c.inputTokens;
      prev.outputTokens += c.outputTokens;
      prev.modelMs += c.modelMs;
    }
  }
  if (unplaced.length > 0) {
    // logKeys only asks for labels LOG_STAGE_STEP knows, so this is a bug
    // between the two tables, not a data condition.
    throw new Error(`Calls logged under stages with no price step: ${unplaced.join(", ")}`);
  }

  let totalUsd = 0;
  let totalCalls = 0;
  const unpriced = new Set<string>();
  const untimed: PriceStep[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM paper_steps WHERE paper_id = $1", [paperId]);
    await client.query("DELETE FROM paper_costs WHERE paper_id = $1", [paperId]);

    for (let seq = 0; seq < PRICE_STEPS.length; seq++) {
      const step = PRICE_STEPS[seq]!;
      const f = facts.get(step)!;
      const r = runner.get(step);
      const t = stepDuration(r ? { startedAt: r.startedAt, completedAt: r.completedAt } : null, f.span);
      if (t.durationMs === null) untimed.push(step);
      await client.query(
        `INSERT INTO paper_steps (paper_id, step, seq, started_at, duration_ms, items_out, sources)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [paperId, step, seq, t.startedAt, t.durationMs, f.itemsOut, f.sources ?? null],
      );
    }

    for (const g of byStepModel.values()) {
      const price = findPrice(pricing, g.model);
      const cost = price ? costUsd(g.inputTokens, g.outputTokens, price) : null;
      if (cost === null) unpriced.add(g.model);
      else totalUsd += cost;
      totalCalls += g.calls;
      await client.query(
        `INSERT INTO paper_costs (paper_id, step, model, calls, failed_calls, calls_without_usage,
                                  input_tokens, output_tokens, model_ms, model_label, model_name,
                                  maker, input_per_mtok, output_per_mtok, price_source,
                                  price_as_of, cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          paperId, g.step, g.model, g.calls, g.failed, g.noUsage, g.inputTokens,
          g.outputTokens, g.modelMs, price?.label ?? null, price?.name ?? null,
          price?.maker ?? null, price?.inputPerMtok ?? null, price?.outputPerMtok ?? null,
          price?.source ?? null, price?.asOf ?? null, cost,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    paperId,
    totalUsd,
    calls: totalCalls,
    unpricedModels: [...unpriced],
    untimedSteps: untimed,
  };
}
