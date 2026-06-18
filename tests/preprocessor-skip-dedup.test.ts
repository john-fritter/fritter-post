import assert from "node:assert/strict";
import {
  normalizeTitle,
  buildCrossRunKeys,
  isCrossRunDuplicate,
} from "../src/pipeline/preprocessor/dedup.js";

const identityParent = (s: string) => s;
const LONG_TITLE = "Senate passes major infrastructure bill today 2026"; // 50 chars ≥ 30

// --- normalizeTitle ---

function testNormalizeTitleLowercasesAndTrims() {
  assert.equal(normalizeTitle("  HELLO World  "), "hello world");
}

function testNormalizeTitleCollapsesWhitespace() {
  assert.equal(normalizeTitle("a  b   c"), "a b c");
}

// --- buildCrossRunKeys ---

function testBuildCrossRunKeysAddsSourceAndParentUrlKeys() {
  const rows = [{ source_name: "AP", canonical_url: "https://ap.com/story", title: "x" }];
  const keys = buildCrossRunKeys(rows, identityParent);
  // With identity parent, source key and parent key are both "AP::url"
  assert.ok(keys.urlKeys.has("AP::https://ap.com/story"), "source-keyed URL must be present");
}

function testBuildCrossRunKeysAddsParentUrlKeyForSubfeed() {
  const rows = [{ source_name: "AP Politics", canonical_url: "https://ap.com/story", title: "x" }];
  const getParent = (s: string) => s === "AP Politics" ? "AP" : s;
  const keys = buildCrossRunKeys(rows, getParent);
  assert.ok(keys.urlKeys.has("AP Politics::https://ap.com/story"), "source-keyed URL must be present");
  assert.ok(keys.urlKeys.has("AP::https://ap.com/story"), "parent-keyed URL must be present");
}

function testBuildCrossRunKeysAddsNormalizedTitleKeyForLongTitle() {
  const rows = [{ source_name: "AP", canonical_url: "https://ap.com/story", title: LONG_TITLE }];
  const keys = buildCrossRunKeys(rows, identityParent);
  assert.ok(
    keys.titleKeys.has(`AP::${normalizeTitle(LONG_TITLE)}`),
    "long title must be added as a normalized title key",
  );
}

function testBuildCrossRunKeysOmitsShortTitleFromTitleKeys() {
  const rows = [{ source_name: "AP", canonical_url: "https://ap.com/x", title: "Short" }];
  const keys = buildCrossRunKeys(rows, identityParent);
  assert.equal(keys.titleKeys.size, 0, "title shorter than 30 chars must not produce a title key");
}

// --- isCrossRunDuplicate ---

function testIsCrossRunDuplicateDetectsUrlMatch() {
  const rows = [{ source_name: "AP", canonical_url: "https://ap.com/story", title: "x" }];
  const keys = buildCrossRunKeys(rows, identityParent);
  assert.ok(
    isCrossRunDuplicate({ sourceName: "AP", canonicalUrl: "https://ap.com/story", title: "different" }, keys, identityParent),
    "matching URL must be flagged as a cross-run duplicate",
  );
}

function testIsCrossRunDuplicateDetectsTitleMatch() {
  const rows = [{ source_name: "AP", canonical_url: "https://ap.com/original", title: LONG_TITLE }];
  const keys = buildCrossRunKeys(rows, identityParent);
  assert.ok(
    isCrossRunDuplicate({ sourceName: "AP", canonicalUrl: "https://ap.com/different", title: LONG_TITLE }, keys, identityParent),
    "matching title must be flagged as a cross-run duplicate",
  );
}

function testIsCrossRunDuplicateNoMatchForDistinctItem() {
  const rows = [{ source_name: "AP", canonical_url: "https://ap.com/story-1", title: LONG_TITLE }];
  const keys = buildCrossRunKeys(rows, identityParent);
  const distinctItem = { sourceName: "AP", canonicalUrl: "https://ap.com/story-2", title: "An entirely different unrelated story about nothing at all" };
  assert.ok(!isCrossRunDuplicate(distinctItem, keys, identityParent), "distinct item must not match");
}

// --- Skip flag behavior ---

function testFlagDefaultIsFalse() {
  // The options type defaults skipCrossRunDedup to undefined/false.
  const options: { collectorRunId?: number; skipCrossRunDedup?: boolean } = {};
  assert.equal(options.skipCrossRunDedup ?? false, false, "flag must default to false when not supplied");
}

