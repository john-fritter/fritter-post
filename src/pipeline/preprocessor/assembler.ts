import "dotenv/config";
import { getPool } from "../../db/index.js";
import { classifyItem } from "./junk-filter.js";

interface PreprocessedItemRow {
  id: string;
  source_name: string;
  source_type: string;
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
 * Reads preprocessed_items for a given run and produces a flat
 * chronological plain-text document for the triage LLM.
 */
export async function assembleTriageDocument(preprocessorRunId: number): Promise<string> {
  const pool = getPool();

  const { rows: items } = await pool.query<PreprocessedItemRow>(
    `SELECT id, source_name, source_type, title, body_text, published_at, fetched_at
     FROM preprocessed_items
     WHERE preprocessor_run_id = $1
     ORDER BY published_at ASC NULLS LAST, fetched_at ASC`,
    [preprocessorRunId]
  );

  if (items.length === 0) {
    return `FRITTER POST — TRIAGE INPUT ${formatDate(new Date())}\n0 items | preprocessor run #${preprocessorRunId}\n`;
  }

  // Apply junk filter, logging every drop.
  const kept: PreprocessedItemRow[] = [];
  for (const item of items) {
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

  const sourceCount = new Set(kept.map((i) => i.source_name)).size;
  const date = formatDate(new Date());

  const lines: string[] = [];

  lines.push(`FRITTER POST — TRIAGE INPUT ${date}`);
  lines.push(`${kept.length} items from ${sourceCount} sources | preprocessor run #${preprocessorRunId}`);
  lines.push(`Reader location: Bend, Oregon`);
  lines.push("");

  for (const item of kept) {
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
