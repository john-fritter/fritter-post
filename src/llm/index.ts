import "dotenv/config";
import OpenAI from "openai";
import { getPool } from "../db/index.js";

export type LLMProvider = "ollama-cloud" | "nanogpt";

export interface LLMCallOptions {
  stage: string;
  stageRunId?: number;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  provider?: LLMProvider;
  timeoutMs?: number;
  stream?: boolean;
}

export interface LLMCallResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  generationLogId: bigint;
}

// Default timeout. The OpenAI SDK defaults to a 600s timeout with 2 silent
// retries — run #21 hung for 903s on a single "Request timed out" because of
// that combination, re-firing an expensive multi-minute reasoning call without
// anyone noticing. An explicit timeout with no SDK-level retries turns a
// provider hang into a clean, fast, diagnosable failure. The default 360s is
// generous enough for long reasoning calls; stages can override via timeout_ms
// in models.yaml. See docs/decisions.md "No retry logic in V1".
const DEFAULT_TIMEOUT_MS = 360_000;
const LLM_MAX_RETRIES = 0;

function getClient(provider: LLMProvider = "nanogpt", timeoutMs: number = DEFAULT_TIMEOUT_MS): OpenAI {
  let baseURL: string | undefined;
  let apiKey: string | undefined;

  if (provider === "nanogpt") {
    baseURL = process.env["NANOGPT_BASE_URL"];
    apiKey = process.env["NANOGPT_API_KEY"];
    if (!baseURL) throw new Error("NANOGPT_BASE_URL environment variable is required for nanogpt provider");
    if (!apiKey) throw new Error("NANOGPT_API_KEY environment variable is required for nanogpt provider");
  } else {
    baseURL = process.env["LLM_BASE_URL"];
    apiKey = process.env["LLM_API_KEY"];
    if (!baseURL) throw new Error("LLM_BASE_URL environment variable is required");
    if (!apiKey) throw new Error("LLM_API_KEY environment variable is required");
  }

  return new OpenAI({ baseURL, apiKey, timeout: timeoutMs, maxRetries: LLM_MAX_RETRIES });
}

export interface EmbedOptions {
  stage: string;
  stageRunId?: number;
  model: string;
  provider?: LLMProvider;
  timeoutMs?: number;
}

export async function embed(texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const { stage, stageRunId, model, provider, timeoutMs } = opts;
  const pool = getPool();
  const startMs = Date.now();

  let inputTokens: number | null = null;
  let errorMsg: string | null = null;
  let vectors: number[][] = [];

  try {
    const client = getClient(provider ?? "nanogpt", timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const response = await client.embeddings.create({ model, input: texts });
    vectors = response.data.map((d) => d.embedding);
    inputTokens = response.usage?.prompt_tokens ?? null;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const durationMs = Date.now() - startMs;

  if (errorMsg !== null) {
    console.error(
      `[llm] ${stage} embed failed: model=${model} inputs=${texts.length} elapsed=${durationMs}ms error=${errorMsg}`
    );
  }

  await pool.query(
    `INSERT INTO generation_logs
       (stage, stage_run_id, model, system_prompt, user_prompt,
        response_text, input_tokens, output_tokens, duration_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      stage,
      stageRunId ?? null,
      model,
      "",
      `[embedding: ${texts.length} texts]`,
      null,
      inputTokens,
      null,
      durationMs,
      errorMsg,
    ]
  );

  if (errorMsg !== null) {
    throw new Error(`Embed call failed: ${errorMsg}`);
  }

  return vectors;
}

export async function callLLM(options: LLMCallOptions): Promise<LLMCallResult> {
  const { stage, stageRunId, model, systemPrompt, userPrompt, temperature, maxTokens, reasoningEffort, provider, timeoutMs, stream } = options;
  const pool = getPool();
  const startMs = Date.now();

  let responseText: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let errorMsg: string | null = null;

  try {
    const client = getClient(provider ?? "nanogpt", timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const baseParams = {
      model,
      messages: [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userPrompt },
      ],
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    };
    if (reasoningEffort !== undefined) {
      // reasoning_effort is not in OpenAI SDK types but is forwarded verbatim
      // to OpenAI-compatible endpoints. Double-cast narrowly — only this assignment.
      (baseParams as unknown as Record<string, unknown>)["reasoning_effort"] = reasoningEffort;
    }

    if (stream) {
      // Streaming path: headers arrive within seconds of the request, keeping
      // the HTTP connection alive past undici's ~300s headers timeout. Chunks
      // are accumulated into the same string the non-streaming path produces.
      const streamParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
        ...baseParams,
        stream: true,
        stream_options: { include_usage: true },
      };

      const streamResult = await client.chat.completions.create(streamParams);

      let accumulated = "";
      let bytesReceived = 0;

      try {
        for await (const chunk of streamResult) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            accumulated += delta;
            bytesReceived += Buffer.byteLength(delta, "utf8");
          }
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? null;
            outputTokens = chunk.usage.completion_tokens ?? null;
          }
        }
      } catch (streamErr) {
        const elapsed = Date.now() - startMs;
        const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        throw new Error(
          `Stream broke at ${elapsed}ms after ${bytesReceived} bytes — stage=${stage} model=${model}: ${msg}`,
        );
      }

      responseText = accumulated.length > 0 ? accumulated : null;
    } else {
      const completionParams: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        ...baseParams,
        stream: false,
      };

      const completion = await client.chat.completions.create(completionParams);

      responseText = completion.choices[0]?.message?.content ?? null;
      inputTokens = completion.usage?.prompt_tokens ?? null;
      outputTokens = completion.usage?.completion_tokens ?? null;
    }
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
