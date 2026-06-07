import assert from "node:assert/strict";
import { parseBatchOutput } from "../src/pipeline/prefilter/index.js";

function testLineFormatParsesPerItemAndFailSafesToKeep() {
  const text = [
    "101;;cut;;Routine box score, no angle",
    "102;;keep;;Labor angle on athlete dispute",
    "103;;CUT;;Verdict casing is normalized",
    "104;;maybe;;Bad verdict should fail safe to keep",
    "stray prose line that should be ignored",
    "```",
    "106;;keep;;Reason keeps ;; internal delimiter intact",
  ].join("\n");

  const parsed = parseBatchOutput(text, [101, 102, 103, 104, 105, 106]);

  assert.equal(parsed.results.length, 6);
  // 101, 102, 103, 104, 106 all parse as valid lines — 104's verdict is
  // invalid, but the line itself is recognized and fail-safed to keep.
  // Only 105 (absent from the model's output) hits the missing-line path.
  assert.equal(parsed.parsedLineCount, 5);
  assert.equal(parsed.failSafeCount, 1);
  assert.deepEqual(parsed.results, [
    { id: 101, keep: false, reason: "Routine box score, no angle" },
    { id: 102, keep: true, reason: "Labor angle on athlete dispute" },
    { id: 103, keep: false, reason: "Verdict casing is normalized" },
    { id: 104, keep: true, reason: "Bad verdict should fail safe to keep" },
    { id: 105, keep: true, reason: "fail-safe: missing/invalid line" },
    { id: 106, keep: true, reason: "Reason keeps ;; internal delimiter intact" },
  ]);
}

function testUnknownAndDuplicateIdsAreDropped() {
  const text = [
    "201;;keep;;First occurrence wins",
    "201;;cut;;Duplicate is dropped",
    "999;;cut;;Unknown id is dropped",
  ].join("\n");

  const parsed = parseBatchOutput(text, [201, 202]);

  assert.equal(parsed.parsedLineCount, 1);
  assert.deepEqual(parsed.results, [
    { id: 201, keep: true, reason: "First occurrence wins" },
    { id: 202, keep: true, reason: "fail-safe: missing/invalid line" },
  ]);
}

testLineFormatParsesPerItemAndFailSafesToKeep();
testUnknownAndDuplicateIdsAreDropped();
console.log("prefilter parser tests passed");
