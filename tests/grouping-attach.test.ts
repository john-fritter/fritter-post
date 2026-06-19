import assert from "node:assert/strict";
import {
  buildClusterCandidateSingletons,
  buildProtoGroups,
  chunkArray,
  parseAttachOutput,
} from "../src/pipeline/grouping/index.js";
import type { Cluster } from "../src/lib/cluster.js";
import type { PreprocessedItemRow } from "../src/pipeline/preprocessor/assembler.js";

// --- Helpers ---

function makeItem(id: number, title: string): PreprocessedItemRow {
  return {
    id: String(id),
    source_name: "Test Source",
    source_type: "journalism",
    group: null,
    title,
    body_text: null,
    english_title: title,
    english_body: null,
    published_at: null,
    fetched_at: new Date().toISOString(),
  };
}

// Build a normalized L2 vector from a raw direction vector.
function makeNormVec(components: number[]): number[] {
  const norm = Math.sqrt(components.reduce((s, x) => s + x * x, 0));
  return components.map((x) => x / norm);
}

// Cosine similarity between two (already-normalized) vectors.
function cosineSim(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + v * b[i]!, 0);
}

// Build a 4-dim unit vector at angle theta (in a 2-d subspace, zeros elsewhere).
function vecAt(theta: number): number[] {
  return makeNormVec([Math.cos(theta), Math.sin(theta), 0, 0]);
}

// --- buildClusterCandidateSingletons ---

// Test 1: singleton above floor → appears in candidates
function testClusterCandidates_aboveFloor() {
  // Cluster member at 0°; singleton at 5° (sim ≈ 0.996 >> 0.55).
  const clusterItemIds = [10];
  const vMember = vecAt(0);
  const vClose = vecAt((5 * Math.PI) / 180);
  const vFar = vecAt((80 * Math.PI) / 180); // sim ≈ 0.174 — below floor

  const titleVecs = new Map<number, number[]>([
    [10, vMember],
    [1, vClose],
    [2, vFar],
  ]);

  const result = buildClusterCandidateSingletons(
    clusterItemIds,
    new Set([1, 2]),
    titleVecs,
    0.55,
  );

  assert.deepEqual(result, [1], "only the close singleton should appear");
}

// Test 2: singleton below floor → excluded
function testClusterCandidates_belowFloor() {
  const vMember = vecAt(0);
  const vFar = vecAt((70 * Math.PI) / 180); // cos(70°) ≈ 0.342 — below 0.55

  const titleVecs = new Map<number, number[]>([
    [10, vMember],
    [1, vFar],
  ]);

  const result = buildClusterCandidateSingletons([10], new Set([1]), titleVecs, 0.55);
  assert.deepEqual(result, [], "below-floor singleton must not appear");
}

// Test 3: cluster with no singletons in range → empty result, no call
function testClusterCandidates_noCandidates() {
  const vMember = vecAt(0);
  const titleVecs = new Map<number, number[]>([[10, vMember]]);
  const result = buildClusterCandidateSingletons([10], new Set(), titleVecs, 0.55);
  assert.deepEqual(result, [], "no singletons → empty candidates");
}

// Test 4: multi-member cluster — maxSim over all members determines floor crossing
function testClusterCandidates_multiMemberMaxSim() {
  // Cluster has members at 0° and 90°. Singleton at 80° — far from member@0° (cos≈0.17)
  // but close to member@90° (cos≈0.985). Should appear.
  const vM1 = vecAt(0);
  const vM2 = vecAt((90 * Math.PI) / 180);
  const vSing = vecAt((80 * Math.PI) / 180); // cos(80°,90°)≈0.985, cos(80°,0°)≈0.174

  const titleVecs = new Map<number, number[]>([
    [10, vM1],
    [11, vM2],
    [1, vSing],
  ]);

  const result = buildClusterCandidateSingletons([10, 11], new Set([1]), titleVecs, 0.55);
  assert.deepEqual(result, [1], "singleton close to any member should appear");
}

