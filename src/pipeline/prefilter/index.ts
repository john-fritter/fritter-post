import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { callWithBackoff, type BackoffConfig } from "../../llm/backoff.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type PrefilterBatchItem,
} from "./prompt.js";

const BIO_PATH = path.join(import.meta.dirname, "..", "..", "..", "docs", "bio.md");

const BIO_FALLBACK =
  "(Reader bio not yet written. Apply generic conservative judgment: cut only " +
  "obvious noise — routine sports results, celebrity tabloid items, routine " +
  "market-movement noise, generic consumer-product marketing — and keep " +
  "everything else, including low-interest topics that carry a substantive " +
  "political, labor, legal, or cultural angle. When unsure, keep.)";

function loadBio(): string {
  try {
    const content = readFileSync(BIO_PATH, "utf-8").trim();
    return content.length > 0 ? content : BIO_FALLBACK;
  } catch {
    return BIO_FALLBACK;
  }
}

export type PrefilterVerdict = "cut" | "news" | "opinion";

export type PrefilterKind = "news" | "opinion";

export interface PrefilterItemResult {
  id: number;
  keep: boolean;
  kind: PrefilterKind;
  reason: string;
}

export interface PrefilterBatchParseResult {
  results: PrefilterItemResult[];
  parsedLineCount: number;
  failSafeCount: number;
}

interface PreprocessedItemRow {
  id: string;
  source_name: string;
  source_type: string;
  title: string;
  body_text: string | null;
}

export interface PrefilterRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  preprocessorRunId: number;
  modelUsed: string;
  itemsIn: number;
  itemsKept: number;
  itemsCut: number;
}

interface PrefilterRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  preprocessor_run_id: number;
  model_used: string;
  items_in: number;
  items_kept: number;
  items_cut: number;
}

/**
 * Defensive flat-line parser for the prefilter's verdict output: `id;;verdict;;reason`.
 * Mirrors editor-pass-1's parseBatchOutput shape exactly — same delimiter, same
 * column order, same per-item reconciliation — so the future score-swap only
 * has to change the middle column's meaning, not this parser's structure.
 *
 * Fail-safe direction is KEEP, and within keep, NEWS (never CUT, never
 * OPINION): an over-inclusive floor is recoverable downstream; a wrongly-cut
 * story is gone for good, and a wrongly-opinion-routed story never reaches
 * the daily paper at all. News is the safer of the two keep outcomes.
 * - Unparseable/missing lines fail-safe to keep as news.
 * - Unknown ids are dropped and logged.
 * - Duplicate ids keep the first occurrence.
 * - Invalid verdict values fail-safe to keep as news.
 */
