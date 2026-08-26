import assert from "node:assert/strict";
import pLimit from "p-limit";
import { scoreBatches } from "../src/pipeline/editor-pass-1/index.js";
import type { EditorPass1BatchItem } from "../src/pipeline/editor-pass-1/prompt.js";
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
    // **An unscored row scores 0, not 50.** 50 is a fabricated judgment in the
    // middle of the range, so it competed with real ones: run #42's pile cutoff
    // was 54 and four unscored clusters fell below it, while run #40's was 49
    // and an unscored row reached the paper. Whether an unjudged item was
    // published turned on where the day's cutoff happened to land. 0 says what
    // is true — no judgment — and the pile takes it only if it is short of
    // judged candidates.
    {
      id: 103,
      score: 0,
      interest: null,
      consequence: null,
      reason: "fail-safe: missing/invalid line",
    },
    {
      id: 104,
      score: 0,
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
  assert.equal(parsed.results[0]!.score, 0);
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
function testAnUnscoredRowCannotOutrankAScoredOne() {
  // The whole point of the change. Whatever the fail-safe value is, it must lose
  // to every real judgment, so an unjudged row can never displace a judged one
  // from the pile. The 0-50 axis floor means the lowest genuine score is 0 too,
  // so this asserts "not greater", which is what the pile ordering needs.
  const parsed = parseBatchOutput("101;;0;;0;;A genuinely dull item", [101, 102]);
  assert.ok(parsed !== null);
  const scored = parsed.results.find((r) => r.id === 101)!;
  const unscored = parsed.results.find((r) => r.id === 102)!;
  assert.equal(unscored.interest, null, "an unscored row has no axes");
  assert.ok(
    unscored.score <= scored.score,
    `unscored ${unscored.score} must not outrank the lowest real score ${scored.score}`,
  );
}

testAnUnscoredRowCannotOutrankAScoredOne();


// --- the straggler re-ask ---
//
// Run #42: one 429 on the first and only attempt defaulted a batch of 40 items
// to a fabricated score, because this stage — batched, concurrent, at the
// highest concurrency in the pipeline — never imported callWithBackoff at all.
// Batches that still fail after retries are now re-asked once, sequentially.

const item = (id: number): EditorPass1BatchItem => ({
  id,
  source: "Src",
  type: "journalism",
  title: `Title ${id}`,
  body_excerpt: "body",
});
const scored = (ids: number[]) =>
  ids.map((id) => ({ id, score: 70, interest: 35, consequence: 35, reason: "ok" }));
const failsafed = (ids: number[]) =>
  ids.map((id) => ({ id, score: 0, interest: null, consequence: null, reason: "fail-safe" }));

async function testEveryItemComesBackInBatchOrder() {
  // Results are matched to items downstream, so a reordering here would attach
  // scores to the wrong stories — silently, and with no way to notice.
  const batches = [[item(1), item(2)], [item(3)], [item(4), item(5)]];
  const out = await scoreBatches(batches, pLimit(3), async (batch) => ({
    results: scored(batch.map((i) => i.id)),
    failed: false,
  }));
  assert.deepEqual(out.results.map((r) => r.id), [1, 2, 3, 4, 5]);
  assert.equal(out.unscored, 0);
}

async function testAFailedBatchIsReAskedAndItsRetryWins() {
  const batches = [[item(1)], [item(2)], [item(3)]];
  const seen: string[] = [];
  const out = await scoreBatches(batches, pLimit(3), async (batch, idx, _count, label) => {
    seen.push(`${idx}${label}`);
    // Batch 1 fails the first time and answers on the re-ask.
    if (idx === 1 && label === "") return { results: failsafed([2]), failed: true };
    return { results: scored(batch.map((i) => i.id)), failed: false };
  });
  assert.ok(seen.includes("1 [straggler]"), "the failed batch was re-asked");
  assert.equal(seen.filter((c) => c.startsWith("0")).length, 1, "clean batches are not re-asked");
  assert.deepEqual(out.results.map((r) => r.id), [1, 2, 3]);
  assert.equal(out.results.find((r) => r.id === 2)!.score, 70, "the retry result replaced the fail-safe");
  assert.equal(out.unscored, 0);
}

async function testABatchThatFailsTwiceIsCountedUnscored() {
  const batches = [[item(1), item(2)], [item(3)]];
  const out = await scoreBatches(batches, pLimit(2), async (batch, idx) =>
    idx === 0
      ? { results: failsafed(batch.map((i) => i.id)), failed: true }
      : { results: scored(batch.map((i) => i.id)), failed: false },
  );
  assert.equal(out.unscored, 2, "both items of the failed batch are unscored");
  assert.deepEqual(out.results.map((r) => r.id), [1, 2, 3]);
  // They are still present, carrying the fail-safe, rather than vanishing.
  assert.equal(out.results.find((r) => r.id === 1)!.interest, null);
}

async function testNoBatchesIsNotAnError() {
  const out = await scoreBatches([], pLimit(1), async () => ({ results: [], failed: false }));
  assert.deepEqual(out.results, []);
  assert.equal(out.unscored, 0);
}

async function runStragglerTests() {
  await testEveryItemComesBackInBatchOrder();
  await testAFailedBatchIsReAskedAndItsRetryWins();
  await testABatchThatFailsTwiceIsCountedUnscored();
  await testNoBatchesIsNotAnError();
}

console.log("editor-pass-1 parser tests passed");

// tsx runs tests under the CJS output format, which rejects top-level await.
runStragglerTests()
  .then(() => console.log("editor pass 1 straggler tests passed"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
