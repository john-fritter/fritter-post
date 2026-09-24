import "dotenv/config";
import { runRerunCheck } from "../src/pipeline/rerun/index.js";
import { getPool } from "../src/db/index.js";
import { overridesFromFlags } from "../src/config/overrides.js";

// Runs the rerun check on its own, for measurement. It writes rerun_runs and
// rerun_verdicts (plus the generation_logs every call writes) and nothing else:
// no pile, no thread run, no paper. `--as-of` makes an old grouping-pass-1 run
// judge against the papers that existed on its day rather than those made since.
//
//   npm run rerun-check -- --grouping-pass1-run <n> --as-of YYYY-MM-DD
//
// Model comparison: the same run judged by another model, with every other
// setting production's. rerun_runs.model_used records which.
//
//   npm run rerun-check -- --grouping-pass1-run <n> --as-of YYYY-MM-DD \
//     --model <id> [--provider nanogpt] [--reasoning-effort none|low|omit] [--max-tokens <n>]

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let groupingPass1RunId: number | undefined;
  let asOf: string | undefined;
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grouping-pass1-run" && i + 1 < args.length) {
      groupingPass1RunId = parseInt(args[++i]!, 10);
    } else if (args[i] === "--as-of" && i + 1 < args.length) {
      asOf = args[++i];
    } else if (args[i]!.startsWith("--") && i + 1 < args.length) {
      flags[args[i]!.slice(2)] = args[++i]!;
    }
  }
  return { groupingPass1RunId, asOf, overrides: overridesFromFlags(flags) };
}

async function main() {
  const { groupingPass1RunId, asOf, overrides } = parseArgs(process.argv);
  if (groupingPass1RunId === undefined || !Number.isFinite(groupingPass1RunId)) {
    console.error("Usage: npm run rerun-check -- --grouping-pass1-run <n> [--as-of YYYY-MM-DD]");
    process.exit(1);
  }
  if (asOf !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    console.error(`--as-of must be YYYY-MM-DD, got "${asOf}"`);
    process.exit(1);
  }
  const r = await runRerunCheck({
    groupingPass1RunId,
    ...(asOf ? { asOf } : {}),
    ...(overrides ? { overrides } : {}),
  });
  console.log(
    `[rerun-check] rerun run #${r.rerunRunId}: ${r.dropped.size} of ${r.candidatesIn} rows would be ` +
      `withheld; ${r.pairsJudged} pairs, ${r.calls} calls, ${r.failedCalls} failed. ` +
      `See: npm run inspect -- reruns --id ${r.rerunRunId} --all`,
  );
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
