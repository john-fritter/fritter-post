import assert from "node:assert/strict";
import { parseBatchOutput } from "../src/pipeline/editor-pass-1/index.js";

function testLineFormatParsesPerItemAndReasonsMayContainDelimiter() {
  const text = [
    "101;;82;;Civil liberties story",
    "102;;73;;Reason keeps ;; internal delimiter intact",
    "103;;not-a-score;;Bad score should fail safe",
    "stray prose line that should be ignored",
    "```",
    "105;;101;;Score above range clamps to 100",
  ].join("\n");

  const parsed = parseBatchOutput(text, [101, 102, 103, 104, 105]);
  if (parsed === null) throw new Error("expected line parse result");

  assert.equal(parsed.mode, "line");
  assert.equal(parsed.results.length, 5);
  assert.equal(parsed.parsedLineCount, 3);
  assert.equal(parsed.failSafeCount, 2);
  assert.deepEqual(parsed.results, [
    { id: 101, score: 82, reason: "Civil liberties story" },
    { id: 102, score: 73, reason: "Reason keeps ;; internal delimiter intact" },
    { id: 103, score: 50, reason: "fail-safe: missing/invalid line" },
    { id: 104, score: 50, reason: "fail-safe: missing/invalid line" },
    { id: 105, score: 100, reason: "Score above range clamps to 100" },
  ]);
}

testLineFormatParsesPerItemAndReasonsMayContainDelimiter();
console.log("editor-pass-1 parser tests passed");
