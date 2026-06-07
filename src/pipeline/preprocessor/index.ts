import "dotenv/config";
import { convert, type HtmlToTextOptions } from "html-to-text";
import { loadSources } from "../../config/sources.js";
import { getPool } from "../../db/index.js";
import { canonicalizeUrl } from "./canonicalize.js";

export interface PreprocessorRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  collectorRunId: number | null;
  rawItemsConsidered: number;
  itemsKept: number;
  itemsDroppedRecency: number;
  itemsDroppedDuplicate: number;
  itemsDroppedParentDedup: number;
  notes: string | null;
}

interface RawItemRow {
  id: string;
  source_name: string;
  original_url: string;
  title: string;
  body: string | null;
  published_at: string | null;
  fetched_at: string;
}

const HTML_TO_TEXT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "figure", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
  ],
};

function stripHtml(raw: string | null): string | null {
  if (!raw) return null;
  const text = convert(raw, HTML_TO_TEXT_OPTIONS).trim();
  return text.length > 0 ? text : null;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function runPreprocessor(options: { collectorRunId?: number } = {}): Promise<PreprocessorRun> {
  const pool = getPool();

  // Build source-type, source-parent, source-track, and source-group lookup
  // from config.
  const sourceTypeMap = new Map<string, string>();
  const parentMap = new Map<string, string>(); // source.name → parent (or source.name if no parent)
  const trackMap = new Map<string, string>(); // source.name → 'news' | 'analysis'
  const groupMap = new Map<string, string | null>(); // source.name → clustering group (or null)
  for (const source of loadSources()) {
    sourceTypeMap.set(source.name, source.type);
    parentMap.set(source.name, source.parent ?? source.name);
    trackMap.set(source.name, source.track);
    groupMap.set(source.name, source.group);
  }

  // Create the run record.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO preprocessor_runs (started_at, collector_run_id)
     VALUES (NOW(), $1)
     RETURNING id`,
    [options.collectorRunId ?? null]
  );
  const runId = runRows[0]!.id;

  try {
    // 1. Recency filter: items published or fetched within 48 hours.
    const { rows: allRows } = await pool.query<RawItemRow & { total_count: string }>(
      `SELECT id, source_name, original_url, title, body, published_at, fetched_at,
              COUNT(*) OVER () AS total_count
       FROM raw_items
       WHERE (published_at >= NOW() - INTERVAL '48 hours')
          OR (published_at IS NULL AND fetched_at >= NOW() - INTERVAL '48 hours')
       ORDER BY COALESCE(published_at, fetched_at) ASC`
    );

    const totalConsidered = allRows.length > 0 ? parseInt(allRows[0]!.total_count, 10) : 0;

    // Count all raw_items to compute dropped-by-recency.
    const { rows: totalRows } = await pool.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM raw_items"
    );
    const grandTotal = parseInt(totalRows[0]?.n ?? "0", 10);
    const droppedRecency = grandTotal - totalConsidered;

    // 2 & 3. HTML stripping and URL canonicalization.
    interface Candidate {
      rawItemId: string;
      sourceName: string;
      sourceType: string;
      track: string;
      group: string | null;
      title: string;
      canonicalUrl: string;
      originalUrl: string;
      bodyText: string | null;
      publishedAt: Date | null;
      fetchedAt: Date;
    }

    interface ExtendedCandidate extends Candidate {
      alsoAppearedIn: string[];
    }

    const candidates: Candidate[] = allRows.map((row) => ({
      rawItemId: row.id,
      sourceName: row.source_name,
      sourceType: sourceTypeMap.get(row.source_name) ?? "journalism",
      track: trackMap.get(row.source_name) ?? "news",
      group: groupMap.get(row.source_name) ?? null,
      title: row.title.trim(),
      canonicalUrl: canonicalizeUrl(row.original_url),
      originalUrl: row.original_url,
      bodyText: stripHtml(row.body),
      publishedAt: row.published_at ? new Date(row.published_at) : null,
      fetchedAt: new Date(row.fetched_at),
    }));

    // 4. Deduplication: within same source_name, keep earliest by published_at / fetched_at.
    // Cross-source duplicates are kept (signal for triage).
    const seen = new Map<string, Candidate>(); // key: `${source_name}::${canonical_url}`
    let droppedDuplicate = 0;
    const surviving: Candidate[] = [];

    for (const item of candidates) {
      const key = `${item.sourceName}::${item.canonicalUrl}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, item);
        surviving.push(item);
      } else {
        // Keep the one with the earlier effective timestamp.
        const itemTs = item.publishedAt ?? item.fetchedAt;
        const existingTs = existing.publishedAt ?? existing.fetchedAt;
        if (itemTs < existingTs) {
          // Replace: remove existing from surviving, add current.
          const idx = surviving.indexOf(existing);
          if (idx !== -1) surviving.splice(idx, 1);
          seen.set(key, item);
          surviving.push(item);
        }
        droppedDuplicate++;
      }
    }

    // 5. Within-parent dedup: collapse duplicate items from different feeds of the
    //    same parent outlet (e.g. AP Top News + AP Politics both carrying same story).
    //    Items are already sorted by published_at ASC from the SQL query — first seen wins.
    const parentUrlSeen = new Map<string, ExtendedCandidate>();   // `${parent}::${canonical_url}`
    const parentTitleSeen = new Map<string, ExtendedCandidate>(); // `${parent}::${normalized_title}`
    let droppedParentDedup = 0;
    const finalSurviving: ExtendedCandidate[] = [];

    for (const item of surviving) {
      const parent = parentMap.get(item.sourceName) ?? item.sourceName;
      const urlKey = `${parent}::${item.canonicalUrl}`;
      const normalizedTitle = normalizeTitle(item.title);
      const titleKey = `${parent}::${normalizedTitle}`;

      // Check URL match first.
      let winner = parentUrlSeen.get(urlKey);
      let matchType = "url";

      // Fall back to title match (only for titles long enough to be distinctive).
      if (!winner && normalizedTitle.length >= 30) {
        winner = parentTitleSeen.get(titleKey);
        matchType = "title";
      }

      if (winner) {
        console.log(
          `[preprocessor] parent-dedup [${matchType}]: kept "${winner.sourceName}" over "${item.sourceName}" | parent: ${parent} | "${item.title}"`
        );
        winner.alsoAppearedIn.push(item.sourceName);
        // Register winner under the duplicate's keys too (handles 3-way dedup).
        parentUrlSeen.set(urlKey, winner);
        if (normalizedTitle.length >= 30) parentTitleSeen.set(titleKey, winner);
        droppedParentDedup++;
      } else {
        const extended: ExtendedCandidate = { ...item, alsoAppearedIn: [] };
        finalSurviving.push(extended);
        parentUrlSeen.set(urlKey, extended);
        if (normalizedTitle.length >= 30) parentTitleSeen.set(titleKey, extended);
      }
    }

    // 6. Bulk insert with a transaction.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const item of finalSurviving) {
        await client.query(
          `INSERT INTO preprocessed_items
             (preprocessor_run_id, raw_item_id, source_name, source_type, track, "group",
              title, canonical_url, original_url, body_text,
              published_at, fetched_at, also_appeared_in)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            runId,
            item.rawItemId,
            item.sourceName,
            item.sourceType,
            item.track,
            item.group,
            item.title,
            item.canonicalUrl,
            item.originalUrl,
            item.bodyText,
            item.publishedAt,
            item.fetchedAt,
            item.alsoAppearedIn.length > 0 ? item.alsoAppearedIn.join(", ") : null,
          ]
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      const msg = err instanceof Error ? err.message : String(err);
      await pool.query(
        `UPDATE preprocessor_runs
         SET completed_at = NOW(), notes = $1
         WHERE id = $2`,
        [`Insert failed and was rolled back: ${msg}`, runId]
      );
      throw err;
    } finally {
      client.release();
    }

    // Log news/analysis split so routing is verifiable.
    const newsCount = finalSurviving.filter((i) => i.track === "news").length;
    const analysisCount = finalSurviving.filter((i) => i.track === "analysis").length;
    console.log(
      `[preprocessor] track split: ${newsCount} news, ${analysisCount} analysis (of ${finalSurviving.length} kept)`
    );

    // Finalize the run record.
    await pool.query(
      `UPDATE preprocessor_runs
       SET completed_at                = NOW(),
           raw_items_considered        = $1,
           items_kept                  = $2,
           items_dropped_recency       = $3,
           items_dropped_duplicate     = $4,
           items_dropped_parent_dedup  = $5
       WHERE id = $6`,
      [totalConsidered, finalSurviving.length, droppedRecency, droppedDuplicate, droppedParentDedup, runId]
    );

    const { rows: finalRows } = await pool.query<{
      id: number;
      started_at: string;
      completed_at: string;
      collector_run_id: number | null;
      raw_items_considered: number;
      items_kept: number;
      items_dropped_recency: number;
      items_dropped_duplicate: number;
      items_dropped_parent_dedup: number;
      notes: string | null;
    }>("SELECT * FROM preprocessor_runs WHERE id = $1", [runId]);

    const r = finalRows[0]!;
    return {
      id: r.id,
      startedAt: new Date(r.started_at),
      completedAt: new Date(r.completed_at),
      collectorRunId: r.collector_run_id,
      rawItemsConsidered: r.raw_items_considered,
      itemsKept: r.items_kept,
      itemsDroppedRecency: r.items_dropped_recency,
      itemsDroppedDuplicate: r.items_dropped_duplicate,
      itemsDroppedParentDedup: r.items_dropped_parent_dedup,
      notes: r.notes,
    };
  } catch (err) {
    // Mark the run as failed if we haven't already.
    const msg = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE preprocessor_runs
       SET notes = COALESCE(notes, $1)
       WHERE id = $2 AND completed_at IS NULL`,
      [`Run failed: ${msg}`, runId]
    );
    throw err;
  }
}