// Test 5: results sorted by maxSim descending
function testClusterCandidates_sortedBySim() {
  const vMember = vecAt(0);
  const vClose = vecAt((5 * Math.PI) / 180); // cos ≈ 0.996
  const vFurther = vecAt((30 * Math.PI) / 180); // cos ≈ 0.866

  const titleVecs = new Map<number, number[]>([
    [10, vMember],
    [1, vFurther], // id=1 is further
    [2, vClose], // id=2 is closer
  ]);

  const result = buildClusterCandidateSingletons([10], new Set([1, 2]), titleVecs, 0.55);
  assert.equal(result.length, 2);
  assert.equal(result[0], 2, "closer singleton (id=2) should be first");
  assert.equal(result[1], 1);
}

// --- buildProtoGroups ---

// Test 6: two close singletons → one proto-group of 2
function testProtoGroups_pairForms() {
  const vA = vecAt(0);
  const vB = vecAt((5 * Math.PI) / 180);

  const titleVecs = new Map<number, number[]>([
    [1, vA],
    [2, vB],
  ]);

  assert.ok(cosineSim(vA, vB) >= 0.55, "A-B must be above floor");

  const groups = buildProtoGroups(new Set([1, 2]), titleVecs, 0.55);
  assert.equal(groups.length, 1, "one group should form");
  assert.ok(groups[0]!.includes(1) && groups[0]!.includes(2), "group contains both singletons");
}

// Test 7: three connected singletons → one group of 3 (transitivity via union-find)
function testProtoGroups_transitivity() {
  // A-B close, B-C close — A-C also close at these angles
  const vA = vecAt(0);
  const vB = vecAt((5 * Math.PI) / 180);
  const vC = vecAt((7 * Math.PI) / 180);

  const titleVecs = new Map<number, number[]>([
    [10, vA],
    [11, vB],
    [12, vC],
  ]);

  const groups = buildProtoGroups(new Set([10, 11, 12]), titleVecs, 0.55);
  assert.equal(groups.length, 1, "one group of 3");
  const ids = groups[0]!.sort((a, b) => a - b);
  assert.deepEqual(ids, [10, 11, 12]);
}

// Test 8: isolated singleton stays out of all groups
function testProtoGroups_isolateExcluded() {
  // A and B close to each other; C far from both
  const vA = vecAt(0);
  const vB = vecAt((5 * Math.PI) / 180);
  const vC = vecAt((90 * Math.PI) / 180); // orthogonal — cos=0

  const titleVecs = new Map<number, number[]>([
    [1, vA],
    [2, vB],
    [3, vC],
  ]);

  const groups = buildProtoGroups(new Set([1, 2, 3]), titleVecs, 0.55);
  assert.equal(groups.length, 1, "one group (A+B); C stays out");
  const flat = groups.flatMap((g) => g);
  assert.ok(!flat.includes(3), "isolated singleton C must not appear in any group");
}

// Test 9: two disjoint pairs → two groups
function testProtoGroups_twoDisjointPairs() {
  // A=0°, B=2° close; C=90°, D=92° close; A/B far from C/D
  const vA = vecAt(0);
  const vB = vecAt((2 * Math.PI) / 180);
  const vC = vecAt((90 * Math.PI) / 180);
  const vD = vecAt((92 * Math.PI) / 180);

  const floor = 0.55;
  assert.ok(cosineSim(vA, vB) >= floor, "A-B above floor");
  assert.ok(cosineSim(vC, vD) >= floor, "C-D above floor");
  assert.ok(cosineSim(vA, vC) < floor, "A-C below floor");

  const titleVecs = new Map<number, number[]>([
    [1, vA],
    [2, vB],
    [3, vC],
    [4, vD],
  ]);

  const groups = buildProtoGroups(new Set([1, 2, 3, 4]), titleVecs, floor);
  assert.equal(groups.length, 2, "two disjoint groups");
  const allIds = groups.flatMap((g) => g).sort((a, b) => a - b);
  assert.deepEqual(allIds, [1, 2, 3, 4]);
}

// Test 10: empty singleton set → no groups
function testProtoGroups_empty() {
  const groups = buildProtoGroups(new Set(), new Map(), 0.55);
  assert.deepEqual(groups, []);
}

