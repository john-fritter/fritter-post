/**
 * Google News link resolution: aggregator interstitial → publisher article.
 *
 * **Why this matters more than any other source question.** AP Top News is the
 * single largest contributor of material to the paper — 250 items reached editor
 * runs over the 14-day window ending 2026-08-25, ahead of OPB and SCMP — and its
 * usable rate is **0%**. Every one of those is a headline, because the feed's
 * links are `news.google.com/rss/articles/CBMi…` interstitials rather than
 * articles, and `sources.yaml` records AP as having no working direct feed.
 *
 * There is a real apnews.com article behind every one of those links. The
 * question this module exists to answer is how to reach it.
 *
 * `canonicalizeUrl` deliberately does not try: its rule is an absolute URL
 * embedded in the *path*, and it documents the Google News token as "an opaque
 * identifier with no URL in it". That claim was never tested — it is an
 * assumption about an encoding Google has changed at least twice — and
 * `decodeGoogleNewsToken` is the test. Older tokens are base64url-encoded
 * protobuf with the target URL in clear text inside them; newer ones are not.
 * Which era a given feed serves is an empirical question, and
 * `scripts/probe-source.ts` asks it against real rows.
 *
 * Pure and offline, so it is unit-testable and costs nothing to try before any
 * network strategy runs.
 *
 * **What the 2026-08-25 probe settled.** Over 52 real links from AP Top News, AP
 * Politics and Willamette Week: `decodeGoogleNewsToken` resolved 0, following
 * redirects resolved 0, and the interstitial is a 580KB JavaScript shell with no
 * publisher URL anywhere in it. `canonicalizeUrl`'s comment turns out to be
 * right about the current encoding, and Google News resolution is a dead end for
 * these feeds. The decoder stays because it is free, offline and correct for the
 * older encoding some feeds still serve — but AP's article text has to come from
 * somewhere else, and `apnews.com/news-sitemap-content.xml` is that somewhere.
 */

/** A `news.google.com` article or read link, whatever the surrounding query. */
export function isGoogleNewsLink(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname.replace(/^www\./, "") !== "news.google.com") return false;
    return /^\/(?:rss\/)?(?:articles|read)\//.test(u.pathname);
  } catch {
    return false;
  }
}

/** The opaque path segment: the bit after /articles/ or /read/, minus any suffix. */
export function googleNewsToken(url: string): string | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/(?:rss\/)?(?:articles|read)\/([^/?#]+)/);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Pulls the publisher URL out of the token, when the token still contains one.
 *
 * **Read the length prefix; do not pattern-match the URL.** The token is
 * base64url of protobuf, whose length-delimited fields are a tag byte, a varint
 * length, then the bytes. A regex over the decoded buffer looks like it works
 * and quietly runs one byte long: the field after the URL is tagged `\x32`,
 * which is ASCII `"2"`, so `https://apnews.com/article/…-8f2a1c` comes back as
 * `…-8f2a1c2` — a URL that parses, resolves to a 404, and would teach the host
 * cooldown against apnews.com for a fault entirely our own. The length prefix
 * says where the field ends, so use it.
 *
 * Any wire-type-2 field is considered, not one hardcoded tag number: field
 * numbering is Google's to change and the URL's shape is not.
 *
 * Returns null when the token carries no URL, which is the expected answer for
 * Google's newer encoding. **A null here is not a failure**: it is the signal to
 * try a network strategy, and the reason this runs first is that it is free.
 */
export function decodeGoogleNewsToken(url: string): string | null {
  const token = googleNewsToken(url);
  if (token === null) return null;

  // Tolerate missing padding and the URL-safe alphabet.
  const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

  let buf: Buffer;
  try {
    buf = Buffer.from(padded, "base64");
  } catch {
    return null;
  }

  for (let i = 0; i < buf.length; i++) {
    // Wire type 2 is length-delimited: the only kind that can hold a string.
    if ((buf[i]! & 0x07) !== 2) continue;

    // Varint length, little-endian groups of seven bits.
    let length = 0;
    let shift = 0;
    let j = i + 1;
    let complete = false;
    while (j < buf.length && shift <= 28) {
      const byte = buf[j]!;
      length |= (byte & 0x7f) << shift;
      j++;
      if ((byte & 0x80) === 0) {
        complete = true;
        break;
      }
      shift += 7;
    }
    if (!complete || length <= 0 || j + length > buf.length) continue;

    const value = buf.toString("latin1", j, j + length);
    if (!/^https?:\/\//.test(value)) continue;

    try {
      const parsed = new URL(value);
      // A token that decodes to another aggregator link has told us nothing.
      if (parsed.hostname.replace(/^www\./, "") === "news.google.com") return null;
      return value;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Hosts that serve Google's own assets rather than anybody's article.
 *
 * `googleusercontent.com` is the one that matters and the one the first version
 * of this list missed. Every AP and Willamette Week interstitial embeds a
 * publisher logo served from `lh3.googleusercontent.com`, so a resolver that
 * takes "the first absolute URL that is not google.com" takes the logo. The
 * 2026-08-25 probe reported 52 of 52 links resolved and every single one was
 * the same 676-byte PNG.
 */
const GOOGLE_ASSET_HOSTS = [
  "google.com",
  "googleusercontent.com",
  "gstatic.com",
  "googleapis.com",
  "googletagmanager.com",
  "google-analytics.com",
  "youtube.com",
  "ggpht.com",
];

/** Extensions that are an asset, not a story. */
const ASSET_EXTENSIONS =
  /\.(?:png|jpe?g|gif|webp|svg|ico|css|js|mjs|woff2?|ttf|eot|mp4|webm|mp3|pdf|json|xml)$/i;

/**
 * Is this plausibly a publisher's article page?
 *
 * **A resolver that reports an unverified success is worse than one that
 * reports nothing**, because a wrong URL sends the fetch to another page
 * entirely and teaches the host cooldown against a host that never refused us.
 * So the bar is deliberately high: a real host that is not Google's, a path
 * with something in it, and not an asset.
 *
 * This is necessary and not sufficient — the caller still has to verify the
 * destination is the *right* article, which is what title matching is for.
 */
export function looksLikeArticleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  if (host === "news.google.com") return false;
  if (GOOGLE_ASSET_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return false;

  // A bare origin is a homepage, not a story.
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path.length <= 1) return false;
  if (ASSET_EXTENSIONS.test(path)) return false;

  return true;
}
