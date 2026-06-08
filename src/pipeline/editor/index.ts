import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type EditorClusterPileItem,
  type EditorSingletonPileItem,
} from "./prompt.js";

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
    const ref = line.slice(firstDelimiter + 2, secondDelimiter).trim();
    const reason = line.slice(secondDelimiter + 2).trim();

    if (ref.length === 0 || reason.length === 0) continue;
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
  triageRunId: number;
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
  triage_run_id: number;
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

  // 2. Load the pile and its triage run's digest.
  const { rows: pileRows } = await pool.query<{ id: number; triage_run_id: number }>(
    "SELECT id, triage_run_id FROM editor_piles WHERE id = $1",
    [pileId],
  );
  const pile = pileRows[0];
  if (!pile) throw new Error(`Editor pile #${pileId} not found`);
  const triageRunId = pile.triage_run_id;

  const { rows: triageRows } = await pool.query<{ digest: string | null }>(
    "SELECT digest FROM triage_runs WHERE id = $1",
    [triageRunId],
  );
  const digest = triageRows[0]?.digest;
  if (!digest) throw new Error(`Triage run #${triageRunId} has no digest`);

  const digestClusters = parseDigestClusters(digest);
  if (digestClusters === null) {
    throw new Error(
      `Triage run #${triageRunId} digest could not be parsed — cannot resolve cluster details`,
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
  const clusterItems: EditorClusterPileItem[] = clusterPileRows
    .map((row) => {
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
    .sort((a, b) => b.sourceCount - a.sourceCount || a.clusterIndex - b.clusterIndex);

  const singletonItems: EditorSingletonPileItem[] = singletonPileRows.map((row) => ({
    ref: `S${row.preprocessed_item_id}`,
    preprocessedItemId: Number(row.preprocessed_item_id),
    title: row.title,
    bodyExcerpt: (row.body_text ?? "").replace(/\s+/g, " ").trim().slice(0, 50),
    pass1Score: row.score,
    pass1Reason: row.reason,
  }));

  const pileItems: EditorPileItem[] = [
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

  const standingMemo = loadTextFile(STANDING_MEMO_PATH, STANDING_MEMO_FALLBACK);
  const bio = loadTextFile(BIO_PATH, BIO_FALLBACK);
  const systemPrompt = buildSystemPrompt(standingMemo, bio);
  const userPrompt = buildUserPrompt(clusterItems, singletonItems);

  console.log(
    `[editor] pile #${pileId}: ${clusterItems.length} clusters, ${singletonItems.length} singletons, ` +
      `${pileItems.length} items total — one whole-pile call`,
  );

  // 6. Create editor_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO editor_runs (started_at, pile_id, triage_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3, $4)
     RETURNING id`,
    [pileId, triageRunId, model, pileItems.length],
  );
  const runId = runRows[0]!.id;

  try {
    // 7. The one whole-pile call. Ranking is relational, so this cannot be batched.
    const llmResult = await callLLM({
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
    });

    const parsed = parseEditorOutput(llmResult.text, pileItems);
    const logParts = [
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
    modelUsed: r.model_used,
    itemsIn: r.items_in,
    itemsFeature: r.items_feature,
    itemsStandard: r.items_standard,
    itemsBrief: r.items_brief,
    itemsCut: r.items_cut,
  };
}
