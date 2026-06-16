import assert from "node:assert/strict";
import { buildAttachCandidates } from "../src/pipeline/grouping/index.js";
import type { AttachCandidate } from "../src/pipeline/grouping/index.js";
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

// Build a 4-dim vector at angle theta (in a 2-d subspace, zeros elsewhere).
function vecAt(theta: number): number[] {
  return makeNormVec([Math.cos(theta), Math.sin(theta), 0, 0]);
}

// --- Test 1: title-only candidate generation — singletons above floor appear ---

function testSingletonAboveFloorIsCandidate() {
  // Anchor at angle 0; singleton at angle ~10°; cosine sim ≈ 0.985.
  const anchor = vecAt(0);
  const close = vecAt((10 * Math.PI) / 180);
  const far = vecAt((80 * Math.PI) / 180); // cosine sim ≈ 0.174

  const titleVecs = new Map<number, number[]>([
    [1, anchor],
    [2, close],
    [3, far],
  ]);

  const candidates = buildAttachCandidates(
    1,
    [],
    new Set([2, 3]),
    titleVecs,
    0.55,
    8,
  );

  assert.equal(candidates.length, 1, "only the close singleton should appear");
  assert.equal(candidates[0]!.type, "singleton");
  const cand = candidates[0] as Extract<AttachCandidate, { type: "singleton" }>;
  assert.equal(cand.id, 2);
  assert.ok(cand.sim > 0.95, `expected sim > 0.95, got ${cand.sim}`);
}

// --- Test 2: anchor is excluded from its own candidate list ---

function testAnchorExcludedFromCandidates() {
  const anchor = vecAt(0);
  const titleVecs = new Map<number, number[]>([
    [1, anchor],
    [2, vecAt((5 * Math.PI) / 180)], // very close
  ]);

  const candidates = buildAttachCandidates(
    1,
    [],
    new Set([1, 2]), // anchor id in available set
    titleVecs,
    0.55,
    8,
  );

  const ids = candidates.map((c) => (c.type === "singleton" ? c.id : null));
  assert.ok(!ids.includes(1), "anchor (id=1) must not appear in its own candidates");
}

// --- Test 3: cluster candidate appears when a member is close enough ---

function testClusterCandidateAboveFloor() {
  const anchor = vecAt(0);
  const clusterMember = vecAt((15 * Math.PI) / 180); // cosine ≈ 0.966

  const clusters: Cluster[] = [
    { title: "Ebola Cluster", summary: "", item_ids: [10, 11], notes: null },
  ];
  const titleVecs = new Map<number, number[]>([
    [1, anchor],
    [10, clusterMember],
    [11, vecAt((90 * Math.PI) / 180)], // far member — should not matter; max sim used
  ]);

  const candidates = buildAttachCandidates(
    1,
    clusters,
    new Set(),
    titleVecs,
    0.55,
    8,
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.type, "cluster");
  const cc = candidates[0] as Extract<AttachCandidate, { type: "cluster" }>;
  assert.equal(cc.clusterIdx, 0);
  assert.ok(cc.maxSim > 0.95);
}

// --- Test 4: items below floor are not included ---

function testBelowFloorExcluded() {
  const anchor = vecAt(0);
  // Angle ~70°: cosine ≈ 0.342 — below any reasonable floor
  const distant = vecAt((70 * Math.PI) / 180);

  const titleVecs = new Map<number, number[]>([
    [1, anchor],
    [2, distant],
  ]);

  const candidates = buildAttachCandidates(1, [], new Set([2]), titleVecs, 0.55, 8);
  assert.equal(candidates.length, 0, "below-floor item must not appear");
}

// --- Test 5: candidate_top_k cap is applied ---

function testTopKCap() {
  const anchor = vecAt(0);
  // Six singletons all above floor with slightly different angles
  const titleVecs = new Map<number, number[]>([[1, anchor]]);
  const available = new Set<number>();
  for (let i = 2; i <= 7; i++) {
    titleVecs.set(i, vecAt((i * Math.PI) / 180)); // 2°..7° — all very close
    available.add(i);
  }

  const candidates = buildAttachCandidates(1, [], available, titleVecs, 0.55, 3);
  assert.equal(candidates.length, 3, "top_k=3 should cap the list");
}

// --- Test 6: candidates are sorted by sim descending ---

function testCandidatesAreSortedBySim() {
  const anchor = vecAt(0);
  // Singleton A at 5°, singleton B at 20° — A is closer
  const vA = vecAt((5 * Math.PI) / 180);
  const vB = vecAt((20 * Math.PI) / 180);

  const titleVecs = new Map<number, number[]>([
    [1, anchor],
    [2, vA],
    [3, vB],
  ]);

  const simA = cosineSim(anchor, vA);
  const simB = cosineSim(anchor, vB);

  const candidates = buildAttachCandidates(1, [], new Set([2, 3]), titleVecs, 0.55, 8);
  assert.equal(candidates.length, 2);
  const c0 = candidates[0] as Extract<AttachCandidate, { type: "singleton" }>;
  const c1 = candidates[1] as Extract<AttachCandidate, { type: "singleton" }>;
  assert.ok(
    c0.sim >= c1.sim,
    `expected sorted descending: ${c0.sim} >= ${c1.sim}`,
  );
  assert.equal(c0.id, 2, "closest singleton (2) should be first");
  assert.ok(Math.abs(c0.sim - simA) < 1e-10);
  assert.ok(Math.abs(c1.sim - simB) < 1e-10);
}

