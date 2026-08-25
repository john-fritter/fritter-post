/**
 * Source reachability probe: what does a publisher actually serve us?
 *
 * The same discovery mechanism `embedding-experiment` is, for the same reason.
 * `sources.yaml` records AP as having no working feed on the strength of five
 * URLs tried on 2026-08-14, and that note is now load-bearing for the largest
 * single contributor of material to the paper — 250 items over 14 days, 0% of
 * them usable. A note is not a probe, and five paths is not a search.
 *
 * Read-only. Touches no table and writes no row; the only side effect is HTTP
 * requests to the host being probed, one at a time.
 *
 *   npm run probe-source -- --robots apnews.com
 *   npm run probe-source -- --feeds apnews.com
 *   npm run probe-source -- --resolve "https://news.google.com/rss/articles/CBMi..."
 *   npm run probe-source -- --resolve-source "AP Top News" [--limit 20]
 */

import "dotenv/config";
import { getPool } from "../src/db/index.js";
import {
  HONEST_USER_AGENT,
  BROWSER_USER_AGENT,
  BROWSER_HINT_HEADERS,
  hostOf,
} from "../src/lib/http.js";
import {
  decodeGoogleNewsToken,
  isGoogleNewsLink,
} from "../src/pipeline/collector/google-news.js";

const TIMEOUT_MS = 20000;
const POLITE_DELAY_MS = 1500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Probe {
  url: string;
  status: number | null;
  contentType: string;
  bytes: number;
  redirectedTo: string | null;
  note: string;
  body?: string;
}

/**
 * One request, with the project's own identity rule: honest first, browser
 * identity once and only on a 403.
 */
