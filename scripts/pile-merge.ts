/**
 * CLI entry point for the pile-merge stage (same-story merge pass over the
 * assembled editor pile).
 *
 * Usage:
 *   npm run pile-merge
 *   npm run pile-merge -- --pile-id 7
 */

import "dotenv/config";
import { runPileMerge } from "../src/pipeline/pile-merge/index.js";

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

  console.log("Starting pile-merge…");
  if (pileId !== undefined) {
    console.log(`  pile-id: ${pileId}`);
  }
  console.log("");

  const run = await runPileMerge({ pileId });

  console.log(`\nPile-merge run #${run.id} complete.`);
  console.log(`  Pile:          #${run.editorPileId}`);
  console.log(`  Model:         ${run.modelUsed}`);
  console.log(`  Items in:      ${run.itemsIn}`);
  console.log(`  Groups merged: ${run.groupsMerged}`);
  console.log(`  Items out:     ${run.itemsOut}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
