import { franc } from "franc-min";
import pLimit from "p-limit";
import type { TranslationConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { callWithBackoff } from "../../llm/backoff.js";

const TRANSLATE_SYSTEM_PROMPT =
  "You are a translation engine. Translate the title and body of each item to English.\n\n" +
  "Input: a JSON array where each object has \"id\" (string), \"title\" (string), and " +
  "\"body\" (string or null).\n" +
  "Output: JSONL — one JSON object per line, each with \"id\", \"title\" (English), and " +
  "\"body\" (translated English string, or null if the input body was null).\n\n" +
  "Rules:\n" +
  "- Output ONLY the JSONL lines. No preamble, explanation, or commentary.\n" +
  "- Every input id must appear in the output exactly once.\n" +
  "- If a title or body is already English, copy it through unchanged.\n" +
  "- Preserve URLs, proper nouns, code snippets, and special characters.";

// Non-Latin Unicode blocks that unambiguously signal a non-English script.
// Used as a fast-path so very short CJK/Arabic/Cyrillic text is never
// mis-classified as "undetermined and therefore English."
const NON_LATIN_SCRIPT_RE =
  /[　-鿿가-힯؀-ۿЀ-ӿ֐-׿ऀ-ॿ฀-๿]/;

/**
 * Returns the ISO 639-3 language code for the item, using franc-min on a
 * combined title + body excerpt. Exported so tests can validate behaviour
 * without mocking the library.
 */
export function detectLanguageCode(title: string, body: string | null): string {
  const bodyExcerpt = body ? body.slice(0, 500) : "";
  const sample = bodyExcerpt.length > 0 ? `${title}\n${bodyExcerpt}` : title;
  return franc(sample);
}

/**
 * Returns true when the item should be treated as English (copy-through)
 * rather than translated. Conservative: "und" (undetermined) with non-Latin
 * script is treated as non-English; "und" with only ASCII/Latin is treated
 * as English (short text, probably English or close enough).
 */
export function isEnglish(langCode: string, title: string, body: string | null): boolean {
  if (langCode === "eng") return true;
  if (langCode === "und") {
    const combined = body ? `${title} ${body.slice(0, 200)}` : title;
    return !NON_LATIN_SCRIPT_RE.test(combined);
  }
  return false;
}

export interface EnglishFields {
  english_title: string;
  english_body: string | null;
  failed: boolean;
}

export interface TranslationInputItem {
  id: string;
  title: string;
  body: string | null;
}

export interface TranslationStats {
  nonEnglish: number;
  batches: number;
  translated: number;
  splitRetries: number;
  /** Batches split because the LLM call itself failed, rather than because ids
   *  were missing from an otherwise-good response. Distinguishing the two says
   *  whether the provider is timing out or the model is dropping ids. */
  callSplits: number;
  fallbacks: number;
}

/** Injectable for testing — raw LLM call, before backoff wrapping. */
export type BatchLLMCallFn = (
  items: TranslationInputItem[],
  config: TranslationConfig,
  stage: string,
  runId: number,
) => Promise<string>;

interface ParsedTranslation {
  title: string;
  body: string | null;
}

/**
 * Parses JSONL batch output from the translation model.
 * Each line: {"id":"...","title":"...","body":"..." or null}
 * Returns a map from id → parsed translation.
 * Lines that fail JSON.parse or lack required string fields are silently
 * dropped — the caller handles missing ids via split-on-failure.
 */
export function parseBatchOutput(text: string): Map<string, ParsedTranslation> {
  const results = new Map<string, ParsedTranslation>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      const obj = JSON.parse(line) as unknown;
      if (
        typeof obj !== "object" ||
        obj === null ||
        typeof (obj as Record<string, unknown>).id !== "string" ||
        typeof (obj as Record<string, unknown>).title !== "string"
      ) {
        continue;
      }
      const rec = obj as Record<string, unknown>;
      const id = rec.id as string;
      const title = rec.title as string;
      const body = typeof rec.body === "string" ? rec.body : null;
      if (!results.has(id)) {
        results.set(id, { title, body });
      }
    } catch {
      // Skip malformed JSON lines; caller handles missing ids.
    }
  }
  return results;
}

