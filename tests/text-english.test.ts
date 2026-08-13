import assert from "node:assert/strict";
import {
  englishTitle,
  englishBody,
  excerpt,
  englishBodyExcerpt,
} from "../src/lib/text.js";

// --- englishTitle ---

function testPrefersTranslation() {
  assert.equal(
    englishTitle({
      title: "Сооснователь радиостанции умер после избиения",
      english_title: "Radio station co-founder dies after beating",
    }),
    "Radio station co-founder dies after beating",
  );
}

function testFallsBackWhenTranslationMissing() {
  // Rows written before migration 028 have no english_title at all.
  assert.equal(englishTitle({ title: "Original headline" }), "Original headline");
  assert.equal(
    englishTitle({ title: "Original headline", english_title: null }),
    "Original headline",
  );
}

function testFallsBackOnEmptyTranslation() {
  // A failed translation that wrote "" must not blank the title — the item
  // still has to be judged on something.
  assert.equal(
    englishTitle({ title: "Original headline", english_title: "" }),
    "Original headline",
  );
}

function testEnglishItemsCopyThrough() {
  // The preprocessor copies english_title = title for English items, so the
  // two paths must agree.
  assert.equal(
    englishTitle({ title: "Bend council approves housing", english_title: "Bend council approves housing" }),
    "Bend council approves housing",
  );
}

// --- englishBody ---

function testBodyPrefersTranslation() {
  assert.equal(
    englishBody({ body_text: "текст статьи", english_body: "article text" }),
    "article text",
  );
}

function testBodyFallsBack() {
  assert.equal(englishBody({ body_text: "original body" }), "original body");
  assert.equal(
    englishBody({ body_text: "original body", english_body: null }),
    "original body",
  );
  assert.equal(
    englishBody({ body_text: "original body", english_body: "" }),
    "original body",
  );
}

function testBodyMissingEntirelyIsEmptyString() {
  // body_text is nullable in the schema. Callers excerpt unconditionally, so
  // this must be "" and never null/undefined.
  assert.equal(englishBody({}), "");
  assert.equal(englishBody({ body_text: null }), "");
  assert.equal(englishBody({ body_text: null, english_body: null }), "");
}

// --- excerpt ---

function testExcerptCaps() {
  assert.equal(excerpt("abcdefghij", 4), "abcd");
  assert.equal(excerpt("abc", 10), "abc");
  assert.equal(excerpt("abc", 3), "abc");
}

function testExcerptHandlesNullAndZero() {
  assert.equal(excerpt(null, 100), "");
  assert.equal(excerpt(undefined, 100), "");
  assert.equal(excerpt("abcdef", 0), "");
}

function testExcerptNegativeCapIsEmptyNotTailSlice() {
  // The bug this guards: String.slice(0, -3) returns "abc" for "abcdef",
  // silently handing the model a truncated-from-the-end excerpt instead of
  // failing or returning nothing.
  assert.equal(excerpt("abcdef", -3), "");
}

// --- englishBodyExcerpt ---

function testEnglishBodyExcerptComposes() {
  assert.equal(
    englishBodyExcerpt({ body_text: "оригинал", english_body: "translated body text" }, 10),
    "translated",
  );
  assert.equal(englishBodyExcerpt({ body_text: "original body" }, 8), "original");
  assert.equal(englishBodyExcerpt({}, 50), "");
}

function testProductionCapsAreNotTruncatingShortBodies() {
  // Sanity: the 500/1000 production caps pass ordinary lede-length text
  // through untouched. This is the regression the caps exist to prevent —
  // the old hardcoded 50 cut every one of these to eight words.
  const lede =
    "Evacuation levels were lifted on the fires closest to Bend on Monday while " +
    "a wildfire burning east of Mount Hood spurred fresh evacuations in Wasco " +
    "and Clackamas counties, state fire officials said.";
  assert.equal(englishBodyExcerpt({ body_text: lede }, 500), lede);
  assert.ok(englishBodyExcerpt({ body_text: lede }, 50).length === 50);
  assert.ok(lede.length > 50, "fixture must be longer than the old hardcoded cap");
}

const tests = [
  testPrefersTranslation,
  testFallsBackWhenTranslationMissing,
  testFallsBackOnEmptyTranslation,
  testEnglishItemsCopyThrough,
  testBodyPrefersTranslation,
  testBodyFallsBack,
  testBodyMissingEntirelyIsEmptyString,
  testExcerptCaps,
  testExcerptHandlesNullAndZero,
  testExcerptNegativeCapIsEmptyNotTailSlice,
  testEnglishBodyExcerptComposes,
  testProductionCapsAreNotTruncatingShortBodies,
];

for (const t of tests) t();
console.log("text english/excerpt tests passed");
