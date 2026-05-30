import "dotenv/config";
import { getPool } from "../../db/index.js";

interface PreprocessedItemRow {
  id: string;
  source_name: string;
  source_type: string;
  title: string;
  body_text: string | null;
  published_at: string | null;
  fetched_at: string;
}

const BODY_PREVIEW_LENGTH = 200;

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

  const sourceCount = new Set(items.map((i) => i.source_name)).size;
  const date = formatDate(new Date());

  const lines: string[] = [];

  lines.push(`FRITTER POST — TRIAGE INPUT ${date}`);
  lines.push(`${items.length} items from ${sourceCount} sources | preprocessor run #${preprocessorRunId}`);
  lines.push(`Reader location: Bend, Oregon`);
  lines.push("");

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const index = String(i + 1).padStart(4, "0");
    const timeStr = formatTimestamp(item.published_at);

    const bodyPreview = item.body_text
      ? item.body_text.slice(0, BODY_PREVIEW_LENGTH)
      : "(no body)";

    lines.push(`[${index}] ${item.source_name} | ${item.source_type} | ${timeStr}`);
    lines.push(item.title);
    lines.push(bodyPreview);
    lines.push("");
  }

  return lines.join("\n");
}
