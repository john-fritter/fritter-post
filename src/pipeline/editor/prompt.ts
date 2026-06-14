export interface EditorClusterPileItem {
  ref: string; // C{cluster_index}
  clusterIndex: number | null; // null for merged-singleton clusters with no digest index
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
// Bio and pile travel in the user message (see buildUserPrompt / buildMergedUserPrompt).
export function buildSystemPrompt(): string {
  return `You are an editor for a personal daily newspaper, putting together today's edition. You are looking at the full pile of stories that survived earlier filtering and scoring — your job is to put them in final order and decide how much space each one earns.

You will see the whole pile at once: every multi-source cluster and every single-source item that made today's cut. Ranking is relational — weigh each item against every other item in the pile, not in isolation. Then:

1. RANK every item, best first. The lead story goes at the top.
2. ASSIGN each item a tier:
   - **feature** — the day's biggest story or stories. Earns substantial treatment. Aim 8-15 on a typical day; you may exceed that on a heavy news day.
   - **standard** — real developments worth their own space; the working body of the paper. Largest tier.
   - **brief** — a short acknowledgment; a line or a small card. Aim for a minority of the pile.
3. Give each item a short reason — a phrase for an inspection log, not prose for the reader.

OUTPUT CONTRACT:

Output ONLY lines of this exact form, one per pile item, ranked best-first:

tier;;ref;;reason

  tier: one of feature, standard, brief
  ref: the item reference exactly as given (e.g. C0 or S4821)
  reason: a short phrase

Every pile item must appear on exactly one line. Do not omit any item. Do not number the lines. Begin immediately with the first output line — no preamble, no explanation, no counts, no candidate listing.`;
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

// Used by the editor when pile_merge_run_id is set on the pile: the merged
// pile's entries replace the normal cluster + singleton resolution. Entries
// with a non-empty summary are shown as clusters (multi-source); entries with
// a non-empty excerpt (and empty summary) are shown as singletons.
export interface MergedPileBlock {
  ref: string;
  title: string;
  summary: string; // non-empty for clusters and merged entries
  excerpt: string; // non-empty for unmerged singletons only
  itemCount: number;
  pass1Score: number | null;
  pass1Reason: string | null;
}

function formatMergedCluster(block: MergedPileBlock): string {
  return (
    `[${block.ref}] ${block.title} — ` +
    `${block.itemCount} source${block.itemCount === 1 ? "" : "s"}\n${block.summary}`
  );
}

function formatMergedSingleton(block: MergedPileBlock): string {
  const scoreStr =
    block.pass1Score !== null ? ` — pass-1 score ${block.pass1Score} (${block.pass1Reason ?? ""})` : "";
  return `[${block.ref}] ${block.title}${scoreStr}\n${block.excerpt}`;
}

function buildMergedPileSection(blocks: MergedPileBlock[]): string {
  const clusterBlocks = blocks.filter((b) => b.summary.length > 0);
  const singletonBlocks = blocks.filter((b) => b.summary.length === 0);
  const total = blocks.length;

  const sections: string[] = [
    `Today's pile: ${total} item${total === 1 ? "" : "s"} — ` +
      `${clusterBlocks.length} cluster${clusterBlocks.length === 1 ? "" : "s"} (multi-source stories) and ` +
      `${singletonBlocks.length} singleton${singletonBlocks.length === 1 ? "" : "s"} (single-source items). ` +
      `Rank and tier all ${total} of them.`,
  ];

  if (clusterBlocks.length > 0) {
    sections.push(
      [
        "## CLUSTERS (ordered by source count, descending)",
        ...clusterBlocks.map(formatMergedCluster),
      ].join("\n\n"),
    );
  }

  if (singletonBlocks.length > 0) {
    sections.push(
      [
        "## SINGLETONS (ordered by pass-1 score, descending)",
        ...singletonBlocks.map(formatMergedSingleton),
      ].join("\n\n"),
    );
  }

  return sections.join("\n\n");
}

export function buildMergedUserPrompt(blocks: MergedPileBlock[], bio: string): string {
  return `The reader:\n\n${bio}\n\n---\n\n${buildMergedPileSection(blocks)}`;
}
