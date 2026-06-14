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

const BIO_FALLBACK =
  "(Reader bio not yet written. Apply generic editorial judgment: weight " +
  "substantive accountability journalism and stories with direct stakes for an " +
  "ordinary reader; send routine sports, celebrity, and market-noise items toward " +
  "the bottom tiers or cut them outright.)";

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
 * Recognition-based parser for the editor's ranked output.
 *
 * The contract with the model is `tier;;ref;;reason`, but reasoning models
 * routinely reorder fields, add line numbers, or bracket refs. This parser
 * finds tier and ref by RECOGNITION rather than position:
 *   - tier:  the first ;;-segment whose lowercased content is in VALID_TIERS
 *   - ref:   the first non-tier ;;-segment containing a C/S pattern (via normalizeRef)
 *   - reason: all remaining segments joined back with ;;
 *
 * All these shapes for the same item parse correctly:
 *   "feature;;C3;;reason"       (specified format)
 *   "C3;;feature;;reason"       (swapped — kimi does this)
 *   "1. C3;;feature;;reason"    (numbered + swapped)
 *   "feature;;[C3];;reason"     (bracketed ref)
 *
 * A line is only valid if both tier and ref are found; lines with neither are
 * silently skipped — they do not inflate parsedLineCount or trigger badTier
 * accounting. The fail-safe for genuinely-absent items is applied at the end,
 * unchanged.
 */
export function parseEditorOutput(text: string, pileItems: EditorPileItem[]): EditorParseResult {
  const byRef = new Map<string, EditorPileItem>();
  for (const item of pileItems) byRef.set(item.ref, item);

  const seen = new Set<string>();
  const ordered: EditorStoryResult[] = [];
  let parsedLineCount = 0;
  let unknownRefCount = 0;
  let duplicateRefCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !line.includes(";;")) continue;

    const parts = line.split(";;");
    if (parts.length < 3) continue;

    // Find tier: first segment that matches a valid tier word exactly.
    let tier: EditorTier | null = null;
    let tierIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      const lower = parts[i]!.trim().toLowerCase();
      if (VALID_TIERS.has(lower as EditorTier)) {
        tier = lower as EditorTier;
        tierIdx = i;
        break;
      }
    }
    if (tier === null) continue; // no valid tier word in any segment → skip

    // Find ref: first non-tier segment containing a C/S pattern.
    let ref: string | null = null;
    let refIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (i === tierIdx) continue;
      const r = normalizeRef(parts[i]!);
      if (r) {
        ref = r;
        refIdx = i;
        break;
      }
    }
    if (ref === null) continue; // no ref token in any segment → skip

    // Reason: remaining segments (everything that's neither tier nor ref).
    const reason = parts
      .filter((_, i) => i !== tierIdx && i !== refIdx)
      .join(";;")
      .trim();
    if (reason.length === 0) continue;

    // Count this line: it had a recognizable tier and ref token.
    parsedLineCount++;

    const pileItem = byRef.get(ref);
    if (!pileItem) {
      console.warn(`[editor] unknown ref in output (dropped): ${ref}`);
      unknownRefCount++;
      continue;
    }
    if (seen.has(ref)) {
      console.warn(`[editor] duplicate ref in output (kept first occurrence): ${ref}`);
      duplicateRefCount++;
      continue;
    }
    seen.add(ref);
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
    badTierCount: 0, // no longer meaningful with recognition-based parsing
  };
}

export interface EditorRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  pileId: number;
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

  // 2. Load the pile and resolve its cluster source. A pile comes from the
  //    embedding-based grouping stage (grouping_run_id set), and may also have
  //    been through the optional pile-merge pass (pile_merge_run_id set), which
  //    stores the final pile as JSONB.
  const { rows: pileRows } = await pool.query<{
    id: number;
    grouping_run_id: number | null;
    pile_merge_run_id: number | null;
  }>(
    "SELECT id, grouping_run_id, pile_merge_run_id FROM editor_piles WHERE id = $1",
    [pileId],
  );
  const pile = pileRows[0];
  if (!pile) throw new Error(`Editor pile #${pileId} not found`);
  const groupingRunId = pile.grouping_run_id;
  const pileMergeRunId = pile.pile_merge_run_id;

  const bio = loadTextFile(BIO_PATH, BIO_FALLBACK);

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
          // Promoted-singleton merges (clusterIndex null) have no digest entry.
          // Carry preprocessedItemId so the identity survives into editor_stories
          // and the writer stage can resolve source articles via originalRefs.
          preprocessedItemId: e.clusterIndex === null ? e.preprocessedItemId : null,
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

    userPrompt = buildMergedUserPrompt(mergedBlocks, bio);
    console.log(`[editor] pile #${pileId}: merged pile (pile-merge run #${pileMergeRunId})`);
  } else {
    // Normal path: resolve cluster details from the grouping run's digest, then
    // load and present items from editor_pile_items.
    if (groupingRunId === null) {
      throw new Error(`Editor pile #${pileId} references no grouping run`);
    }
    // Resolve cluster details from the grouping run's digest using the SAME
    // parser the scorer used to assign editor_pile_items.cluster_index, so
    // indices align by construction. Source count per cluster is its
    // member-id count.
    const { rows: groupingRows } = await pool.query<{ digest: string | null }>(
      "SELECT digest FROM grouping_runs WHERE id = $1",
      [groupingRunId],
    );
    const digest = groupingRows[0]?.digest;
    if (!digest) throw new Error(`Grouping run #${groupingRunId} has no digest`);

    const digestClusters: DigestCluster[] = parseGroupingDigest(digest).map((c) => ({
      index: c.clusterIndex,
      title: c.title,
      summary: c.summary,
      notes: null,
      itemCount: c.memberIds.length,
    }));
    const clusterByIndex = new Map(digestClusters.map((c) => [c.index, c]));

    // 3. Load in-pile items: clusters (by grouping digest index) and singletons
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

    userPrompt = buildUserPrompt(clusterItems, singletonItems, bio);
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

  const systemPrompt = buildSystemPrompt();

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

  // 6. Create editor_runs row, recording the grouping run the pile came from.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO editor_runs (started_at, pile_id, grouping_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3, $4)
     RETURNING id`,
    [pileId, groupingRunId, model, pileItems.length],
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
    groupingRunId: r.grouping_run_id,
    modelUsed: r.model_used,
    itemsIn: r.items_in,
    itemsFeature: r.items_feature,
    itemsStandard: r.items_standard,
    itemsBrief: r.items_brief,
    itemsCut: r.items_cut,
  };
}
