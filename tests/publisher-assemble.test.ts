import assert from "node:assert/strict";
import {
  resolvePieceSources,
  buildIndex,
  displayHeadline,
  sourceLabel,
  paragraphs,
  formatEditionDate,
  readingMinutes,
  type PublishablePiece,
} from "../src/pipeline/publisher/assemble.js";
import type {
  StoryMaterials,
  StoryMember,
  StoryArticle,
} from "../src/pipeline/writers/materials.js";

// --- fixtures ---

function article(id: number, name: string, url: string): StoryArticle {
  return {
    preprocessedItemId: id,
    memberRef: "M",
    sourceName: name,
    parentSource: name,
    sourceType: "journalism",
    title: `Title ${id}`,
    originalTitle: `Title ${id}`,
    translationFailed: false,
    canonicalUrl: url,
    originalUrl: url,
    publishedAt: null,
    alsoAppearedIn: [],
    feedText: "",
    feedTextChars: 0,
  };
}

function member(ref: string, articles: StoryArticle[]): StoryMember {
  return {
    ref,
    itemType: "cluster",
    clusterIndex: 1,
    title: ref,
    summary: "",
    score: 70,
    sourceCount: articles.length,
    articles,
  };
}

function story(ref: string, members: StoryMember[], articles: StoryArticle[]): StoryMaterials {
  return {
    storyId: 1,
    rank: 1,
    tier: "feature",
    ref,
    itemType: members.length > 0 ? "thread" : "singleton",
    threadId: null,
    title: ref,
    summary: "",
    score: 70,
    sourceCount: articles.length,
    members,
    articles,
    unresolved: [],
  };
}

function piece(over: Partial<PublishablePiece> = {}): PublishablePiece {
  return {
    writerPieceId: 1,
    editorStoryId: 1,
    rank: 1,
    sectionRank: 0,
    tier: "standard",
    ref: "S1",
    sectionRef: null,
    sectionTitle: null,
    sectionRole: null,
    headline: "A headline",
    body: "Body.",
    wordCount: 150,
    sourceCount: 1,
    ...over,
  };
}

// --- resolvePieceSources ---

function testStandaloneTakesEveryArticle() {
  const a = [article(1, "AP", "https://a.example/1"), article(2, "Reuters", "https://b.example/2")];
  const m = new Map([["S1", story("S1", [], a)]]);
  const out = resolvePieceSources(piece({ ref: "S1" }), m);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.sourceName), ["AP", "Reuters"]);
  assert.deepEqual(out.map((s) => s.position), [0, 1]);
}

function testSectionPieceTakesOnlyItsMember() {
  // The piece carries the member's ref (C59); its story is the thread (T0).
  const mine = [article(1, "AP", "https://a.example/1")];
  const other = [article(2, "Reuters", "https://b.example/2")];
  const t = story("T0", [member("C59", mine), member("S99", other)], [...mine, ...other]);
  const out = resolvePieceSources(piece({ ref: "C59", sectionRef: "T0" }), new Map([["T0", t]]));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.sourceName, "AP");
}

function testUnknownStoryYieldsNoSourcesRatherThanThrowing() {
  assert.deepEqual(resolvePieceSources(piece({ ref: "S404" }), new Map()), []);
}

function testUnknownMemberYieldsNoSources() {
  const t = story("T0", [member("C59", [article(1, "AP", "https://a.example/1")])], []);
  const out = resolvePieceSources(piece({ ref: "C77", sectionRef: "T0" }), new Map([["T0", t]]));
  assert.deepEqual(out, []);
}

function testDuplicateUrlsCollapseToOneLink() {
  // A syndicated wire story picked up by two feeds is one link, not two.
  const a = [
    article(1, "AP", "https://a.example/1"),
    article(2, "AP Politics", "https://a.example/1"),
    article(3, "Reuters", "https://b.example/2"),
  ];
  const out = resolvePieceSources(piece({ ref: "S1" }), new Map([["S1", story("S1", [], a)]]));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.position), [0, 1]);
}

// --- buildIndex ---

