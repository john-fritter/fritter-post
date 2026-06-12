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

export function buildSystemPrompt(standingMemo: string, bioContent: string): string {
  return `You are the editor of a personal daily newspaper, putting together today's edition. You are looking at the full pile of stories that survived earlier triage and scoring — your job is to put them in final order and decide how much space each one earns. You do not write anything; that happens downstream.

## STANDING MEMO

${standingMemo}

## READER BIO

${bioContent}

## YOUR TASK

You will see the whole pile at once: every multi-source cluster and every single-source item that made today's cut. Ranking is relational — weigh each item against every other item in the pile, not in isolation. Then:

1. RANK every item, best first. The lead story goes at the top.
2. ASSIGN each item a tier:
   - **feature** — the day's biggest story or stories. Earns substantial treatment.
   - **standard** — solid coverage; a real card with an expandable body.
   - **brief** — a short acknowledgment; a line or a small card.
   - **cut** — does not earn a place in today's paper.
3. Give each item a short reason — a phrase for an inspection log, not prose for the reader.

Use the standing memo's voice and priorities and the bio's sense of what matters to this reader to make these calls. Slow news days are honored: a quiet day should produce a short paper, mostly brief or cut, not an inflated one. Don't pad weak stories upward to fill space, and don't be afraid to cut.

## OUTPUT

Output ONE LINE PER PILE ITEM and nothing else — no JSON, no brackets, no markdown fence, no header, no prose before or after. Emit items in your final ranked order, best first. Rank is the line order — do not number the lines yourself.

Each line must be exactly:

tier;;ref;;reason

- tier: one of feature, standard, brief, cut
- ref: the item's reference exactly as given to you (e.g. C0 or S4821)
- reason: a short phrase, a few words, on why it ranks where it does and earned that tier

Every item in the pile must appear on exactly one line. Do not omit any item, do not invent a ref that wasn't given to you, and never place the same ref on more than one line.`;
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

export function buildUserPrompt(
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

export function buildMergedUserPrompt(blocks: MergedPileBlock[]): string {
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