// --- chunkArray ---

// Test 11: basic chunking
function testChunkArray_basic() {
  const result = chunkArray([1, 2, 3, 4, 5], 2);
  assert.deepEqual(result, [[1, 2], [3, 4], [5]]);
}

// Test 12: array smaller than chunk size → single chunk
function testChunkArray_smallerThanSize() {
  const result = chunkArray([10, 20], 40);
  assert.deepEqual(result, [[10, 20]]);
}

// Test 13: oversized list splits correctly at ATTACH_CHUNK_SIZE boundary
function testChunkArray_oversizedAt40() {
  const arr = Array.from({ length: 45 }, (_, i) => i + 1);
  const result = chunkArray(arr, 40);
  assert.equal(result.length, 2, "45 items → 2 chunks");
  assert.equal(result[0]!.length, 40, "first chunk has 40 items");
  assert.equal(result[1]!.length, 5, "second chunk has 5 items");
  assert.equal(result[0]![0], 1, "first item of first chunk");
  assert.equal(result[1]![0], 41, "first item of second chunk");
}

// --- parseAttachOutput ---

// Test 14: "none" → empty set
function testParseAttachOutput_none() {
  assert.equal(parseAttachOutput("none", 5).size, 0);
  assert.equal(parseAttachOutput("NONE", 5).size, 0);
  assert.equal(parseAttachOutput("", 5).size, 0);
  assert.equal(parseAttachOutput("  ", 5).size, 0);
}

// Test 15: valid indices parsed; out-of-range ignored
function testParseAttachOutput_validAndOutOfRange() {
  const result = parseAttachOutput("1,3,7", 5);
  assert.ok(result.has(1));
  assert.ok(result.has(3));
  assert.ok(!result.has(7), "7 out of range (max=5) must be ignored");
  assert.ok(!result.has(0), "0 is not a valid 1-based index");
}

// Test 16: space-separated also works
function testParseAttachOutput_spaceSeparated() {
  const result = parseAttachOutput("2 4", 5);
  assert.ok(result.has(2));
  assert.ok(result.has(4));
  assert.equal(result.size, 2);
}

// --- Structural call-count test ---
//
// Test 17: call count scales with clusters + proto-groups, not singletons.
//
// Fixture layout (all angles on the unit circle):
//   Cluster A  at   0°, Cluster B at 120°, Cluster C at 240°
//   (each pair separated by 120°; cos(120°) = -0.5, well below 0.55 floor)
//
//   Singletons near A (within 56.6° of 0°):     ids 1 (10°), 2 (20°)
//   Singleton  near C (within 56.6° of 240°):   id  3 (250°)
//   No singletons near B
//
//   Proto-group pair  (far from all clusters):   ids 4 (60°),  5 (62°)
//   Proto-group trio  (far from all clusters):   ids 6 (300°), 7 (302°), 8 (304°)
//   (pair-to-trio angle ≈120°, cos=-0.5 — the two groups stay disjoint)
//
// Total singletons: 8. Tasks = 2 (A, C) + 2 (pair, trio) = 4 << 8.

