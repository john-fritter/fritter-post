/**
 * Pure helpers for preprocessor dedup steps — extracted for testability
 * without a database connection or dotenv side-effects.
 */

export function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Keys describing what recent runs already processed.
 *
 * URL keys are scoped to the source and its parent: a canonical URL identifies
 * one publisher's article, so an outlet-scoped key is what it means.
 *
 * **Title keys are deliberately NOT scoped to an outlet, and that is the whole
 * point of them.** A normalized title of 30 characters or more, arriving again
 * within the lookback window, is the same article — whoever is carrying it.
 * Scoping the key to the parent asked "did *this outlet* already run this
 * headline", which is a question syndication answers no to every time.
 *
 * The 2026-09-03 repeated-headline report is the evidence. Its nine confirmed
 * cross-edition repeats were all exact normalized-title matches, all inside the
 * existing lookback, and all from a *different* parent the second time:
 * NPR → OPB four times over (the Iran six-month analysis, Leipzig, the OpenAI
 * lawsuits, the ICE detainee death), Oregon Capital Chronicle → OPB and → The
 * Bend Bulletin, The Guardian US → Grist, Wired → Ars Technica. Every one of
 * them passed this filter and was published a second time as a new story. The
 * lookback window was never the binding constraint; the scoping was.
 *
 * This widens the CROSS-RUN key only. The within-run parent dedup in
 * index.ts stays outlet-scoped, because two outlets carrying one story on one
 * day is prominence — it is what the editor's `ln(sources)` lift reads, and
 * collapsing it would delete the corroboration a cluster exists to show. The
 * same headline five days later is not pickup; it is a straggler.
 *
 * Suppressing the later copy is the right outcome even when a real story is
 * still moving underneath it. The report's Leipzig cluster also carried Meduza
 * and BBC reporting on 9/3, so it survives the loss of the day-old OPB copy and
 * gets written from what is new, rather than anchored on what already ran.
 *
 * URL keys are left outlet-scoped rather than widened alongside: no case in the
 * report turned on a URL, and this project's rule is that dedup rules accrete
 * from audit evidence rather than from symmetry.
 */
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
    if (nt.length >= 30) titleKeys.add(nt);
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
    (nt.length >= 30 && keys.titleKeys.has(nt))
  );
}
