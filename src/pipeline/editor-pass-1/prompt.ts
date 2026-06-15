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

Use the FULL range. The score blends two things: how much this reader cares about the subject (from the bio) AND how much actually happened — a real event, decision, or development versus a static situation, a hobby project, or a headline that sounds bigger than it is. A topic he loves where nothing has happened is not a top story.

- **90–100**: A major story he'd want to read first. Squarely in a core interest AND a real, high-stakes development — a war turning, a major ruling, a crisis that affects him or his world directly.
- **75–89**: Strong. Clearly in a domain he cares about and something genuinely happened, but not the day's lead.
- **60–74**: Solid. A real development he'd want to know about, or a high-interest item where less is at stake (a tool release, an industry move, a story he'd click but isn't important).
- **45–59**: Middling. Touches his interests but is minor, static, or a sounds-big-but-little-happened headline. Most items land here.
- **25–44**: Weak. Tangential to his interests, or interesting-sounding but inconsequential.
- **10–24**: Low. Barely connected to anything in the bio.
- **0–9**: Noise. Nothing suggests he'd care.

## OUTPUT
Output ONE LINE PER ITEM and nothing else — no JSON, no brackets, no markdown fence, no header, no prose before or after. Each line must be:
id;;score;;reason
- id: integer matching the input id
- score: integer (0-100)
- reason: short phrase.  Do not refer to the readers by name.

Return exactly one line per input item. Do not omit any id from the input.`;
}

export function buildUserPrompt(items: EditorPass1BatchItem[]): string {
  return JSON.stringify(items);
}
