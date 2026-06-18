/**
 * Pure helpers for preprocessor dedup steps — extracted for testability
 * without a database connection or dotenv side-effects.
 */

export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

export function buildCrossRunKeys(
  rows: Array<{ source_name: string; canonical_url: string; title: string }>,
  getParent: (sourceName: string) => string,
): { urlKeys: Set<string>; titleKeys: Set<string> } {
  const urlKeys = new Set<string>();
  const titleKeys = new Set<string>();
  for (const h of rows) {
    const parent = getParent(h.source_name);
    urlKeys.add(`${h.source_name}::${h.canonical_url}`);
    urlKeys.add(`${parent}::${h.canonical_url}`);
    const nt = normalizeTitle(h.title);
    if (nt.length >= 30) titleKeys.add(`${parent}::${nt}`);
  }
  return { urlKeys, titleKeys };
}

export function isCrossRunDuplicate(
  item: { sourceName: string; canonicalUrl: string; title: string },
  keys: { urlKeys: Set<string>; titleKeys: Set<string> },
  getParent: (sourceName: string) => string,
): boolean {
  const parent = getParent(item.sourceName);
  const nt = normalizeTitle(item.title);
  return (
    keys.urlKeys.has(`${item.sourceName}::${item.canonicalUrl}`) ||
    keys.urlKeys.has(`${parent}::${item.canonicalUrl}`) ||
    (nt.length >= 30 && keys.titleKeys.has(`${parent}::${nt}`))
  );
}
