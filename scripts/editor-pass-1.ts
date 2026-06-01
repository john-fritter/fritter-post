/**
 * CLI entry point for the editor-pass-1 stage.
 *
 * Usage:
 *   npm run editor-pass-1
 *   npm run editor-pass-1 -- --triage-run-id 3
 *   npm run editor-pass-1 -- --model glm-5.1
 */

import "dotenv/config";
import { runEditorPass1 } from "../src/pipeline/editor-pass-1/index.js";
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

  const triageRunId = flags["triage-run-id"]
    ? parseInt(flags["triage-run-id"], 10)
    : undefined;

  if (triageRunId !== undefined && isNaN(triageRunId)) {
    console.error("--triage-run-id must be a number");
    process.exit(1);
  }

  const modelOverride = flags["model"];

  const modelConfig = loadModelConfig();
  const effectiveModel = modelOverride ?? modelConfig.editor_pass_1.model;

  console.log("Starting editor-pass-1…");
  if (triageRunId !== undefined) {
    console.log(`  triage-run-id: ${triageRunId}`);
  }
  console.log(`  model: ${effectiveModel}${modelOverride ? " (override)" : " (default)"}`);
  console.log(`  batch_size: ${modelConfig.editor_pass_1.batch_size}`);
  console.log(`  concurrency: ${modelConfig.editor_pass_1.concurrency}`);
  console.log("");

  const run = await runEditorPass1({ triageRunId, modelOverride });

  console.log(`\nEditor-pass-1 run #${run.id} complete.`);
  console.log(`  Triage run:   #${run.triageRunId}`);
  console.log(`  Model:        ${run.modelUsed}`);
  console.log(`  Items in:     ${run.itemsIn}`);
  console.log(`  Research:     ${run.itemsResearch}`);
  console.log(`  Footer:       ${run.itemsFooter}`);
  console.log(`  Cut:          ${run.itemsCut}`);
  if (run.itemsIn > 0) {
    const cutPct = ((run.itemsCut / run.itemsIn) * 100).toFixed(1);
    console.log(`  Cut rate:     ${cutPct}%`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
