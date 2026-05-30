/**
 * CLI entry point for the prompt assembler.
 *
 * Usage:
 *   npm run assemble -- --run-id 1
 *   npm run assemble -- --run-id 1 --output /tmp/triage-sample.txt
 */

import "dotenv/config";
import { writeFileSync } from "fs";
import { assembleTriageDocument } from "../src/pipeline/preprocessor/assembler.js";

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

  if (!flags["run-id"]) {
    console.error("Usage: npm run assemble -- --run-id <n> [--output <filepath>]");
    process.exit(1);
  }

  const runId = parseInt(flags["run-id"], 10);
  if (isNaN(runId)) {
    console.error("--run-id must be a number");
    process.exit(1);
  }

  const doc = await assembleTriageDocument(runId);

  if (flags["output"]) {
    writeFileSync(flags["output"], doc, "utf-8");
    console.log(`Written to ${flags["output"]}`);
  } else {
    process.stdout.write(doc);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