export function parseBatchOutput(
  text: string,
  expectedIds: number[],
): PrefilterBatchParseResult {
  const expected = new Set(expectedIds);
  const parsed = new Map<number, PrefilterItemResult>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !/^\d+/.test(line)) continue;

    const firstDelimiter = line.indexOf(";;");
    if (firstDelimiter === -1) continue;
    const secondDelimiter = line.indexOf(";;", firstDelimiter + 2);
    if (secondDelimiter === -1) continue;

    const idField = line.slice(0, firstDelimiter).trim();
    const verdictField = line.slice(firstDelimiter + 2, secondDelimiter).trim().toLowerCase();
    const reason = line.slice(secondDelimiter + 2).trim();

    if (!/^\d+$/.test(idField)) continue;
    if (reason.length === 0) continue;

    const id = Number.parseInt(idField, 10);
    if (!expected.has(id) || parsed.has(id)) continue;

    let keep: boolean;
    let kind: PrefilterKind;
    if (verdictField === "news") {
      keep = true;
      kind = "news";
    } else if (verdictField === "opinion") {
      keep = true;
      kind = "opinion";
    } else if (verdictField === "cut") {
      keep = false;
      kind = "news";
    } else {
      console.warn(`[prefilter] invalid verdict "${verdictField}" for ${id} — fail-safe to keep as news`);
      keep = true;
      kind = "news";
    }

    parsed.set(id, { id, keep, kind, reason });
  }

  const results = expectedIds.map((id) =>
    parsed.get(id) ?? {
      id,
      keep: true,
      kind: "news" as const,
      reason: "fail-safe: missing/invalid line",
    },
  );

  return {
    results,
    parsedLineCount: parsed.size,
    failSafeCount: expectedIds.length - parsed.size,
  };
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
  reasoningEffort: string | undefined,
  backoff: BackoffConfig,
): Promise<PrefilterItemResult[]> {
  const batchPayload: PrefilterBatchItem[] = batch.map((item) => ({
    id: Number(item.id),
    source: item.source_name,
    type: item.source_type,
    title: item.title,
    body_excerpt: (item.body_text ?? "").slice(0, 50),
  }));

  try {
    const llmResult = await callWithBackoff(
      () =>
        callLLM({
          stage: "prefilter",
          stageRunId: runId,
          model,
          systemPrompt,
          userPrompt: buildUserPrompt(batchPayload),
          temperature,
          maxTokens,
          reasoningEffort,
        }),
      backoff,
      "prefilter",
    );

    const expectedIds = batch.map((item) => Number(item.id));
    const parsed = parseBatchOutput(llmResult.text, expectedIds);

    const log =
      `[prefilter] batch ${batchIndex + 1}/${batchCount}: ` +
      `parsed-lines=${parsed.parsedLineCount}/${batch.length}; ` +
      `fail-safe-kept=${parsed.failSafeCount}`;
    if (parsed.failSafeCount > 0) {
      console.warn(log);
    } else {
      console.log(log);
    }

    return parsed.results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[prefilter] batch ${batchIndex + 1}/${batchCount}: LLM call failed (${msg}) — keeping all ${batch.length} items as news`,
    );
    return batch.map((item) => ({
      id: Number(item.id),
      keep: true,
      kind: "news" as const,
      reason: "fail-safe: LLM error",
    }));
  }
}

export async function runPrefilter(
  options: {
    preprocessorRunId?: number;
    modelOverride?: string;
  } = {},
): Promise<PrefilterRun> {
  const pool = getPool();

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

  // 2. Load model config.
  const modelConfig = loadModelConfig();
  const stageConfig = modelConfig.prefilter;
  const model = options.modelOverride ?? stageConfig.model;
  const temperature = stageConfig.temperature;
  const maxTokens = stageConfig.max_tokens;
  const batchSize = stageConfig.batch_size;
  const concurrency = stageConfig.concurrency;
  const reasoningEffort = stageConfig.reasoning_effort;

  // 3. Load bio and build the (static per run) system prompt.
  const systemPrompt = buildSystemPrompt(loadBio());

  // 4. Fetch news-track preprocessed items for this run. The junk filter and
  //    same-parent dedup have already run at preprocess time — this is a
  //    separate, later, reader-relevance judgment over what survives them.
  const { rows: items } = await pool.query<PreprocessedItemRow>(
    `SELECT id, source_name, source_type, title, body_text
     FROM preprocessed_items
     WHERE preprocessor_run_id = $1 AND track = 'news'
     ORDER BY id ASC`,
    [preprocessorRunId],
  );

  // 5. Create prefilter_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO prefilter_runs (started_at, preprocessor_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3)
     RETURNING id`,
    [preprocessorRunId, model, items.length],
  );
  const runId = runRows[0]!.id;

  try {
    // 6. Partition into batches.
    const batches: PreprocessedItemRow[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }

    // 7. Process batches concurrently, capped by prefilter.concurrency.
    const limit = pLimit(concurrency);

    const batchResults = await Promise.all(
      batches.map((batch, batchIndex) =>
        limit(() =>
          processBatch(
            batch,
            batchIndex,
            batches.length,
            runId,
            model,
            temperature,
            maxTokens,
            systemPrompt,
            reasoningEffort,
            {
              retry_max_attempts: stageConfig.retry_max_attempts,
              retry_base_ms: stageConfig.retry_base_ms,
            },
          ),
        ),
      ),
    );

    const allResults = batchResults.flat();

    // 8. Log every CUT to stdout for audit, and tally the news/opinion split.
    //    Opinion-kept items route to the Longer Reads pool (same destination
    //    as track='analysis' items) — they never reach clustering. See
    //    docs/decisions.md.
    const itemMap = new Map<number, PreprocessedItemRow>(
      items.map((item: PreprocessedItemRow) => [Number(item.id), item]),
    );
    let itemsCut = 0;
    let itemsNews = 0;
    let itemsOpinion = 0;
    for (const result of allResults) {
      if (!result.keep) {
        const item = itemMap.get(result.id);
        console.log(
          `[prefilter] CUT [${result.id}] ${item?.source_name ?? "?"} | ${result.reason} | ${item?.title ?? "?"}`,
        );
        itemsCut++;
      } else if (result.kind === "opinion") {
        itemsOpinion++;
      } else {
        itemsNews++;
      }
    }
    const itemsKept = allResults.length - itemsCut;
    console.log(
      `[prefilter] split: ${allResults.length} in, ${itemsCut} cut, ` +
      `${itemsNews} kept-news, ${itemsOpinion} kept-opinion`,
    );

    // 9. Persist prefilter_results in chunks.
    const INSERT_CHUNK = 500;
    for (let i = 0; i < allResults.length; i += INSERT_CHUNK) {
      const chunk = allResults.slice(i, i + INSERT_CHUNK);
      const placeholders = chunk
        .map((_item: PrefilterItemResult, j: number) => {
          const base = j * 5;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        })
        .join(", ");
      const params: Array<number | boolean | string> = [];
      for (const r of chunk) {
        params.push(runId, r.id, r.keep, r.kind, r.reason);
      }
      await pool.query(
        `INSERT INTO prefilter_results (run_id, preprocessed_item_id, keep, kind, reason) VALUES ${placeholders}`,
        params,
      );
    }

    // 10. Finalize run.
    await pool.query(
      `UPDATE prefilter_runs
       SET completed_at = NOW(),
           items_kept   = $1,
           items_cut    = $2
       WHERE id = $3`,
      [itemsKept, itemsCut, runId],
    );

    return await fetchPrefilterRun(pool, runId);
  } catch (err) {
    await pool.query(
      `UPDATE prefilter_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId],
    );
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Prefilter run #${runId} failed: ${msg}`);
  }
}

async function fetchPrefilterRun(pool: import("pg").Pool, runId: number): Promise<PrefilterRun> {
  const { rows } = await pool.query<PrefilterRunRow>(
    "SELECT * FROM prefilter_runs WHERE id = $1",
    [runId],
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
    itemsCut: r.items_cut,
  };
}
