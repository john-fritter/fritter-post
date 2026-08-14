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
 *   npm run inspect -- prefilter
 *   npm run inspect -- prefilter --id 1
 *   npm run inspect -- editor --id 112
 *   npm run inspect -- materials --editor-run 112
 */

import "dotenv/config";
import { Pool } from "pg";
import { loadEditorRunMaterials } from "../src/pipeline/writers/materials.js";
import {
  summarizeMaterials,
  formatMaterialsReport,
} from "../src/pipeline/writers/materials-report.js";
import { buildEditorRunPackets } from "../src/pipeline/writers/packets.js";

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
  items_dropped_parent_dedup: number;
  items_dropped_cross_run: number;
  notes: string | null;
}

interface PrefilterRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  preprocessor_run_id: number;
  model_used: string;
  items_in: number;
  items_kept: number;
  items_cut: number;
}

interface PrefilterResultRow {
  id: string;
  source_name: string;
  title: string;
  keep: boolean;
  kind: "news" | "opinion";
  reason: string;
}

interface EditorRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  pile_id: number;
  grouping_run_id: number | null;
  model_used: string;
  items_in: number;
  items_feature: number;
  items_standard: number;
  items_brief: number;
  items_cut: number;
}

interface EditorStoryRow {
  id: string;
  item_type: "cluster" | "singleton" | "thread";
  cluster_index: number | null;
  preprocessed_item_id: string | null;
  thread_id: string | null;
  thread_index: number | null;
  thread_title: string | null;
  thread_source_count: number | null;
  tier: string;
  rank: number;
  reason: string;
  resolved_title: string | null;
}

interface ClusterObject {
  title: string;
  item_ids: number[];
  summary: string;
  notes: string | null;
}

interface ClusterDigest {
  clusters: ClusterObject[];
}

