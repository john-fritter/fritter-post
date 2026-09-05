/**
 * Publisher assembly: the pure half of the stage.
 *
 * Everything here is a function of its arguments — no database, no clock — so
 * the parts that decide what the reader sees can be unit-tested. The stage
 * itself (index.ts) does the I/O and calls into this.
 *
 * Three jobs:
 *   1. attach each written piece to the articles underneath it (resolvePieceSources)
 *   2. group the flat piece list into the rows the index shows (buildIndex)
 *   3. answer "what does this row say" where the data is ragged (displayHeadline)
 */

import type { StoryMaterials } from "../writers/materials.js";

export type PaperTier = "feature" | "standard" | "brief";
export type SectionRole = "lead" | "sidebar" | "line";

/** A written piece, ready to publish. Mirrors writer_pieces plus nothing. */
export interface PublishablePiece {
  writerPieceId: number;
  editorStoryId: number | null;
  rank: number;
  sectionRank: number;
  tier: PaperTier;
  ref: string;
  sectionRef: string | null;
  sectionTitle: string | null;
  sectionRole: SectionRole | null;
  /** Null for a section line, which is written as a bare sentence. */
  headline: string | null;
  body: string;
  wordCount: number;
  /** The editor's count — what the story was ranked on, not what resolved. */
  sourceCount: number;
}

/** One link out, snapshotted at publication. */
export interface PublishableSource {
  preprocessedItemId: number | null;
  sourceName: string;
  sourceType: string | null;
  title: string;
  url: string;
  publishedAt: Date | null;
  position: number;
}

/**
 * The articles a piece was written from.
 *
 * A section piece carries the *member's* ref (C59, S65418) while its story is
 * the thread (T0), so the lookup is two-step: find the story by section_ref,
 * then the member by ref. A standalone piece is its own story and takes every
 * article under it.
 *
 * Deduplicated by URL rather than by item id. The resolver already dedupes by
 * id, but two sources can carry the same canonical URL — a syndicated wire
 * story picked up twice is the ordinary case — and the reader should see one
 * link, not the same link twice.
 *
 * An unresolvable piece returns an empty list rather than throwing. That is the
 * stage's whole failure posture: a piece with no sources is a piece the reader
 * cannot follow anywhere, which is worth counting, and never a reason to lose
 * the rest of the paper.
 */
export function resolvePieceSources(
  piece: PublishablePiece,
  materialsByRef: Map<string, StoryMaterials>,
): PublishableSource[] {
  const story = materialsByRef.get(piece.sectionRef ?? piece.ref);
  if (!story) return [];

  const articles = piece.sectionRef
    ? (story.members.find((m) => m.ref === piece.ref)?.articles ?? [])
    : story.articles;

  const seen = new Set<string>();
  const out: PublishableSource[] = [];
  for (const a of articles) {
    const url = a.canonicalUrl || a.originalUrl;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      preprocessedItemId: a.preprocessedItemId,
      sourceName: a.sourceName,
      sourceType: a.sourceType,
      title: a.title,
      url,
      publishedAt: a.publishedAt,
      position: out.length,
    });
  }
  return out;
}

/** The minimum a row needs to be grouped. Kept structural so the publish-time
 *  and read-time shapes can both use it. */
export interface Groupable {
  rank: number;
  sectionRank: number;
  ref: string;
  sectionRef: string | null;
  sectionTitle: string | null;
}

export type IndexRow<T extends Groupable> =
  | { kind: "thread"; ref: string; rank: number; title: string; members: T[] }
  | { kind: "piece"; rank: number; piece: T };

/**
 * The flat piece list, grouped into the rows the index shows.
 *
 * A thread is one row that expands; every other piece is a row that opens. That
 * is the whole navigation rule, and it lives here so the index page and any
 * report agree on what a row is.
 *
 * Grouping is by section_ref and does not assume the input is sorted or that a
 * section's pieces are adjacent — a section's members share one rank, so any
 * ordering that puts rank first keeps them together, but the publisher should
 * not break if one ever doesn't. Members come out in section_rank order.
 */
export function buildIndex<T extends Groupable>(pieces: T[]): IndexRow<T>[] {
  const rows: IndexRow<T>[] = [];
  const threads = new Map<string, Extract<IndexRow<T>, { kind: "thread" }>>();

  for (const p of [...pieces].sort((a, b) => a.rank - b.rank || a.sectionRank - b.sectionRank)) {
    if (!p.sectionRef) {
      rows.push({ kind: "piece", rank: p.rank, piece: p });
      continue;
    }
    let thread = threads.get(p.sectionRef);
    if (!thread) {
      thread = {
        kind: "thread",
        ref: p.sectionRef,
        rank: p.rank,
        title: p.sectionTitle ?? p.sectionRef,
        members: [],
      };
      threads.set(p.sectionRef, thread);
      rows.push(thread);
    }
    thread.members.push(p);
  }

  for (const t of threads.values()) {
    t.members.sort((a, b) => a.sectionRank - b.sectionRank);
  }
  return rows;
}

