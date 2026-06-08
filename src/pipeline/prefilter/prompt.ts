export interface PrefilterBatchItem {
  id: number;
  source: string;
  type: string;
  title: string;
  body_excerpt: string;
}

export function buildSystemPrompt(bioContent: string): string {
  return `You are applying a relevance floor to news items for a personal daily newspaper, before they reach the clustering and editing stages. For each item, decide CUT, NEWS, or OPINION — a three-way verdict — and give a short reason.

## READER BIO

${bioContent}

## STEP 1: KEEP OR CUT (the relevance floor)

This is a FLOOR, not a ranking. Your job is to strip out items the reader has AFFIRMATIVELY NO INTEREST IN — not to judge how interesting something is. Downstream stages handle relative importance; you are only removing the obvious noise so they aren't spending their attention on it.

Be CONSERVATIVE. Cut only what the bio makes clear this reader does not care about: routine sports results and box scores with no other angle, celebrity gossip and tabloid items, routine market-movement noise, generic consumer-product/gadget marketing, and similar filler. When you are unsure, KEEP — an over-inclusive floor is recoverable downstream; a wrongly-cut story is gone for good.

Judge each item on its OWN MERIT against the bio — NOT relative to the other items shown in this batch. Your verdict for an item must be the same regardless of what else appears alongside it in the request.

Critically: a low-interest topic is a KEEP the moment it carries a substantive angle this reader cares about. A sports story about a labor dispute, a stadium-funding political fight, an immigration angle on an athlete, or a civil-liberties case is a KEEP — it is not "sports," it is the angle. Likewise celebrity/entertainment items that cross into politics, law, corruption, or culture-war flashpoints are KEEPs. Only cut the routine, angle-free version of these — the box score, the red-carpet photo, the daily ticker move.

## STEP 2: FOR ITEMS YOU KEEP — NEWS OR OPINION

Among the items you keep, decide whether each is NEWS or OPINION:

- OPINION = an argument, analysis, or personal take ABOUT events — columns, op-eds, commentary, personal essays, first-person "here's my experience" pieces, blog-style reflections. The piece's value is the author's view, not a report of something that happened.
- NEWS = reporting of what happened, even if it has a clear angle.

CONSERVATIVE DEFAULT: when genuinely unsure between news and opinion, choose NEWS.

## OUTPUT

Output ONE LINE PER ITEM and nothing else — no JSON, no brackets, no markdown fence, no header, no prose before or after. Each line must be:

id;;verdict;;reason

- id: integer matching the input id
- verdict: exactly one of "cut", "news", or "opinion"
  - "cut" — drop the item (Step 1)
  - "news" — keep, reporting of what happened (Step 1 keep + Step 2 news)
  - "opinion" — keep, but an argument/analysis/personal take about events (Step 1 keep + Step 2 opinion)
- reason: short phrase, 3–8 words, stating why

Return exactly one line per input item. Do not omit any id from the input.`;
}

export function buildUserPrompt(items: PrefilterBatchItem[]): string {
  return JSON.stringify(items);
}
