import assert from "node:assert/strict";
import {
  planFetch,
  groupTargetsByHost,
  hostsInCooldown,
  classifyResponse,
  type FetchStatus,
} from "../src/pipeline/writers/fetch-text.js";
import { extractArticle } from "../src/pipeline/writers/extract.js";
import { hostOf } from "../src/lib/http.js";
import type { StoryMaterials, StoryArticle } from "../src/pipeline/writers/materials.js";
import type { WritersFetchConfig } from "../src/config/models.js";

// The policy these tests pin down comes from the audit of editor run #112:
// 61% of the paper's articles were under 800 chars of feed body, thinness was
// concentrated by outlet, and two hosts (nytimes.com, oregonlive.com) refused
// every request including the browser-agent retry.

const CFG: WritersFetchConfig = {
  enabled: true,
  tiers: ["feature", "standard"],
  feed_chars_floor: 800,
  min_extracted_chars: 1200,
  concurrency: 6,
  per_host_delay_ms: 1500,
  timeout_ms: 20000,
  max_bytes: 5000000,
  retention_days: 14,
  cooldown: { enabled: true, window_days: 7, min_attempts: 3 },
};

function article(
  id: number,
  feedChars: number,
  url = `https://example.com/${id}`,
): StoryArticle {
  return {
    preprocessedItemId: id,
    memberRef: `S${id}`,
    sourceName: "Source",
    parentSource: "Source",
    sourceType: "journalism",
    title: `Title ${id}`,
    originalTitle: `Title ${id}`,
    translationFailed: false,
    canonicalUrl: url,
    originalUrl: url,
    publishedAt: null,
    alsoAppearedIn: [],
    feedText: "x".repeat(feedChars),
    feedTextChars: feedChars,
  };
}

function storyOf(tier: string, articles: StoryArticle[], rank = 1): StoryMaterials {
  return {
    rank,
    tier: tier as StoryMaterials["tier"],
    ref: `C${rank}`,
    itemType: "cluster",
    threadId: null,
    title: "Story",
    summary: "",
    score: 70,
    sourceCount: articles.length,
    members: [],
    articles,
    unresolved: [],
  };
}

// --- what gets fetched ---

function testOnlyThinArticlesAreFetched() {
  // The whole point of the floor: OPB and Meduza give us 1500+ chars in the
  // feed, and re-fetching them is a request that buys nothing.
  const plan = planFetch(
    [storyOf("feature", [article(1, 120), article(2, 3596), article(3, 799)])],
    CFG,
    new Set(),
  );
  assert.deepEqual(
    plan.targets.flatMap((t) => t.items.map((i) => i.preprocessedItemId)),
    [1, 3],
  );
  assert.equal(plan.skips.length, 1);
  assert.equal(plan.skips[0]!.preprocessedItemId, 2);
  assert.match(plan.skips[0]!.detail, /already 3596 chars/);
}

function testBriefTierIsOutOfScope() {
  const plan = planFetch(
    [
      storyOf("feature", [article(1, 100)], 1),
      storyOf("standard", [article(2, 100)], 2),
      storyOf("brief", [article(3, 100)], 3),
    ],
    CFG,
    new Set(),
  );
  const fetched = plan.targets.flatMap((t) => t.items.map((i) => i.preprocessedItemId));
  assert.deepEqual(fetched, [1, 2]);
  // A brief is not skipped-with-a-row either; it was never in scope.
  assert.equal(plan.skips.length, 0);
}

function testCoolingHostsAreSkippedNotRequested() {
  const plan = planFetch(
    [
      storyOf("feature", [
        article(1, 100, "https://www.nytimes.com/2026/08/13/us/politics/a.html"),
        article(2, 100, "https://theguardian.com/world/b"),
      ]),
    ],
    CFG,
    new Set(["nytimes.com"]),
  );
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0]!.host, "theguardian.com");
  assert.equal(plan.skips.length, 1);
  assert.match(plan.skips[0]!.detail, /cooldown/);
}

function testOneRequestPerUrlEvenWhenItemsShareIt() {
  const plan = planFetch(
    [
      storyOf("feature", [
        article(1, 100, "https://ap.example/story"),
        article(2, 150, "https://ap.example/story"),
      ]),
    ],
    CFG,
    new Set(),
  );
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0]!.items.length, 2);
}

function testAnItemInTwoStoriesIsPlannedOnce() {
  const shared = article(1, 100);
  const plan = planFetch(
    [storyOf("feature", [shared], 1), storyOf("standard", [shared], 2)],
    CFG,
    new Set(),
  );
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0]!.items.length, 1);
}

function testHostGroupingIsBusiestFirst() {
  const plan = planFetch(
    [
      storyOf("feature", [
        article(1, 10, "https://theguardian.com/a"),
        article(2, 10, "https://theguardian.com/b"),
        article(3, 10, "https://www.theguardian.com/c"),
        article(4, 10, "https://bbc.co.uk/d"),
      ]),
    ],
    CFG,
    new Set(),
  );
  const groups = groupTargetsByHost(plan.targets);
  assert.equal(groups[0]![0], "theguardian.com");
  assert.equal(groups[0]![1].length, 3);
  assert.equal(groups[1]![0], "bbc.co.uk");
}

// --- the learned cooldown ---

function rows(...pairs: Array<[string, FetchStatus]>) {
  return pairs.map(([host, status]) => ({ host, status }));
}