async function probe(url: string, keepBody = false): Promise<Probe> {
  const attempt = async (browser: boolean): Promise<Response> => {
    const headers: Record<string, string> = {
      "User-Agent": browser ? BROWSER_USER_AGENT : HONEST_USER_AGENT,
      Accept: "application/rss+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.8",
      ...(browser ? BROWSER_HINT_HEADERS : {}),
    };
    return fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
  };

  try {
    let res = await attempt(false);
    let note = "";
    if (res.status === 403) {
      res = await attempt(true);
      note = res.ok ? "browser identity needed" : "refused both identities";
    }
    const body = await res.text();
    return {
      url,
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      bytes: body.length,
      redirectedTo: res.url !== url ? res.url : null,
      note,
      body: keepBody ? body : undefined,
    };
  } catch (err) {
    return {
      url,
      status: null,
      contentType: "",
      bytes: 0,
      redirectedTo: null,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

function describe(p: Probe): string {
  const status = p.status === null ? "ERR" : String(p.status);
  const kind = /xml|rss|atom/.test(p.contentType)
    ? "XML"
    : /html/.test(p.contentType)
      ? "html"
      : p.contentType.split(";")[0] || "?";
  const bits = [
    `${status.padStart(3)} ${kind.padEnd(5)} ${String(p.bytes).padStart(7)}b`,
    p.redirectedTo ? `→ ${p.redirectedTo}` : null,
    p.note || null,
  ].filter(Boolean);
  return bits.join("  ");
}

/**
 * robots.txt first, because it is the one request that *tells you* where the
 * feeds and sitemaps are instead of guessing. A publisher that serves Google
 * News must expose a news sitemap, and a news sitemap is a feed in all but
 * name: article URLs, titles and publication times for the last 48 hours.
 */
async function probeRobots(host: string): Promise<void> {
  const url = `https://${host}/robots.txt`;
  console.log(`\n=== robots.txt — ${host} ===\n`);
  const p = await probe(url, true);
  console.log(`  ${describe(p)}`);
  if (!p.body) return;
  const sitemaps = [...p.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
  if (sitemaps.length === 0) {
    console.log("  no Sitemap: directives");
    return;
  }
  console.log(`\n  ${sitemaps.length} sitemap(s) declared:`);
  for (const s of sitemaps) console.log(`    ${s}`);

  console.log("\n  probing each:");
  for (const s of sitemaps) {
    await sleep(POLITE_DELAY_MS);
    const sp = await probe(s, true);
    const urls = sp.body ? (sp.body.match(/<loc>/g) ?? []).length : 0;
    const news = sp.body ? /<news:news>|<news:publication>/.test(sp.body) : false;
    console.log(
      `    ${describe(sp)}  ${urls} <loc>${news ? "  NEWS SITEMAP — carries titles and publication dates" : ""}`,
    );
  }
}

/** Candidate paths, tried honestly and one at a time. */
const FEED_PATHS = [
  "/index.rss", "/rss", "/rss.xml", "/feed", "/feed.xml", "/feeds", "/atom.xml",
  "/hub/ap-top-news.rss", "/hub/politics.rss", "/apf-topnews?format=rss",
  "/sitemap.xml", "/sitemap_index.xml", "/news-sitemap.xml", "/sitemap-news.xml",
  "/googlenews.xml", "/sitemaps/news.xml", "/arc/outboundfeeds/rss/?outputType=xml",
];

async function probeFeeds(host: string): Promise<void> {
  console.log(`\n=== candidate feed and sitemap paths — ${host} ===\n`);
  for (const path of FEED_PATHS) {
    const p = await probe(`https://${host}${path}`, true);
    const items = p.body ? (p.body.match(/<item[\s>]|<entry[\s>]/g) ?? []).length : 0;
    const locs = p.body ? (p.body.match(/<loc>/g) ?? []).length : 0;
    const found = items > 0 ? `  ${items} items` : locs > 0 ? `  ${locs} <loc>` : "";
    console.log(`  ${path.padEnd(42)} ${describe(p)}${found}`);
    await sleep(POLITE_DELAY_MS);
  }
}

type Strategy = "token-decode" | "redirect-follow" | "interstitial-html";

interface Resolution {
  source: string;
  resolved: string | null;
  strategy: Strategy | null;
  detail: string;
}

/**
 * Try each strategy in order, cheapest first, and report which one worked.
 *
 * The order is the point. `token-decode` is free and offline; if the feed still
 * serves the older encoding, nothing else is needed and the resolution can move
 * into the preprocessor beside the other redirector unwrapping. Only if that
 * comes back empty do the network strategies matter.
 */
async function resolveOne(url: string): Promise<Resolution> {
  const decoded = decodeGoogleNewsToken(url);
  if (decoded !== null) {
    return { source: url, resolved: decoded, strategy: "token-decode", detail: "offline" };
  }

  const p = await probe(url, true);
  if (p.redirectedTo && !isGoogleNewsLink(p.redirectedTo)) {
    return {
      source: url,
      resolved: p.redirectedTo,
      strategy: "redirect-follow",
      detail: `HTTP ${p.status}`,
    };
  }

  // The interstitial is a JS shell, but it usually names the destination
  // somewhere in it. Look for any absolute URL that is not Google's own.
  if (p.body) {
    const candidates = [...p.body.matchAll(/https?:\/\/[^\s"'<>\\]+/g)]
      .map((m) => m[0])
      .filter((u) => {
        const h = hostOf(u);
        return (
          h !== "news.google.com" &&
          !h.endsWith("google.com") &&
          !h.endsWith("gstatic.com") &&
          !h.endsWith("googleapis.com") &&
          !h.endsWith("schema.org") &&
          !h.endsWith("w3.org")
        );
      });
    if (candidates.length > 0) {
      return {
        source: url,
        resolved: candidates[0]!,
        strategy: "interstitial-html",
        detail: `${candidates.length} non-Google URL(s) in ${p.bytes}b page`,
      };
    }
  }

  return {
    source: url,
    resolved: null,
    strategy: null,
    detail: `HTTP ${p.status ?? "ERR"}, ${p.bytes}b, no publisher URL found${p.note ? ` — ${p.note}` : ""}`,
  };
}

async function resolveFromDb(sourceName: string, limit: number): Promise<void> {
  const { rows } = await getPool().query<{ canonical_url: string; title: string }>(
    `SELECT canonical_url, title FROM preprocessed_items
     WHERE source_name = $1 AND canonical_url LIKE '%news.google.com%'
     ORDER BY id DESC LIMIT $2`,
    [sourceName, limit],
  );
  if (rows.length === 0) {
    console.log(`No Google News rows for source "${sourceName}".`);
    return;
  }

  console.log(`\n=== resolving ${rows.length} real link(s) — ${sourceName} ===\n`);
  const byStrategy = new Map<string, number>();
  for (const row of rows) {
    const r = await resolveOne(row.canonical_url);
    const key = r.strategy ?? "UNRESOLVED";
    byStrategy.set(key, (byStrategy.get(key) ?? 0) + 1);
    console.log(`  ${key.padEnd(18)} ${row.title.slice(0, 62)}`);
    console.log(`      ${r.resolved ?? r.detail}`);
    if (r.strategy !== "token-decode") await sleep(POLITE_DELAY_MS);
  }

  console.log(`\n  ── by strategy`);
  for (const [k, n] of [...byStrategy].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(4)}  ${k}  (${((n / rows.length) * 100).toFixed(0)}%)`);
  }
  const resolved = rows.length - (byStrategy.get("UNRESOLVED") ?? 0);
  console.log(`\n  ${resolved} of ${rows.length} resolved to a publisher URL.`);
}

function flagsOf(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    flags[a.slice(2)] = next && !next.startsWith("--") ? next : "true";
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = flagsOf(process.argv.slice(2));

  if (flags["robots"] && flags["robots"] !== "true") {
    await probeRobots(flags["robots"]);
  } else if (flags["feeds"] && flags["feeds"] !== "true") {
    await probeFeeds(flags["feeds"]);
  } else if (flags["resolve"] && flags["resolve"] !== "true") {
    const r = await resolveOne(flags["resolve"]);
    console.log(`\n  strategy: ${r.strategy ?? "UNRESOLVED"}`);
    console.log(`  result:   ${r.resolved ?? r.detail}\n`);
  } else if (flags["resolve-source"] && flags["resolve-source"] !== "true") {
    const limit = flags["limit"] ? parseInt(flags["limit"], 10) : 20;
    await resolveFromDb(flags["resolve-source"], limit);
  } else {
    console.log(`Usage: npm run probe-source -- <mode>

  --robots <host>             Fetch robots.txt and probe every Sitemap: it declares.
                              Start here: it names the feeds instead of guessing.
  --feeds <host>              Try a battery of candidate feed and sitemap paths.
  --resolve <url>             Resolve one aggregator link, reporting which
                              strategy worked.
  --resolve-source <name>     Take recent real links for a configured source out
                  [--limit n] of preprocessed_items and resolve each, reporting
                              the success rate per strategy.

Read-only: no table is written. Requests are serialized with a polite delay.`);
  }
  await getPool().end().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
