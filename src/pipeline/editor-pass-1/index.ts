import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type EditorPass1BatchItem,
} from "./prompt.js";

const BIO_PATH = path.join(import.meta.dirname, "..", "..", "..", "docs", "bio.md");

const BIO_FALLBACK =
  "(Reader bio not yet written. Apply generic editorial judgment when scoring: " +
  "score routine sports results, celebrity tabloid items, routine financial market " +
  "noise, and generic wire filler near zero. Score substantive news from credible " +
  "sources higher. Use the full 0–100 range.)";

function loadBio(): string {
  try {
    const content = readFileSync(BIO_PATH, "utf-8").trim();
    return content.length > 0 ? content : BIO_FALLBACK;
  } catch {
    return BIO_FALLBACK;
  }
}

export interface EditorPass1ItemResult {
  id: number;
  score: number;
  reason: string;
}

export interface EditorPass1BatchParseResult {
  mode: "line";
  results: EditorPass1ItemResult[];
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

interface TriageRunRow {
  id: number;
  preprocessor_run_id: number;
  digest: string | null;
  completed_at: string | null;
}

export interface EditorPass1Run {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  triageRunId: number;
  modelUsed: string;
  itemsIn: number;
}

interface EditorPass1RunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  triage_run_id: number;
  model_used: string;
  items_in: number;
}

export function parseBatchOutput(
  text: string,
  expectedIds?: number[],
): EditorPass1BatchParseResult | null {
  if (expectedIds === undefined) return null;

  const expected = new Set(expectedIds);
  const parsed = new Map<number, EditorPass1ItemResult>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !/^\d+/.test(line)) continue;

    const firstDelimiter = line.indexOf(";;");
    if (firstDelimiter === -1) continue;
    const secondDelimiter = line.indexOf(";;", firstDelimiter + 2);
    if (secondDelimiter === -1) continue;

    const idField = line.slice(0, firstDelimiter).trim();
    const scoreField = line.slice(firstDelimiter + 2, secondDelimiter).trim();
    const reason = line.slice(secondDelimiter + 2).trim();

    if (!/^\d+$/.test(idField)) continue;
    if (!/^-?\d+$/.test(scoreField)) continue;
    if (reason.length === 0) continue;

    const id = Number.parseInt(idField, 10);
    if (!expected.has(id) || parsed.has(id)) continue;

    const rawScore = Number.parseInt(scoreField, 10);
    const score = Math.max(0, Math.min(100, rawScore));
    parsed.set(id, { id, score, reason });
  }

  const results = expectedIds.map((id) =>
    parsed.get(id) ?? {
      id,
      score: 50,
      reason: "fail-safe: missing/invalid line",
    },
  );

  return {
    mode: "line",
    results,
    parsedLineCount: parsed.size,
    failSafeCount: expectedIds.length - parsed.size,
  };
}

