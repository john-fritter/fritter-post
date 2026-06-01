/**
 * CLI entry point for the filter stage.
 *
 * Usage:
 *   npm run filter
 *   npm run filter -- --preprocessor-run-id 3
 *   npm run filter -- --model gpt-oss-120b
 */

import "dotenv/config";
import { runFilter } from "../src/pipeline/filter/index.js";
import { loadModelConfig } from "../src/config/models.js";

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

  const preprocessorRunId = flags["preprocessor-run-id"]
    ? parseInt(flags["preprocessor-run-id"], 10)
    : undefined;

  if (preprocessorRunId !== undefined && isNaN(preprocessorRunId)) {
    console.error("--preprocessor-run-id must be a number");
    process.exit(1);
  }

  const modelOverride = flags["model"];

  const modelConfig = loadModelConfig();
  const effectiveModel = modelOverride ?? modelConfig.filter.model;

  console.log("Starting filter…");
  if (preprocessorRunId !== undefined) {
    console.log(`  preprocessor-run-id: ${preprocessorRunId}`);
  }
  console.log(`  model: ${effectiveModel}${modelOverride ? " (override)" : " (default)"}`);
  console.log(`  batch_size: ${modelConfig.filter.batch_size}`);
  console.log(`  concurrency: ${modelConfig.filter.concurrency}`);
  console.log("");

  const run = await runFilter({ preprocessorRunId, modelOverride });

  console.log(`\nFilter run #${run.id} complete.`);
  console.log(`  Preprocessor run:  #${run.preprocessorRunId}`);
  console.log(`  Model:             ${run.modelUsed}`);
  console.log(`  Items in:          ${run.itemsIn}`);
  console.log(`  Items kept:        ${run.itemsKept}`);
  console.log(`  Items dropped:     ${run.itemsDropped}`);
  if (run.itemsIn > 0) {
    const pct = ((run.itemsDropped / run.itemsIn) * 100).toFixed(1);
    console.log(`  Drop rate:         ${pct}%`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