/**
 * What a row says.
 *
 * A section line has no headline by design — the writers' line contract is
 * `ref;;the sentence`, because a line sits under a lead that has already
 * established the situation. In a continuous-reading layout that was right. In
 * an index it leaves a row with nothing to show, so the sentence stands in.
 *
 * The sentence is used whole, deliberately. Trimming it to its first sentence
 * would keep the row one line tall, and every cheap way to find that sentence
 * is wrong on news prose: a period followed by a space ends "U.S." and "Adm."
 * as readily as it ends a clause, so `U.S. and NATO officials told AP…` becomes
 * the headline `U.S.`. A tall row is a blemish; a headline that says "U.S." is
 * a defect. The real fix is upstream — a line should carry its own headline —
 * and this stays as the safety net for a null one.
 */
export function displayHeadline(piece: { headline: string | null; body: string }): string {
  const headline = piece.headline?.trim();
  return headline ? headline : piece.body.trim();
}

/**
 * Words a minute, for the folio line and a piece's reading time.
 *
 * A display constant, not a tuning lever: it changes a number the reader
 * glances at and nothing the pipeline decides. 230 is an unremarkable adult
 * rate for news prose.
 */
export const WORDS_PER_MINUTE = 230;

/**
 * A reading time is only information above a paragraph or so. Below that the
 * reader can already see the whole piece, and "1 min" on eighteen words is
 * noise, so it is withheld rather than rounded up.
 */
export const READING_TIME_FLOOR_WORDS = 100;

export function readingMinutes(words: number): number | null {
  if (words < READING_TIME_FLOOR_WORDS) return null;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

/**
 * What a row says about its sourcing.
 *
 * Reports what actually *resolved to links*, not the count the editor ranked
 * the story on. Those differ when the lineage will not resolve, and the reader's
 * question is "where can I go from here", not "what did the formula see". A
 * piece with nothing behind it says nothing rather than claiming sources the
 * page cannot offer.
 */
export function sourceLabel(piece: { resolvedSources: number; firstSource: string | null }): string | null {
  if (piece.resolvedSources > 1) return `${piece.resolvedSources} sources`;
  if (piece.resolvedSources === 1 && piece.firstSource) return piece.firstSource;
  return null;
}

/**
 * A stored body split back into paragraphs. The writers separate them with a
 * blank line; a body with none is one paragraph, not an error.
 */
export function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * The edition date, formatted for the masthead.
 *
 * Built in UTC from the date parts rather than by parsing the string into a
 * local Date: `new Date("2026-08-27")` is midnight UTC, which in Bend is the
 * evening of the 26th, and the masthead would name the wrong day.
 */
export function formatEditionDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * The short date a "previously" marker carries — "Aug 27".
 *
 * Built in UTC from the parts for `formatEditionDate`'s reason: parsing the
 * string into a local Date makes 2026-08-27 the evening of the 26th in Bend, and
 * a continuity marker naming the wrong day is worse than no marker.
 */
export function formatMarkerDate(iso: string): string {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * Whether a re-publish would shrink the edition past the point of being a
 * correction, and by how much. Null means go ahead.
 *
 * **The only place a stage guards an artifact the reader already has**, which is
 * why it is a refusal rather than a warning. Re-publishing a date replaces it —
 * right for correcting a morning, wrong for a second run the same day. Cross-run
 * dedup gave the earlier run today's news, so the second one sees only the hours
 * since and assembles a small paper; every stage's counters look healthy because
 * each is fine in isolation, and a 150-piece edition becomes a 56-piece one
 * behind nine `ok` gates. A warning would arrive after the delete, and the
 * smaller paper is strictly worse than the one it destroyed.
 *
 * Growth is never refused, and neither is replacing a paper that had no pieces:
 * the guard exists to protect a real edition, not to make re-publishing hard.
 */
export function replacementShortfall(
  existingPieceCount: number,
  newPieceCount: number,
  floor: number,
): { ratio: number; existingPieceCount: number; newPieceCount: number } | null {
  if (existingPieceCount <= 0) return null;
  const ratio = newPieceCount / existingPieceCount;
  if (ratio >= floor) return null;
  return { ratio, existingPieceCount, newPieceCount };
}
