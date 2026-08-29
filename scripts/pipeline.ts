/**
 * The daily run: every stage in order, with a gate between each pair.
 *
 * Usage:
 *   npm run pipeline
 *   npm run pipeline -- --from editor
 *   npm run pipeline -- --from write --to publish
 *   npm run pipeline -- --dry-run
 *   npm run pipeline -- --print-timer [--working-dir /opt/fritter-post]
 *
 * --from is the recovery path, and it is not the same as re-running. Retrying
 * from `collect` is not idempotent in the useful sense: the preprocessor's
 * cross-run dedup suppresses everything recent runs already processed, so a
 * same-day full re-run comes back near-empty by design and would replace a good
 * paper with an empty one. The tail is safely re-runnable — papers.published_on
 * is unique and the publisher deletes-then-inserts — so recovery resumes.
 *
 * This is also why the systemd unit has no Restart=on-failure.
 */

import "dotenv/config";
import { runPipeline } from "../src/pipeline/runner/index.js";
import { isStageName, type StageName } from "../src/pipeline/runner/stages.js";
import { buildTimerUnits } from "../src/pipeline/runner/timer.js";
import { loadModelConfig } from "../src/config/models.js";

const DEFAULT_WORKING_DIR = "/opt/fritter-post";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        flags[key] = value;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

function requireStage(value: string | undefined, flag: string): StageName | undefined {
  if (value === undefined) return undefined;
  if (!isStageName(value)) {
    console.error(`${flag} must be a stage name, got "${value}"`);
    process.exit(1);
  }
  return value;
}

function printTimer(workingDir: string): void {
  const { schedule, max_duration_minutes } = loadModelConfig().pipeline;
  const units = buildTimerUnits({
    time: schedule.time,
    timezone: schedule.timezone,
    workingDir,
    maxDurationMinutes: max_duration_minutes,
  });

  console.log(`# ── /etc/systemd/system/${units.serviceName} ──`);
  console.log(units.service);
  console.log(`# ── /etc/systemd/system/${units.timerName} ──`);
  console.log(units.timer);
  console.log("# ── install ──");
  console.log("# systemctl daemon-reload");
  console.log(`# systemctl enable --now ${units.timerName}`);
  console.log(`# systemctl list-timers ${units.timerName}`);
}

async function main() {
  const flags = parseArgs(process.argv);

  if (flags["print-timer"] === "true") {
    printTimer(flags["working-dir"] ?? DEFAULT_WORKING_DIR);
    process.exit(0);
  }

  const from = requireStage(flags["from"], "--from");
  const to = requireStage(flags["to"], "--to");

  const summary = await runPipeline({
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    dryRun: flags["dry-run"] === "true",
  });

  if (flags["dry-run"] === "true") process.exit(0);

  const minutes = (summary.durationMs / 60_000).toFixed(1);
  console.log(`\n[pipeline] run #${summary.pipelineRunId}: ${summary.status} in ${minutes} min`);
  for (const s of summary.stages) {
    const secs = (s.durationMs / 1000).toFixed(0);
    const id = s.stageRunId !== null ? ` #${s.stageRunId}` : "";
    console.log(`  ${s.status.padEnd(7)} ${s.stage.padEnd(15)}${id.padEnd(7)} ${secs}s`);
    for (const reason of s.reasons) console.log(`          ↳ ${reason}`);
  }
  if (summary.stoppedAtStage) {
    console.log(`\n[pipeline] stopped at ${summary.stoppedAtStage}: ${summary.stoppedReason}`);
  }
  if (summary.lineage.paperId !== null) {
    console.log(`[pipeline] paper #${summary.lineage.paperId} published`);
  }

  // Exit code carries the verdict, because the thing invoking this is systemd
  // and `systemctl status` is where a failure is first seen. 'degraded' exits 0
  // on purpose: a paper came out, and a red unit every time one brief fails
  // would teach the reader to ignore a red unit.
  process.exit(summary.status === "aborted" || summary.status === "failed" ? 1 : 0);
}

main().catch((err) => {
  // The message, not the stack: a stage that threw has already had its stack
  // written to pipeline_stage_runs.error and printed by the runner, and what
  // reaches here is usually a bad flag.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
