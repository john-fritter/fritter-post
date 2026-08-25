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
  // Ars Technica closes every feed body with these. The source audit over the
  // 14-day window found 92 of its 92 long bodies ending on one of them, which
  // made a complete article look truncated to `endsMidSentence` — the reason
  // that check runs on the stripped body and not the raw one.
  { pattern: /^read full article\s*[→>»]?$/i, note: "Ars Technica feed footer" },
  { pattern: /^comments$/i, note: "Ars Technica feed footer" },
  // Cascade PBS's house promo for a different programme, which Readability
  // returns as the article on every cascadepbs.org page. Run #118's rank 65 was
  // an ABC-v-FCC story whose first source read "In this episode of 'Beyond the
  // CANVAS,' we sit down with novelist Margaret Atwood…", and rank 8's
  // South Korea feature carried the identical paragraph. Matched on the show
  // name so a genuine article *about* the programme keeps its sentences.
  {
    pattern: /^finding one['’]s voice as a writer takes dedication\b.*$/i,
    note: "Cascade PBS house promo",
  },
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
  // Le Monde's inline "read also" pointer. A line rule rather than a tail cut:
  // in a live blog it appears many times between real entries, so cutting the
  // document at the first one would throw away most of the reporting.
  { pattern: /^lire aussi\s*:?$/i, note: "Le Monde inline read-also" },
  { pattern: /^(?:lire aussi|voir aussi)\s*:\s*.{0,120}$/i, note: "Le Monde inline read-also" },
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

/**
 * Sentence-terminal punctuation, plus the closers that may follow it.
 *
 * An ellipsis is deliberately **not** terminal. In a feed body it is a
 * truncation marker, not a stylistic trail-off, and treating it as an ending is
 * how a teaser passes for a finished article.
 */
const TERMINAL_PUNCT = /[.!?。！？؟।]/;
const TRAILING_CLOSERS = /[)\]"'”’»›\s]*$/;

/**
 * Does this body stop in the middle of a sentence?
 *
 * **A long feed body is not the same as a complete one.** La Nación publishes
 * ~1,800-character teasers that stop mid-clause on an open quote. Run #43's
 * rank 15 (S62865) was one: `feed_chars_floor` is 800, so the fetch skipped it
 * as "already long enough", the writer was handed a fragment, and the piece
 * ends `"We are not only receiving deportees from outside Haiti due to the
 * political crisis; we also have people from" — the source cuts off there.`
 * 180 words of real reporting, and then the writer narrating the packet, which
 * is the one thing the standing memo forbids.
 *
 * Nothing upstream could see it. Every stage between the feed and the writer
 * measured that body by its length and found it generous.
 */
