import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM, type LLMCallOptions } from "../../llm/index.js";
import { parseGroupingDigest } from "../editor-pass-1/index.js";
import { normalizeRef } from "../../lib/refs.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildMergedUserPrompt,
  type EditorClusterPileItem,
  type EditorSingletonPileItem,
  type MergedPileBlock,
} from "./prompt.js";
import type { MergedPileEntry } from "../pile-merge/index.js";

const BIO_PATH = path.join(import.meta.dirname, "..", "..", "..", "docs", "bio.md");
const STANDING_MEMO_PATH = path.join(import.meta.dirname, "..", "..", "..", "docs", "standing-memo.md");

const BIO_FALLBACK =
  "(Reader bio not yet written. Apply generic editorial judgment: weight " +
  "substantive accountability journalism and stories with direct stakes for an " +
  "ordinary reader; send routine sports, celebrity, and market-noise items toward " +
  "the bottom tiers or cut them outright.)";

const STANDING_MEMO_FALLBACK =
  "(Standing memo not yet written. Rank by what most directly matters to the " +
  "reader described in the bio below — give the lead position to the day's most " +
  "consequential story — and don't be afraid to tier most of the pile down to " +
  "brief or cut on a slow news day. A short, honest paper beats a padded one.)";

function loadTextFile(filePath: string, fallback: string): string {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    return content.length > 0 ? content : fallback;
  } catch {
    return fallback;
  }
}

export type EditorTier = "feature" | "standard" | "brief" | "cut";
const VALID_TIERS = new Set<EditorTier>(["feature", "standard", "brief", "cut"]);

/**
 * Pass-1 relevance score at/above which a missing singleton fails safe to
 * 'standard' rather than 'brief'. ~70 is where the editor's own standard/brief
 * placements cluster — close enough to use as the fail-safe line. Fail-safe
 * is deliberately capped at 'standard': promoting a dropped item to 'feature'
 * requires the editor's actual judgment, not a heuristic.
 */
const SINGLETON_FAILSAFE_STANDARD_SCORE_THRESHOLD = 70;

interface DigestCluster {
  index: number;
  title: string;
  summary: string;
  notes: string | null;
  itemCount: number;
}

/**
 * Parses cluster title/summary/notes/item-count from a triage digest, indexed
 * the same way assemble-pile.ts and editor-pass-1's extractClusteredIds count
 * them — by raw line position, not by validated cluster membership — so
 * cluster_index here lines up with editor_pile_items.cluster_index.
 */
function parseDigestClusters(digest: string): DigestCluster[] | null {
  const stripped = digest.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  // JSON format (old digests start with '{').
  if (stripped.startsWith("{")) {
    try {
      const parsed = JSON.parse(stripped) as {
        clusters?: Array<{ title?: unknown; summary?: unknown; notes?: unknown; item_ids?: unknown[] }>;
      };
      if (!Array.isArray(parsed.clusters)) return null;
      return parsed.clusters.map((c, index) => ({
        index,
        title: typeof c.title === "string" ? c.title : `Cluster ${index}`,
        summary: typeof c.summary === "string" ? c.summary : "",
        notes: typeof c.notes === "string" ? c.notes : null,
        itemCount: Array.isArray(c.item_ids) ? c.item_ids.length : 0,
      }));
    } catch {
      return null;
    }
  }

  // Flat line format: label;;summary;;id,id,...
  const clusters: DigestCluster[] = [];
  for (const rawLine of stripped.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue;

    const title = line.slice(0, first).trim();
    const summary = line.slice(first + 2, last).trim();
    const idPart = line.slice(last + 2).trim();
    const itemCount = idPart.split(",").filter((tok) => /^\s*\d+\s*$/.test(tok)).length;

    clusters.push({ index: clusters.length, title, summary, notes: null, itemCount });
  }

  return clusters.length > 0 ? clusters : null;
}

interface EditorPileItem {
  ref: string;
  itemType: "cluster" | "singleton";
  clusterIndex: number | null;
  preprocessedItemId: number | null;
  // Singleton-only: pass-1 relevance score, used to pick a sensible fail-safe
  // tier if the editor drops the item from its output. Null for clusters.
  pass1Score: number | null;
}