function parseClusterDigest(digest: string): ClusterDigest | null {
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
      return obj as ClusterDigest;
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
          console.log(`  Dropped (parent-dedup):  ${run.items_dropped_parent_dedup}`);
          console.log(`  Dropped (cross-run):     ${run.items_dropped_cross_run}`);
          if (run.notes) console.log(`  Notes: ${run.notes}`);
        } else {
          // Summary list of recent runs.
          const limit = parseInt(flags["limit"] ?? "20", 10);
          const { rows } = await pool.query<PreprocessorRunRow>(
            `SELECT id, started_at, completed_at, collector_run_id,
                    raw_items_considered, items_kept,
                    items_dropped_recency, items_dropped_duplicate,
                    items_dropped_parent_dedup, items_dropped_cross_run, notes
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

      case "prefilter": {
        if (flags["id"]) {
          const runId = parseInt(flags["id"], 10);
          const { rows: runRows } = await pool.query<PrefilterRunRow>(
            "SELECT * FROM prefilter_runs WHERE id = $1",
            [runId]
          );
          const run = runRows[0];
          if (!run) {
            console.log(`No prefilter run with id ${runId}`);
            break;
          }

          const started = new Date(run.started_at).toISOString().slice(0, 19);
          const finished = run.completed_at
            ? new Date(run.completed_at).toISOString().slice(0, 19)
            : "in progress / crashed";
          console.log(`Prefilter run #${run.id}`);
          console.log(`  Started:             ${started}`);
          console.log(`  Completed:           ${finished}`);
          console.log(`  Preprocessor run:    #${run.preprocessor_run_id}`);
          console.log(`  Model:               ${run.model_used}`);
          console.log(`  Items in:            ${run.items_in}`);
          console.log(`  Items kept:          ${run.items_kept}`);
          console.log(`  Items cut:           ${run.items_cut}`);
          if (run.items_in > 0) {
            const pct = ((run.items_cut / run.items_in) * 100).toFixed(1);
            console.log(`  Cut rate:            ${pct}%`);
          }

          // Full per-item cut/news/opinion list with reasons.
          const { rows: itemRows } = await pool.query<PrefilterResultRow>(
            `SELECT pr.preprocessed_item_id AS id, pi.source_name, pi.title, pr.keep, pr.kind, pr.reason
             FROM prefilter_results pr
             JOIN preprocessed_items pi ON pi.id = pr.preprocessed_item_id
             WHERE pr.run_id = $1
             ORDER BY pr.keep ASC, pr.kind, pi.source_name, pi.title`,
            [runId]
          );

          const cutRows = itemRows.filter((r) => !r.keep);
          const newsRows = itemRows.filter((r) => r.keep && r.kind === "news");
          const opinionRows = itemRows.filter((r) => r.keep && r.kind === "opinion");

          console.log(`  Kept — news:         ${newsRows.length}`);
          console.log(`  Kept — opinion:      ${opinionRows.length} (routed to Longer Reads)`);

          if (cutRows.length > 0) {
            console.log(`\n── CUT (${cutRows.length})`);
            for (const row of cutRows) {
              console.log(`  [${row.id}] ${row.source_name} | ${row.reason} | ${row.title}`);
            }
          }
          if (newsRows.length > 0) {
            console.log(`\n── KEPT — NEWS (${newsRows.length})`);
            for (const row of newsRows) {
              console.log(`  [${row.id}] ${row.source_name} | ${row.reason} | ${row.title}`);
            }
          }
          if (opinionRows.length > 0) {
            console.log(`\n── KEPT — OPINION → Longer Reads (${opinionRows.length})`);
            for (const row of opinionRows) {
              console.log(`  [${row.id}] ${row.source_name} | ${row.reason} | ${row.title}`);
            }
          }
        } else {
          const limit = parseInt(flags["limit"] ?? "20", 10);
          const { rows } = await pool.query<PrefilterRunRow>(
            `SELECT id, started_at, completed_at, preprocessor_run_id,
                    model_used, items_in, items_kept, items_cut
             FROM prefilter_runs
             ORDER BY started_at DESC
             LIMIT $1`,
            [limit]
          );

          if (rows.length === 0) {
            console.log("No prefilter runs recorded.");
            break;
          }

          console.log(
            `${"ID".padEnd(6)} ${"Started".padEnd(19)} ${"Prep#".padEnd(7)} ${"Model".padEnd(26)} ${"In".padEnd(6)} ${"Kept".padEnd(6)} Cut`
          );
          console.log("─".repeat(82));

          for (const run of rows) {
            const started = new Date(run.started_at).toISOString().slice(0, 19);
            const model = run.model_used.length > 24 ? run.model_used.slice(0, 23) + "…" : run.model_used;
            const status = run.completed_at ? "" : " (running…)";
            console.log(
              `${String(run.id).padEnd(6)} ${started} ${String(run.preprocessor_run_id).padEnd(7)} ${model.padEnd(26)} ${String(run.items_in).padEnd(6)} ${String(run.items_kept).padEnd(6)} ${run.items_cut}${status}`
            );
          }
        }
        break;
      }

      case "editor": {
        if (flags["id"]) {
          const runId = parseInt(flags["id"], 10);
          const { rows: runRows } = await pool.query<EditorRunRow>(
            "SELECT * FROM editor_runs WHERE id = $1",
            [runId]
          );
          const run = runRows[0];
          if (!run) {
            console.log(`No editor run with id ${runId}`);
            break;
          }

          const started = new Date(run.started_at).toISOString().slice(0, 19);
          const finished = run.completed_at
            ? new Date(run.completed_at).toISOString().slice(0, 19)
            : "in progress / crashed";
          console.log(`Editor run #${run.id}`);
          console.log(`  Started:    ${started}`);
          console.log(`  Completed:  ${finished}`);
          console.log(`  Pile:       #${run.pile_id}`);
          if (run.grouping_run_id !== null) {
            console.log(`  Grouping run: #${run.grouping_run_id}`);
          }
          console.log(`  Model:      ${run.model_used}`);
          console.log(`  Items in:   ${run.items_in}`);

          console.log("\n── TIER COUNTS");
          console.log(`  feature   ${run.items_feature}`);
          console.log(`  standard  ${run.items_standard}`);
          console.log(`  brief     ${run.items_brief}`);
          console.log(`  cut       ${run.items_cut}`);

          // Resolve cluster titles from the grouping digest so the ranked list
          // can show readable titles.
          const clusterTitles = new Map<number, string>();
          if (run.grouping_run_id !== null) {
            const { rows: groupingRows } = await pool.query<{ digest: string | null }>(
              "SELECT digest FROM grouping_runs WHERE id = $1",
              [run.grouping_run_id]
            );
            const parsedDigest = groupingRows[0]?.digest
              ? parseClusterDigest(groupingRows[0].digest)
              : null;
            if (parsedDigest) {
              parsedDigest.clusters.forEach((c, idx) => clusterTitles.set(idx, c.title));
            }
          }

          const { rows: storyRows } = await pool.query<EditorStoryRow>(
            `SELECT es.id, es.item_type, es.cluster_index,
                    es.preprocessed_item_id::text AS preprocessed_item_id,
                    es.thread_id::text AS thread_id,
                    t.thread_index, t.title AS thread_title,
                    t.source_count AS thread_source_count,
                    es.tier, es.rank, es.reason,
                    -- The review artifact reads in English. 33+ of run #47's
                    -- 150 rows were non-Latin-script headlines, which makes the
                    -- ranked list hard to scan for the one person who has to
                    -- judge it. Falls back to the original for rows predating
                    -- migration 028.
                    COALESCE(NULLIF(pi.english_title, ''), pi.title) AS resolved_title
             FROM editor_stories es
             LEFT JOIN preprocessed_items pi ON pi.id = es.preprocessed_item_id
             LEFT JOIN threads t ON t.id = es.thread_id
             WHERE es.run_id = $1
             ORDER BY es.rank ASC`,
            [runId]
          );

          if (storyRows.length === 0) {
            console.log("\nNo stories recorded for this run.");
          } else {
            console.log(`\n── RANKED LIST (${storyRows.length})`);
            const flagged: EditorStoryRow[] = [];
            for (const row of storyRows) {
              // Promoted-singleton merged entries have item_type='cluster' but
              // cluster_index=null; fall back to the singleton ref/title path.
              const ref =
                row.item_type === "thread"
                  ? `T${row.thread_index ?? "?"}`
                  : row.item_type === "cluster"
                    ? (row.cluster_index !== null
                        ? `C${row.cluster_index}`
                        : `S${row.preprocessed_item_id ?? "?"}`)
                    : `S${row.preprocessed_item_id}`;
              const title =
                row.item_type === "thread"
                  ? row.thread_title ?? "(thread title unresolved)"
                  : row.item_type === "cluster" && row.cluster_index !== null
                    ? clusterTitles.get(row.cluster_index) ?? "(cluster title unresolved)"
                    : row.resolved_title ?? "(item title unresolved)";
              const tier = row.tier.padEnd(8);
              console.log(`  ${String(row.rank).padStart(3)}. [${tier}] ${ref.padEnd(7)} ${title}`);
              console.log(`       ${row.reason}`);
              // A thread stands in for several rows; show what it absorbed so
              // the ranked list stays traceable without a separate query.
              if (row.item_type === "thread" && row.thread_id !== null) {
                const { rows: memberRows } = await pool.query<{
                  item_type: string;
                  cluster_index: number | null;
                  preprocessed_item_id: string | null;
                  score: number;
                  member_title: string | null;
                }>(
                  `SELECT m.item_type, m.cluster_index,
                          m.preprocessed_item_id::text AS preprocessed_item_id,
                          m.score, pi.title AS member_title
                   FROM thread_members m
                   LEFT JOIN preprocessed_items pi ON pi.id = m.preprocessed_item_id
                   WHERE m.thread_id = $1
                   ORDER BY m.score DESC`,
                  [row.thread_id],
                );
                for (const m of memberRows) {
                  const mRef =
                    m.item_type === "cluster"
                      ? `C${m.cluster_index}`
                      : `S${m.preprocessed_item_id}`;
                  const mTitle =
                    m.item_type === "cluster"
                      ? clusterTitles.get(m.cluster_index ?? -1) ?? "(unresolved)"
                      : m.member_title ?? "(unresolved)";
                  console.log(`         ├─ ${mRef.padEnd(7)} [${m.score}] ${mTitle}`);
                }
              }
              if (row.reason.startsWith("fail-safe:")) flagged.push(row);
            }

            if (flagged.length > 0) {
              console.log(`\n── FAIL-SAFE FLAGS (${flagged.length})`);
              for (const row of flagged) {
                const ref =
                  row.item_type === "cluster"
                    ? (row.cluster_index !== null
                        ? `C${row.cluster_index}`
                        : `S${row.preprocessed_item_id ?? "?"}`)
                    : `S${row.preprocessed_item_id}`;
                console.log(`  rank ${row.rank}: ${ref} — ${row.reason}`);
              }
            }
          }
        } else {
          const limit = parseInt(flags["limit"] ?? "20", 10);
          const { rows } = await pool.query<EditorRunRow>(
            `SELECT id, started_at, completed_at, pile_id, grouping_run_id,
                    model_used, items_in, items_feature, items_standard, items_brief, items_cut
             FROM editor_runs
             ORDER BY started_at DESC
             LIMIT $1`,
            [limit]
          );

          if (rows.length === 0) {
            console.log("No editor runs recorded.");
            break;
          }

          console.log(
            `${"ID".padEnd(6)} ${"Started".padEnd(19)} ${"Pile#".padEnd(7)} ${"Model".padEnd(18)} ${"In".padEnd(5)} ${"Feat".padEnd(5)} ${"Std".padEnd(5)} ${"Brief".padEnd(6)} Cut`
          );
          console.log("─".repeat(80));

          for (const run of rows) {
            const started = new Date(run.started_at).toISOString().slice(0, 19);
            const model = run.model_used.length > 16 ? run.model_used.slice(0, 15) + "…" : run.model_used;
            const status = run.completed_at ? "" : " (running…)";
            console.log(
              `${String(run.id).padEnd(6)} ${started} ${String(run.pile_id).padEnd(7)} ${model.padEnd(18)} ${String(run.items_in).padEnd(5)} ${String(run.items_feature).padEnd(5)} ${String(run.items_standard).padEnd(5)} ${String(run.items_brief).padEnd(6)} ${run.items_cut}${status}`
            );
          }
        }
        break;
      }

      // Writer materials audit: resolves an editor run's stories to the
      // articles underneath them and reports how much body text each carries.
      // Uses the shared pool from src/db rather than this script's, since the
      // resolver is stage code — both are closed by the process exit below.
      case "materials": {
        const runId = flags["editor-run"] ? parseInt(flags["editor-run"], 10) : undefined;
        if (runId === undefined || Number.isNaN(runId)) {
          console.log("Usage: npm run inspect -- materials --editor-run <n> [--sources <n>]");
          break;
        }
        const stories = await loadEditorRunMaterials(runId);
        const report = summarizeMaterials(runId, stories);
        const sourceLimit = flags["sources"] ? parseInt(flags["sources"], 10) : undefined;
        console.log(formatMaterialsReport(report, sourceLimit));
        break;
      }

      // Writer packets: the assembled prompt for one story, or a size summary
      // for the whole run. This is the writers stage's feedback loop — the
      // prompt is the product, so it has to be readable before any model sees it.
      case "packet": {
        const runId = flags["editor-run"] ? parseInt(flags["editor-run"], 10) : undefined;
        if (runId === undefined || Number.isNaN(runId)) {
          console.log("Usage: npm run inspect -- packet --editor-run <n> [--rank <n>]");
          break;
        }
        const packets = await buildEditorRunPackets(runId);

        if (flags["rank"]) {
          const rank = parseInt(flags["rank"], 10);
          const found = packets.find((p) => p.packet.rank === rank);
          if (!found) {
            console.log(`No story at rank ${rank} in editor run #${runId}`);
            break;
          }
          console.log(`=== SYSTEM PROMPT (${found.systemPrompt.length} chars) ===\n`);
          console.log(found.systemPrompt);
          console.log(`\n=== USER PROMPT (${found.userPrompt.length} chars) ===\n`);
          console.log(found.userPrompt);
          // The prompt deliberately does not name omitted sources — the writer
          // must not refer to material it cannot read — but an audit has to see
          // which sources were dropped and why.
          if (found.packet.omitted.length > 0) {
            console.log(`\n=== OMITTED SOURCES (${found.packet.omitted.length}) ===\n`);
            for (const o of found.packet.omitted) {
              console.log(`  [${o.preprocessedItemId}] ${o.sourceName} — ${o.reason}`);
              console.log(`      ${o.title.slice(0, 110)}`);
            }
          }
          break;
        }

        console.log(`Writer packets — editor run #${runId} (${packets.length} stories)`);
        const totalChars = packets.reduce((sum, p) => sum + p.promptChars, 0);
        console.log(`  Total prompt characters: ${totalChars}`);
        console.log(`  Largest packet:          ${Math.max(...packets.map((p) => p.promptChars))}`);
        console.log("");
        console.log("  rank tier      ref     arts  omit  material       chars  fetched/feed");
        for (const { packet, promptChars } of packets) {
          const fetched = packet.articles.filter((a) => a.origin === "fetched").length;
          console.log(
            `  ${String(packet.rank).padStart(4)} ${packet.tier.padEnd(9)} ${packet.ref.padEnd(7)} ` +
              `${String(packet.articles.length).padStart(4)}  ${String(packet.omitted.length).padStart(4)}  ` +
              `${packet.materialLevel.padEnd(13)} ${String(promptChars).padStart(6)}  ` +
              `${fetched}/${packet.articles.length - fetched}`,
          );
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
  prefilter                List recent prefilter runs
  prefilter --id <n>       Show detail and per-item cut/news/opinion verdicts with reasons
  editor                   List recent editor runs
  editor --id <n>          Show ranked/tiered list with resolved titles and fail-safe flags
  materials --editor-run <n>
                           Writer materials audit: per-tier and per-source body
                           text available under each story, and the fetch scope
  packet --editor-run <n>  Writer packet sizes for every story of an editor run
  packet --editor-run <n> --rank <n>
                           Print the full assembled prompt for one story

Options:
  --source <name>          Filter by source name (exact match)
  --limit <n>              Max rows returned (default varies by command)
  --id <n>                 Run id for detail view
  --editor-run <n>         Editor run id (materials)
  --sources <n>            Rows in the per-source table (materials, default 40)
  --rank <n>               Story rank (packet)
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
