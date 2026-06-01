import "dotenv/config";
import { z } from "zod";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { assembleTriageDocument } from "../preprocessor/assembler.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompt.js";

const ClusterSchema = z.object({
  title: z.string(),
  item_ids: z.array(z.number().int()),
  summary: z.string(),
  notes: z.string().nullable(),
});

const TriageOutputSchema = z.object({
  clusters: z.array(ClusterSchema),
});

export type TriageCluster = z.infer<typeof ClusterSchema>;
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

function parseTriageOutput(text: string): TriageOutput | null {
  try {
    const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    const parsed: unknown = JSON.parse(stripped);
    return TriageOutputSchema.parse(parsed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[triage] digest parse failed: ${reason}`);
    console.warn(`[triage] first 500 chars: ${text.slice(0, 500)}`);
    return null;
  }
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
    // 4. Assemble the triage document from preprocessed items.
    const document = await assembleTriageDocument(preprocessorRunId);

    // 5. Call the LLM.
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

    // 6. Defensively parse the output. Warn on failure but do not throw.
    parseTriageOutput(result.text);

    // 7. Update triage_runs with results (store raw text regardless of parse outcome).
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

    // 8. Return completed run.
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
