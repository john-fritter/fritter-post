/**
 * The daily run: nine stages in order, with a decision between each pair.
 *
 * The ordering is the least of it. A shell script can call nine commands, and
 * for most of the pipeline it would even thread the ids correctly, because the
 * middle stages already default to their latest completed upstream run. What a
 * shell script cannot do is notice that a stage failed while exiting 0, and
 * that is the failure this pipeline actually has:
 *
 *   - the writers return a normal summary after the circuit breaker trips, so
 *     `write && publish` would freeze an edition of holes;
 *   - a failed attach call returns an empty set, indistinguishable from the
 *     model declining every candidate;
 *   - the editor's tie-break catch returns an empty rank map, which is what a
 *     tie group the model declined to order also returns;
 *   - the thread pass losing its one call yields zero threads, which is what a
 *     day with no ongoing situations also yields.
 *
 * Each of those is counted on the stage's own run row already. The runner reads
 * them back through gates.ts and decides whether the next stage starts.
 */

import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import type { GateVerdict } from "./gates.js";
import {
  STAGES,
  STAGE_NAMES,
  emptyLineage,
  type Lineage,
  type StageName,
} from "./stages.js";

export type PipelineStatus = "running" | "ok" | "degraded" | "aborted" | "failed";

export interface PipelineRunSummary {
  pipelineRunId: number;
  status: PipelineStatus;
  startedFrom: StageName;
  stoppedAtStage: StageName | null;
  stoppedReason: string | null;
  lineage: Lineage;
  stages: {
    stage: StageName;
    status: "ok" | "warn" | "abort" | "failed" | "skipped";
    stageRunId: number | null;
    reasons: string[];
    durationMs: number;
  }[];
  durationMs: number;
}

export interface RunPipelineOptions {
  /** Stage to start at. Anything but "collect" is a resume. */
  from?: StageName;
  /** Stage to stop after, inclusive. */
  to?: StageName;
  /** Print the plan and the inherited lineage, run nothing. */
  dryRun?: boolean;
}

const LINEAGE_COLUMNS: Record<keyof Lineage, string> = {
  collectorRunId: "collector_run_id",
  preprocessorRunId: "preprocessor_run_id",
  prefilterRunId: "prefilter_run_id",
  groupingRunId: "grouping_run_id",
  groupingPass1RunId: "grouping_pass1_run_id",
  threadRunId: "thread_run_id",
  pileId: "pile_id",
  editorRunId: "editor_run_id",
  writerRunId: "writer_run_id",
  paperId: "paper_id",
};

/**
 * Inherits the ids of the most recent pipeline run.
 *
 * A resume has to know what it is resuming. The stages would each fall back to
 * "the latest completed upstream run" if told nothing, which is usually the
 * same answer and is a guess -- the same guess `inspect timing` makes with its
 * six-hour heuristic, and which was wrong for run #45. The recorded lineage is
 * the reason migration 042 exists, so a resume reads it rather than re-deriving
 * it. When there is no recorded run to inherit from (the first run after the
 * migration), the stages' own defaults are left to do their job.
 */
async function inheritLineage(): Promise<{ lineage: Lineage; inheritedFrom: number | null }> {
  const pool = getPool();
  const { rows } = await pool.query<Record<string, number | null>>(
    `SELECT id, collector_run_id, preprocessor_run_id, prefilter_run_id, grouping_run_id,
            grouping_pass1_run_id, thread_run_id, pile_id, editor_run_id, writer_run_id, paper_id
       FROM pipeline_runs
      ORDER BY started_at DESC LIMIT 1`,
  );
  const row = rows[0];
  const lineage = emptyLineage();
  if (!row) return { lineage, inheritedFrom: null };
  for (const [key, column] of Object.entries(LINEAGE_COLUMNS) as [keyof Lineage, string][]) {
    lineage[key] = row[column] ?? null;
  }
  return { lineage, inheritedFrom: row["id"] ?? null };
}

