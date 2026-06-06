import assert from "node:assert/strict";
import { parseFlatClusterOutput } from "../src/pipeline/triage/index.js";

const INPUT_IDS = new Set([101, 102, 103, 104, 105, 106]);

function testNormalClusterParsesCorrectly() {
  const text = "US Trade Tariffs;;President signed an executive order imposing 25% tariffs on imports from Canada and Mexico.;;101,102,103";
  const result = parseFlatClusterOutput(text, INPUT_IDS);
  if (result === null) throw new Error("expected parse result");
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]!.title, "US Trade Tariffs");
  assert.equal(result.clusters[0]!.summary, "President signed an executive order imposing 25% tariffs on imports from Canada and Mexico.");
  assert.deepEqual(result.clusters[0]!.item_ids, [101, 102, 103]);
  assert.equal(result.clusters[0]!.notes, null);
  assert.equal(result.parsedLineCount, 1);
  assert.equal(result.fabricatedIds.length, 0);
  assert.equal(result.duplicateIds.length, 0);
  assert.equal(result.droppedSingletonCount, 0);
}

function testSummaryContainingDoubleDelimiterParsesCorrectly() {
  // The summary itself contains ;; — first/last ;; split keeps summary intact and id list correct.
  const text = "Senate Budget Vote;;Senators debated the bill;; a 51-49 final vote was taken.;;104,105";
  const result = parseFlatClusterOutput(text, INPUT_IDS);
  if (result === null) throw new Error("expected parse result");
  assert.equal(result.clusters.length, 1);
  assert.equal(result.clusters[0]!.title, "Senate Budget Vote");
  assert.equal(
    result.clusters[0]!.summary,
    "Senators debated the bill;; a 51-49 final vote was taken.",
  );
  assert.deepEqual(result.clusters[0]!.item_ids, [104, 105]);
}

function testFabricatedIdDroppedAndLogged() {
  // id 999 is not in INPUT_IDS — should be dropped; cluster still has 2 valid ids.
  const text = "Climate Summit;;World leaders agreed to new emissions targets at the UN conference.;;101,102,999";
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(String(args[0]));
  try {
    const result = parseFlatClusterOutput(text, INPUT_IDS);
    if (result === null) throw new Error("expected parse result");
    assert.equal(result.clusters.length, 1);
    assert.deepEqual(result.clusters[0]!.item_ids, [101, 102]);
    assert.deepEqual(result.fabricatedIds, [999]);
    assert.ok(warns.some((w) => w.includes("fabricated") && w.includes("999")), "expected fabricated-id warning");
  } finally {
    console.warn = origWarn;
  }
}

function testOneIdClusterDropped() {
  // After filtering fabricated id 888, only id 103 remains — below the 2-item minimum.
  const text = "Single Source Story;;One outlet covered a local council vote.;;103,888";
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(String(args[0]));
  try {
    const result = parseFlatClusterOutput(text, INPUT_IDS);
    // parsedLineCount is 1 (structural line found), but cluster is dropped.
    if (result === null) throw new Error("whole-output parse should succeed (has parseable lines)");
    assert.equal(result.clusters.length, 0);
    assert.equal(result.droppedSingletonCount, 1);
    assert.ok(warns.some((w) => w.includes("dropped cluster")), "expected singleton-drop warning");
  } finally {
    console.warn = origWarn;
  }
}

function testSplitLineJoinFallback() {
  // Model emits label;;summary on one line, id list on the next — parser joins them.
  const text = [
    "Gaza Ceasefire Talks;;Mediators proposed a 40-day pause in fighting.",
    "101,102,103",
    "Senate Tariff Vote;;The Senate passed the tariff bill 67-33.",
    "104,105",
  ].join("\n");
  const result = parseFlatClusterOutput(text, INPUT_IDS);
  if (result === null) throw new Error("expected parse result");
  assert.equal(result.clusters.length, 2);
  assert.equal(result.clusters[0]!.title, "Gaza Ceasefire Talks");
  assert.deepEqual(result.clusters[0]!.item_ids, [101, 102, 103]);
  assert.equal(result.clusters[1]!.title, "Senate Tariff Vote");
  assert.deepEqual(result.clusters[1]!.item_ids, [104, 105]);
}

function testWholeOutputUnparseableReturnsNull() {
  const text = "This is just prose with no delimiters at all.\nAnother stray line.";
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(String(args[0]));
  try {
    const result = parseFlatClusterOutput(text, INPUT_IDS);
    assert.equal(result, null);
    assert.ok(warns.some((w) => w.includes("digest parse failed")), "expected parse-failed warning");
  } finally {
    console.warn = origWarn;
  }
}

testNormalClusterParsesCorrectly();
testSummaryContainingDoubleDelimiterParsesCorrectly();
testFabricatedIdDroppedAndLogged();
testOneIdClusterDropped();
testSplitLineJoinFallback();
testWholeOutputUnparseableReturnsNull();
console.log("triage parser tests passed");
