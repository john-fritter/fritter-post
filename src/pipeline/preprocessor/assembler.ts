import "dotenv/config";
import { getPool } from "../../db/index.js";
import { classifyItem } from "./junk-filter.js";

export interface PreprocessedItemRow {
  id: string;
  source_name: string;
  source_type: string;
  group: string | null;
  title: string;
  body_text: string | null;
  published_at: string | null;
  fetched_at: string;
}

const BODY_PREVIEW_LENGTH = 50;

function formatTimestamp(publishedAt: string | null): string {
  if (!publishedAt) return "no timestamp";
  const d = new Date(publishedAt);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Returns the set of kept preprocessed_item IDs from the latest completed
 * filter run for the given preprocessor run, or null if no filter run exists.
 */
async function getFilterKeptIds(
  pool: import("pg").Pool,
  preprocessorRunId: number
): Promise<Set<number> | null> {
  const { rows: runRows } = await pool.query<{ id: number }>(
    `SELECT id FROM filter_runs
     WHERE preprocessor_run_id = $1 AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`,
    [preprocessorRunId]
  );
  if (!runRows[0]) return null;

  const filterRunId = runRows[0].id;
  const { rows: resultRows } = await pool.query<{ preprocessed_item_id: string }>(
    `SELECT preprocessed_item_id FROM filter_results
     WHERE filter_run_id = $1 AND keep = true`,
    [filterRunId]
  );
  return new Set(resultRows.map((r: { preprocessed_item_id: string }) => Number(r.preprocessed_item_id)));
}

/**
 * Returns the set of news-routable preprocessed_item IDs from the latest
 * completed prefilter run for the given preprocessor run, or null if no
 * prefilter run exists. Mirrors getFilterKeptIds — same shape, same fallback
 * (no run means no opinion, so nothing is excluded on its account).
 *
 * Restricted to kind = 'news': the prefilter also classifies kept items as
 * news or opinion, and opinion-kept items route to the Longer Reads pool —
 * the same destination as track='analysis' items — rather than into
 * clustering. This function backs the clustering document, so it must
 * exclude them. See docs/decisions.md.
 */
async function getPrefilterKeptIds(
  pool: import("pg").Pool,
  preprocessorRunId: number
): Promise<Set<number> | null> {
  const { rows: runRows } = await pool.query<{ id: number }>(
    `SELECT id FROM prefilter_runs
     WHERE preprocessor_run_id = $1 AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`,
    [preprocessorRunId]
  );
  if (!runRows[0]) return null;

  const prefilterRunId = runRows[0].id;
  const { rows: resultRows } = await pool.query<{ preprocessed_item_id: string }>(
    `SELECT preprocessed_item_id FROM prefilter_results
     WHERE run_id = $1 AND keep = true AND kind = 'news'`,
    [prefilterRunId]
  );
  return new Set(resultRows.map((r: { preprocessed_item_id: string }) => Number(r.preprocessed_item_id)));
}

/**
 * Reads preprocessed_items for a given run, applies the LLM filter run (if
 * any), the bio-aware prefilter run (if any), and the junk filter, and
 * returns the surviving items in chronological order — the same item set
 * `assembleTriageDocument` would format. Exposed so the triage stage can
 * group these items into rounds before formatting.
 */
export async function getTriageItems(preprocessorRunId: number): Promise<PreprocessedItemRow[]> {
  const pool = getPool();

  const { rows: items } = await pool.query<PreprocessedItemRow>(
    `SELECT id, source_name, source_type, "group", title, body_text, published_at, fetched_at
     FROM preprocessed_items
     WHERE preprocessor_run_id = $1 AND track = 'news'
     ORDER BY published_at ASC NULLS LAST, fetched_at ASC`,
    [preprocessorRunId]
  );

  // Apply LLM filter results if a completed filter run exists.
  const keptIds = await getFilterKeptIds(pool, preprocessorRunId);
  const preFilterItems = keptIds !== null
    ? items.filter((item: PreprocessedItemRow) => (keptIds as Set<number>).has(Number(item.id)))
    : items;

  if (keptIds !== null) {
    const dropped = items.length - preFilterItems.length;
    if (dropped > 0) {
      console.log(`[assembler] filter run applied: ${preFilterItems.length} kept, ${dropped} dropped`);
    }
  }

  // Apply the bio-aware prefilter run, if one exists.
  const prefilterKeptIds = await getPrefilterKeptIds(pool, preprocessorRunId);
  const prefilteredItems = prefilterKeptIds !== null
    ? preFilterItems.filter((item: PreprocessedItemRow) => (prefilterKeptIds as Set<number>).has(Number(item.id)))
    : preFilterItems;

  if (prefilterKeptIds !== null) {
    const cut = preFilterItems.length - prefilteredItems.length;
    if (cut > 0) {
      console.log(`[assembler] prefilter run applied: ${prefilteredItems.length} kept, ${cut} cut`);
    }
  }

  // Apply junk filter, logging every drop.
  const kept: PreprocessedItemRow[] = [];
  for (const item of prefilteredItems) {
    const result = classifyItem({
      id: item.id,
      source_name: item.source_name,
      title: item.title,
      body_text: item.body_text,
    });
    if (!result.keep) {
      console.log(`[junk-filter] DROP [${item.id}] ${item.source_name} | ${result.reason} | ${item.title}`);
    } else {
      kept.push(item);
    }
  }

  return kept;
}

/**
 * Formats a list of preprocessed items into the per-item blocks the triage
 * LLM reads: id, source, type, time, headline, body preview. Shared by the
 * full triage document and by the incremental clustering rounds' item lists.
 */
export function formatTriageItemBlocks(items: PreprocessedItemRow[]): string {
  const lines: string[] = [];

  for (const item of items) {
    const timeStr = formatTimestamp(item.published_at);
    lines.push(`[${item.id}] ${item.source_name} | ${item.source_type} | ${timeStr}`);
    lines.push(item.title);
    if (item.body_text) {
      const bodyPreview = item.body_text.replace(/\s+/g, " ").trim().slice(0, BODY_PREVIEW_LENGTH);
      lines.push(bodyPreview);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Reads preprocessed_items for a given run and produces a flat
 * chronological plain-text document for the triage LLM.
 * If a completed filter run exists for this preprocessor run, only the
 * items kept by that filter run are included.
 *
 * An optional `filter` restricts the document to a subset of the surviving
 * items (e.g. by source_type, for clustering rounds) without re-running the
 * filter-run/junk-filter pipeline.
 */
export async function assembleTriageDocument(
  preprocessorRunId: number,
  filter?: (item: PreprocessedItemRow) => boolean,
): Promise<string> {
  const allKept = await getTriageItems(preprocessorRunId);
  const kept = filter ? allKept.filter(filter) : allKept;

  if (kept.length === 0) {
    return `FRITTER POST — TRIAGE INPUT ${formatDate(new Date())}\n0 items | preprocessor run #${preprocessorRunId}\n`;
  }

  const sourceCount = new Set(kept.map((i) => i.source_name)).size;
  const date = formatDate(new Date());

  const lines: string[] = [];

  lines.push(`FRITTER POST — TRIAGE INPUT ${date}`);
  lines.push(`${kept.length} items from ${sourceCount} sources | preprocessor run #${preprocessorRunId}`);
  lines.push(`Reader location: Bend, Oregon`);
  lines.push("");
  lines.push(formatTriageItemBlocks(kept));

  return lines.join("\n");
}
