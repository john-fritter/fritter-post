export interface EditorClusterPileItem {
  ref: string; // C{cluster_index}
  clusterIndex: number | null;
  title: string;
  summary: string;
  notes: string | null;
  sourceCount: number;
}

export interface EditorSingletonPileItem {
  ref: string; // S{preprocessed_item_id}
  preprocessedItemId: number;
  title: string;
  bodyExcerpt: string;
  pass1Score: number;
  pass1Reason: string;
}

// Static task spec: rank/tier every pile item for a one-reader newspaper.
// Bio and pile travel in the user message (see buildUserPrompt).
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
function formatCluster(item: EditorClusterPileItem): string {
  const lines = [
    `[${item.ref}] ${item.title} — ${item.sourceCount} source${item.sourceCount === 1 ? "" : "s"}`,
    item.summary,
  ];
  if (item.notes) lines.push(`Notes: ${item.notes}`);
  return lines.join("\n");
}

function formatSingleton(item: EditorSingletonPileItem): string {
  return [
    `[${item.ref}] ${item.title} — pass-1 score ${item.pass1Score} (${item.pass1Reason})`,
    item.bodyExcerpt,
  ].join("\n");
}

function buildPileSection(
  clusters: EditorClusterPileItem[],
  singletons: EditorSingletonPileItem[],
): string {
  const total = clusters.length + singletons.length;
  const sections: string[] = [
    `Today's pile: ${total} item${total === 1 ? "" : "s"} — ` +
      `${clusters.length} cluster${clusters.length === 1 ? "" : "s"} (multi-source stories) and ` +
      `${singletons.length} singleton${singletons.length === 1 ? "" : "s"} (single-source items). ` +
      `Rank and tier all ${total} of them.`,
  ];

  if (clusters.length > 0) {
    sections.push(
      [`## CLUSTERS (ordered by source count, descending)`, ...clusters.map(formatCluster)].join("\n\n"),
    );
  }

  if (singletons.length > 0) {
    sections.push(
      [`## SINGLETONS (ordered by pass-1 score, descending)`, ...singletons.map(formatSingleton)].join(
        "\n\n",
      ),
    );
  }

  return sections.join("\n\n");
}

export function buildUserPrompt(
  clusters: EditorClusterPileItem[],
  singletons: EditorSingletonPileItem[],
  bio: string,
): string {
  return `The reader:\n\n${bio}\n\n---\n\n${buildPileSection(clusters, singletons)}`;
}