function testCallCountScalesWithClustersAndGroups() {
  const floor = 0.55;
  const deg = (d: number) => (d * Math.PI) / 180;

  const titleVecs = new Map<number, number[]>([
    // cluster members
    [100, vecAt(deg(0))],   // cluster A
    [101, vecAt(deg(120))], // cluster B
    [102, vecAt(deg(240))], // cluster C

    // singletons near clusters
    [1, vecAt(deg(10))],  // near A: cos(10°)≈0.985
    [2, vecAt(deg(20))],  // near A: cos(20°)≈0.940
    [3, vecAt(deg(250))], // near C (250°-240°=10°): cos≈0.985

    // proto-group pair — at 60° from A and B (cos=0.5 < 0.55): no cluster is close
    [4, vecAt(deg(60))],
    [5, vecAt(deg(62))],

    // proto-group trio — at 60° from A and C (cos=0.5 < 0.55): no cluster is close
    [6, vecAt(deg(300))],
    [7, vecAt(deg(302))],
    [8, vecAt(deg(304))],
  ]);

  // Verify geometry invariants
  assert.ok(cosineSim(titleVecs.get(100)!, titleVecs.get(1)!) >= floor, "id1 near cluster A");
  assert.ok(cosineSim(titleVecs.get(100)!, titleVecs.get(2)!) >= floor, "id2 near cluster A");
  assert.ok(cosineSim(titleVecs.get(102)!, titleVecs.get(3)!) >= floor, "id3 near cluster C");
  assert.ok(cosineSim(titleVecs.get(101)!, titleVecs.get(1)!) < floor, "id1 NOT near cluster B");
  assert.ok(cosineSim(titleVecs.get(101)!, titleVecs.get(4)!) < floor, "id4 NOT near cluster B");
  assert.ok(cosineSim(titleVecs.get(4)!, titleVecs.get(5)!) >= floor, "pair 4-5 connected");
  assert.ok(cosineSim(titleVecs.get(6)!, titleVecs.get(7)!) >= floor, "trio 6-7 connected");
  assert.ok(cosineSim(titleVecs.get(4)!, titleVecs.get(6)!) < floor, "pair-to-trio disjoint");

  const clusterA: Cluster = { title: "A", summary: "", item_ids: [100], notes: null };
  const clusterB: Cluster = { title: "B", summary: "", item_ids: [101], notes: null };
  const clusterC: Cluster = { title: "C", summary: "", item_ids: [102], notes: null };
  const clusters = [clusterA, clusterB, clusterC];

  const allSingletons = new Set([1, 2, 3, 4, 5, 6, 7, 8]);

  // Phase A: which clusters have candidates?
  const aCandidates = buildClusterCandidateSingletons([100], allSingletons, titleVecs, floor);
  const bCandidates = buildClusterCandidateSingletons([101], allSingletons, titleVecs, floor);
  const cCandidates = buildClusterCandidateSingletons([102], allSingletons, titleVecs, floor);

  assert.ok(aCandidates.length > 0, "cluster A has candidates (singletons 1, 2)");
  assert.equal(bCandidates.length, 0, "cluster B has NO candidates → no LLM call");
  assert.ok(cCandidates.length > 0, "cluster C has candidates (singleton 3)");

  const phaseATasks = clusters.filter(
    (c) => buildClusterCandidateSingletons(c.item_ids, allSingletons, titleVecs, floor).length > 0,
  ).length;
  assert.equal(phaseATasks, 2, "Phase A tasks = 2 (clusters A and C only)");

  // Phase B: after Phase A consumes singletons 1, 2, 3, leftovers are 4-8
  const leftovers = new Set([4, 5, 6, 7, 8]);
  const protoGroups = buildProtoGroups(leftovers, titleVecs, floor);

  assert.equal(protoGroups.length, 2, "two proto-groups from leftovers");
  const groupSizes = protoGroups.map((g) => g.length).sort((a, b) => a - b);
  assert.deepEqual(groupSizes, [2, 3], "one pair and one trio");

  // Total tasks: 2 Phase A + 2 Phase B = 4 << 8 singletons
  const totalTasks = phaseATasks + protoGroups.length;
  assert.equal(totalTasks, 4, "4 total LLM tasks");
  assert.ok(totalTasks < allSingletons.size, "tasks (4) << singletons (8)");
}

// --- Run all tests ---

testClusterCandidates_aboveFloor();
testClusterCandidates_belowFloor();
testClusterCandidates_noCandidates();
testClusterCandidates_multiMemberMaxSim();
testClusterCandidates_sortedBySim();
testProtoGroups_pairForms();
testProtoGroups_transitivity();
testProtoGroups_isolateExcluded();
testProtoGroups_twoDisjointPairs();
testProtoGroups_empty();
testChunkArray_basic();
testChunkArray_smallerThanSize();
testChunkArray_oversizedAt40();
testParseAttachOutput_none();
testParseAttachOutput_validAndOutOfRange();
testParseAttachOutput_spaceSeparated();
testCallCountScalesWithClustersAndGroups();

console.log("grouping attach tests passed");
