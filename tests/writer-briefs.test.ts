import assert from "node:assert/strict";
import {
  buildBriefBatchUserPrompt,
  parseBriefBatchOutput,
  parseWriterOutput,
} from "../src/pipeline/writers/prompt.js";
import { countWords } from "../src/pipeline/writers/index.js";
import type { WriterPacket } from "../src/pipeline/writers/assembler.js";

// Briefs are written in batches because the paper carries 75 of them at 25–45
// words each, and one call per brief would re-send the bio and the standing memo
// 75 times. The batch's risk is misalignment — a brief written for the wrong
// story, or one silently missing — so the parser is keyed on refs and every
// absence becomes a failed piece rather than a gap.

function packet(ref: string, rank: number): WriterPacket {
  return {
    storyId: rank,
    section: null,
    rank,
    tier: "brief",
    ref,
    itemType: "singleton",
    title: `Title for ${ref}`,
    summary: "",
    score: 60,
    sourceCount: 1,
    targetWords: [25, 45],
    materialLevel: "partial",
    articles: [
      {
        preprocessedItemId: rank,
        memberRef: ref,
        sourceName: "Source",
        parentSource: "Source",
        title: `Title for ${ref}`,
        url: `https://example.com/${rank}`,
        publishedAt: new Date("2026-08-13T12:00:00Z"),
        text: `Body text for ${ref}.`,
        chars: 20,
        availableChars: 20,
        truncated: false,
        origin: "feed",
        duplicateParagraphs: 0,
        boilerplateParagraphs: 0,
        translationFailed: false,
      },
    ],
    omitted: [],
    notes: [],
    totalChars: 20,
  };
}

function testBatchPromptCarriesEveryBriefAndItsRef() {
  const packets = [packet("S1", 100), packet("S2", 101), packet("S3", 102)];
  const prompt = buildBriefBatchUserPrompt("John, b. 1983. Bend, Oregon.", packets);
  assert.ok(prompt.includes("Bend, Oregon"));
  for (const p of packets) {
    assert.ok(prompt.includes(p.ref), `missing ref ${p.ref}`);
    assert.ok(prompt.includes(`Body text for ${p.ref}.`));
  }
  assert.ok(prompt.includes("BRIEFS TO WRITE (3)"));
  assert.ok(prompt.includes("ref;;headline;;body"));
  // Briefs are unrelated; the prompt has to say so or the model will braid them.
  assert.ok(/unrelated to each other/.test(prompt));
}

function testParsesOneLinePerBrief() {
  const out = [
    "S1;;Oregon bans fireworks in Redmond;;The city council voted Tuesday to ban all fireworks.",
    "S2;;North Korea fires ballistic missiles;;Three missiles fell into the sea, South Korea said.",
  ].join("\n");
  const parsed = parseBriefBatchOutput(out, ["S1", "S2"]);
  assert.equal(parsed.size, 2);
  assert.equal(parsed.get("S1")!.headline, "Oregon bans fireworks in Redmond");
  assert.equal(parsed.get("S2")!.body, "Three missiles fell into the sea, South Korea said.");
}

function testBracketedAndLowercaseRefsStillMatch() {
  const parsed = parseBriefBatchOutput("[s1];;A headline;;A body sentence.", ["S1"]);
  assert.equal(parsed.get("S1")!.headline, "A headline");
}

function testSemicolonsInsideTheBodySurvive() {
  // The body is last, so a ;; inside it cannot shift a column.
  const parsed = parseBriefBatchOutput(
    "S1;;A headline;;One clause;; and another that follows it.",
    ["S1"],
  );
  assert.equal(parsed.get("S1")!.body, "One clause;; and another that follows it.");
}

function testInventedRefsAreDropped() {
  const parsed = parseBriefBatchOutput(
    ["S1;;Real;;Real body.", "S999;;Invented;;Invented body."].join("\n"),
    ["S1"],
  );
  assert.equal(parsed.size, 1);
  assert.ok(!parsed.has("S999"));
}

function testFirstLineForARefWins() {
  const parsed = parseBriefBatchOutput(
    ["S1;;First;;First body.", "S1;;Second;;Second body."].join("\n"),
    ["S1"],
  );
  assert.equal(parsed.get("S1")!.headline, "First");
}

