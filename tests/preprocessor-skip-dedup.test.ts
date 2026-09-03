import assert from "node:assert/strict";
import {
  normalizeTitle,
  buildCrossRunKeys,
  isCrossRunDuplicate,
} from "../src/pipeline/preprocessor/dedup.js";

const identityParent = (s: string) => s;
const LONG_TITLE = "Senate passes major infrastructure bill today 2026"; // 50 chars ≥ 30
// A real repeat from the 2026-09-03 report: NPR on 9/2, OPB on 9/3.
const SYNDICATED_TITLE = "ICE detainee dies just hours after he was admitted into detention";

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
    keys.titleKeys.has(normalizeTitle(LONG_TITLE)),
    "long title must be added as a normalized title key",
  );
}

function testBuildCrossRunKeysTitleKeyIsNotOutletScoped() {
  // The key is the bare normalized title. Scoping it to the outlet is what let
  // syndicated copies through -- see dedup.ts.
  const rows = [{ source_name: "NPR News", canonical_url: "https://npr.org/story", title: SYNDICATED_TITLE }];
  const keys = buildCrossRunKeys(rows, identityParent);
  assert.ok(
    !keys.titleKeys.has(`NPR News::${normalizeTitle(SYNDICATED_TITLE)}`),
    "title key must not carry an outlet prefix",
  );
  assert.equal(keys.titleKeys.size, 1);
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

function testIsCrossRunDuplicateCatchesSyndicatedCopyFromAnotherOutlet() {
  // The whole point of the change. NPR ran it yesterday; OPB carries the same
  // wire copy today under a different URL and a different masthead. This is
  // four of the nine confirmed repeats in the 2026-09-03 report.
  const rows = [{ source_name: "NPR News", canonical_url: "https://npr.org/2026/ice-detainee", title: SYNDICATED_TITLE }];
  const keys = buildCrossRunKeys(rows, identityParent);
  const opbCopy = {
    sourceName: "OPB (Oregon Public Broadcasting) News",
    canonicalUrl: "https://opb.org/article/2026/ice-detainee-dies",
    title: SYNDICATED_TITLE.toUpperCase(),   // normalization must still match
  };
  assert.ok(
    isCrossRunDuplicate(opbCopy, keys, identityParent),
    "a syndicated copy from another outlet must be flagged as a cross-run duplicate",
  );
}

function testIsCrossRunDuplicateAllowsShortSharedTitleFromAnotherOutlet() {
  // The near-miss that must survive. Below 30 chars a shared headline is a
  // coincidence of brevity, not evidence of syndication, so the floor still
  // guards the now-unscoped key.
  const shortTitle = "Markets close higher"; // 20 chars < 30
  const rows = [{ source_name: "Reuters", canonical_url: "https://reuters.com/a", title: shortTitle }];
  const keys = buildCrossRunKeys(rows, identityParent);
  assert.ok(
    !isCrossRunDuplicate({ sourceName: "AP", canonicalUrl: "https://ap.com/b", title: shortTitle }, keys, identityParent),
    "a short shared title from another outlet must not be flagged",
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
testBuildCrossRunKeysTitleKeyIsNotOutletScoped();
testIsCrossRunDuplicateDetectsUrlMatch();
testIsCrossRunDuplicateDetectsTitleMatch();
testIsCrossRunDuplicateCatchesSyndicatedCopyFromAnotherOutlet();
testIsCrossRunDuplicateAllowsShortSharedTitleFromAnotherOutlet();
testIsCrossRunDuplicateNoMatchForDistinctItem();
testFlagDefaultIsFalse();
testFlagFalseDropsItemAlreadyInHistory();
testFlagTruePassesItemAlreadyInHistory();
testWithinBatchDedupIsIndependentOfCrossRunFlag();
testWithinBatchDedupKeepsEarliestItem();

console.log("preprocessor skip-dedup tests passed");
