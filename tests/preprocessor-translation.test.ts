import assert from "node:assert/strict";
import {
  isEnglish,
  detectLanguageCode,
  parseBatchOutput,
  batchTranslateItems,
  type BatchLLMCallFn,
  type TranslationInputItem,
} from "../src/pipeline/preprocessor/translation.js";
import type { TranslationConfig } from "../src/config/models.js";

// Minimal config — values only matter when the injectable callBatchLLM is the
// real one, which never happens in these tests.
const MOCK_CONFIG: TranslationConfig = {
  model: "mock-model",
  provider: "nanogpt",
  temperature: 0.1,
  max_tokens: 4096,
  translation_batch_size: 10,
  concurrency: 1,
  retry_max_attempts: 1, // 1 attempt = no retries (tests that need retries override this)
  retry_base_ms: 10,     // tiny delay so 429-retry tests don't slow the suite
};

const MOCK_RUN_ID = 0;

// --- isEnglish() ---

function testIsEnglishReturnsTrueForEng() {
  assert.ok(isEnglish("eng", "Hello world", null), "eng → English");
}

function testIsEnglishReturnsFalseForOtherLangs() {
  assert.ok(!isEnglish("fra", "Bonjour le monde", null), "fra → not English");
  assert.ok(!isEnglish("jpn", "日本のニュース", null), "jpn → not English");
  assert.ok(!isEnglish("deu", "Guten Morgen", null), "deu → not English");
  assert.ok(!isEnglish("spa", "Hola mundo", null), "spa → not English");
}

function testIsEnglishUndWithLatinIsEnglish() {
  // Very short ASCII text → und, but no non-Latin script → treat as English
  assert.ok(isEnglish("und", "OK", null), "und + ASCII → treated as English");
}

function testIsEnglishUndWithCJKIsNonEnglish() {
  assert.ok(!isEnglish("und", "日本", null), "und + CJK → non-English");
  assert.ok(!isEnglish("und", "뉴스", null), "und + Hangul → non-English");
}

function testIsEnglishUndWithArabicIsNonEnglish() {
  assert.ok(!isEnglish("und", "مرحبا", null), "und + Arabic → non-English");
}

// --- detectLanguageCode() ---

function testDetectLanguageCodeEnglish() {
  const lang = detectLanguageCode(
    "Senate passes infrastructure bill",
    "The United States Senate voted to pass a major infrastructure bill on Thursday.",
  );
  assert.equal(lang, "eng", `expected eng, got ${lang}`);
}

function testDetectLanguageCodeJapanese() {
  const lang = detectLanguageCode(
    "日本のニュース",
    "日本の首相は本日、新しい経済政策を発表しました。",
  );
  assert.notEqual(lang, "eng", `expected non-eng for Japanese, got ${lang}`);
  assert.notEqual(lang, "und", `expected definite lang code for Japanese, got ${lang}`);
}

// --- parseBatchOutput() ---

function testParseBatchOutputByIdNotPosition() {
  // Model returns items in reversed order — parser must key by id, not line position.
  const jsonl = [
    JSON.stringify({ id: "c", title: "C in English", body: "C body" }),
    JSON.stringify({ id: "a", title: "A in English", body: null }),
    JSON.stringify({ id: "b", title: "B in English", body: "B body" }),
  ].join("\n");

  const result = parseBatchOutput(jsonl);
  assert.equal(result.size, 3);
  assert.equal(result.get("a")?.title, "A in English");
  assert.equal(result.get("a")?.body, null);
  assert.equal(result.get("b")?.title, "B in English");
  assert.equal(result.get("c")?.title, "C in English");
}

function testParseBatchOutputHandlesEmbeddedDelimiters() {
  // Embedded quotes, backslashes, and ";;" in the translated text must parse cleanly.
  const line = JSON.stringify({
    id: "1",
    title: 'It\'s a "great" day',
    body: "Line 1;; Line 2\\nstill line 2",
  });
  const result = parseBatchOutput(line);
  assert.equal(result.get("1")?.title, 'It\'s a "great" day');
  assert.equal(result.get("1")?.body, "Line 1;; Line 2\\nstill line 2");
}

