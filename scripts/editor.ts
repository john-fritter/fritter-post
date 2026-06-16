/**
 * CLI entry point for the editor stage (deterministic combined-score formula).
 *
 * Usage:
 *   npm run editor
 *   npm run editor -- --pile-id 3
 */

import "dotenv/config";
import { runEditor } from "../src/pipeline/editor/index.js";

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

  const pileId = flags["pile-id"] ? parseInt(flags["pile-id"], 10) : undefined;
  if (pileId !== undefined && isNaN(pileId)) {
    console.error("--pile-id must be a number");
    process.exit(1);
  }

  console.log("Starting editor…");
  if (pileId !== undefined) {
    console.log(`  pile-id: ${pileId}`);
  }
  console.log("");

  const run = await runEditor({ pileId });

  console.log(`\nEditor run #${run.id} complete.`);
  console.log(`  Pile:         #${run.pileId}`);
  if (run.groupingRunId !== null) {
    console.log(`  Grouping run: #${run.groupingRunId}`);
  }
  console.log(`  Items in:     ${run.itemsIn}`);
  console.log(`  Feature:      ${run.itemsFeature}`);
  console.log(`  Standard:     ${run.itemsStandard}`);
  console.log(`  Brief:        ${run.itemsBrief}`);
  console.log(`  Cut:          ${run.itemsCut}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
