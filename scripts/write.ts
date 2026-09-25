/**
 * Writes the paper's pieces for an editor run.
 *
 * Usage:
 *   npm run write
 *   npm run write -- --editor-run 112
 *   npm run write -- --editor-run 112 --tier feature --limit 3
 *   npm run write -- --repair 3
 *
 * Model comparison (writes a writer run and nothing else; never publish it):
 *   npm run write -- --editor-run 112 --ranks 1-6,20,40 \
 *     --model <id> [--provider nanogpt] [--reasoning-effort low|omit] [--max-tokens 16000]
 *
 * --reasoning-effort omit sends no reasoning_effort at all, for a model that
 * rejects the field.
 * --tier and --limit exist for a cautious first run: three features cost three
 * calls and show whether the prose is worth 150 of them.
 */

import "dotenv/config";
import { runWriters, repairWriterRun } from "../src/pipeline/writers/index.js";
import { overridesFromFlags } from "../src/config/overrides.js";

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

/** "1-6,20,40" -> [1,2,3,4,5,6,20,40]. */
function parseRanks(spec: string): number[] {
  const ranks: number[] = [];
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`--ranks: cannot read "${part}"`);
    const lo = parseInt(m[1]!, 10);
    const hi = m[2] !== undefined ? parseInt(m[2], 10) : lo;
    for (let r = lo; r <= hi; r++) ranks.push(r);
  }
  return ranks;
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

  // No --editor-run means the latest completed one, as in the middle stages.
  const editorRunId = flags["editor-run"] ? parseInt(flags["editor-run"], 10) : undefined;
  if (editorRunId !== undefined && Number.isNaN(editorRunId)) {
    console.error("--editor-run must be a number");
    process.exit(1);
  }

  const overrides = overridesFromFlags(flags);

  const summary = await runWriters({
    ...(editorRunId !== undefined ? { editorRunId } : {}),
    ...(flags["tier"] ? { tier: flags["tier"] } : {}),
    ...(flags["limit"] ? { limit: parseInt(flags["limit"], 10) } : {}),
    ...(flags["ranks"] ? { ranks: parseRanks(flags["ranks"]) } : {}),
    ...(overrides ? { overrides } : {}),
  });

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
