import "dotenv/config";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { parseGroupingDigest } from "../editor-pass-1/index.js";
import { extractRefs } from "../../lib/refs.js";
import { buildPileMergeSystemPrompt, buildPileMergeUserPrompt } from "./prompt.js";

// Maps cluster_index → digest-resolved details for cluster pile items.
interface DigestClusterDetail {
  title: string;
  summary: string;
  itemCount: number;
}

// Parses cluster details from a triage digest string into a map keyed by
// cluster_index. Handles both the legacy JSON format and the current flat
// `title;;summary;;ids` format.
function parseTriageDigest(digest: string): Map<number, DigestClusterDetail> {
  const map = new Map<number, DigestClusterDetail>();
  const stripped = digest
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  if (stripped.startsWith("{")) {
    try {
      const parsed = JSON.parse(stripped) as {
        clusters?: Array<{ title?: unknown; summary?: unknown; item_ids?: unknown[] }>;
      };
      if (Array.isArray(parsed.clusters)) {
        parsed.clusters.forEach((c, index) => {
          map.set(index, {
            title: typeof c.title === "string" ? c.title : `Cluster ${index}`,
            summary: typeof c.summary === "string" ? c.summary : "",
            itemCount: Array.isArray(c.item_ids) ? c.item_ids.length : 0,
          });
        });
      }
    } catch {
      /* fall through to flat parser */
    }
    return map;
  }

  let index = 0;
  for (const rawLine of stripped.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue;
    const title = line.slice(0, first).trim();
    const summary = line.slice(first + 2, last).trim();
    const idPart = line.slice(last + 2).trim();
    const itemCount = idPart.split(",").filter((tok) => /^\s*\d+\s*$/.test(tok)).length;
    map.set(index, { title, summary, itemCount });
    index++;
  }
  return map;
}

// Full pile entry with all fields needed for formatting and merge building.
interface ResolvedPileEntry {
  ref: string;
  title: string;
  summary: string; // non-empty for clusters; "" for singletons
  excerpt: string; // non-empty for singletons; "" for clusters
  itemType: "cluster" | "singleton";
  clusterIndex: number | null;
  preprocessedItemId: number | null;
  pass1Score: number | null;
  pass1Reason: string | null;
  itemCount: number; // member count for clusters; 1 for singletons
  score: number | null; // grouping-path pass-1 score; null for triage-path clusters
}

// Exported type stored as JSONB in pile_merge_runs.merged_pile and read by
// the editor when pile_merge_run_id is set on the pile. originalRefs holds
// all ref strings that were merged into this entry (including the entry's own
// ref); length > 1 means this entry absorbed others.
export interface MergedPileEntry {
  ref: string;
  title: string;
  summary: string;
  excerpt: string;
  itemType: "cluster" | "singleton";
  clusterIndex: number | null;
  preprocessedItemId: number | null;
  pass1Score: number | null;
  pass1Reason: string | null;
  itemCount: number;
  score: number | null;
  originalRefs: string[];
}

export interface PileMergeRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  editorPileId: number;
  modelUsed: string;
  itemsIn: number;
  groupsMerged: number;
  itemsOut: number;
  mergedPile: MergedPileEntry[] | null;
  generationLogId: bigint | null;
}

interface PileMergeRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  editor_pile_id: number;
  model_used: string;
  items_in: number;
  groups_merged: number;
  items_out: number;
  merged_pile: MergedPileEntry[] | null;
  generation_log_id: string | null;
}

// Formats each pile entry as a block for the LLM prompt. No scores — scores
// are relevance signals, not duplicate signals; showing them would bias the
// model toward merging high-scoring pairs.
function formatPileBlocks(entries: ResolvedPileEntry[]): string {
  return entries
    .map((entry) => {
      if (entry.itemType === "cluster") {
        return (
          `[${entry.ref}] ${entry.title} — ` +
          `${entry.itemCount} source${entry.itemCount === 1 ? "" : "s"}\n${entry.summary}`
        );
      }
      return `[${entry.ref}] ${entry.title}\n${entry.excerpt}`;
    })
    .join("\n\n");
}

