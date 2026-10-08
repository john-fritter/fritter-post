/**
 * Title cleanup for aggregator-supplied feeds.
 *
 * Google News RSS appends the publisher's domain to every headline: run #112
 * published "DHS cites recent policy shift after not disclosing death of
 * Guatemalan man who had been in custody - apnews.com" and eight more like it.
 * The suffix is not part of the headline — it is the aggregator naming its
 * source — and it travels all the way to the reader, through the embeddings that
 * cluster the item and the prompts that judge it.
 *
 * The rule is deliberately narrow: a trailing separator followed by something
 * that is *only* a bare domain. "What Happens When the Most Powerful Law
 * Enforcement Officer in a Rural County Goes Rogue? - Willamette Week" keeps its
 * suffix, because an outlet's name is not a domain and stripping publication
 * names from headlines is a different decision that nobody has made.
 */

// A bare hostname and nothing else: "apnews.com", "bbc.co.uk", "theguardian.com".
// Anchored end-to-end, so "Reuters reports from ap.org and beyond" cannot match.
const BARE_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+$/i;

// Separators an aggregator uses before the attribution.
const SUFFIX_SPLIT = /\s+[-–—|]\s+/;

/**
 * Shortest title we will leave behind. A headline that is mostly its own domain
 * suffix is more likely a malformed feed entry than a real headline, and
 * gutting it would lose more than it cleans.
 */
const MIN_REMAINING_CHARS = 20;

/** Removes a trailing bare-domain attribution. Returns the title unchanged otherwise. */
export function cleanTitle(title: string): string {
  const trimmed = title.trim();
  const parts = trimmed.split(SUFFIX_SPLIT);
  if (parts.length < 2) return trimmed;

  const last = parts[parts.length - 1]!.trim();
  if (!BARE_DOMAIN.test(last)) return trimmed;

  // Rebuild without the final segment, preserving the separators between the
  // parts that remain — a headline may legitimately contain a dash.
  const cut = trimmed.length - last.length;
  const remaining = trimmed.slice(0, cut).replace(/\s*[-–—|]\s*$/, "").trim();

  return remaining.length >= MIN_REMAINING_CHARS ? remaining : trimmed;
}
