/**
 * Story materials resolver for the writers stage.
 *
 * The editor's output names 150 stories by ref — `T0`, `C25`, `S52283` — and
 * nothing downstream of it walks those refs back to the articles they stand
 * for. Every earlier stage needed only one level of that walk: pass-1 scores a
 * cluster on its describe summary, the thread pass reads member titles, the
 * editor ranks on numbers. The writers need the leaves.
 *
 * The walk is three-deep and each level is stored somewhere different:
 *
 *   thread  → thread_members  → cluster → grouping_runs.digest → items
 *                             → singleton                      → item
 *   cluster → grouping_runs.digest → items
 *   singleton → item
 *
 * This module does that walk and nothing else. It does not fetch, cap, dedup,
 * or format — the assembler owns all four, and keeping them out of here is what
 * lets the assembler be a pure function over this output.
 *
 * **Full text, uncapped.** Every other stage excerpts at a configured
 * `body_cap` because it is about to hand text to a model. This one hands text
 * to the assembler, which owns the budget. Capping here would silently halve
 * the assembler's material and there would be two places to look for why.
 *
 * Ordering is meaningful and stable: members by score descending (the thread
 * pass's own ranking of its members), articles within a member chronologically,
 * so a cluster reads as a timeline of the event it covers.
 */

import "dotenv/config";
import { getPool } from "../../db/index.js";
import { loadSources } from "../../config/sources.js";
import { englishTitle, englishBody } from "../../lib/text.js";
import { parseGroupingDigest, type ParsedGroupingCluster } from "../editor-pass-1/index.js";
import type { EditorTier } from "../editor/index.js";

/** One underlying article: a single preprocessed item, with its lineage intact. */
export interface StoryArticle {
  preprocessedItemId: number;
  /** The story member this article arrived through — `C25` or `S52283`. */
  memberRef: string;
  sourceName: string;
  /** Parent outlet from sources.yaml (AP Politics → AP Top News), for source-diversity selection. */
  parentSource: string;
  sourceType: string;
  /** English where the preprocessor translated; the original otherwise. */
  title: string;
  originalTitle: string;
  /**
   * True when the preprocessor's translation failed, so `title` and `feedText`
   * hold untranslated original-language text despite coming from the english_*
   * columns (migration 032). The assembler must not hand a writer text it
   * cannot read without saying so.
   */
  translationFailed: boolean;
  canonicalUrl: string;
  originalUrl: string;
  publishedAt: Date | null;
  /** Sibling feeds of the same parent that carried this story (preprocessor parent-dedup). */
  alsoAppearedIn: string[];
  /** Body text as the feed supplied it, English where translated. Uncapped. */
  feedText: string;
  feedTextChars: number;
}

/** A row of the grouping/thread layer: one cluster or one singleton. */
export interface StoryMember {
  ref: string;
  itemType: "cluster" | "singleton";
  clusterIndex: number | null;
  title: string;
  summary: string;
  score: number;
  sourceCount: number;
  articles: StoryArticle[];
}

/** One published story, resolved to everything it is made of. */
export interface StoryMaterials {
  rank: number;
  tier: EditorTier;
  ref: string;
  itemType: "thread" | "cluster" | "singleton";
  threadId: number | null;
  title: string;
  summary: string;
  /** Relevance as the editor ranked it: pass-1 score, or max(member) for a thread. */
  score: number;
  /** Prominence as the editor ranked it: cluster member count, 1, or sum for a thread. */
  sourceCount: number;
  members: StoryMember[];
  /** Every article under this story, member order, deduplicated by item id. */
  articles: StoryArticle[];
  /**
   * Anything that could not be resolved. Non-empty means this story reaches the
   * writers with less material than the editor thought it had — a fact the
   * report must be able to state rather than infer from a short article list.
   */
  unresolved: string[];
}

// --- row shapes, exported so tests can build fixtures without a database ---

export interface EditorStoryRow {
  item_type: string;
  cluster_index: number | null;
  preprocessed_item_id: string | null;
  thread_id: string | null;
  tier: string;
  rank: number;
}

export interface ThreadRow {
  id: number;
  thread_index: number;
  title: string;
  summary: string | null;
  score: number;
  source_count: number;
}

export interface ThreadMemberRow {
  thread_id: string;
  item_type: string;
  cluster_index: number | null;
  preprocessed_item_id: string | null;
  score: number;
  source_count: number;
}

