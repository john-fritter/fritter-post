import assert from "node:assert/strict";
import {
  buildAttachCandidates,
  applyAttachRound,
  computeNextDirty,
} from "../src/pipeline/grouping/index.js";
import type { AttachCandidate, AttachProposal } from "../src/pipeline/grouping/index.js";
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

  const candidates = buildAttachCandidates(1, [], new Set([2, 3]), titleVecs, 0.55);

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

  // anchor id (1) is in the available set — must not appear in output
  const candidates = buildAttachCandidates(1, [], new Set([1, 2]), titleVecs, 0.55);

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

  const candidates = buildAttachCandidates(1, clusters, new Set(), titleVecs, 0.55);

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

  const candidates = buildAttachCandidates(1, [], new Set([2]), titleVecs, 0.55);
  assert.equal(candidates.length, 0, "below-floor item must not appear");
}

// --- Test 5: all candidates above floor are returned — no truncation ---
//
// 12 singletons all above floor; all 12 must appear in the output.
// candidate_floor is the sole filter; there is no per-anchor cap.

function testAllAboveFloorReturnedNoTruncation() {
  const anchor = vecAt(0);
  const titleVecs = new Map<number, number[]>([[1, anchor]]);
  const available = new Set<number>();
  for (let i = 2; i <= 13; i++) {
    titleVecs.set(i, vecAt((i * Math.PI) / 180)); // 2°..13° — all well above floor
    available.add(i);
  }

  const candidates = buildAttachCandidates(1, [], available, titleVecs, 0.55);
  assert.equal(candidates.length, 12, "all 12 candidates above floor must be returned");
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

  const candidates = buildAttachCandidates(1, [], new Set([2, 3]), titleVecs, 0.55);
  assert.equal(candidates.length, 2);
  const c0 = candidates[0] as Extract<AttachCandidate, { type: "singleton" }>;
  const c1 = candidates[1] as Extract<AttachCandidate, { type: "singleton" }>;
  assert.ok(c0.sim >= c1.sim, `expected sorted descending: ${c0.sim} >= ${c1.sim}`);
  assert.equal(c0.id, 2, "closest singleton (2) should be first");
  assert.ok(Math.abs(c0.sim - simA) < 1e-10);
  assert.ok(Math.abs(c1.sim - simB) < 1e-10);
}

// --- Test 7: singleton↔singleton pairing — union-find simulation ---
//
// Simulates two rounds of the sequential attach loop (mocked LLM responses)
// to verify the union-find behavior:
//   Round 1: anchor=A, candidates=[B, C], mock confirms B → {A,B} new cluster
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
  // itemById used only to verify makeItem; not needed by buildAttachCandidates itself
  void itemA; void itemB; void itemC;

  let currentClusters: Cluster[] = [];
  let remainingSingletons = new Set([10, 11, 12]);

  // --- Round 1: anchor=A (id=10) ---
  const availableForA = new Set(remainingSingletons);
  availableForA.delete(10);

  const candidatesForA = buildAttachCandidates(10, currentClusters, availableForA, titleVecs, 0.55);

  // B (11) and C (12) should both appear as singleton candidates — no cap drops them.
  assert.ok(candidatesForA.length >= 2, "A should see both B and C as candidates");
  const singletonCandidateIds = candidatesForA
    .filter((c) => c.type === "singleton")
    .map((c) => (c as Extract<AttachCandidate, { type: "singleton" }>).id);
  assert.ok(singletonCandidateIds.includes(11), "B must be a candidate for A");
  assert.ok(singletonCandidateIds.includes(12), "C must be a candidate for A");

  // Mock LLM: confirms only B (id=11) as same event.
  // Apply: pair A + B → new cluster.
  const newCluster: Cluster = {
    title: "Iran launches missiles at Israel",
    summary: "Iran launches missiles at Israel | Iran fires ballistic missiles at Israeli territory",
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

  const candidatesForC = buildAttachCandidates(12, currentClusters, availableForC, titleVecs, 0.55);

  // The {A,B} cluster must appear as a cluster candidate.
  const clusterCandidates = candidatesForC.filter((c) => c.type === "cluster");
  assert.ok(clusterCandidates.length >= 1, "C should see the newly formed A+B cluster as a candidate");
  const cc = clusterCandidates[0] as Extract<AttachCandidate, { type: "cluster" }>;
  assert.equal(cc.clusterIdx, 0, "cluster candidate should be the A+B cluster at index 0");
  assert.ok(cc.maxSim >= 0.55, `max sim to cluster should be above floor: ${cc.maxSim}`);

  // Mock LLM: confirms the cluster. Apply: C attaches to {A,B}.
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

  const candidates = buildAttachCandidates(1, [], new Set([2]), titleVecs, 0.55);
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

  const candidates = buildAttachCandidates(1, clusters, new Set(), titleVecs, 0.55);
  assert.equal(candidates.length, 0, "cluster with no member vectors should not appear");
}

