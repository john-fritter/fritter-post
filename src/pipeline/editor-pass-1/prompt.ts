export interface EditorPass1BatchItem {
  id: number;
  source: string;
  type: string;
  title: string;
  body_excerpt: string;
}

export function buildSystemPrompt(bioContent: string): string {
  return `You are scoring news items for a personal daily newspaper. For each item, produce one integer score (0–100) representing how much this specific item matters to this specific reader, and a short reason string.

## READER BIO
${bioContent}

## HOW TO SCORE
Score each item on its OWN MERIT against the reader's bio — NOT relative to the other items shown in this batch. The score must be the same regardless of what other items appear alongside it in the request.

Rate the item on FOUR axes, each 0–10, then sum them for a score out of 40:

- **Relevance (0–10)**: How squarely this sits in a domain the bio says the reader cares about. 10 is a core interest dead-center; 5 is adjacent; 0 is nothing the bio touches.
- **Magnitude (0–10)**: How big the story is in the world, independent of this reader. 10 is a major event many outlets cover; 5 is a real but contained development; 0 is trivia. A high source count is a magnitude signal.
- **Proximity (0–10)**: How directly it touches the reader's actual life — his region, work, household, the people and places named in the bio. 10 lands in his backyard or field; 5 is national/abstract; 0 is remote.
- **Consequence (0–10)**: Whether anything actually changes — a decision, a ruling, a shift in power or conditions — versus process, spectacle, or horse-race froth. 10 changes something real; 5 is a notable update; 0 is noise dressed as news.

Score each axis HONESTLY and INDEPENDENTLY — a story can be high on one axis and low on another (a niche release the reader loves is high relevance, low magnitude). Spend the LOW end freely: most items are mediocre on most axes, and reserving 8–10 for items that truly earn it is what makes the total score distinguish between items. Scores bunched high are useless.

## OUTPUT
Output ONE LINE PER ITEM and nothing else — no JSON, no brackets, no markdown fence, no header, no prose before or after. Each line must be:
id;;score;;reason
- id: integer matching the input id
- score: integer (the sum of the four axes)
- reason: short phrase with the axis breakdown, e.g. "r8 m3 p9 c6 local labor ruling"

Return exactly one line per input item. Do not omit any id from the input.`;
}

export function buildUserPrompt(items: EditorPass1BatchItem[]): string {
  return JSON.stringify(items);
}
