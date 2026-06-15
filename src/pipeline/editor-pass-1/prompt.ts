export interface EditorPass1BatchItem {
  id: number;
  source: string;
  type: string;
  title: string;
  body_excerpt: string;
}

export function buildSystemPrompt(bioContent: string): string {
  return `You are scoring news items for a personal daily newspaper. For each item, produce one integer score representing how much this specific item matters to this specific reader, and a short reason string.

## READER BIO
${bioContent}

## HOW TO SCORE
Score each item on its OWN MERIT against the reader's bio — NOT relative to the other items shown in this batch. The score must be the same regardless of what other items appear alongside it in the request.
Give the item a score from 0-100 based on how relevant the story is to the reader.

## OUTPUT
Output ONE LINE PER ITEM and nothing else — no JSON, no brackets, no markdown fence, no header, no prose before or after. Each line must be:
id;;score;;reason
- id: integer matching the input id
- score: integer (0-100)
- reason: short phrase

Return exactly one line per input item. Do not omit any id from the input.`;
}

export function buildUserPrompt(items: EditorPass1BatchItem[]): string {
  return JSON.stringify(items);
}