const defaultCallBatchLLM: BatchLLMCallFn = async (items, config, stage, runId) => {
  const result = await callLLM({
    stage,
    stageRunId: runId,
    model: config.model,
    provider: config.provider,
    systemPrompt: TRANSLATE_SYSTEM_PROMPT,
    userPrompt: JSON.stringify(
      items.map((item) => ({ id: item.id, title: item.title, body: item.body })),
    ),
    temperature: config.temperature,
    maxTokens: config.max_tokens,
    reasoningEffort: config.reasoning_effort,
    stream: config.stream,
    timeoutMs: config.timeout_ms,
  });
  return result.text.trim();
};

/**
 * Translates a batch of items with split-on-failure retry logic.
 *
 * - 429/503 errors on the LLM call are retried with callWithBackoff before
 *   any splitting occurs.
 * - If the call fails even after backoff, ALL items in the batch fall back
 *   to original text.
 * - If the call succeeds but some ids are missing from the output, the
 *   missing items are split in half and each half is retried recursively,
 *   down to a batch of 1. A single-item batch that still produces no output
 *   falls back to original text.
 */
async function translateBatchWithSplit(
  batch: TranslationInputItem[],
  config: TranslationConfig,
  runId: number,
  callBatchLLM: BatchLLMCallFn,
  stats: TranslationStats,
): Promise<Map<string, EnglishFields>> {
  const results = new Map<string, EnglishFields>();

  // Halves the given items and recurses. Shared by the call-failure and
  // missing-id paths, which want identical recovery behaviour.
  async function splitAndRetry(
    items: TranslationInputItem[],
    into: Map<string, EnglishFields>,
  ): Promise<void> {
    const mid = Math.ceil(items.length / 2);
    for (const half of [items.slice(0, mid), items.slice(mid)]) {
      if (half.length === 0) continue;
      stats.splitRetries++;
      const halfResults = await translateBatchWithSplit(
        half,
        config,
        runId,
        callBatchLLM,
        stats,
      );
      for (const [id, fields] of halfResults) into.set(id, fields);
    }
  }

  let rawText: string;
  try {
    rawText = await callWithBackoff(
      () => callBatchLLM(batch, config, "preprocessor", runId),
      { retry_max_attempts: config.retry_max_attempts, retry_base_ms: config.retry_base_ms },
      "translation",
    );
  } catch (err) {
    // The call failed after backoff — in practice a timeout, since 429/503 are
    // already retried above. A timeout means this payload was too slow, so
    // re-sending it unchanged would likely time out again. Split instead, the
    // same recovery the missing-id path uses: half the work per call is the
    // thing that actually addresses the cause.
    //
    // Before this, a single slow call fell back its whole batch at once — two
    // timeouts cost 20 of run #44's 23 lost items.
    if (batch.length > 1) {
      stats.callSplits++;
      await splitAndRetry(batch, results);
      return results;
    }
    // A single item that still fails has nowhere left to split.
    const msg = err instanceof Error ? err.message : String(err);
    const item = batch[0]!;
    console.warn(
      `[translation] item ${item.id} failed alone (${msg.slice(0, 80)}) — ` +
        `falling back to original-language text`,
    );
    results.set(item.id, { english_title: item.title, english_body: item.body, failed: true });
    stats.fallbacks++;
    return results;
  }

  const parsed = parseBatchOutput(rawText);

  // Record successfully translated items.
  for (const item of batch) {
    const translation = parsed.get(item.id);
    if (translation !== undefined) {
      results.set(item.id, {
        english_title: translation.title,
        english_body: translation.body,
        failed: false,
      });
      stats.translated++;
    }
  }

  // Handle missing ids.
  const missingItems = batch.filter((item) => !parsed.has(item.id));
  if (missingItems.length === 0) return results;

  if (batch.length === 1) {
    // Already at minimum batch size — no further splitting possible. Fall back.
    const item = batch[0]!;
    results.set(item.id, { english_title: item.title, english_body: item.body, failed: true });
    stats.fallbacks++;
    return results;
  }

  // batch.length > 1: retry missing items (split if more than one, send alone if one).
  if (missingItems.length === 1) {
    stats.splitRetries++;
    const retryResult = await translateBatchWithSplit(
      [missingItems[0]!], config, runId, callBatchLLM, stats,
    );
    for (const [id, fields] of retryResult) results.set(id, fields);
  } else {
    await splitAndRetry(missingItems, results);
  }

  return results;
}

