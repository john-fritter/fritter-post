/**
 * CLI entry point for the categorizer stage.
 *
 * Usage:
 *   npm run categorize
 *   npm run categorize -- --preprocessor-run-id 3
 *   npm run categorize -- --model deepseek-v4-pro
 */

import "dotenv/config";
import { Pool } from "pg";
import { runCategorizer } from "../src/pipeline/categorizer/index.js";
import { loadModelConfig } from "../src/config/models.js";

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

async function printTagDistribution(runId: number): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) return;
  const pool = new Pool({ connectionString: url });
  try {
    const { rows: sectionRows } = await pool.query<{ section: string; n: string }>(
      `SELECT section, COUNT(*) AS n
       FROM categorizer_results, jsonb_array_elements_text(sections) AS section
       WHERE categorizer_run_id = $1
       GROUP BY section
       ORDER BY COUNT(*) DESC`,
      [runId]
    );
    const { rows: multiRows } = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM categorizer_results
       WHERE categorizer_run_id = $1
         AND jsonb_array_length(sections) >= 2`,
      [runId]
    );

    console.log("\nTag distribution:");
    for (const row of sectionRows) {
      console.log(`  ${row.section.padEnd(14)}: ${row.n}`);
    }
    const multiCount = multiRows[0]?.n ?? "0";
    console.log(`\nItems with 2+ tags: ${multiCount}`);
  } finally {
    await pool.end();
  }
}

async function main() {
  const flags = parseArgs(process.argv);

  const preprocessorRunId = flags["preprocessor-run-id"]
    ? parseInt(flags["preprocessor-run-id"], 10)
    : undefined;

  if (preprocessorRunId !== undefined && isNaN(preprocessorRunId)) {
    console.error("--preprocessor-run-id must be a number");
    process.exit(1);
  }

  const modelOverride = flags["model"];

  const modelConfig = loadModelConfig();
  const effectiveModel = modelOverride ?? modelConfig.categorizer.model;

  console.log("Starting categorizer…");
  if (preprocessorRunId !== undefined) {
    console.log(`  preprocessor-run-id: ${preprocessorRunId}`);
  }
  console.log(`  model:      ${effectiveModel}${modelOverride ? " (override)" : " (default)"}`);
  console.log(`  batch_size: ${modelConfig.categorizer.batch_size}`);
  console.log(`  concurrency: ${modelConfig.categorizer.concurrency}`);
  console.log("");

  const run = await runCategorizer({ preprocessorRunId, modelOverride });

  console.log(`\nCategorizer run #${run.id} complete.`);
  console.log(`  Preprocessor run:  #${run.preprocessorRunId}`);
  console.log(`  Model:             ${run.modelUsed}`);
  console.log(`  Items in:          ${run.itemsIn}`);
  console.log(`  Items categorized: ${run.itemsCategorized}`);
  console.log(`  Fallback (general-tagged due to error): ${run.fallbackCount}`);

  await printTagDistribution(run.id);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