// --- Test 10: contention resolution — higher-sim anchor wins a contested singleton ---
//
// Anchors A (anchorBestSim=0.9) and B (anchorBestSim=0.7) both propose to pair
// with singleton C. A should win; C ends up with A; B remains as a singleton.

function testContentionResolvesToHigherSimAnchor() {
  const itemA = makeItem(1, "Iran launches missiles at Israel");
  const itemB = makeItem(2, "Iran fires ballistic missiles");
  const itemC = makeItem(3, "Iran missile attack overnight");
  const itemById = new Map([
    [1, itemA],
    [2, itemB],
    [3, itemC],
  ]);

  const currentClusters: Cluster[] = [];
  const remainingSingletonIds = new Set([1, 2, 3]);

  const proposals: AttachProposal[] = [
    { anchorId: 1, anchorBestSim: 0.9, confirmedClusters: [], confirmedSingletonIds: [3] },
    { anchorId: 2, anchorBestSim: 0.7, confirmedClusters: [], confirmedSingletonIds: [3] },
  ];

  const { attachedToCluster, newPairsFormed } = applyAttachRound(
    proposals,
    currentClusters,
    remainingSingletonIds,
    itemById,
  );

  assert.equal(newPairsFormed, 1, "one pair should form");
  assert.equal(attachedToCluster, 0, "no attachments to existing clusters");
  assert.equal(currentClusters.length, 1, "one cluster formed");
  assert.ok(currentClusters[0]!.item_ids.includes(1), "A should be in the winning cluster");
  assert.ok(currentClusters[0]!.item_ids.includes(3), "C should be in the winning cluster");
  assert.ok(!currentClusters[0]!.item_ids.includes(2), "B should not be in the cluster");
  assert.ok(remainingSingletonIds.has(2), "B remains a singleton after losing the contest");
  assert.ok(!remainingSingletonIds.has(1), "A consumed");
  assert.ok(!remainingSingletonIds.has(3), "C consumed by A");
}

// --- Test 11: cascade across rounds — C sees pair formed in round 1 ---
//
// Round 1 apply: A + B form a new cluster {A, B}.
// Round 2 snapshot includes that cluster; C's buildAttachCandidates call sees it
// and C attaches to it via a second applyAttachRound call.

function testCascadeAcrossRounds() {
  const vA = vecAt(0);
  const vB = vecAt((5 * Math.PI) / 180);
  const vC = vecAt((7 * Math.PI) / 180);

  const titleVecs = new Map<number, number[]>([
    [10, vA],
    [11, vB],
    [12, vC],
  ]);

  const itemA = makeItem(10, "Iran launches missiles at Israel");
  const itemB = makeItem(11, "Iran fires ballistic missiles at Israeli territory");
  const itemC = makeItem(12, "Iran missile attack overnight");
  const itemById = new Map([
    [10, itemA],
    [11, itemB],
    [12, itemC],
  ]);

  const currentClusters: Cluster[] = [];
  const remainingSingletonIds = new Set([10, 11, 12]);

  // --- Round 1: A and B form a pair ---
  const round1Proposals: AttachProposal[] = [
    {
      anchorId: 10,
      anchorBestSim: cosineSim(vA, vB),
      confirmedClusters: [],
      confirmedSingletonIds: [11],
    },
  ];
  const { newPairsFormed: r1Pairs } = applyAttachRound(
    round1Proposals,
    currentClusters,
    remainingSingletonIds,
    itemById,
  );
  assert.equal(r1Pairs, 1, "round 1 should form one pair");
  assert.equal(currentClusters.length, 1, "one cluster after round 1");
  assert.deepEqual(currentClusters[0]!.item_ids, [10, 11]);
  assert.deepEqual([...remainingSingletonIds], [12], "only C remains after round 1");

  // --- Round 2: C should see {A, B} as a cluster candidate ---
  // Simulate what the round loop does: snapshot includes the new cluster.
  const snapshotClusters = currentClusters.slice();
  const availableForC = new Set(remainingSingletonIds);
  availableForC.delete(12);

  const candidatesForC = buildAttachCandidates(12, snapshotClusters, availableForC, titleVecs, 0.55);
  const clusterCandidates = candidatesForC.filter((c) => c.type === "cluster");
  assert.ok(
    clusterCandidates.length >= 1,
    "C should see the {A,B} cluster formed in round 1 as a candidate in round 2",
  );

  const cc = clusterCandidates[0] as Extract<AttachCandidate, { type: "cluster" }>;
  const round2Proposals: AttachProposal[] = [
    {
      anchorId: 12,
      anchorBestSim: cc.maxSim,
      confirmedClusters: [{ clusterIdx: cc.clusterIdx, maxSim: cc.maxSim }],
      confirmedSingletonIds: [],
    },
  ];
  const { attachedToCluster: r2Attaches } = applyAttachRound(
    round2Proposals,
    currentClusters,
    remainingSingletonIds,
    itemById,
  );
  assert.equal(r2Attaches, 1, "C attaches to the {A,B} cluster in round 2");
  assert.equal(remainingSingletonIds.size, 0, "no remaining singletons after cascade");
  assert.deepEqual(currentClusters[0]!.item_ids, [10, 11, 12], "cluster contains A, B, C");
}

