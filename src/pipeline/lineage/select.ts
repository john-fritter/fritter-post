/**
 * Lineage selection policy — pure, so the rules are testable without a database
 * or a vector index.
 *
 * The vector maths lives in Postgres, where the embeddings already are: pulling
 * 4096-dimension vectors into Node to compare them there would ship megabytes
 * over the wire to compute something pgvector does in C. What comes back is a
 * scored candidate list, and everything below is *policy* over that list —
 * which is the half that has rules worth pinning down.
 */

export interface LineageCandidate {
  /** Today's piece. */
  paperPieceId: string;
  ref: string;
  priorPaperId: number;
  priorPaperPieceId: string;
  /** ISO date (YYYY-MM-DD) of the paper the prior piece was published in. */
  priorPublishedOn: string;
  priorRef: string;
  priorHeadline: string | null;
  /** Max cosine similarity between any article behind each piece. */
  similarity: number;
}

export interface SelectOptions {
  /**
   * Cosine floor for calling two pieces the same continuing situation.
   *
   * Grouping uses 0.66 for same-*event* edges within a single day. Continuity
   * across days wants to be stricter than that, because a false link puts a
   * "previously" line on an unrelated story where the reader can see it, while
   * a missed link only leaves today's paper as it already is. Precision is
   * therefore worth more than recall here.
   */
  threshold: number;
}

/**
 * At most one prior piece per piece of today's paper.
 *
 * Ties break toward the **more recent** prior piece. A story running four days
 * straight would otherwise anchor every day to its first appearance, and the
 * useful thing to tell a reader is what the paper said last, not what it said
 * first. `priorRef` is the final tie-break so the result is deterministic.
 *
 * Two of today's pieces are allowed to point at the same prior piece: one day's
 * coverage can genuinely split into two the next.
 */
export function selectLineageLinks(
  candidates: LineageCandidate[],
  opts: SelectOptions,
): LineageCandidate[] {
  const best = new Map<string, LineageCandidate>();

  for (const c of candidates) {
    if (c.similarity < opts.threshold) continue;
    const held = best.get(c.paperPieceId);
    if (!held || beats(c, held)) best.set(c.paperPieceId, c);
  }

  // Stable output order: by today's ref, so a re-run inserts identically.
  return [...best.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

function beats(c: LineageCandidate, held: LineageCandidate): boolean {
  if (c.similarity !== held.similarity) return c.similarity > held.similarity;
  if (c.priorPublishedOn !== held.priorPublishedOn) {
    return c.priorPublishedOn > held.priorPublishedOn;
  }
  return c.priorRef.localeCompare(held.priorRef) < 0;
}

/**
 * How a "previously" line reads.
 *
 * A prior section line has no headline of its own, so there is nothing to show
 * and the link is dropped rather than rendered as an empty date. That is the
 * same call the reading view makes for a line's own row, one step further on:
 * a pointer to a pointer is not worth the reader's attention.
 */
export function lineageLabel(
  link: Pick<LineageCandidate, "priorPublishedOn" | "priorHeadline">,
  formatDate: (iso: string) => string,
): string | null {
  const headline = link.priorHeadline?.trim();
  if (!headline) return null;
  return `${formatDate(link.priorPublishedOn)} — ${headline}`;
}
