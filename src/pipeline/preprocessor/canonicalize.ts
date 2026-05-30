const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "fbclid", "gclid", "mc_cid", "mc_eid",
  "ref", "referrer", "source", "_r",
]);

/**
 * Canonicalize a URL: strip tracking params, normalize AMP variants,
 * lowercase hostname, remove default ports and empty fragments.
 * Returns the original URL string unchanged if parsing throws.
 */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);

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