export interface PreprocessedItemRow {
  id: string;
  source_name: string;
  source_type: string;
  title: string;
  english_title: string | null;
  body_text: string | null;
  english_body: string | null;
  translation_failed: boolean | null;
  canonical_url: string;
  original_url: string;
  published_at: string | null;
  also_appeared_in: string | null;
}

export interface MaterialsInputs {
  stories: EditorStoryRow[];
  threadsById: Map<number, ThreadRow>;
  threadMembersByThreadId: Map<number, ThreadMemberRow[]>;
  clustersByIndex: Map<number, ParsedGroupingCluster>;
  itemsById: Map<number, PreprocessedItemRow>;
  /** Pass-1 relevance by member ref (`C25` / `S52283`), for members and non-thread stories. */
  scoreByRef: Map<string, number>;
  parentOf: (sourceName: string) => string;
}

function toArticle(
  row: PreprocessedItemRow,
  memberRef: string,
  parentOf: (sourceName: string) => string,
): StoryArticle {
  // A failed translation left the ORIGINAL text in english_body (migration 032),
  // so english_* being populated does not mean the text is English. Read the
  // flag rather than the column's presence. NULL predates the migration and is
  // treated as not-failed, the same reading the column comment gives it.
  const feedText = englishBody(row);
  return {
    preprocessedItemId: Number(row.id),
    memberRef,
    sourceName: row.source_name,
    parentSource: parentOf(row.source_name),
    sourceType: row.source_type,
    title: englishTitle(row),
    originalTitle: row.title,
    translationFailed: row.translation_failed === true,
    canonicalUrl: row.canonical_url,
    originalUrl: row.original_url,
    publishedAt: row.published_at ? new Date(row.published_at) : null,
    alsoAppearedIn: row.also_appeared_in
      ? row.also_appeared_in.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : [],
    feedText,
    feedTextChars: feedText.length,
  };
}

/** Chronological within a member, so a cluster reads as the event's timeline. */
function byPublishedAt(a: StoryArticle, b: StoryArticle): number {
  const at = a.publishedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bt = b.publishedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return at - bt || a.preprocessedItemId - b.preprocessedItemId;
}

function buildClusterMember(
  clusterIndex: number,
  score: number,
  inputs: MaterialsInputs,
  unresolved: string[],
): StoryMember {
  const detail = inputs.clustersByIndex.get(clusterIndex);
  const ref = `C${clusterIndex}`;
  if (!detail) {
    unresolved.push(`${ref}: not present in the grouping digest`);
    return {
      ref,
      itemType: "cluster",
      clusterIndex,
      title: "(cluster unresolved)",
      summary: "",
      score,
      sourceCount: 0,
      articles: [],
    };
  }

  const articles: StoryArticle[] = [];
  for (const itemId of detail.memberIds) {
    const row = inputs.itemsById.get(itemId);
    if (!row) {
      unresolved.push(`${ref}: member item ${itemId} not found`);
      continue;
    }
    articles.push(toArticle(row, ref, inputs.parentOf));
  }
  articles.sort(byPublishedAt);

  return {
    ref,
    itemType: "cluster",
    clusterIndex,
    title: detail.title,
    summary: detail.summary,
    score,
    // The count the editor ranked on is the digest's, not the number of rows we
    // managed to resolve; a gap between the two is what `unresolved` records.
    sourceCount: detail.memberIds.length,
    articles,
  };
}

function buildSingletonMember(
  itemId: number,
  score: number,
  inputs: MaterialsInputs,
  unresolved: string[],
): StoryMember {
  const ref = `S${itemId}`;
  const row = inputs.itemsById.get(itemId);
  if (!row) {
    unresolved.push(`${ref}: item not found`);
    return {
      ref,
      itemType: "singleton",
      clusterIndex: null,
      title: "(item unresolved)",
      summary: "",
      score,
      sourceCount: 1,
      articles: [],
    };
  }
  const article = toArticle(row, ref, inputs.parentOf);
  return {
    ref,
    itemType: "singleton",
    clusterIndex: null,
    title: article.title,
    // A singleton has no describe-pass summary; its body is its own summary and
    // the assembler reads that from the article.
    summary: "",
    score,
    sourceCount: 1,
    articles: [article],
  };
}

/**
 * Assembles resolved stories from already-loaded rows. Pure: no database, no
 * clock, no config read — every dependency arrives in `inputs`, so the whole
 * walk (including the thread → cluster → item case that only shows up on a real
 * run) is testable from fixtures.
 */