// --- Test 12: empty LLM response yields no merge ---
//
// When a proposal has both confirmedClusters and confirmedSingletonIds empty
// (representing an LLM response of "none" / empty text), applyAttachRound
// produces no merge for that anchor and leaves it as a singleton.

function testEmptyProposalYieldsNoMerge() {
  const currentClusters: Cluster[] = [];
  const remainingSingletonIds = new Set([1, 2, 3]);
  const itemById = new Map<number, PreprocessedItemRow>([
    [1, makeItem(1, "Item 1")],
    [2, makeItem(2, "Item 2")],
    [3, makeItem(3, "Item 3")],
  ]);

  const proposals: AttachProposal[] = [
    { anchorId: 1, anchorBestSim: 0.9, confirmedClusters: [], confirmedSingletonIds: [] },
    { anchorId: 2, anchorBestSim: 0.8, confirmedClusters: [], confirmedSingletonIds: [] },
  ];

  const { attachedToCluster, newPairsFormed } = applyAttachRound(
    proposals,
    currentClusters,
    remainingSingletonIds,
    itemById,
  );

  assert.equal(attachedToCluster, 0, "no attaches from empty proposals");
  assert.equal(newPairsFormed, 0, "no pairs from empty proposals");
  assert.equal(currentClusters.length, 0, "no clusters formed");
  assert.equal(remainingSingletonIds.size, 3, "all singletons remain");
}

// --- Test 13: no-contention equivalence — concurrent rounds match sequential result ---
//
// Three disjoint pairs (A↔D, B↔E, C↔F) where cross-pair sims are all below the
// floor. All six proposals fire in one round with no contention; the result must
// match what sequential processing would produce: three separate 2-item clusters.