function testParseBatchOutputSkipsMalformedLines() {
  const jsonl = [
    "not json at all",
    JSON.stringify({ id: "ok", title: "Good", body: null }),
    '{"id": 42, "title": "id is not a string"}',  // id must be string
    "",
  ].join("\n");
  const result = parseBatchOutput(jsonl);
  assert.equal(result.size, 1);
  assert.ok(result.has("ok"));
}

// --- batchTranslateItems() ---

async function testFullBatchReturnedByIdNotPosition() {
  // Mock returns items in different order than input — verify id-keyed pairing.
  const callBatchLLM: BatchLLMCallFn = async (items) => {
    // Return in reversed id order.
    const reversed = [...items].reverse();
    return reversed
      .map((item) =>
        JSON.stringify({ id: item.id, title: `[EN] ${item.title}`, body: item.body }),
      )
      .join("\n");
  };

  const items = [
    { id: "raw-1", title: "日本のニュース", bodyText: "本文テキスト" },
    { id: "raw-2", title: "Nachrichten aus Deutschland", bodyText: null },
    { id: "raw-3", title: "新闻标题", bodyText: "正文" },
  ];

  const { fields, stats } = await batchTranslateItems(items, MOCK_CONFIG, MOCK_RUN_ID, callBatchLLM);

  assert.equal(fields.get("raw-1")?.english_title, "[EN] 日本のニュース");
  assert.equal(fields.get("raw-1")?.english_body, "本文テキスト");
  assert.equal(fields.get("raw-2")?.english_title, "[EN] Nachrichten aus Deutschland");
  assert.equal(fields.get("raw-2")?.english_body, null);
  assert.equal(fields.get("raw-3")?.english_title, "[EN] 新闻标题");
  assert.equal(fields.get("raw-3")?.failed, false);
  assert.equal(stats.nonEnglish, 3);
  assert.equal(stats.translated, 3);
  assert.equal(stats.fallbacks, 0);
}

async function testMissingIdSplitsAndRecovers() {
  // First call omits item "raw-2". Split retry sends it alone and recovers it.
  let callCount = 0;
  const callBatchLLM: BatchLLMCallFn = async (items) => {
    callCount++;
    if (callCount === 1) {
      // Omit raw-2 from first response.
      return items
        .filter((i) => i.id !== "raw-2")
        .map((i) => JSON.stringify({ id: i.id, title: `[EN] ${i.title}`, body: i.body }))
        .join("\n");
    }
    // Split retry: should receive only ["raw-2"].
    assert.equal(items.length, 1, "split retry must send only the missing item");
    assert.equal(items[0]?.id, "raw-2");
    return JSON.stringify({ id: "raw-2", title: "[EN] recovered", body: null });
  };

  const items = [
    { id: "raw-1", title: "日本のニュース", bodyText: null },
    { id: "raw-2", title: "法国最新新闻报道", bodyText: null },
  ];

  const { fields, stats } = await batchTranslateItems(items, MOCK_CONFIG, MOCK_RUN_ID, callBatchLLM);

  assert.equal(fields.get("raw-1")?.english_title, "[EN] 日本のニュース");
  assert.equal(fields.get("raw-2")?.english_title, "[EN] recovered");
  assert.equal(fields.get("raw-2")?.failed, false);
  assert.equal(stats.splitRetries, 1, "one split retry call made");
  assert.equal(stats.translated, 2);
  assert.equal(stats.fallbacks, 0);
}

