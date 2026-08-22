/**
 * Writes the paper's pieces for an editor run.
 *
 * Usage:
 *   npm run write -- --editor-run 112
 *   npm run write -- --editor-run 112 --tier feature --limit 3
 *   npm run write -- --repair 3
 *
 * --tier and --limit exist for a cautious first run: three features cost three
 * calls and show whether the prose is worth 150 of them.
 */

import "dotenv/config";
import { runWriters, repairWriterRun } from "../src/pipeline/writers/index.js";

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

  // Repair re-writes only the failed pieces of an existing run, in place: a
  // paper is one run, and filling three holes should not cost 150 calls.
  if (flags["repair"]) {
    const summary = await repairWriterRun(parseInt(flags["repair"], 10));
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  }

  const editorRunId = flags["editor-run"] ? parseInt(flags["editor-run"], 10) : NaN;
  if (Number.isNaN(editorRunId)) {
    console.error(
      "Usage: npm run write -- --editor-run <n> [--tier <tier>] [--limit <n>]\n" +
        "       npm run write -- --repair <writer-run-id>",
    );
    process.exit(1);
  }

  const summary = await runWriters({
    editorRunId,
    ...(flags["tier"] ? { tier: flags["tier"] } : {}),
    ...(flags["limit"] ? { limit: parseInt(flags["limit"], 10) } : {}),
  });

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
