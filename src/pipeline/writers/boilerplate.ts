/**
 * Publisher furniture removal, applied to every article before it reaches a
 * writer prompt.
 *
 * Readability keeps the article and drops the page, but it cannot know that a
 * syndication footer, a wire-service copyright line, or a live blog's "post your
 * question to the newsroom" box are not sentences the paper should read. The
 * first assembled packets for editor run #112 carried all of those into rank 3.
 *
 * **These rules are evidence-driven, like the junk filter's.** Every one of them
 * names the source and the run that produced it. Do not add speculative
 * patterns: a rule that fires on something a publisher actually writes as prose
 * silently deletes reporting, and nothing downstream can tell. Add the test case
 * for both the cut and the near-miss that must survive.
 */

const PARAGRAPH_SPLIT = /\n{2,}/;

/**
 * Everything from this paragraph to the end of the article is furniture.
 * Only for markers that are unambiguously terminal — a heading that introduces
 * a list of other articles, never a heading inside the piece.
 */
const TAIL_MARKERS: RegExp[] = [
  // Meduza, rank 3 source 12: "READ ALSO" then a list of other stories.
  /^read also$/i,
  /^related stor(?:y|ies):?$/i,
  /^more on this story:?$/i,
  /^sign up (?:for|to) .{0,60}newsletter/i,
];

/** Paragraphs dropped wherever they appear. */
const LINE_RULES: Array<{ pattern: RegExp; note: string }> = [
  // KTVZ carrying CNN wire copy, rank 3 source 6.
  { pattern: /^the-cnn-wire$/i, note: "CNN wire marker" },
  {
    pattern: /^[™®]?\s*&?\s*©.{0,120}all rights reserved\.?$/i,
    note: "copyright line",
  },
  // WordPress syndication footer — KTVZ, rank 3 source 6.
  { pattern: /^the post .{1,200} appeared first on .{1,60}\.?$/i, note: "syndication footer" },
  // Guardian feed teasers end with this, rank 17.
  { pattern: /^continue reading\.\.\.$/i, note: "feed teaser marker" },
  // NPR feed items, rank 3 source 10.
  { pattern: /^\(image credit:.{0,120}\)$/i, note: "image credit" },
  // Le Monde live blog chrome, rank 3 source 4.
  { pattern: /^posez votre question à la rédaction\s*:?$/i, note: "Le Monde live chrome" },
  { pattern: /^réagissez$/i, note: "Le Monde live chrome" },
  { pattern: /^[eé]crivez votre message ici$/i, note: "Le Monde live chrome" },
  { pattern: /^votre pseudo\.\.\.$/i, note: "Le Monde live chrome" },
  { pattern: /^live animé par .{1,120}$/i, note: "Le Monde live chrome" },
  { pattern: /^sur le monde aujourd['’]hui$/i, note: "Le Monde most-read block" },
  {
    pattern: /^découvrez les articles les plus lus par nos abonnés$/i,
    note: "Le Monde most-read block",
  },
  // The most-read list items themselves: "1. Article réservé aux abonnés …".
  { pattern: /^\d+\.\s*article réservé aux abonnés\b/i, note: "Le Monde most-read item" },
  { pattern: /^article réservé aux abonnés$/i, note: "Le Monde paywall marker" },
];

/** Characters of new content beyond the headline that make a body worth reading. */
const ECHO_SLACK_CHARS = 40;

function normalizeForCompare(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    // Feeds that route through an aggregator append the publisher's domain to
    // both the title and the body: "… in Warsaw - apnews.com".
    .replace(/[\s-–—|]*\b[\w-]+\.(?:com|org|net|gov|co\.uk|io)\s*$/, "")
    .trim();
}

/**
 * True when an article's "body" is just its headline again.
 *
 * This is what a Google News item looks like: run #112's rank 3 spent one of
 * twelve source slots on `Poland says it thwarted a Russian plot to kill an
 * American citizen in Warsaw  apnews.com` — the headline, the domain, nothing
 * else. Length alone cannot catch it, because a 90-character Al Jazeera summary
 * in the same packet is a real sentence carrying a real fact. The tell is that
 * the body adds nothing the headline did not already say.
 */
export function isHeadlineEcho(title: string, text: string): boolean {
  const body = normalizeForCompare(text);
  if (body.length === 0) return true;
  const headline = normalizeForCompare(title);
  if (headline.length === 0) return false;
  if (!body.startsWith(headline)) return false;
  return body.length - headline.length < ECHO_SLACK_CHARS;
}

export interface StripResult {
  text: string;
  /** Number of paragraphs removed, for auditing what the rules are doing. */
  dropped: number;
}

/**
 * Removes known publisher furniture. Operates on paragraphs, never on
 * substrings, so a rule can only ever delete a whole block that matches it
 * end-to-end — a sentence of reporting that happens to contain one of these
 * phrases is untouched.
 */
export function stripBoilerplate(text: string): StripResult {
  if (text.length === 0) return { text, dropped: 0 };

  const paragraphs = text.split(PARAGRAPH_SPLIT);
  const kept: string[] = [];
  let dropped = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]!.trim();
    if (para.length === 0) continue;

    if (TAIL_MARKERS.some((re) => re.test(para))) {
      // Everything from here on is a list of other articles. Counted by index
      // rather than by searching for the paragraph, which would find the wrong
      // one when a document repeats a line.
      dropped += paragraphs.length - i;
      break;
    }

    if (LINE_RULES.some((rule) => rule.pattern.test(para))) {
      dropped++;
      continue;
    }

    kept.push(para);
  }

  return { text: kept.join("\n\n"), dropped };
}
