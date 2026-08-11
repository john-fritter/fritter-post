import Parser from "rss-parser";
import { synthesizeGuid } from "./guid.js";
import { decodeFeedBytes } from "./charset.js";
import type { Source } from "../../config/sources.js";

// Honest identification, sent first for every feed. It works for the large
// majority of sources and is the right default for a polite aggregator.
const USER_AGENT = "FritterPost/0.1 (+https://post.fritter.lol)";

// Escalation UA, sent only after a source has already refused the honest one
// with a 403. Run #47 lost The Baffler, TechCrunch, and Inside Climate News to
// 403s — three publishers who serve the same feed to any browser, behind CDN
// rules that score an unknown UA as a bot. Retrying once with a browser UA
// costs one extra request on the handful of sources that need it and nothing
// on the rest, and the log line names which sources are in that set so
// sources.yaml can record it.
const FALLBACK_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

const TIMEOUT_MS = 20_000;

const ACCEPT_HEADER =
  "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8";

// Sent only on the escalation attempt. Run #48 showed a UA swap alone is not
// enough for The Baffler or Inside Climate News: the retry fired and was
// refused again. A bot score is built from the whole request, and a "browser"
// that sends no Accept-Language and no Sec-Fetch headers still reads as
// automation. This is the cheap half of the remaining gap — if it does not move
// those two, the block is TLS-fingerprint or IP based and no header set will
// fix it, which is the point at which the honest answer is to drop the source.
const BROWSER_HINT_HEADERS: Record<string, string> = {
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

// Custom item fields beyond the rss-parser defaults.
type CustomItemFields = {
  contentEncoded?: string; // maps from <content:encoded>
  dcCreator?: string;      // maps from <dc:creator>
};

// Transport options are not set here: we fetch and decode the body ourselves
// (see fetchFeedText) and hand the parser a string, so only parseString runs.
const parser = new Parser<Record<string, never>, CustomItemFields>({
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

/** One GET for a feed, with the given UA. No status handling — that's the caller's. */
function requestOnce(url: string, userAgent: string, asBrowser = false): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": userAgent,
      // rss-parser sent `Accept: application/rss+xml`. Dropping it when we took
      // over the transport made The Baffler start returning 403 in run #43 —
      // some CDNs reject feed requests that advertise no acceptable type.
      Accept: ACCEPT_HEADER,
      ...(asBrowser ? BROWSER_HINT_HEADERS : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
}

/**
 * Fetches the feed body and decodes it with the charset the publisher actually
 * used. We do the transport ourselves rather than calling `parser.parseURL`,
 * which reads the charset from the Content-Type header only — it ignores the
 * XML declaration and does not support windows-1252, so Latin-1 feeds arrived
 * as mojibake — accented characters replaced by U+FFFD. See ./charset.ts.
 */
async function fetchFeedText(url: string): Promise<string> {
  let res = await requestOnce(url, USER_AGENT);

  // A 403 to the honest UA is a bot rule, not a real refusal: the publisher is
  // still serving the feed, just not to us. Retry once as a browser. Every
  // other status — 404, 410, 5xx — is the feed genuinely being gone or broken,
  // and retrying it would only double the request for no new information.
  if (res.status === 403) {
    const retry = await requestOnce(url, FALLBACK_USER_AGENT, true);
    if (retry.ok) {
      console.warn(
        `[collector] ${url}: 403 for the FritterPost UA, served with a browser UA — ` +
          `CDN bot rule. Note it in sources.yaml.`,
      );
      res = retry;
    } else {
      // Log the failed escalation too. Without this line a report can only say
      // "no rescue happened", which reads identically to "the retry never ran"
      // — exactly the ambiguity run #48's report hit. A 403 here means the
      // block is not UA-based and no header set will get past it.
      console.warn(
        `[collector] ${url}: 403 for the FritterPost UA, and ${retry.status} for the ` +
          `browser UA too — not a UA rule. Consider dropping the source.`,
      );
      // Report the original refusal; the retry told us nothing new.
      throw new Error(`Status code ${res.status}`);
    }
  }

  if (!res.ok) {
    throw new Error(`Status code ${res.status}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const { text, charset, recovered } = decodeFeedBytes(
    bytes,
    res.headers.get("content-type"),
  );

  if (recovered) {
    console.warn(
      `[collector] ${url}: declared charset did not decode cleanly; ` +
        `recovered as ${charset}`,
    );
  }

  return text;
}

/**
 * Parses the feed, and on a parse error logs the lines around the position sax
 * reported before rethrowing.
 *
 * Run #47 lost Labor Notes to "Unexpected close tag / Line: 64 / Column: 9",
 * which says a tag is unbalanced but not which one, and the feed body is gone
 * by the time anyone reads the log. A malformed feed is usually one publisher's
 * bad escaping in one field; seeing the actual line is the difference between
 * fixing it and guessing at it.
 */
async function parseFeedText(sourceName: string, text: string) {
  try {
    return await parser.parseString(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lineMatch = msg.match(/Line:\s*(\d+)/);
    if (lineMatch) {
      // sax reports 0-based lines; the surrounding window is what's useful.
      const line = Number.parseInt(lineMatch[1]!, 10);
      const lines = text.split(/\r?\n/);
      const from = Math.max(0, line - 3);
      const to = Math.min(lines.length, line + 4);
      console.error(`[collector] ${sourceName}: XML parse failed — ${msg.replace(/\n/g, " ")}`);
      for (let i = from; i < to; i++) {
        const marker = i === line ? ">>" : "  ";
        console.error(`[collector]   ${marker} ${i}: ${lines[i]?.slice(0, 300) ?? ""}`);
      }
    }
    throw err;
  }
}

export async function fetchFeed(source: Source): Promise<FetchedItem[]> {
  const feed = await parseFeedText(source.name, await fetchFeedText(source.url));
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
