import "dotenv/config";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import type { GroupingDescribeConfig, GroupingAttachConfig } from "../../config/models.js";
import { embed, callLLM } from "../../llm/index.js";
import { getClusteringItems, formatItemBlocks } from "../preprocessor/assembler.js";
import type { PreprocessedItemRow } from "../preprocessor/assembler.js";
import type { Cluster } from "../../lib/cluster.js";
import {
  buildDescribeSystemPrompt,
  buildDescribeUserPrompt,
  buildAttachSystemPrompt,
  buildAttachUserPrompt,
} from "./prompt.js";

export interface GroupingRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  preprocessorRunId: number;
  modelUsed: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  digest: string | null;
  generationLogId: bigint | null;
}

// Parse pgvector text format "[v1,v2,...,vN]" returned by pg for vector columns.
function parseVectorText(s: string): number[] {
  return s.slice(1, -1).split(",").map(Number);
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function l2Norm(v: number[]): number {
  return Math.sqrt(dotProduct(v, v));
}

function formatFlatClusterLines(clusters: Cluster[]): string {
  return clusters.map((c) => `${c.title};;${c.summary};;${c.item_ids.join(",")}`).join("\n");
}

// Fallback label for a group that has no LLM description yet.
function buildAutoCluster(groupItems: PreprocessedItemRow[]): Cluster {
  const label = groupItems[0]!.title.slice(0, 80);
  const summary = groupItems.map((i) => i.title).join(" | ");
  return {
    title: label,
    item_ids: groupItems.map((i) => Number(i.id)),
    summary,
    notes: null,
  };
}

// --- ATTACH PASS ---

// A candidate for the attach pass: either an existing cluster or a standalone singleton.
export type AttachCandidate =
  | { type: "cluster"; clusterIdx: number; maxSim: number }
  | { type: "singleton"; id: number; sim: number };

// Pure function: given an anchor singleton, produce an ordered candidate list from
// the current cluster set and remaining singletons, scored by title-only cosine.
// Returns ALL candidates with title cosine >= candidateFloor, sorted by sim desc.
// candidate_floor is the sole per-anchor filter — no top-K cap. Dropping a genuine
// duplicate to save prompt space would violate dedup completeness. If prompt size
// for a very dense cluster ever becomes a real issue, the fix is batched LLM calls
// that union their confirmations, not a silent drop here.
// Exported for testing.
export function buildAttachCandidates(
  anchorId: number,
  clusters: ReadonlyArray<Cluster>,
  availableSingletonIds: ReadonlySet<number>,
  titleNormalizedVectors: ReadonlyMap<number, number[]>,
  candidateFloor: number,
): AttachCandidate[] {
  const anchorVec = titleNormalizedVectors.get(anchorId);
  if (!anchorVec) return [];

  const candidates: AttachCandidate[] = [];

  for (let cIdx = 0; cIdx < clusters.length; cIdx++) {
    const cluster = clusters[cIdx]!;
    let maxSim = 0;
    for (const memberId of cluster.item_ids) {
      const memberVec = titleNormalizedVectors.get(memberId);
      if (!memberVec) continue;
      const sim = dotProduct(anchorVec, memberVec);
      if (sim > maxSim) maxSim = sim;
    }
    if (maxSim >= candidateFloor) {
      candidates.push({ type: "cluster", clusterIdx: cIdx, maxSim });
    }
  }

  for (const sId of availableSingletonIds) {
    if (sId === anchorId) continue;
    const sVec = titleNormalizedVectors.get(sId);
    if (!sVec) continue;
    const sim = dotProduct(anchorVec, sVec);
    if (sim >= candidateFloor) {
      candidates.push({ type: "singleton", id: sId, sim });
    }
  }

  candidates.sort((a, b) => {
    const simA = a.type === "cluster" ? a.maxSim : a.sim;
    const simB = b.type === "cluster" ? b.maxSim : b.sim;
    return simB - simA;
  });

  return candidates;
}

function formatAnchorBlock(item: PreprocessedItemRow): string {
  const body = item.body_text?.replace(/\s+/g, " ").trim().slice(0, 50) ?? "";
  return body.length > 0 ? `${item.title}\n${body}` : item.title;
}

function formatMixedCandidateBlocks(
  candidates: AttachCandidate[],
  clusters: ReadonlyArray<Cluster>,
  itemById: Map<number, PreprocessedItemRow>,
): string {
  return candidates
    .map((cand, idx) => {
      const num = idx + 1;
      if (cand.type === "cluster") {
        const cluster = clusters[cand.clusterIdx]!;
        const memberLines = cluster.item_ids.slice(0, 3).map((id) => {
          const item = itemById.get(id);
          return `    - ${item ? item.title : `[item ${id}]`}`;
        });
        const extra =
          cluster.item_ids.length > 3 ? `\n    (+ ${cluster.item_ids.length - 3} more)` : "";
        return `(${num}) [Cluster: ${cluster.item_ids.length} articles]\n${memberLines.join("\n")}${extra}`;
      } else {
        const item = itemById.get(cand.id);
        if (!item) return `(${num}) [Article] [item ${cand.id} not found]`;
        const body = item.body_text?.replace(/\s+/g, " ").trim().slice(0, 50) ?? "";
        return body.length > 0
          ? `(${num}) [Article] ${item.title}\n    ${body}`
          : `(${num}) [Article] ${item.title}`;
      }
    })
    .join("\n");
}

function parseAttachOutput(text: string, candidateCount: number): Set<number> {
  const trimmed = text.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return new Set();
  const result = new Set<number>();
  for (const part of trimmed.split(/[\s,]+/)) {
    const n = parseInt(part.trim(), 10);
    if (!isNaN(n) && n >= 1 && n <= candidateCount) result.add(n);
  }
  return result;
}

interface AttachPassResult {
  clusters: Cluster[];
  remainingSingletonIds: Set<number>;
  candidatesOffered: number;
  attachedToCluster: number;
  newPairsFormed: number;
  inputTokens: number | null;
  outputTokens: number | null;
  firstGenerationLogId: bigint | null;
}

// Reworked attach pass: anchor-centric, title-embedding-based, covers both
// singleton→cluster and singleton↔singleton pairing. Processes anchors in
// descending best-title-sim order; consumed singletons are not reprocessed.
// New singleton pairs form 2-item clusters that subsequent anchors can attach to.
async function attachSingletons(
  clusters: Cluster[],
  singletonIds: Set<number>,
  titleNormalizedVectors: Map<number, number[]>,
  itemById: Map<number, PreprocessedItemRow>,
  config: GroupingAttachConfig,
  runId: number,
): Promise<AttachPassResult> {
  if (singletonIds.size === 0) {
    return {
      clusters,
      remainingSingletonIds: new Set(),
      candidatesOffered: 0,
      attachedToCluster: 0,
      newPairsFormed: 0,
      inputTokens: 0,
      outputTokens: 0,
      firstGenerationLogId: null,
    };
  }

  // Pre-compute best title-sim for each singleton to determine processing order.
  // Best-sim = max cosine(anchor, X) across all cluster members and other singletons.
  const allSingletonIds = [...singletonIds];
  type AnchorInfo = { id: number; bestSim: number };
  const anchorInfos: AnchorInfo[] = [];

  for (const anchorId of allSingletonIds) {
    const anchorVec = titleNormalizedVectors.get(anchorId);
    if (!anchorVec) {
      anchorInfos.push({ id: anchorId, bestSim: 0 });
      continue;
    }
    let bestSim = 0;
    for (const cluster of clusters) {
      for (const memberId of cluster.item_ids) {
        const mv = titleNormalizedVectors.get(memberId);
        if (!mv) continue;
        const s = dotProduct(anchorVec, mv);
        if (s > bestSim) bestSim = s;
      }
    }
    for (const otherId of allSingletonIds) {
      if (otherId === anchorId) continue;
      const ov = titleNormalizedVectors.get(otherId);
      if (!ov) continue;
      const s = dotProduct(anchorVec, ov);
      if (s > bestSim) bestSim = s;
    }
    anchorInfos.push({ id: anchorId, bestSim });
  }

  anchorInfos.sort((a, b) => b.bestSim - a.bestSim);
  const eligibleAnchors = anchorInfos.filter((a) => a.bestSim >= config.candidate_floor);

  if (eligibleAnchors.length === 0) {
    return {
      clusters,
      remainingSingletonIds: new Set(singletonIds),
      candidatesOffered: 0,
      attachedToCluster: 0,
      newPairsFormed: 0,
      inputTokens: 0,
      outputTokens: 0,
      firstGenerationLogId: null,
    };
  }

  // Mutable state threaded through the sequential loop.
  const currentClusters: Cluster[] = [...clusters];
  const remainingSingletonIds = new Set(singletonIds);

  let totalCandidatesOffered = 0;
  let attachedToCluster = 0;
  let newPairsFormed = 0;
  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let firstGenerationLogId: bigint | null = null;

  // Sequential processing: high-best-sim anchors are processed first. Each
  // confirmed match updates currentClusters and remainingSingletonIds before
  // the next anchor's candidates are built, so singleton pairs formed in an
  // earlier round are visible as cluster candidates in later rounds.
  const limit = pLimit(config.concurrency);

  for (const { id: anchorId } of eligibleAnchors) {
    if (!remainingSingletonIds.has(anchorId)) continue;

    const availableSingletons = new Set(remainingSingletonIds);
    availableSingletons.delete(anchorId);

    const candidates = buildAttachCandidates(
      anchorId,
      currentClusters,
      availableSingletons,
      titleNormalizedVectors,
      config.candidate_floor,
    );

    if (candidates.length === 0) continue;

    totalCandidatesOffered += candidates.length;

    const anchorItem = itemById.get(anchorId);
    if (!anchorItem) continue;

    const anchorBlock = formatAnchorBlock(anchorItem);
    const candidateBlocks = formatMixedCandidateBlocks(candidates, currentClusters, itemById);

    // p-limit wraps the single call; the outer loop awaits each before proceeding.
    const result = await limit(async () => {
      try {
        return await callLLM({
          stage: "grouping",
          stageRunId: runId,
          model: config.model,
          systemPrompt: buildAttachSystemPrompt(),
          userPrompt: buildAttachUserPrompt(anchorBlock, candidateBlocks),
          temperature: config.temperature,
          maxTokens: config.max_tokens,
          reasoningEffort: config.reasoning_effort,
          provider: config.provider,
          timeoutMs: config.timeout_ms,
          stream: config.stream,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[grouping] attach: anchor ${anchorId} LLM call failed: ${msg}`);
        return null;
      }
    });

    if (result === null) continue;

    if (result.inputTokens !== null) {
      totalInputTokens = totalInputTokens !== null ? totalInputTokens + result.inputTokens : null;
    } else if (result.generationLogId !== null) {
      totalInputTokens = null;
    }
    if (result.outputTokens !== null) {
      totalOutputTokens =
        totalOutputTokens !== null ? totalOutputTokens + result.outputTokens : null;
    } else if (result.generationLogId !== null) {
      totalOutputTokens = null;
    }
    if (result.generationLogId !== null && firstGenerationLogId === null) {
      firstGenerationLogId = result.generationLogId;
    }

    const confirmedIndices = parseAttachOutput(result.text, candidates.length);
    if (confirmedIndices.size === 0) continue;

    const confirmedClusters: Array<{ clusterIdx: number; maxSim: number }> = [];
    const confirmedSingletonIds: number[] = [];

    for (const idx of confirmedIndices) {
      const cand = candidates[idx - 1]!;
      if (cand.type === "cluster") {
        confirmedClusters.push({ clusterIdx: cand.clusterIdx, maxSim: cand.maxSim });
      } else {
        if (remainingSingletonIds.has(cand.id)) {
          confirmedSingletonIds.push(cand.id);
        }
      }
    }

    if (confirmedClusters.length > 0) {
      // Attach anchor (and any confirmed singletons) to the highest-sim cluster.
      confirmedClusters.sort((a, b) => b.maxSim - a.maxSim);
      const bestIdx = confirmedClusters[0]!.clusterIdx;
      const target = currentClusters[bestIdx]!;
      const toAdd = [anchorId, ...confirmedSingletonIds];
      currentClusters[bestIdx] = { ...target, item_ids: [...target.item_ids, ...toAdd] };
      for (const id of toAdd) {
        remainingSingletonIds.delete(id);
        attachedToCluster++;
      }
    } else if (confirmedSingletonIds.length > 0) {
      // Pair anchor with confirmed singletons — form a new cluster.
      const newMembers = [anchorId, ...confirmedSingletonIds];
      const groupItems = newMembers
        .map((id) => itemById.get(id))
        .filter((i): i is PreprocessedItemRow => i !== undefined);
      currentClusters.push(buildAutoCluster(groupItems));
      for (const id of newMembers) remainingSingletonIds.delete(id);
      newPairsFormed++;
    }
  }

  return {
    clusters: currentClusters,
    remainingSingletonIds,
    candidatesOffered: totalCandidatesOffered,
    attachedToCluster,
    newPairsFormed,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    firstGenerationLogId,
  };
}

// --- DESCRIBE PASS ---

interface DescribeParseResult {
  localIndex: number;
  title: string;
  summary: string;
}

function parseDescribeOutput(text: string, batchSize: number): Map<number, DescribeParseResult> {
  const results = new Map<number, DescribeParseResult>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue;
    const idxStr = line.slice(0, first).trim();
    if (!/^\d+$/.test(idxStr)) continue;
    const localIndex = parseInt(idxStr, 10);
    if (localIndex < 0 || localIndex >= batchSize) continue;
    const title = line.slice(first + 2, last).trim();
    const summary = line.slice(last + 2).trim();
    if (!title || !summary) continue;
    if (!results.has(localIndex)) results.set(localIndex, { localIndex, title, summary });
  }
  return results;
}

interface DescribePassResult {
  clusters: Cluster[];
  inputTokens: number | null;
  outputTokens: number | null;
  firstGenerationLogId: bigint | null;
}

async function describeGroups(
  clusters: Cluster[],
  itemById: Map<number, PreprocessedItemRow>,
  config: GroupingDescribeConfig,
  runId: number,
): Promise<DescribePassResult> {
  if (clusters.length === 0) {
    return { clusters: [], inputTokens: 0, outputTokens: 0, firstGenerationLogId: null };
  }

  const limit = pLimit(config.concurrency);

  const batches: Cluster[][] = [];
  for (let i = 0; i < clusters.length; i += config.batch_size) {
    batches.push(clusters.slice(i, i + config.batch_size));
  }

  type BatchResult = {
    descriptions: Map<number, { title: string; summary: string }>;
    inputTokens: number | null;
    outputTokens: number | null;
    generationLogId: bigint | null;
  };

  const batchResults = await Promise.all(
    batches.map((batch, batchIdx) =>
      limit(async (): Promise<BatchResult> => {
        const clusterBlocks = batch
          .map((cluster, localIdx) => {
            const items = cluster.item_ids
              .map((id) => itemById.get(id))
              .filter((i): i is PreprocessedItemRow => i !== undefined);
            return `[CLUSTER ${localIdx}]\n${formatItemBlocks(items)}`;
          })
          .join("\n");

        try {
          const result = await callLLM({
            stage: "grouping",
            stageRunId: runId,
            model: config.model,
            systemPrompt: buildDescribeSystemPrompt(),
            userPrompt: buildDescribeUserPrompt(clusterBlocks),
            temperature: config.temperature,
            maxTokens: config.max_tokens,
            reasoningEffort: config.reasoning_effort,
            provider: config.provider,
            timeoutMs: config.timeout_ms,
            stream: config.stream,
          });

          const parsed = parseDescribeOutput(result.text, batch.length);
          const descriptions = new Map<number, { title: string; summary: string }>();
          for (const [localIdx, r] of parsed) {
            descriptions.set(localIdx, { title: r.title, summary: r.summary });
          }

          const missing = batch.length - parsed.size;
          if (missing > 0) {
            console.warn(
              `[grouping] describe batch ${batchIdx + 1}/${batches.length}: ` +
                `${missing} cluster(s) missing from output — keeping fallback label`,
            );
          } else {
            console.log(
              `[grouping] describe batch ${batchIdx + 1}/${batches.length}: ` +
                `parsed ${parsed.size}/${batch.length}`,
            );
          }

          return {
            descriptions,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            generationLogId: result.generationLogId,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[grouping] describe batch ${batchIdx + 1}/${batches.length}: ` +
              `LLM failed — keeping fallback labels for all ${batch.length}: ${msg}`,
          );
          return {
            descriptions: new Map(),
            inputTokens: null,
            outputTokens: null,
            generationLogId: null,
          };
        }
      }),
    ),
  );

  const described: Cluster[] = [];
  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let firstGenerationLogId: bigint | null = null;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!;
    const result = batchResults[batchIdx]!;

    for (let localIdx = 0; localIdx < batch.length; localIdx++) {
      const cluster = batch[localIdx]!;
      const desc = result.descriptions.get(localIdx);
      described.push(desc ? { ...cluster, title: desc.title, summary: desc.summary } : cluster);
    }

    if (result.inputTokens !== null) {
      totalInputTokens = totalInputTokens !== null ? totalInputTokens + result.inputTokens : null;
    } else if (result.generationLogId !== null) {
      totalInputTokens = null;
    }
    if (result.outputTokens !== null) {
      totalOutputTokens =
        totalOutputTokens !== null ? totalOutputTokens + result.outputTokens : null;
    } else if (result.generationLogId !== null) {
      totalOutputTokens = null;
    }
    if (result.generationLogId !== null && firstGenerationLogId === null) {
      firstGenerationLogId = result.generationLogId;
    }
  }

  return {
    clusters: described,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    firstGenerationLogId,
  };
}

