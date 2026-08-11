import assert from "node:assert/strict";
import { classifyItem } from "../src/pipeline/preprocessor/junk-filter.js";

function item(title: string, body: string | null = null) {
  return { id: "1", source_name: "Test Source", title, body_text: body };
}

function assertCut(title: string, body: string | null, reason: string) {
  const r = classifyItem(item(title, body));
  assert.equal(r.keep, false, `expected CUT: ${title}`);
  assert.equal(r.reason, reason);
}

function assertKept(title: string, body: string | null = null) {
  const r = classifyItem(item(title, body));
  assert.equal(r.keep, true, `expected KEEP: ${title} (cut as ${r.reason})`);
}

// --- Link-dump digests: the run #109 rows that reached the feature tier ---

function testDateOnlyTitleIsCut() {
  assertCut("August 10, 2026", null, "link-dump-digest");
  assertCut("August 10 2026", null, "link-dump-digest");
  assertCut("10 August 2026", null, "link-dump-digest");
  assertCut("Aug. 10, 2026", null, "link-dump-digest");
}

function testDigestMastheadIsCut() {
  assertCut("Early Edition: August 10, 2026", null, "link-dump-digest");
  assertCut("Early Edition: August 11, 2026", null, "link-dump-digest");
  assertCut("The Download: AI agents for science, and the censorship-industrial complex", null, "link-dump-digest");
  assertCut("Catch-up Weekend: New Developments in the Hong Kong 47 Case", null, "link-dump-digest");
  assertCut("What we're reading — week of August 10", null, "link-dump-digest");
}

function testDigestBoilerplateBodyIsCut() {
  // The exact shape of the Just Security body observed in run #109's prefilter
  // prompt sample.
  assertCut(
    "Some innocuous headline",
    "Signup to receive the Early Edition in your inbox here.\n\n" +
      "A curated guide to major news and developments over the weekend. Here's today's news:\n\n" +
      "IRAN WAR \n\nThe secretary of Iran's Supreme National Security Council issued a statement",
    "link-dump-digest",
  );
  assertCut("Untitled", "Here's today's news: the Senate voted, the court ruled…", "link-dump-digest");
}

// --- The precision side: these must NOT be cut ---

function testRealStoriesWithDatesSurvive() {
  // A headline that contains a date but says what happened.
  assertKept("Bend City Council approves $1 million for affordable housing on August 10, 2026");
  assertKept("August 10 protest draws thousands to the state capitol");
}

function testMastheadWordsInRealHeadlinesSurvive() {
  // "The Download" only matches as a masthead — followed by a separator.
  assertKept("The download problem nobody wants to talk about");
  assertKept("Early edition sales beat expectations for the publisher");
  assertKept("Quick hits from the semiconductor earnings call are worth reading");
}

function testNewsletterMentionInABodyDoesNotCut() {
  // A real article that happens to mention signing up for something.
  assertKept(
    "ICE is amassing a DNA bank",
    "The agency has collected genetic material from hundreds of thousands of people. " +
      "Sign up for our newsletter to follow this investigation.",
  );
}

function testTitleOnlyItemsSurvive() {
  // Wire and foreign feeds ship title-only rows. A missing body is never a
  // digest signal on its own.
  assertKept("Zelensky says Russia using North Korean missiles", null);
  assertKept("Philippine VP Sara Duterte charged over Marcos assassination threat", "");
}

// --- Pre-existing rules still work ---

function testExistingRulesUnchanged() {
  assertCut("Explore calendar May 30-June 5", null, "event-calendar");
  assertCut("Photos of the week", null, "photo-gallery");
  assertCut("Things to do this weekend in Bend", null, "events-listing");
  assertCut("Support us", "We are member-supported and rely on donate today gifts.", "house-ad");
  assertKept("Oregon wildfires prompt evacuations");
}

const tests = [
  testDateOnlyTitleIsCut,
  testDigestMastheadIsCut,
  testDigestBoilerplateBodyIsCut,
  testRealStoriesWithDatesSurvive,
  testMastheadWordsInRealHeadlinesSurvive,
  testNewsletterMentionInABodyDoesNotCut,
  testTitleOnlyItemsSurvive,
  testExistingRulesUnchanged,
];

for (const t of tests) t();
console.log("junk-filter tests passed");
