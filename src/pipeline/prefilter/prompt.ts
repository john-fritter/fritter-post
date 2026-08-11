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

Cut routine, angle-free filler: sports results and box scores, celebrity and tabloid gossip, market-movement noise, consumer-product and gadget marketing. Cut non-article material outright: event listings and calendars, horoscopes, weather forecasts, photo galleries, video-only posts, and house ads.

**CUT every digest, without exception.** A digest is an item that indexes other people's stories instead of reporting one: daily roundups and link dumps, "here's today's news" briefings, newsletter editions, "what we're reading", "the download", morning and evening briefings, and any item whose title is just a date. This paper exists to do that job itself, so a competing roundup is never useful to this reader no matter how good its contents are.

Judge this on SHAPE, not on topic. A digest's body is a dense list of many unrelated stories, so it will look *more* relevant than any single article — several of the reader's core interests will appear in the first few lines, often under shouted section headers or separated into short unlinked paragraphs. That density is the tell, not a reason to keep it. If the excerpt reads like a table of contents, an inbox pitch, or a run of headlines rather than one story with one subject, cut it.

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
