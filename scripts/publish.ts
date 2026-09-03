/**
 * Publishes a writer run as the day's paper.
 *
 * Usage:
 *   npm run publish
 *   npm run publish -- --writer-run 47
 *   npm run publish -- --writer-run 47 --date 2026-08-27
 *   npm run publish -- --writer-run 47 --force
 *
 * --date overrides the edition date, which otherwise comes from the writer
 * run's own start time in the reader's timezone. Re-publishing a date replaces
 * that paper rather than adding a second one, so this is safe to re-run.
 *
 * --force replaces a paper even when the replacement is substantially smaller.
 * Without it the publisher refuses, because a second run on the same day sees
 * only the hours since the first — cross-run dedup gave the earlier run today's
 * news — so it would trade a full edition for a thin one.
 */

import "dotenv/config";
import { runPublisher } from "../src/pipeline/publisher/index.js";

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

async function main() {
  const flags = parseArgs(process.argv);
  // No --writer-run means the latest completed one, as in the middle stages.
  const writerRunId = flags["writer-run"] ? parseInt(flags["writer-run"], 10) : undefined;
  if (writerRunId !== undefined && Number.isNaN(writerRunId)) {
    console.error("--writer-run must be a number");
    process.exit(1);
  }
  if (flags["date"] && !/^\d{4}-\d{2}-\d{2}$/.test(flags["date"])) {
    console.error(`--date must be YYYY-MM-DD, got "${flags["date"]}"`);
    process.exit(1);
  }

  const summary = await runPublisher({
    ...(writerRunId !== undefined ? { writerRunId } : {}),
    ...(flags["force"] === "true" ? { force: true } : {}),
    ...(flags["date"] ? { date: flags["date"] } : {}),
  });

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  // The message, not the stack. The publisher's refusals are designed outcomes
  // that name their own remedy, and a stack above them reads as a crash. When
  // the runner drives this stage the full stack is persisted to
  // pipeline_stage_runs.error regardless.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
