/**
 * Fetches publisher article text for the stories of an editor run.
 *
 * Usage:
 *   npm run fetch-text
 *   npm run fetch-text -- --editor-run 112
 *   npm run fetch-text -- --editor-run 112 --dry-run
 *   npm run fetch-text -- --editor-run 112 --limit 20
 *
 * --dry-run plans and prints the worklist without making a single request.
 * --limit caps the number of URLs requested, for a first cautious run.
 */

import "dotenv/config";
import { runArticleFetch } from "../src/pipeline/writers/fetch-text.js";

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
  // No --editor-run means the latest completed one, which is what every stage
  // in the middle of the pipeline has always done with its own upstream.
  const editorRunId = flags["editor-run"] ? parseInt(flags["editor-run"], 10) : undefined;
  if (editorRunId !== undefined && Number.isNaN(editorRunId)) {
    console.error("--editor-run must be a number");
    process.exit(1);
  }

  const summary = await runArticleFetch({
    ...(editorRunId !== undefined ? { editorRunId } : {}),
    dryRun: flags["dry-run"] === "true",
    ...(flags["limit"] ? { limit: parseInt(flags["limit"], 10) } : {}),
  });

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
