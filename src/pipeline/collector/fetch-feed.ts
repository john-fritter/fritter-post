import Parser from "rss-parser";
import { synthesizeGuid } from "./guid.js";
import type { Source } from "../../config/sources.js";

const USER_AGENT = "FritterPost/0.1 (+https://post.fritter.lol)";
const TIMEOUT_MS = 20_000;

// Custom item fields beyond the rss-parser defaults.
type CustomItemFields = {
  contentEncoded?: string; // maps from <content:encoded>
  dcCreator?: string;      // maps from <dc:creator>
};

const parser = new Parser<Record<string, never>, CustomItemFields>({
  timeout: TIMEOUT_MS,
  headers: { "User-Agent": USER_AGENT },
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["dc:creator", "dcCreator"],
    ],
  },
});

export interface FetchedItem {
  item_guid: string;
  original_url: string;
  title: string;
  body: string | null;
  author: string | null;
  published_at: Date | null;
  raw_entry: Parser.Item & CustomItemFields;
}

export async function fetchFeed(source: Source): Promise<FetchedItem[]> {
  const feed = await parser.parseURL(source.url);
  const results: FetchedItem[] = [];

  for (const item of feed.items) {
    const rawItem = item as Parser.Item & {
      id?: unknown;
      guid?: unknown;
      link?: unknown;
    };
    const originalUrl =
      typeof rawItem.link === "string" && rawItem.link
        ? rawItem.link
        : typeof rawItem.guid === "string" && /^https?:\/\//.test(rawItem.guid)
          ? rawItem.guid
          : typeof rawItem.id === "string" && /^https?:\/\//.test(rawItem.id)
            ? rawItem.id
            : null;
    const title = item.title ?? "(no title)";

    if (!originalUrl) {
      // Skip items with no URL — can't meaningfully identify or link to them.
      continue;
    }

    // Prefer the feed's own guid; synthesize if absent or if guid looks like
    // a URL duplicate of link (some feeds set guid = link, which is fine, but
    // ensures the synthesized path is only taken when truly absent).
    const item_guid = item.guid ?? synthesizeGuid(source.name, originalUrl, title);

    // Body: prefer full HTML content:encoded, fall back to content, then null.
    // Do not strip HTML — downstream stages decide what to do with it.
    const body = item.contentEncoded ?? item.content ?? null;

    // Author: dc:creator is the canonical author field in RSS; fall back to
    // the base creator field that rss-parser maps from various author elements.
    const author = item.dcCreator ?? item.creator ?? null;

    // Parse published_at; leave null if missing or unparseable.
    let published_at: Date | null = null;
    const rawDate = item.pubDate ?? item.isoDate;
    if (rawDate) {
      const d = new Date(rawDate);
      if (!isNaN(d.getTime())) published_at = d;
    }

    results.push({
      item_guid,
      original_url: originalUrl,
      title,
      body: body || null,
      author: author || null,
      published_at,
      raw_entry: item,
    });
  }

  return results;
}
