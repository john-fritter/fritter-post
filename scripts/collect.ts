/**
 * Collector CLI. Fetches all configured feeds and writes raw items to the DB.
 *
 * Usage:
 *   npm run collect
 *   npm run collect -- --source "NPR News"
 *   npm run collect -- --source "AP Top News" --concurrency 5
 */

import "dotenv/config";
import { runCollector } from "../src/pipeline/collector/index.js";

function parseArgs(argv: string[]): { source?: string; concurrency?: number } {
  const args = argv.slice(2);
  const opts: { source?: string; concurrency?: number } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--source" && args[i + 1]) {
      opts.source = args[++i];
    } else if (arg === "--concurrency" && args[i + 1]) {
      const n = parseInt(args[++i]!, 10);
      if (!isNaN(n) && n > 0) opts.concurrency = n;
    }
  }

  return opts;
}

async function main() {
  const { source, concurrency } = parseArgs(process.argv);
  await runCollector({ sourceFilter: source, concurrency });
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