// --- MAIN EXPORT ---

export async function runGrouping(
  options: { preprocessorRunId?: number; modelOverride?: string } = {},
): Promise<GroupingRun> {
  const pool = getPool();
  const modelConfig = loadModelConfig();
  const groupingConfig = modelConfig.grouping;
  const embConfig = modelConfig.embeddings;

  // 1. Find preprocessor run (explicit id or latest completed).
  let preprocessorRunId: number;
  if (options.preprocessorRunId !== undefined) {
    preprocessorRunId = options.preprocessorRunId;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM preprocessor_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
    );
    if (!rows[0]) throw new Error("No completed preprocessor runs found");
    preprocessorRunId = rows[0].id;
  }

  const model = options.modelOverride ?? groupingConfig.model;
  const bodyCap = groupingConfig.embedding.body_cap;
  const threshold = groupingConfig.embedding.similarity_threshold;
  const topK = groupingConfig.embedding.top_k;

  // 2. Create grouping_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO grouping_runs (started_at, preprocessor_run_id, model_used)
     VALUES (NOW(), $1, $2) RETURNING id`,
    [preprocessorRunId, model],
  );
  const runId = runRows[0]!.id;
  console.log(`[grouping] run #${runId}: preprocessor_run_id=${preprocessorRunId}, model=${model}`);
  console.log(
    `[grouping] config: similarity_threshold=${threshold}, top_k=${topK}, ` +
      `attach=${groupingConfig.attach.enabled}`,
  );

  try {
    const stageStartedAt = Date.now();

    // --- STEP 1: EMBED ---
    // Compute two embeddings per item in the same batched loop:
    //   body embedding  = title + body[:body_cap]  (used for step-2 connected-components)
    //   title embedding = title only               (used for step-3 attach pass)
    const items = await getClusteringItems(preprocessorRunId);
    console.log(`[grouping] step 1 embed: ${items.length} items to embed`);

    const batchSize = embConfig.batch_size;
    let embeddedCount = 0;
    for (let offset = 0; offset < items.length; offset += batchSize) {
      const batch = items.slice(offset, offset + batchSize);

      // Build body and title embed texts from english_* columns so all clustering
      // happens in one English embedding space. Fallback to original title/body
      // for rows that pre-date the migration (english_title IS NULL).
      const bodyTexts = batch.map((item) => {
        const title = item.english_title ?? item.title;
        const body = (item.english_body ?? item.body_text)?.replace(/\s+/g, " ").trim() ?? "";
        return body.length > 0 ? `${title}\n${body.slice(0, bodyCap)}` : title;
      });
      const titleTexts = batch.map((item) => item.english_title ?? item.title);

      // Interleave [body0, title0, body1, title1, ...] so one API call covers both.
      const interleavedTexts = batch.flatMap((_, i) => [bodyTexts[i]!, titleTexts[i]!]);

      const vectors = await embed(interleavedTexts, {
        stage: "grouping",
        stageRunId: runId,
        model: embConfig.model,
        provider: embConfig.provider,
        timeoutMs: embConfig.timeout_ms,
      });

      for (let i = 0; i < batch.length; i++) {
        const itemId = Number(batch[i]!.id);
        const bodyVec = vectors[2 * i]!;
        const titleVec = vectors[2 * i + 1]!;
        const bodyVecStr = `[${bodyVec.join(",")}]`;
        const titleVecStr = `[${titleVec.join(",")}]`;
        await pool.query(
          `INSERT INTO item_embeddings (preprocessed_item_id, model, dims, embedding, title_embedding)
           VALUES ($1, $2, $3, $4::vector, $5::vector)
           ON CONFLICT (preprocessed_item_id) DO UPDATE
             SET model           = EXCLUDED.model,
                 dims            = EXCLUDED.dims,
                 embedding       = EXCLUDED.embedding,
                 title_embedding = EXCLUDED.title_embedding`,
          [itemId, embConfig.model, embConfig.dims, bodyVecStr, titleVecStr],
        );
        embeddedCount++;
      }
      console.log(`[grouping] embedded ${embeddedCount}/${items.length}`);
    }

    // --- STEP 2: CANDIDATE GROUPS ---
    // First-pass clustering runs on body embeddings at similarity_threshold,
    // deliberately conservative to keep a low false-merge rate.
    const itemIds = items.map((i) => Number(i.id));

    const { rows: embRows } = await pool.query<{
      preprocessed_item_id: string;
      embedding: string;
      title_embedding: string | null;
    }>(
      `SELECT preprocessed_item_id, embedding::text, title_embedding::text
       FROM item_embeddings
       WHERE preprocessed_item_id = ANY($1)`,
      [itemIds],
    );

    if (embRows.length < itemIds.length) {
      console.warn(
        `[grouping] ${itemIds.length - embRows.length} item(s) have no embedding — will be singletons`,
      );
    }

    const normalizedVectors = new Map<number, number[]>();
    const titleNormalizedVectors = new Map<number, number[]>();
    for (const row of embRows) {
      const id = Number(row.preprocessed_item_id);
      // Body embedding — used for connected-components (step 2).
      const v = parseVectorText(row.embedding);
      const norm = l2Norm(v);
      if (norm > 0) normalizedVectors.set(id, v.map((x) => x / norm));
      // Title embedding — used for the attach pass (step 3).
      if (row.title_embedding) {
        const tv = parseVectorText(row.title_embedding);
        const tnorm = l2Norm(tv);
        if (tnorm > 0) titleNormalizedVectors.set(id, tv.map((x) => x / tnorm));
      }
    }

    const embeddedIds = [...normalizedVectors.keys()];
    const edges = new Map<number, Set<number>>();
    for (const id of embeddedIds) edges.set(id, new Set());

    let totalPairsAboveThreshold = 0;
    for (let i = 0; i < embeddedIds.length; i++) {
      const idA = embeddedIds[i]!;
      const vA = normalizedVectors.get(idA)!;
      const aboveThreshold: [number, number][] = [];
      for (let j = i + 1; j < embeddedIds.length; j++) {
        const idB = embeddedIds[j]!;
        const sim = dotProduct(vA, normalizedVectors.get(idB)!);
        if (sim >= threshold) aboveThreshold.push([idB, sim]);
      }
      totalPairsAboveThreshold += aboveThreshold.length;
      aboveThreshold.sort((a, b) => b[1] - a[1]);
      for (const [idB] of aboveThreshold.slice(0, topK)) {
        edges.get(idA)!.add(idB);
        edges.get(idB)!.add(idA);
      }
    }

    const parent = new Map<number, number>();
    for (const id of embeddedIds) parent.set(id, id);

    function find(x: number): number {
      while (parent.get(x) !== x) {
        const px = parent.get(x)!;
        parent.set(x, parent.get(px)!);
        x = px;
      }
      return x;
    }

    function union(a: number, b: number): void {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    for (const [idA, neighbors] of edges) {
      for (const idB of neighbors) union(idA, idB);
    }

    const components = new Map<number, number[]>();
    for (const id of embeddedIds) {
      const root = find(id);
      const members = components.get(root);
      if (members) members.push(id);
      else components.set(root, [id]);
    }

    const itemById = new Map<number, PreprocessedItemRow>();
    for (const item of items) itemById.set(Number(item.id), item);

    const candidateGroups: PreprocessedItemRow[][] = [];
    const clusteredIds = new Set<number>();
    for (const members of components.values()) {
      if (members.length >= 2) {
        const sorted = members
          .map((id) => itemById.get(id)!)
          .sort((a, b) => Number(a.id) - Number(b.id));
        candidateGroups.push(sorted);
        for (const item of sorted) clusteredIds.add(Number(item.id));
      }
    }

    const singletonIds = new Set<number>();
    for (const id of itemIds) {
      if (!clusteredIds.has(id)) singletonIds.add(id);
    }

    const sizeDistribution = new Map<number, number>();
    for (const g of candidateGroups) {
      sizeDistribution.set(g.length, (sizeDistribution.get(g.length) ?? 0) + 1);
    }
    const distStr = [...sizeDistribution.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sz, n]) => `size=${sz}:${n}`)
      .join(", ");
    console.log(
      `[grouping] step 2 candidate groups: items=${embeddedIds.length}, ` +
        `groups=${candidateGroups.length}, singletons=${singletonIds.size}, ` +
        `pairs_above_threshold=${totalPairsAboveThreshold}` +
        (distStr.length > 0 ? `, size_distribution=[${distStr}]` : ""),
    );

    let totalInputTokens: number | null = 0;
    let totalOutputTokens: number | null = 0;
    let firstGenerationLogId: bigint | null = null;

    function accumulateTokens(
      inputTokens: number | null,
      outputTokens: number | null,
      generationLogId: bigint | null,
    ): void {
      if (inputTokens !== null) {
        totalInputTokens = totalInputTokens !== null ? totalInputTokens + inputTokens : null;
      } else if (generationLogId !== null) {
        totalInputTokens = null;
      }
      if (outputTokens !== null) {
        totalOutputTokens =
          totalOutputTokens !== null ? totalOutputTokens + outputTokens : null;
      } else if (generationLogId !== null) {
        totalOutputTokens = null;
      }
      if (generationLogId !== null && firstGenerationLogId === null) {
        firstGenerationLogId = generationLogId;
      }
    }

    // --- STEP 3: ATTACH ---
    // Anchor-centric, title-embedding-based. Covers two cases:
    //   singleton → existing cluster  (LLM confirms same event as cluster)
    //   singleton ↔ singleton         (LLM confirms same event; forms new cluster)
    // Sequential union-find: anchors processed in descending best-title-sim order;
    // consumed singletons are not reprocessed; newly formed pairs are available
    // as cluster candidates for subsequent anchors.
    let preClusters: Cluster[];
    let remainingSingletonIds: Set<number>;

    const singletonsBefore = singletonIds.size;

    if (!groupingConfig.attach.enabled) {
      console.log(
        `[grouping] step 3 attach: disabled — ${singletonIds.size} singletons unchanged`,
      );
      preClusters = candidateGroups.map(buildAutoCluster);
      remainingSingletonIds = new Set(singletonIds);
    } else {
      const initialClusters = candidateGroups.map(buildAutoCluster);
      const attachResult = await attachSingletons(
        initialClusters,
        singletonIds,
        titleNormalizedVectors,
        itemById,
        groupingConfig.attach,
        runId,
      );
      preClusters = attachResult.clusters;
      remainingSingletonIds = attachResult.remainingSingletonIds;
      accumulateTokens(
        attachResult.inputTokens,
        attachResult.outputTokens,
        attachResult.firstGenerationLogId,
      );
      console.log(
        `[grouping] step 3 attach: candidates_offered=${attachResult.candidatesOffered}, ` +
          `attached_to_cluster=${attachResult.attachedToCluster}, ` +
          `new_pairs_formed=${attachResult.newPairsFormed}, ` +
          `singletons=${singletonsBefore}→${remainingSingletonIds.size}`,
      );
    }

    let finalClusters: Cluster[] = preClusters;

    // --- STEP 4: DESCRIBE ---
    // Batch LLM pass that writes a neutral title + short summary for every
    // multi-item cluster. Singletons skip this pass.
    const describeResult = await describeGroups(
      finalClusters,
      itemById,
      groupingConfig.describe,
      runId,
    );
    finalClusters = describeResult.clusters;

    accumulateTokens(
      describeResult.inputTokens,
      describeResult.outputTokens,
      describeResult.firstGenerationLogId,
    );

    console.log(
      `[grouping] step 4 describe: ${finalClusters.length} clusters described, ` +
        `${remainingSingletonIds.size} singletons pass through unchanged`,
    );

    const digestText = formatFlatClusterLines(finalClusters);
    const totalDurationMs = Date.now() - stageStartedAt;

    await pool.query(
      `UPDATE grouping_runs
       SET completed_at      = NOW(),
           input_tokens      = $1,
           output_tokens     = $2,
           duration_ms       = $3,
           digest            = $4,
           generation_log_id = $5
       WHERE id = $6`,
      [totalInputTokens, totalOutputTokens, totalDurationMs, digestText, firstGenerationLogId, runId],
    );

    console.log(
      `[grouping] run #${runId} complete: ${finalClusters.length} clusters, ` +
        `${remainingSingletonIds.size} singletons, duration=${totalDurationMs}ms`,
    );

    return await fetchGroupingRun(pool, runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE grouping_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId],
    );
    throw new Error(`Grouping run #${runId} failed: ${msg}`);
  }
}

interface GroupingRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  preprocessor_run_id: number;
  model_used: string;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  digest: string | null;
  generation_log_id: string | null;
}

async function fetchGroupingRun(pool: import("pg").Pool, runId: number): Promise<GroupingRun> {
  const { rows } = await pool.query<GroupingRunRow>(
    "SELECT * FROM grouping_runs WHERE id = $1",
    [runId],
  );
  const r = rows[0]!;
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    preprocessorRunId: r.preprocessor_run_id,
    modelUsed: r.model_used,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    durationMs: r.duration_ms,
    digest: r.digest,
    generationLogId: r.generation_log_id !== null ? BigInt(r.generation_log_id) : null,
  };
}
