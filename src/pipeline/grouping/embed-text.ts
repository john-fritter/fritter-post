/**
 * The two texts grouping embeds for one item: title + body excerpt (for
 * connected components) and title alone (for attach).
 *
 * Neither may be empty, because the provider rejects an empty input and one
 * rejected input fails the whole batch call -- and the batch call failing
 * fails the grouping run. Sep 12 made no paper for exactly that: KTVZ item
 * 80915, a Central Oregon 9/11 memorial story with a substantial body and an
 * empty title, sat at input 179 of a 200-text request and the provider
 * answered `400 too_small: expected string to have >=1 characters`.
 *
 * So a missing title borrows the start of the body, which is what the item is
 * about, and an item with neither has nothing to embed and returns null: the
 * caller leaves it out of the request, and grouping already treats an item with
 * no embedding as a singleton.
 */

/** How much of a body stands in for a missing title. A headline's length. */
const TITLE_STAND_IN_CHARS = 200;

export interface EmbedSource {
  title: string;
  english_title: string | null;
  body_text: string | null;
  english_body: string | null;
}

export function embedTexts(
  item: EmbedSource,
  bodyCap: number,
): { body: string; title: string } | null {
  const body = (item.english_body ?? item.body_text)?.replace(/\s+/g, " ").trim() ?? "";
  const rawTitle = (item.english_title ?? item.title)?.replace(/\s+/g, " ").trim() ?? "";
  const title = rawTitle.length > 0 ? rawTitle : body.slice(0, TITLE_STAND_IN_CHARS);
  if (title.length === 0) return null;
  if (body.length === 0) return { body: title, title };
  // With no real title the stand-in is the body's own opening, so prefixing it
  // would only say the first sentence twice.
  const excerpt = body.slice(0, bodyCap);
  return { body: rawTitle.length > 0 ? `${title}\n${excerpt}` : excerpt, title };
}
