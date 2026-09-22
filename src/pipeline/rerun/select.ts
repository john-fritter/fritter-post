import type { RerunVerdict } from "./prompt.js";

/** One judged pair: a candidate row against one piece the paper printed. */
export interface JudgedPair {
  rowKey: string;
  /** null when the call failed or the line was unreadable -- kept, unjudged. */
  verdict: RerunVerdict | null;
}

/**
 * The rows to withhold from threading and the pile.
 *
 * A row goes when ANY of its pairs is a rerun. A row is offered its nearest
 * printed pieces, and the one it repeats need not be the nearest: today's
 * AfD recap can be a development against Sep 6's "voting today" piece and a
 * rerun of Sep 8's result. If the reader has already read what it says,
 * which earlier piece they read it in does not matter.
 *
 * Nothing else drops a row. `development`, `new` and `null` all keep it --
 * the verdict that removes a story must be stated, never inferred.
 */
export function rowsToDrop(pairs: JudgedPair[]): Set<string> {
  const drop = new Set<string>();
  for (const p of pairs) if (p.verdict === "rerun") drop.add(p.rowKey);
  return drop;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