function testMissingBriefsAreSimplyAbsent() {
  // The runner turns each absence into a failed piece with a reason; the parser
  // must not invent a placeholder.
  const parsed = parseBriefBatchOutput("S1;;Only one;;Body.", ["S1", "S2", "S3"]);
  assert.equal(parsed.size, 1);
  assert.ok(!parsed.has("S2"));
}

function testEmptyFieldsAreRejected() {
  const parsed = parseBriefBatchOutput(
    ["S1;;;;A body with no headline.", "S2;;A headline with no body;;"].join("\n"),
    ["S1", "S2"],
  );
  assert.equal(parsed.size, 0);
}

function testPreambleAndFencesAreIgnored() {
  const out = [
    "Here are the briefs:",
    "```",
    "S1;;A headline;;A body.",
    "```",
  ].join("\n");
  const parsed = parseBriefBatchOutput(out, ["S1"]);
  assert.equal(parsed.size, 1);
}

// --- reading a writer's output ---
//
// Run #3 lost two whole pieces to "unparseable output": calls that succeeded,
// cost their tokens, and produced prose the parser refused to read because the
// first line was not exactly the contracted shape.

function testLabelledHeadlineIsRead() {
  const parsed = parseWriterOutput("HEADLINE: Third person dies in ICE custody\n\nA man died...");
  assert.equal(parsed!.headline, "Third person dies in ICE custody");
  assert.equal(parsed!.body, "A man died...");
}

function testPreambleBeforeTheHeadlineIsSkipped() {
  const parsed = parseWriterOutput(
    "Here is the piece:\n\nHEADLINE: Oregon covers wildfire costs upfront\n\nOregon's season is the worst on record.",
  );
  assert.equal(parsed!.headline, "Oregon covers wildfire costs upfront");
  assert.ok(parsed!.body.startsWith("Oregon's season"));
}

function testCodeFencesAreIgnored() {
  const parsed = parseWriterOutput(
    "```\nHEADLINE: A fenced headline\n\nThe body of the piece.\n```",
  );
  assert.equal(parsed!.headline, "A fenced headline");
  assert.equal(parsed!.body, "The body of the piece.");
}

function testDecoratedLabelsAreRead() {
  assert.equal(
    parseWriterOutput("**Headline:** A bold label\n\nBody.")!.headline,
    "A bold label",
  );
  assert.equal(parseWriterOutput("## HEADLINE: A heading label\n\nBody.")!.headline, "A heading label");
}

function testAnUnlabelledShortFirstLineIsTheHeadline() {
  // The model wrote the piece correctly and skipped the label. Refusing to read
  // that costs a whole piece for nothing.
  const parsed = parseWriterOutput(
    "Ukrainian strike shuts down three Russian grain terminals\n\nA combined drone and missile attack...",
  );
  assert.equal(parsed!.headline, "Ukrainian strike shuts down three Russian grain terminals");
  assert.ok(parsed!.body.startsWith("A combined drone"));
}

function testMarkdownHeadingAsHeadline() {
  const parsed = parseWriterOutput("# Oregon bans fireworks in Redmond\n\nThe council voted Tuesday.");
  assert.equal(parsed!.headline, "Oregon bans fireworks in Redmond");
}

function testProseFirstLineIsNotAHeadline() {
  // Publishing a paragraph as a headline is worse than recording a failure.
  const prose =
    "The Trump administration's immigration crackdown has widened from Latino communities to groups that previously drew less enforcement attention, according to data obtained under a Freedom of Information Act request.";
  assert.equal(parseWriterOutput(`${prose}\n\nMore body text follows here.`), null);
}

function testHeadlineWithNoBodyIsAFailure() {
  assert.equal(parseWriterOutput("HEADLINE: no body follows"), null);
  assert.equal(parseWriterOutput("A bare line and nothing else"), null);
  assert.equal(parseWriterOutput(""), null);
}

// Run #28's C187: the model wrote a draft, caught itself asserting a figure that
// came from the cluster label rather than a source, wrote a second, caught
// itself writing about the sourcing, and wrote a third that was correct. All
// three drafts and the reasoning between them reached the paper — 233 words on a
// 60-word ceiling — because the parser took the first headline and everything
// after it.

