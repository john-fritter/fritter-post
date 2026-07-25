import assert from "node:assert/strict";
import {
  computeComponentDensity,
  computeCohesion,
  maxAchievableDensity,
  parseSplitOutput,
} from "../src/pipeline/grouping/index.js";

// The split pass (step 2b) repairs over-merges that union-find creates: a
// connected component only requires a PATH between members, so a bridging
// article chains unrelated stories together. Density distinguishes the two
// shapes — a real same-event cluster is near-fully connected, a chain is a path.

// Builds a symmetric adjacency map from undirected pairs.
function edgesFrom(pairs: [number, number][]): Map<number, Set<number>> {
  const edges = new Map<number, Set<number>>();
  const ensure = (id: number) => {
    let s = edges.get(id);
    if (!s) {
      s = new Set<number>();
      edges.set(id, s);
    }
    return s;
  };
  for (const [a, b] of pairs) {
    ensure(a).add(b);
    ensure(b).add(a);
  }
  return edges;
}

// --- computeComponentDensity ---

function testFullyConnectedIsOne() {
  // A true same-event cluster: every article resembles every other.
  const edges = edgesFrom([
    [1, 2],
    [1, 3],
    [2, 3],
  ]);
  assert.equal(computeComponentDensity([1, 2, 3], edges), 1);
}

function testChainIsLowDensity() {
  // The over-merge shape: 1—2—3, where 1 and 3 are unrelated.
  // 2 of 3 possible pairs are present.
  const edges = edgesFrom([
    [1, 2],
    [2, 3],
  ]);
  assert.equal(computeComponentDensity([1, 2, 3], edges), 2 / 3);
}

function testLongChainApproachesTwoOverN() {
  // 1—2—3—4—5: 4 edges of 10 possible pairs.
  const edges = edgesFrom([
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
  ]);
  assert.equal(computeComponentDensity([1, 2, 3, 4, 5], edges), 0.4);
}

function testFourItemChainSitsAtTheFloor() {
  // 1—2—3—4: 3 edges of 6 pairs = 0.5, exactly density_floor. The production
  // check is `density < floor`, so this is deliberately NOT suspect — it pins
  // the boundary case documented in models.yaml.
  const edges = edgesFrom([
    [1, 2],
    [2, 3],
    [3, 4],
  ]);
  assert.equal(computeComponentDensity([1, 2, 3, 4], edges), 0.5);
}

function testPairIsAlwaysDense() {
  // Size-2 components cannot be chained; they are 1.0 by construction.
  const edges = edgesFrom([[1, 2]]);
  assert.equal(computeComponentDensity([1, 2], edges), 1);
}

function testSingletonIsDense() {
  assert.equal(computeComponentDensity([1], new Map()), 1);
}

function testMissingAdjacencyEntryDoesNotThrow() {
  // An id with no edges entry contributes no pairs rather than crashing.
  const edges = edgesFrom([[1, 2]]);
  assert.equal(computeComponentDensity([1, 2, 99], edges), 1 / 3);
}

// --- maxAchievableDensity / computeCohesion ---
//
// Step 2 caps each item at top_k neighbours, so raw density has a ceiling that
// falls as components grow. Thresholding raw density would flag every large
// cluster as chained — including run #35's 37-source US-Iran cluster, the single
// most important row in the paper. Cohesion divides out that ceiling.

function testMaxAchievableDensityCeiling() {
  const topK = 15;
  assert.equal(maxAchievableDensity(4, topK), 1); // 15/3 clamps to 1
  assert.equal(maxAchievableDensity(16, topK), 1); // 15/15
  assert.equal(maxAchievableDensity(31, topK), 0.5); // 15/30
  assert.ok(maxAchievableDensity(37, topK) < 0.5); // 15/36 = 0.4167
}

function testLargeCoherentClusterIsNotFlagged() {
  // 37 items, each connected to its 15-neighbour cap: this is the US-Iran
  // cluster. Raw density is 0.417 — under density_floor — but cohesion is 1.0.
  const size = 37;
  const topK = 15;
  const ids = Array.from({ length: size }, (_, i) => i + 1);
  const pairs: [number, number][] = [];
  for (const id of ids) {
    for (let k = 1; k <= topK / 2; k++) {
      const other = ((id - 1 + k) % size) + 1;
      pairs.push([id, other]);
    }
  }
  const edges = edgesFrom(pairs);

  const raw = computeComponentDensity(ids, edges);
  assert.ok(raw < 0.5, `raw density should trip the naive floor, got ${raw}`);

  const cohesion = computeCohesion(ids, edges, topK);
  assert.ok(
    cohesion >= 0.5,
    `a maximally-connected large cluster must not be flagged, got ${cohesion}`,
  );
}