// --- Test 7: singleton↔singleton pairing — union-find simulation ---
//
// Simulates two rounds of the sequential attach loop (mocked LLM responses)
// to verify the union-find behavior:
//   Round 1: anchor=A, candidates=[B], mock confirms B → {A,B} new cluster
//   Round 2: anchor=C, candidates=[cluster {A,B}], mock confirms cluster → C attaches
//
// We call buildAttachCandidates directly and apply results manually, mirroring
// what attachSingletons does in the real async loop.

function testSingletonPairingAndCascadeAttach() {
  // Angles: A≈0°, B≈8°, C≈6° — all close to each other
  const vA = vecAt(0);
  const vB = vecAt((8 * Math.PI) / 180);
  const vC = vecAt((6 * Math.PI) / 180);

  const titleVecs = new Map<number, number[]>([
    [10, vA], // anchor A
    [11, vB], // singleton B
    [12, vC], // singleton C
  ]);

  const itemA = makeItem(10, "Iran launches missiles at Israel");
  const itemB = makeItem(11, "Iran fires ballistic missiles at Israeli territory");
  const itemC = makeItem(12, "Iran missile attack on Israeli bases overnight");
  const itemById = new Map([[10, itemA], [11, itemB], [12, itemC]]);

  let currentClusters: Cluster[] = [];
  let remainingSingletons = new Set([10, 11, 12]);

  // --- Round 1: anchor=A (id=10) ---
  const availableForA = new Set(remainingSingletons);
  availableForA.delete(10);

  const candidatesForA = buildAttachCandidates(10, currentClusters, availableForA, titleVecs, 0.55, 8);

  // Expect B (11) and C (12) as singleton candidates
  assert.ok(candidatesForA.length >= 1, "A should have singleton candidates");
  const singletonCandidateIds = candidatesForA
    .filter((c) => c.type === "singleton")
    .map((c) => (c as Extract<AttachCandidate, { type: "singleton" }>).id);
  assert.ok(singletonCandidateIds.includes(11), "B should be a candidate for A");

  // Mock LLM: confirms candidate 1 (B, the first/highest-sim singleton candidate for A)
  // Find which index B is at
  const bIdx = candidatesForA.findIndex(
    (c) => c.type === "singleton" && (c as Extract<AttachCandidate, { type: "singleton" }>).id === 11,
  );
  assert.ok(bIdx >= 0, "B must be in A's candidate list");

  // Apply: pair A + B → new cluster
  const newCluster: Cluster = {
    title: itemA.title.slice(0, 80),
    summary: `${itemA.title} | ${itemB.title}`,
    item_ids: [10, 11],
    notes: null,
  };
  currentClusters = [newCluster];
  remainingSingletons.delete(10);
  remainingSingletons.delete(11);

  assert.deepEqual([...remainingSingletons], [12], "only C (12) should remain");
  assert.equal(currentClusters.length, 1, "one cluster should have been formed");
  assert.deepEqual(currentClusters[0]!.item_ids, [10, 11]);

  // --- Round 2: anchor=C (id=12) ---
  const availableForC = new Set(remainingSingletons);
  availableForC.delete(12);

  const candidatesForC = buildAttachCandidates(12, currentClusters, availableForC, titleVecs, 0.55, 8);

  // Expect the {A,B} cluster to appear as a cluster candidate (both A and B are close to C)
  const clusterCandidates = candidatesForC.filter((c) => c.type === "cluster");
  assert.ok(clusterCandidates.length >= 1, "C should see the newly formed A+B cluster as a candidate");
  const cc = clusterCandidates[0] as Extract<AttachCandidate, { type: "cluster" }>;
  assert.equal(cc.clusterIdx, 0, "cluster candidate should be the A+B cluster at index 0");
  assert.ok(cc.maxSim >= 0.55, `max sim to cluster should be above floor: ${cc.maxSim}`);

  // Mock LLM: confirms cluster candidate (cluster index 0)
  // Apply: C attaches to the A+B cluster
  const target = currentClusters[cc.clusterIdx]!;
  currentClusters[cc.clusterIdx] = { ...target, item_ids: [...target.item_ids, 12] };
  remainingSingletons.delete(12);

  assert.equal(remainingSingletons.size, 0, "all singletons should be consumed");
  assert.deepEqual(currentClusters[0]!.item_ids, [10, 11, 12], "cluster should contain A, B, C");
}

// --- Test 8: anchor with no title vector generates no candidates ---

function testAnchorWithNoVectorSkipped() {
  const titleVecs = new Map<number, number[]>([
    // anchor id=1 has no entry
    [2, vecAt(0)],
  ]);

  const candidates = buildAttachCandidates(1, [], new Set([2]), titleVecs, 0.55, 8);
  assert.equal(candidates.length, 0, "anchor with no vector should produce no candidates");
}

// --- Test 9: cluster with no member vectors does not appear as candidate ---

function testClusterWithNoVectorsExcluded() {
  const anchor = vecAt(0);
  const clusters: Cluster[] = [
    { title: "Cluster with no vectors", summary: "", item_ids: [10, 11], notes: null },
  ];
  const titleVecs = new Map<number, number[]>([
    [1, anchor],
    // 10 and 11 have no entries → max sim will be 0, below floor
  ]);

  const candidates = buildAttachCandidates(1, clusters, new Set(), titleVecs, 0.55, 8);
  assert.equal(candidates.length, 0, "cluster with no member vectors should not appear");
}

// --- Run all tests ---

testSingletonAboveFloorIsCandidate();
testAnchorExcludedFromCandidates();
testClusterCandidateAboveFloor();
testBelowFloorExcluded();
testTopKCap();
testCandidatesAreSortedBySim();
testSingletonPairingAndCascadeAttach();
testAnchorWithNoVectorSkipped();
testClusterWithNoVectorsExcluded();

console.log("grouping attach tests passed");
