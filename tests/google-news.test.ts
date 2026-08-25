import assert from "node:assert/strict";
import {
  isGoogleNewsLink,
  googleNewsToken,
  decodeGoogleNewsToken,
  looksLikeArticleUrl,
} from "../src/pipeline/collector/google-news.js";

// AP Top News is the single largest contributor of material to the paper — 250
// items reached editor runs over the 14 days to 2026-08-25, ahead of OPB and
// SCMP — and its usable rate is 0%, because every link is an interstitial.
// canonicalizeUrl documents the token as "an opaque identifier with no URL in
// it"; these tests are the part of that claim that can be settled offline.

// A legacy-encoding token: base64url of protobuf framing around the target URL.
// The `CBMi` prefix is 0x08 0x13 0x22, which is what real Google News links
// carry.
const LEGACY_AP =
  "CBMiOGh0dHBzOi8vYXBuZXdzLmNvbS9hcnRpY2xlL2hhaXRpLWRlcG9ydGF0aW9ucy10cHMtOGYyYTFjMgtDQUFpQzBOQ1RXaw";
const LEGACY_WW =
  "CBMiRmh0dHBzOi8vd3d3Lnd3ZWVrLmNvbS9uZXdzLzIwMjYvMDgvMjUvY291bnR5LXVuaW9uLWJhY2tzLWJyaW0tZWR3YXJkcy8yC0NBQWlDME5DVFdr";
// A newer-encoding token: same framing, no URL inside it.
const OPAQUE = "CBMiLPzsmdWp_lg00o8P_XD8LZO-TeBRITb9QUxt1tRl05DNQbnizEsjvjs";

const rss = (t: string) => `https://news.google.com/rss/articles/${t}?oc=5`;

function testAggregatorLinksAreRecognised() {
  assert.equal(isGoogleNewsLink(rss(OPAQUE)), true);
  assert.equal(isGoogleNewsLink(`https://news.google.com/read/${OPAQUE}?hl=en-US`), true);
  // The publisher's own article is not an aggregator link.
  assert.equal(isGoogleNewsLink("https://apnews.com/article/haiti-deportations"), false);
  // Neither is Google News's front page.
  assert.equal(isGoogleNewsLink("https://news.google.com/topstories"), false);
}

function testTheTokenIsTakenFromEitherPathShape() {
  assert.equal(googleNewsToken(rss(LEGACY_AP)), LEGACY_AP);
  assert.equal(googleNewsToken(`https://news.google.com/read/${LEGACY_AP}`), LEGACY_AP);
  assert.equal(googleNewsToken("https://apnews.com/article/x"), null);
}

function testALegacyTokenGivesUpItsPublisherUrl() {
  // If the feeds still serve this encoding, AP needs no network strategy at all:
  // the resolution moves into the preprocessor beside the other redirector
  // unwrapping, and costs nothing.
  assert.equal(
    decodeGoogleNewsToken(rss(LEGACY_AP)),
    "https://apnews.com/article/haiti-deportations-tps-8f2a1c",
  );
  assert.equal(
    decodeGoogleNewsToken(rss(LEGACY_WW)),
    "https://www.wweek.com/news/2026/08/25/county-union-backs-brim-edwards/",
  );
}

function testAnOpaqueTokenReturnsNullRatherThanGuessing() {
  // Null is the signal to try a network strategy, not a failure. Returning a
  // wrong URL here would send the fetch to another publisher's article and
  // teach the host cooldown against a host that never refused us — the exact
  // damage unwrapRedirect's query-string exclusion exists to prevent.
  assert.equal(decodeGoogleNewsToken(rss(OPAQUE)), null);
}

function testATokenDecodingToAnotherAggregatorLinkIsRejected() {
  const selfReferential = Buffer.from(
    "\x08\x13\x22 https://news.google.com/rss/articles/CBMiXYZ",
    "latin1",
  ).toString("base64url");
  assert.equal(decodeGoogleNewsToken(rss(selfReferential)), null);
}

function testGarbageNeverThrows() {
  // A malformed link must degrade to null, never take the preprocessor down.
  for (const url of [
    "https://news.google.com/rss/articles/!!!not-base64!!!",
    "https://news.google.com/rss/articles/",
    "not a url at all",
    "",
  ]) {
    assert.doesNotThrow(() => decodeGoogleNewsToken(url));
    assert.equal(decodeGoogleNewsToken(url), null);
  }
}

function testTheUrlStopsAtProtobufFraming() {
  // The decoded buffer continues past the URL into the next field. A decoder
  // that ran to the end of the buffer would hand the fetch a URL with binary
  // glued to it.
  const decoded = decodeGoogleNewsToken(rss(LEGACY_AP))!;
  assert.ok(!decoded.includes("CAAi"), "trailing protobuf field leaked into the URL");
  assert.doesNotThrow(() => new URL(decoded));
}

function testGoogleAssetHostsAreNotArticles() {
  // The 2026-08-25 probe reported 52 of 52 links resolved and every one was the
  // same 676-byte PNG: each interstitial embeds the publisher's logo from
  // lh3.googleusercontent.com, and "first absolute URL that is not google.com"
  // takes the logo. A resolver that reports an unverified success is worse than
  // one that reports nothing — a wrong URL sends the fetch to another page and
  // teaches the host cooldown against a host that never refused us.
  assert.equal(
    looksLikeArticleUrl("https://lh3.googleusercontent.com/proxy/AbC123=w200-h200"),
    false,
  );
  for (const u of [
    "https://www.gstatic.com/images/branding/x.png",
    "https://fonts.googleapis.com/css2?family=Roboto",
    "https://www.youtube.com/watch?v=abc",
    "https://news.google.com/rss/articles/CBMiXYZ",
  ]) {
    assert.equal(looksLikeArticleUrl(u), false, u);
  }
}

function testAnAssetIsNeverAnArticleHoweverItIsHosted() {
  assert.equal(looksLikeArticleUrl("https://apnews.com/logo.png"), false);
  assert.equal(looksLikeArticleUrl("https://apnews.com/bundle/app.js"), false);
  assert.equal(looksLikeArticleUrl("https://apnews.com/news-sitemap-content.xml"), false);
}

function testAHomepageIsNotAnArticle() {
  assert.equal(looksLikeArticleUrl("https://apnews.com"), false);
  assert.equal(looksLikeArticleUrl("https://apnews.com/"), false);
}

function testARealArticleUrlPasses() {
  assert.equal(looksLikeArticleUrl("https://apnews.com/article/haiti-deportations-tps"), true);
  assert.equal(looksLikeArticleUrl("https://apnews.com/live/trump-economy-news-08-25-2026"), true);
  assert.equal(
    looksLikeArticleUrl("https://www.wweek.com/news/2026/08/25/county-union-backs/"),
    true,
  );
}

testAggregatorLinksAreRecognised();
testGoogleAssetHostsAreNotArticles();
testAnAssetIsNeverAnArticleHoweverItIsHosted();
testAHomepageIsNotAnArticle();
testARealArticleUrlPasses();
testTheTokenIsTakenFromEitherPathShape();
testALegacyTokenGivesUpItsPublisherUrl();
testAnOpaqueTokenReturnsNullRatherThanGuessing();
testATokenDecodingToAnotherAggregatorLinkIsRejected();
testGarbageNeverThrows();
testTheUrlStopsAtProtobufFraming();

console.log("google news link tests passed");
