import assert from "node:assert/strict";
import { combinedScore, assignTier } from "../src/pipeline/editor/index.js";

// --- combinedScore ---

function testSingletonGetsNoLift() {
  // ln(1) = 0, so combined === relevance regardless of W
  assert.equal(combinedScore(90, 1, 9), 90);
  assert.equal(combinedScore(55, 1, 100), 55);
}

function testCombinedScoreFormula() {
  // combined = score + W * ln(sources)
  const W = 9;
  assert.equal(combinedScore(80, 5, W), 80 + 9 * Math.log(5));
  assert.equal(combinedScore(70, 53, W), 70 + 9 * Math.log(53));
  assert.equal(combinedScore(50, 10, W), 50 + 9 * Math.log(10));
}

// --- assignTier (15/60/75 production config) ---

function testFeatureTierBoundary() {
  // ranks 0–14 are feature
  assert.equal(assignTier(0, 15, 60), "feature");
  assert.equal(assignTier(14, 15, 60), "feature");
}

function testStandardTierBoundary() {
  // ranks 15–74 are standard
  assert.equal(assignTier(15, 15, 60), "standard");
  assert.equal(assignTier(74, 15, 60), "standard");
}

function testBriefTierBoundary() {
  // rank 75 onward is brief
  assert.equal(assignTier(75, 15, 60), "brief");
  assert.equal(assignTier(149, 15, 60), "brief");
  assert.equal(assignTier(999, 15, 60), "brief");
}

function testShortfallFeatureAbsorbsAll() {
  // 10-item pile with featureCount=15: all 10 go to feature
  for (let i = 0; i < 10; i++) {
    assert.equal(assignTier(i, 15, 60), "feature", `rank ${i} should be feature`);
  }
}

function testShortfallStandardAbsorbsRemainder() {
  // 20-item pile: 15 feature, 5 standard, 0 brief
  for (let i = 0; i < 15; i++) assert.equal(assignTier(i, 15, 60), "feature");
  for (let i = 15; i < 20; i++) assert.equal(assignTier(i, 15, 60), "standard");
}

// --- sort order and tier cuts on a small fixed pile (W=9, tiers 2/2/rest) ---
//
// Item | score | sources | combined
//   A  |  80   |    5    | 80 + 9*ln(5)  ≈ 94.49
//   B  |  70   |   53    | 70 + 9*ln(53) ≈ 105.73
//   C  |  90   |    1    | 90 + 0        = 90.00
//   D  |  50   |   10    | 50 + 9*ln(10) ≈ 70.72
//   E  |  95   |    1    | 95 + 0        = 95.00
//
// Sort descending: B(105.73) > E(95.00) > A(94.49) > C(90.00) > D(70.72)
// With featureCount=2, standardCount=2:
//   rank 0 → B: feature
//   rank 1 → E: feature
//   rank 2 → A: standard
//   rank 3 → C: standard
//   rank 4 → D: brief

function testSortOrderAndTierCuts() {
  const W = 9;
  const items = [
    { ref: "A", score: 80, sourceCount: 5 },
    { ref: "B", score: 70, sourceCount: 53 },
    { ref: "C", score: 90, sourceCount: 1 },
    { ref: "D", score: 50, sourceCount: 10 },
    { ref: "E", score: 95, sourceCount: 1 },
  ];

  const scored = items
    .map((it) => ({ ...it, combined: combinedScore(it.score, it.sourceCount, W) }))
    .sort(
      (a, b) =>
        b.combined - a.combined ||
        b.score - a.score ||
        a.ref.localeCompare(b.ref),
    );

  // Verify sort order
  assert.deepEqual(
    scored.map((s) => s.ref),
    ["B", "E", "A", "C", "D"],
    "sort order mismatch",
  );

  // Verify combined scores
  const eps = 1e-9;
  assert.ok(Math.abs(scored[0]!.combined - (70 + 9 * Math.log(53))) < eps, "B combined");
  assert.ok(Math.abs(scored[1]!.combined - 95) < eps, "E combined");
  assert.ok(Math.abs(scored[2]!.combined - (80 + 9 * Math.log(5))) < eps, "A combined");
  assert.ok(Math.abs(scored[3]!.combined - 90) < eps, "C combined");
  assert.ok(Math.abs(scored[4]!.combined - (50 + 9 * Math.log(10))) < eps, "D combined");

  // Verify tiers with featureCount=2, standardCount=2
  const tiers = scored.map((_, i) => assignTier(i, 2, 2));
  assert.deepEqual(tiers, ["feature", "feature", "standard", "standard", "brief"]);
}

// --- tiebreak: equal combined falls back to higher relevance ---

function testTiebreakByRelevance() {
  const W = 9;
  // Both singletons (sourceCount=1, ln(1)=0): combined === score
  // Higher score wins the tiebreak
  const items = [
    { ref: "S1", score: 60, sourceCount: 1 },
    { ref: "S2", score: 75, sourceCount: 1 },
  ];
  const sorted = items
    .map((it) => ({ ...it, combined: combinedScore(it.score, it.sourceCount, W) }))
    .sort(
      (a, b) =>
        b.combined - a.combined ||
        b.score - a.score ||
        a.ref.localeCompare(b.ref),
    );
  assert.equal(sorted[0]!.ref, "S2");
  assert.equal(sorted[1]!.ref, "S1");
}

// --- tiebreak: equal combined AND equal score falls back to ref alphabetically ---

function testTiebreakByRef() {
  const W = 9;
  // Same score, same sourceCount → same combined; tiebreak is ref asc
  const items = [
    { ref: "S9", score: 70, sourceCount: 1 },
    { ref: "S2", score: 70, sourceCount: 1 },
  ];
  const sorted = items
    .map((it) => ({ ...it, combined: combinedScore(it.score, it.sourceCount, W) }))
    .sort(
      (a, b) =>
        b.combined - a.combined ||
        b.score - a.score ||
        a.ref.localeCompare(b.ref),
    );
  assert.equal(sorted[0]!.ref, "S2");
  assert.equal(sorted[1]!.ref, "S9");
}

testSingletonGetsNoLift();
testCombinedScoreFormula();
testFeatureTierBoundary();
testStandardTierBoundary();
testBriefTierBoundary();
testShortfallFeatureAbsorbsAll();
testShortfallStandardAbsorbsRemainder();
testSortOrderAndTierCuts();
testTiebreakByRelevance();
testTiebreakByRef();
console.log("editor formula tests passed");