/**
 * Picks the tier a pile item fails safe to when the editor's output omits it.
 * Clusters reach the pile on multi-source pickup alone — inherently
 * higher-signal than a residual singleton — so they fail safe to 'standard'.
 * Singletons fail safe based on the one piece of relevance signal we already
 * have (the pass-1 score): high-scoring drops land at 'standard', everything
 * else at 'brief'. Never 'feature' — that tier is the editor's call alone.
 */
function failSafeTierForMissingItem(item: EditorPileItem): EditorTier {
  if (item.itemType === "cluster") return "standard";
  if (item.pass1Score !== null && item.pass1Score >= SINGLETON_FAILSAFE_STANDARD_SCORE_THRESHOLD) {
    return "standard";
  }
  return "brief";
}

/**
 * Single call attempt: invokes callLLM, parses the result, and checks whether
 * the parse collapsed (< 50% of pile items produced valid output lines).
 * Returns the EditorParseResult on success, null on any failure including
 * thrown exceptions and collapse. A paper with fail-safed missing items but
 * >= 50% parsed lines is a success — do not retry a merely-imperfect paper.
 */
async function attemptEditorCall(
  runId: number,
  callOptions: LLMCallOptions,
  pileItems: EditorPileItem[],
  label: string,
): Promise<EditorParseResult | null> {
  console.log(
    `[editor] run #${runId}: ${label} — model=${callOptions.model} provider=${callOptions.provider ?? "ollama-cloud"}`,
  );
  try {
    const llmResult = await callLLM(callOptions);
    const parsed = parseEditorOutput(llmResult.text, pileItems);

    const collapseThreshold = Math.floor(pileItems.length * 0.5);
    if (pileItems.length > 0 && parsed.parsedLineCount < collapseThreshold) {
      console.warn(
        `[editor] run #${runId}: ${label} — COLLAPSE: ` +
          `parsed ${parsed.parsedLineCount}/${pileItems.length} lines (< 50% threshold)`,
      );
      return null;
    }

    console.log(
      `[editor] run #${runId}: ${label} — SUCCESS: ` +
        `parsed ${parsed.parsedLineCount}/${pileItems.length}, missing=${parsed.missingCount}`,
    );
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[editor] run #${runId}: ${label} — FAILED: ${msg}`);
    return null;
  }
}

export interface EditorStoryResult extends EditorPileItem {
  tier: EditorTier;
  reason: string;
}

export interface EditorParseResult {
  results: EditorStoryResult[]; // final rank order: parsed lines, then fail-safed missing items
  parsedLineCount: number;
  missingCount: number;
  unknownRefCount: number;
  duplicateRefCount: number;
  badTierCount: number;
}

/**
 * Defensive flat-line parser for the editor's ranked output: `tier;;ref;;reason`.
 * Mirrors parseBatchOutput's split-on-first-two-`;;` shape, but reconciles
 * against the pile by ref rather than by id, since rank is derived from line
 * order, not emitted by the model.
 *
 * - Unknown refs are dropped and logged.
 * - Duplicate refs keep the first occurrence; later ones are dropped and logged.
 * - Invalid tier values fail-safe to 'brief'.
 * - Pile items absent from the output are appended at the end with a flagged
 *   reason — an editor that drops items truncates the paper. Their fail-safe
 *   tier is derived from the best signal available rather than a flat
 *   'brief': clusters (inherently higher-signal — multi-source pickup got
 *   them into the pile) fail safe to 'standard'; singletons fail safe to
 *   'standard' or 'brief' based on their pass-1 relevance score (see
 *   failSafeTierForMissingItem). Never 'feature' — see that function.
 */