export function endsMidSentence(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length === 0) return false;
  // An explicit ellipsis is a truncation marker, whatever precedes it.
  if (/(?:\.\.\.|…)["'”’»›)\]]*$/.test(trimmed)) return true;
  const withoutClosers = trimmed.replace(TRAILING_CLOSERS, "");
  if (withoutClosers.length === 0) return false;
  return !TERMINAL_PUNCT.test(withoutClosers.slice(-1));
}

/**
 * Drops a trailing half-sentence, back to the last sentence that finished.
 *
 * This is `trimToBoundary`'s rule — "a writer quoting a half-sentence is a
 * defect the assembler can prevent for free" — applied to the case that
 * actually produced one. `trimToBoundary` only ever runs when the *budget*
 * truncated a body, and the budget is inert while `total_chars` is null; the
 * truncation that reached run #43's paper was done by the publisher, upstream
 * of anything that checked.
 *
 * Never empties a body. When no sentence in it ever finished there is nothing
 * to trim back to, and a one-sentence fragment is left for `materialLevelOf`
 * and `isHeadlineEcho` to judge on its length.
 */
export function trimTruncatedTail(text: string): { text: string; trimmed: boolean } {
  if (!endsMidSentence(text)) return { text, trimmed: false };

  let cut = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (!TERMINAL_PUNCT.test(text[i]!)) continue;
    // An ellipsis is not an ending, so do not trim back to the middle of one.
    if (text.slice(i, i + 3) === "..." || text[i] === "\u2026") continue;
    if (i > 0 && (text[i - 1] === "." || text[i - 1] === "\u2026")) continue;
    if (text.slice(i + 1, i + 3) === "..") continue;
    cut = i;
    break;
  }
  if (cut < 0) return { text, trimmed: false };

  // Keep whatever closed the sentence: a full stop inside a quotation belongs
  // with its closing mark.
  let end = cut + 1;
  while (end < text.length && /["'”’»›)\]]/.test(text[end]!)) end++;
  const kept = text.slice(0, end).trimEnd();

  // **Only honour a boundary that keeps most of the body**, which is the guard
  // `trimToBoundary` already applies for the same reason. A body whose last
  // finished sentence is near its start is not prose with a broken tail — it is
  // a list, a caption run, or an extraction with no sentence structure at all,
  // and cutting back to that first full stop would throw away nearly everything
  // to fix nothing. Leave it whole and let `materialLevelOf` judge it on length.
  if (kept.length === 0 || kept.length * 2 < text.trimEnd().length) {
    return { text, trimmed: false };
  }
  return { text: kept, trimmed: true };
}

export interface StripResult {
  text: string;
  /** Number of paragraphs removed, for auditing what the rules are doing. */
  dropped: number;
  /** True when a trailing half-sentence was cut. See trimTruncatedTail. */
  truncatedTail: boolean;
  /**
   * Did the body stop mid-sentence *once its furniture was removed*?
   *
   * Not the same as `truncatedTail`, and the difference matters to the fetch.
   * `trimTruncatedTail` declines to cut when the last finished sentence sits in
   * the first half of the body — a structureless extraction, where trimming
   * would cost more than it saves — but such a body is still incomplete, and
   * still the strongest reason to go and get the real article.
   */
  endedMidSentence: boolean;
}

/**
 * Removes known publisher furniture.
 *
 * Matching is **per line, not per paragraph**. The first version of this
 * matched whole paragraphs and missed the case it was written for: KTVZ emits
 *
 *     The-CNN-Wire
 *     ™ & © 2026 Cable News Network, Inc. … All rights reserved.
 *
 * as two lines of a *single* paragraph, so neither anchored rule could fire and
 * both survived into the rank 3 packet. Lines are still matched end-to-end, so a
 * rule can only ever delete a line that is nothing but furniture — a sentence of
 * reporting that happens to mention CNN is untouched.
 */
export function stripBoilerplate(text: string): StripResult {
  if (text.length === 0)
    return { text, dropped: 0, truncatedTail: false, endedMidSentence: false };

  const paragraphs = text.split(PARAGRAPH_SPLIT);
  const kept: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  outer: for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]!;
    if (para.trim().length === 0) continue;

    const keptLines: string[] = [];
    for (const rawLine of para.split(/\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      if (TAIL_MARKERS.some((re) => re.test(line))) {
        // Everything from here on is a list of other articles. Whatever was kept
        // from this paragraph stays; the rest of the document goes.
        if (keptLines.length > 0) kept.push(keptLines.join("\n"));
        dropped += paragraphs.length - i;
        break outer;
      }

      if (LINE_RULES.some((rule) => rule.pattern.test(line))) {
        dropped++;
        continue;
      }

      keptLines.push(line);
    }

    if (keptLines.length === 0) continue;

    // **A paragraph repeated inside one document is furniture by construction.**
    // No article says the same paragraph twice; a page template does, once per
    // slot. Cascade PBS's extraction carried its "Beyond the CANVAS" promo twice
    // and nothing else, which measured 574 characters against a 390-character
    // feed teaser and won the packet's longer-of-the-two comparison — the
    // comparison happens before the packet-wide dedup that later cut it to 286.
    // Collapsing the repeat here means the candidate is measured at what it
    // actually carries.
    const paragraph = keptLines.join("\n");
    const key = paragraph.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    kept.push(paragraph);
  }

  // Last, so the trim sees the body the writer would actually read: a tail
  // marker or a repeated template paragraph can leave a different final
  // sentence than the raw document had. Both candidates go through here before
  // the packet compares their lengths, which is the same reason furniture is
  // stripped before either is measured — a teaser must not win on text it is
  // about to lose.
  const stripped = kept.join("\n\n");
  const tail = trimTruncatedTail(stripped);
  return {
    text: tail.text,
    dropped,
    truncatedTail: tail.trimmed,
    endedMidSentence: endsMidSentence(stripped),
  };
}