async function persistLineage(pipelineRunId: number, lineage: Lineage): Promise<void> {
  const pool = getPool();
  const entries = Object.entries(LINEAGE_COLUMNS) as [keyof Lineage, string][];
  const sets = entries.map(([, column], i) => `${column} = $${i + 2}`).join(", ");
  await pool.query(
    `UPDATE pipeline_runs SET ${sets} WHERE id = $1`,
    [pipelineRunId, ...entries.map(([key]) => lineage[key])],
  );
}

/** Gate verdicts and stage statuses are the same word for the first three. */
function statusFor(verdict: GateVerdict): "ok" | "warn" | "abort" {
  return verdict === "ok" ? "ok" : verdict === "warn" ? "warn" : "abort";
}

export async function runPipeline(
  options: RunPipelineOptions = {},
): Promise<PipelineRunSummary> {
  const config = loadModelConfig().pipeline;

  const from: StageName = options.from ?? "collect";
  const startIndex = STAGES.findIndex((s) => s.name === from);
  const endIndex = options.to ? STAGES.findIndex((s) => s.name === options.to) : STAGES.length - 1;
  if (startIndex < 0) throw new Error(`Unknown stage "${from}"`);
  if (endIndex < 0) throw new Error(`Unknown stage "${options.to}"`);
  if (endIndex < startIndex) {
    throw new Error(`--to ${options.to} comes before --from ${from}`);
  }

  const planned = STAGES.slice(startIndex, endIndex + 1);

  // A resume inherits the lineage of the last recorded run; a full run starts
  // clean, so a re-run at 6am does not silently attach to yesterday's ids.
  const { lineage, inheritedFrom } =
    startIndex === 0 ? { lineage: emptyLineage(), inheritedFrom: null } : await inheritLineage();

  if (options.dryRun) {
    console.log(`[pipeline] plan: ${planned.map((s) => s.name).join(" → ")}`);
    if (inheritedFrom !== null) {
      console.log(`[pipeline] would inherit lineage from pipeline run #${inheritedFrom}:`);
      for (const [key, value] of Object.entries(lineage)) {
        if (value !== null) console.log(`             ${key}: ${value}`);
      }
    }
    console.log(`[pipeline] deadline: ${config.max_duration_minutes} minutes (checked between stages)`);
    console.log("[pipeline] --dry-run: nothing was run");
    return {
      pipelineRunId: -1,
      status: "ok",
      startedFrom: from,
      stoppedAtStage: null,
      stoppedReason: null,
      lineage,
      stages: [],
      durationMs: 0,
    };
  }

  const startedAt = Date.now();
  const deadlineMs = config.max_duration_minutes * 60_000;

  // Not before here: --dry-run prints the plan and the argument errors above
  // fire without one, and needing a database to be told a stage name is wrong
  // is the kind of friction that stops anyone checking.
  const pool = getPool();

  const { rows: runRows } = await pool.query<{ id: number }>(
    "INSERT INTO pipeline_runs (started_from, notes) VALUES ($1, $2) RETURNING id",
    [from, inheritedFrom !== null ? `lineage inherited from pipeline run #${inheritedFrom}` : null],
  );
  const pipelineRunId = runRows[0]!.id;
  console.log(
    `[pipeline] run #${pipelineRunId}: ${planned.map((s) => s.name).join(" → ")}` +
      (inheritedFrom !== null ? ` (resuming from pipeline run #${inheritedFrom})` : ""),
  );
  if (inheritedFrom !== null) await persistLineage(pipelineRunId, lineage);

  const stageResults: PipelineRunSummary["stages"] = [];
  let status: PipelineStatus = "ok";
  let stoppedAtStage: StageName | null = null;
  let stoppedReason: string | null = null;
  let sawWarning = false;

  for (const [i, stage] of planned.entries()) {
    const seq = startIndex + i;

    // The deadline is checked here and only here. An in-flight LLM call cannot
    // be cancelled from this process, so a deadline that claimed to interrupt
    // one would be a lie; what it can honestly do is refuse to START the next
    // stage, which is worth real money at `write`. The hard kill is systemd's.
    const elapsed = Date.now() - startedAt;
    if (elapsed > deadlineMs) {
      stoppedAtStage = stage.name;
      stoppedReason =
        `deadline: ${Math.round(elapsed / 60_000)} min elapsed of ` +
        `${config.max_duration_minutes} allowed — not starting ${stage.name}`;
      status = "aborted";
      await pool.query(
        `INSERT INTO pipeline_stage_runs (pipeline_run_id, stage, seq, status, completed_at, gate_verdict, gate_reasons)
         VALUES ($1, $2, $3, 'skipped', NOW(), 'abort', $4)`,
        [pipelineRunId, stage.name, seq, stoppedReason],
      );
      console.error(`[pipeline] ${stoppedReason}`);
      break;
    }

    // The stage row is written when the stage STARTS. A run killed by the
    // systemd timeout must leave behind which stage it died in, and a
    // status='running' row with no completed_at says that without ambiguity.
    const { rows: stageRows } = await pool.query<{ id: number }>(
      `INSERT INTO pipeline_stage_runs (pipeline_run_id, stage, seq) VALUES ($1, $2, $3) RETURNING id`,
      [pipelineRunId, stage.name, seq],
    );
    const stageRowId = stageRows[0]!.id;
    const stageStartedAt = Date.now();
    console.log(`\n[pipeline] ── ${stage.name} ──`);

    let outcome;
    try {
      outcome = await stage.run({ lineage, dryRun: false });
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      await pool.query(
        `UPDATE pipeline_stage_runs
            SET status = 'failed', completed_at = NOW(), error = $2
          WHERE id = $1`,
        [stageRowId, message],
      );
      stageResults.push({
        stage: stage.name,
        status: "failed",
        stageRunId: null,
        reasons: [message.split("\n")[0] ?? message],
        durationMs: Date.now() - stageStartedAt,
      });
      status = "failed";
      stoppedAtStage = stage.name;
      stoppedReason = `${stage.name} threw: ${message.split("\n")[0]}`;
      console.error(`[pipeline] ${stage.name} FAILED: ${message}`);
      break;
    }

    Object.assign(lineage, outcome.lineage);
    await persistLineage(pipelineRunId, lineage);

    const stageStatus = statusFor(outcome.gate.verdict);
    await pool.query(
      `UPDATE pipeline_stage_runs
          SET status = $2, completed_at = NOW(), stage_run_id = $3,
              gate_verdict = $4, gate_reasons = $5, metrics = $6
        WHERE id = $1`,
      [
        stageRowId,
        stageStatus,
        outcome.stageRunId,
        outcome.gate.verdict,
        outcome.gate.reasons.length > 0 ? outcome.gate.reasons.join("\n") : null,
        JSON.stringify(outcome.metrics),
      ],
    );

    stageResults.push({
      stage: stage.name,
      status: stageStatus,
      stageRunId: outcome.stageRunId,
      reasons: outcome.gate.reasons,
      durationMs: Date.now() - stageStartedAt,
    });

    for (const reason of outcome.gate.reasons) {
      const label = outcome.gate.verdict === "abort" ? "ABORT" : "WARN";
      console.warn(`[pipeline] ${label} ${stage.name}: ${reason}`);
    }

    if (outcome.gate.verdict === "warn") sawWarning = true;
    if (outcome.gate.verdict === "abort") {
      status = "aborted";
      stoppedAtStage = stage.name;
      stoppedReason = outcome.gate.reasons.join("; ");
      break;
    }
  }

  if (status === "ok" && sawWarning) status = "degraded";

  await pool.query(
    `UPDATE pipeline_runs
        SET completed_at = NOW(), status = $2, stopped_at_stage = $3, stopped_reason = $4
      WHERE id = $1`,
    [pipelineRunId, status, stoppedAtStage, stoppedReason],
  );

  const durationMs = Date.now() - startedAt;
  return {
    pipelineRunId,
    status,
    startedFrom: from,
    stoppedAtStage,
    stoppedReason,
    lineage,
    stages: stageResults,
    durationMs,
  };
}

export { STAGE_NAMES, type StageName, type Lineage };
