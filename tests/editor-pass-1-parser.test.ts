import assert from "node:assert/strict";
import { parseBatchOutput } from "../src/pipeline/editor-pass-1/index.js";

function testStrictParseStillWorks() {
  const text = '```json\n[{"id":1,"score":82,"reason":"Civil liberties"},{"id":2,"score":5,"reason":"Sports noise"}]\n```';
  const parsed = parseBatchOutput(text, [1, 2]);
  if (parsed === null) throw new Error("expected strict parse result");

  assert.equal(parsed.mode, "strict");
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.recoveredCount, 0);
  assert.equal(parsed.unrecoveredCount, 0);
  assert.deepEqual(parsed.results, [
    { id: 1, score: 82, reason: "Civil liberties" },
    { id: 2, score: 5, reason: "Sports noise" },
  ]);
}

function testMalformedDelimiterSalvagesValidObjectsOnly() {
  const text = '[{"id":83,"score":45,"reason":"Labor dispute"},{"},{"id":85,"score":72,"reason":"Gaza escalation"},{"id":86,"score":101,"reason":"Invalid score"},{"id":87,"score":8,"reason":"Sports"}]';
  const parsed = parseBatchOutput(text, [83, 85, 86, 87, 88]);
  if (parsed === null) throw new Error("expected recovered parse result");

  assert.equal(parsed.mode, "recovered");
  assert.equal(parsed.results.length, 5);
  assert.equal(parsed.recoveredCount, 3);
  assert.equal(parsed.unrecoveredCount, 2);
  assert.deepEqual(parsed.results, [
    { id: 83, score: 45, reason: "Labor dispute" },
    { id: 85, score: 72, reason: "Gaza escalation" },
    { id: 86, score: 50, reason: "fail-safe: unrecovered from malformed batch" },
    { id: 87, score: 8, reason: "Sports" },
    { id: 88, score: 50, reason: "fail-safe: unrecovered from malformed batch" },
  ]);
}

testStrictParseStillWorks();
testMalformedDelimiterSalvagesValidObjectsOnly();
console.log("editor-pass-1 parser tests passed");
