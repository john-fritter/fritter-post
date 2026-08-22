const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "fbclid", "gclid", "mc_cid", "mc_eid",
  "ref", "referrer", "source", "_r",
]);

/**
 * Unwraps a redirector that carries its destination in the URL itself.
 *
 * Folha's feed publishes every item as
 * `https://redir.folha.com.br/redir/online/…/rss091/*https://www1.folha.uol.com.br/…`,
 * and the wrapper was stored as the canonical URL, so the fetch went to the
 * redirector, the host was recorded as redir.folha.com.br, and 42 of run #118's
 * article rows shared a host that is not a publisher. Cooldown is learned per
 * host, so one wrapper's failures also stood in for the outlet's.
 *
 * The rule is the shape, not the outlet: an absolute `http(s)://` embedded in the
 * **path**, which is a wrapper carrying its destination. Query strings are
 * deliberately excluded — `…/article?ref=https://other.example` is one outlet's
 * article with a referrer on it, not a redirect to another, and unwrapping it
 * would replace the story with whatever the parameter pointed at.
 *
 * Deliberately does **not** try to decode Google News, whose `/rss/articles/CBMi…`
 * token is an opaque identifier with no URL in it. There is nothing to unwrap, so
 * those stay as they are.
 */
export function unwrapRedirect(url: string): string {
  try {
    const outer = new URL(url);
    const match = outer.pathname.match(/.(https?:\/\/.+)$/);
    if (!match) return url;
    const inner = match[1]!;
    new URL(inner);
    return inner;
  } catch {
    return url;
  }
}

/**
 * Canonicalize a URL: unwrap redirectors, strip tracking params, normalize AMP
 * variants, lowercase hostname, remove default ports and empty fragments.
 * Returns the original URL string unchanged if parsing throws.
 */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(unwrapRedirect(url));

    // Lowercase hostname and strip default ports.
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") ||
        (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }

    // AMP subdomain: amp.example.com → www.example.com (or example.com)
    if (u.hostname.startsWith("amp.")) {
      const base = u.hostname.slice(4); // strip "amp."
      u.hostname = base.includes(".") ? `www.${base}` : base;
    }

    // AMP path prefix: /amp/path → /path
    if (u.pathname.startsWith("/amp/")) {
      u.pathname = u.pathname.slice(4); // keep leading slash on the remainder
    }
    // AMP path suffix: /article/amp → /article
    if (u.pathname.endsWith("/amp")) {
      u.pathname = u.pathname.slice(0, -4);
    }
    // Trailing slash normalisation not applied — too many sites are slash-sensitive.

    // Strip tracking query parameters.
    for (const key of TRACKING_PARAMS) {
      u.searchParams.delete(key);
    }

    // Remove empty fragment.
    if (u.hash === "#") {
      u.hash = "";
    }

    return u.toString();
  } catch {
    return url;
  }
}
