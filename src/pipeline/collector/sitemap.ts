/**
 * Google News sitemap parsing: a publisher's own index of what it just filed.
 *
 * **Why a second feed format exists at all.** AP is the paper's largest single
 * contributor of material — 250 items reached editor runs over the 14 days to
 * 2026-08-25, ahead of OPB and SCMP — and it was 0% usable, because AP serves no
 * RSS and the Google News proxy standing in for it yields interstitials rather
 * than articles. Fifty-two real links, three resolution strategies, zero
 * publisher URLs recovered.
 *
 * AP's own robots.txt declares `news-sitemap-content.xml`, and that is a feed in
 * all but name: 529 entries carrying a URL, a headline and a publication time,
 * spanning about 28 hours. 518 of the 529 were `/article/`. Fifteen sampled
 * pages, run through the real path (`extractArticle` then `stripBoilerplate`),
 * all cleared 800 characters.
 *
 * **What a sitemap does not carry is body text.** Every item from one arrives
 * with a null body, which is not a regression — the Google News items it
 * replaces carried a headline echo worth about a hundred characters — but it is
 * a real property to know: prefilter, grouping and scoring judge these items on
 * their titles, and only the ~150 that reach the editor get their text fetched.
 * That the proxy's title-only items already survived those stages in numbers is
 * the evidence this works; it is not a guarantee, and it is the thing to watch
 * in the first run.
 */

import { DOMParser } from "linkedom";

export interface SitemapEntry {
  url: string;
  title: string;
  publishedAt: Date | null;
}

/** The `<news:...>` names, and the bare forms a publisher may emit instead. */
function firstText(el: Element, names: string[]): string | null {
  for (const name of names) {
    const found = el.getElementsByTagName(name)[0];
    const text = found?.textContent?.trim();
    if (text) return text;
  }
  return null;
}

/**
 * Parses a Google News sitemap into entries, newest first.
 *
 * Never throws. A publisher's malformed sitemap must cost that source and not
 * the run — the same rule the feed path learned when one sax error took Labor
 * Notes down in two consecutive collections.
 *
 * Entries without a URL are dropped, since nothing downstream can identify or
 * link to them. Entries without a title are dropped too: a sitemap carries no
 * body, so the title is the entire item, and a title-less one would reach the
 * prefilter with nothing at all to judge.
 */
export function parseNewsSitemap(xml: string): SitemapEntry[] {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    return [];
  }

  const entries: SitemapEntry[] = [];
  for (const el of Array.from(doc.getElementsByTagName("url"))) {
    const url = firstText(el, ["loc"]);
    if (url === null) continue;
    try {
      new URL(url);
    } catch {
      continue;
    }

    const title = firstText(el, ["news:title", "title"]);
    if (title === null) continue;

    const rawDate = firstText(el, ["news:publication_date", "publication_date", "lastmod"]);
    let publishedAt: Date | null = null;
    if (rawDate !== null) {
      const parsed = new Date(rawDate);
      if (!Number.isNaN(parsed.getTime())) publishedAt = parsed;
    }

    entries.push({ url, title, publishedAt });
  }

  entries.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  return entries;
}

/**
 * Drops entries older than the window.
 *
 * A sitemap is not a feed and does not window itself: AP's spans about 28 hours
 * against a collector that runs daily, so without this the tail is re-collected
 * every day for the preprocessor's cross-run dedup to throw away again. An entry
 * with no date is **kept** — a missing timestamp is not evidence of age, and
 * dropping it would silently lose whatever a publisher forgot to stamp.
 */
export function withinWindow(
  entries: SitemapEntry[],
  maxAgeHours: number,
  now: Date = new Date(),
): SitemapEntry[] {
  if (maxAgeHours <= 0) return entries;
  const cutoff = now.getTime() - maxAgeHours * 3600_000;
  return entries.filter((e) => e.publishedAt === null || e.publishedAt.getTime() >= cutoff);
}

/**
 * Drops entries whose path a publisher's robots.txt disallows.
 *
 * AP's generic block permits `/article/` and `/live/` and sets no Crawl-delay,
 * with exactly one specific article excluded. That one is honoured here rather
 * than noted somewhere and forgotten: the case for collecting AP at all rests on
 * reading its robots.txt, and a rule you read but do not follow is worse than
 * one you never read.
 *
 * Exact paths, not patterns. A prefix rule would quietly grow to cover articles
 * the publisher never excluded, and the whole value of this list is that it can
 * be diffed against the robots.txt it came from.
 */
export function withoutExcludedPaths(
  entries: SitemapEntry[],
  excludePaths: string[] | undefined,
): SitemapEntry[] {
  if (excludePaths === undefined || excludePaths.length === 0) return entries;
  const excluded = new Set(excludePaths.map((p) => p.replace(/\/+$/, "")));
  return entries.filter((e) => {
    try {
      return !excluded.has(new URL(e.url).pathname.replace(/\/+$/, ""));
    } catch {
      return true;
    }
  });
}
