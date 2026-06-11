import "dotenv/config";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { embed, callLLM } from "../../llm/index.js";
import { getTriageItems, formatTriageItemBlocks } from "../preprocessor/assembler.js";
import type { PreprocessedItemRow } from "../preprocessor/assembler.js";
import { parseFlatClusterOutput } from "../triage/index.js";
import type { TriageCluster } from "../triage/index.js";
import { buildRefineSystemPrompt, buildRefineUserPrompt } from "./prompt.js";

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

// Build a cluster entry for a group that bypasses LLM refinement.
// Uses the first item's title as label and all titles joined as summary,
// which gives the editor enough orientation without an LLM call.
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
  const minGroupSize = groupingConfig.refine.min_group_size;

  // 2. Create grouping_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO grouping_runs (started_at, preprocessor_run_id, model_used)
     VALUES (NOW(), $1, $2) RETURNING id`,
    [preprocessorRunId, model],
  );
  const runId = runRows[0]!.id;
  console.log(`[grouping] run #${runId}: preprocessor_run_id=${preprocessorRunId}, model=${model}`);
  console.log(`[grouping] config: similarity_threshold=${threshold}, top_k=${topK}, min_group_size=${minGroupSize}`);

  try {
    const stageStartedAt = Date.now();

    // --- STEP 1: EMBED ---
    // Fetch the same item set as triage (post-filter, post-prefilter, news track only).
    const items = await getTriageItems(preprocessorRunId);
    console.log(`[grouping] step 1 embed: ${items.length} items to embed`);

    // Build embed text: title + capped body. The body_cap keeps each input
    // bounded so a single very long article doesn't dominate the vector.
    const embedTexts = items.map((item) => {
      const body = item.body_text?.replace(/\s+/g, " ").trim() ?? "";
      return body.length > 0 ? `${item.title}\n${body.slice(0, bodyCap)}` : item.title;
    });

    // Embed in batches, upsert results into item_embeddings.
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

      // Upsert one row per item. ON CONFLICT updates the vector so re-runs
      // with a different model or config don't leave stale embeddings.
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
    // Fetch stored embeddings for all items in this run in one query,
    // then compute cosine similarities in memory. For the pipeline's expected
    // N (100–1000 items), the O(N²) comparison is fast (~200ms at N=1000).
    // The top_k limit per item controls graph density — same intent as
    // pgvector's nearest-neighbor LIMIT, just done in JS to avoid N round-trips.
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

    // Build normalized vector map for cosine similarity via dot product.
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

    // For each item i, find its top-K neighbors above the threshold (among items j > i
    // to avoid double-counting), then add undirected edges in both directions.
    for (let i = 0; i < embeddedIds.length; i++) {
      const idA = embeddedIds[i]!;
      const vA = normalizedVectors.get(idA)!;
      const aboveThreshold: [number, number][] = [];
      for (let j = i + 1; j < embeddedIds.length; j++) {
        const idB = embeddedIds[j]!;
        const sim = dotProduct(vA, normalizedVectors.get(idB)!);
        if (sim >= threshold) aboveThreshold.push([idB, sim]);
      }
      // Take only the top-K neighbors to limit graph density.
      aboveThreshold.sort((a, b) => b[1] - a[1]);
      for (const [idB] of aboveThreshold.slice(0, topK)) {
        edges.get(idA)!.add(idB);
        edges.get(idB)!.add(idA);
      }
    }

    // Union-find connected components — same shape as mergeSpineClusters.
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

    // Build item lookup for auto-cluster label generation.
    const itemById = new Map<number, PreprocessedItemRow>();
    for (const item of items) itemById.set(Number(item.id), item);

    // Separate multi-item candidate groups from singletons.
    const candidateGroups: PreprocessedItemRow[][] = [];
    let singletonCount = 0;
    for (const members of components.values()) {
      if (members.length >= 2) {
        // Sort by original item order so output is deterministic.
        const sorted = members
          .map((id) => itemById.get(id)!)
          .sort((a, b) => Number(a.id) - Number(b.id));
        candidateGroups.push(sorted);
      } else {
        singletonCount++;
      }
    }
    // Items with no embeddings are implicitly singletons.
    singletonCount += itemIds.length - embRows.length;

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
        `groups=${candidateGroups.length}, singletons=${singletonCount}` +
        (distStr.length > 0 ? `, size_distribution=[${distStr}]` : ""),
    );

    // --- STEP 3: BOUNDARY REFINE ---
    // Large candidate groups go to LLM for a "same event or split?" judgment.
    // Small groups and singletons pass through unchanged.
    const inputIds = new Set<number>(itemIds);
    const refineLimit = pLimit(groupingConfig.refine.concurrency);

    type RefineResult = {
      clusters: TriageCluster[];
      inputTokens: number | null;
      outputTokens: number | null;
      generationLogId: bigint | null;
    };

    const refineResults = await Promise.all(
      candidateGroups.map((groupItems) =>
        refineLimit(async (): Promise<RefineResult> => {
          if (groupItems.length < minGroupSize) {
            return { clusters: [buildAutoCluster(groupItems)], inputTokens: null, outputTokens: null, generationLogId: null };
          }

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
                `[grouping] refine parse failed for group of ${groupItems.length} items — keeping intact`,
              );
              return {
                clusters: [buildAutoCluster(groupItems)],
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
              `[grouping] refine call failed for group of ${groupItems.length} items — keeping intact: ${msg}`,
            );
            return { clusters: [buildAutoCluster(groupItems)], inputTokens: null, outputTokens: null, generationLogId: null };
          }
        }),
      ),
    );

    // Collect final clusters and aggregate token counts.
    const finalClusters: TriageCluster[] = [];
    let totalInputTokens: number | null = 0;
    let totalOutputTokens: number | null = 0;
    let firstGenerationLogId: bigint | null = null;
    let refinedGroupCount = 0;
    let passedThroughCount = 0;

    for (let i = 0; i < candidateGroups.length; i++) {
      const r = refineResults[i]!;
      finalClusters.push(...r.clusters);

      if (candidateGroups[i]!.length >= minGroupSize) {
        refinedGroupCount++;
      } else {
        passedThroughCount++;
      }

      if (r.inputTokens !== null) {
        totalInputTokens = totalInputTokens !== null ? totalInputTokens + r.inputTokens : null;
      } else if (r.generationLogId !== null) {
        // LLM call happened but tokens were null — mark total unknown.
        totalInputTokens = null;
      }
      if (r.outputTokens !== null) {
        totalOutputTokens = totalOutputTokens !== null ? totalOutputTokens + r.outputTokens : null;
      } else if (r.generationLogId !== null) {
        totalOutputTokens = null;
      }
      if (r.generationLogId !== null && firstGenerationLogId === null) {
        firstGenerationLogId = r.generationLogId;
      }
    }

    console.log(
      `[grouping] step 3 refine: refined=${refinedGroupCount}, passed_through=${passedThroughCount}, ` +
        `final_clusters=${finalClusters.length}`,
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
        `${singletonCount} singletons, duration=${totalDurationMs}ms`,
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
