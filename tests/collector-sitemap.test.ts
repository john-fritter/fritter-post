import assert from "node:assert/strict";
import {
  parseNewsSitemap,
  withinWindow,
  withoutExcludedPaths,
} from "../src/pipeline/collector/sitemap.js";

// AP is the paper's largest contributor of material and was 0% usable: it serves
// no RSS, and the Google News proxy standing in for it yields interstitials —
// 52 real links, three strategies, zero publisher URLs recovered. Its own
// robots.txt declares news-sitemap-content.xml, which is a feed in all but name:
// 529 entries, 518 of them /article/, and 15 of 15 sampled pages cleared 800
// characters through extractArticle + stripBoilerplate.

const AP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
  <url>
    <loc>https://apnews.com/article/canada-trump-lake-810649a0a4143d</loc>
    <news:news>
      <news:publication><news:name>AP News</news:name><news:language>en</news:language></news:publication>
      <news:publication_date>2026-08-25T20:45:33-04:00</news:publication_date>
      <news:title>Canada strikes back at US with retaliatory tariffs</news:title>
    </news:news>
  </url>
  <url>
    <loc>https://apnews.com/live/dolly-parton-8-25-2026</loc>
    <news:news>
      <news:publication_date>2026-08-25T14:15:49-04:00</news:publication_date>
      <news:title>Musical icon Dolly Parton dies at 80 &amp; the tributes begin</news:title>
    </news:news>
  </url>
  <url>
    <loc>https://apnews.com/article/older-story-8f2a1c</loc>
    <news:news>
      <news:publication_date>2026-08-23T20:52:05-04:00</news:publication_date>
      <news:title>An entry from the far end of the window</news:title>
    </news:news>
  </url>
</urlset>`;

const NOW = new Date("2026-08-26T00:56:56Z");

function testEveryEntryBecomesAnItem() {
  const entries = parseNewsSitemap(AP);
  assert.equal(entries.length, 3);
  assert.equal(entries[0]!.url, "https://apnews.com/article/canada-trump-lake-810649a0a4143d");
  assert.equal(entries[0]!.title, "Canada strikes back at US with retaliatory tariffs");
  assert.equal(entries[0]!.publishedAt?.toISOString(), "2026-08-26T00:45:33.000Z");
}

function testEntitiesAreDecoded() {
  // A headline is the entire item here — there is no body to fall back on — so
  // a raw &amp; would reach the reader.
  const entries = parseNewsSitemap(AP);
  assert.ok(entries.some((e) => e.title.includes("dies at 80 & the tributes begin")));
  assert.ok(!entries.some((e) => e.title.includes("&amp;")));
}

function testNewestFirst() {
  const dates = parseNewsSitemap(AP).map((e) => e.publishedAt!.getTime());
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
}

function testTheWindowDropsTheTail() {
  // AP's sitemap spans ~28 hours against a daily collector. Without a window the
  // tail is re-collected every day for the cross-run dedup to discard again.
  const kept = withinWindow(parseNewsSitemap(AP), 24, NOW);
  assert.equal(kept.length, 2);
  assert.ok(!kept.some((e) => e.url.includes("older-story")));
}

function testAZeroWindowKeepsEverything() {
  assert.equal(withinWindow(parseNewsSitemap(AP), 0, NOW).length, 3);
}

function testAnUndatedEntryIsKept() {
  // A missing timestamp is not evidence of age. Dropping it would silently lose
  // whatever the publisher forgot to stamp.
  const xml = `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
    <url><loc>https://apnews.com/article/undated</loc>
      <news:news><news:title>No date on this one</news:title></news:news></url>
  </urlset>`;
  const entries = parseNewsSitemap(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.publishedAt, null);
  assert.equal(withinWindow(entries, 24, NOW).length, 1);
}

function testEntriesWithNothingToWorkFromAreDropped() {
  // No URL: nothing downstream can identify or link to it. No title: a sitemap
  // carries no body, so the title is the whole item and the prefilter would be
  // handed nothing at all to judge.
  const xml = `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
    <url><news:news><news:title>No loc</news:title></news:news></url>
    <url><loc>https://apnews.com/article/no-title</loc></url>
    <url><loc>not-a-url</loc><news:news><news:title>Bad loc</news:title></news:news></url>
    <url><loc>https://apnews.com/article/good</loc>
      <news:news><news:title>Keeps its place</news:title></news:news></url>
  </urlset>`;
  const entries = parseNewsSitemap(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.title, "Keeps its place");
}

function testABareTitleElementIsAccepted() {
  // Not every publisher emits the news: namespace.
  const xml = `<urlset><url>
    <loc>https://example.com/article/x</loc>
    <title>Plain title element</title>
    <lastmod>2026-08-25T20:45:33-04:00</lastmod>
  </url></urlset>`;
  const entries = parseNewsSitemap(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.title, "Plain title element");
  assert.ok(entries[0]!.publishedAt !== null);
}

function testMalformedXmlCostsTheSourceNotTheRun() {
  // One sax error took Labor Notes down in two consecutive collections. A
  // publisher's broken sitemap must never throw out of the collector.
  for (const bad of ["", "not xml at all", "<urlset><url><loc>unclosed", "<<<>>>"]) {
    assert.doesNotThrow(() => parseNewsSitemap(bad), bad);
  }
}

function testAnUnparseableDateDoesNotBecomeAnInvalidDate() {
  const xml = `<urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
    <url><loc>https://apnews.com/article/x</loc>
      <news:news><news:publication_date>not a date</news:publication_date>
      <news:title>Still an item</news:title></news:news></url>
  </urlset>`;
  const entries = parseNewsSitemap(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.publishedAt, null);
}

testEveryEntryBecomesAnItem();
testEntitiesAreDecoded();
testNewestFirst();
testTheWindowDropsTheTail();
testAZeroWindowKeepsEverything();
testAnUndatedEntryIsKept();
testEntriesWithNothingToWorkFromAreDropped();
testABareTitleElementIsAccepted();
function testADisallowedPathIsDropped() {
  // AP's robots.txt permits /article/ and /live/ and sets no Crawl-delay, with
  // exactly one specific article excluded. The case for collecting AP at all
  // rests on reading that file, so the one restriction in it is honoured in
  // code — a rule you read but do not follow is worse than one you never read.
  const entries = parseNewsSitemap(AP);
  const kept = withoutExcludedPaths(entries, [
    "/article/canada-trump-lake-810649a0a4143d",
  ]);
  assert.equal(kept.length, entries.length - 1);
  assert.ok(!kept.some((e) => e.url.includes("canada-trump-lake")));
}

function testExclusionIsExactNotAPrefix() {
  // A prefix rule would quietly grow to cover articles the publisher never
  // excluded, and the value of the list is that it diffs against robots.txt.
  const kept = withoutExcludedPaths(parseNewsSitemap(AP), ["/article"]);
  assert.equal(kept.length, 3);
}

function testNoExclusionListIsANoOp() {
  assert.equal(withoutExcludedPaths(parseNewsSitemap(AP), undefined).length, 3);
  assert.equal(withoutExcludedPaths(parseNewsSitemap(AP), []).length, 3);
}

testMalformedXmlCostsTheSourceNotTheRun();
testADisallowedPathIsDropped();
testExclusionIsExactNotAPrefix();
testNoExclusionListIsANoOp();
testAnUnparseableDateDoesNotBecomeAnInvalidDate();

console.log("collector sitemap tests passed");
