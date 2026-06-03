import "dotenv/config";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { assembleTriageDocument } from "../preprocessor/assembler.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";

export interface TriageCluster {
  title: string;
  item_ids: number[];
  summary: string;
  notes: string | null;
}

export interface TriageOutput {
  clusters: TriageCluster[];
}

export interface FlatClusterParseResult {
  clusters: TriageCluster[];
  fabricatedIds: number[];
  duplicateIds: number[];
  droppedSingletonCount: number;
  parsedLineCount: number;
}

/**
 * Parses the flat line-based cluster format:
 *   label;;summary;;id,id,id,...
 *
 * The id list is last so any ;; inside summary cannot shift the id column.
 * Validates each cluster against inputIds: drops fabricated ids (logs them),
 * records duplicates (logs them), and drops clusters with fewer than 2 valid ids.
 * Returns null only if the entire output has no parseable cluster lines.
 */
export function parseFlatClusterOutput(
  text: string,
  inputIds: Set<number>,
): FlatClusterParseResult | null {
  const seenIds = new Set<number>();
  const clusters: TriageCluster[] = [];
  const allFabricated: number[] = [];
  const allDuplicates: number[] = [];
  let parsedLineCount = 0;
  let droppedSingletonCount = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue; // only one ;; — needs exactly two distinct occurrences

    parsedLineCount++;

    const label = line.slice(0, first).trim();
    const summary = line.slice(first + 2, last).trim(); // absorbs any ;; inside summary
    const idPart = line.slice(last + 2).trim();

    if (label.length === 0 || summary.length === 0) {
      console.warn(`[triage] skipping malformed line: empty label or summary`);
      continue;
    }

    const fabricated: number[] = [];
    const duplicate: number[] = [];
    const validIds: number[] = [];

    for (const tok of idPart.split(",")) {
      const trimmed = tok.trim();
      if (!/^\d+$/.test(trimmed)) continue;
      const id = Number.parseInt(trimmed, 10);
      if (!inputIds.has(id)) {
        fabricated.push(id);
      } else if (seenIds.has(id)) {
        duplicate.push(id);
      } else {
        validIds.push(id);
        seenIds.add(id);
      }
    }

    if (fabricated.length > 0) {
      console.warn(`[triage] fabricated ids in cluster "${label}": ${fabricated.join(", ")}`);
      allFabricated.push(...fabricated);
    }
    if (duplicate.length > 0) {
      console.warn(`[triage] duplicate ids (appeared in earlier cluster): ${duplicate.join(", ")}`);
      allDuplicates.push(...duplicate);
    }

    if (validIds.length < 2) {
      console.warn(
        `[triage] dropped cluster "${label}": only ${validIds.length} valid id(s) after filtering`,
      );
      droppedSingletonCount++;
      continue;
    }

    clusters.push({ title: label, item_ids: validIds, summary, notes: null });
  }

  if (parsedLineCount === 0) {
    console.warn(`[triage] digest parse failed: no cluster lines found`);
    console.warn(`[triage] first 500 chars: ${text.slice(0, 500)}`);
    return null;
  }

  return {
    clusters,
    fabricatedIds: allFabricated,
    duplicateIds: allDuplicates,
    droppedSingletonCount,
    parsedLineCount,
  };
}

export interface TriageRun {
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

export async function runTriage(options: {
  preprocessorRunId?: number;
  modelOverride?: string;
} = {}): Promise<TriageRun> {
  const pool = getPool();

  // 1. Find preprocessor run (explicit id or latest).
  let preprocessorRunId: number;

  if (options.preprocessorRunId !== undefined) {
    preprocessorRunId = options.preprocessorRunId;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM preprocessor_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1"
    );
    if (!rows[0]) {
      throw new Error("No completed preprocessor runs found");
    }
    preprocessorRunId = rows[0].id;
  }

  // 2. Load model config and resolve model string.
  const modelConfig = loadModelConfig();
  const model = options.modelOverride ?? modelConfig.triage.model;
  const temperature = modelConfig.triage.temperature;
  const maxTokens = modelConfig.triage.max_tokens;
  const reasoningEffort = modelConfig.triage.reasoning_effort;

  // 3. Create triage_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO triage_runs (started_at, preprocessor_run_id, model_used)
     VALUES (NOW(), $1, $2)
     RETURNING id`,
    [preprocessorRunId, model]
  );
  const runId = runRows[0]!.id;

  try {
    // 4. Fetch input item ids for parse-time validation.
    const { rows: itemIdRows } = await pool.query<{ id: string }>(
      "SELECT id FROM preprocessed_items WHERE preprocessor_run_id = $1",
      [preprocessorRunId],
    );
    const inputIds = new Set<number>(itemIdRows.map((r: { id: string }) => Number(r.id)));

    // 5. Assemble the triage document from preprocessed items.
    const document = await assembleTriageDocument(preprocessorRunId);

    // 6. Call the LLM.
    const result = await callLLM({
      stage: "triage",
      stageRunId: runId,
      model,
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt(document),
      temperature,
      maxTokens,
      reasoningEffort,
    });

    // 7. Defensively parse the output. Warn on failure but do not throw.
    const parseResult = parseFlatClusterOutput(result.text, inputIds);
    if (parseResult !== null) {
      const parts = [
        `clusters=${parseResult.clusters.length}`,
        `lines=${parseResult.parsedLineCount}`,
      ];
      if (parseResult.fabricatedIds.length > 0) parts.push(`fabricated=${parseResult.fabricatedIds.length}`);
      if (parseResult.duplicateIds.length > 0) parts.push(`duplicates=${parseResult.duplicateIds.length}`);
      if (parseResult.droppedSingletonCount > 0) parts.push(`dropped-singletons=${parseResult.droppedSingletonCount}`);
      console.log(`[triage] run #${runId}: ${parts.join(", ")}`);
    }

    // 8. Update triage_runs with results (store raw text regardless of parse outcome).
    await pool.query(
      `UPDATE triage_runs
       SET completed_at       = NOW(),
           input_tokens       = $1,
           output_tokens      = $2,
           duration_ms        = $3,
           digest             = $4,
           generation_log_id  = $5
       WHERE id = $6`,
      [result.inputTokens, result.outputTokens, result.durationMs, result.text, result.generationLogId, runId]
    );

    // 9. Return completed run.
    return await fetchTriageRun(pool, runId);
  } catch (err) {
    // Mark run as failed with a note if it never completed.
    const msg = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE triage_runs
       SET completed_at = NOW()
       WHERE id = $1 AND completed_at IS NULL`,
      [runId]
    );
    throw new Error(`Triage run #${runId} failed: ${msg}`);
  }
}

interface TriageRunRow {
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

async function fetchTriageRun(pool: import("pg").Pool, runId: number): Promise<TriageRun> {
  const { rows } = await pool.query<TriageRunRow>(
    "SELECT * FROM triage_runs WHERE id = $1",
    [runId]
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
