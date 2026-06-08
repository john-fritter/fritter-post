import "dotenv/config";
import OpenAI from "openai";
import { getPool } from "../db/index.js";

export interface LLMCallOptions {
  stage: string;
  stageRunId?: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
}

export interface LLMCallResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  generationLogId: bigint;
}

// Worst observed successful run plus headroom. The OpenAI SDK defaults to a
// 600s timeout with 2 silent retries — run #21 hung for 903s on a single
// "Request timed out" because of that combination, re-firing an expensive
// multi-minute reasoning call without anyone noticing. An explicit, shorter
// timeout with no SDK-level retries turns a provider hang into a clean,
// fast, diagnosable failure instead of a ~15-minute zombie. App-level
// retry-with-fallback is a deliberate later change, not a side effect of
// this fix — see docs/decisions.md "No retry logic in V1".
const LLM_TIMEOUT_MS = 360_000;
const LLM_MAX_RETRIES = 0;

function getClient(): OpenAI {
  const baseURL = process.env["LLM_BASE_URL"];
  const apiKey = process.env["LLM_API_KEY"];

  if (!baseURL) throw new Error("LLM_BASE_URL environment variable is required");
  if (!apiKey) throw new Error("LLM_API_KEY environment variable is required");

  return new OpenAI({ baseURL, apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES });
}

export async function callLLM(options: LLMCallOptions): Promise<LLMCallResult> {
  const { stage, stageRunId, model, systemPrompt, userPrompt, temperature, maxTokens, reasoningEffort } = options;
  const pool = getPool();
  const startMs = Date.now();

  let responseText: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let errorMsg: string | null = null;

  try {
    const client = getClient();

    const completionParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    };
    if (reasoningEffort !== undefined) {
      // reasoning_effort is not in OpenAI SDK types but is forwarded verbatim
      // to OpenAI-compatible endpoints. Double-cast narrowly — only this assignment.
      (completionParams as unknown as Record<string, unknown>)["reasoning_effort"] = reasoningEffort;
    }

    const completion = await client.chat.completions.create(completionParams);

    responseText = completion.choices[0]?.message?.content ?? null;
    inputTokens = completion.usage?.prompt_tokens ?? null;
    outputTokens = completion.usage?.completion_tokens ?? null;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startMs;

  if (errorMsg !== null) {
    console.error(
      `[llm] ${stage} call failed: model=${model} elapsed=${durationMs}ms error=${errorMsg}`
    );
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO generation_logs
       (stage, stage_run_id, model, system_prompt, user_prompt,
        response_text, input_tokens, output_tokens, duration_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      stage,
      stageRunId ?? null,
      model,
      systemPrompt,
      userPrompt,
      responseText,
      inputTokens,
      outputTokens,
      durationMs,
      errorMsg,
    ]
  );

  const generationLogId = BigInt(rows[0]!.id);

  if (errorMsg !== null) {
    throw new Error(`LLM call failed: ${errorMsg}`);
  }

  if (responseText === null) {
    throw new Error("LLM returned empty response");
  }

  return { text: responseText, inputTokens, outputTokens, durationMs, generationLogId };
}