export function buildStoryMaterials(inputs: MaterialsInputs): StoryMaterials[] {
  const out: StoryMaterials[] = [];

  for (const story of inputs.stories) {
    const unresolved: string[] = [];
    const tier = story.tier as EditorTier;
    let materials: StoryMaterials | null = null;

    if (story.item_type === "thread" && story.thread_id !== null) {
      const threadId = Number(story.thread_id);
      const thread = inputs.threadsById.get(threadId);
      const memberRows = inputs.threadMembersByThreadId.get(threadId) ?? [];
      if (!thread) {
        unresolved.push(`thread ${threadId}: not found`);
      }
      if (memberRows.length === 0) {
        unresolved.push(`thread ${threadId}: no members recorded`);
      }

      const members = [...memberRows]
        .sort((a, b) => b.score - a.score)
        .map((m) =>
          m.item_type === "cluster" && m.cluster_index !== null
            ? buildClusterMember(m.cluster_index, m.score, inputs, unresolved)
            : buildSingletonMember(Number(m.preprocessed_item_id), m.score, inputs, unresolved),
        );

      materials = {
        rank: story.rank,
        tier,
        ref: `T${thread?.thread_index ?? "?"}`,
        itemType: "thread",
        threadId,
        title: thread?.title ?? "(thread unresolved)",
        summary: thread?.summary ?? "",
        score: thread?.score ?? 0,
        sourceCount: thread?.source_count ?? 0,
        members,
        articles: [],
        unresolved,
      };
    } else if (story.item_type === "cluster" && story.cluster_index !== null) {
      const ref = `C${story.cluster_index}`;
      const member = buildClusterMember(
        story.cluster_index,
        inputs.scoreByRef.get(ref) ?? 0,
        inputs,
        unresolved,
      );
      materials = {
        rank: story.rank,
        tier,
        ref,
        itemType: "cluster",
        threadId: null,
        title: member.title,
        summary: member.summary,
        score: member.score,
        sourceCount: member.sourceCount,
        members: [member],
        articles: [],
        unresolved,
      };
    } else if (story.preprocessed_item_id !== null) {
      // Includes the promoted-singleton shape: item_type='cluster' with a null
      // cluster_index and a real preprocessed_item_id.
      const itemId = Number(story.preprocessed_item_id);
      const ref = `S${itemId}`;
      const member = buildSingletonMember(
        itemId,
        inputs.scoreByRef.get(ref) ?? 0,
        inputs,
        unresolved,
      );
      materials = {
        rank: story.rank,
        tier,
        ref,
        itemType: "singleton",
        threadId: null,
        title: member.title,
        summary: "",
        score: member.score,
        sourceCount: 1,
        members: [member],
        articles: [],
        unresolved,
      };
    } else {
      unresolved.push(`rank ${story.rank}: story names neither a thread, cluster, nor item`);
      materials = {
        rank: story.rank,
        tier,
        ref: "(unresolved)",
        itemType: "singleton",
        threadId: null,
        title: "(story unresolved)",
        summary: "",
        score: 0,
        sourceCount: 0,
        members: [],
        articles: [],
        unresolved,
      };
    }

    // Flatten, keeping member order and dropping repeats. Grouping assigns each
    // item to exactly one cluster or singleton, so a repeat means two members of
    // one thread claim the same article — worth recording, not worth failing on.
    const seen = new Set<number>();
    for (const member of materials.members) {
      for (const article of member.articles) {
        if (seen.has(article.preprocessedItemId)) {
          materials.unresolved.push(
            `${member.ref}: item ${article.preprocessedItemId} already claimed by an earlier member`,
          );
          continue;
        }
        seen.add(article.preprocessedItemId);
        materials.articles.push(article);
      }
    }

    out.push(materials);
  }

  return out;
}

/**
 * Loads every story of an editor run, resolved to its underlying articles.
 * One query per table — the walk is wide (150 stories, ~300 articles) and
 * per-story queries would make it hundreds of round trips.
 */
