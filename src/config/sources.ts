import { readFileSync } from "fs";
import path from "path";
import { parse } from "yaml";
import { z } from "zod";

const RawSourceSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  type: z.enum(["wire", "journalism", "advocacy", "newsletter"]),
  track: z.string().optional(),
  group: z.string().optional(),
  notes: z.string().optional(),
  parent: z.string().optional(),
  // How the collector reads this endpoint. `rss` is everything with a feed;
  // `news-sitemap` is a publisher's own Google News sitemap, which is a feed in
  // all but name and the only route to outlets that serve no RSS at all. See
  // src/pipeline/collector/sitemap.ts.
  format: z.enum(["rss", "news-sitemap"]).optional(),
  // Drop items published longer ago than this. A sitemap carries a publisher's
  // whole recent index and is windowed by default (24h) because it has to be;
  // an RSS feed windows itself by construction, so here it is opt-in and unset
  // means no window. Set it on a source whose feed holds more than a day of
  // publishing — a weekly, or any source on its first collection, where the
  // whole backlog arrives at once and competes with the day's news. 0 disables.
  max_age_hours: z.number().int().nonnegative().optional(),
  // Exact URL paths the collector drops — a publisher's robots.txt disallows,
  // or a section of a feed that is not what the source was added for. Written
  // out in full rather than pattern-matched, so the list stays auditable
  // against the robots.txt it came from and stale entries are visible.
  // Re-check when re-probing a source. Applies to both formats.
  exclude_paths: z.array(z.string()).optional(),
});

type RawSource = z.infer<typeof RawSourceSchema>;

const RawSourcesSchema = z.array(RawSourceSchema);

export type Source = Omit<RawSource, "track" | "group" | "format"> & {
  track: "news" | "analysis";
  group: string | null;
  format: "rss" | "news-sitemap";
};

const SOURCES_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "config",
  "sources.yaml"
);

let cached: Source[] | null = null;

export function loadSources(): Source[] {
  if (cached) return cached;
  const raw = readFileSync(SOURCES_PATH, "utf-8");
  const parsed: RawSource[] = RawSourcesSchema.parse(parse(raw));
  cached = parsed.map((s) => {
    let track: "news" | "analysis" = "news";
    if (s.track === "news" || s.track === "analysis") {
      track = s.track;
    } else if (s.track !== undefined) {
      console.warn(
        `[sources] unknown track "${s.track}" for source "${s.name}" — defaulting to "news"`
      );
    }
    return { ...s, track, group: s.group ?? null, format: s.format ?? "rss" };
  });
  return cached;
}
