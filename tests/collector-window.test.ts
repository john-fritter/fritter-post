import assert from "node:assert/strict";
import { withinAgeWindow, withoutExcludedUrlPaths } from "../src/pipeline/collector/window.js";

const NOW = new Date("2026-08-29T12:00:00Z");
const item = (url: string, iso: string | null) => ({
  original_url: url,
  published_at: iso === null ? null : new Date(iso),
});

// A weekly's feed on the day the source is added: several issues at once.
const NUGGET = [
  item("https://n.example/a", "2026-08-29T06:00:00Z"), // today
  item("https://n.example/b", "2026-08-25T06:00:00Z"), // this week's issue
  item("https://n.example/c", "2026-08-18T06:00:00Z"), // last week
  item("https://n.example/d", "2026-08-04T06:00:00Z"), // a month back
];

function testWindowAdmitsThisIssueAndRejectsTheBacklog() {
  // 192h = 8 days: this week's issue survives, older issues do not. That is the
  // shape of the problem — paper #3's top eleven held three items from one
  // newly-added weekly's backlog.
  const kept = withinAgeWindow(NUGGET, (i) => i.published_at, 192, NOW);
  assert.deepEqual(kept.map((k) => k.original_url), [
    "https://n.example/a",
    "https://n.example/b",
  ]);
}

function testZeroOrNegativeDisablesTheWindow() {
  assert.equal(withinAgeWindow(NUGGET, (i) => i.published_at, 0, NOW).length, 4);
  assert.equal(withinAgeWindow(NUGGET, (i) => i.published_at, -1, NOW).length, 4);
}

function testUndatedItemsSurvive() {
  // A feed with no pubDate cannot be judged on age. Dropping what we cannot
  // date would silently empty those feeds, which is worse than admitting stale.
  const mixed = [...NUGGET, item("https://n.example/undated", null)];
  const kept = withinAgeWindow(mixed, (i) => i.published_at, 24, NOW);
  assert.ok(kept.some((k) => k.original_url === "https://n.example/undated"));
  assert.equal(kept.length, 2); // today's item + the undated one
}

function testExcludedPathsDropWholePathsOnly() {
  const items = [
    item("https://ktvz.com/news/local-news/story", null),
    item("https://ktvz.com/cnn-spanish", null),
    item("https://ktvz.com/cnn-spanish/", null),   // trailing slash normalised
    item("https://ktvz.com/cnn-spanish-daily", null), // NOT the excluded path
  ];
  const kept = withoutExcludedUrlPaths(items, (i) => i.original_url, ["/cnn-spanish"]);
  assert.deepEqual(kept.map((k) => k.original_url), [
    "https://ktvz.com/news/local-news/story",
    "https://ktvz.com/cnn-spanish-daily",
  ]);
}

function testNoExclusionsIsAPassThrough() {
  assert.equal(withoutExcludedUrlPaths(NUGGET, (i) => i.original_url, undefined).length, 4);
  assert.equal(withoutExcludedUrlPaths(NUGGET, (i) => i.original_url, []).length, 4);
}

function testUnparseableUrlIsKept() {
  // This filter honours a publisher's disallow list; it is not a URL validator.
  const items = [item("not a url", null)];
  assert.equal(withoutExcludedUrlPaths(items, (i) => i.original_url, ["/x"]).length, 1);
}

testWindowAdmitsThisIssueAndRejectsTheBacklog();
testZeroOrNegativeDisablesTheWindow();
testUndatedItemsSurvive();
testExcludedPathsDropWholePathsOnly();
testNoExclusionsIsAPassThrough();
testUnparseableUrlIsKept();
console.log("collector window tests passed");
