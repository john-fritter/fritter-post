/**
 * Inspection CLI for the Fritter Post pipeline.
 *
 * Usage:
 *   npm run inspect -- count
 *   npm run inspect -- count --source "AP Top News"
 *   npm run inspect -- list
 *   npm run inspect -- list --source "ProPublica" --limit 20
 *   npm run inspect -- collector
 *   npm run inspect -- collector --id 3
 *   npm run inspect -- preprocessor
 *   npm run inspect -- preprocessor --id 1
 */

import "dotenv/config";
import { Pool } from "pg";

interface RawItemRow {
  id: string;
  source_name: string;
  source_type: string;
  title: string;
  original_url: string;
  author: string | null;
  published_at: string | null;
  fetched_at: string;
}

interface CollectorRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  source_filter: string | null;
  sources_attempted: number;
  sources_succeeded: number;
  items_fetched: number;
  items_inserted: number;
  per_source_results: SourceResult[] | null;
}

interface SourceResult {
  source_name: string;
  status: "success" | "error";
  items_fetched: number;
  items_inserted: number;
  error_message?: string;
  duration_ms: number;
}

interface PreprocessorRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  collector_run_id: number | null;
  raw_items_considered: number;
  items_kept: number;
  items_dropped_recency: number;
  items_dropped_duplicate: number;
  notes: string | null;
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2); // strip node + script path
  const command = args[0];
  const subcommand = args[1]?.startsWith("--") ? undefined : args[1];
  const flagStart = subcommand !== undefined ? 2 : 1;
  const flags: Record<string, string> = {};

  for (let i = flagStart; i < args.length; i++) {
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

  return { command, subcommand, flags };
}

