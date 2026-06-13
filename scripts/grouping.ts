/**
 * CLI entry point for the embedding-based grouping stage.
 *
 * Runs in parallel with triage on the same input — compare digests with
 * the inspect tool or by diffing grouping_runs.digest vs triage_runs.digest.
 *
 * Usage:
 *   npm run grouping
 *   npm run grouping -- --preprocessor-run-id 3
 *   npm run grouping -- --model alibaba/qwen3.6-27b:thinking
 */

import "dotenv/config";
import { runGrouping } from "../src/pipeline/grouping/index.js";
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
  const effectiveModel = modelOverride ?? modelConfig.grouping.model;
  const cfg = modelConfig.grouping;

  console.log("Starting grouping…");
  if (preprocessorRunId !== undefined) {
    console.log(`  preprocessor-run-id:  ${preprocessorRunId}`);
  }
  console.log(`  model:                ${effectiveModel}${modelOverride ? " (override)" : " (default)"}`);
  console.log(`  similarity_threshold: ${cfg.embedding.similarity_threshold}`);
  console.log(`  top_k:                ${cfg.embedding.top_k}`);
  console.log(`  min_group_size:       ${cfg.refine.min_group_size}`);
  console.log(`  embed_body_cap:       ${cfg.embedding.body_cap} chars`);

  const run = await runGrouping({ preprocessorRunId, modelOverride });

  console.log(`\nGrouping run #${run.id} complete.`);
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
