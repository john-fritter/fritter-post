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

interface EditorPass1RunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  triage_run_id: number;
  model_used: string;
  items_in: number;
}

interface EditorPass1ResultRow {
  id: string;
  source_name: string;
  title: string;
  score: number;
  reason: string;
}

interface ScoreDistRow {
  range_label: string;
  range_ord: number;
  n: string;
}

interface EditorPileRow {
  id: number;
  clusters_included: number;
  singletons_in_pile: number;
  singletons_below_line: number;
  score_cutoff: number | null;
  singleton_pile_target: number;
}

interface BelowLineRow {
  id: string;
  source_name: string;
  title: string;
  score: number;
  reason: string;
}

function parseClusterCount(digest: string): string {
  const stripped = digest.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  // JSON format (old digests start with '{').
  if (stripped.startsWith("{")) {
    try {
      const parsed = JSON.parse(stripped) as { clusters?: unknown[] };
      if (Array.isArray(parsed.clusters)) return String(parsed.clusters.length);
    } catch {
      // fall through
    }
    return "?";
  }

  // Flat line format: count lines with two distinct ;; occurrences.
  let count = 0;
  for (const rawLine of digest.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const first = line.indexOf(";;");
    if (first === -1) continue;
    if (line.lastIndexOf(";;") !== first) count++;
  }
  if (count > 0) return String(count);

  // Legacy text format.
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
  const stripped = digest.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  // JSON format (old digests start with '{').
  if (stripped.startsWith("{")) {
    try {
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

  // Flat line format: label;;summary;;id,id,...
  const clusters: ClusterObject[] = [];
  for (const rawLine of digest.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue;

    const title = line.slice(0, first).trim();
    const summary = line.slice(first + 2, last).trim();
    const idPart = line.slice(last + 2).trim();

    if (title.length === 0 || summary.length === 0) continue;

    const item_ids: number[] = [];
    for (const tok of idPart.split(",")) {
      const trimmed = tok.trim();
      if (/^\d+$/.test(trimmed)) item_ids.push(Number.parseInt(trimmed, 10));
    }

    clusters.push({ title, item_ids, summary, notes: null });
  }

  return clusters.length > 0 ? { clusters } : null;
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

      case "editor-pass-1": {
        if (flags["id"]) {
          const runId = parseInt(flags["id"], 10);
          const { rows: runRows } = await pool.query<EditorPass1RunRow>(
            "SELECT * FROM editor_pass_1_runs WHERE id = $1",
            [runId]
          );
          const run = runRows[0];
          if (!run) {
            console.log(`No editor-pass-1 run with id ${runId}`);
            break;
          }

          const started = new Date(run.started_at).toISOString().slice(0, 19);
          const finished = run.completed_at
            ? new Date(run.completed_at).toISOString().slice(0, 19)
            : "in progress / crashed";
          console.log(`Editor-pass-1 run #${run.id}`);
          console.log(`  Started:          ${started}`);
          console.log(`  Completed:        ${finished}`);
          console.log(`  Triage run:       #${run.triage_run_id}`);
          console.log(`  Model:            ${run.model_used}`);
          console.log(`  Items in:         ${run.items_in}`);
          if (run.items_in > 0) {
            console.log(`  Results scored:   ${run.items_in}`);
          }

          // Score distribution across all scored singletons.
          const { rows: distRows } = await pool.query<ScoreDistRow>(
            `SELECT
               CASE WHEN score >= 90 THEN '90–100'
                    WHEN score >= 70 THEN '70–89'
                    WHEN score >= 50 THEN '50–69'
                    WHEN score >= 30 THEN '30–49'
                    ELSE                  '0–29'
               END AS range_label,
               CASE WHEN score >= 90 THEN 4
                    WHEN score >= 70 THEN 3
                    WHEN score >= 50 THEN 2
                    WHEN score >= 30 THEN 1
                    ELSE                  0
               END AS range_ord,
               COUNT(*) AS n
             FROM editor_pass_1_results
             WHERE run_id = $1
             GROUP BY range_label, range_ord
             ORDER BY range_ord DESC`,
            [runId]
          );
          if (distRows.length > 0) {
            console.log("\n── SCORE DISTRIBUTION");
            const allRanges = [
              { label: "90–100", ord: 4 },
              { label: "70–89",  ord: 3 },
              { label: "50–69",  ord: 2 },
              { label: "30–49",  ord: 1 },
              { label: "0–29",   ord: 0 },
            ];
            for (const r of allRanges) {
              const found = distRows.find((d: ScoreDistRow) => d.range_ord === r.ord);
              const count = found ? found.n : "0";
              console.log(`  ${r.label.padEnd(8)} ${count}`);
            }
          }

          // Score-50 fail-safe audit.
          const { rows: failSafeRows } = await pool.query<{ reason: string; n: string }>(
            `SELECT reason, COUNT(*)::int AS n
             FROM editor_pass_1_results
             WHERE run_id = $1 AND score = 50
             GROUP BY reason
             ORDER BY n DESC, reason`,
            [runId]
          );
          if (failSafeRows.length > 0) {
            console.log("\n── FAIL-SAFE (score=50)");
            for (const row of failSafeRows) {
              console.log(`  ${row.reason.padEnd(28)} ${row.n}`);
            }
          }

          // Low-score protected-beat audit.
          const protectedBeatPatterns = [
            /philipp|manila|aira/i,
            /qorvo|semi|semiconductor|fab|chip/i,
            /labor|union|strike/i,
            /bend|central oregon|oregon/i,
            /immigr|ice\b/i,
            /housing|homeless/i,
          ];
          const { rows: lowRows } = await pool.query<EditorPass1ResultRow & { source_name: string }>(
            `SELECT r.preprocessed_item_id AS id, pi.source_name, pi.title, r.score, r.reason
             FROM editor_pass_1_results r
             JOIN preprocessed_items pi ON pi.id = r.preprocessed_item_id
             WHERE r.run_id = $1 AND r.score < 30
             ORDER BY r.score ASC, pi.source_name, pi.title`,
            [runId]
          );
          const protectedMatches = lowRows.filter((row) => {
            const haystack = `${row.source_name} ${row.title} ${row.reason}`;
            return protectedBeatPatterns.some((re) => re.test(haystack));
          });
          console.log(`\n── PROTECTED-BEAT LOW-SCORE AUDIT (${protectedMatches.length})`);
          if (protectedMatches.length === 0) {
            console.log("  none");
          } else {
            for (const row of protectedMatches) {
              console.log(`  [${row.id}] score=${row.score} | ${row.source_name} | ${row.reason} | ${row.title}`);
            }
          }
          // Pile info, if assembly has been run for this editor-pass-1 run.
          const { rows: pileRows } = await pool.query<EditorPileRow>(
            `SELECT id, clusters_included, singletons_in_pile, singletons_below_line,
                    score_cutoff, singleton_pile_target
             FROM editor_piles
             WHERE editor_pass_1_run_id = $1
             ORDER BY created_at DESC LIMIT 1`,
            [runId]
          );
          const pile = pileRows[0];
          if (pile) {
            const totalPile = pile.clusters_included + pile.singletons_in_pile;
            console.log(`\n── PILE #${pile.id}`);
            console.log(`  Singleton target:    ${pile.singleton_pile_target}`);
            console.log(`  Clusters in pile:    ${pile.clusters_included} (all pass through)`);
            console.log(`  Singletons in pile:  ${pile.singletons_in_pile}`);
            console.log(`  Singletons below:    ${pile.singletons_below_line}`);
            if (pile.score_cutoff !== null) {
              console.log(`  Score cutoff:        ${pile.score_cutoff}`);
            }
            console.log(`  Total pile size:     ${totalPile}`);

            if (pile.singletons_below_line > 0) {
              const { rows: belowRows } = await pool.query<BelowLineRow>(
                `SELECT epi.preprocessed_item_id AS id, pi.source_name, pi.title,
                        epi.score, epi.reason
                 FROM editor_pile_items epi
                 JOIN preprocessed_items pi ON pi.id = epi.preprocessed_item_id
                 WHERE epi.pile_id = $1 AND epi.in_pile = false
                 ORDER BY epi.score DESC, pi.title ASC`,
                [pile.id]
              );
              console.log(`\n── BELOW LINE (${pile.singletons_below_line})`);
              for (const row of belowRows) {
                console.log(`  [${row.id}] score=${row.score} | ${row.source_name} | ${row.reason} | ${row.title}`);
              }
            }
          }
        } else {
          const limit = parseInt(flags["limit"] ?? "20", 10);
          const { rows } = await pool.query<EditorPass1RunRow>(
            `SELECT id, started_at, completed_at, triage_run_id,
                    model_used, items_in
             FROM editor_pass_1_runs
             ORDER BY started_at DESC
             LIMIT $1`,
            [limit]
          );

          if (rows.length === 0) {
            console.log("No editor-pass-1 runs recorded.");
            break;
          }

          console.log(
            `${"ID".padEnd(6)} ${"Started".padEnd(19)} ${"Triage#".padEnd(9)} ${"Model".padEnd(22)} ${"In".padEnd(6)}`
          );
          console.log("─".repeat(65));

          for (const run of rows) {
            const started = new Date(run.started_at).toISOString().slice(0, 19);
            const model = run.model_used.length > 24
              ? run.model_used.slice(0, 23) + "…"
              : run.model_used;
            const status = run.completed_at ? "" : " (running…)";
            console.log(
              `${String(run.id).padEnd(6)} ${started} ${String(run.triage_run_id).padEnd(9)} ${model.padEnd(22)} ${String(run.items_in).padEnd(6)}${status}`
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
  triage                   List recent triage runs
  triage --id <n>          Print full digest for one triage run
  filter                   List recent filter runs
  filter --id <n>          Show detail, drop reasons, and dropped titles for one filter run
  editor-pass-1            List recent editor-pass-1 runs
  editor-pass-1 --id <n>   Show score distribution, pile info, and below-line list

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
