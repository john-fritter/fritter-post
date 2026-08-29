import assert from "node:assert/strict";
import { countDistinctOutlets } from "../src/db/outlets.js";

const OUTLETS = new Map<string, string>([
  ["AP Top News", "AP"],
  ["AP Politics", "AP"],
  ["Reuters Top News", "Reuters"],
  ["Reuters World News", "Reuters"],
  ["KTVZ NewsChannel 21", "KTVZ NewsChannel 21"],
  ["The Bend Bulletin", "The Bend Bulletin"],
]);

function testSiblingFeedsAreOneOutlet() {
  // AP Politics and AP Top News are declared with a shared parent precisely
  // because they are one newsroom. Before this, a story both carried counted 2.
  assert.equal(countDistinctOutlets(["AP Top News", "AP Politics"], OUTLETS), 1);
  assert.equal(
    countDistinctOutlets(["AP Top News", "AP Politics", "Reuters Top News"], OUTLETS),
    2,
  );
}

function testOneOutletTwiceIsOneOutlet() {
  // The run #47 defect: KTVZ carried the same CNN story in English and Spanish,
  // two rows from one feed, and the pair added a source to the editor's lift.
  assert.equal(countDistinctOutlets(["KTVZ NewsChannel 21", "KTVZ NewsChannel 21"], OUTLETS), 1);
}

function testGenuinePickupStillCounts() {
  assert.equal(
    countDistinctOutlets(
      ["AP Top News", "Reuters Top News", "The Bend Bulletin"],
      OUTLETS,
    ),
    3,
  );
}

function testUnknownSourceIsItsOwnOutlet() {
  // A source absent from the map is not silently merged with anything.
  assert.equal(countDistinctOutlets(["Not In Config", "Also Missing"], OUTLETS), 2);
  assert.equal(countDistinctOutlets(["Not In Config", "Not In Config"], OUTLETS), 1);
}

function testNeverReturnsZero() {
  // The result is fed to ln(). ln(0) is -Infinity, which does not throw — it
  // sorts the story to the bottom of the paper and looks like editorial
  // judgment. An empty input means the caller could not resolve its items.
  assert.equal(countDistinctOutlets([], OUTLETS), 1);
  assert.ok(Number.isFinite(Math.log(countDistinctOutlets([], OUTLETS))));
}

function testCompressionIsMildWhenTheCountIsHonest() {
  // 43 rows across 30 outlets: the lift moves ~3 points at W=9, not a cliff.
  const names = Array.from({ length: 43 }, (_, i) => `Outlet ${i % 30}`);
  const n = countDistinctOutlets(names, new Map());
  assert.equal(n, 30);
  assert.ok(Math.abs(9 * Math.log(43) - 9 * Math.log(n) - 3.2) < 0.2);
}

testSiblingFeedsAreOneOutlet();
testOneOutletTwiceIsOneOutlet();
testGenuinePickupStillCounts();
testUnknownSourceIsItsOwnOutlet();
testNeverReturnsZero();
testCompressionIsMildWhenTheCountIsHonest();
console.log("outlet count tests passed");