// Parses MERGE lines from the model's output. A ref may appear in at most one
// group; second appearances are dropped with a warning. Returns only groups of
// 2+ valid refs.
function parseMergeOutput(text: string, validRefs: Set<string>): string[][] {
  const groups: string[][] = [];
  const usedRefs = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toUpperCase().startsWith("MERGE:")) continue;
    // extractRefs pulls bare upper-case C/S tokens from the raw text,
    // tolerating brackets, trailing punctuation, and spacing variations.
    const refs = extractRefs(line.slice("MERGE:".length));

    const validGroup: string[] = [];
    for (const ref of refs) {
      if (!validRefs.has(ref)) {
        console.warn(`[pile-merge] unknown ref in output (dropped): ${ref}`);
        continue;
      }
      if (usedRefs.has(ref)) {
        console.warn(`[pile-merge] ref already in a merge group (dropped): ${ref}`);
        continue;
      }
      validGroup.push(ref);
      usedRefs.add(ref);
    }
    if (validGroup.length >= 2) {
      groups.push(validGroup);
    }
  }
  return groups;
}

// Builds the merged pile from resolved entries and parsed merge groups.
// Primary of each group is selected by: cluster > singleton, then by itemCount
// desc, then by ref (lexicographic, for determinism). Non-primary group
// members are absorbed. Pass-through entries (not in any group) are unchanged.
function buildMergedPile(
  entries: ResolvedPileEntry[],
  mergeGroups: string[][],
): MergedPileEntry[] {
  const byRef = new Map<string, ResolvedPileEntry>();
  for (const entry of entries) byRef.set(entry.ref, entry);

  const absorbed = new Set<string>();
  const mergedByPrimaryRef = new Map<string, MergedPileEntry>();

  for (const group of mergeGroups) {
    // Pick primary: prefer cluster over singleton; within same type, prefer
    // higher itemCount; tie-break lexicographically on ref for determinism.
    let primary: ResolvedPileEntry | null = null;
    for (const ref of group) {
      const entry = byRef.get(ref);
      if (!entry) continue;
      if (!primary) {
        primary = entry;
        continue;
      }
      const entryIsCluster = entry.itemType === "cluster";
      const primaryIsCluster = primary.itemType === "cluster";
      const preferEntry =
        (entryIsCluster && !primaryIsCluster) ||
        (entryIsCluster === primaryIsCluster && entry.itemCount > primary.itemCount) ||
        (entryIsCluster === primaryIsCluster &&
          entry.itemCount === primary.itemCount &&
          entry.ref < primary.ref);
      if (preferEntry) primary = entry;
    }
    if (!primary) continue;

    // Accumulate itemCount and max scores across all group members.
    let totalItemCount = 0;
    let maxScore: number | null = null;
    let maxPass1Score: number | null = null;
    for (const ref of group) {
      const e = byRef.get(ref);
      if (!e) continue;
      totalItemCount += e.itemCount;
      if (e.score !== null && (maxScore === null || e.score > maxScore)) maxScore = e.score;
      if (e.pass1Score !== null && (maxPass1Score === null || e.pass1Score > maxPass1Score)) {
        maxPass1Score = e.pass1Score;
      }
    }

    // If the primary was a singleton, promote to cluster and use its excerpt
    // as the summary (enough context for the editor to rank the merged entry).
    const newItemType: "cluster" | "singleton" =
      primary.itemType === "cluster" || group.length > 1 ? "cluster" : "singleton";
    const newSummary =
      newItemType === "cluster" && primary.summary.length === 0
        ? primary.excerpt
        : primary.summary;

    // Absorb all non-primary refs.
    for (const ref of group) {
      if (ref !== primary.ref) absorbed.add(ref);
    }

    mergedByPrimaryRef.set(primary.ref, {
      ref: primary.ref,
      title: primary.title,
      summary: newSummary,
      excerpt: newItemType === "singleton" ? primary.excerpt : "",
      itemType: newItemType,
      clusterIndex: primary.itemType === "cluster" ? primary.clusterIndex : null,
      preprocessedItemId: primary.itemType === "singleton" ? primary.preprocessedItemId : null,
      pass1Score: maxPass1Score,
      pass1Reason: primary.pass1Reason,
      itemCount: totalItemCount,
      score: maxScore,
      originalRefs: group,
    });
  }

  // Preserve original order: filter absorbed entries, replace primaries with
  // their merged versions, wrap pass-through entries with originalRefs: [ref].
  return entries
    .filter((e) => !absorbed.has(e.ref))
    .map((e) => {
      const merged = mergedByPrimaryRef.get(e.ref);
      if (merged) return merged;
      return { ...e, originalRefs: [e.ref] };
    });
}

