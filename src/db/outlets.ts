/**
 * How many *outlets* are behind a cluster.
 *
 * The editor's prominence lift is `source_weight * ln(sources)`, and `sources`
 * meant the cluster's member count — one row per preprocessed item. That counts
 * pickup, which is what it is for, but it also counts the same outlet twice
 * whenever one publisher's feed carries a story more than once.
 *
 * Run #47 made the cost visible. KTVZ's general feed republished the CNN wire
 * in English and in Spanish, and seven clusters held both copies of one story:
 * the Iran response piece, the Mladić obituary, the Nepal floods, the CIA in
 * Moscow. Each pair added one to the count the lift reads, so wire stories were
 * promoted over local singletons partly by being counted twice — and the source
 * it happened through was the one added to supply local news.
 *
 * The general form of the defect is bigger than that one feed. Sibling feeds of
 * one publisher (AP Politics and AP Top News, OPB News and OPB Politics) are
 * already declared in sources.yaml with a shared `parent`, precisely because
 * they are one outlet; nothing downstream read that. So a story both AP feeds
 * carried counted as two sources, and adding the four KTVZ county feeds — all
 * of which overlap — would have made it worse.
 *
 * Counting distinct parents fixes all three at once, and it is what the number
 * was always supposed to mean: `sources` is how many newsrooms reported this,
 * not how many rows we stored.
 *
 * The compression is mild where the count is honest (43 items across 30 outlets
 * is ln 3.76 -> 3.40, about three points at W=9) and total where it is not
 * (two items from one outlet is ln 2 -> ln 1, the full 6.2 points removed).
 */

import { getPool } from "./index.js";
import { loadSources } from "../config/sources.js";

/** sources.yaml name -> the outlet it belongs to. A source with no `parent` is its own. */
export function loadOutletMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of loadSources()) map.set(s.name, s.parent ?? s.name);
  return map;
}

/**
 * Distinct outlets among these source names.
 *
 * **Never returns 0.** The result is fed to `ln()`, and `ln(0)` is -Infinity,
 * which would not throw — it would silently sort a story to the bottom of the
 * paper and look like an editorial judgment. An empty input means the caller
 * could not resolve its items, not that the story has no sources.
 */
export function countDistinctOutlets(
  sourceNames: Iterable<string>,
  outletMap: Map<string, string>,
): number {
  const outlets = new Set<string>();
  for (const name of sourceNames) outlets.add(outletMap.get(name) ?? name);
  return Math.max(1, outlets.size);
}

/**
 * Outlet counts for many clusters at once, by preprocessed item id.
 *
 * One query for every cluster in a run rather than one per cluster: the caller
 * has the whole digest in hand, and this runs inside stages that already hold
 * hundreds of clusters.
 *
 * An id that resolves to no row is dropped rather than counted as an unknown
 * outlet — a missing item is missing, and inventing a source for it would put
 * the invention into the ranking.
 */
export async function outletCountsByCluster(
  memberIdsByCluster: Map<number, number[]>,
): Promise<Map<number, number>> {
  const outletMap = loadOutletMap();
  const allIds = [...new Set([...memberIdsByCluster.values()].flat())];

  const sourceByItem = new Map<number, string>();
  if (allIds.length > 0) {
    const { rows } = await getPool().query<{ id: string; source_name: string }>(
      "SELECT id::text AS id, source_name FROM preprocessed_items WHERE id = ANY($1::bigint[])",
      [allIds],
    );
    for (const r of rows) sourceByItem.set(Number(r.id), r.source_name);
  }

  const counts = new Map<number, number>();
  let unresolved = 0;
  for (const [clusterIndex, ids] of memberIdsByCluster) {
    const names: string[] = [];
    for (const id of ids) {
      const name = sourceByItem.get(id);
      if (name === undefined) unresolved++;
      else names.push(name);
    }
    counts.set(clusterIndex, countDistinctOutlets(names, outletMap));
  }

  if (unresolved > 0) {
    console.warn(
      `[outlets] ${unresolved} cluster member id(s) resolved to no preprocessed item — ` +
        `their clusters are counted on the members that did resolve`,
    );
  }
  return counts;
}
