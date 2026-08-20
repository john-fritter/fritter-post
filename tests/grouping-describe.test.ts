import assert from "node:assert/strict";
import { parseDescribeOutput } from "../src/pipeline/grouping/index.js";

// The describe pass writes the label every downstream stage ranks and reads, and
// since run #50 it also answers whether the cluster is really one story. That
// question exists because the split pass structurally cannot see this class of
// over-merge: it selects suspects by cohesion, and two gold mine collapses on
// different continents are *tightly* connected — same kind of event, same words.
// Describe reads the material, and in run #50 it wrote the defect straight into
// its own title: "Gold mine collapses kill dozens in Central African Republic
// and Colombia".

function testFourFieldLineCarriesTheVerdict() {
  const out = parseDescribeOutput(
    "0;;ONE;;Trump nominates Overton to lead FDA;;The president named her Wednesday.",
    1,
  );
  const r = out.get(0)!;
  assert.equal(r.oneEvent, true);
  assert.equal(r.title, "Trump nominates Overton to lead FDA");
  assert.equal(r.summary, "The president named her Wednesday.");
}

function testMultiIsFlagged() {
  const out = parseDescribeOutput(
    "0;;MULTI;;Gold mine collapses kill dozens in Central African Republic and Colombia;;Two collapses.",
    1,
  );
  assert.equal(out.get(0)!.oneEvent, false);
  // The title is kept: the model was told to write it anyway, and the audit
  // wants to see the label that gave the merge away.
  assert.ok(/Central African Republic and Colombia/.test(out.get(0)!.title));
}

function testVerdictIsCaseInsensitive() {
  assert.equal(parseDescribeOutput("0;;multi;;T;;S.", 1).get(0)!.oneEvent, false);
  assert.equal(parseDescribeOutput("0;;One;;T;;S.", 1).get(0)!.oneEvent, true);
}

function testAThreeFieldLineStillParsesAndDefaultsToOne() {
  // The format before the verdict existed. Reading the output is forgiving, and
  // the absence of a verdict must never start dissolving clusters.
  const out = parseDescribeOutput("0;;Trump nominates Overton;;The president named her.", 1);
  const r = out.get(0)!;
  assert.equal(r.oneEvent, true);
  assert.equal(r.title, "Trump nominates Overton");
  assert.equal(r.summary, "The president named her.");
}

function testAnUnreadableVerdictIsTreatedAsOne() {
  // A wrongly split cluster loses corroboration; a wrongly merged one publishes
  // two stories under one headline. Only the first is caused by guessing here,
  // so anything unrecognisable leaves the cluster alone — and the word lands in
  // the title rather than being swallowed.
  const out = parseDescribeOutput("0;;probably one;;A title;;A summary.", 1);
  const r = out.get(0)!;
  assert.equal(r.oneEvent, true);
  // Read as the older three-field shape, so nothing in the middle is dropped.
  assert.equal(r.title, "probably one;;A title");
  assert.equal(r.summary, "A summary.");
}

function testAStraySemicolonPairWidensTheSummary() {
  const out = parseDescribeOutput("0;;MULTI;;Title;;first half;;second half", 1);
  const r = out.get(0)!;
  assert.equal(r.oneEvent, false);
  assert.equal(r.title, "Title");
  assert.equal(r.summary, "first half;;second half");
}

function testOutOfRangeAndMalformedLinesAreDropped() {
  assert.equal(parseDescribeOutput("7;;ONE;;T;;S.", 2).size, 0, "index beyond the batch");
  assert.equal(parseDescribeOutput("x;;ONE;;T;;S.", 2).size, 0, "non-numeric index");
  assert.equal(parseDescribeOutput("0;;ONE", 2).size, 0, "one delimiter");
  assert.equal(parseDescribeOutput("0;;ONE;;;;S.", 2).size, 0, "empty title");
}

function testFirstLineForAnIndexWins() {
  const out = parseDescribeOutput(
    ["0;;ONE;;First;;Summary one.", "0;;MULTI;;Second;;Summary two."].join("\n"),
    1,
  );
  assert.equal(out.get(0)!.title, "First");
  assert.equal(out.get(0)!.oneEvent, true);
}

testFourFieldLineCarriesTheVerdict();
testMultiIsFlagged();
testVerdictIsCaseInsensitive();
testAThreeFieldLineStillParsesAndDefaultsToOne();
testAnUnreadableVerdictIsTreatedAsOne();
testAStraySemicolonPairWidensTheSummary();
testOutOfRangeAndMalformedLinesAreDropped();
testFirstLineForAnIndexWins();
console.log("grouping describe tests passed");
