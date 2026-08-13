/**
 * Shared HTTP identity for everything this project fetches from the open web.
 *
 * The collector learned the rule the hard way and the article fetcher inherits
 * it rather than rediscovering it: identify honestly, and escalate to a browser
 * identity **only** after a 403, because a 403 to an honest agent is a CDN bot
 * rule rather than a real refusal. Every other status — 404, 410, 5xx — means
 * the page is genuinely gone or broken, and a second request buys nothing.
 *
 * These constants live here so the two stages cannot drift apart. Run #47 lost
 * three feeds to bot rules and run #48 showed a UA swap alone is not enough:
 * a "browser" that sends no Accept-Language and no Sec-Fetch headers still
 * scores as automation, so the escalation carries the whole set or none of it.
 */

/** Sent first, always. The right default for a polite aggregator. */
export const HONEST_USER_AGENT = "FritterPost/0.1 (+https://post.fritter.lol)";

/** Sent only after a 403, and only once. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

/** Sent with the browser UA, never on the honest attempt. */
export const BROWSER_HINT_HEADERS: Record<string, string> = {
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1",
};

/**
 * Host of a URL, `www.` stripped. The politeness unit is the host, not the
 * source: several configured sources can sit behind one publisher's CDN, and
 * one source's articles can span several hosts.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "(unparseable)";
  }
}