const C187_OUTPUT = `HEADLINE: SK Hynix plans to build a semiconductor factory in Japan

SK Hynix will construct a semiconductor factory in Japan, the Korean newspaper Hankyoreh reported. The company expects substantial subsidies from the Japanese government as part of the plan.

---

I'm going to stop here. The source material I have is extremely thin — only a headline. The piece above includes the subsidy claim, which appears in the clustering summary but not in the actual source text I was given. Let me correct that.

---

HEADLINE: SK Hynix plans to build a semiconductor factory in Japan

SK Hynix will construct a semiconductor factory in Japan, Hankyoreh reported. No further details were available from the source.

---

No — I must not write about the sourcing or what was unavailable. Let me write only what the source headline states.

---

HEADLINE: SK Hynix plans semiconductor factory in Japan

Korean newspaper Hankyoreh reports that SK Hynix will build a semiconductor factory in Japan.`;

function testTheLastDraftWins() {
  const parsed = parseWriterOutput(C187_OUTPUT);
  assert.equal(parsed!.headline, "SK Hynix plans semiconductor factory in Japan");
  assert.equal(
    parsed!.body,
    "Korean newspaper Hankyoreh reports that SK Hynix will build a semiconductor factory in Japan.",
  );
  // The failures the drafts were revising away must not survive into the piece.
  assert.ok(!parsed!.body.includes("subsidies"));
  assert.ok(!parsed!.body.includes("No further details"));
  assert.ok(!parsed!.body.includes("I must not"));
}

function testAnUnlabelledFirstDraftStillYieldsTheLastOne() {
  // The opening draft skipped the label; the revisions did not.
  const parsed = parseWriterOutput(
    "A first attempt at the headline\n\nA first attempt at the body.\n\n---\n\nHEADLINE: The second attempt\n\nThe second body.",
  );
  assert.equal(parsed!.headline, "The second attempt");
  assert.equal(parsed!.body, "The second body.");
}

function testARevisionWithNoBodyFallsBackToTheDraftBefore() {
  // A trailing label with nothing under it is an abandoned start, not the piece.
  const parsed = parseWriterOutput(
    "HEADLINE: The real headline\n\nThe real body.\n\n---\n\nHEADLINE: Abandoned restart",
  );
  assert.equal(parsed!.headline, "The real headline");
  assert.equal(parsed!.body, "The real body.");
}

function testTheRescanOnlyLooksInsideTheBody() {
  // A "Headline:" deep in prose is not a restart — the lookahead guard that
  // stopped it being read as the headline must keep stopping it.
  const body = [
    "The paper ran the story under a bland label.",
    "",
    "Headline: writing is not the reporter's job at that outlet, an editor said.",
    "",
    "The desk has since changed hands.",
  ].join("\n");
  const parsed = parseWriterOutput(`HEADLINE: A newsroom changes hands\n\n${body}`);
  assert.equal(parsed!.headline, "A newsroom changes hands");
  assert.ok(parsed!.body.startsWith("The paper ran"));
}

function testAThematicBreakInsideAPieceSurvives() {
  // Only leading and trailing rules are plumbing.
  const parsed = parseWriterOutput(
    "HEADLINE: A feature with a break\n\nFirst movement.\n\n---\n\nSecond movement.",
  );
  assert.equal(parsed!.body, "First movement.\n\n---\n\nSecond movement.");
}

function testWordCount() {
  assert.equal(countWords("The city council voted Tuesday to ban fireworks."), 8);
  assert.equal(countWords("  spaced   out \n words  "), 3);
  assert.equal(countWords(""), 0);
}

testBatchPromptCarriesEveryBriefAndItsRef();
testParsesOneLinePerBrief();
testBracketedAndLowercaseRefsStillMatch();
testSemicolonsInsideTheBodySurvive();
testInventedRefsAreDropped();
testFirstLineForARefWins();
testMissingBriefsAreSimplyAbsent();
testEmptyFieldsAreRejected();
testPreambleAndFencesAreIgnored();
testLabelledHeadlineIsRead();
testPreambleBeforeTheHeadlineIsSkipped();
testCodeFencesAreIgnored();
testDecoratedLabelsAreRead();
testAnUnlabelledShortFirstLineIsTheHeadline();
testMarkdownHeadingAsHeadline();
testProseFirstLineIsNotAHeadline();
testHeadlineWithNoBodyIsAFailure();
testTheLastDraftWins();
testAnUnlabelledFirstDraftStillYieldsTheLastOne();
testARevisionWithNoBodyFallsBackToTheDraftBefore();
testTheRescanOnlyLooksInsideTheBody();
testAThematicBreakInsideAPieceSurvives();
testWordCount();
console.log("writer briefs tests passed");
