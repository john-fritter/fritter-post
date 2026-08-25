import assert from "node:assert/strict";
import {
  planFetch,
  groupTargetsByHost,
  hostsInCooldown,
  classifyResponse,
  isTransportError,
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
  refetch_after_hours: 20,
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
    // A finished sentence: `endsMidSentence` reads the last character, and a
    // body of bare filler would look truncated to it — which is the whole point
    // of the rule, but not what these fixtures are testing.
    feedText: feedChars > 0 ? `${"x".repeat(Math.max(0, feedChars - 1))}.` : "",
    feedTextChars: feedChars,
  };
}

function storyOf(tier: string, articles: StoryArticle[], rank = 1): StoryMaterials {
  return {
    storyId: rank,
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

function testRecentlyAttemptedArticlesAreNotRequestedAgain() {
  // Run #112's full fetch re-requested the 20 URLs its own capped run had just
  // retrieved: the plan consulted the cooldown but never the cache.
  const plan = planFetch(
    [storyOf("feature", [article(1, 100), article(2, 100)])],
    CFG,
    new Set(),
    new Set([1]),
  );
  assert.deepEqual(
    plan.targets.flatMap((t) => t.items.map((i) => i.preprocessedItemId)),
    [2],
  );
  assert.match(plan.skips[0]!.detail, /already attempted/);
}

function testCooldownSkipsPreserveTheAttemptThatCausedThem() {
  // The self-defeating case: if a cooldown skip overwrites the blocked rows that
  // produced the cooldown, the next run sees no failures, lifts the cooldown,
  // and re-requests every URL. Only cooldown skips carry the flag — a
  // fat-feed skip has no attempt to protect.
  const plan = planFetch(
    [
      storyOf("feature", [
        article(1, 100, "https://nytimes.com/a"),
        article(2, 4000, "https://opb.org/b"),
      ]),
    ],
    CFG,
    new Set(["nytimes.com"]),
  );
  const cooldownSkip = plan.skips.find((s) => s.host === "nytimes.com")!;
  const fatSkip = plan.skips.find((s) => s.host === "opb.org")!;
  assert.equal(cooldownSkip.preservesAttempt, true);
  assert.notEqual(fatSkip.preservesAttempt, true);
}

function testTransportFailuresRetryButTimeoutsDoNot() {
  // Same rule callWithBackoff applies to LLM calls: a dead socket says nothing
  // about the request, a timeout ran to its ceiling and would do it again.
  assert.equal(isTransportError(new Error("fetch failed")), true);
  assert.equal(isTransportError(new Error("socket hang up")), true);
  assert.equal(isTransportError(new Error("read ECONNRESET")), true);
  // npr.org, which failed both the manual probe and the run.
  assert.equal(
    isTransportError(new Error("HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR")),
    true,
  );
  const timeout = new Error("The operation was aborted due to timeout");
  timeout.name = "TimeoutError";
  assert.equal(isTransportError(timeout), false);
  assert.equal(isTransportError(new Error("Request timed out")), false);
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

/** Same article, but the publisher cut the body mid-clause. */
function truncatedArticle(id: number, feedChars: number): StoryArticle {
  const body = `${"x".repeat(Math.max(0, feedChars - 30))}. The minister said the plan would`;
  return { ...article(id, feedChars), feedText: body, feedTextChars: body.length };
}

function testALongBodyThatStopsMidSentenceIsStillFetched() {
  // **Long is not the same as complete.** La Nación's ~1,800-character teasers
  // clear the 800-char floor and stop mid-clause, so run #43's rank 15 was never
  // requested and its writer was handed a fragment. Length does not excuse a
  // body from the fetch when it plainly is not the whole article.
  const plan = planFetch(
    [storyOf("feature", [truncatedArticle(1, 2000)])],
    CFG,
    new Set(),
  );
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.skips.length, 0);
}

function testALongCompleteBodyIsStillSkipped() {
  // The near-miss: the rule must not turn the floor off for everyone. A body
  // that ends on a finished sentence is taken at its word, as before.
  const plan = planFetch([storyOf("feature", [article(1, 2000)])], CFG, new Set());
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.skips.length, 1);
  assert.match(plan.skips[0]!.detail, /already 2000 chars/);
}

function testAFeedFooterDoesNotTriggerAFetch() {
  // Ars Technica and the Guardian close their feed bodies with furniture, so a
  // complete article has no terminal punctuation at the end of the raw text.
  // The plan judges the stripped body; otherwise the source audit's 14-day
  // window would have produced 611 requests from outlets already 100% usable.
  const complete =
    "The commission voted on Tuesday to open the proceeding. " +
    "Regulators said the review would take up to a year. ".repeat(20) +
    "\n\nRead full article";
  const withFooter = {
    ...article(1, complete.length),
    feedText: complete,
    feedTextChars: complete.length,
  };
  const plan = planFetch([storyOf("feature", [withFooter])], CFG, new Set());
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.skips.length, 1);
}

function testATruncatedBodyOnACoolingHostIsStillSkipped() {
  // Being truncated earns a fetch attempt, not an exemption from the cooldown.
  const plan = planFetch(
    [storyOf("feature", [truncatedArticle(1, 2000)])],
    CFG,
    new Set(["example.com"]),
  );
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.skips.length, 1);
  assert.match(plan.skips[0]!.detail, /cooldown/);
}

testOnlyThinArticlesAreFetched();
testALongBodyThatStopsMidSentenceIsStillFetched();
testALongCompleteBodyIsStillSkipped();
testAFeedFooterDoesNotTriggerAFetch();
testATruncatedBodyOnACoolingHostIsStillSkipped();
testBriefTierIsOutOfScope();
testCoolingHostsAreSkippedNotRequested();
testOneRequestPerUrlEvenWhenItemsShareIt();
testAnItemInTwoStoriesIsPlannedOnce();
testRecentlyAttemptedArticlesAreNotRequestedAgain();
testCooldownSkipsPreserveTheAttemptThatCausedThem();
testTransportFailuresRetryButTimeoutsDoNot();
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
