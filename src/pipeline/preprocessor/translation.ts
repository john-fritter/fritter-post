import { franc } from "franc-min";
import type { TranslationConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";

const TRANSLATE_SYSTEM_PROMPT =
  "Translate the following text to English. Output ONLY the translation with no preamble, notes, quotes, or commentary.";

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

/** One LLM call translating a single text string to English. */
async function translateText(
  text: string,
  config: TranslationConfig,
  stage: string,
  stageRunId: number,
): Promise<string> {
  const result = await callLLM({
    stage,
    stageRunId,
    model: config.model,
    provider: config.provider,
    systemPrompt: TRANSLATE_SYSTEM_PROMPT,
    userPrompt: text,
    temperature: config.temperature,
    maxTokens: config.max_tokens,
    reasoningEffort: config.reasoning_effort,
    stream: config.stream,
    timeoutMs: config.timeout_ms,
  });
  return result.text.trim();
}

export interface EnglishFields {
  english_title: string;
  english_body: string | null;
  failed: boolean;
}

/**
 * Derives english_title and english_body for one preprocessed item.
 *
 * - English items: copy title and body through unchanged.
 * - Non-English items: translate title and body[:2000] with the configured model.
 * - Idempotent: if english_title is already set (item was processed before),
 *   returns the existing values without calling the translator.
 * - Translation failure: logs a warning and returns the original text so the
 *   item is never lost (it just clusters within its own language).
 *
 * The translateFn parameter is injectable for testing.
 */
export async function buildEnglishFields(
  item: {
    title: string;
    bodyText: string | null;
    english_title?: string | null;
    english_body?: string | null;
  },
  config: TranslationConfig,
  runId: number,
  translateFn: typeof translateText = translateText,
): Promise<EnglishFields> {
  // Idempotency: if already populated, return as-is.
  if (item.english_title != null) {
    return {
      english_title: item.english_title,
      english_body: item.english_body ?? null,
      failed: false,
    };
  }

  const langCode = detectLanguageCode(item.title, item.bodyText);

  if (isEnglish(langCode, item.title, item.bodyText)) {
    return { english_title: item.title, english_body: item.bodyText, failed: false };
  }

  // Non-English: translate title and body[:2000].
  try {
    const bodyExcerpt = item.bodyText ? item.bodyText.slice(0, 2000) : null;

    const english_title = await translateFn(item.title, config, "preprocessor", runId);
    const english_body = bodyExcerpt
      ? await translateFn(bodyExcerpt, config, "preprocessor", runId)
      : null;

    return { english_title, english_body, failed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[preprocessor] translation failed for "${item.title.slice(0, 60)}": ${msg} — using original`,
    );
    return { english_title: item.title, english_body: item.bodyText, failed: true };
  }
}