export function parseEditorOutput(text: string, pileItems: EditorPileItem[]): EditorParseResult {
  const byRef = new Map<string, EditorPileItem>();
  for (const item of pileItems) byRef.set(item.ref, item);

  const seen = new Set<string>();
  const ordered: EditorStoryResult[] = [];
  let parsedLineCount = 0;
  let unknownRefCount = 0;
  let duplicateRefCount = 0;
  let badTierCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const firstDelimiter = line.indexOf(";;");
    if (firstDelimiter === -1) continue;
    const secondDelimiter = line.indexOf(";;", firstDelimiter + 2);
    if (secondDelimiter === -1) continue;

    const tierField = line.slice(0, firstDelimiter).trim().toLowerCase();
    const rawRef = line.slice(firstDelimiter + 2, secondDelimiter).trim();
    const reason = line.slice(secondDelimiter + 2).trim();

    if (rawRef.length === 0 || reason.length === 0) continue;
    parsedLineCount++;

    // normalizeRef strips brackets, punctuation, and case so both "[C3]" and
    // "C3" resolve to the same pile key. Clean refs normalize to themselves.
    const ref = normalizeRef(rawRef);
    if (!ref) {
      console.warn(`[editor] unknown ref in output (dropped): ${rawRef}`);
      unknownRefCount++;
      continue;
    }
    const pileItem = byRef.get(ref);
    if (!pileItem) {
      console.warn(`[editor] unknown ref in output (dropped): ${rawRef}`);
      unknownRefCount++;
      continue;
    }
    if (seen.has(ref)) {
      console.warn(`[editor] duplicate ref in output (kept first occurrence): ${rawRef}`);
      duplicateRefCount++;
      continue;
    }
    seen.add(ref);

    let tier: EditorTier;
    if (VALID_TIERS.has(tierField as EditorTier)) {
      tier = tierField as EditorTier;
    } else {
      console.warn(`[editor] invalid tier "${tierField}" for ${ref} — fail-safe to brief`);
      badTierCount++;
      tier = "brief";
    }

    ordered.push({ ...pileItem, tier, reason });
  }

  let missingCount = 0;
  for (const item of pileItems) {
    if (seen.has(item.ref)) continue;
    const tier = failSafeTierForMissingItem(item);
    console.warn(`[editor] pile item missing from output — fail-safe to ${tier}: ${item.ref}`);
    missingCount++;
    ordered.push({ ...item, tier, reason: "fail-safe: missing from editor output" });
  }

  return {
    results: ordered,
    parsedLineCount,
    missingCount,
    unknownRefCount,
    duplicateRefCount,
    badTierCount,
  };
}

export interface EditorRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  pileId: number;
  triageRunId: number | null;
  groupingRunId: number | null;
  modelUsed: string;
  itemsIn: number;
  itemsFeature: number;
  itemsStandard: number;
  itemsBrief: number;
  itemsCut: number;
}

interface EditorRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  pile_id: number;
  triage_run_id: number | null;
  grouping_run_id: number | null;
  model_used: string;
  items_in: number;
  items_feature: number;
  items_standard: number;
  items_brief: number;
  items_cut: number;
}

