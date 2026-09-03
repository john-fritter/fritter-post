/**
 * "The latest completed run of stage X."
 *
 * The middle of the pipeline has always resolved its own upstream this way --
 * prefilter, grouping, grouping-pass-1 and the editor all default to the newest
 * completed run above them when given no id. The tail did not: fetch-text,
 * write and publish required an explicit id and exited 1 without one, so the
 * last three stages were the only ones a person had to thread by hand.
 *
 * Shared rather than repeated in three call sites, because "latest" is one idea
 * and three copies of it are three chances to disagree about whether a run that
 * never completed counts.
 */

import { getPool } from "./index.js";

/** The newest completed editor run, or null if there is none. */
export async function latestEditorRunId(): Promise<number | null> {
  const { rows } = await getPool().query<{ id: number }>(
    "SELECT id FROM editor_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
  );
  return rows[0]?.id ?? null;
}

/** The newest completed writer run, or null if there is none. */
export async function latestWriterRunId(): Promise<number | null> {
  const { rows } = await getPool().query<{ id: number }>(
    "SELECT id FROM writer_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
  );
  return rows[0]?.id ?? null;
}

/** Resolves an optional id against a fallback, failing with the stage's own words. */
export async function resolveRunId(
  explicit: number | undefined,
  lookup: () => Promise<number | null>,
  what: string,
): Promise<number> {
  if (explicit !== undefined) return explicit;
  const found = await lookup();
  if (found === null) throw new Error(`No completed ${what} found`);
  return found;
}
