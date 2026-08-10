import "dotenv/config";
import { runGroupingPass1 } from "../src/pipeline/editor-pass-1/index.js";
import { assembleGroupingPile } from "../src/pipeline/editor-pass-1/assemble-pile.js";
import { runThreading } from "../src/pipeline/thread/index.js";
import { loadModelConfig } from "../src/config/models.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let groupingRunId: number | undefined;
  let modelOverride: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grouping-run-id" && i + 1 < args.length) {
      groupingRunId = parseInt(args[++i]!, 10);
    } else if (args[i] === "--model" && i + 1 < args.length) {
      modelOverride = args[++i];
    }
  }

  return { groupingRunId, modelOverride };
}

async function main() {
  const { groupingRunId, modelOverride } = parseArgs(process.argv);

  console.log("[grouping-pass-1] starting...");
  const run = await runGroupingPass1({ groupingRunId, modelOverride });
  console.log(
    `[grouping-pass-1] run #${run.id} complete: ` +
      `${run.itemsIn} items scored, model=${run.modelUsed}`,
  );

  // Thread pass runs between scoring and pile assembly: it needs the scores to
  // pick candidates, and the pile needs its results so a threaded row does not
  // also appear on its own.
  const { thread: threadConfig } = loadModelConfig();
  let threadRunId: number | undefined;
  if (threadConfig.enabled) {
    const threadRun = await runThreading({ groupingPass1RunId: run.id });
    threadRunId = threadRun.threadRunId;
  } else {
    console.log("[thread] disabled — pile will contain un-threaded rows");
  }

  const pile = await assembleGroupingPile(run.id, threadRunId);
  console.log(
    `[grouping-pass-1] pile #${pile.pileId}: ` +
      `${pile.threadsInPile} threads + ${pile.clustersInPile} clusters + ` +
      `${pile.singletonsInPile} singletons in pile ` +
      `(target=${pile.pileTarget}, score_cutoff=${pile.scoreCutoff ?? "n/a"}, ` +
      `below_line=${pile.itemsBelowLine})`,
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