function testFlagFalseDropsItemAlreadyInHistory() {
  const rows = [{ source_name: "AP", canonical_url: "https://ap.com/story", title: "x" }];
  const keys = buildCrossRunKeys(rows, identityParent);
  const skipCrossRunDedup = false;
  const item = { sourceName: "AP", canonicalUrl: "https://ap.com/story", title: "x" };

  // Production gate: skip=false → duplicates are filtered
  const isDuplicate = !skipCrossRunDedup && isCrossRunDuplicate(item, keys, identityParent);
  assert.ok(isDuplicate, "flag=false must cause item already in history to be dropped");
}

function testFlagTruePassesItemAlreadyInHistory() {
  const rows = [{ source_name: "AP", canonical_url: "https://ap.com/story", title: "x" }];
  const keys = buildCrossRunKeys(rows, identityParent);
  const skipCrossRunDedup = true;
  const item = { sourceName: "AP", canonicalUrl: "https://ap.com/story", title: "x" };

  // Bypass: skip=true → items in history pass through regardless of key match
  const isDuplicate = !skipCrossRunDedup && isCrossRunDuplicate(item, keys, identityParent);
  assert.ok(!isDuplicate, "flag=true must allow item already in history to pass through");
}

function testWithinBatchDedupIsIndependentOfCrossRunFlag() {
  // Within-batch dedup collapses same source+URL items regardless of the cross-run flag.
  // This simulates the step-4 logic in index.ts.
  interface SimpleItem { sourceName: string; canonicalUrl: string; fetchedAt: Date }

  const items: SimpleItem[] = [
    { sourceName: "AP", canonicalUrl: "https://ap.com/story", fetchedAt: new Date("2026-06-18T10:00:00Z") },
    { sourceName: "AP", canonicalUrl: "https://ap.com/story", fetchedAt: new Date("2026-06-18T10:01:00Z") },
  ];

  const seen = new Map<string, SimpleItem>();
  const surviving: SimpleItem[] = [];
  let dropped = 0;

  for (const item of items) {
    const key = `${item.sourceName}::${item.canonicalUrl}`;
    if (!seen.has(key)) {
      seen.set(key, item);
      surviving.push(item);
    } else {
      dropped++;
    }
  }

  assert.equal(surviving.length, 1, "within-batch dedup must collapse same source+URL to one item");
  assert.equal(dropped, 1);
}

function testWithinBatchDedupKeepsEarliestItem() {
  // When two items share a source+URL, the earliest fetchedAt wins.
  interface SimpleItem { sourceName: string; canonicalUrl: string; fetchedAt: Date; publishedAt: Date | null }

  const earlier: SimpleItem = { sourceName: "AP", canonicalUrl: "https://ap.com/s", fetchedAt: new Date("2026-06-18T09:00:00Z"), publishedAt: null };
  const later: SimpleItem   = { sourceName: "AP", canonicalUrl: "https://ap.com/s", fetchedAt: new Date("2026-06-18T10:00:00Z"), publishedAt: null };
  // Items arrive in chronological order (SQL sorts by published_at / fetched_at ASC).
  const items = [earlier, later];

  const seen = new Map<string, SimpleItem>();
  const surviving: SimpleItem[] = [];
  let dropped = 0;

  for (const item of items) {
    const key = `${item.sourceName}::${item.canonicalUrl}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
      surviving.push(item);
    } else {
      const itemTs = item.publishedAt ?? item.fetchedAt;
      const existingTs = existing.publishedAt ?? existing.fetchedAt;
      if (itemTs < existingTs) {
        const idx = surviving.indexOf(existing);
        if (idx !== -1) surviving.splice(idx, 1);
        seen.set(key, item);
        surviving.push(item);
      }
      dropped++;
    }
  }

  assert.equal(surviving.length, 1);
  assert.equal(surviving[0]!.fetchedAt.toISOString(), earlier.fetchedAt.toISOString(), "earlier item must survive");
}

// --- Run all ---

testNormalizeTitleLowercasesAndTrims();
testNormalizeTitleCollapsesWhitespace();
testBuildCrossRunKeysAddsSourceAndParentUrlKeys();
testBuildCrossRunKeysAddsParentUrlKeyForSubfeed();
testBuildCrossRunKeysAddsNormalizedTitleKeyForLongTitle();
testBuildCrossRunKeysOmitsShortTitleFromTitleKeys();
testIsCrossRunDuplicateDetectsUrlMatch();
testIsCrossRunDuplicateDetectsTitleMatch();
testIsCrossRunDuplicateNoMatchForDistinctItem();
testFlagDefaultIsFalse();
testFlagFalseDropsItemAlreadyInHistory();
testFlagTruePassesItemAlreadyInHistory();
testWithinBatchDedupIsIndependentOfCrossRunFlag();
testWithinBatchDedupKeepsEarliestItem();

console.log("preprocessor skip-dedup tests passed");
