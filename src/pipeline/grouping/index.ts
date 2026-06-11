import "dotenv/config";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import type { GroupingDescribeConfig, GroupingAttachConfig } from "../../config/models.js";
import { embed, callLLM } from "../../llm/index.js";
import { getTriageItems, formatTriageItemBlocks } from "../preprocessor/assembler.js";
import type { PreprocessedItemRow } from "../preprocessor/assembler.js";
import { parseFlatClusterOutput } from "../triage/index.js";
import type { TriageCluster } from "../triage/index.js";
import {
  buildRefineSystemPrompt,
  buildRefineUserPrompt,
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

function formatFlatClusterLines(clusters: TriageCluster[]): string {
  return clusters.map((c) => `${c.title};;${c.summary};;${c.item_ids.join(",")}`).join("\n");
}

// Fallback label for a group that has no LLM description yet.
function buildAutoCluster(groupItems: PreprocessedItemRow[]): TriageCluster {
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

function formatAttachCandidateBlocks(
  candidates: Array<{ id: number }>,
  itemById: Map<number, PreprocessedItemRow>,
): string {
  return candidates
    .map(({ id }, idx) => {
      const item = itemById.get(id);
      if (!item) return `(${idx + 1}) [item ${id} not found]`;
      const body = item.body_text?.replace(/\s+/g, " ").trim().slice(0, 50) ?? "";
      return body.length > 0
        ? `(${idx + 1}) ${item.title}\n    ${body}`
        : `(${idx + 1}) ${item.title}`;
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
  clusters: TriageCluster[];
  remainingSingletonIds: Set<number>;
  clustersWithCandidates: number;
  candidatesOffered: number;
  attached: number;
  inputTokens: number | null;
  outputTokens: number | null;
  firstGenerationLogId: bigint | null;
}

async function attachSingletons(
  clusters: TriageCluster[],
  singletonIds: Set<number>,
  normalizedVectors: Map<number, number[]>,
  itemById: Map<number, PreprocessedItemRow>,
  config: GroupingAttachConfig,
  threshold: number,
  runId: number,
): Promise<AttachPassResult> {
  if (clusters.length === 0 || singletonIds.size === 0) {
    return {
      clusters,
      remainingSingletonIds: new Set(singletonIds),
      clustersWithCandidates: 0,
      candidatesOffered: 0,
      attached: 0,
      inputTokens: 0,
      outputTokens: 0,
      firstGenerationLogId: null,
    };
  }

  // For each cluster, find singletons whose max cosine sim to any cluster member
  // falls in [attach_floor, threshold) — the near-miss band.
  const clusterCandidates: Array<Array<{ id: number; maxSim: number }>> = clusters.map(
    (cluster) => {
      const candidates: Array<{ id: number; maxSim: number }> = [];
      for (const sId of singletonIds) {
        const sVec = normalizedVectors.get(sId);
        if (!sVec) continue;
        let maxSim = 0;
        for (const cId of cluster.item_ids) {
          const cVec = normalizedVectors.get(cId);
          if (!cVec) continue;
          const sim = dotProduct(sVec, cVec);
          if (sim > maxSim) maxSim = sim;
        }
        if (maxSim >= config.attach_floor && maxSim < threshold) {
          candidates.push({ id: sId, maxSim });
        }
      }
      candidates.sort((a, b) => b.maxSim - a.maxSim);
      return candidates;
    },
  );

  const clustersWithCandidates = clusterCandidates.filter((c) => c.length > 0).length;
  const totalCandidatesOffered = clusterCandidates.reduce((acc, c) => acc + c.length, 0);

  if (clustersWithCandidates === 0) {
    return {
      clusters,
      remainingSingletonIds: new Set(singletonIds),
      clustersWithCandidates: 0,
      candidatesOffered: 0,
      attached: 0,
      inputTokens: 0,
      outputTokens: 0,
      firstGenerationLogId: null,
    };
  }

  const limit = pLimit(config.concurrency);

  type AttachLLMResult = {
    clusterIdx: number;
    attachedIds: Set<number>;
    candidateMaxSims: Map<number, number>;
    inputTokens: number | null;
    outputTokens: number | null;
    generationLogId: bigint | null;
  };

  const llmResults = await Promise.all(
    clusters.map((cluster, clusterIdx) =>
      limit(async (): Promise<AttachLLMResult> => {
        const candidates = clusterCandidates[clusterIdx]!;
        const candidateMaxSims = new Map(candidates.map((c) => [c.id, c.maxSim]));

        if (candidates.length === 0) {
          return {
            clusterIdx,
            attachedIds: new Set(),
            candidateMaxSims,
            inputTokens: null,
            outputTokens: null,
            generationLogId: null,
          };
        }

        const clusterItems = cluster.item_ids
          .map((id) => itemById.get(id))
          .filter((i): i is PreprocessedItemRow => i !== undefined);
        const clusterBlocks = formatTriageItemBlocks(clusterItems);
        const candidateBlocks = formatAttachCandidateBlocks(candidates, itemById);

        try {
          const result = await callLLM({
            stage: "grouping",
            stageRunId: runId,
            model: config.model,
            systemPrompt: buildAttachSystemPrompt(),
            userPrompt: buildAttachUserPrompt(clusterBlocks, candidateBlocks),
            temperature: config.temperature,
            maxTokens: config.max_tokens,
            reasoningEffort: config.reasoning_effort,
            provider: config.provider,
            timeoutMs: config.timeout_ms,
            stream: config.stream,
          });

          const confirmedIndices = parseAttachOutput(result.text, candidates.length);
          const attachedIds = new Set(
            [...confirmedIndices].map((i) => candidates[i - 1]!.id),
          );

          return {
            clusterIdx,
            attachedIds,
            candidateMaxSims,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            generationLogId: result.generationLogId,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[grouping] attach: cluster ${clusterIdx} LLM call failed — no attachments: ${msg}`,
          );
          return {
            clusterIdx,
            attachedIds: new Set(),
            candidateMaxSims,
            inputTokens: null,
            outputTokens: null,
            generationLogId: null,
          };
        }
      }),
    ),
  );

  // Dedup: if a singleton was claimed by multiple clusters, assign to the one
  // with the highest max cosine similarity.
  const singletonWinner = new Map<number, { clusterIdx: number; maxSim: number }>();
  for (const r of llmResults) {
    for (const sId of r.attachedIds) {
      const maxSim = r.candidateMaxSims.get(sId) ?? 0;
      const current = singletonWinner.get(sId);
      if (current === undefined || maxSim > current.maxSim) {
        singletonWinner.set(sId, { clusterIdx: r.clusterIdx, maxSim });
      }
    }
  }

  const updatedClusters = clusters.map((cluster, clusterIdx) => {
    const toAttach = [...singletonWinner.entries()]
      .filter(([, v]) => v.clusterIdx === clusterIdx)
      .map(([sId]) => sId);
    if (toAttach.length === 0) return cluster;
    return { ...cluster, item_ids: [...cluster.item_ids, ...toAttach] };
  });

  const remainingSingletonIds = new Set(singletonIds);
  for (const sId of singletonWinner.keys()) remainingSingletonIds.delete(sId);

  let attachInputTokens: number | null = 0;
  let attachOutputTokens: number | null = 0;
  let attachFirstLogId: bigint | null = null;
  for (const r of llmResults) {
    if (r.inputTokens !== null) {
      attachInputTokens = attachInputTokens !== null ? attachInputTokens + r.inputTokens : null;
    } else if (r.generationLogId !== null) {
      attachInputTokens = null;
    }
    if (r.outputTokens !== null) {
      attachOutputTokens =
        attachOutputTokens !== null ? attachOutputTokens + r.outputTokens : null;
    } else if (r.generationLogId !== null) {
      attachOutputTokens = null;
    }
    if (r.generationLogId !== null && attachFirstLogId === null) {
      attachFirstLogId = r.generationLogId;
    }
  }

  return {
    clusters: updatedClusters,
    remainingSingletonIds,
    clustersWithCandidates,
    candidatesOffered: totalCandidatesOffered,
    attached: singletonWinner.size,
    inputTokens: attachInputTokens,
    outputTokens: attachOutputTokens,
    firstGenerationLogId: attachFirstLogId,
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
  clusters: TriageCluster[];
  inputTokens: number | null;
  outputTokens: number | null;
  firstGenerationLogId: bigint | null;
}

async function describeGroups(
  clusters: TriageCluster[],
  itemById: Map<number, PreprocessedItemRow>,
  config: GroupingDescribeConfig,
  runId: number,
): Promise<DescribePassResult> {
  if (clusters.length === 0) {
    return { clusters: [], inputTokens: 0, outputTokens: 0, firstGenerationLogId: null };
  }

  const limit = pLimit(config.concurrency);

  const batches: TriageCluster[][] = [];
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
            return `[CLUSTER ${localIdx}]\n${formatTriageItemBlocks(items)}`;
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

  const described: TriageCluster[] = [];
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
      `attach=${groupingConfig.attach.enabled}, refine=${groupingConfig.refine.enabled}`,
  );

  try {
    const stageStartedAt = Date.now();

    // --- STEP 1: EMBED ---
    const items = await getTriageItems(preprocessorRunId);
    console.log(`[grouping] step 1 embed: ${items.length} items to embed`);

    const embedTexts = items.map((item) => {
      const body = item.body_text?.replace(/\s+/g, " ").trim() ?? "";
      return body.length > 0 ? `${item.title}\n${body.slice(0, bodyCap)}` : item.title;
    });

    const batchSize = embConfig.batch_size;
    let embeddedCount = 0;
    for (let offset = 0; offset < items.length; offset += batchSize) {
      const batch = items.slice(offset, offset + batchSize);
      const batchTexts = embedTexts.slice(offset, offset + batchSize);

      const vectors = await embed(batchTexts, {
        stage: "grouping",
        stageRunId: runId,
        model: embConfig.model,
        provider: embConfig.provider,
        timeoutMs: embConfig.timeout_ms,
      });

      for (let i = 0; i < batch.length; i++) {
        const itemId = Number(batch[i]!.id);
        const vec = vectors[i]!;
        const vecStr = `[${vec.join(",")}]`;
        await pool.query(
          `INSERT INTO item_embeddings (preprocessed_item_id, model, dims, embedding)
           VALUES ($1, $2, $3, $4::vector)
           ON CONFLICT (preprocessed_item_id) DO UPDATE
             SET model      = EXCLUDED.model,
                 dims       = EXCLUDED.dims,
                 embedding  = EXCLUDED.embedding`,
          [itemId, embConfig.model, embConfig.dims, vecStr],
        );
        embeddedCount++;
      }
      console.log(`[grouping] embedded ${embeddedCount}/${items.length}`);
    }

    // --- STEP 2: CANDIDATE GROUPS ---
    const itemIds = items.map((i) => Number(i.id));

    const { rows: embRows } = await pool.query<{
      preprocessed_item_id: string;
      embedding: string;
    }>(
      `SELECT preprocessed_item_id, embedding::text
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
    for (const row of embRows) {
      const id = Number(row.preprocessed_item_id);
      const v = parseVectorText(row.embedding);
      const norm = l2Norm(v);
      if (norm > 0) normalizedVectors.set(id, v.map((x) => x / norm));
    }

    const embeddedIds = [...normalizedVectors.keys()];
    const edges = new Map<number, Set<number>>();
    for (const id of embeddedIds) edges.set(id, new Set());

    for (let i = 0; i < embeddedIds.length; i++) {
      const idA = embeddedIds[i]!;
      const vA = normalizedVectors.get(idA)!;
      const aboveThreshold: [number, number][] = [];
      for (let j = i + 1; j < embeddedIds.length; j++) {
        const idB = embeddedIds[j]!;
        const sim = dotProduct(vA, normalizedVectors.get(idB)!);
        if (sim >= threshold) aboveThreshold.push([idB, sim]);
      }
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
        `groups=${candidateGroups.length}, singletons=${singletonIds.size}` +
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
    // For each multi-item cluster, offer near-miss singletons ([attach_floor, threshold))
    // to a cheap LLM call. Confirmed singletons are absorbed; others remain isolated.
    let preClusters: TriageCluster[];
    let remainingSingletonIds: Set<number>;

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
        normalizedVectors,
        itemById,
        groupingConfig.attach,
        threshold,
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
        `[grouping] step 3 attach: clusters_with_candidates=${attachResult.clustersWithCandidates}, ` +
          `candidates_offered=${attachResult.candidatesOffered}, attached=${attachResult.attached}, ` +
          `singletons=${singletonIds.size}→${remainingSingletonIds.size}`,
      );
    }

    // --- STEP 4 (optional): BOUNDARY REFINE ---
    // When disabled, clusters from step 3 pass through as-is.
    let finalClusters: TriageCluster[];

    if (!groupingConfig.refine.enabled) {
      console.log(
        `[grouping] step 4 refine: disabled — ${preClusters.length} clusters pass through as-is`,
      );
      finalClusters = preClusters;
    } else {
      const minGroupSize = groupingConfig.refine.min_group_size;
      const inputIds = new Set<number>(itemIds);
      const refineLimit = pLimit(groupingConfig.refine.concurrency);

      type RefineResult = {
        clusters: TriageCluster[];
        inputTokens: number | null;
        outputTokens: number | null;
        generationLogId: bigint | null;
      };

      const refineResults = await Promise.all(
        preClusters.map((cluster) =>
          refineLimit(async (): Promise<RefineResult> => {
            if (cluster.item_ids.length < minGroupSize) {
              return {
                clusters: [cluster],
                inputTokens: null,
                outputTokens: null,
                generationLogId: null,
              };
            }

            const groupItems = cluster.item_ids
              .map((id) => itemById.get(id))
              .filter((i): i is PreprocessedItemRow => i !== undefined);
            const itemBlocks = formatTriageItemBlocks(groupItems);

            try {
              const result = await callLLM({
                stage: "grouping",
                stageRunId: runId,
                model,
                systemPrompt: buildRefineSystemPrompt(),
                userPrompt: buildRefineUserPrompt(itemBlocks),
                temperature: groupingConfig.temperature,
                maxTokens: groupingConfig.max_tokens,
                reasoningEffort: groupingConfig.reasoning_effort,
                provider: groupingConfig.provider,
                timeoutMs: groupingConfig.timeout_ms,
                stream: groupingConfig.stream,
              });

              const parsed = parseFlatClusterOutput(result.text, inputIds);
              if (parsed === null || parsed.clusters.length === 0) {
                console.warn(
                  `[grouping] refine parse failed for cluster of ${cluster.item_ids.length} items — keeping intact`,
                );
                return {
                  clusters: [cluster],
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens,
                  generationLogId: result.generationLogId,
                };
              }

              return {
                clusters: parsed.clusters,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                generationLogId: result.generationLogId,
              };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(
                `[grouping] refine call failed for cluster of ${cluster.item_ids.length} items — keeping intact: ${msg}`,
              );
              return {
                clusters: [cluster],
                inputTokens: null,
                outputTokens: null,
                generationLogId: null,
              };
            }
          }),
        ),
      );

      finalClusters = [];
      let refinedGroupCount = 0;
      let passedThroughCount = 0;

      for (let i = 0; i < preClusters.length; i++) {
        const r = refineResults[i]!;
        finalClusters.push(...r.clusters);

        if (preClusters[i]!.item_ids.length >= minGroupSize) {
          refinedGroupCount++;
        } else {
          passedThroughCount++;
        }

        accumulateTokens(r.inputTokens, r.outputTokens, r.generationLogId);
      }

      console.log(
        `[grouping] step 4 refine: refined=${refinedGroupCount}, passed_through=${passedThroughCount}, ` +
          `final_clusters=${finalClusters.length}`,
      );
    }

    // --- STEP 5: DESCRIBE ---
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
      `[grouping] step 5 describe: ${finalClusters.length} clusters described, ` +
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
