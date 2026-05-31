/**
 * CLI entry point for the triage stage.
 *
 * Usage:
 *   npm run triage
 *   npm run triage -- --preprocessor-run-id 3
 *   npm run triage -- --model deepseek-v4-flash
 */

import "dotenv/config";
import { runTriage } from "../src/pipeline/triage/index.js";
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
  const effectiveModel = modelOverride ?? modelConfig.triage.model;

  console.log("Starting triage…");
  if (preprocessorRunId !== undefined) {
    console.log(`  preprocessor-run-id: ${preprocessorRunId}`);
  }
  console.log(`  model: ${effectiveModel}${modelOverride ? " (override)" : " (default)"}`);

  const run = await runTriage({ preprocessorRunId, modelOverride });

  console.log(`\nTriage run #${run.id} complete.`);
  console.log(`  Preprocessor run:  #${run.preprocessorRunId}`);
  console.log(`  Model:             ${run.modelUsed}`);
  console.log(`  Input tokens:      ${run.inputTokens ?? "unknown"}`);
  console.log(`  Output tokens:     ${run.outputTokens ?? "unknown"}`);
  console.log(`  Duration:          ${run.durationMs !== null ? `${run.durationMs}ms` : "unknown"}`);
  console.log(`  Generation log:    #${run.generationLogId ?? "none"}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
