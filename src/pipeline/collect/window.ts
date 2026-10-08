/**
 * Per-source windowing, shared by both feed formats.
 *
 * These two rules — drop what is too old, drop what the publisher's robots.txt
 * disallows — were written for news sitemaps and applied only there. Both are
 * declared per source in `sources.yaml`, and on an RSS source both were
 * silently inert: `max_age_hours` and `exclude_paths` looked like configuration
 * and did nothing on the format 109 of 111 sources use.
 *
 * The cost showed up when The Nugget was added on 2026-08-28. It is a weekly,
 * so its feed holds several issues at once, and a source's first collection
 * fetches all of it: 44 items, every one new, every one inside the
 * preprocessor's 14-day `max_age_days` backstop. Three of paper #3's top eleven
 * came from that one backlog, some of it a week old, ranked against the day's
 * news. The backstop was doing its job — it exists to catch archive dumps at
 * 14 days — and a newly-added weekly is a smaller, sharper version of the same
 * problem that it cannot see.
 *
 * Accessors rather than a shared item shape: a sitemap entry and a feed item
 * are genuinely different records, and giving them a common interface purely to
 * share these two filters would be the tail wagging the dog.
 */

/**
 * Items published within `maxAgeHours`. `maxAgeHours <= 0` disables the window.
 *
 * **An item with no date is kept.** A feed that publishes no `pubDate` cannot be
 * judged on age, and dropping what we cannot date would silently empty those
 * feeds — a far worse failure than admitting something stale.
 */
export function withinAgeWindow<T>(
  items: T[],
  dateOf: (item: T) => Date | null,
  maxAgeHours: number,
  now: Date = new Date(),
): T[] {
  if (maxAgeHours <= 0) return items;
  const cutoff = now.getTime() - maxAgeHours * 3600_000;
  return items.filter((item) => {
    const d = dateOf(item);
    return d === null || d.getTime() >= cutoff;
  });
}

/**
 * Items whose URL path is not in `excludePaths`.
 *
 * Paths are compared whole and trailing slashes normalised, so the list stays
 * auditable against the robots.txt it came from. An unparseable URL is kept:
 * this filter exists to honour a publisher's disallow list, not to validate
 * URLs, and the identity rules downstream are where a bad URL should die.
 */
export function withoutExcludedUrlPaths<T>(
  items: T[],
  urlOf: (item: T) => string,
  excludePaths: string[] | undefined,
): T[] {
  if (excludePaths === undefined || excludePaths.length === 0) return items;
  const excluded = new Set(excludePaths.map((p) => p.replace(/\/+$/, "")));
  return items.filter((item) => {
    try {
      return !excluded.has(new URL(urlOf(item)).pathname.replace(/\/+$/, ""));
    } catch {
      return true;
    }
  });
}
