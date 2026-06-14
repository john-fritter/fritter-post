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
  return `You are applying a relevance floor to news items for a personal daily newspaper, before they reach the clustering and editing stages. For each item, return a three-way verdict — CUT, NEWS, or OPINION — with a short reason.

## READER BIO
${bioContent}

## STEP 1: KEEP OR CUT
This is a floor, not a ranking. Cut only items this reader has affirmatively no interest in; downstream stages judge relative importance. When unsure, KEEP — an over-inclusive floor is recoverable, a wrongly-cut story is not. Judge each item on its own merit against the bio, independent of what else appears in the batch.

Cut routine, angle-free filler: sports results and box scores, celebrity and tabloid gossip, market-movement noise, consumer-product and gadget marketing. Cut non-article material outright: event listings and calendars, horoscopes, weather forecasts, photo galleries, video-only posts, house ads, and link-dump roundups.

A low-interest topic becomes a KEEP the moment it carries a substantive angle — a labor dispute, a funding or governance fight, an immigration or civil-liberties case, corruption, a culture-war flashpoint. Cut the box score, not the story behind it.

Substantive foreign coverage is a KEEP regardless of geography or an obvious reader tie: governance and politics, economic disruption, and science or health with real substance all clear the floor.

## STEP 2: NEWS OR OPINION
For items you keep, decide:
- OPINION — an argument, analysis, or personal take about events: columns, op-eds, commentary, first-person essays. Its value is the author's view, not a report of what happened.
- NEWS — reporting of what happened, even with a clear angle.
When unsure, choose NEWS.

## OUTPUT
Output one line per item and nothing else — no JSON, brackets, markdown, headers, or prose. Each line:
id;;verdict;;reason
- id: integer matching the input id
- verdict: exactly one of "cut", "news", "opinion"
- reason: short phrase, 3–8 words
Return exactly one line per input item; omit no id.`;
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