/**
 * Translates all non-English items in a list.
 *
 * - English items (detected via franc-min + non-Latin script heuristic) are
 *   copied through without any LLM call.
 * - Items with english_title already set are returned as-is (idempotency).
 * - Non-English items are batched (config.translation_batch_size per call)
 *   and sent to the model. Output is JSONL keyed by id.
 * - Missing ids trigger split-on-failure: the missing subset is halved and
 *   each half is retried recursively down to a 1-item floor.
 * - 429/503 errors use callWithBackoff before splitting.
 * - Fallback (after all recovery attempts) uses original text so no item
 *   is ever lost from the pipeline.
 *
 * Returns a map from item id → EnglishFields, plus a stats summary.
 */
export async function batchTranslateItems(
  items: Array<{
    id: string;
    title: string;
    bodyText: string | null;
    english_title?: string | null;
    english_body?: string | null;
  }>,
  config: TranslationConfig,
  runId: number,
  callBatchLLM: BatchLLMCallFn = defaultCallBatchLLM,
): Promise<{ fields: Map<string, EnglishFields>; stats: TranslationStats }> {
  const stats: TranslationStats = {
    nonEnglish: 0,
    batches: 0,
    translated: 0,
    splitRetries: 0,
    callSplits: 0,
    fallbacks: 0,
  };
  const allFields = new Map<string, EnglishFields>();

  const toTranslate: TranslationInputItem[] = [];

  for (const item of items) {
    // Idempotency: already translated in a prior pass.
    if (item.english_title != null) {
      allFields.set(item.id, {
        english_title: item.english_title,
        english_body: item.english_body ?? null,
        failed: false,
      });
      continue;
    }

    const langCode = detectLanguageCode(item.title, item.bodyText);
    if (isEnglish(langCode, item.title, item.bodyText)) {
      allFields.set(item.id, {
        english_title: item.title,
        english_body: item.bodyText,
        failed: false,
      });
    } else {
      stats.nonEnglish++;
      const bodyExcerpt = item.bodyText ? item.bodyText.slice(0, 2000) : null;
      toTranslate.push({ id: item.id, title: item.title, body: bodyExcerpt });
    }
  }

  if (toTranslate.length === 0) {
    return { fields: allFields, stats };
  }

  // Partition into batches.
  const batchSize = config.translation_batch_size;
  const batches: TranslationInputItem[][] = [];
  for (let i = 0; i < toTranslate.length; i += batchSize) {
    batches.push(toTranslate.slice(i, i + batchSize));
  }
  stats.batches = batches.length;

  // Process batches concurrently (p-limit).
  const limit = pLimit(config.concurrency);
  const batchResults = await Promise.all(
    batches.map((batch) =>
      limit(async () => translateBatchWithSplit(batch, config, runId, callBatchLLM, stats)),
    ),
  );

  for (const batchResult of batchResults) {
    for (const [id, fields] of batchResult) {
      allFields.set(id, fields);
    }
  }

  return { fields: allFields, stats };
}