function testNoContentionEquivalence() {
  // A=0°, D=2°, B=60°, E=62°, C=120°, F=122°
  // Within-pair cos ≈ 0.9994; across-group cos ≤ cos(58°) ≈ 0.53 — below 0.55 floor.
  const vA = vecAt(0);
  const vD = vecAt((2 * Math.PI) / 180);
  const vB = vecAt((60 * Math.PI) / 180);
  const vE = vecAt((62 * Math.PI) / 180);
  const vC = vecAt((120 * Math.PI) / 180);
  const vF = vecAt((122 * Math.PI) / 180);

  const titleVecs = new Map<number, number[]>([
    [1, vA],
    [2, vD],
    [3, vB],
    [4, vE],
    [5, vC],
    [6, vF],
  ]);

  const floor = 0.55;
  assert.ok(cosineSim(vA, vD) >= floor, "A-D within floor");
  assert.ok(cosineSim(vB, vE) >= floor, "B-E within floor");
  assert.ok(cosineSim(vC, vF) >= floor, "C-F within floor");
  assert.ok(cosineSim(vA, vB) < floor, "A-B cross-pair below floor");
  assert.ok(cosineSim(vA, vC) < floor, "A-C cross-pair below floor");
  assert.ok(cosineSim(vB, vC) < floor, "B-C cross-pair below floor");

  const itemById = new Map<number, PreprocessedItemRow>([
    [1, makeItem(1, "Item 1")],
    [2, makeItem(2, "Item 2")],
    [3, makeItem(3, "Item 3")],
    [4, makeItem(4, "Item 4")],
    [5, makeItem(5, "Item 5")],
    [6, makeItem(6, "Item 6")],
  ]);

  const singletonIds = new Set([1, 2, 3, 4, 5, 6]);
  const clusters: Cluster[] = [];

  // Simulate one concurrent round: all 6 anchors build from same snapshot.
  const proposals: AttachProposal[] = [];
  for (const anchorId of [1, 2, 3, 4, 5, 6]) {
    const anchorVec = titleVecs.get(anchorId)!;
    const available = new Set(singletonIds);
    available.delete(anchorId);
    const candidates = buildAttachCandidates(anchorId, clusters, available, titleVecs, floor);
    if (candidates.length === 0) continue;

    // Compute bestSim (max over all others).
    let bestSim = 0;
    for (const otherId of singletonIds) {
      if (otherId === anchorId) continue;
      const ov = titleVecs.get(otherId)!;
      const s = cosineSim(anchorVec, ov);
      if (s > bestSim) bestSim = s;
    }

    // Mock LLM: confirm the top singleton candidate (only one exists per anchor above the floor).
    const topCand = candidates[0];
    if (topCand && topCand.type === "singleton") {
      proposals.push({
        anchorId,
        anchorBestSim: bestSim,
        confirmedClusters: [],
        confirmedSingletonIds: [topCand.id],
      });
    }
  }

  const { newPairsFormed } = applyAttachRound(proposals, clusters, singletonIds, itemById);

  assert.equal(newPairsFormed, 3, "3 disjoint pairs should form with no contention");
  assert.equal(clusters.length, 3, "3 clusters");
  assert.equal(singletonIds.size, 0, "no remaining singletons");

  const allPaired = clusters.flatMap((c) => c.item_ids).sort((a, b) => a - b);
  assert.deepEqual(allPaired, [1, 2, 3, 4, 5, 6], "all 6 items are paired");
}

// --- Test 14: dirty tracking excludes unrelated anchors ---
//
// After A (1) and B (2) pair in round 1, C (3) and D (4) — which are far from A and B —
// must NOT appear in nextDirty. Their candidate sets are unchanged; re-judging them
// would be wasteful and produce the same "none" as round 1.

function testDirtyTrackingExcludesUnrelatedAnchor() {
  // A=0°, B=2° (close); C=90°, D=92° (far from A/B)
  const vA = vecAt(0);
  const vB = vecAt((2 * Math.PI) / 180);
  const vC = vecAt((90 * Math.PI) / 180);
  const vD = vecAt((92 * Math.PI) / 180);

  const floor = 0.55;
  assert.ok(cosineSim(vA, vB) >= floor, "A-B above floor");
  assert.ok(cosineSim(vA, vC) < floor, "A-C below floor");
  assert.ok(cosineSim(vA, vD) < floor, "A-D below floor");
  assert.ok(cosineSim(vB, vC) < floor, "B-C below floor");
  assert.ok(cosineSim(vB, vD) < floor, "B-D below floor");

  const titleVecs = new Map<number, number[]>([
    [1, vA],
    [2, vB],
    [3, vC],
    [4, vD],
  ]);

  // Round 1 result: A (1) and B (2) paired → changedMemberIds = {1, 2}.
  // C (3) and D (4) remain as singletons.
  const changedMemberIds = new Set([1, 2]);
  const remainingSingletonIds = new Set([3, 4]);

  const nextDirty = computeNextDirty(remainingSingletonIds, changedMemberIds, titleVecs, floor);

  assert.equal(nextDirty.size, 0, "C and D are not near changed members; nextDirty should be empty");
  assert.ok(!nextDirty.has(3), "C should not be dirty");
  assert.ok(!nextDirty.has(4), "D should not be dirty");
}

// --- Test 15: dirty tracking includes cascade anchor ---
//
// After A (10) and B (11) pair in round 1, C (12) — which IS near A and B —
// must appear in nextDirty so it can attach to the new cluster in round 2.

