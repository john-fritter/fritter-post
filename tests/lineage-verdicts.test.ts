import assert from "node:assert/strict";
import { parseLineageVerdicts } from "../src/pipeline/lineage/prompt.js";

function testReadsYesAndNo() {
  const c = parseLineageVerdicts("1;;YES;;same deal\n2;;NO;;different state\n3;;YES;;same case", 3);
  assert.deepEqual([...c.keys()].sort(), [0, 2], "only YES pairs are confirmed, 0-based");
}

function testCapturesTheReason() {
  const c = parseLineageVerdicts("1;;YES;;same acquisition, now confirmed", 1);
  assert.equal(c.get(0), "same acquisition, now confirmed");
}

function testAMissingReasonCostsTheReasonNotTheVerdict() {
  // Run #36's lesson: a parser demanding every field threw away forty complete
  // answers. A verdict with no reason is still a verdict.
  const c = parseLineageVerdicts("1;;YES", 1);
  assert.ok(c.has(0), "the verdict survives a missing reason");
  assert.equal(c.get(0), null);
}

function testStripsMarkdownFromTheReason() {
  const c = parseLineageVerdicts("1;;YES;;**same ruling appealed**", 1);
  assert.equal(c.get(0), "same ruling appealed");
}

function testIsCaseInsensitiveAndToleratesMarkdown() {
  const c = parseLineageVerdicts("**1**;; yes;;one situation\n2;;No;;unrelated", 2);
  assert.deepEqual([...c.keys()], [0]);
}

function testAMissingLineIsANo() {
  // Fail closed: an unjudged pair must never print in the paper.
  const c = parseLineageVerdicts("1;;YES;;same case", 3);
  assert.deepEqual([...c.keys()], [0], "pairs 2 and 3 were not answered and stay out");
}

function testUnparseableOutputConfirmsNothing() {
  assert.equal(parseLineageVerdicts("I could not decide.", 3).size, 0);
  assert.equal(parseLineageVerdicts("", 3).size, 0);
}

function testOutOfRangeNumbersAreIgnored() {
  const c = parseLineageVerdicts("0;;YES;;x\n1;;YES;;y\n9;;YES;;z", 2);
  assert.deepEqual([...c.keys()], [0], "only 1..pairCount are read");
}

function testProseAroundTheLinesDoesNotBreakIt() {
  const c = parseLineageVerdicts("Here are my judgments:\n\n1;;NO;;different war\n2;;YES;;same toll rising\n\nDone.", 2);
  assert.deepEqual([...c.keys()], [1]);
}

testReadsYesAndNo();
testCapturesTheReason();
testAMissingReasonCostsTheReasonNotTheVerdict();
testStripsMarkdownFromTheReason();
testIsCaseInsensitiveAndToleratesMarkdown();
testAMissingLineIsANo();
testUnparseableOutputConfirmsNothing();
testOutOfRangeNumbersAreIgnored();
testProseAroundTheLinesDoesNotBreakIt();

console.log("lineage verdict parser tests passed");
