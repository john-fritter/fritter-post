import pLimit from "p-limit";
import { loadSources } from "../../config/sources.js";
import { fetchFeed } from "./fetch-feed.js";
import { getPool } from "../../db/index.js";

export interface CollectorOptions {
  /** Restrict to a single source by name. Fetches all sources if omitted. */
  sourceFilter?: string;
  /** Max number of feeds fetched concurrently. Default: 10. */
  concurrency?: number;
}

interface SourceResult {
  source_name: string;
  status: "success" | "error";
  items_fetched: number;
  items_inserted: number;
  error_message?: string;
  duration_ms: number;
}

/**
 * What a collection did, returned rather than only logged.
 *
 * Every other stage returns its run; this one printed its counters and returned
 * void, so the runner would have had to re-read "the latest collector run" and
 * hope it was the one it had just started.
 */
export interface CollectorRunSummary {
  runId: number;
  sourcesAttempted: number;
  sourcesSucceeded: number;
  itemsFetched: number;
  itemsInserted: number;
}

export async function runCollector(
  options: CollectorOptions = {}
): Promise<CollectorRunSummary> {
  const { sourceFilter, concurrency = 10 } = options;
  const pool = getPool();

  const allSources = loadSources();
  const sources = sourceFilter
    ? allSources.filter((s) => s.name === sourceFilter)
    : allSources;

  if (sources.length === 0) {
    const hint = sourceFilter ? ` matching "${sourceFilter}"` : "";
    throw new Error(`No sources found${hint}. Check config/sources.yaml.`);
  }

  // Create the run record before any fetching starts.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO collector_runs (started_at, source_filter)
     VALUES (NOW(), $1)
     RETURNING id`,
    [sourceFilter ?? null]
  );
  const runId = runRows[0]!.id;

  console.log(
    `Collector run #${runId}: ${sources.length} source${sources.length === 1 ? "" : "s"}, concurrency ${concurrency}`
  );

  const limit = pLimit(concurrency);
  const results: SourceResult[] = [];

  const tasks = sources.map((source) =>
    limit(async () => {
      const start = Date.now();
      try {
        const items = await fetchFeed(source);
        let inserted = 0;

        for (const item of items) {
          try {
            const result = await pool.query(
              `INSERT INTO raw_items
                 (source_name, source_type, feed_url, item_guid,
                  original_url, title, body, author, published_at, raw_entry)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               ON CONFLICT (source_name, item_guid) DO NOTHING
               RETURNING id`,
              [
                source.name,
                source.type,
                source.url,
                item.item_guid,
                item.original_url,
                item.title,
                item.body,
                item.author,
                item.published_at,
                item.raw_entry,
              ]
            );
            if (result.rowCount && result.rowCount > 0) inserted++;
          } catch (itemErr) {
            // Skip individual bad items rather than failing the whole source.
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            console.warn(`  [${source.name}] skipped item "${item.title}": ${msg}`);
          }
        }

        const duration_ms = Date.now() - start;
        results.push({
          source_name: source.name,
          status: "success",
          items_fetched: items.length,
          items_inserted: inserted,
          duration_ms,
        });
        console.log(
          `  ✓ ${source.name}: ${items.length} fetched, ${inserted} new (${duration_ms}ms)`
        );
      } catch (err) {
        const duration_ms = Date.now() - start;
        const error_message = err instanceof Error ? err.message : String(err);
        results.push({
          source_name: source.name,
          status: "error",
          items_fetched: 0,
          items_inserted: 0,
          error_message,
          duration_ms,
        });
        console.error(`  ✗ ${source.name}: ${error_message} (${duration_ms}ms)`);
      }
    })
  );

  await Promise.all(tasks);

  const succeeded = results.filter((r) => r.status === "success").length;
  const totalFetched = results.reduce((sum, r) => sum + r.items_fetched, 0);
  const totalInserted = results.reduce((sum, r) => sum + r.items_inserted, 0);

  // pg serializes plain objects to JSON automatically, but treats top-level
  // JS arrays as Postgres arrays rather than JSON — explicit stringify needed.
  await pool.query(
    `UPDATE collector_runs
     SET completed_at      = NOW(),
         sources_attempted = $1,
         sources_succeeded = $2,
         items_fetched     = $3,
         items_inserted    = $4,
         per_source_results = $5::jsonb
     WHERE id = $6`,
    [sources.length, succeeded, totalFetched, totalInserted, JSON.stringify(results), runId]
  );

  console.log(
    `\nRun #${runId} complete: ${succeeded}/${sources.length} sources OK, ` +
    `${totalFetched} items fetched, ${totalInserted} new`
  );

  return {
    runId,
    sourcesAttempted: sources.length,
    sourcesSucceeded: succeeded,
    itemsFetched: totalFetched,
    itemsInserted: totalInserted,
  };
}
