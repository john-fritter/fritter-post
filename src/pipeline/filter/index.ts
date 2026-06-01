import "dotenv/config";
import pLimit from "p-limit";
import { z } from "zod";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { buildSystemPrompt, buildUserPrompt, type FilterBatchItem } from "./prompt.js";

const FilterItemResultSchema = z.object({
  id: z.number().int(),
  keep: z.boolean(),
  reason: z.string(),
});

const FilterBatchOutputSchema = z.array(FilterItemResultSchema);

export type FilterItemResult = z.infer<typeof FilterItemResultSchema>;

interface PreprocessedItemRow {
  id: string;
  source_name: string;
  source_type: string;
  title: string;
}

export interface FilterRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  preprocessorRunId: number;
  modelUsed: string;
  itemsIn: number;
  itemsKept: number;
  itemsDropped: number;
}

interface FilterRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  preprocessor_run_id: number;
  model_used: string;
  items_in: number;
  items_kept: number;
  items_dropped: number;
}

function parseBatchOutput(text: string): FilterItemResult[] | null {
  try {
    const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    const parsed: unknown = JSON.parse(stripped);
    return FilterBatchOutputSchema.parse(parsed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[filter] batch parse failed: ${reason}`);
    return null;
  }
}

async function processBatch(
  batch: PreprocessedItemRow[],
  batchIndex: number,
  batchCount: number,
  runId: number,
  model: string,
  temperature: number,
  maxTokens: number,
  systemPrompt: string,
  reasoningEffort?: string
): Promise<FilterItemResult[]> {
  const batchPayload: FilterBatchItem[] = batch.map((item) => ({
    id: Number(item.id),
    source: item.source_name,
    type: item.source_type,
    title: item.title,
  }));

  try {
    const llmResult = await callLLM({
      stage: "filter",
      stageRunId: runId,
      model,
      systemPrompt,
      userPrompt: buildUserPrompt(batchPayload),
      temperature,
      maxTokens,
      reasoningEffort,
    });

    const parsed = parseBatchOutput(llmResult.text);
    if (parsed === null) {
      console.warn(
        `[filter] batch ${batchIndex + 1}/${batchCount}: parse failed — keeping all ${batch.length} items`
      );
      return batch.map((item) => ({
        id: Number(item.id),
        keep: true,
        reason: "parse-error-kept",
      }));
    }

    const resultMap = new Map(parsed.map((r) => [r.id, r]));
    return batch.map((item) => {
      const result = resultMap.get(Number(item.id));
      if (!result) {
        console.warn(
          `[filter] batch ${batchIndex + 1}: item ${item.id} missing from response — keeping`
        );
        return { id: Number(item.id), keep: true, reason: "missing-from-response-kept" };
      }
      return result;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[filter] batch ${batchIndex + 1}/${batchCount}: LLM call failed (${msg}) — keeping all ${batch.length} items`
    );
    return batch.map((item) => ({
      id: Number(item.id),
      keep: true,
      reason: "llm-error-kept",
    }));
  }
}

export async function runFilter(
  options: {
    preprocessorRunId?: number;
    modelOverride?: string;
  } = {}
): Promise<FilterRun> {
  const pool = getPool();

  // 1. Find preprocessor run (explicit id or latest).
  let preprocessorRunId: number;
  if (options.preprocessorRunId !== undefined) {
    preprocessorRunId = options.preprocessorRunId;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM preprocessor_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1"
    );
    if (!rows[0]) throw new Error("No completed preprocessor runs found");
    preprocessorRunId = rows[0].id;
  }

  // 2. Load config.
  const modelConfig = loadModelConfig();
  const model = options.modelOverride ?? modelConfig.filter.model;
  const temperature = modelConfig.filter.temperature;
  const maxTokens = modelConfig.filter.max_tokens;
  const batchSize = modelConfig.filter.batch_size;
  const concurrency = modelConfig.filter.concurrency;
  const reasoningEffort = modelConfig.filter.reasoning_effort;

  // 3. Fetch preprocessed items for this run.
  const { rows: items } = await pool.query<PreprocessedItemRow>(
    `SELECT id, source_name, source_type, title
     FROM preprocessed_items
     WHERE preprocessor_run_id = $1
     ORDER BY id ASC`,
    [preprocessorRunId]
  );

  // 4. Create filter_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO filter_runs (started_at, preprocessor_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3)
     RETURNING id`,
    [preprocessorRunId, model, items.length]
  );
  const runId = runRows[0]!.id;

  try {
    // 5. Partition into batches.
    const batches: PreprocessedItemRow[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }

    // 6. Process batches concurrently (hard cap: concurrency 3).
    const systemPrompt = buildSystemPrompt();
    const limit = pLimit(concurrency);

    const batchResults = await Promise.all(
      batches.map((batch, batchIndex) =>
        limit(() =>
          processBatch(batch, batchIndex, batches.length, runId, model, temperature, maxTokens, systemPrompt, reasoningEffort)
        )
      )
    );

    const allResults = batchResults.flat();

    // 7. Log every DROP to stdout for audit.
    const itemMap = new Map<number, PreprocessedItemRow>(
      items.map((item: PreprocessedItemRow) => [Number(item.id), item])
    );
    let itemsDropped = 0;
    for (const result of allResults) {
      if (!result.keep) {
        const item = itemMap.get(result.id);
        console.log(
          `[filter] DROP [${result.id}] ${item?.source_name ?? "?"} | ${result.reason} | ${item?.title ?? "?"}`
        );
        itemsDropped++;
      }
    }
    const itemsKept = allResults.length - itemsDropped;

    // 8. Persist filter_results in chunks.
    const INSERT_CHUNK = 500;
    for (let i = 0; i < allResults.length; i += INSERT_CHUNK) {
      const chunk = allResults.slice(i, i + INSERT_CHUNK);
      const placeholders = chunk
        .map((_item: FilterItemResult, j: number) => {
          const base = j * 4;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
        })
        .join(", ");
      const params: Array<number | boolean | string> = [];
      for (const r of chunk) {
        params.push(runId, r.id, r.keep, r.reason);
      }
      await pool.query(
        `INSERT INTO filter_results (filter_run_id, preprocessed_item_id, keep, reason) VALUES ${placeholders}`,
        params
      );
    }

    // 9. Finalize run.
    await pool.query(
      `UPDATE filter_runs
       SET completed_at = NOW(),
           items_kept   = $1,
           items_dropped = $2
       WHERE id = $3`,
      [itemsKept, itemsDropped, runId]
    );

    return await fetchFilterRun(pool, runId);
  } catch (err) {
    await pool.query(
      `UPDATE filter_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId]
    );
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Filter run #${runId} failed: ${msg}`);
  }
}

async function fetchFilterRun(pool: import("pg").Pool, runId: number): Promise<FilterRun> {
  const { rows } = await pool.query<FilterRunRow>(
    "SELECT * FROM filter_runs WHERE id = $1",
    [runId]
  );
  const r = rows[0]!;
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    preprocessorRunId: r.preprocessor_run_id,
    modelUsed: r.model_used,
    itemsIn: r.items_in,
    itemsKept: r.items_kept,
    itemsDropped: r.items_dropped,
  };
}