async function main() {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }

  const { command, flags } = parseArgs(process.argv);

  const pool = new Pool({ connectionString: url });

  try {
    switch (command) {
      case "count": {
        let query = "SELECT COUNT(*) AS n FROM raw_items";
        const params: string[] = [];
        if (flags["source"]) {
          params.push(flags["source"]);
          query += ` WHERE source_name = $${params.length}`;
        }
        const { rows } = await pool.query<{ n: string }>(query, params);
        const label = flags["source"] ? `"${flags["source"]}"` : "all sources";
        console.log(`raw_items (${label}): ${rows[0]?.n ?? 0}`);
        break;
      }

      case "list": {
        const limit = parseInt(flags["limit"] ?? "50", 10);
        let query = `
          SELECT id, source_name, source_type, title, original_url, author,
                 published_at, fetched_at
          FROM raw_items
        `;
        const params: Array<string | number> = [];
        if (flags["source"]) {
          params.push(flags["source"]);
          query += ` WHERE source_name = $${params.length}`;
        }
        query += ` ORDER BY fetched_at DESC LIMIT $${params.length + 1}`;
        params.push(limit);

        const { rows } = await pool.query<RawItemRow>(query, params);

        if (rows.length === 0) {
          console.log("No items found.");
          break;
        }

        for (const row of rows) {
          const pub = row.published_at
            ? new Date(row.published_at).toISOString().slice(0, 16)
            : "no date";
          console.log(
            `[${row.id}] ${row.source_name} (${row.source_type}) — ${pub}`
          );
          console.log(`  ${row.title}`);
          console.log(`  ${row.original_url}`);
          if (row.author) console.log(`  by ${row.author}`);
          console.log();
        }
        break;
      }

      case "collector": {
        if (flags["id"]) {
          // Detail view for one run.
          const runId = parseInt(flags["id"], 10);
          const { rows } = await pool.query<CollectorRunRow>(
            "SELECT * FROM collector_runs WHERE id = $1",
            [runId]
          );
          const run = rows[0];
          if (!run) {
            console.log(`No collector run with id ${runId}`);
            break;
          }
          const started = new Date(run.started_at).toISOString().slice(0, 19);
          const finished = run.completed_at
            ? new Date(run.completed_at).toISOString().slice(0, 19)
            : "in progress / crashed";
          console.log(`Run #${run.id}`);
          console.log(`  Started:   ${started}`);
          console.log(`  Completed: ${finished}`);
          if (run.source_filter) console.log(`  Filter:    ${run.source_filter}`);
          console.log(
            `  Sources:   ${run.sources_succeeded}/${run.sources_attempted} succeeded`
          );
          console.log(
            `  Items:     ${run.items_fetched} fetched, ${run.items_inserted} new`
          );
          console.log();

          if (run.per_source_results) {
            const results = run.per_source_results;
            const failed = results.filter((r) => r.status === "error");
            const succeeded = results.filter((r) => r.status === "success");

            if (failed.length > 0) {
              console.log("Failed sources:");
              for (const r of failed) {
                console.log(`  ✗ ${r.source_name} (${r.duration_ms}ms)`);
                if (r.error_message) console.log(`    ${r.error_message}`);
              }
              console.log();
            }

            console.log("Succeeded sources:");
            for (const r of succeeded.sort((a, b) => b.items_fetched - a.items_fetched)) {
              console.log(
                `  ✓ ${r.source_name}: ${r.items_fetched} fetched, ` +
                `${r.items_inserted} new (${r.duration_ms}ms)`
              );
            }
          }
        } else {
          // Summary list of recent runs.
          const limit = parseInt(flags["limit"] ?? "20", 10);
          const { rows } = await pool.query<CollectorRunRow>(
            `SELECT id, started_at, completed_at, source_filter,
                    sources_attempted, sources_succeeded, items_fetched, items_inserted
             FROM collector_runs
             ORDER BY started_at DESC
             LIMIT $1`,
            [limit]
          );

          if (rows.length === 0) {
            console.log("No collector runs recorded.");
            break;
          }

          console.log(
            `${"ID".padEnd(6)} ${"Started".padEnd(19)} ${"Sources".padEnd(10)} ${"Fetched".padEnd(9)} ${"New".padEnd(7)} Filter`
          );
          console.log("─".repeat(70));

          for (const run of rows) {
            const started = new Date(run.started_at).toISOString().slice(0, 19);
            const sources = run.completed_at
              ? `${run.sources_succeeded}/${run.sources_attempted}`
              : "running…";
            const filter = run.source_filter ?? "";
            console.log(
              `${String(run.id).padEnd(6)} ${started} ${sources.padEnd(10)} ${String(run.items_fetched).padEnd(9)} ${String(run.items_inserted).padEnd(7)} ${filter}`
            );
          }
        }
        break;
      }

      case "preprocessor": {
        if (flags["id"]) {
          // Detail view for one run.
          const runId = parseInt(flags["id"], 10);
          const { rows } = await pool.query<PreprocessorRunRow>(
            "SELECT * FROM preprocessor_runs WHERE id = $1",
            [runId]
          );
          const run = rows[0];
          if (!run) {
            console.log(`No preprocessor run with id ${runId}`);
            break;
          }
          const started = new Date(run.started_at).toISOString().slice(0, 19);
          const finished = run.completed_at
            ? new Date(run.completed_at).toISOString().slice(0, 19)
            : "in progress / crashed";
          console.log(`Run #${run.id}`);
          console.log(`  Started:                 ${started}`);
          console.log(`  Completed:               ${finished}`);
          if (run.collector_run_id !== null) {
            console.log(`  Collector run id:        ${run.collector_run_id}`);
          }
          console.log(`  Raw items considered:    ${run.raw_items_considered}`);
          console.log(`  Items kept:              ${run.items_kept}`);
          console.log(`  Dropped (recency):       ${run.items_dropped_recency}`);
          console.log(`  Dropped (duplicate):     ${run.items_dropped_duplicate}`);
          if (run.notes) console.log(`  Notes: ${run.notes}`);
        } else {
          // Summary list of recent runs.
          const limit = parseInt(flags["limit"] ?? "20", 10);
          const { rows } = await pool.query<PreprocessorRunRow>(
            `SELECT id, started_at, completed_at, collector_run_id,
                    raw_items_considered, items_kept,
                    items_dropped_recency, items_dropped_duplicate, notes
             FROM preprocessor_runs
             ORDER BY started_at DESC
             LIMIT $1`,
            [limit]
          );

          if (rows.length === 0) {
            console.log("No preprocessor runs recorded.");
            break;
          }

          console.log(
            `${"ID".padEnd(6)} ${"Started".padEnd(19)} ${"Considered".padEnd(12)} ${"Kept".padEnd(8)} ${"RecDrop".padEnd(10)} DupDrop`
          );
          console.log("─".repeat(65));

          for (const run of rows) {
            const started = new Date(run.started_at).toISOString().slice(0, 19);
            const status = run.completed_at ? "" : " (running…)";
            console.log(
              `${String(run.id).padEnd(6)} ${started} ` +
              `${String(run.raw_items_considered).padEnd(12)} ` +
              `${String(run.items_kept).padEnd(8)} ` +
              `${String(run.items_dropped_recency).padEnd(10)} ` +
              `${run.items_dropped_duplicate}${status}`
            );
          }
        }
        break;
      }

      default:
        console.log(`Usage: npm run inspect -- <command> [options]

Commands:
  count                    Count raw_items rows
  list                     List recent raw_items
  collector                List recent collector runs
  collector --id <n>       Show full detail for one collector run
  preprocessor             List recent preprocessor runs
  preprocessor --id <n>    Show full stats for one preprocessor run

Options:
  --source <name>          Filter by source name (exact match)
  --limit <n>              Max rows returned (default varies by command)
  --id <n>                 Run id for detail view
`);
        process.exit(1);
    }
  } finally {
    await pool.end();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
