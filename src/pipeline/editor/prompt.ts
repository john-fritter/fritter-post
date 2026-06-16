// A single pile entry as presented to the editor: just what tiering needs —
// the headline, its ref, the grouping-pass-1 relevance score, and how many
// sources are covering it. No summaries, body excerpts, or notes: the editor
// no longer ranks, so it doesn't need the heavier context the scorer used.
export interface EditorPileEntry {
  ref: string; // C{cluster_index} or S{preprocessed_item_id}
  title: string;
  score: number; // grouping-pass-1 relevance score, 0–100
  sourceCount: number; // cluster member count; 1 for a singleton
}

// Static task spec: tier each pile item for a one-reader newspaper, in the
// order given. The pile arrives pre-ranked (score descending); the editor does
// not reorder. No bio in the prompt — tiering reads off score + sources alone.
export function buildSystemPrompt(): string {
  return `You are an editor for a personal daily newspaper, deciding how much space each of today's stories earns.

The pile has already been ranked — it is handed to you in final order, best first, top to bottom. Do NOT reorder it. Your only job is to assign each item a tier. Keep the items in the order given and tier each one where it sits.

Each item comes with two signals:
- **score** (0–100): how much this reader cares about the subject.
- **sources**: how many outlets are covering it — a proxy for how big the story is in the world.

Tier reflects how much treatment a story earns. Score tells you interest; sources and the nature of the story tell you magnitude. Weigh both.

Assign each item one tier:
- **feature** — a major story of the day, earns substantial treatment. Aim for 8–15 on a typical day.
- **standard** — a real development worth its own space. The working body of the paper, the largest tier.
- **brief** — worth a line or a small card: real but small, or high-interest but low-magnitude.
- **cut** — does not earn a place today. Cut only items of genuinely no interest; when unsure, keep as brief.

OUTPUT CONTRACT:
Output ONLY lines of this exact form, one per pile item, in the order the items were given:
tier;;ref;;reason
  tier: one of feature, standard, brief, cut
  ref: the item reference exactly as given (e.g. C0 or S4821)
  reason: a short phrase for an inspection log
Every pile item must appear on exactly one line. Do not omit any item. Do not number the lines. Begin immediately with the first output line — no preamble, no explanation, no counts.`;
}

function formatEntry(item: EditorPileEntry): string {
  return (
    `[${item.ref}] ${item.title} — score ${item.score}, ` +
    `${item.sourceCount} source${item.sourceCount === 1 ? "" : "s"}`
  );
}

export function buildUserPrompt(entries: EditorPileEntry[]): string {
  const total = entries.length;
  const header =
    `Today's pile: ${total} item${total === 1 ? "" : "s"}, already ranked best-first ` +
    `(highest score at the top). Assign each one a tier, in this order — do not reorder.`;
  return [header, "", ...entries.map(formatEntry)].join("\n");
}
