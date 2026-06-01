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
 *   npm run inspect -- triage
 *   npm run inspect -- triage --id 1
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

interface TriageRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  preprocessor_run_id: number;
  model_used: string;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  digest: string | null;
  generation_log_id: string | null;
}

interface PrepItemRow {
  id: string;
  source_name: string;
  title: string;
}

interface FilterRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  preprocessor_run_id: number;
  model_used: string;
  items_in: number;
  items_kept: number;
  items_dropped: number;
}

interface FilterDropRow {
  id: string;
  source_name: string;
  title: string;
  reason: string;
}

function parseClusterCount(digest: string): string {
  // Try new JSON schema first.
  try {
    const stripped = digest.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    const parsed = JSON.parse(stripped) as { clusters?: unknown[] };
    if (Array.isArray(parsed.clusters)) return String(parsed.clusters.length);
  } catch {
    // fall through to legacy text format
  }
  const match = digest.match(/^Clusters identified:\s*(\d+)/m);
  return match?.[1] ?? "?";
}

interface ClusterObject {
  title: string;
  item_ids: number[];
  summary: string;
  notes: string | null;
}

interface TriageJsonOutput {
  clusters: ClusterObject[];
}

function parseTriageJson(digest: string): TriageJsonOutput | null {
  try {
    const stripped = digest.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    const parsed = JSON.parse(stripped) as unknown;
    if (
      typeof parsed !== "object" || parsed === null ||
      !Array.isArray((parsed as { clusters?: unknown }).clusters)
    ) return null;
    const obj = parsed as { clusters: unknown[] };
    for (const c of obj.clusters) {
      if (
        typeof c !== "object" || c === null ||
        typeof (c as ClusterObject).title !== "string" ||
        !Array.isArray((c as ClusterObject).item_ids) ||
        typeof (c as ClusterObject).summary !== "string"
      ) return null;
    }
    return obj as TriageJsonOutput;
  } catch {
    return null;
  }
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

      case "triage": {
        if (flags["id"]) {
          const runId = parseInt(flags["id"], 10);
          const { rows } = await pool.query<TriageRunRow>(
            "SELECT * FROM triage_runs WHERE id = $1",
            [runId]
          );
          const run = rows[0];
          if (!run) {
            console.log(`No triage run with id ${runId}`);
            break;
          }
          if (!run.digest) {
            console.log(`Triage run #${run.id} has no digest (failed or incomplete).`);
            break;
          }

          const parsed = parseTriageJson(run.digest);
          if (!parsed) {
            // Fall back to raw output for old/unparseable digests.
            process.stdout.write(run.digest);
            if (!run.digest.endsWith("\n")) process.stdout.write("\n");
            break;
          }

          // Load all preprocessed items for the run so we can resolve ids.
          const { rows: prepItems } = await pool.query<PrepItemRow>(
            `SELECT id, source_name, title FROM preprocessed_items
             WHERE preprocessor_run_id = $1`,
            [run.preprocessor_run_id]
          );
          const itemMap = new Map<number, PrepItemRow>();
          for (const pi of prepItems) {
            itemMap.set(Number(pi.id), pi);
          }

          const runStarted = new Date(run.started_at).toISOString().slice(0, 19);
          console.log(`Triage run #${run.id}  |  preprocessor run #${run.preprocessor_run_id}  |  ${runStarted}`);
          console.log(`Model: ${run.model_used}`);
          const inTok = run.input_tokens !== null ? run.input_tokens.toLocaleString() : "?";
          const outTok = run.output_tokens !== null ? run.output_tokens.toLocaleString() : "?";
          console.log(`Tokens: ${inTok} in / ${outTok} out`);
          console.log(`Clusters: ${parsed.clusters.length}  |  Items in run: ${prepItems.length}`);
          console.log("");

          // Integrity pre-checks.
          const allClusteredIds = new Set<number>();
          const seenIds = new Map<number, number>(); // id → cluster index (first seen)
          const fabricatedIds: number[] = [];
          const duplicateIds: number[] = [];
          const singletonClusters: number[] = [];

          for (let ci = 0; ci < parsed.clusters.length; ci++) {
            const cluster = parsed.clusters[ci]!;
            if (cluster.item_ids.length < 2) singletonClusters.push(ci);
            for (const id of cluster.item_ids) {
              if (!itemMap.has(id)) {
                fabricatedIds.push(id);
              } else if (seenIds.has(id)) {
                duplicateIds.push(id);
              } else {
                seenIds.set(id, ci);
                allClusteredIds.add(id);
              }
            }
          }

          // Print clusters.
          for (let ci = 0; ci < parsed.clusters.length; ci++) {
            const cluster = parsed.clusters[ci]!;
            const validIds = cluster.item_ids.filter((id) => itemMap.has(id));
            const sources = [...new Set(validIds.map((id) => itemMap.get(id)!.source_name))];
            sources.sort();
            console.log(`── [${ci + 1}/${parsed.clusters.length}] ${cluster.title}`);
            console.log(`   Items: ${cluster.item_ids.length}  |  Sources (${sources.length}): ${sources.join(", ")}`);
            console.log(`   ${cluster.summary}`);
            if (cluster.notes) {
              console.log(`   Notes: ${cluster.notes}`);
            }
            console.log("");
          }

          // Residual.
          const residualItems = (prepItems as PrepItemRow[]).filter((pi) => !allClusteredIds.has(Number(pi.id)));
          console.log(`── RESIDUAL: ${residualItems.length} unclustered item${residualItems.length !== 1 ? "s" : ""}`);
          const sample = residualItems.slice(0, 30);
          for (const pi of sample) {
            console.log(`   [${pi.id}] ${pi.source_name} — ${pi.title}`);
          }
          if (residualItems.length > 30) {
            console.log(`   … and ${residualItems.length - 30} more`);
          }
          console.log("");

          // Integrity flags.
          const flags2: string[] = [];
          if (fabricatedIds.length > 0) flags2.push(`FABRICATED IDs (not in run): ${fabricatedIds.join(", ")}`);
          if (duplicateIds.length > 0) flags2.push(`DUPLICATE IDs (in >1 cluster): ${duplicateIds.join(", ")}`);
          if (singletonClusters.length > 0) flags2.push(`SINGLETON CLUSTERS (< 2 items): indices ${singletonClusters.map((i) => i + 1).join(", ")}`);
          if (flags2.length > 0) {
            console.log("── INTEGRITY FLAGS");
            for (const f of flags2) console.log(`   ⚠  ${f}`);
          } else {
            console.log("── INTEGRITY: OK");
          }
        } else {
          const limit = parseInt(flags["limit"] ?? "20", 10);
          const { rows } = await pool.query<TriageRunRow>(
            `SELECT id, started_at, completed_at, preprocessor_run_id,
                    model_used, input_tokens, output_tokens, duration_ms, digest
             FROM triage_runs
             ORDER BY started_at DESC
             LIMIT $1`,
            [limit]
          );

          if (rows.length === 0) {
            console.log("No triage runs recorded.");
            break;
          }

          console.log(
            `${"ID".padEnd(6)} ${"Started".padEnd(19)} ${"Prep#".padEnd(7)} ${"Model".padEnd(26)} ${"InTok".padEnd(8)} ${"OutTok".padEnd(8)} ${"Ms".padEnd(8)} Clusters`
          );
          console.log("─".repeat(100));

          for (const run of rows) {
            const started = new Date(run.started_at).toISOString().slice(0, 19);
            const prepId = String(run.preprocessor_run_id);
            const model = run.model_used.length > 24 ? run.model_used.slice(0, 23) + "…" : run.model_used;
            const inTok = run.input_tokens !== null ? String(run.input_tokens) : "—";
            const outTok = run.output_tokens !== null ? String(run.output_tokens) : "—";
            const ms = run.duration_ms !== null ? String(run.duration_ms) : "—";
            const clusterCount = run.digest ? parseClusterCount(run.digest) : "—";
            const status = run.completed_at ? "" : " (running…)";
            console.log(
              `${String(run.id).padEnd(6)} ${started} ${prepId.padEnd(7)} ${model.padEnd(26)} ${inTok.padEnd(8)} ${outTok.padEnd(8)} ${ms.padEnd(8)} ${clusterCount}${status}`
            );
          }
        }
        break;
      }

      case "filter": {
        if (flags["id"]) {
          const runId = parseInt(flags["id"], 10);
          const { rows: runRows } = await pool.query<FilterRunRow>(
            "SELECT * FROM filter_runs WHERE id = $1",
            [runId]
          );
          const run = runRows[0];
          if (!run) {
            console.log(`No filter run with id ${runId}`);
            break;
          }

          const started = new Date(run.started_at).toISOString().slice(0, 19);
          const finished = run.completed_at
            ? new Date(run.completed_at).toISOString().slice(0, 19)
            : "in progress / crashed";
          console.log(`Filter run #${run.id}`);
          console.log(`  Started:             ${started}`);
          console.log(`  Completed:           ${finished}`);
          console.log(`  Preprocessor run:    #${run.preprocessor_run_id}`);
          console.log(`  Model:               ${run.model_used}`);
          console.log(`  Items in:            ${run.items_in}`);
          console.log(`  Items kept:          ${run.items_kept}`);
          console.log(`  Items dropped:       ${run.items_dropped}`);
          if (run.items_in > 0) {
            const pct = ((run.items_dropped / run.items_in) * 100).toFixed(1);
            console.log(`  Drop rate:           ${pct}%`);
          }

          if (run.items_dropped > 0) {
            // Drops by reason.
            const { rows: reasonRows } = await pool.query<{ reason: string; n: string }>(
              `SELECT reason, COUNT(*) AS n FROM filter_results
               WHERE filter_run_id = $1 AND keep = false
               GROUP BY reason ORDER BY COUNT(*) DESC`,
              [runId]
            );
            console.log("\nDrops by reason:");
            for (const r of reasonRows) {
              console.log(`  ${r.reason}: ${r.n}`);
            }

            // Full dropped-items list.
            const { rows: dropRows } = await pool.query<FilterDropRow>(
              `SELECT fr.preprocessed_item_id AS id, pi.source_name, pi.title, fr.reason
               FROM filter_results fr
               JOIN preprocessed_items pi ON pi.id = fr.preprocessed_item_id
               WHERE fr.filter_run_id = $1 AND fr.keep = false
               ORDER BY fr.reason, pi.source_name, pi.title`,
              [runId]
            );
            console.log("\nDropped items:");
            for (const row of dropRows) {
              console.log(`  [${row.id}] ${row.source_name} | ${row.reason} | ${row.title}`);
            }
          }
        } else {
          const limit = parseInt(flags["limit"] ?? "20", 10);
          const { rows } = await pool.query<FilterRunRow>(
            `SELECT id, started_at, completed_at, preprocessor_run_id,
                    model_used, items_in, items_kept, items_dropped
             FROM filter_runs
             ORDER BY started_at DESC
             LIMIT $1`,
            [limit]
          );

          if (rows.length === 0) {
            console.log("No filter runs recorded.");
            break;
          }

          console.log(
            `${"ID".padEnd(6)} ${"Started".padEnd(19)} ${"Prep#".padEnd(7)} ${"Model".padEnd(26)} ${"In".padEnd(6)} ${"Kept".padEnd(6)} Dropped`
          );
          console.log("─".repeat(82));

          for (const run of rows) {
            const started = new Date(run.started_at).toISOString().slice(0, 19);
            const model = run.model_used.length > 24 ? run.model_used.slice(0, 23) + "…" : run.model_used;
            const status = run.completed_at ? "" : " (running…)";
            console.log(
              `${String(run.id).padEnd(6)} ${started} ${String(run.preprocessor_run_id).padEnd(7)} ${model.padEnd(26)} ${String(run.items_in).padEnd(6)} ${String(run.items_kept).padEnd(6)} ${run.items_dropped}${status}`
            );
          }
        }
        break;
      }

      case "categorizer": {
        if (flags["id"]) {
          const runId = parseInt(flags["id"], 10);
          const { rows: runRows } = await pool.query<{
            id: number;
            started_at: string;
            completed_at: string | null;
            preprocessor_run_id: number;
            model_used: string;
            items_in: number;
            items_categorized: number;
            fallback_count: number;
          }>(
            "SELECT * FROM categorizer_runs WHERE id = $1",
            [runId]
          );
          const run = runRows[0];
          if (!run) {
            console.log(`No categorizer run with id ${runId}`);
            break;
          }

          const started = new Date(run.started_at).toISOString().slice(0, 19);
          const finished = run.completed_at
            ? new Date(run.completed_at).toISOString().slice(0, 19)
            : "in progress / crashed";
          console.log(`Categorizer run #${run.id}`);
          console.log(`  Started:            ${started}`);
          console.log(`  Completed:          ${finished}`);
          console.log(`  Preprocessor run:   #${run.preprocessor_run_id}`);
          console.log(`  Model:              ${run.model_used}`);
          console.log(`  Items in:           ${run.items_in}`);
          console.log(`  Items categorized:  ${run.items_categorized}`);
          console.log(`  Fallback count:     ${run.fallback_count}`);

          const { rows: sectionRows } = await pool.query<{ section: string; n: string }>(
            `SELECT section, COUNT(*) AS n
             FROM categorizer_results, jsonb_array_elements_text(sections) AS section
             WHERE categorizer_run_id = $1
             GROUP BY section
             ORDER BY COUNT(*) DESC`,
            [runId]
          );
          const { rows: multiRows } = await pool.query<{ n: string; pct: string }>(
            `SELECT COUNT(*) AS n,
                    ROUND(COUNT(*) * 100.0 / NULLIF($2, 0), 1) AS pct
             FROM categorizer_results
             WHERE categorizer_run_id = $1
               AND jsonb_array_length(sections) >= 2`,
            [runId, run.items_categorized]
          );
          const multiCount = multiRows[0]?.n ?? "0";
          const multiPct = multiRows[0]?.pct ?? "0.0";
          console.log(`  Items with 2+ tags: ${multiCount} (${multiPct}%)`);

          if (sectionRows.length > 0) {
            console.log("\nTag distribution (tag appearances, not unique items):");
            for (const row of sectionRows) {
              console.log(`  ${row.section.padEnd(14)}: ${row.n}`);
            }
          }
        } else {
          const limit = parseInt(flags["limit"] ?? "20", 10);
          const { rows } = await pool.query<{
            id: number;
            started_at: string;
            completed_at: string | null;
            preprocessor_run_id: number;
            model_used: string;
            items_in: number;
            items_categorized: number;
            fallback_count: number;
          }>(
            `SELECT id, started_at, completed_at, preprocessor_run_id,
                    model_used, items_in, items_categorized, fallback_count
             FROM categorizer_runs
             ORDER BY started_at DESC
             LIMIT $1`,
            [limit]
          );

          if (rows.length === 0) {
            console.log("No categorizer runs recorded.");
            break;
          }

          console.log(
            `${"ID".padEnd(6)} ${"Started".padEnd(19)} ${"Prep#".padEnd(7)} ${"Model".padEnd(26)} ${"In".padEnd(6)} ${"Categorized".padEnd(13)} Fallback`
          );
          console.log("─".repeat(90));

          for (const run of rows) {
            const started = new Date(run.started_at).toISOString().slice(0, 19);
            const model = run.model_used.length > 24 ? run.model_used.slice(0, 23) + "…" : run.model_used;
            const status = run.completed_at ? "" : " (running…)";
            console.log(
              `${String(run.id).padEnd(6)} ${started} ${String(run.preprocessor_run_id).padEnd(7)} ${model.padEnd(26)} ${String(run.items_in).padEnd(6)} ${String(run.items_categorized).padEnd(13)} ${run.fallback_count}${status}`
            );
          }
        }
        break;
      }

      case "categorized": {
        // A/B side-by-side comparison mode.
        if (flags["compare-whole"] && flags["id"]) {
          const catRunId = parseInt(flags["id"], 10);
          const wholeRunId = parseInt(flags["compare-whole"], 10);

          const { rows: catRows } = await pool.query<{
            id: number;
            started_at: string;
            categorizer_run_id: number;
            preprocessor_run_id: number;
            model_used: string;
            total_clusters: number | null;
            combined_output: Array<{ section: string; clusters: { item_ids: number[] }[] }> | null;
            residual_item_ids: number[] | null;
            straddle_report: Array<unknown> | null;
          }>(
            "SELECT * FROM categorized_triage_runs WHERE id = $1",
            [catRunId]
          );
          const catRun = catRows[0];
          if (!catRun) {
            console.log(`No categorized triage run with id ${catRunId}`);
            break;
          }

          const { rows: wholeRows } = await pool.query<TriageRunRow>(
            "SELECT * FROM triage_runs WHERE id = $1",
            [wholeRunId]
          );
          const wholeRun = wholeRows[0];
          if (!wholeRun) {
            console.log(`No whole-pile triage run with id ${wholeRunId}`);
            break;
          }

          // Count clustered items for the categorized run (items in at least one cluster, once).
          const catClusteredIds = new Set<number>();
          for (const sec of catRun.combined_output ?? []) {
            for (const cluster of sec.clusters) {
              for (const id of cluster.item_ids) catClusteredIds.add(id);
            }
          }

          // Count clustered items and clusters for the whole-pile run.
          const wholeParsed = wholeRun.digest ? parseTriageJson(wholeRun.digest) : null;
          const wholeClusteredIds = new Set<number>();
          if (wholeParsed) {
            for (const cluster of wholeParsed.clusters) {
              for (const id of cluster.item_ids) wholeClusteredIds.add(id);
            }
          }

          const catSectionCount = catRun.combined_output?.length ?? 0;
          const catClusters = catRun.total_clusters ?? 0;
          const wholeClusters = wholeParsed?.clusters.length ?? "?";
          const catResidual = catRun.residual_item_ids?.length ?? "?";
          const wholeResidual = "?"; // not stored for whole-pile runs
          const catStraddle = catRun.straddle_report?.length ?? 0;

          const col1 = `Categorized #${catRunId}`;
          const col2 = `Whole-pile #${wholeRunId}`;
          const W1 = Math.max(col1.length, 20);
          const W2 = Math.max(col2.length, 20);

          console.log(`A/B COMPARISON`);
          console.log("─".repeat(20 + W1 + W2 + 4));
          console.log(`${"".padEnd(20)} ${col1.padEnd(W1)} ${col2}`);
          console.log("─".repeat(20 + W1 + W2 + 4));
          console.log(`${"Preprocessor run".padEnd(20)} #${catRun.preprocessor_run_id}`.padEnd(20 + W1 + 1) + ` #${wholeRun.preprocessor_run_id}`);
          const catModel = catRun.model_used.length > W1 ? catRun.model_used.slice(0, W1 - 1) + "…" : catRun.model_used;
          const wholeModel = wholeRun.model_used.length > W2 ? wholeRun.model_used.slice(0, W2 - 1) + "…" : wholeRun.model_used;
          console.log(`${"Model".padEnd(20)} ${catModel.padEnd(W1)} ${wholeModel}`);
          console.log(`${"Total clusters".padEnd(20)} ${String(catClusters).padEnd(W1)} ${wholeClusters}`);
          console.log(`${"Clustered items".padEnd(20)} ${String(catClusteredIds.size).padEnd(W1)} ${wholeClusteredIds.size}`);
          console.log(`${"Residual items".padEnd(20)} ${String(catResidual).padEnd(W1)} ${wholeResidual} (not tracked)`);
          console.log(`${"Sections".padEnd(20)} ${String(catSectionCount).padEnd(W1)} N/A`);
          console.log(`${"Straddle items".padEnd(20)} ${String(catStraddle).padEnd(W1)} N/A`);
          break;
        }

        if (flags["id"]) {
          const runId = parseInt(flags["id"], 10);
          const { rows: runRows } = await pool.query<{
            id: number;
            started_at: string;
            completed_at: string | null;
            categorizer_run_id: number;
            preprocessor_run_id: number;
            model_used: string;
            total_clusters: number | null;
            combined_output: Array<{
              section: string;
              clusters: Array<{
                title: string;
                item_ids: number[];
                summary: string;
                notes: string | null;
              }>;
              inputTokens: number | null;
              outputTokens: number | null;
              durationMs: number | null;
            }> | null;
            straddle_report: Array<{
              itemId: number;
              appearances: Array<{ section: string; clusterTitle: string }>;
            }> | null;
            integrity_flags: {
              fabricatedIds: number[];
              duplicateIdsWithinSection: Array<{ id: number; section: string }>;
              singletonClusters: Array<{ section: string; clusterIndex: number }>;
            } | null;
            residual_item_ids: number[] | null;
          }>(
            "SELECT * FROM categorized_triage_runs WHERE id = $1",
            [runId]
          );
          const run = runRows[0];
          if (!run) {
            console.log(`No categorized triage run with id ${runId}`);
            break;
          }
          if (!run.completed_at) {
            console.log(`Categorized triage run #${run.id} has no completed timestamp (failed or incomplete).`);
            break;
          }

          // Load preprocessed items for resolving ids.
          const { rows: prepItems } = await pool.query<PrepItemRow>(
            `SELECT id, source_name, title FROM preprocessed_items
             WHERE preprocessor_run_id = $1`,
            [run.preprocessor_run_id]
          );
          const itemMap = new Map<number, PrepItemRow>();
          for (const pi of prepItems) {
            itemMap.set(Number(pi.id), pi);
          }

          const runStarted = new Date(run.started_at).toISOString().slice(0, 19);
          console.log(
            `Categorized triage run #${run.id}  |  categorizer run #${run.categorizer_run_id}` +
            `  |  preprocessor run #${run.preprocessor_run_id}  |  ${runStarted}`
          );
          console.log(`Model: ${run.model_used}`);

          const sectionCount = run.combined_output?.length ?? 0;
          const totalClusters = run.total_clusters ?? 0;
          const residualCount = run.residual_item_ids?.length ?? 0;
          const straddleCount = run.straddle_report?.length ?? 0;

          // Count total clustered items across all sections (unique ids).
          const clusteredIds = new Set<number>();
          for (const sec of run.combined_output ?? []) {
            for (const cluster of sec.clusters) {
              for (const id of cluster.item_ids) clusteredIds.add(id);
            }
          }

          console.log(
            `Sections: ${sectionCount}  |  Total clusters: ${totalClusters}` +
            `  |  Clustered items: ${clusteredIds.size}  |  Residual: ${residualCount}`
          );
          console.log("");

          // Print each section.
          for (const secResult of run.combined_output ?? []) {
            const inTok = secResult.inputTokens !== null ? secResult.inputTokens.toLocaleString() : "?";
            const outTok = secResult.outputTokens !== null ? secResult.outputTokens.toLocaleString() : "?";
            const ms = secResult.durationMs !== null ? `${secResult.durationMs}ms` : "?";
            console.log(
              `── SECTION: ${secResult.section} (${secResult.clusters.length} clusters` +
              ` | ${inTok} in / ${outTok} out tokens | ${ms})`
            );

            for (let ci = 0; ci < secResult.clusters.length; ci++) {
              const cluster = secResult.clusters[ci]!;
              const validIds = cluster.item_ids.filter((id) => itemMap.has(id));
              const sources = [...new Set(validIds.map((id) => itemMap.get(id)!.source_name))].sort();
              console.log(`   [${ci + 1}/${secResult.clusters.length}] ${cluster.title}`);
              console.log(`      Items: ${cluster.item_ids.length}  |  Sources (${sources.length}): ${sources.join(", ")}`);
              console.log(`      ${cluster.summary}`);
              if (cluster.notes) console.log(`      Notes: ${cluster.notes}`);
              console.log("");
            }
          }

          // Straddle report.
          console.log(`── STRADDLE REPORT: ${straddleCount} item${straddleCount !== 1 ? "s" : ""} in clusters from >1 section`);
          for (const entry of run.straddle_report ?? []) {
            const item = itemMap.get(entry.itemId);
            const titleStr = item ? item.title : `[unknown id ${entry.itemId}]`;
            console.log(`   [${entry.itemId}] ${titleStr}`);
            for (const a of entry.appearances) {
              console.log(`      ${a.section} / "${a.clusterTitle}"`);
            }
          }
          console.log("");

          // Integrity flags.
          const iflags = run.integrity_flags;
          const problems: string[] = [];
          if (iflags?.fabricatedIds && iflags.fabricatedIds.length > 0) {
            problems.push(`FABRICATED IDs (not in run): ${iflags.fabricatedIds.join(", ")}`);
          }
          if (iflags?.duplicateIdsWithinSection && iflags.duplicateIdsWithinSection.length > 0) {
            const dupeList = iflags.duplicateIdsWithinSection
              .map((d) => `${d.id}@${d.section}`)
              .join(", ");
            problems.push(`DUPLICATE IDs within section: ${dupeList}`);
          }
          if (iflags?.singletonClusters && iflags.singletonClusters.length > 0) {
            const singleList = iflags.singletonClusters
              .map((s) => `${s.section}#${s.clusterIndex}`)
              .join(", ");
            problems.push(`SINGLETON CLUSTERS (< 2 items): ${singleList}`);
          }
          if (problems.length > 0) {
            console.log("── INTEGRITY FLAGS");
            for (const p of problems) console.log(`   ⚠  ${p}`);
          } else {
            console.log("── INTEGRITY: OK");
          }
          console.log("");

          // Residual.
          const residualIds = run.residual_item_ids ?? [];
          console.log(`── RESIDUAL: ${residualIds.length} unclustered item${residualIds.length !== 1 ? "s" : ""}`);
          const sample = residualIds.slice(0, 30);
          for (const id of sample) {
            const item = itemMap.get(id);
            console.log(`   [${id}] ${item?.source_name ?? "?"} — ${item?.title ?? "?"}`);
          }
          if (residualIds.length > 30) {
            console.log(`   … and ${residualIds.length - 30} more`);
          }
        } else {
          const limit = parseInt(flags["limit"] ?? "20", 10);
          const { rows } = await pool.query<{
            id: number;
            started_at: string;
            completed_at: string | null;
            categorizer_run_id: number;
            preprocessor_run_id: number;
            model_used: string;
            total_clusters: number | null;
          }>(
            `SELECT id, started_at, completed_at, categorizer_run_id,
                    preprocessor_run_id, model_used, total_clusters
             FROM categorized_triage_runs
             ORDER BY started_at DESC
             LIMIT $1`,
            [limit]
          );

          if (rows.length === 0) {
            console.log("No categorized triage runs recorded.");
            break;
          }

          console.log(
            `${"ID".padEnd(6)} ${"Started".padEnd(19)} ${"Cat#".padEnd(6)} ${"Prep#".padEnd(7)} ${"Model".padEnd(26)} Clusters`
          );
          console.log("─".repeat(80));

          for (const run of rows) {
            const started = new Date(run.started_at).toISOString().slice(0, 19);
            const model = run.model_used.length > 24 ? run.model_used.slice(0, 23) + "…" : run.model_used;
            const clusters = run.total_clusters !== null ? String(run.total_clusters) : "—";
            const status = run.completed_at ? "" : " (running…)";
            console.log(
              `${String(run.id).padEnd(6)} ${started} ${String(run.categorizer_run_id).padEnd(6)} ${String(run.preprocessor_run_id).padEnd(7)} ${model.padEnd(26)} ${clusters}${status}`
            );
          }
        }
        break;
      }

      default:
        console.log(`Usage: npm run inspect -- <command> [options]

Commands:
  count                          Count raw_items rows
  list                           List recent raw_items
  collector                      List recent collector runs
  collector --id <n>             Show full detail for one collector run
  preprocessor                   List recent preprocessor runs
  preprocessor --id <n>          Show full stats for one preprocessor run
  triage                         List recent triage runs
  triage --id <n>                Print full digest for one triage run
  filter                         List recent filter runs
  filter --id <n>                Show detail, drop reasons, and dropped titles for one filter run
  categorizer                    List recent categorizer runs
  categorizer --id <n>           Show tag distribution for one categorizer run
  categorized                    List recent categorized triage runs
  categorized --id <n>           Show full report for one categorized triage run
  categorized --id <n> --compare-whole <m>
                                 A/B comparison: categorized run #n vs. whole-pile triage run #m

Options:
  --source <name>                Filter by source name (exact match)
  --limit <n>                    Max rows returned (default varies by command)
  --id <n>                       Run id for detail view
  --compare-whole <n>            Whole-pile triage run id for A/B comparison
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
