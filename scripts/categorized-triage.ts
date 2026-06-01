/**
 * CLI entry point for the per-category clustering stage.
 *
 * Usage:
 *   npm run categorized-triage
 *   npm run categorized-triage -- --categorizer-run-id 2
 *   npm run categorized-triage -- --model deepseek-v4-pro
 */

import "dotenv/config";
import { runCategorizedTriage } from "../src/pipeline/categorizer/triage.js";
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

  const categorizerRunId = flags["categorizer-run-id"]
    ? parseInt(flags["categorizer-run-id"], 10)
    : undefined;

  if (categorizerRunId !== undefined && isNaN(categorizerRunId)) {
    console.error("--categorizer-run-id must be a number");
    process.exit(1);
  }

  const modelOverride = flags["model"];

  const modelConfig = loadModelConfig();
  const effectiveModel = modelOverride ?? modelConfig.categorized_triage.model;

  console.log("Starting categorized triage…");
  if (categorizerRunId !== undefined) {
    console.log(`  categorizer-run-id: ${categorizerRunId}`);
  }
  console.log(`  model:       ${effectiveModel}${modelOverride ? " (override)" : " (default)"}`);
  console.log(`  concurrency: ${modelConfig.categorized_triage.concurrency}`);
  console.log("");

  const run = await runCategorizedTriage({ categorizerRunId, modelOverride });

  console.log(`\nCategorized triage run #${run.id} complete.`);
  console.log(`  Categorizer run:   #${run.categorizerRunId}`);
  console.log(`  Preprocessor run:  #${run.preprocessorRunId}`);
  console.log(`  Model:             ${run.modelUsed}`);
  console.log(`  Total clusters:    ${run.totalClusters ?? 0}`);
  console.log(`  Straddle items:    ${run.straddleReport?.length ?? 0}`);
  console.log(`  Residual items:    ${run.residualItemIds?.length ?? 0}`);

  if (run.integrityFlags) {
    const { fabricatedIds, duplicateIdsWithinSection, singletonClusters } = run.integrityFlags;
    if (fabricatedIds.length > 0) {
      console.log(`  ⚠  Fabricated IDs: ${fabricatedIds.join(", ")}`);
    }
    if (duplicateIdsWithinSection.length > 0) {
      console.log(`  ⚠  Duplicate IDs within section: ${duplicateIdsWithinSection.length}`);
    }
    if (singletonClusters.length > 0) {
      console.log(`  ⚠  Singleton clusters (< 2 items): ${singletonClusters.length}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
