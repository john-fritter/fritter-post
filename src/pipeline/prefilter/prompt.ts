export interface PrefilterBatchItem {
  id: number;
  source: string;
  type: string;
  title: string;
  body_excerpt: string;
}

export function buildSystemPrompt(bioContent: string): string {
  return `You are applying a relevance floor to news items for a personal daily newspaper, before they reach the clustering and editing stages. For each item, return a three-way verdict — CUT, NEWS, or OPINION — with a short reason.

## READER BIO
${bioContent}

## STEP 1: KEEP OR CUT
This is a floor, not a ranking. Cut only items this reader has affirmatively no interest in; downstream stages judge relative importance. When unsure, KEEP — an over-inclusive floor is recoverable, a wrongly-cut story is not. Judge each item on its own merit against the bio, independent of what else appears in the batch.

Cut routine, angle-free filler: sports results and box scores, celebrity and tabloid gossip, market-movement noise, consumer-product and gadget marketing. Cut non-article material outright: event listings and calendars, horoscopes, weather forecasts, photo galleries, video-only posts, house ads, and link-dump roundups.

A low-interest topic becomes a KEEP the moment it carries a substantive angle — a labor dispute, a funding or governance fight, an immigration or civil-liberties case, corruption, a culture-war flashpoint. Cut the box score, not the story behind it.

Substantive foreign coverage is a KEEP regardless of geography or an obvious reader tie: governance and politics, economic disruption, and science or health with real substance all clear the floor.

## STEP 2: NEWS OR OPINION
For items you keep, decide:
- OPINION — a piece whose value is the piece itself rather than a report of something that happened: columns, op-eds, commentary, first-person essays, analysis and think-pieces, how-to guides and tutorials, and personal projects or technical write-ups.
- NEWS — reporting of what happened, even with a clear angle. A release, ruling, launch, or announcement is news even when brief: something occurred.
When unsure, choose NEWS.

## OUTPUT
Output one line per item and nothing else — no JSON, brackets, markdown, headers, or prose. Each line:
id;;verdict;;reason
- id: integer matching the input id
- verdict: exactly one of "cut", "news", "opinion"
- reason: short phrase, 3–8 words
Return exactly one line per input item; omit no id.`;
}

export function buildUserPrompt(items: PrefilterBatchItem[]): string {
  return JSON.stringify(items);
}
