/**
 * Publishes a writer run as the day's paper.
 *
 * Usage:
 *   npm run publish -- --writer-run 47
 *   npm run publish -- --writer-run 47 --date 2026-08-27
 *
 * --date overrides the edition date, which otherwise comes from the writer
 * run's own start time in the reader's timezone. Re-publishing a date replaces
 * that paper rather than adding a second one, so this is safe to re-run.
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
  const writerRunId = flags["writer-run"] ? parseInt(flags["writer-run"], 10) : NaN;

  if (Number.isNaN(writerRunId)) {
    console.error("Usage: npm run publish -- --writer-run <n> [--date YYYY-MM-DD]");
    process.exit(1);
  }
  if (flags["date"] && !/^\d{4}-\d{2}-\d{2}$/.test(flags["date"])) {
    console.error(`--date must be YYYY-MM-DD, got "${flags["date"]}"`);
    process.exit(1);
  }

  const summary = await runPublisher({
    writerRunId,
    ...(flags["date"] ? { date: flags["date"] } : {}),
  });

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
