import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM, type LLMProvider } from "../../llm/index.js";
import { getTriageItems } from "../preprocessor/assembler.js";
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

/**
 * Returns the set of news-routable preprocessed_item IDs from the latest
 * completed prefilter run for the given preprocessor run, or null if no
 * prefilter run exists. Mirrors the triage assembler's getPrefilterKeptIds —
 * same shape, same fallback (no run means no opinion, so nothing is excluded
 * on its account).
 *
 * Restricted to kind = 'news': opinion-kept items route to the Longer Reads
 * pool, not into clustering, so they must never be scored or ranked here
 * either — pass-1 only scores residual singletons from the news track. See
 * docs/decisions.md.
 */
async function getPrefilterKeptIds(
  pool: import("pg").Pool,
  preprocessorRunId: number,
): Promise<Set<number> | null> {
  const { rows: runRows } = await pool.query<{ id: number }>(
    `SELECT id FROM prefilter_runs
     WHERE preprocessor_run_id = $1 AND completed_at IS NOT NULL
     ORDER BY completed_at DESC LIMIT 1`,
    [preprocessorRunId],
  );
  if (!runRows[0]) return null;

  const prefilterRunId = runRows[0].id;
  const { rows: resultRows } = await pool.query<{ preprocessed_item_id: string }>(
    `SELECT preprocessed_item_id FROM prefilter_results
     WHERE run_id = $1 AND keep = true AND kind = 'news'`,
    [prefilterRunId],
  );
  return new Set(resultRows.map((r: { preprocessed_item_id: string }) => Number(r.preprocessed_item_id)));
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

  // 5. Fetch news-track preprocessed items for this run.
  //    Analysis items never enter a cluster, so without this filter they would
  //    all appear as residual singletons and receive scores — which is wrong.
  const { rows: allNewsItems } = await pool.query<PreprocessedItemRow>(
    `SELECT id, source_name, source_type, title, body_text
     FROM preprocessed_items
     WHERE preprocessor_run_id = $1 AND track = 'news'
     ORDER BY id ASC`,
    [preprocessorRunId],
  );

  // 6. Apply the bio-aware prefilter run, if a completed one exists for this
  //    preprocessor run — items it cut never reached clustering and should
  //    not be scored either. Mirrors the triage assembler's kept-set
  //    intersection; graceful fallback to scoring everything if no run exists.
  const prefilterKeptIds = await getPrefilterKeptIds(pool, preprocessorRunId);
  const allItems = prefilterKeptIds !== null
    ? allNewsItems.filter((item: PreprocessedItemRow) => (prefilterKeptIds as Set<number>).has(Number(item.id)))
    : allNewsItems;

  if (prefilterKeptIds !== null) {
    const cut = allNewsItems.length - allItems.length;
    console.log(
      `[editor-pass-1] prefilter run applied: ${allItems.length} kept, ${cut} cut`,
    );
  }

  // 7. Compute residual: items that appear in no cluster.
  const residuals = allItems.filter((item: PreprocessedItemRow) => !clusteredIds.has(Number(item.id)));

  console.log(
    `[editor-pass-1] triage run #${triageRunId}: ${allItems.length} total, ` +
    `${clusteredIds.size} clustered, ${residuals.length} residual singletons`,
  );

  // 8. Create editor_pass_1_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO editor_pass_1_runs (started_at, triage_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3)
     RETURNING id`,
    [triageRunId, model, residuals.length],
  );
  const runId = runRows[0]!.id;

  try {
    // 9. Partition into batches.
    const batches: PreprocessedItemRow[][] = [];
    for (let i = 0; i < residuals.length; i += batchSize) {
      batches.push(residuals.slice(i, i + batchSize));
    }

    // 10. Process batches concurrently — hard cap 3.
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

    // 11. Persist score-only results in chunks.
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

    // 12. Finalize run.
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

// --- GROUPING PASS-1 ---

export interface GroupingPass1Run {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  groupingRunId: number;
  modelUsed: string;
  itemsIn: number;
}

interface GroupingDigestRow {
  id: number;
  preprocessor_run_id: number;
  digest: string | null;
  completed_at: string | null;
}

interface GroupingPass1RunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  grouping_run_id: number;
  model_used: string;
  items_in: number;
}

interface ParsedGroupingCluster {
  clusterIndex: number;
  title: string;
  summary: string;
  memberIds: number[];
}

function parseGroupingDigest(digest: string): ParsedGroupingCluster[] {
  const clusters: ParsedGroupingCluster[] = [];
  let clusterIndex = 0;
  for (const rawLine of digest.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue;
    const title = line.slice(0, first).trim();
    const summary = line.slice(first + 2, last).trim();
    const idPart = line.slice(last + 2).trim();
    const memberIds: number[] = [];
    for (const tok of idPart.split(",")) {
      const t = tok.trim();
      if (/^\d+$/.test(t)) memberIds.push(parseInt(t, 10));
    }
    if (title && memberIds.length > 0) {
      clusters.push({ clusterIndex, title, summary, memberIds });
      clusterIndex++;
    }
  }
  return clusters;
}

async function processGroupingBatch(
  items: EditorPass1BatchItem[],
  batchIndex: number,
  batchCount: number,
  runId: number,
  model: string,
  temperature: number,
  maxTokens: number,
  systemPrompt: string,
  reasoningEffort: string | undefined,
  provider: LLMProvider | undefined,
  timeoutMs: number | undefined,
  stream: boolean | undefined,
): Promise<EditorPass1ItemResult[]> {
  try {
    const llmResult = await callLLM({
      stage: "grouping-pass-1",
      stageRunId: runId,
      model,
      systemPrompt,
      userPrompt: buildUserPrompt(items),
      temperature,
      maxTokens,
      reasoningEffort,
      provider,
      timeoutMs,
      stream,
    });

    const expectedIds = items.map((item) => item.id);
    const parsed = parseBatchOutput(llmResult.text, expectedIds);
    if (parsed === null) {
      console.warn(
        `[grouping-pass-1] batch ${batchIndex + 1}/${batchCount}: parse failed — defaulting all ${items.length} items to score=50`,
      );
      return items.map((item) => ({
        id: item.id,
        score: 50,
        reason: "fail-safe: batch parse error",
      }));
    }

    const log =
      `[grouping-pass-1] batch ${batchIndex + 1}/${batchCount}: ` +
      `parsed-lines=${parsed.parsedLineCount}/${items.length}; ` +
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
      `[grouping-pass-1] batch ${batchIndex + 1}/${batchCount}: LLM call failed (${msg}) — defaulting all ${items.length} items to score=50`,
    );
    return items.map((item) => ({
      id: item.id,
      score: 50,
      reason: "fail-safe: LLM error",
    }));
  }
}

export async function runGroupingPass1(
  options: { groupingRunId?: number; modelOverride?: string } = {},
): Promise<GroupingPass1Run> {
  const pool = getPool();

  // 1. Find grouping run (explicit id or latest completed).
  let groupingRunId: number;
  if (options.groupingRunId !== undefined) {
    groupingRunId = options.groupingRunId;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM grouping_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
    );
    if (!rows[0]) throw new Error("No completed grouping runs found");
    groupingRunId = rows[0].id;
  }

  // 2. Load grouping run and parse its digest.
  const { rows: grRows } = await pool.query<GroupingDigestRow>(
    "SELECT id, preprocessor_run_id, digest, completed_at FROM grouping_runs WHERE id = $1",
    [groupingRunId],
  );
  const groupingRun = grRows[0];
  if (!groupingRun) throw new Error(`Grouping run #${groupingRunId} not found`);
  if (!groupingRun.completed_at) throw new Error(`Grouping run #${groupingRunId} is not completed`);
  if (!groupingRun.digest) throw new Error(`Grouping run #${groupingRunId} has no digest`);

  const preprocessorRunId = groupingRun.preprocessor_run_id;
  const clusters = parseGroupingDigest(groupingRun.digest);
  const clusteredIds = new Set<number>(clusters.flatMap((c) => c.memberIds));

  // 3. Load model config (scoring reuses editor_pass_1 model settings).
  const modelConfig = loadModelConfig();
  const stageConfig = modelConfig.editor_pass_1;
  const model = options.modelOverride ?? stageConfig.model;
  const { temperature, max_tokens: maxTokens, batch_size: batchSize, concurrency } = stageConfig;
  const reasoningEffort = stageConfig.reasoning_effort;
  const provider = stageConfig.provider;
  const timeoutMs = stageConfig.timeout_ms;
  const stream = stageConfig.stream;

  // 4. Load all items the grouping run processed; identify singletons.
  const allItems = await getTriageItems(preprocessorRunId);
  const singletons = allItems.filter((item) => !clusteredIds.has(Number(item.id)));

  const totalItems = clusters.length + singletons.length;
  console.log(
    `[grouping-pass-1] grouping run #${groupingRunId}: ` +
      `${clusters.length} clusters, ${singletons.length} singletons = ${totalItems} total to score`,
  );

  // 5. Load bio and build system prompt.
  const systemPrompt = buildSystemPrompt(loadBio());

  // 6. Create grouping_pass1_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO grouping_pass1_runs (started_at, grouping_run_id, model_used, items_in)
     VALUES (NOW(), $1, $2, $3) RETURNING id`,
    [groupingRunId, model, totalItems],
  );
  const runId = runRows[0]!.id;

  try {
    // 7. Score clusters. Cluster index (0-based) serves as the scoring id.
    // Singletons use preprocessed_item_id (large BIGSERIAL) — no collision
    // possible within a batch type since clusters and singletons are scored
    // in separate passes.
    const clusterBatchItems: EditorPass1BatchItem[] = clusters.map((c) => ({
      id: c.clusterIndex,
      source: "cluster",
      type: "cluster",
      title: c.title,
      body_excerpt: c.summary.slice(0, 300),
    }));

    const clusterBatches: EditorPass1BatchItem[][] = [];
    for (let i = 0; i < clusterBatchItems.length; i += batchSize) {
      clusterBatches.push(clusterBatchItems.slice(i, i + batchSize));
    }

    const clusterLimit = pLimit(concurrency);
    const clusterBatchResults = await Promise.all(
      clusterBatches.map((batch, batchIdx) =>
        clusterLimit(() =>
          processGroupingBatch(
            batch, batchIdx, clusterBatches.length,
            runId, model, temperature, maxTokens,
            systemPrompt, reasoningEffort, provider, timeoutMs, stream,
          ),
        ),
      ),
    );
    const clusterResults = clusterBatchResults.flat();

    // 8. Score singletons.
    const singletonBatchItems: EditorPass1BatchItem[] = singletons.map((item) => ({
      id: Number(item.id),
      source: item.source_name,
      type: item.source_type,
      title: item.title,
      body_excerpt: (item.body_text ?? "").slice(0, 50),
    }));

    const singletonBatches: EditorPass1BatchItem[][] = [];
    for (let i = 0; i < singletonBatchItems.length; i += batchSize) {
      singletonBatches.push(singletonBatchItems.slice(i, i + batchSize));
    }

    const singletonLimit = pLimit(concurrency);
    const singletonBatchResults = await Promise.all(
      singletonBatches.map((batch, batchIdx) =>
        singletonLimit(() =>
          processGroupingBatch(
            batch, batchIdx, singletonBatches.length,
            runId, model, temperature, maxTokens,
            systemPrompt, reasoningEffort, provider, timeoutMs, stream,
          ),
        ),
      ),
    );
    const singletonResults = singletonBatchResults.flat();

    // 9. Persist results.
    const INSERT_CHUNK = 500;

    // Cluster rows: 5 params each (run_id, cluster_index, source_count, score, reason).
    for (let i = 0; i < clusterResults.length; i += INSERT_CHUNK) {
      const chunk = clusterResults.slice(i, i + INSERT_CHUNK);
      if (chunk.length === 0) continue;
      const placeholders = chunk
        .map((_, j) => {
          const base = j * 5;
          return `($${base + 1}, 'cluster', $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        })
        .join(", ");
      const params: Array<number | string> = [];
      for (const r of chunk) {
        const sourceCount = clusters[r.id]!.memberIds.length;
        params.push(runId, r.id, sourceCount, r.score, r.reason);
      }
      await pool.query(
        `INSERT INTO grouping_pass1_results (run_id, item_type, cluster_index, source_count, score, reason)
         VALUES ${placeholders}`,
        params,
      );
    }

    // Singleton rows: 4 params each (run_id, preprocessed_item_id, score, reason).
    // source_count defaults to 1.
    for (let i = 0; i < singletonResults.length; i += INSERT_CHUNK) {
      const chunk = singletonResults.slice(i, i + INSERT_CHUNK);
      if (chunk.length === 0) continue;
      const placeholders = chunk
        .map((_, j) => {
          const base = j * 4;
          return `($${base + 1}, 'singleton', $${base + 2}, 1, $${base + 3}, $${base + 4})`;
        })
        .join(", ");
      const params: Array<number | string> = [];
      for (const r of chunk) {
        params.push(runId, r.id, r.score, r.reason);
      }
      await pool.query(
        `INSERT INTO grouping_pass1_results (run_id, item_type, preprocessed_item_id, source_count, score, reason)
         VALUES ${placeholders}`,
        params,
      );
    }

    // 10. Finalize run.
    await pool.query(
      `UPDATE grouping_pass1_runs SET completed_at = NOW() WHERE id = $1`,
      [runId],
    );

    return await fetchGroupingPass1Run(pool, runId);
  } catch (err) {
    await pool.query(
      `UPDATE grouping_pass1_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId],
    );
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Grouping-pass-1 run #${runId} failed: ${msg}`);
  }
}

async function fetchGroupingPass1Run(
  pool: import("pg").Pool,
  runId: number,
): Promise<GroupingPass1Run> {
  const { rows } = await pool.query<GroupingPass1RunRow>(
    "SELECT * FROM grouping_pass1_runs WHERE id = $1",
    [runId],
  );
  const r = rows[0]!;
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    groupingRunId: r.grouping_run_id,
    modelUsed: r.model_used,
    itemsIn: r.items_in,
  };
}
