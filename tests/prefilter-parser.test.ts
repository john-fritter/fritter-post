import assert from "node:assert/strict";
import { parseBatchOutput } from "../src/pipeline/prefilter/index.js";

function testLineFormatParsesPerItemAndFailSafesToKeepAsNews() {
  const text = [
    "101;;cut;;Routine box score, no angle",
    "102;;news;;Labor angle on athlete dispute",
    "103;;CUT;;Verdict casing is normalized",
    "104;;maybe;;Bad verdict should fail safe to news",
    "stray prose line that should be ignored",
    "```",
    "106;;opinion;;Personal essay, author's view is the point",
  ].join("\n");

  const parsed = parseBatchOutput(text, [101, 102, 103, 104, 105, 106]);

  assert.equal(parsed.results.length, 6);
  // 101, 102, 103, 104, 106 all parse as valid lines — 104's verdict is
  // invalid, but the line itself is recognized and fail-safed to keep as news.
  // Only 105 (absent from the model's output) hits the missing-line path.
  assert.equal(parsed.parsedLineCount, 5);
  assert.equal(parsed.failSafeCount, 1);
  assert.deepEqual(parsed.results, [
    { id: 101, keep: false, kind: "news", reason: "Routine box score, no angle" },
    { id: 102, keep: true, kind: "news", reason: "Labor angle on athlete dispute" },
    { id: 103, keep: false, kind: "news", reason: "Verdict casing is normalized" },
    { id: 104, keep: true, kind: "news", reason: "Bad verdict should fail safe to news" },
    { id: 105, keep: true, kind: "news", reason: "fail-safe: missing/invalid line" },
    { id: 106, keep: true, kind: "opinion", reason: "Personal essay, author's view is the point" },
  ]);
}

function testUnknownAndDuplicateIdsAreDropped() {
  const text = [
    "201;;news;;First occurrence wins",
    "201;;cut;;Duplicate is dropped",
    "999;;cut;;Unknown id is dropped",
  ].join("\n");

  const parsed = parseBatchOutput(text, [201, 202]);

  assert.equal(parsed.parsedLineCount, 1);
  assert.deepEqual(parsed.results, [
    { id: 201, keep: true, kind: "news", reason: "First occurrence wins" },
    { id: 202, keep: true, kind: "news", reason: "fail-safe: missing/invalid line" },
  ]);
}

testLineFormatParsesPerItemAndFailSafesToKeepAsNews();
testUnknownAndDuplicateIdsAreDropped();
console.log("prefilter parser tests passed");
