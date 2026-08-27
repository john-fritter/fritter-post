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
import { buildEditorRunPackets, loadFetchedTexts } from "../src/pipeline/writers/packets.js";

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
  tie_break_calls: number | null;
  tie_break_failed_calls: number | null;
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

          // NULL is a run before migration 040, where the console was the only
          // record. Zero is a run that lost nothing; they are not the same, so
          // they do not print the same.
          if (run.tie_break_calls === null) {
            console.log("\n── TIE-BREAK  (not recorded — run predates migration 040)");
          } else {
            console.log("\n── TIE-BREAK");
            console.log(`  calls     ${run.tie_break_calls}`);
            console.log(`  failed    ${run.tie_break_failed_calls}`);
            if ((run.tie_break_failed_calls ?? 0) > 0) {
              console.log(
                `  Every item in a failed group is ordered by ref instead, which is\n` +
                  `  alphabetical. At a tier boundary that decides feature vs standard.`,
              );
            }
          }

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
        // Fetched lengths, so the audit can report what a writer reads and not
        // only what the feeds gave. Empty before the fetch has run, which is
        // when the report says so rather than implying the two are the same.
        const itemIds = [
          ...new Set(stories.flatMap((s) => s.articles.map((a) => a.preprocessedItemId))),
        ];
        const fetched = await loadFetchedTexts(itemIds);
        const fetchedChars = new Map(
          [...fetched].map(([id, resolved]) => [id, resolved.text.length]),
        );
        const report = summarizeMaterials(runId, stories, undefined, fetchedChars);
        const sourceLimit = flags["sources"] ? parseInt(flags["sources"], 10) : undefined;
        console.log(formatMaterialsReport(report, sourceLimit));
        break;
      }

      // Writer packets: the assembled prompt for one story, or a size summary
      // for the whole run. This is the writers stage's feedback loop — the
      // prompt is the product, so it has to be readable before any model sees it.
      // **Can the writer actually get text out of this source?**
      //
      // The fetch is the one stage with no inspection view, and it is the stage
      // whose answer decides what belongs in sources.yaml. `article_texts` has
      // carried the evidence per item since migration 034 — whose own comment
      // says "text_chars - feed_chars is the only honest measure of whether this
      // stage earns its keep" — and nothing has ever read it back.
      //
      // Deliberately cross-run rather than scoped to one editor run. A single
      // day is noise: a source with four articles that all happened to be
      // fetchable proves nothing. The retention window is what there is to
      // judge on.
      // **How long does the paper actually take?**
      //
      // Every stage has written started_at and completed_at since migration 002
      // and nothing has ever read them back, so the only answer available has
      // been whoever ran it saying "about an hour" — which conflates the
      // pipeline with the deploy, the audit queries and the report around it.
      // A stage that doubled in cost would be invisible until someone noticed
      // the wait.
      //
      // Latest run of each stage by default, since that is the lineage anybody
      // asking has just produced.
      case "timing": {
        const stages: Array<{ label: string; table: string }> = [
          { label: "collector", table: "collector_runs" },
          { label: "preprocessor", table: "preprocessor_runs" },
          { label: "prefilter", table: "prefilter_runs" },
          { label: "grouping", table: "grouping_runs" },
          { label: "grouping-pass-1", table: "grouping_pass1_runs" },
          { label: "thread", table: "thread_runs" },
          { label: "editor", table: "editor_runs" },
          { label: "writers", table: "writer_runs" },
        ];

        const rows: Array<{
          label: string; id: number | null; started: Date | null;
          completed: Date | null; seconds: number | null;
        }> = [];
        for (const stage of stages) {
          const { rows: found } = await pool.query<{
            run_id: string; started_at: Date; completed_at: Date | null; seconds: string | null;
          }>(
            // **`id::text AS run_id`, not `id::text`.** A cast expression keeps
            // the underlying column's name, so `SELECT id::text` names its
            // output column `id` — and SQL resolves `ORDER BY id` to the output
            // column before the table column. That sorted the ids as strings:
            // "9" above "99" above "57" above "123". Every stage came back as
            // run #9 and the whole report was silently wrong about which runs it
            // was timing. Aliasing the cast leaves `id` bound to the integer.
            `SELECT id::text AS run_id, started_at, completed_at,
                    EXTRACT(EPOCH FROM (completed_at - started_at))::text AS seconds
             FROM ${stage.table} ORDER BY id DESC LIMIT 1`,
          );
          const r = found[0];
          rows.push({
            label: stage.label,
            id: r ? Number(r.run_id) : null,
            started: r ? r.started_at : null,
            completed: r?.completed_at ?? null,
            seconds: r?.seconds != null ? Number(r.seconds) : null,
          });
        }

        const clock = (sec: number) => {
          const m = Math.floor(sec / 60);
          const s = Math.round(sec % 60);
          return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
        };

        // **A replay mixes lineages, and the output has to say so.** Taking the
        // latest row of each table is right for a full pipeline run and wrong
        // for a replay from an existing preprocessor run: the collector and
        // preprocessor rows are then hours or days older than the stages that
        // actually ran, and their gap lands in the wall clock as if somebody had
        // waited. Run #45's report had to discard this output for exactly that.
        const newestStart = Math.max(
          ...rows.map((r) => r.started?.getTime() ?? 0),
          0,
        );
        // Anything that started more than this before the newest stage was not
        // part of the same sitting. Generous, so a slow full run is never split.
        const LINEAGE_WINDOW_MS = 6 * 3600_000;
        const inLineage = (r: (typeof rows)[number]) =>
          r.started !== null && newestStart - r.started.getTime() <= LINEAGE_WINDOW_MS;
        const stale = rows.filter((r) => r.id !== null && !inLineage(r));

        // **A downstream stage cannot start before the upstream one it reads.**
        // The six-hour window catches a replay from a *days*-old preprocessor
        // run and misses the case that actually reached a report: editor #123
        // and writers #45 ran at 21:51 and 21:52, and grouping-pass-1 #43 and
        // thread #21 ran at 00:43 and 00:51 the next morning. Every row was
        // inside six hours of every other, so nothing was marked, and the
        // command reported a 332m wall clock and a 308m "orchestration gap"
        // that no one ever waited — it was the distance between two separate
        // sittings, and #123's paper was not written from #43's scores at all.
        //
        // Time-of-day proximity was never the question. Order is, and the
        // stage list is already in pipeline order, so a stage that starts
        // before one above it demonstrably did not consume it.
        const outOfOrder: string[] = [];
        let highWater = -Infinity;
        let highWaterLabel = "";
        for (const r of rows) {
          if (r.started === null || !inLineage(r)) continue;
          const t = r.started.getTime();
          if (t < highWater) outOfOrder.push(`${r.label} < ${highWaterLabel}`);
          else {
            highWater = t;
            highWaterLabel = r.label;
          }
        }
        const oneLineage = outOfOrder.length === 0;

        console.log("Stage durations — latest run of each stage\n");
        console.log("  stage             run        started              duration");
        let stageTotal = 0;
        for (const r of rows) {
          if (r.id === null) {
            console.log(`  ${r.label.padEnd(17)} (none)`);
            continue;
          }
          const when = r.started ? r.started.toISOString().replace("T", " ").slice(0, 19) : "?";
          // A null completed_at means in progress, or crashed before finishing —
          // never zero. Saying so beats printing a 0 that reads like "instant".
          const dur =
            r.seconds === null ? "INCOMPLETE (no completed_at)" : clock(r.seconds);
          if (r.seconds !== null && inLineage(r)) stageTotal += r.seconds;
          const mark = inLineage(r) ? "" : "   [earlier lineage]";
          console.log(
            `  ${r.label.padEnd(17)} #${String(r.id).padEnd(9)} ${when}  ${dur}${mark}`,
          );
        }

        console.log(`\n  Sum of stage durations:  ${clock(stageTotal)}`);
        if (stale.length > 0) {
          console.log(
            `  ${stale.length} stage(s) marked [earlier lineage] did not run in this ` +
              `sitting — a replay reuses them. The wall clock below spans only the ` +
              `stages that did.`,
          );
        }

        // Wall clock across the lineage, which is the number a person actually
        // waited: it includes the gaps where a human or a script sat between
        // stages, and the sum above does not.
        const fresh = rows.filter(inLineage);
        const started = fresh.map((r) => r.started).filter((d): d is Date => d !== null);
        const ended = fresh.map((r) => r.completed).filter((d): d is Date => d !== null);
        if (!oneLineage) {
          console.log(
            `\n  NOT ONE LINEAGE — ${outOfOrder.join(", ")}. A stage cannot have ` +
              `consumed\n  one that started after it. These are the latest runs of ` +
              `each stage, but they\n  are not one run of the pipeline, so no wall ` +
              `clock is reported: the span\n  between them is the distance between two ` +
              `sittings, not a wait anybody sat\n  through. The per-stage durations ` +
              `above are still each stage's own.`,
          );
        } else if (started.length > 0 && ended.length > 0) {
          const first = Math.min(...started.map((d) => d.getTime()));
          const last = Math.max(...ended.map((d) => d.getTime()));
          const wall = (last - first) / 1000;
          console.log(`  Wall clock, first start to last finish: ${clock(wall)}`);
          const gap = wall - stageTotal;
          if (gap > 0) {
            console.log(
              `  Of which between stages: ${clock(gap)} — ` +
                `orchestration, not the pipeline`,
            );
          }
        }

        // fetch-text has no run table of its own; article_texts is where it
        // leaves a trace, and the spread of one editor run's fetched_at is the
        // closest thing to its duration.
        // fetch-text has no run table, so its only trace is when its rows were
        // written. Scoped to the same window as the lineage above: over 24 hours
        // this spans several runs and reads as one very slow stage — the first
        // version reported "127m 59s" for 31 rows written across a whole day.
        const { rows: fetchRows } = await pool.query<{ n: string; seconds: string | null }>(
          `SELECT count(*)::text AS n,
                  EXTRACT(EPOCH FROM (max(fetched_at) - min(fetched_at)))::text AS seconds
           FROM article_texts
           WHERE status <> 'skipped'
             AND fetched_at >= NOW() - ($1::int || ' hours')::interval`,
          [LINEAGE_WINDOW_MS / 3600_000],
        );
        const fr = fetchRows[0];
        if (fr && Number(fr.n) > 0 && fr.seconds !== null) {
          console.log(
            `\n  fetch-text has no run table. ${fr.n} row(s) written in the last ` +
              `${LINEAGE_WINDOW_MS / 3600_000}h, spanning ${clock(Number(fr.seconds))} — ` +
              `an approximation, and one that covers every fetch in the window.`,
          );
        }
        break;
      }

      case "fetch": {
        const days = flags["days"] ? parseInt(flags["days"], 10) : 14;
        const { rows } = await pool.query<{
          source_name: string;
          host: string;
          status: string;
          detail: string | null;
          text_chars: number;
          feed_chars: number;
        }>(
          `SELECT p.source_name, a.host, a.status, a.detail,
                  a.text_chars, a.feed_chars
           FROM article_texts a
           JOIN preprocessed_items p ON p.id = a.preprocessed_item_id
           WHERE a.fetched_at >= NOW() - ($1::int || ' days')::interval`,
          [days],
        );

        if (rows.length === 0) {
          console.log(`No article_texts rows in the last ${days} day(s).`);
          break;
        }

        const THIN = 800;
        const statusOrder = ["ok", "thin", "blocked", "error", "skipped"] as const;
        const totals = new Map<string, number>();
        for (const r of rows) totals.set(r.status, (totals.get(r.status) ?? 0) + 1);

        console.log(`Article fetch outcomes — article_texts, last ${days} day(s)`);
        console.log(
          `  Rows: ${rows.length} across ${new Set(rows.map((r) => r.host)).size} host(s), ` +
            `${new Set(rows.map((r) => r.source_name)).size} source(s)`,
        );
        console.log(
          "  Status: " +
            statusOrder.map((st) => `${totals.get(st) ?? 0} ${st}`).join(", "),
        );

        // Why we did not ask. A skip is a decision, and the three reasons mean
        // very different things about a source: "feed already long enough" is
        // the fetch working as designed, "cooldown" is a host refusing us.
        const skipReasons = new Map<string, number>();
        for (const r of rows) {
          if (r.status !== "skipped") continue;
          const d = r.detail ?? "(none)";
          const key = /already \d+ chars/.test(d)
            ? "feed body already long enough"
            : d.includes("cooldown")
              ? "host in cooldown after repeated failures"
              : d.includes("refetch")
                ? "already attempted within refetch window"
                : d;
          skipReasons.set(key, (skipReasons.get(key) ?? 0) + 1);
        }
        if (skipReasons.size > 0) {
          console.log("\n── WHY WE DID NOT ASK");
          for (const [reason, n] of [...skipReasons].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${String(n).padStart(5)}  ${reason}`);
          }
        }

        const median = (xs: number[]): number => {
          if (xs.length === 0) return 0;
          const sorted = [...xs].sort((a, b) => a - b);
          return sorted[Math.floor(sorted.length / 2)]!;
        };

        interface SourceStat {
          source: string;
          items: number;
          counts: Map<string, number>;
          feed: number[];
          best: number[];
          hosts: Set<string>;
        }
        const bySource = new Map<string, SourceStat>();
        for (const r of rows) {
          const stat = bySource.get(r.source_name) ?? {
            source: r.source_name,
            items: 0,
            counts: new Map<string, number>(),
            feed: [],
            best: [],
            hosts: new Set<string>(),
          };
          stat.items++;
          stat.counts.set(r.status, (stat.counts.get(r.status) ?? 0) + 1);
          stat.feed.push(r.feed_chars);
          // What the writer would actually read: the packet takes whichever of
          // the fetched text and the feed body is longer.
          stat.best.push(Math.max(r.text_chars, r.feed_chars));
          stat.hosts.add(r.host);
          bySource.set(r.source_name, stat);
        }

        // **The sources.yaml decision metric.** Not "did the fetch succeed" —
        // a source whose feed already carries full text never needs the fetch
        // and should not be marked down for skipping it. The question is
        // whether a writer ends up with something to work from, whatever route
        // it came by.
        const usable = (stat: SourceStat) =>
          stat.best.filter((n) => n >= THIN).length / stat.items;

        console.log(
          `\n── PER SOURCE — what a writer ends up with (usable = best text ≥ ${THIN} chars)`,
        );
        console.log(
          "  source                                   items usable   ok thin blkd  err skip   feed→best median",
        );
        const ranked = [...bySource.values()].sort(
          (a, b) => usable(a) - usable(b) || b.items - a.items,
        );
        for (const stat of ranked) {
          const c = (st: string) => String(stat.counts.get(st) ?? 0).padStart(4);
          console.log(
            `  ${stat.source.slice(0, 40).padEnd(40)} ${String(stat.items).padStart(5)} ` +
              `${(usable(stat) * 100).toFixed(0).padStart(5)}% ` +
              `${c("ok")} ${c("thin")} ${c("blocked")} ${c("error")} ${c("skipped")}   ` +
              `${String(median(stat.feed)).padStart(6)} → ${String(median(stat.best)).padStart(6)}`,
          );
        }

        // A source that can never clear the floor is a headline generator. That
        // is not automatically a reason to drop it — a brief is a pointer and a
        // headline is enough for one — but it is the shortlist to decide on,
        // and it is the list nothing has ever printed.
        const headlineOnly = ranked.filter((st) => usable(st) === 0);
        if (headlineOnly.length > 0) {
          console.log(
            `\n── NEVER USABLE: ${headlineOnly.length} source(s) produced no article over ${THIN} chars`,
          );
          for (const stat of headlineOnly) {
            const blocked = (stat.counts.get("blocked") ?? 0) + (stat.counts.get("error") ?? 0);
            const why =
              blocked > 0
                ? `${blocked} refused/errored`
                : (stat.counts.get("skipped") ?? 0) === stat.items
                  ? "never attempted (cooldown or feed judged long enough)"
                  : `${stat.counts.get("thin") ?? 0} fetched thin`;
            console.log(
              `  ${stat.source.slice(0, 40).padEnd(40)} ${String(stat.items).padStart(4)} items — ${why}`,
            );
            console.log(`      hosts: ${[...stat.hosts].join(", ")}`);
          }
        }
        break;
      }

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
          // Provenance for the same reason: the prompt used to label each source
          // `[feed summary only]` and `[truncated at N of M chars]`, and run #15
          // relayed both to the reader. A writer cannot act on either, but an
          // audit cannot work without them — so they live here now.
          console.log(`\n=== MATERIAL (${found.packet.articles.length} source(s)) ===\n`);
          console.log(`  level: ${found.packet.materialLevel}, ${found.packet.totalChars} chars in prompt`);
          for (const a of found.packet.articles) {
            const marks = [
              a.origin,
              a.truncated ? `truncated ${a.chars}/${a.availableChars}` : `${a.chars} chars`,
              a.duplicateParagraphs > 0 ? `${a.duplicateParagraphs} dup para` : null,
              a.boilerplateParagraphs > 0 ? `${a.boilerplateParagraphs} furniture` : null,
              a.truncatedTail ? "TRUNCATED TAIL CUT" : null,
              a.translationFailed ? "UNTRANSLATED" : null,
            ].filter((m) => m !== null);
            console.log(`  [${a.preprocessedItemId}] ${a.sourceName} — ${marks.join(", ")}`);
          }
          break;
        }

        console.log(`Writer packets — editor run #${runId} (${packets.length} stories)`);
        const totalChars = packets.reduce((sum, p) => sum + p.promptChars, 0);
        console.log(`  Total prompt characters: ${totalChars}`);
        console.log(`  Largest packet:          ${Math.max(...packets.map((p) => p.promptChars))}`);
        console.log("");
        const sectionPieces = packets.filter((p) => p.packet.section !== null).length;
        if (sectionPieces > 0) {
          const sections = new Set(packets.map((p) => p.packet.section?.ref).filter(Boolean));
          console.log(`  Sections:                ${sections.size} (${sectionPieces} pieces)`);
        }
        // The number run #42's audit had no way to state: how much of each tier
        // is running on a headline. 37 of its 150 pieces were headline-only,
        // three of them features, and nothing in the reports said so — the
        // materials audit counted thin *articles*, which is a different thing
        // from a thin *piece*. Tiers whose slots require material are resolved
        // before this point, so a non-zero count here is a day the paper ran out
        // of material to trade with, not a slot mis-assignment.
        console.log("");
        console.log("  Material by tier:");
        const tierOrder = ["feature", "standard", "brief"];
        const seen = [...new Set(packets.map((p) => p.packet.tier))].sort(
          (a, b) => (tierOrder.indexOf(a) + 1 || 99) - (tierOrder.indexOf(b) + 1 || 99),
        );
        for (const tier of seen) {
          const inTier = packets.filter((p) => p.packet.tier === tier);
          const at = (level: string) =>
            inTier.filter((p) => p.packet.materialLevel === level).length;
          console.log(
            `    ${tier.padEnd(9)} ${String(inTier.length).padStart(3)} pieces — ` +
              `${at("full")} full, ${at("partial")} partial, ${at("headline-only")} headline-only`,
          );
        }

        // **Why sources were left out, not just how many.** The per-story table
        // has carried an `omit` count since it was written, and the reasons only
        // ever printed under `--rank`. Run #46's audit could not say whether AP's
        // live page left the packet because the live-blog rule fired or because
        // its cache was empty — the count was 3 and the reasons were one drill-in
        // away, on a command the audit had not been asked to run.
        const omissionReasons = new Map<string, number>();
        for (const { packet } of packets) {
          for (const o of packet.omitted) {
            // Collapse the numbers out of "no usable body text (0 chars ...)"
            // so the shapes group instead of splintering per article.
            const key = o.reason.replace(/\d+/g, "N");
            omissionReasons.set(key, (omissionReasons.get(key) ?? 0) + 1);
          }
        }
        if (omissionReasons.size > 0) {
          const totalOmitted = [...omissionReasons.values()].reduce((a, b) => a + b, 0);
          console.log("");
          console.log(`  Sources left out of packets: ${totalOmitted}`);
          for (const [reason, n] of [...omissionReasons].sort((a, b) => b[1] - a[1])) {
            console.log(`    ${String(n).padStart(4)}  ${reason}`);
          }
          console.log("    (use --rank <n> for the per-article detail)");
        }

        console.log("");
        console.log("  rank tier      ref     section     arts  omit  material       chars  fetched/feed");
        for (const { packet, promptChars } of packets) {
          const fetched = packet.articles.filter((a) => a.origin === "fetched").length;
          const section = packet.section
            ? `${packet.section.ref}/${packet.section.role}`
            : "-";
          console.log(
            `  ${String(packet.rank).padStart(4)} ${packet.tier.padEnd(9)} ${packet.ref.padEnd(7)} ` +
              `${section.padEnd(11)} ` +
              `${String(packet.articles.length).padStart(4)}  ${String(packet.omitted.length).padStart(4)}  ` +
              `${packet.materialLevel.padEnd(13)} ${String(promptChars).padStart(6)}  ` +
              `${fetched}/${packet.articles.length - fetched}`,
          );
        }
        break;
      }

      // Written pieces: the paper as the reader will see it.
      case "writers": {
        if (flags["id"]) {
          const runId = parseInt(flags["id"], 10);
          const { rows: runRows } = await pool.query<{
            id: number; started_at: string; completed_at: string | null;
            editor_run_id: number; model_used: string; pieces_in: number;
            pieces_written: number; pieces_failed: number; calls: number;
            failed_calls: number; input_tokens: number | null; output_tokens: number | null;
          }>("SELECT * FROM writer_runs WHERE id = $1", [runId]);
          const run = runRows[0];
          if (!run) {
            console.log(`No writer run with id ${runId}`);
            break;
          }
          console.log(`Writer run #${run.id}`);
          console.log(`  Editor run: #${run.editor_run_id}`);
          console.log(`  Model:      ${run.model_used}`);
          console.log(`  Pieces:     ${run.pieces_written} written, ${run.pieces_failed} failed of ${run.pieces_in}`);
          console.log(`  Calls:      ${run.calls} (${run.failed_calls} failed)`);
          console.log(`  Tokens:     ${run.input_tokens ?? 0} in, ${run.output_tokens ?? 0} out`);

          const { rows: pieces } = await pool.query<{
            rank: number; tier: string; ref: string; headline: string | null;
            body: string | null; word_count: number; material_level: string | null;
            source_count: number; articles_used: number; status: string; detail: string | null;
            section_ref: string | null; section_title: string | null;
            section_role: string | null; section_rank: number;
          }>(
            `SELECT rank, tier, ref, headline, body, word_count, material_level,
                    source_count, articles_used, status, detail,
                    section_ref, section_title, section_role, section_rank
             FROM writer_pieces WHERE run_id = $1 ORDER BY rank ASC, section_rank ASC`,
            [runId],
          );

          const full = flags["full"] === "true";
          console.log(`\n── PIECES (${pieces.length})`);
          let currentSection: string | null = null;
          for (const p of pieces) {
            // A section reads as one run of pieces under one heading.
            if (p.section_ref !== currentSection) {
              currentSection = p.section_ref;
              if (p.section_ref !== null) {
                console.log(`\n  ══ SECTION ${p.section_ref}: ${p.section_title ?? ""}`);
              }
            }
            if (p.status !== "ok") {
              console.log(`  ${String(p.rank).padStart(3)}. [${p.tier.padEnd(8)}] ${p.ref.padEnd(7)} FAILED — ${p.detail ?? ""}`);
              continue;
            }
            const role = p.section_role ? ` ${p.section_role.padEnd(7)}` : "";
            console.log(
              `  ${String(p.rank).padStart(3)}. [${p.tier.padEnd(8)}]${role} ${p.ref.padEnd(7)} ` +
                `${String(p.word_count).padStart(3)}w  ${(p.material_level ?? "").padEnd(13)} ` +
                `src=${p.source_count}/${p.articles_used}`,
            );
            console.log(`       ${p.headline ?? ""}`);
            if (full && p.body) {
              for (const line of p.body.split("\n")) console.log(`       ${line}`);
              console.log("");
            }
          }
          break;
        }

        const { rows } = await pool.query<{
          id: number; started_at: string; editor_run_id: number; model_used: string;
          pieces_in: number; pieces_written: number; pieces_failed: number; failed_calls: number;
        }>(
          `SELECT id, started_at, editor_run_id, model_used, pieces_in,
                  pieces_written, pieces_failed, failed_calls
           FROM writer_runs ORDER BY started_at DESC LIMIT 20`,
        );
        if (rows.length === 0) {
          console.log("No writer runs yet.");
          break;
        }
        console.log("id     started              editor  model                in    ok    fail  bad-calls");
        for (const r of rows) {
          console.log(
            `${String(r.id).padEnd(6)} ${new Date(r.started_at).toISOString().slice(0, 19)}  ` +
              `#${String(r.editor_run_id).padEnd(6)} ${r.model_used.slice(0, 20).padEnd(20)} ` +
              `${String(r.pieces_in).padEnd(5)} ${String(r.pieces_written).padEnd(5)} ` +
              `${String(r.pieces_failed).padEnd(5)} ${r.failed_calls}`,
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
  timing                   Per-stage durations for the latest run of each stage,
                           plus wall clock across the lineage and how much of it
                           was spent between stages rather than inside them
  fetch [--days <n>]       Per-source article fetch outcomes from article_texts
                           (default 14 days): what a writer ends up with per
                           outlet, why we did not ask, and which sources have
                           never produced a usable article
  packet --editor-run <n>  Writer packet sizes for every story of an editor run
  packet --editor-run <n> --rank <n>
                           Print the full assembled prompt for one story
  writers                  List recent writer runs
  writers --id <n>         Show every written piece; add --full for bodies

Options:
  --source <name>          Filter by source name (exact match)
  --limit <n>              Max rows returned (default varies by command)
  --id <n>                 Run id for detail view
  --editor-run <n>         Editor run id (materials)
  --sources <n>            Rows in the per-source table (materials, default 40)
  --rank <n>               Story rank (packet)
  --full                   Print piece bodies (writers --id)
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