function extractClusteredIds(digest: string): Set<number> | null {
  const stripped = digest.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();

  // JSON format (old digests start with '{').
  if (stripped.startsWith("{")) {
    try {
      const parsed = JSON.parse(stripped) as { clusters?: Array<{ item_ids?: unknown[] }> };
      if (!Array.isArray(parsed.clusters)) return null;
      const ids = new Set<number>();
      for (const cluster of parsed.clusters) {
        if (Array.isArray(cluster.item_ids)) {
          for (const id of cluster.item_ids) {
            if (typeof id === "number") ids.add(id);
          }
        }
      }
      return ids;
    } catch {
      return null;
    }
  }

  // Flat line format: label;;summary;;id,id,...
  // Use first and last ;; so summary can contain ;; without disrupting the id column.
  const ids = new Set<number>();
  let lineCount = 0;
  for (const rawLine of digest.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue;
    lineCount++;
    const idPart = line.slice(last + 2).trim();
    for (const tok of idPart.split(",")) {
      const trimmed = tok.trim();
      if (/^\d+$/.test(trimmed)) ids.add(Number.parseInt(trimmed, 10));
    }
  }
  return lineCount > 0 ? ids : null;
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
): Promise<EditorPass1ItemResult[]> {
  const batchPayload: EditorPass1BatchItem[] = batch.map((item) => ({
    id: Number(item.id),
    source: item.source_name,
    type: item.source_type,
    title: item.title,
    body_excerpt: (item.body_text ?? "").slice(0, 50),
  }));

  try {
    const llmResult = await callLLM({
      stage: "editor-pass-1",
      stageRunId: runId,
      model,
      systemPrompt,
      userPrompt: buildUserPrompt(batchPayload),
      temperature,
      maxTokens,
      reasoningEffort,
    });

    const expectedIds = batch.map((item) => Number(item.id));
    const parsed = parseBatchOutput(llmResult.text, expectedIds);
    if (parsed === null) {
      // This is only possible if the parser is called without expected ids. Keep a
      // defensive whole-batch fail-safe, but normal model-output problems are
      // reconciled per item by parseBatchOutput.
      console.warn(
        `[editor-pass-1] batch ${batchIndex + 1}/${batchCount}: parse failed — defaulting all ${batch.length} items to score=50`,
      );
      return batch.map((item) => ({
        id: Number(item.id),
        score: 50,
        reason: "fail-safe: batch parse error",
      }));
    }

    const log =
      `[editor-pass-1] batch ${batchIndex + 1}/${batchCount}: ` +
      `parsed-lines=${parsed.parsedLineCount}/${batch.length}; ` +
      `fail-safe-defaulted=${parsed.failSafeCount}`;
    if (parsed.failSafeCount > 0) {
      console.warn(log);
    } else {
      console.log(log);
    }

    return parsed.results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[editor-pass-1] batch ${batchIndex + 1}/${batchCount}: LLM call failed (${msg}) — defaulting all ${batch.length} items to score=50`,
    );
    return batch.map((item) => ({
      id: Number(item.id),
      score: 50,
      reason: "fail-safe: LLM error",
    }));
  }
}

export async function runEditorPass1(
  options: {
    triageRunId?: number;
    modelOverride?: string;
  } = {},
): Promise<EditorPass1Run> {
  const pool = getPool();

  // 1. Find triage run (explicit id or latest completed).
  let triageRunId: number;
  if (options.triageRunId !== undefined) {
    triageRunId = options.triageRunId;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM triage_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
    );
    if (!rows[0]) throw new Error("No completed triage runs found");
    triageRunId = rows[0].id;
  }

  // 2. Load the triage run and parse its digest to identify clustered items.
  const { rows: triageRows } = await pool.query<TriageRunRow>(
    "SELECT id, preprocessor_run_id, digest, completed_at FROM triage_runs WHERE id = $1",
    [triageRunId],
  );
  const triageRun = triageRows[0];
  if (!triageRun) throw new Error(`Triage run #${triageRunId} not found`);
  if (!triageRun.completed_at) throw new Error(`Triage run #${triageRunId} is not completed`);
  if (!triageRun.digest) throw new Error(`Triage run #${triageRunId} has no digest`);

  const clusteredIds = extractClusteredIds(triageRun.digest);
  if (clusteredIds === null) {
    throw new Error(
      `Triage run #${triageRunId} digest could not be parsed — cannot determine residual singletons`,
    );
  }

  const preprocessorRunId = triageRun.preprocessor_run_id;

  // 3. Load model config.
  const modelConfig = loadModelConfig();
  const stageConfig = modelConfig.editor_pass_1;
  const model = options.modelOverride ?? stageConfig.model;
  const temperature = stageConfig.temperature;
  const maxTokens = stageConfig.max_tokens;
  const batchSize = stageConfig.batch_size;
  const concurrency = stageConfig.concurrency;
  const reasoningEffort = stageConfig.reasoning_effort;

  // 4. Load bio and build the (static per run) system prompt.
  const systemPrompt = buildSystemPrompt(loadBio());

  // 5. Fetch all preprocessed items for this run.
  const { rows: allItems } = await pool.query<PreprocessedItemRow>(
    `SELECT id, source_name, source_type, title, body_text
     FROM preprocessed_items
     WHERE preprocessor_run_id = $1
     ORDER BY id ASC`,
    [preprocessorRunId],
  );

  // 6. Compute residual: items that appear in no cluster.
  const residuals = allItems.filter((item: PreprocessedItemRow) => !clusteredIds.has(Number(item.id)));

  console.log(
    `[editor-pass-1] triage run #${triageRunId}: ${allItems.length} total, ` +
    `${clusteredIds.size} clustered, ${residuals.length} residual singletons`,
  );

  // 7. Create editor_pass_1_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO editor_pass_1_runs (started_at, triage_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3)
     RETURNING id`,
    [triageRunId, model, residuals.length],
  );
  const runId = runRows[0]!.id;

  try {
    // 8. Partition into batches.
    const batches: PreprocessedItemRow[][] = [];
    for (let i = 0; i < residuals.length; i += batchSize) {
      batches.push(residuals.slice(i, i + batchSize));
    }

    // 9. Process batches concurrently — hard cap 3.
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
          ),
        ),
      ),
    );

    const allResults = batchResults.flat();

    // 10. Persist score-only results in chunks.
    const INSERT_CHUNK = 500;
    for (let i = 0; i < allResults.length; i += INSERT_CHUNK) {
      const chunk = allResults.slice(i, i + INSERT_CHUNK);
      const placeholders = chunk
        .map((_item: EditorPass1ItemResult, j: number) => {
          const base = j * 4;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
        })
        .join(", ");
      const params: Array<number | string> = [];
      for (const r of chunk) {
        params.push(runId, r.id, r.score, r.reason);
      }
      await pool.query(
        `INSERT INTO editor_pass_1_results (run_id, preprocessed_item_id, score, reason) VALUES ${placeholders}`,
        params,
      );
    }

    // 11. Finalize run.
    await pool.query(
      `UPDATE editor_pass_1_runs
       SET completed_at = NOW()
       WHERE id = $1`,
      [runId],
    );

    return await fetchEditorPass1Run(pool, runId);
  } catch (err) {
    await pool.query(
      `UPDATE editor_pass_1_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId],
    );
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Editor-pass-1 run #${runId} failed: ${msg}`);
  }
}

async function fetchEditorPass1Run(
  pool: import("pg").Pool,
  runId: number,
): Promise<EditorPass1Run> {
  const { rows } = await pool.query<EditorPass1RunRow>(
    "SELECT * FROM editor_pass_1_runs WHERE id = $1",
    [runId],
  );
  const r = rows[0]!;
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    triageRunId: r.triage_run_id,
    modelUsed: r.model_used,
    itemsIn: r.items_in,
  };
}