async function test429ThenSuccess() {
  // First call throws a 429; backoff retries; second call succeeds.
  let callCount = 0;
  const config: TranslationConfig = {
    ...MOCK_CONFIG,
    retry_max_attempts: 2,  // allow one retry
    retry_base_ms: 10,
  };

  const callBatchLLM: BatchLLMCallFn = async (items) => {
    callCount++;
    if (callCount === 1) {
      throw new Error("HTTP 429 Too Many Requests: rate limit exceeded");
    }
    return items
      .map((i) => JSON.stringify({ id: i.id, title: `[EN] ${i.title}`, body: i.body }))
      .join("\n");
  };

  const items = [{ id: "raw-1", title: "日本のニュース", bodyText: null }];
  const { fields, stats } = await batchTranslateItems(items, config, MOCK_RUN_ID, callBatchLLM);

  assert.equal(callCount, 2, "callBatchLLM must be called twice (initial + one retry)");
  assert.equal(fields.get("raw-1")?.english_title, "[EN] 日本のニュース");
  assert.equal(fields.get("raw-1")?.failed, false);
  assert.equal(stats.translated, 1);
  assert.equal(stats.fallbacks, 0);
}

async function testExhaustedRetriesFallsBackToOriginal() {
  // All attempts throw 429 — item falls back to original text with failed:true.
  const config: TranslationConfig = {
    ...MOCK_CONFIG,
    retry_max_attempts: 1,  // 1 attempt, no retries
  };

  const callBatchLLM: BatchLLMCallFn = async () => {
    throw new Error("HTTP 429 Too Many Requests");
  };

  const items = [{ id: "raw-1", title: "日本のニュース", bodyText: "本文" }];
  const { fields, stats } = await batchTranslateItems(items, config, MOCK_RUN_ID, callBatchLLM);

  const f = fields.get("raw-1");
  assert.ok(f?.failed, "failed must be true after exhausted retries");
  assert.equal(f?.english_title, "日本のニュース", "fallback uses original title");
  assert.equal(f?.english_body, "本文", "fallback uses original body");
  assert.equal(stats.fallbacks, 1);
  assert.equal(stats.translated, 0);
}

async function testEnglishItemsNeverBatched() {
  let batchLLMCalled = false;
  const callBatchLLM: BatchLLMCallFn = async () => {
    batchLLMCalled = true;
    return "";
  };

  const items = [
    {
      id: "raw-1",
      title: "Senate passes infrastructure bill",
      bodyText: "The United States Senate voted to pass a major infrastructure bill on Thursday.",
    },
    {
      id: "raw-2",
      title: "Climate report warns of rising sea levels",
      bodyText: "Scientists published a landmark report on climate change and global warming trends.",
    },
  ];

  const { fields, stats } = await batchTranslateItems(items, MOCK_CONFIG, MOCK_RUN_ID, callBatchLLM);

  assert.ok(!batchLLMCalled, "batch LLM must not be called for English items");
  assert.equal(fields.get("raw-1")?.english_title, "Senate passes infrastructure bill");
  assert.equal(fields.get("raw-2")?.english_title, "Climate report warns of rising sea levels");
  assert.equal(stats.nonEnglish, 0);
  assert.equal(stats.batches, 0);
}

// --- split-on-call-failure (run #44 regression) ---
//
// Run #44 logged 2 translation timeouts and lost 23 of 601 items. Twenty of
// those came from one behaviour: a failed call fell back its ENTIRE batch at
// once. Since a timeout means the payload was too slow, re-sending it unchanged
// is unlikely to help — halving it is. These pin that.

/** Four non-English items, enough to split twice. */
function nonEnglishItems(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `raw-${i + 1}`,
    title: `Сенаторы США согласовали законопроект номер ${i + 1}`,
    bodyText:
      "Российские власти сообщили о новых мерах в отношении иностранных компаний, " +
      "работающих на территории страны, и объявили о дополнительных ограничениях.",
  }));
}

function jsonlFor(items: TranslationInputItem[]): string {
  return items
    .map((i) =>
      JSON.stringify({ id: i.id, title: `EN ${i.id}`, body: `EN body ${i.id}` }),
    )
    .join("\n");
}