export async function runEditor(
  options: {
    pileId?: number;
    modelOverride?: string;
  } = {},
): Promise<EditorRun> {
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

  // 2. Load the pile and resolve its cluster source. A pile comes from one of
  //    two upstream paths: triage (triage_run_id set) or the embedding-based
  //    grouping stage (grouping_run_id set, triage_run_id null). Both store
  //    cluster title/summary/members in the same flat digest format; only the
  //    source table differs.
  const { rows: pileRows } = await pool.query<{
    id: number;
    triage_run_id: number | null;
    grouping_run_id: number | null;
    pile_merge_run_id: number | null;
  }>(
    "SELECT id, triage_run_id, grouping_run_id, pile_merge_run_id FROM editor_piles WHERE id = $1",
    [pileId],
  );
  const pile = pileRows[0];
  if (!pile) throw new Error(`Editor pile #${pileId} not found`);
  const triageRunId = pile.triage_run_id;
  const groupingRunId = pile.grouping_run_id;
  const pileMergeRunId = pile.pile_merge_run_id;

  let clusterItems: EditorClusterPileItem[];
  let singletonItems: EditorSingletonPileItem[];
  let pileItems: EditorPileItem[];
  let userPrompt: string;

  if (pileMergeRunId !== null) {
    // Merged pile path: the pile-merge pass already assembled the final pile as
    // JSONB. Use it directly — no digest resolution or separate item queries.
    const { rows: mergeRows } = await pool.query<{ merged_pile: MergedPileEntry[] | null }>(
      "SELECT merged_pile FROM pile_merge_runs WHERE id = $1",
      [pileMergeRunId],
    );
    const mergedPile = mergeRows[0]?.merged_pile;
    if (!mergedPile) {
      throw new Error(`Pile-merge run #${pileMergeRunId} has no merged_pile — run pile-merge first`);
    }

    // Split into cluster-like (has summary) and singleton-like (has excerpt)
    // entries for both the prompt and the per-item fail-safe tier logic.
    clusterItems = mergedPile
      .filter((e) => e.summary.length > 0)
      .map((e) => ({
        ref: e.ref,
        clusterIndex: e.clusterIndex,
        title: e.title,
        summary: e.summary,
        notes: null,
        sourceCount: e.itemCount,
      }))
      .sort((a, b) => b.sourceCount - a.sourceCount || (a.clusterIndex ?? -1) - (b.clusterIndex ?? -1));

    singletonItems = mergedPile
      .filter((e) => e.summary.length === 0)
      .map((e) => ({
        ref: e.ref,
        preprocessedItemId: e.preprocessedItemId ?? 0,
        title: e.title,
        bodyExcerpt: e.excerpt,
        pass1Score: e.pass1Score ?? 0,
        pass1Reason: e.pass1Reason ?? "",
      }));

    const mergedBlocks: MergedPileBlock[] = [
      ...clusterItems.map((c) => ({
        ref: c.ref,
        title: c.title,
        summary: c.summary,
        excerpt: "",
        itemCount: c.sourceCount,
        pass1Score: null,
        pass1Reason: null,
      })),
      ...singletonItems.map((s) => ({
        ref: s.ref,
        title: s.title,
        summary: "",
        excerpt: s.bodyExcerpt,
        itemCount: 1,
        pass1Score: s.pass1Score,
        pass1Reason: s.pass1Reason,
      })),
    ];

    pileItems = [
      ...mergedPile
        .filter((e) => e.summary.length > 0)
        .map((e) => ({
          ref: e.ref,
          itemType: "cluster" as const,
          clusterIndex: e.clusterIndex,
          preprocessedItemId: null,
          pass1Score: null,
        })),
      ...mergedPile
        .filter((e) => e.summary.length === 0)
        .map((e) => ({
          ref: e.ref,
          itemType: "singleton" as const,
          clusterIndex: null,
          preprocessedItemId: e.preprocessedItemId,
          pass1Score: e.pass1Score,
        })),
    ];

    userPrompt = buildMergedUserPrompt(mergedBlocks);
    console.log(`[editor] pile #${pileId}: merged pile (pile-merge run #${pileMergeRunId})`);
  } else {
    // Normal path: resolve cluster details from the appropriate digest, then
    // load and present items from editor_pile_items.
    let digestClusters: DigestCluster[];
    if (groupingRunId !== null) {
      // Grouping-sourced pile. Resolve cluster details from the grouping run's
      // digest using the SAME parser the scorer used to assign
      // editor_pile_items.cluster_index, so indices align by construction.
      // Source count per cluster is its member-id count.
      const { rows: groupingRows } = await pool.query<{ digest: string | null }>(
        "SELECT digest FROM grouping_runs WHERE id = $1",
        [groupingRunId],
      );
      const digest = groupingRows[0]?.digest;
      if (!digest) throw new Error(`Grouping run #${groupingRunId} has no digest`);

      digestClusters = parseGroupingDigest(digest).map((c) => ({
        index: c.clusterIndex,
        title: c.title,
        summary: c.summary,
        notes: null,
        itemCount: c.memberIds.length,
      }));
    } else if (triageRunId !== null) {
      // Triage-sourced pile (original path) — behaviour unchanged.
      const { rows: triageRows } = await pool.query<{ digest: string | null }>(
        "SELECT digest FROM triage_runs WHERE id = $1",
        [triageRunId],
      );
      const digest = triageRows[0]?.digest;
      if (!digest) throw new Error(`Triage run #${triageRunId} has no digest`);

      const parsed = parseDigestClusters(digest);
      if (parsed === null) {
        throw new Error(
          `Triage run #${triageRunId} digest could not be parsed — cannot resolve cluster details`,
        );
      }
      digestClusters = parsed;
    } else {
      throw new Error(
        `Editor pile #${pileId} references neither a triage run nor a grouping run`,
      );
    }
    const clusterByIndex = new Map(digestClusters.map((c) => [c.index, c]));

    // 3. Load in-pile items: clusters (by triage digest index) and singletons
    //    (joined to preprocessed_items for title/body, carrying pass-1 score + reason).
    const { rows: clusterPileRows } = await pool.query<{ cluster_index: number }>(
      `SELECT cluster_index FROM editor_pile_items
       WHERE pile_id = $1 AND item_type = 'cluster' AND in_pile = true
       ORDER BY cluster_index ASC`,
      [pileId],
    );

    const { rows: singletonPileRows } = await pool.query<{
      preprocessed_item_id: string;
      score: number;
      reason: string;
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

    // 4. Build presentation lists in stable order: clusters by source count desc,
    //    then singletons by pass-1 score desc (already the query order).
    clusterItems = clusterPileRows
      .map((row): EditorClusterPileItem | null => {
        const detail = clusterByIndex.get(row.cluster_index);
        if (!detail) {
          console.warn(
            `[editor] pile cluster_index ${row.cluster_index} not found in digest — skipping`,
          );
          return null;
        }
        return {
          ref: `C${row.cluster_index}`,
          clusterIndex: row.cluster_index,
          title: detail.title,
          summary: detail.summary,
          notes: detail.notes,
          sourceCount: detail.itemCount,
        };
      })
      .filter((c): c is EditorClusterPileItem => c !== null)
      .sort(
        (a, b) => b.sourceCount - a.sourceCount || (a.clusterIndex ?? 0) - (b.clusterIndex ?? 0),
      );

    singletonItems = singletonPileRows.map((row) => ({
      ref: `S${row.preprocessed_item_id}`,
      preprocessedItemId: Number(row.preprocessed_item_id),
      title: row.title,
      bodyExcerpt: (row.body_text ?? "").replace(/\s+/g, " ").trim().slice(0, 50),
      pass1Score: row.score,
      pass1Reason: row.reason,
    }));

    pileItems = [
      ...clusterItems.map((c) => ({
        ref: c.ref,
        itemType: "cluster" as const,
        clusterIndex: c.clusterIndex,
        preprocessedItemId: null,
        pass1Score: null,
      })),
      ...singletonItems.map((s) => ({
        ref: s.ref,
        itemType: "singleton" as const,
        clusterIndex: null,
        preprocessedItemId: s.preprocessedItemId,
        pass1Score: s.pass1Score,
      })),
    ];

    userPrompt = buildUserPrompt(clusterItems, singletonItems);
  }

  if (pileItems.length === 0) {
    throw new Error(`Editor pile #${pileId} has no in-pile items`);
  }

  // 5. Load model config and build the (whole-pile, single-call) prompts.
  const modelConfig = loadModelConfig();
  const stageConfig = modelConfig.editor;
  const model = options.modelOverride ?? stageConfig.model;
  const temperature = stageConfig.temperature;
  const maxTokens = stageConfig.max_tokens;
  const reasoningEffort = stageConfig.reasoning_effort;
  const provider = stageConfig.provider;
  const timeoutMs = stageConfig.timeout_ms;
  const stream = stageConfig.stream;

  const standingMemo = loadTextFile(STANDING_MEMO_PATH, STANDING_MEMO_FALLBACK);
  const bio = loadTextFile(BIO_PATH, BIO_FALLBACK);
  const systemPrompt = buildSystemPrompt(standingMemo, bio);

  if (pileMergeRunId === null) {
    console.log(
      `[editor] pile #${pileId}: ${clusterItems.length} clusters, ${singletonItems.length} singletons, ` +
        `${pileItems.length} items total — one whole-pile call`,
    );
  } else {
    console.log(
      `[editor] pile #${pileId} (merged): ${clusterItems.length} clusters, ` +
        `${singletonItems.length} singletons, ${pileItems.length} items total — one whole-pile call`,
    );
  }

  // 6. Create editor_runs row. Exactly one of triage_run_id / grouping_run_id
  //    is set, matching the pile's source.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO editor_runs (started_at, pile_id, triage_run_id, grouping_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3, $4, $5)
     RETURNING id`,
    [pileId, triageRunId, groupingRunId, model, pileItems.length],
  );
  const runId = runRows[0]!.id;

  try {
    // 7. Whole-pile call with primary-retry + fallback resilience.
    //    stream: true keeps the HTTP connection alive past undici's ~300s headers
    //    timeout — non-streaming calls don't send headers until the model finishes.
    //    Retry + fallback logic: attempt primary → retry primary once → fallback once.
    //    A parse collapse (< 50% lines) counts as failure; an imperfect-but-parsed
    //    paper does not. The fallback model is only invoked on genuine failure.
    const primaryCallOptions: LLMCallOptions = {
      stage: "editor",
      stageRunId: runId,
      model,
      systemPrompt,
      userPrompt,
      temperature,
      maxTokens,
      reasoningEffort,
      provider,
      timeoutMs,
      stream,
    };

    const fallbackConfig = stageConfig.fallback;
    let actualModelUsed = model;

    let parsed = await attemptEditorCall(runId, primaryCallOptions, pileItems, "primary attempt 1/2");

    if (parsed === null) {
      console.warn(`[editor] run #${runId}: primary attempt 1/2 failed — retrying primary`);
      parsed = await attemptEditorCall(runId, primaryCallOptions, pileItems, "primary attempt 2/2 (retry)");
    }

    if (parsed === null) {
      if (!fallbackConfig) {
        throw new Error(`primary model failed twice and no fallback is configured`);
      }
      const fallbackCallOptions: LLMCallOptions = {
        ...primaryCallOptions,
        model: fallbackConfig.model,
        provider: fallbackConfig.provider,
        reasoningEffort: fallbackConfig.reasoning_effort,
      };
      console.warn(
        `[editor] run #${runId}: primary model failed twice — invoking fallback model "${fallbackConfig.model}"`,
      );
      parsed = await attemptEditorCall(runId, fallbackCallOptions, pileItems, "fallback attempt");
      if (parsed !== null) {
        actualModelUsed = fallbackConfig.model;
      }
    }

    if (parsed === null) {
      throw new Error(`all attempts failed (primary ×2 + fallback ×1) — no acceptable paper produced`);
    }

    // Record which model actually produced the accepted output.
    if (actualModelUsed !== model) {
      await pool.query(`UPDATE editor_runs SET model_used = $1 WHERE id = $2`, [actualModelUsed, runId]);
      console.log(
        `[editor] run #${runId}: fallback model "${actualModelUsed}" produced accepted output — model_used updated`,
      );
    } else {
      console.log(`[editor] run #${runId}: primary model "${actualModelUsed}" produced accepted output`);
    }

    const logParts = [
      `model=${actualModelUsed}`,
      `parsed-lines=${parsed.parsedLineCount}/${pileItems.length}`,
      `missing=${parsed.missingCount}`,
      `unknown-refs=${parsed.unknownRefCount}`,
      `duplicates=${parsed.duplicateRefCount}`,
      `bad-tier=${parsed.badTierCount}`,
    ];
    const log = `[editor] run #${runId}: ${logParts.join(", ")}`;
    if (parsed.missingCount > 0 || parsed.unknownRefCount > 0 || parsed.duplicateRefCount > 0 || parsed.badTierCount > 0) {
      console.warn(log);
    } else {
      console.log(log);
    }

    // 8. Persist stories in final rank order (1-based), counting tiers along the way.
    const tierCounts: Record<EditorTier, number> = { feature: 0, standard: 0, brief: 0, cut: 0 };
    const INSERT_CHUNK = 500;
    for (let i = 0; i < parsed.results.length; i += INSERT_CHUNK) {
      const chunk = parsed.results.slice(i, i + INSERT_CHUNK);
      const placeholders = chunk
        .map((_r, j) => {
          const base = j * 7;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
        })
        .join(", ");
      const params: Array<number | string | null> = [];
      chunk.forEach((r, j) => {
        const rank = i + j + 1;
        tierCounts[r.tier]++;
        params.push(runId, r.itemType, r.clusterIndex, r.preprocessedItemId, r.tier, rank, r.reason);
      });
      await pool.query(
        `INSERT INTO editor_stories
           (run_id, item_type, cluster_index, preprocessed_item_id, tier, rank, reason)
         VALUES ${placeholders}`,
        params,
      );
    }

    // 9. Finalize run with per-tier counts.
    await pool.query(
      `UPDATE editor_runs
       SET completed_at   = NOW(),
           items_feature  = $1,
           items_standard = $2,
           items_brief    = $3,
           items_cut      = $4
       WHERE id = $5`,
      [tierCounts.feature, tierCounts.standard, tierCounts.brief, tierCounts.cut, runId],
    );

    return await fetchEditorRun(pool, runId);
  } catch (err) {
    await pool.query(
      `UPDATE editor_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId],
    );
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Editor run #${runId} failed: ${msg}`);
  }
}

async function fetchEditorRun(pool: import("pg").Pool, runId: number): Promise<EditorRun> {
  const { rows } = await pool.query<EditorRunRow>("SELECT * FROM editor_runs WHERE id = $1", [runId]);
  const r = rows[0]!;
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    pileId: r.pile_id,
    triageRunId: r.triage_run_id,
    groupingRunId: r.grouping_run_id,
    modelUsed: r.model_used,
    itemsIn: r.items_in,
    itemsFeature: r.items_feature,
    itemsStandard: r.items_standard,
    itemsBrief: r.items_brief,
    itemsCut: r.items_cut,
  };
}
