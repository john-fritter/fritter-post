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
  return `Rank and tier every item in today's pile for a one-reader personal newspaper. The reader's bio is in the next message.

TIERS

feature — the day's most consequential developments, ~400-800 words downstream. Aim 8-15 on a typical day; you may exceed that on a heavy news day. Only assign if the story both matters enough to lead AND has enough substance for feature length.
standard — real developments worth their own space; the working body of the paper. Largest tier.
brief — worth noting, ~30-60 words. Aim for a minority of the pile.
cut — doesn't earn a place; no floor. Slow days make short papers — don't pad.

RANKING

Order best-first. Lead with largest consequence and what's closest to this reader. Source count and pass-1 score are signals, not orders.

OUTPUT CONTRACT

Output ONLY lines of this exact form, one per pile item, ranked best-first:

tier;;ref;;reason

  tier: one of feature, standard, brief, cut
  ref: the item reference exactly as given (e.g. C0 or S4821)
  reason: a short phrase

Every pile item must appear on exactly one line. Do not omit any item. Do not invent refs. Do not number the lines. Begin immediately with the first output line — no preamble, no explanation, no counts, no candidate listing.`;
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