async function testTimeoutSplitsInsteadOfDumpingTheBatch() {
  // The full batch of 4 times out; each half of 2 succeeds. Before the fix all
  // four items fell back. Now all four are translated.
  const seen: number[] = [];
  const callBatchLLM: BatchLLMCallFn = async (batch) => {
    seen.push(batch.length);
    if (batch.length > 2) throw new Error("Request timed out.");
    return jsonlFor(batch);
  };

  const { fields, stats } = await batchTranslateItems(
    nonEnglishItems(4),
    MOCK_CONFIG,
    MOCK_RUN_ID,
    callBatchLLM,
  );

  assert.equal(stats.fallbacks, 0, "no item should fall back when halves succeed");
  assert.equal(stats.translated, 4);
  assert.ok(stats.callSplits >= 1, "the failed call should be recorded as a split");
  assert.ok(seen.includes(4) && seen.includes(2), `expected 4 then 2s, saw ${seen}`);
  for (let i = 1; i <= 4; i++) {
    assert.equal(fields.get(`raw-${i}`)?.english_title, `EN raw-${i}`);
    assert.equal(fields.get(`raw-${i}`)?.failed, false);
  }
}

async function testSplitRecursesToSingleItems() {
  // Only single-item calls succeed — the split must go all the way down rather
  // than giving up at the first half.
  const callBatchLLM: BatchLLMCallFn = async (batch) => {
    if (batch.length > 1) throw new Error("Request timed out.");
    return jsonlFor(batch);
  };

  const { fields, stats } = await batchTranslateItems(
    nonEnglishItems(4),
    MOCK_CONFIG,
    MOCK_RUN_ID,
    callBatchLLM,
  );

  assert.equal(stats.fallbacks, 0);
  assert.equal(stats.translated, 4);
  for (let i = 1; i <= 4; i++) {
    assert.equal(fields.get(`raw-${i}`)?.english_title, `EN raw-${i}`);
  }
}

async function testItemFailingAloneStillFallsBack() {
  // The floor must still hold: an item that fails at batch size 1 has nowhere
  // to split, keeps its original text, and is marked failed so the loss is
  // recorded rather than silent.
  const callBatchLLM: BatchLLMCallFn = async () => {
    throw new Error("Request timed out.");
  };

  const items = nonEnglishItems(2);
  const { fields, stats } = await batchTranslateItems(
    items,
    MOCK_CONFIG,
    MOCK_RUN_ID,
    callBatchLLM,
  );

  assert.equal(stats.fallbacks, 2, "both items exhaust the split and fall back");
  assert.equal(fields.get("raw-1")?.english_title, items[0]!.title);
  assert.equal(fields.get("raw-1")?.failed, true, "failure must be flagged, not silent");
  assert.equal(fields.get("raw-2")?.failed, true);
}

// --- Run all tests ---

testIsEnglishReturnsTrueForEng();
testIsEnglishReturnsFalseForOtherLangs();
testIsEnglishUndWithLatinIsEnglish();
testIsEnglishUndWithCJKIsNonEnglish();
testIsEnglishUndWithArabicIsNonEnglish();
testDetectLanguageCodeEnglish();
testDetectLanguageCodeJapanese();
testParseBatchOutputByIdNotPosition();
testParseBatchOutputHandlesEmbeddedDelimiters();
testParseBatchOutputSkipsMalformedLines();

async function main() {
  await testFullBatchReturnedByIdNotPosition();
  await testMissingIdSplitsAndRecovers();
  await test429ThenSuccess();
  await testExhaustedRetriesFallsBackToOriginal();
  await testEnglishItemsNeverBatched();
  await testTimeoutSplitsInsteadOfDumpingTheBatch();
  await testSplitRecursesToSingleItems();
  await testItemFailingAloneStillFallsBack();
  console.log("preprocessor translation tests passed");
}

main().catch((err) => {
  console.error("preprocessor translation tests FAILED:", err);
  process.exit(1);
});
