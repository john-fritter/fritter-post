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
  looksLikeArticleUrl,
} from "../src/pipeline/collector/google-news.js";
import {
  parseNewsSitemap,
  looksLikeSitemapIndex,
  withinWindow,
} from "../src/pipeline/collector/sitemap.js";
import { extractArticle } from "../src/pipeline/writers/extract.js";
import { stripBoilerplate } from "../src/pipeline/writers/boilerplate.js";

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
  /** null when no expected title was available to check against. */
  verified: boolean | null;
  destinationTitle: string | null;
}

/** Comparable form: case, punctuation and stopwords are not identity. */
function titleTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

/**
 * Does the page at `url` actually carry the story the feed promised?
 *
 * **The probe must never report a success it has not checked.** The first
 * version of this script did, and it reported 52 of 52 Google News links
 * resolved when the true answer was zero — every "publisher URL" was the same
 * 676-byte logo PNG. A tool that launders a guess into a finding is worse than
 * no tool, because the next decision gets made on it.
 */
async function verifyDestination(
  url: string,
  expectedTitle: string,
): Promise<{ ok: boolean; title: string | null; detail: string }> {
  const p = await probe(url, true);
  if (p.status === null || p.status >= 400 || !p.body) {
    return { ok: false, title: null, detail: `HTTP ${p.status ?? "ERR"}, ${p.bytes}b` };
  }
  if (!/html/i.test(p.contentType)) {
    return { ok: false, title: null, detail: `not HTML (${p.contentType}, ${p.bytes}b)` };
  }
  const match = p.body.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const title = match ? match[1]!.replace(/\s+/g, " ").trim() : null;
  if (title === null) return { ok: false, title: null, detail: `no <title> in ${p.bytes}b` };

  const want = titleTokens(expectedTitle);
  const got = titleTokens(title);
  if (want.size === 0) return { ok: false, title, detail: "feed title had no comparable words" };
  let shared = 0;
  for (const w of want) if (got.has(w)) shared++;
  const ratio = shared / want.size;
  return {
    ok: ratio >= 0.5,
    title,
    detail: `${shared}/${want.size} title words matched (${(ratio * 100).toFixed(0)}%)`,
  };
}

/**
 * Try each strategy in order, cheapest first, and report which one worked.
 *
 * The order is the point. `token-decode` is free and offline; if the feed still
 * serves the older encoding, nothing else is needed and the resolution can move
 * into the preprocessor beside the other redirector unwrapping. Only if that
 * comes back empty do the network strategies matter.
 *
 * Every candidate must clear `looksLikeArticleUrl` before it is offered, and
 * when an expected title is available the destination is fetched and checked
 * against it. Unverified is reported as unverified, never as resolved.
 */