function testDirtyTrackingIncludesCascadeAnchor() {
  const vA = vecAt(0);
  const vB = vecAt((5 * Math.PI) / 180);
  const vC = vecAt((7 * Math.PI) / 180);

  const floor = 0.55;
  assert.ok(cosineSim(vA, vC) >= floor, "A-C above floor");
  assert.ok(cosineSim(vB, vC) >= floor, "B-C above floor");

  const titleVecs = new Map<number, number[]>([
    [10, vA],
    [11, vB],
    [12, vC],
  ]);

  const changedMemberIds = new Set([10, 11]); // A and B paired in round 1
  const remainingSingletonIds = new Set([12]); // C remains

  const nextDirty = computeNextDirty(remainingSingletonIds, changedMemberIds, titleVecs, floor);

  assert.ok(nextDirty.has(12), "C should be dirty — it's near the newly formed {A, B} cluster");
  assert.equal(nextDirty.size, 1, "only C should be dirty");
}

// --- Test 16: applyAttachRound returns correct changedMemberIds ---
//
// A (1) pairs with B (2). changedMemberIds must contain both 1 and 2.

function testApplyAttachRoundReturnsChangedMemberIds() {
  const itemA = makeItem(1, "Item A");
  const itemB = makeItem(2, "Item B");
  const itemById = new Map([
    [1, itemA],
    [2, itemB],
  ]);

  const currentClusters: Cluster[] = [];
  const remainingSingletonIds = new Set([1, 2]);

  const proposals: AttachProposal[] = [
    { anchorId: 1, anchorBestSim: 0.9, confirmedClusters: [], confirmedSingletonIds: [2] },
  ];

  const { newPairsFormed, changedMemberIds } = applyAttachRound(
    proposals,
    currentClusters,
    remainingSingletonIds,
    itemById,
  );

  assert.equal(newPairsFormed, 1, "one pair formed");
  assert.ok(changedMemberIds.has(1), "A in changedMemberIds");
  assert.ok(changedMemberIds.has(2), "B in changedMemberIds");
  assert.equal(changedMemberIds.size, 2, "exactly two changed members");
}

// --- Test 17: rejected proposal anchor absent from changedMemberIds ---
//
// A (bestSim=0.9) and B (bestSim=0.7) both propose C. A wins; B's proposal is
// rejected by contention. Only A and C should be in changedMemberIds — not B.

function testApplyAttachRoundChangedMemberIdsExcludesRejected() {
  const itemA = makeItem(1, "Item A");
  const itemB = makeItem(2, "Item B");
  const itemC = makeItem(3, "Item C");
  const itemById = new Map([
    [1, itemA],
    [2, itemB],
    [3, itemC],
  ]);

  const currentClusters: Cluster[] = [];
  const remainingSingletonIds = new Set([1, 2, 3]);

  const proposals: AttachProposal[] = [
    { anchorId: 1, anchorBestSim: 0.9, confirmedClusters: [], confirmedSingletonIds: [3] },
    { anchorId: 2, anchorBestSim: 0.7, confirmedClusters: [], confirmedSingletonIds: [3] },
  ];

  const { changedMemberIds } = applyAttachRound(
    proposals,
    currentClusters,
    remainingSingletonIds,
    itemById,
  );

  assert.ok(changedMemberIds.has(1), "A (winner) in changedMemberIds");
  assert.ok(changedMemberIds.has(3), "C (contested, won by A) in changedMemberIds");
  assert.ok(!changedMemberIds.has(2), "B (loser) must NOT be in changedMemberIds");
  assert.equal(changedMemberIds.size, 2, "exactly two changed members");
}

// --- Run all tests ---

testSingletonAboveFloorIsCandidate();
testAnchorExcludedFromCandidates();
testClusterCandidateAboveFloor();
testBelowFloorExcluded();
testAllAboveFloorReturnedNoTruncation();
testCandidatesAreSortedBySim();
testSingletonPairingAndCascadeAttach();
testAnchorWithNoVectorSkipped();
testClusterWithNoVectorsExcluded();
testContentionResolvesToHigherSimAnchor();
testCascadeAcrossRounds();
testEmptyProposalYieldsNoMerge();
testNoContentionEquivalence();
testDirtyTrackingExcludesUnrelatedAnchor();
testDirtyTrackingIncludesCascadeAnchor();
testApplyAttachRoundReturnsChangedMemberIds();
testApplyAttachRoundChangedMemberIdsExcludesRejected();

console.log("grouping attach tests passed");