function testLargeChainIsStillFlagged() {
  // Same size, but a path: the correction must not rescue genuine chains.
  const size = 37;
  const topK = 15;
  const ids = Array.from({ length: size }, (_, i) => i + 1);
  const pairs: [number, number][] = [];
  for (let i = 1; i < size; i++) pairs.push([i, i + 1]);
  const edges = edgesFrom(pairs);

  const cohesion = computeCohesion(ids, edges, topK);
  assert.ok(cohesion < 0.5, `a long chain must stay suspect, got ${cohesion}`);
}

function testCohesionMatchesDensityWhenCapIsNotBinding() {
  // For small components the cap is not binding, so cohesion === raw density.
  const edges = edgesFrom([
    [1, 2],
    [2, 3],
  ]);
  assert.equal(computeCohesion([1, 2, 3], edges, 15), 2 / 3);
}

function testCohesionIsClampedToOne() {
  const edges = edgesFrom([
    [1, 2],
    [1, 3],
    [2, 3],
  ]);
  assert.equal(computeCohesion([1, 2, 3], edges, 2), 1);
}

// --- parseSplitOutput ---

function testParsesTwoGroups() {
  const groups = parseSplitOutput("1,2\n3,4", 4);
  assert.deepEqual(groups, [
    [1, 2],
    [3, 4],
  ]);
}

function testNoneReturnsNoGroups() {
  // Every member becomes a singleton — a legitimate verdict, not a failure.
  assert.deepEqual(parseSplitOutput("none", 4), []);
  assert.deepEqual(parseSplitOutput("NONE", 4), []);
  assert.deepEqual(parseSplitOutput("", 4), []);
}

function testSingleGroupMeansComponentWasCorrect() {
  assert.deepEqual(parseSplitOutput("1,2,3", 3), [[1, 2, 3]]);
}

function testDropsOutOfRangeIndices() {
  assert.deepEqual(parseSplitOutput("1,2,99\n0,3,4", 4), [
    [1, 2],
    [3, 4],
  ]);
}

function testItemClaimedTwiceStaysWithFirstGroup() {
  // An item must not end up in two clusters.
  assert.deepEqual(parseSplitOutput("1,2,3\n3,4,5", 5), [
    [1, 2, 3],
    [4, 5],
  ]);
}

function testGroupFallingBelowTwoIsDiscardedAndMembersFreed() {
  // Second line keeps only 4 after dedup, so it is dropped — and 4 must be
  // released, not left marked as claimed, so the caller frees it as a singleton.
  const groups = parseSplitOutput("1,2,3\n3,4", 4);
  assert.deepEqual(groups, [[1, 2, 3]]);
}

function testSpaceSeparatedAndRaggedFormatting() {
  assert.deepEqual(parseSplitOutput("  1 2 \n\n 3,4 \n", 4), [
    [1, 2],
    [3, 4],
  ]);
}

function testPerLineNoneIsSkipped() {
  assert.deepEqual(parseSplitOutput("1,2\nnone\n3,4", 4), [
    [1, 2],
    [3, 4],
  ]);
}

function testSingleIndexLineIsNotAGroup() {
  // A lone number is not a cluster; member 3 is freed as a singleton.
  assert.deepEqual(parseSplitOutput("1,2\n3", 3), [[1, 2]]);
}

// --- the C41 regression ---

function testPowerGridOverMergeIsDetectedAndSplit() {
  // Run #35's "Power grid strains and data center moratoriums amid AI growth"
  // chained three unrelated events through a bridging data-center article:
  //   1 Virginia power line — 2 data centers — 3 NY moratorium — 4 NY transmission
  const edges = edgesFrom([
    [1, 2],
    [2, 3],
    [3, 4],
  ]);
  const density = computeComponentDensity([1, 2, 3, 4], edges);
  assert.ok(density <= 0.5, `chained component should be loose, got ${density}`);

  // The model separates the Virginia incident from the New York policy items.
  assert.deepEqual(parseSplitOutput("3,4", 4), [[3, 4]]);
  // Members 1 and 2 appear in no group, so the caller frees them as singletons
  // for the attach pass to place.
}

testFullyConnectedIsOne();
testChainIsLowDensity();
testLongChainApproachesTwoOverN();
testFourItemChainSitsAtTheFloor();
testPairIsAlwaysDense();
testSingletonIsDense();
testMissingAdjacencyEntryDoesNotThrow();
testMaxAchievableDensityCeiling();
testLargeCoherentClusterIsNotFlagged();
testLargeChainIsStillFlagged();
testCohesionMatchesDensityWhenCapIsNotBinding();
testCohesionIsClampedToOne();
testParsesTwoGroups();
testNoneReturnsNoGroups();
testSingleGroupMeansComponentWasCorrect();
testDropsOutOfRangeIndices();
testItemClaimedTwiceStaysWithFirstGroup();
testGroupFallingBelowTwoIsDiscardedAndMembersFreed();
testSpaceSeparatedAndRaggedFormatting();
testPerLineNoneIsSkipped();
testSingleIndexLineIsNotAGroup();
testPowerGridOverMergeIsDetectedAndSplit();
console.log("grouping split tests passed");
