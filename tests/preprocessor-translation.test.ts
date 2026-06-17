import assert from "node:assert/strict";
import { isEnglish, detectLanguageCode, buildEnglishFields } from "../src/pipeline/preprocessor/translation.js";
import type { TranslationConfig } from "../src/config/models.js";

// Minimal config — provider/model/etc are passed through to translateFn which
// is always mocked in these tests, so the values don't matter.
const MOCK_CONFIG: TranslationConfig = {
  model: "mock-model",
  provider: "nanogpt",
  temperature: 0.1,
  max_tokens: 4096,
  concurrency: 1,
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
  // "und" result but CJK characters present → non-English
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

// --- buildEnglishFields() ---

function makeTranslateFn(mapping: Record<string, string>) {
  return async (text: string): Promise<string> => {
    const result = mapping[text];
    if (result === undefined) throw new Error(`unexpected translate call for: "${text}"`);
    return result;
  };
}

async function testEnglishCopiedThrough() {
  let translateCalled = false;
  const neverTranslate = async (_text: string): Promise<string> => {
    translateCalled = true;
    throw new Error("should not be called for English");
  };

  const result = await buildEnglishFields(
    { title: "Senate passes infrastructure bill", bodyText: "The US Senate voted..." },
    MOCK_CONFIG,
    MOCK_RUN_ID,
    neverTranslate as Parameters<typeof buildEnglishFields>[3],
  );

  assert.ok(!translateCalled, "translate must not be called for English");
  assert.equal(result.english_title, "Senate passes infrastructure bill");
  assert.equal(result.english_body, "The US Senate voted...");
  assert.ok(!result.failed);
}

async function testNonEnglishTranslated() {
  const translateFn = makeTranslateFn({
    "日本のニュース": "Japan News",
    "日本の首相は本日、新しい経済政策を発表しました。": "The Japanese PM announced new economic policy today.",
  });

  const result = await buildEnglishFields(
    {
      title: "日本のニュース",
      bodyText: "日本の首相は本日、新しい経済政策を発表しました。",
    },
    MOCK_CONFIG,
    MOCK_RUN_ID,
    translateFn as Parameters<typeof buildEnglishFields>[3],
  );

  assert.equal(result.english_title, "Japan News");
  assert.equal(result.english_body, "The Japanese PM announced new economic policy today.");
  assert.ok(!result.failed);
}

async function testNonEnglishBodyCappedAt2000Chars() {
  const longBody = "日".repeat(3000);
  const expectedBodyExcerpt = "日".repeat(2000);

  let capturedText: string | null = null;
  let callCount = 0;
  const capturingTranslate = async (text: string): Promise<string> => {
    callCount++;
    if (callCount === 2) capturedText = text; // second call is the body
    return "translated";
  };

  await buildEnglishFields(
    { title: "日本のニュース", bodyText: longBody },
    MOCK_CONFIG,
    MOCK_RUN_ID,
    capturingTranslate as Parameters<typeof buildEnglishFields>[3],
  );

  assert.equal(capturedText, expectedBodyExcerpt, "body excerpt sent to translate must be capped at 2000 chars");
}

async function testIdempotencySkipsTranslation() {
  let translateCalled = false;
  const neverTranslate = async (_text: string): Promise<string> => {
    translateCalled = true;
    throw new Error("should not be called when english_title already set");
  };

  const result = await buildEnglishFields(
    {
      title: "titre en français",
      bodyText: "corps en français",
      english_title: "title already translated",
      english_body: "body already translated",
    },
    MOCK_CONFIG,
    MOCK_RUN_ID,
    neverTranslate as Parameters<typeof buildEnglishFields>[3],
  );

  assert.ok(!translateCalled, "translate must not be called when english_* already set");
  assert.equal(result.english_title, "title already translated");
  assert.equal(result.english_body, "body already translated");
  assert.ok(!result.failed);
}

async function testTranslationFailureFallsBackToOriginal() {
  const failingTranslate = async (_text: string): Promise<string> => {
    throw new Error("LLM call failed: connection reset");
  };

  const result = await buildEnglishFields(
    {
      title: "Bonjour le monde",
      bodyText: "Il faisait beau ce jour-là.",
    },
    MOCK_CONFIG,
    MOCK_RUN_ID,
    failingTranslate as Parameters<typeof buildEnglishFields>[3],
  );

  assert.equal(result.english_title, "Bonjour le monde", "fallback: original title");
  assert.equal(result.english_body, "Il faisait beau ce jour-là.", "fallback: original body");
  assert.ok(result.failed, "failed flag must be true");
}

async function testNullBodyHandled() {
  let bodyTranslateCalled = false;
  const translateFn = async (text: string): Promise<string> => {
    if (text !== "日本のニュース") bodyTranslateCalled = true; // should only get title
    return "Japan News";
  };

  const result = await buildEnglishFields(
    { title: "日本のニュース", bodyText: null },
    MOCK_CONFIG,
    MOCK_RUN_ID,
    translateFn as Parameters<typeof buildEnglishFields>[3],
  );

  assert.ok(!bodyTranslateCalled, "body translate must not be called when bodyText is null");
  assert.equal(result.english_title, "Japan News");
  assert.equal(result.english_body, null);
}

// --- Run all tests ---

testIsEnglishReturnsTrueForEng();
testIsEnglishReturnsFalseForOtherLangs();
testIsEnglishUndWithLatinIsEnglish();
testIsEnglishUndWithCJKIsNonEnglish();
testIsEnglishUndWithArabicIsNonEnglish();
testDetectLanguageCodeEnglish();
testDetectLanguageCodeJapanese();

// Async tests
async function main() {
  await testEnglishCopiedThrough();
  await testNonEnglishTranslated();
  await testNonEnglishBodyCappedAt2000Chars();
  await testIdempotencySkipsTranslation();
  await testTranslationFailureFallsBackToOriginal();
  await testNullBodyHandled();
  console.log("preprocessor translation tests passed");
}

main().catch((err) => {
  console.error("preprocessor translation tests FAILED:", err);
  process.exit(1);
});
