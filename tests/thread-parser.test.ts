import assert from "node:assert/strict";
import {
  parseThreadOutput,
  deriveThreadScores,
  type ThreadCandidate,
} from "../src/pipeline/thread/index.js";
import { combinedScore } from "../src/pipeline/editor/index.js";

// The thread pass exists because run #43 published five separate Oregon wildfire
// clusters, four of them in the top fifteen. Grouping was right by its own
// criterion — those are distinct events — but a reader experiences them as one
// situation. These tests use that run's real rows.

function candidate(
  ref: string,
  score: number,
  sourceCount: number,
  title = "",
): ThreadCandidate {
  const isCluster = ref.startsWith("C");
  return {
    ref,
    itemType: isCluster ? "cluster" : "singleton",
    clusterIndex: isCluster ? parseInt(ref.slice(1), 10) : null,
    preprocessedItemId: isCluster ? null : parseInt(ref.slice(1), 10),
    score,
    sourceCount,
    title,
    summary: "",
  };
}

const REFS = new Set(["C16", "C17", "C21", "C98", "C18", "S39242", "C44", "C43"]);

// --- parseThreadOutput ---

function testParsesOneThread() {
  const out =
    "Wildfires burn across Oregon as Bench and Beachcomb merge near Warm Springs;;" +
    "the lightning fires that started in late July;;" +
    "Fires across Central and Eastern Oregon have burned over 1.1 million acres.;;" +
    "C16,C17,C21,C98,C18";
  const threads = parseThreadOutput(out, REFS);
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0]!.refs, ["C16", "C17", "C21", "C98", "C18"]);
  assert.ok(threads[0]!.title.startsWith("Wildfires burn across Oregon"));
  assert.ok(threads[0]!.summary.includes("1.1 million acres"));
}

function testTheAnchorIsItsOwnColumn() {
  // The anchor is what forces the criterion to be applied: run #8's
  // "immigration crackdown" and run #113's "Afghanistan under Taliban" both
  // pattern-matched "one front of one war" and neither had one.
  const out =
    "Iran conflict escalates around the Strait of Hormuz;;" +
    "Israel's strikes on Iran beginning February 28;;" +
    "Trump halted negotiations as the 60-day window expired.;;" +
    "C16,C17";
  const threads = parseThreadOutput(out, REFS);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]!.anchor, "Israel's strikes on Iran beginning February 28");
  assert.ok(threads[0]!.summary.startsWith("Trump halted negotiations"));
}

function testAStraySemicolonPairLandsInTheSummary() {
  // Columns come from the first, second and last delimiter, so extra ones can
  // only widen the summary — never shift the refs or swallow the anchor.
  const out = "Title;;the anchor;;first half;;second half;;C16,C17";
  const threads = parseThreadOutput(out, REFS);
  assert.equal(threads.length, 1);
  assert.equal(threads[0]!.anchor, "the anchor");
  assert.equal(threads[0]!.summary, "first half;;second half");
  assert.deepEqual(threads[0]!.refs, ["C16", "C17"]);
}

function testAThreeFieldLineStillFormsAThread() {
  // The output format before the anchor existed. Reading the output is
  // forgiving: this loses the summary, not the thread.
  const out = "Oregon fires;;Fires burned across Central Oregon.;;C16,C17";
  const threads = parseThreadOutput(out, REFS);
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0]!.refs, ["C16", "C17"]);
  assert.equal(threads[0]!.title, "Oregon fires");
  assert.equal(threads[0]!.summary, "");
}

function testNoneMeansNoThreads() {
  assert.deepEqual(parseThreadOutput("none", REFS), []);
  assert.deepEqual(parseThreadOutput("NONE", REFS), []);
  assert.deepEqual(parseThreadOutput("", REFS), []);
  assert.deepEqual(parseThreadOutput("   \n  ", REFS), []);
}

function testMultipleThreads() {
  const out = ["Oregon fires;;A.;;Summary one.;;C16,C17", "Iran war;;A.;;Summary two.;;C44,C43"].join("\n");
  const threads = parseThreadOutput(out, REFS);
  assert.equal(threads.length, 2);
  assert.deepEqual(threads[0]!.refs, ["C16", "C17"]);
  assert.deepEqual(threads[1]!.refs, ["C44", "C43"]);
}

function testRefClaimedTwiceStaysWithFirstThread() {
  // An item must never appear twice in the paper — that repetition is the
  // entire reason this pass exists. C21 is claimed by both lines; the first
  // keeps it, which leaves the second with only C98, below the two-member
  // minimum, so it is dropped entirely.
  const out = ["Oregon fires;;A.;;S.;;C16,C17,C21", "Something else;;A.;;S.;;C21,C98"].join("\n");
  const threads = parseThreadOutput(out, REFS);
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0]!.refs, ["C16", "C17", "C21"]);
}

function testContestedRefStillLeavesViableSecondThread() {
  // Same contention, but the second thread has enough members to survive it.
  const out = ["Oregon fires;;A.;;S.;;C16,C17,C21", "Other;;A.;;S.;;C21,C98,C18"].join("\n");
  const threads = parseThreadOutput(out, REFS);
  assert.equal(threads.length, 2);
  assert.deepEqual(threads[0]!.refs, ["C16", "C17", "C21"]);
  assert.deepEqual(threads[1]!.refs, ["C98", "C18"], "C21 must not be duplicated");
}

function testUnknownRefsAreDropped() {
  const out = "Oregon fires;;A.;;Summary.;;C16,C17,C999,S12345";
  const threads = parseThreadOutput(out, REFS);
  assert.deepEqual(threads[0]!.refs, ["C16", "C17"]);
}