function testThreadBecomesOneRowAndPiecesBecomeRows() {
  const rows = buildIndex([
    piece({ ref: "T0-lead", rank: 1, sectionRank: 0, sectionRef: "T0", sectionTitle: "A war" }),
    piece({ ref: "T0-side", rank: 1, sectionRank: 1, sectionRef: "T0", sectionTitle: "A war" }),
    piece({ ref: "S5", rank: 2 }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.kind, "thread");
  assert.equal(rows[1]!.kind, "piece");
  const thread = rows[0]!;
  assert.ok(thread.kind === "thread");
  assert.equal(thread.title, "A war");
  assert.equal(thread.members.length, 2);
}

function testMembersComeBackInSectionRankOrder() {
  const rows = buildIndex([
    piece({ ref: "c", rank: 1, sectionRank: 2, sectionRef: "T0", sectionTitle: "T" }),
    piece({ ref: "a", rank: 1, sectionRank: 0, sectionRef: "T0", sectionTitle: "T" }),
    piece({ ref: "b", rank: 1, sectionRank: 1, sectionRef: "T0", sectionTitle: "T" }),
  ]);
  const thread = rows[0]!;
  assert.ok(thread.kind === "thread");
  assert.deepEqual(thread.members.map((m) => m.ref), ["a", "b", "c"]);
}

function testNonAdjacentSectionMembersStillGroup() {
  // Members of one section share a rank, so this should not happen — but the
  // publisher must not split a section if it ever does.
  const rows = buildIndex([
    piece({ ref: "x", rank: 1, sectionRank: 0, sectionRef: "T0", sectionTitle: "T" }),
    piece({ ref: "s", rank: 2 }),
    piece({ ref: "y", rank: 1, sectionRank: 1, sectionRef: "T0", sectionTitle: "T" }),
  ]);
  assert.equal(rows.length, 2);
  const thread = rows[0]!;
  assert.ok(thread.kind === "thread");
  assert.equal(thread.members.length, 2);
}

function testRowsComeOutInRankOrder() {
  const rows = buildIndex([piece({ ref: "c", rank: 3 }), piece({ ref: "a", rank: 1 })]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 3]);
}

// --- displayHeadline ---

function testHeadlineWins() {
  assert.equal(displayHeadline({ headline: "Real headline", body: "Body." }), "Real headline");
}

function testLineFallsBackToItsWholeSentence() {
  const body =
    "Iran threatened to block all oil exports through the Gulf. Treasury " +
    "announced further sanctions.";
  assert.equal(displayHeadline({ headline: null, body }), body);
}

function testFallbackNeverTruncatesAtAnAbbreviation() {
  // The reason the fallback does not trim: "U.S." ends in a period followed by
  // a space, and any first-sentence heuristic makes it the headline.
  const body = "U.S. and NATO officials said Patriot stocks are beyond critical.";
  assert.equal(displayHeadline({ headline: null, body }), body);
}

function testBlankHeadlineIsTreatedAsAbsent() {
  assert.equal(displayHeadline({ headline: "   ", body: "Fallback." }), "Fallback.");
  assert.equal(displayHeadline({ headline: null, body: "  Padded.  " }), "Padded.");
}

// --- sourceLabel: what resolved, never what the formula counted ---

function testSourceLabelReportsResolvedLinks() {
  assert.equal(sourceLabel({ resolvedSources: 5, firstSource: "AP" }), "5 sources");
  assert.equal(sourceLabel({ resolvedSources: 1, firstSource: "AP" }), "AP");
  assert.equal(sourceLabel({ resolvedSources: 0, firstSource: null }), null);
  // Nothing resolved, so nothing is claimed — even if a name lingers.
  assert.equal(sourceLabel({ resolvedSources: 0, firstSource: "AP" }), null);
}

// --- paragraphs / reading time / date ---

function testParagraphSplitting() {
  assert.deepEqual(paragraphs("One.\n\nTwo.\n\n  \n\nThree."), ["One.", "Two.", "Three."]);
  assert.deepEqual(paragraphs("Only one."), ["Only one."]);
  assert.deepEqual(paragraphs("   "), []);
}

function testReadingTimeIsWithheldOnShortPieces() {
  assert.equal(readingMinutes(18), null);
  assert.equal(readingMinutes(99), null);
  assert.equal(readingMinutes(100), 1);
  assert.equal(readingMinutes(599), 3);
}

function testEditionDateDoesNotDriftAcrossTheDateLine() {
  // new Date("2026-08-27") is midnight UTC, which is the 26th in Bend. The
  // masthead must still say the 27th.
  assert.equal(formatEditionDate("2026-08-27"), "Thursday, August 27, 2026");
  assert.equal(formatEditionDate("2026-01-01"), "Thursday, January 1, 2026");
  assert.equal(formatEditionDate("not-a-date"), "not-a-date");
}

testStandaloneTakesEveryArticle();
testSectionPieceTakesOnlyItsMember();
testUnknownStoryYieldsNoSourcesRatherThanThrowing();
testUnknownMemberYieldsNoSources();
testDuplicateUrlsCollapseToOneLink();
testThreadBecomesOneRowAndPiecesBecomeRows();
testMembersComeBackInSectionRankOrder();
testNonAdjacentSectionMembersStillGroup();
testRowsComeOutInRankOrder();
testHeadlineWins();
testLineFallsBackToItsWholeSentence();
testFallbackNeverTruncatesAtAnAbbreviation();
testBlankHeadlineIsTreatedAsAbsent();
testSourceLabelReportsResolvedLinks();
testParagraphSplitting();
testReadingTimeIsWithheldOnShortPieces();
testEditionDateDoesNotDriftAcrossTheDateLine();
console.log("publisher assemble tests passed");
