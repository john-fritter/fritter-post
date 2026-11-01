/**
 * Computes and freezes a paper's price (paper_steps + paper_costs).
 *
 * Usage:
 *   npm run price                    the latest paper
 *   npm run price -- --paper 52
 *   npm run price -- --all           every paper, oldest first
 *
 * The publisher does this itself for every new paper. This is for papers
 * published before it did, and for repricing on purpose after the list prices
 * in config/models.yaml change: a paper is otherwise priced once, at the prices
 * of the morning it was made. Each run replaces the paper's rows, so it is safe
 * to repeat.
 */

import "dotenv/config";
import { getPool } from "../src/db/index.js";
import { recordPaperPrice } from "../src/pipeline/publish/price-record.js";
import { formatUsd } from "../src/pipeline/publish/price.js";

function parseArgs(argv: string[]): Record<string, string> {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith("--")) {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        flags[arg.slice(2)] = value;
        i++;
      } else {
        flags[arg.slice(2)] = "true";
      }
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv);
  const pool = getPool();

  let paperIds: number[];
  if (flags["all"] === "true") {
    const { rows } = await pool.query<{ id: number }>("SELECT id FROM papers ORDER BY published_on, id");
    paperIds = rows.map((r) => r.id);
  } else if (flags["paper"]) {
    const id = parseInt(flags["paper"], 10);
    if (Number.isNaN(id)) {
      console.error("--paper must be a number");
      process.exit(1);
    }
    paperIds = [id];
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM papers ORDER BY published_on DESC, id DESC LIMIT 1",
    );
    paperIds = rows.map((r) => r.id);
  }

  if (paperIds.length === 0) {
    console.error("No papers to price.");
    process.exit(1);
  }

  let failed = 0;
  for (const id of paperIds) {
    try {
      const r = await recordPaperPrice(id);
      const notes = [
        r.unpricedModels.length > 0 ? `unpriced: ${r.unpricedModels.join(", ")}` : null,
        r.untimedSteps.length > 0 ? `untimed: ${r.untimedSteps.join(", ")}` : null,
      ].filter((n) => n !== null);
      console.log(
        `paper #${id}: ${formatUsd(r.totalUsd)} over ${r.calls} call(s)` +
          (notes.length > 0 ? ` (${notes.join("; ")})` : ""),
      );
    } catch (err) {
      failed++;
      console.error(`paper #${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
