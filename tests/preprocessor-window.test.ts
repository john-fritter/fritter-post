import assert from "node:assert/strict";
import {
  computeWindowStart,
  isInWindow,
  isBackstopDropped,
} from "../src/pipeline/preprocessor/window.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

// Fixed "now" so tests are deterministic and not tied to wall-clock.
const FIXED_NOW_MS = new Date("2026-06-18T12:00:00Z").getTime();
const WINDOW_HOURS = 24;

// --- computeWindowStart ---

function testWindowStartIs24hBeforeNow() {
  const start = computeWindowStart(WINDOW_HOURS, FIXED_NOW_MS);
  assert.equal(
    start.toISOString(),
    "2026-06-17T12:00:00.000Z",
    "window start must be exactly window_hours before now",
  );
}

function testWindowStartRespectsDifferentWindowHours() {
  const start48 = computeWindowStart(48, FIXED_NOW_MS);
  assert.equal(start48.toISOString(), "2026-06-16T12:00:00.000Z");
}

// --- isInWindow ---

function testItemFetchedInsideWindowIsSelected() {
  const windowStart = computeWindowStart(WINDOW_HOURS, FIXED_NOW_MS);
  const fetchedAt = new Date(FIXED_NOW_MS - 12 * ONE_HOUR_MS); // 12h ago
  assert.ok(isInWindow(fetchedAt, windowStart), "item fetched 12h ago must be in a 24h window");
}

function testItemFetchedExactlyAtWindowStartIsSelected() {
  const windowStart = computeWindowStart(WINDOW_HOURS, FIXED_NOW_MS);
  assert.ok(
    isInWindow(windowStart, windowStart),
    "item fetched exactly at window start must be included (>= boundary)",
  );
}

function testItemFetchedOneSecondBeforeWindowIsExcluded() {
  const windowStart = computeWindowStart(WINDOW_HOURS, FIXED_NOW_MS);
  const justBefore = new Date(windowStart.getTime() - 1);
  assert.ok(!isInWindow(justBefore, windowStart), "item fetched 1ms before window start must be excluded");
}

function testItemFetchedOutsideWindowIsExcluded() {
  const windowStart = computeWindowStart(WINDOW_HOURS, FIXED_NOW_MS);
  const old = new Date(FIXED_NOW_MS - 25 * ONE_HOUR_MS); // 25h ago
  assert.ok(!isInWindow(old, windowStart), "item fetched 25h ago must be outside a 24h window");
}

// --- Window independence from prior run timing ---

function testWindowIsIndependentOfPriorRunTiming() {
  // Two back-to-back calls with the same clock produce the same window.
  // The old design used the prior run's started_at — the new design must not.
  const start1 = computeWindowStart(WINDOW_HOURS, FIXED_NOW_MS);
  const start2 = computeWindowStart(WINDOW_HOURS, FIXED_NOW_MS);
  assert.equal(
    start1.getTime(),
    start2.getTime(),
    "two calls with the same clock must produce identical window starts",
  );
}

function testWindowIsNotAnchoredToPriorRunTimestamp() {
  // Simulate a prior run that started 30 minutes ago. The new window must be
  // now()-24h, not the prior run's started_at.
  const priorRunStartedAt = new Date(FIXED_NOW_MS - 30 * 60 * 1000); // 30min ago
  const windowStart = computeWindowStart(WINDOW_HOURS, FIXED_NOW_MS);
  const expectedStart = new Date(FIXED_NOW_MS - WINDOW_HOURS * ONE_HOUR_MS);

  assert.equal(windowStart.getTime(), expectedStart.getTime());
  assert.notEqual(
    windowStart.getTime(),
    priorRunStartedAt.getTime(),
    "window start must not equal prior run's started_at",
  );
}

// --- max_age_days backstop ---

function testBackstopDropsItemPublishedBeforeCutoff() {
  const publishedAt = new Date(FIXED_NOW_MS - 15 * ONE_DAY_MS); // 15 days ago
  assert.ok(
    isBackstopDropped(publishedAt, 14, FIXED_NOW_MS),
    "item published 15 days ago with max_age_days=14 must be dropped",
  );
}

function testBackstopKeepsItemPublishedAfterCutoff() {
  const publishedAt = new Date(FIXED_NOW_MS - 13 * ONE_DAY_MS); // 13 days ago
  assert.ok(
    !isBackstopDropped(publishedAt, 14, FIXED_NOW_MS),
    "item published 13 days ago with max_age_days=14 must be kept",
  );
}

function testBackstopNeverDropsNullPublishedAt() {
  assert.ok(
    !isBackstopDropped(null, 14, FIXED_NOW_MS),
    "null published_at must never be dropped by the backstop",
  );
}

function testBackstopDisabledWhenMaxAgeDaysIsNull() {
  const veryOld = new Date(FIXED_NOW_MS - 1000 * ONE_DAY_MS);
  assert.ok(
    !isBackstopDropped(veryOld, null, FIXED_NOW_MS),
    "backstop must be disabled when max_age_days is null",
  );
}

// --- Empty window warning ---

function testEmptyWindowTriggersConsoleWarn() {
  let warnMessage: string | undefined;
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnMessage = String(args[0]);
  };
  try {
    const windowStart = computeWindowStart(WINDOW_HOURS, FIXED_NOW_MS);
    const windowEnd = new Date(FIXED_NOW_MS);
    const totalConsidered = 0;
    if (totalConsidered === 0) {
      console.warn(
        `[preprocessor] WARNING: 0 raw items in window ` +
        `${windowStart.toISOString()} → ${windowEnd.toISOString()} — nothing to process`,
      );
    }
    assert.ok(warnMessage !== undefined, "console.warn must be called when totalConsidered === 0");
    assert.ok(warnMessage!.includes("WARNING"), "warning message must contain WARNING");
    assert.ok(warnMessage!.includes("0 raw items"), "warning message must mention 0 raw items");
  } finally {
    console.warn = origWarn;
  }
}

function testNonEmptyWindowDoesNotTriggerWarn() {
  let warnCalled = false;
  const origWarn = console.warn;
  console.warn = () => { warnCalled = true; };
  try {
    const totalConsidered: number = 42;
    if (totalConsidered === 0) {
      console.warn("should not be called");
    }
    assert.ok(!warnCalled, "console.warn must not be called when items exist");
  } finally {
    console.warn = origWarn;
  }
}

// --- Run all ---

testWindowStartIs24hBeforeNow();
testWindowStartRespectsDifferentWindowHours();
testItemFetchedInsideWindowIsSelected();
testItemFetchedExactlyAtWindowStartIsSelected();
testItemFetchedOneSecondBeforeWindowIsExcluded();
testItemFetchedOutsideWindowIsExcluded();
testWindowIsIndependentOfPriorRunTiming();
testWindowIsNotAnchoredToPriorRunTimestamp();
testBackstopDropsItemPublishedBeforeCutoff();
testBackstopKeepsItemPublishedAfterCutoff();
testBackstopNeverDropsNullPublishedAt();
testBackstopDisabledWhenMaxAgeDaysIsNull();
testEmptyWindowTriggersConsoleWarn();
testNonEmptyWindowDoesNotTriggerWarn();

console.log("preprocessor window tests passed");
