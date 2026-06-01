import "dotenv/config";
import pLimit from "p-limit";
import { z } from "zod";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { buildSystemPrompt, buildUserPrompt, type CategorizerBatchItem } from "./prompt.js";

const VALID_SECTIONS = new Set([
  "politics", "world", "business", "science_health",
  "technology", "sports", "culture", "local", "general",
]);

const CategorizerItemResultSchema = z.object({
  id: z.number().int(),
  sections: z.array(z.string()).min(1),
});

const CategorizerBatchOutputSchema = z.array(CategorizerItemResultSchema);

export type CategorizerItemResult = z.infer<typeof CategorizerItemResultSchema>;

interface PreprocessedItemRow {
  id: string;
  source_name: string;
  source_type: string;
  title: string;
}

export interface CategorizerRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  preprocessorRunId: number;
  modelUsed: string;
  itemsIn: number;
  itemsCategorized: number;
  fallbackCount: number;
}

interface CategorizerRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  preprocessor_run_id: number;
  model_used: string;
  items_in: number;
  items_categorized: number;
  fallback_count: number;
}

function parseBatchOutput(text: string): CategorizerItemResult[] | null {
  try {
    const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    const parsed: unknown = JSON.parse(stripped);
    return CategorizerBatchOutputSchema.parse(parsed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[categorizer] batch parse failed: ${reason}`);
    return null;
  }
}

function sanitizeSections(raw: string[]): string[] {
  const valid = raw.filter((s) => VALID_SECTIONS.has(s));
  return valid.length > 0 ? valid : ["general"];
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
  reasoningEffort: string | undefined
): Promise<{ results: CategorizerItemResult[]; fallbackCount: number }> {
  const batchPayload: CategorizerBatchItem[] = batch.map((item) => ({
    id: Number(item.id),
    source: item.source_name,
    type: item.source_type,
    title: item.title,
  }));

  const fallback = (): { results: CategorizerItemResult[]; fallbackCount: number } => ({
    results: batch.map((item) => ({ id: Number(item.id), sections: ["general"] })),
    fallbackCount: batch.length,
  });

  try {
    const llmResult = await callLLM({
      stage: "categorizer",
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
        `[categorizer] batch ${batchIndex + 1}/${batchCount}: parse failed — tagging all ${batch.length} items as general`
      );
      return fallback();
    }

    const resultMap = new Map(parsed.map((r) => [r.id, r]));
    let fallbackCount = 0;
    const results: CategorizerItemResult[] = batch.map((item) => {
      const result = resultMap.get(Number(item.id));
      if (!result) {
        console.warn(`[categorizer] batch ${batchIndex + 1}: item ${item.id} missing from response — tagging as general`);
        fallbackCount++;
        return { id: Number(item.id), sections: ["general"] };
      }
      return { id: Number(item.id), sections: sanitizeSections(result.sections) };
    });

    return { results, fallbackCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[categorizer] batch ${batchIndex + 1}/${batchCount}: LLM call failed (${msg}) — tagging all ${batch.length} items as general`
    );
    return fallback();
  }
}

export async function runCategorizer(
  options: {
    preprocessorRunId?: number;
    modelOverride?: string;
  } = {}
): Promise<CategorizerRun> {
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
  const model = options.modelOverride ?? modelConfig.categorizer.model;
  const temperature = modelConfig.categorizer.temperature;
  const maxTokens = modelConfig.categorizer.max_tokens;
  const batchSize = modelConfig.categorizer.batch_size;
  const concurrency = modelConfig.categorizer.concurrency;
  const reasoningEffort = modelConfig.categorizer.reasoning_effort;

  // 3. Fetch post-filter items for this run (uses latest completed filter run if one exists).
  const { rows: filterRunRows } = await pool.query<{ id: number }>(
    `SELECT id FROM filter_runs
     WHERE preprocessor_run_id = $1 AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`,
    [preprocessorRunId]
  );

  let items: PreprocessedItemRow[];
  if (filterRunRows[0]) {
    const filterRunId = filterRunRows[0].id;
    const { rows } = await pool.query<PreprocessedItemRow>(
      `SELECT pi.id, pi.source_name, pi.source_type, pi.title
       FROM preprocessed_items pi
       JOIN filter_results fr ON fr.preprocessed_item_id = pi.id
       WHERE pi.preprocessor_run_id = $1
         AND fr.filter_run_id = $2
         AND fr.keep = true
       ORDER BY pi.id ASC`,
      [preprocessorRunId, filterRunId]
    );
    items = rows;
    console.log(`[categorizer] filter run #${filterRunId}: ${items.length} kept items`);
  } else {
    const { rows } = await pool.query<PreprocessedItemRow>(
      `SELECT id, source_name, source_type, title
       FROM preprocessed_items
       WHERE preprocessor_run_id = $1
       ORDER BY id ASC`,
      [preprocessorRunId]
    );
    items = rows;
    console.log(`[categorizer] no filter run for preprocessor #${preprocessorRunId}; using all ${items.length} items`);
  }

  // 4. Create categorizer_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO categorizer_runs (started_at, preprocessor_run_id, model_used, items_in)
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
          processBatch(
            batch, batchIndex, batches.length,
            runId, model, temperature, maxTokens, systemPrompt, reasoningEffort
          )
        )
      )
    );

    const allResults = batchResults.flatMap((b) => b.results);
    const totalFallback = batchResults.reduce((sum, b) => sum + b.fallbackCount, 0);

    // 7. Persist categorizer_results in chunks.
    const INSERT_CHUNK = 500;
    for (let i = 0; i < allResults.length; i += INSERT_CHUNK) {
      const chunk = allResults.slice(i, i + INSERT_CHUNK);
      const placeholders = chunk
        .map((_item, j) => {
          const base = j * 3;
          return `($${base + 1}, $${base + 2}, $${base + 3}::jsonb)`;
        })
        .join(", ");
      const params: Array<number | string> = [];
      for (const r of chunk) {
        params.push(runId, r.id, JSON.stringify(r.sections));
      }
      await pool.query(
        `INSERT INTO categorizer_results (categorizer_run_id, preprocessed_item_id, sections) VALUES ${placeholders}`,
        params
      );
    }

    // 8. Finalize run.
    await pool.query(
      `UPDATE categorizer_runs
       SET completed_at      = NOW(),
           items_categorized = $1,
           fallback_count    = $2
       WHERE id = $3`,
      [allResults.length, totalFallback, runId]
    );

    return await fetchCategorizerRun(pool, runId);
  } catch (err) {
    await pool.query(
      `UPDATE categorizer_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId]
    );
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Categorizer run #${runId} failed: ${msg}`);
  }
}

async function fetchCategorizerRun(pool: import("pg").Pool, runId: number): Promise<CategorizerRun> {
  const { rows } = await pool.query<CategorizerRunRow>(
    "SELECT * FROM categorizer_runs WHERE id = $1",
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
    itemsCategorized: r.items_categorized,
    fallbackCount: r.fallback_count,
  };
}
