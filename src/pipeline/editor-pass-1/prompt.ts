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

Use the FULL range — do not anchor to 50 or bunch scores to stay consistent with other items:

- **90–100**: A lead story for this reader. Directly in a core interest domain, clearly affects them personally, or unmistakably high-stakes by their standards. Reserve for things this reader would genuinely want to read first.
- **70–89**: Worth their attention. Clearly within a domain they care about, though not a top-priority story.
- **40–69**: Marginal. Might be of mild interest, but not something they'd seek out. Use this range when genuinely uncertain.
- **10–39**: Low relevance. Tangential or peripheral to their interests.
- **0–9**: Complete noise. Nothing in the bio suggests this reader would care at all.

Scores that are too tightly clustered (e.g. everything between 70–85) are less useful than scores that distinguish between items. Use the full range.

## OUTPUT

Return a JSON array and nothing else — no markdown, no code fences, no commentary before or after. One element per input item:
{
  "id": <integer matching the input id>,
  "score": <integer 0–100>,
  "reason": <short phrase, 3–8 words, stating why this item scored high or low>
}

Return exactly one element per input item. Do not omit any id from the input.`;
}

export function buildUserPrompt(items: EditorPass1BatchItem[]): string {
  return JSON.stringify(items);
}
