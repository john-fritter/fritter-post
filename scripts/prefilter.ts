/**
 * CLI entry point for the prefilter stage (bio-aware relevance floor).
 *
 * Usage:
 *   npm run prefilter
 *   npm run prefilter -- --preprocessor-run-id 3
 *   npm run prefilter -- --model glm-5.1
 */

import "dotenv/config";
import { runPrefilter } from "../src/pipeline/prefilter/index.js";
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
  const effectiveModel = modelOverride ?? modelConfig.prefilter.model;

  console.log("Starting prefilter…");
  if (preprocessorRunId !== undefined) {
    console.log(`  preprocessor-run-id: ${preprocessorRunId}`);
  }
  console.log(`  model: ${effectiveModel}${modelOverride ? " (override)" : " (default)"}`);
  console.log(`  batch_size: ${modelConfig.prefilter.batch_size}`);
  console.log(`  concurrency: ${modelConfig.prefilter.concurrency}`);
  console.log("");

  const run = await runPrefilter({ preprocessorRunId, modelOverride });

  console.log(`\nPrefilter run #${run.id} complete.`);
  console.log(`  Preprocessor run:  #${run.preprocessorRunId}`);
  console.log(`  Model:             ${run.modelUsed}`);
  console.log(`  Items in:          ${run.itemsIn}`);
  console.log(`  Items kept:        ${run.itemsKept}`);
  console.log(`  Items cut:         ${run.itemsCut}`);
  if (run.itemsIn > 0) {
    const pct = ((run.itemsCut / run.itemsIn) * 100).toFixed(1);
    console.log(`  Cut rate:          ${pct}%`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