export async function loadEditorRunMaterials(editorRunId: number): Promise<StoryMaterials[]> {
  const pool = getPool();

  const { rows: runRows } = await pool.query<{
    id: number;
    pile_id: number;
    grouping_run_id: number | null;
  }>("SELECT id, pile_id, grouping_run_id FROM editor_runs WHERE id = $1", [editorRunId]);
  const run = runRows[0];
  if (!run) throw new Error(`Editor run #${editorRunId} not found`);
  if (run.grouping_run_id === null) {
    throw new Error(`Editor run #${editorRunId} references no grouping run`);
  }

  const { rows: digestRows } = await pool.query<{ digest: string | null }>(
    "SELECT digest FROM grouping_runs WHERE id = $1",
    [run.grouping_run_id],
  );
  const digest = digestRows[0]?.digest;
  if (!digest) throw new Error(`Grouping run #${run.grouping_run_id} has no digest`);
  const clustersByIndex = new Map(
    parseGroupingDigest(digest).map((c) => [c.clusterIndex, c]),
  );

  const { rows: stories } = await pool.query<EditorStoryRow>(
    `SELECT item_type, cluster_index,
            preprocessed_item_id::text AS preprocessed_item_id,
            thread_id::text AS thread_id,
            tier, rank
     FROM editor_stories
     WHERE run_id = $1
     ORDER BY rank ASC`,
    [editorRunId],
  );

  const { rows: threadRows } = await pool.query<ThreadRow>(
    `SELECT DISTINCT t.id, t.thread_index, t.title, t.summary, t.score, t.source_count
     FROM threads t
     JOIN editor_stories es ON es.thread_id = t.id
     WHERE es.run_id = $1`,
    [editorRunId],
  );
  const threadsById = new Map(threadRows.map((t) => [Number(t.id), t]));

  const { rows: memberRows } = await pool.query<ThreadMemberRow>(
    `SELECT m.thread_id::text AS thread_id, m.item_type, m.cluster_index,
            m.preprocessed_item_id::text AS preprocessed_item_id,
            m.score, m.source_count
     FROM thread_members m
     JOIN editor_stories es ON es.thread_id = m.thread_id
     WHERE es.run_id = $1
     ORDER BY m.score DESC, m.id ASC`,
    [editorRunId],
  );
  const threadMembersByThreadId = new Map<number, ThreadMemberRow[]>();
  for (const m of memberRows) {
    const key = Number(m.thread_id);
    const list = threadMembersByThreadId.get(key) ?? [];
    list.push(m);
    threadMembersByThreadId.set(key, list);
  }

  // Pass-1 relevance for stories that are not threads. Threads carry their own
  // derived score; their members carry theirs on thread_members.
  const { rows: pileRows } = await pool.query<{
    item_type: string;
    cluster_index: number | null;
    preprocessed_item_id: string | null;
    score: number | null;
  }>(
    `SELECT item_type, cluster_index,
            preprocessed_item_id::text AS preprocessed_item_id, score
     FROM editor_pile_items
     WHERE pile_id = $1 AND in_pile = true`,
    [run.pile_id],
  );
  const scoreByRef = new Map<string, number>();
  for (const row of pileRows) {
    if (row.score === null) continue;
    if (row.item_type === "cluster" && row.cluster_index !== null) {
      scoreByRef.set(`C${row.cluster_index}`, row.score);
    } else if (row.preprocessed_item_id !== null) {
      scoreByRef.set(`S${row.preprocessed_item_id}`, row.score);
    }
  }

  // Every item the walk can reach: story singletons, thread-member singletons,
  // and the members of every cluster either of those paths names.
  const itemIds = new Set<number>();
  for (const s of stories) {
    if (s.preprocessed_item_id !== null) itemIds.add(Number(s.preprocessed_item_id));
    if (s.cluster_index !== null) {
      for (const id of clustersByIndex.get(s.cluster_index)?.memberIds ?? []) itemIds.add(id);
    }
  }
  for (const m of memberRows) {
    if (m.preprocessed_item_id !== null) itemIds.add(Number(m.preprocessed_item_id));
    if (m.cluster_index !== null) {
      for (const id of clustersByIndex.get(m.cluster_index)?.memberIds ?? []) itemIds.add(id);
    }
  }

  const { rows: itemRows } = await pool.query<PreprocessedItemRow>(
    `SELECT id::text AS id, source_name, source_type, title, english_title,
            body_text, english_body, translation_failed,
            canonical_url, original_url, published_at, also_appeared_in
     FROM preprocessed_items
     WHERE id = ANY($1::bigint[])`,
    [[...itemIds]],
  );
  const itemsById = new Map(itemRows.map((r) => [Number(r.id), r]));

  const parentBySource = new Map<string, string>();
  for (const source of loadSources()) {
    parentBySource.set(source.name, source.parent ?? source.name);
  }

  return buildStoryMaterials({
    stories,
    threadsById,
    threadMembersByThreadId,
    clustersByIndex,
    itemsById,
    scoreByRef,
    parentOf: (name) => parentBySource.get(name) ?? name,
  });
}