function testThreadWithFewerThanTwoMembersIsDropped() {
  const out = "Lonely;;A.;;Summary.;;C16";
  assert.deepEqual(parseThreadOutput(out, REFS), []);
}

function testDroppedThreadReleasesItsMembers() {
  // C16 is claimed by a one-member thread that gets dropped, so it must remain
  // available to the thread on the next line.
  const out = ["Dropped;;A.;;S.;;C16", "Real thread;;A.;;S.;;C16,C17"].join("\n");
  const threads = parseThreadOutput(out, REFS);
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0]!.refs, ["C16", "C17"]);
}

function testBracketedAndSpacedRefs() {
  const out = "Oregon fires;;A.;;Summary.;; [C16] , c17 , C21 ";
  const threads = parseThreadOutput(out, REFS);
  assert.deepEqual(threads[0]!.refs, ["C16", "C17", "C21"]);
}

function testSingletonRefsWork() {
  const out = "Bend news;;A.;;Summary.;;C16,S39242";
  const threads = parseThreadOutput(out, REFS);
  assert.deepEqual(threads[0]!.refs, ["C16", "S39242"]);
}

function testMalformedLinesAreSkipped() {
  const out = [
    "no delimiters at all",
    "only;;one delimiter C16,C17",
    "Oregon fires;;A.;;Summary.;;C16,C17",
    ";;A.;;empty title;;C21,C98",
  ].join("\n");
  const threads = parseThreadOutput(out, REFS);
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0]!.refs, ["C16", "C17"]);
}

function testSummaryMayContainCommas() {
  const out = "Oregon fires;;A.;;Fires burned, evacuations followed, smoke spread.;;C16,C17";
  const threads = parseThreadOutput(out, REFS);
  assert.equal(threads[0]!.summary, "Fires burned, evacuations followed, smoke spread.");
  assert.deepEqual(threads[0]!.refs, ["C16", "C17"]);
}

// --- deriveThreadScores ---

function testScoreIsMaxAndSourcesAreSum() {
  // Run #43's five Oregon wildfire rows, verbatim.
  const members = [
    candidate("C16", 78, 12), // Wildfires surge across Central Oregon
    candidate("C17", 85, 5),  // Bench and Beachcomb fires merge, Warm Springs
    candidate("C21", 80, 2),  // Evacuations across 1.1 million acres
    candidate("C98", 80, 2),  // National Guard activates aircraft
    candidate("C18", 60, 2),  // Aid groups, farmworkers, smoke
  ];
  const { score, sourceCount } = deriveThreadScores(members);
  assert.equal(score, 85, "thread is as relevant as its strongest member");
  assert.equal(sourceCount, 23, "cross-source pickup adds up");
}

function testThreadOutranksItsBestMember() {
  // The point of summing sources: the thread must beat every member it absorbed,
  // or threading would bury the situation instead of leading with it.
  const members = [
    candidate("C16", 78, 12),
    candidate("C17", 85, 5),
    candidate("C21", 80, 2),
    candidate("C98", 80, 2),
    candidate("C18", 60, 2),
  ];
  const { score, sourceCount } = deriveThreadScores(members);
  const W = 9;
  const threadCombined = combinedScore(score, sourceCount, W);
  for (const m of members) {
    assert.ok(
      threadCombined > combinedScore(m.score, m.sourceCount, W),
      `thread (${threadCombined.toFixed(2)}) must outrank member ${m.ref}`,
    );
  }
  // Run #43's lead was 111.64. The threaded fires clear it.
  assert.ok(
    threadCombined > 111.64,
    `expected the Oregon fire thread to lead the paper, got ${threadCombined.toFixed(2)}`,
  );
}

function testSingleMemberDegeneratesToItself() {
  const { score, sourceCount } = deriveThreadScores([candidate("C16", 78, 12)]);
  assert.equal(score, 78);
  assert.equal(sourceCount, 12);
}

function testEmptyMembers() {
  const { score, sourceCount } = deriveThreadScores([]);
  assert.equal(score, 0);
  assert.equal(sourceCount, 0);
}

function testSingletonsContributeOneSourceEach() {
  const members = [candidate("S1", 70, 1), candidate("S2", 72, 1), candidate("S3", 65, 1)];
  const { score, sourceCount } = deriveThreadScores(members);
  assert.equal(score, 72);
  assert.equal(sourceCount, 3);
  // ln(3) > 0, so a thread of singletons still gets a prominence lift that no
  // individual singleton could earn.
  assert.ok(combinedScore(score, sourceCount, 9) > combinedScore(72, 1, 9));
}

testParsesOneThread();
testTheAnchorIsItsOwnColumn();
testAStraySemicolonPairLandsInTheSummary();
testAThreeFieldLineStillFormsAThread();
testNoneMeansNoThreads();
testMultipleThreads();
testRefClaimedTwiceStaysWithFirstThread();
testContestedRefStillLeavesViableSecondThread();
testUnknownRefsAreDropped();
testThreadWithFewerThanTwoMembersIsDropped();
testDroppedThreadReleasesItsMembers();
testBracketedAndSpacedRefs();
testSingletonRefsWork();
testMalformedLinesAreSkipped();
testSummaryMayContainCommas();
testScoreIsMaxAndSourcesAreSum();
testThreadOutranksItsBestMember();
testSingleMemberDegeneratesToItself();
testEmptyMembers();
testSingletonsContributeOneSourceEach();
console.log("thread parser tests passed");
