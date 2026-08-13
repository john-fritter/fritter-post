import assert from "node:assert/strict";
import { parseBatchOutput } from "../src/pipeline/editor-pass-1/index.js";

function testTwoAxisFormatParsesAndSums() {
  const text = [
    "101;;42;;40;;Civil liberties story",
    "102;;38;;35;;Reason keeps ;; internal delimiter intact",
    "103;;not-a-score;;40;;Bad interest should fail safe",
    "stray prose line that should be ignored",
    "```",
    "105;;60;;70;;Both axes above range clamp to 50",
  ].join("\n");

  const parsed = parseBatchOutput(text, [101, 102, 103, 104, 105]);
  if (parsed === null) throw new Error("expected line parse result");

  assert.equal(parsed.mode, "line");
  assert.equal(parsed.results.length, 5);
  assert.equal(parsed.parsedLineCount, 3);
  assert.equal(parsed.failSafeCount, 2);
  assert.deepEqual(parsed.results, [
    { id: 101, score: 82, interest: 42, consequence: 40, reason: "Civil liberties story" },
    {
      id: 102,
      score: 73,
      interest: 38,
      consequence: 35,
      reason: "Reason keeps ;; internal delimiter intact",
    },
    {
      id: 103,
      score: 50,
      interest: null,
      consequence: null,
      reason: "fail-safe: missing/invalid line",
    },
    {
      id: 104,
      score: 50,
      interest: null,
      consequence: null,
      reason: "fail-safe: missing/invalid line",
    },
    { id: 105, score: 100, interest: 50, consequence: 50, reason: "Both axes above range clamp to 50" },
  ]);
}

function testAxesAreClampedIndependently() {
  const parsed = parseBatchOutput("1;;99;;3;;High interest, no consequence", [1]);
  if (parsed === null) throw new Error("expected line parse result");
  assert.deepEqual(parsed.results[0], {
    id: 1,
    score: 53,
    interest: 50,
    consequence: 3,
    reason: "High interest, no consequence",
  });
}

function testNegativeAxisClampsToZero() {
  const parsed = parseBatchOutput("1;;-5;;20;;Negative interest", [1]);
  if (parsed === null) throw new Error("expected line parse result");
  assert.equal(parsed.results[0]!.interest, 0);
  assert.equal(parsed.results[0]!.score, 20);
}

function testDigestShapeScoresLowOverall() {
  // The shape the consequence axis exists to catch: a roundup that is genuinely
  // high-interest but reports nothing. It must land far below a real story, and
  // below the ~55 pile cutoff that run #109 produced.
  const parsed = parseBatchOutput(
    ["1;;46;;2;;digest of other stories", "2;;40;;38;;real ruling with stakes"].join("\n"),
    [1, 2],
  );
  if (parsed === null) throw new Error("expected line parse result");
  const digest = parsed.results[0]!;
  const story = parsed.results[1]!;
  assert.equal(digest.score, 48);
  assert.equal(story.score, 78);
  assert.ok(digest.score < story.score, "digest must rank below a real story");
  assert.ok(digest.score < 55, "digest must fall below a representative pile cutoff");
}

function testOldThreeFieldFormatFailsSafeRatherThanMisparsing() {
  // The pre-migration format was id;;score;;reason. If a model or an old prompt
  // emits it, the line must fail safe — silently reading "82" as interest and
  // the reason text as consequence would corrupt the score.
  const parsed = parseBatchOutput("101;;82;;Civil liberties story", [101]);
  if (parsed === null) throw new Error("expected line parse result");
  assert.equal(parsed.parsedLineCount, 0);
  assert.equal(parsed.failSafeCount, 1);
  assert.equal(parsed.results[0]!.score, 50);
  assert.equal(parsed.results[0]!.interest, null);
}

function testEmptyReasonIsRejected() {
  const parsed = parseBatchOutput("101;;40;;40;;", [101]);
  if (parsed === null) throw new Error("expected line parse result");
  assert.equal(parsed.parsedLineCount, 0);
  assert.equal(parsed.failSafeCount, 1);
}

const tests = [
  testTwoAxisFormatParsesAndSums,
  testAxesAreClampedIndependently,
  testNegativeAxisClampsToZero,
  testDigestShapeScoresLowOverall,
  testOldThreeFieldFormatFailsSafeRatherThanMisparsing,
  testEmptyReasonIsRejected,
];

for (const t of tests) t();
console.log("editor-pass-1 parser tests passed");
