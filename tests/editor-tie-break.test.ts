import assert from "node:assert/strict";
import { parseTieBreakOutput, applySortWithTieRanks } from "../src/pipeline/editor/index.js";

// --- parseTieBreakOutput ---

function testParsesRefsInRankedOrder() {
  const text = "C3\nS17566\nC7\n";
  const ranks = parseTieBreakOutput(text, ["C3", "S17566", "C7"]);
  assert.equal(ranks.get("C3"), 0);
  assert.equal(ranks.get("S17566"), 1);
  assert.equal(ranks.get("C7"), 2);
}

function testParsesRefWithBracketsAndTrailingPunctuation() {
  // Model may output [C3] or [S17566.] — normalizeRef strips these
  const text = "[C3]\n[S17566.]\n";
  const ranks = parseTieBreakOutput(text, ["C3", "S17566"]);
  assert.equal(ranks.get("C3"), 0);
  assert.equal(ranks.get("S17566"), 1);
}

function testOmittedRefIsAbsentFromMap() {
  // S17566 omitted from LLM output — caller treats absence as Infinity
  const text = "C3\n";
  const ranks = parseTieBreakOutput(text, ["C3", "S17566"]);
  assert.equal(ranks.get("C3"), 0);
  assert.equal(ranks.has("S17566"), false);
}

function testDuplicateRefKepsFirstOccurrence() {
  const text = "C3\nS1\nC3\n"; // C3 repeated; second occurrence ignored
  const ranks = parseTieBreakOutput(text, ["C3", "S1"]);
  assert.equal(ranks.get("C3"), 0);
  assert.equal(ranks.get("S1"), 1);
  assert.equal(ranks.size, 2);
}

function testRefNotInGroupIsIgnored() {
  // C9 is not in the group — should not appear in output
  const text = "C3\nC9\nS1\n";
  const ranks = parseTieBreakOutput(text, ["C3", "S1"]);
  assert.equal(ranks.get("C3"), 0);
  assert.equal(ranks.get("S1"), 1);
  assert.equal(ranks.has("C9"), false);
}

function testEmptyOutputProducesEmptyMap() {
  const ranks = parseTieBreakOutput("", ["C3", "S1"]);
  assert.equal(ranks.size, 0);
}

// --- applySortWithTieRanks ---

function testTieRankAppliedWithinTiedGroup() {
  // Three items with the same combined score; LLM ranks S2, C1, S9
  const items = [
    { ref: "C1", combined: 90 },
    { ref: "S2", combined: 90 },
    { ref: "S9", combined: 90 },
  ];
  const tieRanks = new Map([["S2", 0], ["C1", 1], ["S9", 2]]);
  const sorted = applySortWithTieRanks(items, tieRanks);
  assert.deepEqual(sorted.map((s) => s.ref), ["S2", "C1", "S9"]);
}

function testOmittedRefSortsToEndOfGroup() {
  // S9 has tieRank 0; C1 omitted (Infinity) → S9 before C1
  const items = [
    { ref: "C1", combined: 90 },
    { ref: "S9", combined: 90 },
  ];
  const tieRanks = new Map([["S9", 0]]);
  const sorted = applySortWithTieRanks(items, tieRanks);
  assert.deepEqual(sorted.map((s) => s.ref), ["S9", "C1"]);
}

function testFullCallFailureFallsBackToRefOrder() {
  // Empty map (entire group failed) → both items get Infinity → ref order
  // "C1" < "S9" alphabetically
  const items = [
    { ref: "S9", combined: 90 },
    { ref: "C1", combined: 90 },
  ];
  const sorted = applySortWithTieRanks(items, new Map());
  assert.deepEqual(sorted.map((s) => s.ref), ["C1", "S9"]);
}

function testNoItemsDroppedOnFullCallFailure() {
  const items = [
    { ref: "S1", combined: 85 },
    { ref: "S2", combined: 85 },
    { ref: "S3", combined: 85 },
  ];
  const sorted = applySortWithTieRanks(items, new Map());
  assert.equal(sorted.length, 3);
  // All present, ref order fallback: S1, S2, S3
  assert.deepEqual(sorted.map((s) => s.ref), ["S1", "S2", "S3"]);
}

function testTwoSeparateTiedGroupsEachRankedIndependently() {
  // Group A: combined=95, LLM ranks S1 before S2
  // Group B: combined=80, LLM ranks C6 before C5
  const items = [
    { ref: "S2", combined: 95 },
    { ref: "S1", combined: 95 },
    { ref: "C5", combined: 80 },
    { ref: "C6", combined: 80 },
  ];
  const tieRanks = new Map([["S1", 0], ["S2", 1], ["C6", 0], ["C5", 1]]);
  const sorted = applySortWithTieRanks(items, tieRanks);
  assert.deepEqual(sorted.map((s) => s.ref), ["S1", "S2", "C6", "C5"]);
}

function testNonTiedItemsPreserveCombinedOrder() {
  // Unique combined scores → combined sort resolves; tie ranks irrelevant
  const items = [
    { ref: "S3", combined: 70 },
    { ref: "S1", combined: 95 },
    { ref: "C2", combined: 80 },
  ];
  const sorted = applySortWithTieRanks(items, new Map());
  assert.deepEqual(sorted.map((s) => s.ref), ["S1", "C2", "S3"]);
}

function testMixedTiedAndNonTiedItems() {
  // S5 and C1 are tied; S3 has a unique score above them; C8 has a unique score below
  const items = [
    { ref: "C1", combined: 88 },
    { ref: "S3", combined: 92 },
    { ref: "S5", combined: 88 },
    { ref: "C8", combined: 75 },
  ];
  // LLM ranks C1 before S5 within the 88 group
  const tieRanks = new Map([["C1", 0], ["S5", 1]]);
  const sorted = applySortWithTieRanks(items, tieRanks);
  assert.deepEqual(sorted.map((s) => s.ref), ["S3", "C1", "S5", "C8"]);
}

testParsesRefsInRankedOrder();
testParsesRefWithBracketsAndTrailingPunctuation();
testOmittedRefIsAbsentFromMap();
testDuplicateRefKepsFirstOccurrence();
testRefNotInGroupIsIgnored();
testEmptyOutputProducesEmptyMap();
testTieRankAppliedWithinTiedGroup();
testOmittedRefSortsToEndOfGroup();
testFullCallFailureFallsBackToRefOrder();
testNoItemsDroppedOnFullCallFailure();
testTwoSeparateTiedGroupsEachRankedIndependently();
testNonTiedItemsPreserveCombinedOrder();
testMixedTiedAndNonTiedItems();
console.log("editor tie-break tests passed");
