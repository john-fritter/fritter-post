import assert from "node:assert/strict";
import { parseLineageVerdicts } from "../src/pipeline/lineage/prompt.js";

function testReadsYesAndNo() {
  const c = parseLineageVerdicts("1;;YES\n2;;NO\n3;;YES", 3);
  assert.deepEqual([...c].sort(), [0, 2], "only YES pairs are confirmed, 0-based");
}

function testIsCaseInsensitiveAndToleratesMarkdown() {
  const c = parseLineageVerdicts("**1**;; yes\n2;;No", 2);
  assert.deepEqual([...c], [0]);
}

function testAMissingLineIsANo() {
  // Fail closed: an unjudged pair must never print in the paper.
  const c = parseLineageVerdicts("1;;YES", 3);
  assert.deepEqual([...c], [0], "pairs 2 and 3 were not answered and stay out");
}

function testUnparseableOutputConfirmsNothing() {
  assert.equal(parseLineageVerdicts("I could not decide.", 3).size, 0);
  assert.equal(parseLineageVerdicts("", 3).size, 0);
}

function testOutOfRangeNumbersAreIgnored() {
  const c = parseLineageVerdicts("0;;YES\n1;;YES\n9;;YES", 2);
  assert.deepEqual([...c], [0], "only 1..pairCount are read");
}

function testProseAroundTheLinesDoesNotBreakIt() {
  const c = parseLineageVerdicts("Here are my judgments:\n\n1;;NO\n2;;YES\n\nDone.", 2);
  assert.deepEqual([...c], [1]);
}

testReadsYesAndNo();
testIsCaseInsensitiveAndToleratesMarkdown();
testAMissingLineIsANo();
testUnparseableOutputConfirmsNothing();
testOutOfRangeNumbersAreIgnored();
testProseAroundTheLinesDoesNotBreakIt();

console.log("lineage verdict parser tests passed");