async function resolveOne(url: string, expectedTitle?: string): Promise<Resolution> {
  const finish = async (
    resolved: string,
    strategy: Strategy,
    detail: string,
  ): Promise<Resolution> => {
    if (expectedTitle === undefined) {
      return { source: url, resolved, strategy, detail, verified: null, destinationTitle: null };
    }
    await sleep(POLITE_DELAY_MS);
    const v = await verifyDestination(resolved, expectedTitle);
    return {
      source: url,
      resolved,
      strategy,
      detail: `${detail}; ${v.detail}`,
      verified: v.ok,
      destinationTitle: v.title,
    };
  };

  const decoded = decodeGoogleNewsToken(url);
  if (decoded !== null && looksLikeArticleUrl(decoded)) {
    return finish(decoded, "token-decode", "offline");
  }

  const p = await probe(url, true);
  if (p.redirectedTo && looksLikeArticleUrl(p.redirectedTo)) {
    return finish(p.redirectedTo, "redirect-follow", `HTTP ${p.status}`);
  }

  // The interstitial is a JS shell. As of the 2026-08-25 probe it names no
  // publisher URL at all — 580KB of page with no apnews.com in it — but the
  // strategy stays because Google has changed this encoding before and may
  // again. What it must not do is accept the page's furniture.
  if (p.body) {
    const candidates = [...p.body.matchAll(/https?:\/\/[^\s"'<>\\]+/g)]
      .map((m) => m[0])
      .filter(looksLikeArticleUrl);
    if (candidates.length > 0) {
      return finish(
        candidates[0]!,
        "interstitial-html",
        `${candidates.length} candidate(s) in ${p.bytes}b page`,
      );
    }
  }

  return {
    source: url,
    resolved: null,
    strategy: null,
    detail: `HTTP ${p.status ?? "ERR"}, ${p.bytes}b, no publisher URL found${p.note ? ` — ${p.note}` : ""}`,
    verified: null,
    destinationTitle: null,
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
  let verified = 0;
  let falsePositives = 0;
  for (const row of rows) {
    const r = await resolveOne(row.canonical_url, row.title);
    const key = r.strategy ?? "UNRESOLVED";
    byStrategy.set(key, (byStrategy.get(key) ?? 0) + 1);
    if (r.verified === true) verified++;
    if (r.resolved !== null && r.verified === false) falsePositives++;
    const mark = r.verified === true ? "OK " : r.verified === false ? "WRONG" : "?  ";
    console.log(`  ${mark} ${key.padEnd(18)} ${row.title.slice(0, 58)}`);
    console.log(`       ${r.resolved ?? r.detail}`);
    if (r.resolved !== null) console.log(`       ${r.detail}`);
    if (r.destinationTitle) console.log(`       destination title: ${r.destinationTitle.slice(0, 90)}`);
    if (r.strategy !== "token-decode") await sleep(POLITE_DELAY_MS);
  }

  console.log(`\n  ── by strategy (claimed)`);
  for (const [k, n] of [...byStrategy].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(4)}  ${k}  (${((n / rows.length) * 100).toFixed(0)}%)`);
  }
  console.log(`\n  ── verified against the feed's own title`);
  console.log(`     ${String(verified).padStart(4)}  correct publisher article`);
  console.log(`     ${String(falsePositives).padStart(4)}  RESOLVED BUT WRONG — a strategy is lying`);
  console.log(
    `     ${String(rows.length - verified - falsePositives).padStart(4)}  unresolved\n`,
  );
  if (falsePositives > 0) {
    console.log(
      `  A non-zero "resolved but wrong" count is a bug in the resolver, not a\n` +
        `  property of the feed. Do not use these URLs.\n`,
    );
  }
}

/**
 * Does a sitemap actually give us articles a writer can use?
 *
 * A sitemap answers only half the question. It hands over URLs and titles; the
 * text still has to come out of the page, and **the fetch has never once
 * requested apnews.com** — the cooldown that hides AP is on news.google.com, so
 * whether Readability finds prose on an AP article page is completely untested.
 * A sitemap we cannot extract from is worth exactly what the interstitials were.
 *
 * So this runs the real path: fetch the page, `extractArticle`, then
 * `stripBoilerplate`, and report the characters a packet would actually carry.
 * Anything less measures a different pipeline than the one that writes the paper.
 *
 * **And the parse is the production parse.** This function used to read the XML
 * with four regexes of its own, which is the same defect one level up: the
 * finding that put AP into `sources.yaml` — 529 entries, 518 of them
 * `/article/` — was produced by code the collector does not run, so
 * `parseNewsSitemap` and its linkedom DOMParser had never once seen real AP
 * markup. It now calls the shipped parser, and reports what the collector's own
 * window and exclude rules would then leave, so a probe run is a genuine
 * rehearsal of a collection rather than a second opinion about one.
 */
async function probeSitemapExtraction(sitemapUrl: string, limit: number): Promise<void> {
  console.log(`\n=== extraction from ${sitemapUrl} ===\n`);
  const sm = await probe(sitemapUrl, true);
  console.log(`  sitemap: ${describe(sm)}`);
  if (!sm.body) return;

  if (looksLikeSitemapIndex(sm.body)) {
    console.log(
      `\n  This is a sitemap INDEX — it lists other sitemaps, not articles.\n` +
        `  A news-sitemap source pointed here collects nothing. Probe one of the\n` +
        `  sitemaps it declares instead.\n`,
    );
    return;
  }

  const parsed = parseNewsSitemap(sm.body);
  const entries = parsed.map((e) => ({
    loc: e.url,
    title: e.title,
    date: e.publishedAt?.toISOString() ?? "",
  }));
  console.log(`  ${entries.length} entries parsed (production parseNewsSitemap)`);
  if (entries.length === 0) {
    console.log(
      `  Zero entries from a ${sm.bytes}-byte body is a parser result, not a\n` +
        `  publisher result — the collector would report this source as a clean\n` +
        `  empty. Report it as a failure.\n`,
    );
    return;
  }

  // What the collector would actually keep. A sitemap does not window itself,
  // so the gap between these two numbers is the daily re-collection the
  // preprocessor's cross-run dedup would otherwise absorb every day.
  for (const hours of [24, 48]) {
    console.log(`  within ${hours}h: ${withinWindow(parsed, hours).length}`);
  }
  const dated = parsed.filter((e) => e.publishedAt !== null);
  if (dated.length > 0) {
    const newest = dated[0]!.publishedAt!;
    const oldest = dated[dated.length - 1]!.publishedAt!;
    const span = (newest.getTime() - oldest.getTime()) / 3600_000;
    console.log(
      `  dated: ${dated.length}/${parsed.length}, spanning ${span.toFixed(1)}h ` +
        `(${oldest.toISOString()} → ${newest.toISOString()})`,
    );
  } else {
    console.log(
      `  dated: 0/${parsed.length} — every entry would survive any window, ` +
        `so max_age_hours buys nothing here.`,
    );
  }

  // The shape question, before the extraction question. A live blog is one URL
  // carrying every event of a running story — run #20's T1 lead was 45,000
  // characters of the whole Ukraine war — so a sitemap that is mostly /live/ is
  // a different proposition from one that is mostly /article/.
  const byShape = new Map<string, number>();
  for (const e of entries) {
    const seg = (() => {
      try {
        return new URL(e.loc).pathname.split("/").filter(Boolean)[0] ?? "(root)";
      } catch {
        return "(unparseable)";
      }
    })();
    byShape.set(seg, (byShape.get(seg) ?? 0) + 1);
  }
  console.log("\n  ── URL shape (first path segment)");
  for (const [seg, n] of [...byShape].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(5)}  /${seg}/  (${((n / entries.length) * 100).toFixed(0)}%)`);
  }

  // Sample across shapes rather than off the top, or a sitemap sorted by date
  // answers only for whatever the last hour happened to publish.
  const shapes = [...byShape.keys()];
  const sample: typeof entries = [];
  for (let i = 0; sample.length < limit && i < entries.length; i++) {
    for (const shape of shapes) {
      const found = entries.find(
        (e) => !sample.includes(e) && e.loc.includes(`/${shape}/`),
      );
      if (found && sample.length < limit) sample.push(found);
    }
    if (sample.length >= Math.min(limit, entries.length)) break;
  }

  console.log(`\n  ── extraction on ${sample.length} sampled article(s)\n`);
  let usable = 0;
  for (const e of sample) {
    await sleep(POLITE_DELAY_MS);
    const page = await probe(e.loc, true);
    if (!page.body || page.status === null || page.status >= 400) {
      console.log(`  FAIL  ${String(page.status ?? "ERR").padEnd(4)} ${e.loc.slice(0, 84)}`);
      console.log(`        ${page.note || `${page.bytes}b`}`);
      continue;
    }
    const extracted = extractArticle(page.body);
    const stripped = stripBoilerplate(extracted.text);
    const chars = stripped.text.length;
    if (chars >= 800) usable++;
    console.log(
      `  ${chars >= 800 ? "OK  " : "THIN"}  ${String(chars).padStart(6)}c  ` +
        `(page ${page.bytes}b) ${e.loc.slice(0, 74)}`,
    );
    console.log(`        feed title: ${e.title.slice(0, 88)}`);
    if (extracted.title) console.log(`        page title: ${extracted.title.slice(0, 88)}`);
    if (chars > 0) console.log(`        opens: ${stripped.text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  console.log(
    `\n  ${usable} of ${sample.length} extracted 800+ characters — ` +
      `the bar the fetch already uses for "usable".\n`,
  );
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
  } else if (flags["sitemap"] && flags["sitemap"] !== "true") {
    const limit = flags["limit"] ? parseInt(flags["limit"], 10) : 12;
    await probeSitemapExtraction(flags["sitemap"], limit);
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
  --sitemap <url> [--limit n] Parse a news sitemap, report the URL-shape mix,
                              then run a sample through the real extractor
                              (extractArticle + stripBoilerplate) and report the
                              characters a writer packet would carry.
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
