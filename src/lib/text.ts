/**
 * Text selection and excerpting for the LLM judgment stages.
 *
 * Two rules live here, both of which were previously re-implemented (and got
 * out of step) at every call site:
 *
 * 1. **Judgment reads English.** The preprocessor translates every non-English
 *    item into `english_title` / `english_body` (migration 028). Until now only
 *    the grouping stage read those columns, so prefilter, grouping-pass-1,
 *    thread, and the editor tie-break were all making bio-aware judgments over
 *    original-language text. Run #47 published 33+ non-Latin-script rows, every
 *    one of them scored on text the scorer had to translate for itself, for
 *    free, inside a batch of 40. The translation is already paid for; these
 *    helpers are how a stage spends it.
 *
 * 2. **Excerpt caps are configuration.** Every cap is passed in, never
 *    hardcoded. `slice(0, 50)` in prefilter and grouping-pass-1 was the reason
 *    singleton scoring collapsed onto a handful of coarse values — see
 *    docs/decisions.md, 2026-08-11.
 *
 * `english_*` is nullable for rows written before migration 028, so both
 * selectors fall back to the original column rather than dropping the item.
 *
 * **Ceiling on body_cap.** The preprocessor translates only the first 2000
 * characters of a non-English body (`translation.ts`), while English items copy
 * through at full length. So any `body_cap` above 2000 silently gives English
 * items more text than foreign ones — the opposite of what these helpers are
 * for. Raise translation's excerpt first if a stage ever needs more than that.
 */

/** A row carrying both original and translated title columns. */
export interface TranslatableTitle {
  title: string;
  english_title?: string | null;
}

/** A row carrying both original and translated body columns. */
export interface TranslatableBody {
  body_text?: string | null;
  english_body?: string | null;
}

/**
 * The title an LLM judgment stage should read: the English translation when the
 * preprocessor produced one, otherwise the original.
 */
export function englishTitle(row: TranslatableTitle): string {
  const translated = row.english_title;
  return translated !== null && translated !== undefined && translated.length > 0
    ? translated
    : row.title;
}

/**
 * The body an LLM judgment stage should read: the English translation when the
 * preprocessor produced one, otherwise the original. Returns "" rather than
 * null so callers can excerpt unconditionally.
 */
export function englishBody(row: TranslatableBody): string {
  const translated = row.english_body;
  if (translated !== null && translated !== undefined && translated.length > 0) {
    return translated;
  }
  return row.body_text ?? "";
}

/**
 * Cap text at `cap` characters. Null/undefined becomes "". A non-positive cap
 * yields "" — a stage that wants no body should say so in config rather than
 * relying on a slice of a negative length behaving surprisingly.
 */
export function excerpt(text: string | null | undefined, cap: number): string {
  if (text === null || text === undefined) return "";
  if (cap <= 0) return "";
  return text.slice(0, cap);
}

/** Convenience: the English body of a row, capped. */
export function englishBodyExcerpt(row: TranslatableBody, cap: number): string {
  return excerpt(englishBody(row), cap);
}
