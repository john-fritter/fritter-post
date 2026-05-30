/**
 * CLI entry point for the preprocessor stage.
 *
 * Usage:
 *   npm run preprocess
 *   npm run preprocess -- --collector-run-id 3
 */

import "dotenv/config";
import { runPreprocessor } from "../src/pipeline/preprocessor/index.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
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

  const collectorRunId = flags["collector-run-id"]
    ? parseInt(flags["collector-run-id"], 10)
    : undefined;

  if (collectorRunId !== undefined && isNaN(collectorRunId)) {
    console.error("--collector-run-id must be a number");
    process.exit(1);
  }

  console.log("Starting preprocessor…");
  if (collectorRunId !== undefined) {
    console.log(`  collector-run-id: ${collectorRunId}`);
  }

  const run = await runPreprocessor({ collectorRunId });

  console.log(`\nPreprocessor run #${run.id} complete.`);
  console.log(`  Raw items considered:   ${run.rawItemsConsidered}`);
  console.log(`  Items kept:             ${run.itemsKept}`);
  console.log(`  Dropped (recency):      ${run.itemsDroppedRecency}`);
  console.log(`  Dropped (duplicate):    ${run.itemsDroppedDuplicate}`);
  if (run.notes) console.log(`  Notes: ${run.notes}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