async function fetchPileMergeRunFromPool(
  pool: import("pg").Pool,
  runId: number,
): Promise<PileMergeRun> {
  const { rows } = await pool.query<PileMergeRunRow>(
    "SELECT * FROM pile_merge_runs WHERE id = $1",
    [runId],
  );
  const r = rows[0]!;
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    editorPileId: r.editor_pile_id,
    modelUsed: r.model_used,
    itemsIn: r.items_in,
    groupsMerged: r.groups_merged,
    itemsOut: r.items_out,
    mergedPile: r.merged_pile,
    generationLogId: r.generation_log_id ? BigInt(r.generation_log_id) : null,
  };
}

export async function runPileMerge(options: { pileId?: number } = {}): Promise<PileMergeRun> {
  const pool = getPool();

  // 1. Find editor pile (explicit id or latest).
  let pileId: number;
  if (options.pileId !== undefined) {
    pileId = options.pileId;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM editor_piles ORDER BY created_at DESC LIMIT 1",
    );
    if (!rows[0]) throw new Error("No editor piles found");
    pileId = rows[0].id;
  }

  // 2. Load pile meta and resolve cluster details from the appropriate digest.
  const { rows: pileRows } = await pool.query<{
    id: number;
    triage_run_id: number | null;
    grouping_run_id: number | null;
  }>("SELECT id, triage_run_id, grouping_run_id FROM editor_piles WHERE id = $1", [pileId]);
  const pile = pileRows[0];
  if (!pile) throw new Error(`Editor pile #${pileId} not found`);

  let clusterDetails: Map<number, DigestClusterDetail>;
  if (pile.grouping_run_id !== null) {
    const { rows } = await pool.query<{ digest: string | null }>(
      "SELECT digest FROM grouping_runs WHERE id = $1",
      [pile.grouping_run_id],
    );
    const digest = rows[0]?.digest;
    if (!digest) throw new Error(`Grouping run #${pile.grouping_run_id} has no digest`);
    clusterDetails = new Map(
      parseGroupingDigest(digest).map((c) => [
        c.clusterIndex,
        { title: c.title, summary: c.summary, itemCount: c.memberIds.length },
      ]),
    );
  } else if (pile.triage_run_id !== null) {
    const { rows } = await pool.query<{ digest: string | null }>(
      "SELECT digest FROM triage_runs WHERE id = $1",
      [pile.triage_run_id],
    );
    const digest = rows[0]?.digest;
    if (!digest) throw new Error(`Triage run #${pile.triage_run_id} has no digest`);
    clusterDetails = parseTriageDigest(digest);
  } else {
    throw new Error(`Editor pile #${pileId} has neither triage_run_id nor grouping_run_id`);
  }

  // 3. Load cluster pile items (by index, for digest resolution).
  const { rows: clusterRows } = await pool.query<{
    cluster_index: number;
    score: number | null;
    reason: string | null;
  }>(
    `SELECT cluster_index, score, reason
     FROM editor_pile_items
     WHERE pile_id = $1 AND item_type = 'cluster' AND in_pile = true
     ORDER BY cluster_index ASC`,
    [pileId],
  );

  // 4. Load singleton pile items (with title and body excerpt from
  //    preprocessed_items, and pass-1 score/reason from editor_pile_items).
  const { rows: singletonRows } = await pool.query<{
    preprocessed_item_id: string;
    score: number | null;
    reason: string | null;
    title: string;
    body_text: string | null;
  }>(
    `SELECT epi.preprocessed_item_id, epi.score, epi.reason, pi.title, pi.body_text
     FROM editor_pile_items epi
     JOIN preprocessed_items pi ON pi.id = epi.preprocessed_item_id
     WHERE epi.pile_id = $1 AND epi.item_type = 'singleton' AND epi.in_pile = true
     ORDER BY epi.score DESC, epi.preprocessed_item_id ASC`,
    [pileId],
  );

  // 5. Resolve full entries.
  const entries: ResolvedPileEntry[] = [];

  for (const row of clusterRows) {
    const detail = clusterDetails.get(row.cluster_index);
    if (!detail) {
      console.warn(
        `[pile-merge] cluster_index ${row.cluster_index} not in digest — skipping`,
      );
      continue;
    }
    entries.push({
      ref: `C${row.cluster_index}`,
      title: detail.title,
      summary: detail.summary,
      excerpt: "",
      itemType: "cluster",
      clusterIndex: row.cluster_index,
      preprocessedItemId: null,
      pass1Score: row.score,
      pass1Reason: row.reason,
      itemCount: detail.itemCount,
      score: row.score,
    });
  }

  for (const row of singletonRows) {
    const pid = Number(row.preprocessed_item_id);
    const excerpt = (row.body_text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    entries.push({
      ref: `S${pid}`,
      title: row.title,
      summary: "",
      excerpt,
      itemType: "singleton",
      clusterIndex: null,
      preprocessedItemId: pid,
      pass1Score: row.score,
      pass1Reason: row.reason,
      itemCount: 1,
      score: row.score,
    });
  }

  if (entries.length === 0) throw new Error(`Editor pile #${pileId} has no in-pile items`);

  console.log(
    `[pile-merge] pile #${pileId}: ${clusterRows.length} clusters + ` +
      `${singletonRows.length} singletons = ${entries.length} items`,
  );

  // 6. Load model config and create a pile_merge_runs row.
  const modelConfig = loadModelConfig();
  const stageConfig = modelConfig.pile_merge;
  const model = stageConfig.model;

  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO pile_merge_runs (editor_pile_id, model_used, items_in)
     VALUES ($1, $2, $3) RETURNING id`,
    [pileId, model, entries.length],
  );
  const runId = runRows[0]!.id;

  try {
    // 7. Format pile blocks and call the LLM.
    const pileBlocks = formatPileBlocks(entries);
    const systemPrompt = buildPileMergeSystemPrompt();
    const userPrompt = buildPileMergeUserPrompt(pileBlocks);

    console.log(
      `[pile-merge] run #${runId}: calling ${model} (provider=${stageConfig.provider ?? "ollama-cloud"})…`,
    );

    const llmResult = await callLLM({
      stage: "pile-merge",
      stageRunId: runId,
      model,
      systemPrompt,
      userPrompt,
      temperature: stageConfig.temperature,
      maxTokens: stageConfig.max_tokens,
      reasoningEffort: stageConfig.reasoning_effort,
      provider: stageConfig.provider,
      timeoutMs: stageConfig.timeout_ms,
      stream: stageConfig.stream,
    });

    // 8. Parse merge groups and build the merged pile.
    const validRefs = new Set(entries.map((e) => e.ref));
    const mergeGroups = parseMergeOutput(llmResult.text, validRefs);
    const mergedPile = buildMergedPile(entries, mergeGroups);

    const groupsMerged = mergeGroups.length;
    const itemsOut = mergedPile.length;

    console.log(
      `[pile-merge] run #${runId}: ` +
        `${mergeGroups.length} group(s) merged — ` +
        `${entries.length} in → ${itemsOut} out`,
    );

    // 9. Write merged pile to DB and link the editor pile.
    await pool.query(
      `UPDATE pile_merge_runs
       SET completed_at      = NOW(),
           groups_merged     = $1,
           items_out         = $2,
           merged_pile       = $3::jsonb,
           generation_log_id = $4
       WHERE id = $5`,
      [groupsMerged, itemsOut, JSON.stringify(mergedPile), llmResult.generationLogId, runId],
    );

    await pool.query("UPDATE editor_piles SET pile_merge_run_id = $1 WHERE id = $2", [
      runId,
      pileId,
    ]);

    return fetchPileMergeRunFromPool(pool, runId);
  } catch (err) {
    await pool.query(
      "UPDATE pile_merge_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL",
      [runId],
    );
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Pile-merge run #${runId} failed: ${msg}`);
  }
}

export async function fetchPileMergeRun(runId: number): Promise<PileMergeRun | null> {
  const pool = getPool();
  const { rows } = await pool.query<PileMergeRunRow>(
    "SELECT * FROM pile_merge_runs WHERE id = $1",
    [runId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    editorPileId: r.editor_pile_id,
    modelUsed: r.model_used,
    itemsIn: r.items_in,
    groupsMerged: r.groups_merged,
    itemsOut: r.items_out,
    mergedPile: r.merged_pile,
    generationLogId: r.generation_log_id ? BigInt(r.generation_log_id) : null,
  };
}