function testHostWithRepeatedFailuresAndNoSuccessCools() {
  const cooling = hostsInCooldown(
    rows(
      ["nytimes.com", "blocked"],
      ["nytimes.com", "blocked"],
      ["nytimes.com", "blocked"],
      ["theguardian.com", "ok"],
    ),
    3,
  );
  assert.ok(cooling.has("nytimes.com"));
  assert.ok(!cooling.has("theguardian.com"));
}

function testOneSuccessKeepsAHostOutOfCooldown() {
  // A paywalled outlet that sometimes serves a free article must keep being
  // tried — the cooldown is for hosts that refuse everything, not hard ones.
  const cooling = hostsInCooldown(
    rows(
      ["scmp.com", "thin"],
      ["scmp.com", "thin"],
      ["scmp.com", "thin"],
      ["scmp.com", "ok"],
    ),
    3,
  );
  assert.equal(cooling.size, 0);
}

function testTooFewAttemptsDoesNotCool() {
  const cooling = hostsInCooldown(rows(["latimes.com", "error"], ["latimes.com", "error"]), 3);
  assert.equal(cooling.size, 0);
}

function testSkippedRowsAreNotEvidence() {
  // A skip means "not attempted". Counting skips as failures would cool every
  // host whose articles happen to arrive with full feed bodies.
  const cooling = hostsInCooldown(
    rows(["meduza.io", "skipped"], ["meduza.io", "skipped"], ["meduza.io", "skipped"]),
    3,
  );
  assert.equal(cooling.size, 0);
}

// --- response classification ---

function testRefusalsAreBlockedAndGoneIsError() {
  assert.equal(classifyResponse(403, "text/html", 0, 1200).status, "blocked");
  assert.equal(classifyResponse(429, "text/html", 0, 1200).status, "blocked");
  assert.equal(classifyResponse(404, "text/html", 0, 1200).status, "error");
  assert.equal(classifyResponse(503, "text/html", 0, 1200).status, "error");
}

function testShortExtractionIsThinNotOk() {
  assert.equal(classifyResponse(200, "text/html", 400, 1200).status, "thin");
  assert.equal(classifyResponse(200, "text/html", 1200, 1200).status, "ok");
  assert.equal(classifyResponse(200, "text/html; charset=utf-8", 9000, 1200).status, "ok");
}

function testNonHtmlIsAnError() {
  const result = classifyResponse(200, "application/pdf", 5000, 1200);
  assert.equal(result.status, "error");
  assert.match(result.detail!, /content-type/);
}

// --- extraction ---

function testExtractionDropsChromeAndKeepsProse() {
  const body = "A man died in custody at Delaney Hall on Wednesday. ".repeat(30);
  const html = `<!doctype html><html><head><title>T</title></head><body>
    <nav><a href="/x">Home</a><a href="/y">Subscribe</a></nav>
    <div class="cookie-banner">We use cookies to improve your experience.</div>
    <article><h1>Third person dies at New Jersey detention center</h1><p>${body}</p></article>
    <footer>Copyright 2026 Example. Sign up for our newsletter.</footer></body></html>`;
  const extracted = extractArticle(html);
  assert.ok(extracted.chars > 1000);
  assert.ok(extracted.text.includes("Delaney Hall"));
  assert.ok(!/cookies|Copyright|Subscribe/.test(extracted.text));
}

function testExtractionOfAWallReturnsAlmostNothing() {
  // The device-check page NYT and OregonLive serve: 774 bytes, no article. It
  // must come back short enough for classifyResponse to call it thin.
  const html = `<!doctype html><html><head><title>nytimes.com</title></head>
    <body><div id="captcha"><p>Please enable JS and disable any ad blocker</p></div></body></html>`;
  const extracted = extractArticle(html);
  assert.ok(extracted.chars < 1200);
  assert.equal(classifyResponse(200, "text/html", extracted.chars, 1200).status, "thin");
}

function testExtractionNeverThrows() {
  assert.equal(extractArticle("").chars, 0);
  assert.equal(extractArticle("<html").chars, 0);
  assert.equal(extractArticle("not html at all").chars, 0);
}

function testHostOfStripsWww() {
  assert.equal(hostOf("https://www.oregonlive.com/a/b"), "oregonlive.com");
  assert.equal(hostOf("https://news.google.com/rss/articles/CBMi"), "news.google.com");
  assert.equal(hostOf("not a url"), "(unparseable)");
}

testOnlyThinArticlesAreFetched();
testBriefTierIsOutOfScope();
testCoolingHostsAreSkippedNotRequested();
testOneRequestPerUrlEvenWhenItemsShareIt();
testAnItemInTwoStoriesIsPlannedOnce();
testHostGroupingIsBusiestFirst();
testHostWithRepeatedFailuresAndNoSuccessCools();
testOneSuccessKeepsAHostOutOfCooldown();
testTooFewAttemptsDoesNotCool();
testSkippedRowsAreNotEvidence();
testRefusalsAreBlockedAndGoneIsError();
testShortExtractionIsThinNotOk();
testNonHtmlIsAnError();
testExtractionDropsChromeAndKeepsProse();
testExtractionOfAWallReturnsAlmostNothing();
testExtractionNeverThrows();
testHostOfStripsWww();
console.log("writer fetch tests passed");
