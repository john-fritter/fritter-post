import assert from "node:assert/strict";
import {
  stripBoilerplate,
  isHeadlineEcho,
  endsMidSentence,
} from "../src/pipeline/writers/boilerplate.js";

// Every rule here came from reading the first assembled packets for editor run
// #112. Each test pins both the cut and a near-miss that must survive, the same
// contract the junk filter's rules carry.

function testCnnWireFooterIsRemoved() {
  const text = [
    "A bomb attack in Crimea has reportedly killed a former Ukrainian submarine commander.",
    "The-CNN-Wire",
    "\u2122 & \u00a9 2026 Cable News Network, Inc., a Warner Bros. Discovery Company. All rights reserved.",
    "The post Crimea bomb attack reportedly kills former Ukrainian submarine commander appeared first on KTVZ.",
  ].join("\n\n");
  const { text: cleaned, dropped } = stripBoilerplate(text);
  assert.equal(dropped, 3);
  assert.equal(cleaned, "A bomb attack in Crimea has reportedly killed a former Ukrainian submarine commander.");
}

function testFurnitureInsideOneParagraphIsRemoved() {
  // KTVZ emits these as two lines of a single paragraph. The first version of
  // the rules matched whole paragraphs and missed exactly this, which is how
  // both lines reached the rank 3 packet after the first fix.
  const text = [
    "Five other people were killed in a separate explosion in Sevastopol.",
    "The-CNN-Wire\n\u2122 & \u00a9 2026 Cable News Network, Inc., a Warner Bros. Discovery Company. All rights reserved.",
  ].join("\n\n");
  const { text: cleaned, dropped } = stripBoilerplate(text);
  assert.equal(dropped, 2);
  assert.equal(cleaned, "Five other people were killed in a separate explosion in Sevastopol.");
}

function testALineOfProseSharingAParagraphWithFurnitureSurvives() {
  const text = "The agency confirmed the strike.\nThe-CNN-Wire";
  const { text: cleaned, dropped } = stripBoilerplate(text);
  assert.equal(dropped, 1);
  assert.equal(cleaned, "The agency confirmed the strike.");
}

function testLireAussiIsDroppedWithoutCuttingTheDocument() {
  // Le Monde's live blog repeats this between real entries; a tail cut here
  // would throw away most of the reporting.
  const text = [
    "Deux personnes ont \u00e9t\u00e9 bless\u00e9es \u00e0 la suite d\u2019une frappe russe.",
    "Lire aussi :",
    "L\u2019Ukraine et la Russie ont proc\u00e9d\u00e9 \u00e0 de nouveaux \u00e9changes de d\u00e9pouilles.",
  ].join("\n\n");
  const { text: cleaned, dropped } = stripBoilerplate(text);
  assert.equal(dropped, 1);
  assert.ok(cleaned.includes("Deux personnes"));
  assert.ok(cleaned.includes("nouveaux \u00e9changes"));
}

function testReadAlsoCutsTheTail() {
  const text = [
    "The KSK grain terminal in Novorossiysk has suspended operations.",
    "READ ALSO",
    "* War Day 1632. The port of Novorossiysk was closed for exercises",
    "* Another unrelated story",
  ].join("\n\n");
  const { text: cleaned } = stripBoilerplate(text);
  assert.equal(cleaned, "The KSK grain terminal in Novorossiysk has suspended operations.");
}

function testGuardianTeaserMarkerIsRemoved() {
  const text = "Nearly 100 children have been wrongly identified and detained as adults.\n\nContinue reading...";
  const { text: cleaned, dropped } = stripBoilerplate(text);
  assert.equal(dropped, 1);
  assert.ok(!cleaned.includes("Continue reading"));
}

function testLeMondeLiveChromeIsRemoved() {
  const text = [
    "Deux personnes ont \u00e9t\u00e9 bless\u00e9es \u00e0 la suite d\u2019une frappe russe.",
    "Posez votre question \u00e0 la r\u00e9daction :",
    "R\u00e9agissez",
    "Votre pseudo...",
    "1. Article r\u00e9serv\u00e9 aux abonn\u00e9s Avec la s\u00e9cheresse en France, des tensions",
  ].join("\n\n");
  const { text: cleaned, dropped } = stripBoilerplate(text);
  assert.equal(dropped, 4);
  assert.ok(cleaned.startsWith("Deux personnes"));
}

function testNprImageCreditIsRemoved() {
  const text = "Ukraine is hitting Crimea hard, upending daily life.\n\n(Image credit: Igor Ivanko)";
  const { dropped } = stripBoilerplate(text);
  assert.equal(dropped, 1);
}

function testProseIsNeverCutForMentioningTheseThings() {
  // The near-misses. Each of these is reporting that contains a phrase a
  // sloppier rule would fire on.
  const survivors = [
    "CNN reported that the officer had defected in 2014.",
    "The company said all rights reserved to its licensees would be honoured under the settlement.",
    "Readers were told to continue reading the filing before the hearing.",
    "The post office announced it would appear first on the ballot in November.",
    "Related stories about the outage were published by three outlets that week.",
  ];
  for (const line of survivors) {
    const { text: cleaned, dropped } = stripBoilerplate(line);
    assert.equal(dropped, 0, `wrongly cut: ${line}`);
    assert.equal(cleaned, line);
  }
}

function testEmptyInputIsSafe() {
  assert.deepEqual(stripBoilerplate(""), {
    text: "",
    dropped: 0,
    truncatedTail: false,
    endedMidSentence: false,
  });
}

// --- headline echo ---

function testGoogleNewsStubIsAnEcho() {
  assert.equal(
    isHeadlineEcho(
      "Poland says it thwarted a Russian plot to kill an American citizen in Warsaw - apnews.com",
      "Poland says it thwarted a Russian plot to kill an American citizen in Warsaw  apnews.com",
    ),
    true,
  );
}

function testAShortRealSummaryIsNotAnEcho() {
  // 89 characters, and every one of them is a fact the headline did not carry.
  assert.equal(
    isHeadlineEcho(
      "Ukraine attacks key Russian grain terminal on Black Sea port",
      "Ukraine has damaged Russia\u2019s grain export terminals in an attack on the Novorossiysk port.",
    ),
    false,
  );
}

function testHeadlineFollowedByRealTextIsNotAnEcho() {
  assert.equal(
    isHeadlineEcho(
      "Third person dies at New Jersey immigration detention center",
      "Third person dies at New Jersey immigration detention center. A man died in custody at Delaney Hall on Wednesday, the third death this year.",
    ),
    false,
  );
}

function testEmptyBodyIsAnEcho() {
  assert.equal(isHeadlineEcho("Some headline", ""), true);
  assert.equal(isHeadlineEcho("Some headline", "   "), true);
}

testCnnWireFooterIsRemoved();
testFurnitureInsideOneParagraphIsRemoved();
testALineOfProseSharingAParagraphWithFurnitureSurvives();
testLireAussiIsDroppedWithoutCuttingTheDocument();
testReadAlsoCutsTheTail();
testGuardianTeaserMarkerIsRemoved();
testLeMondeLiveChromeIsRemoved();
testNprImageCreditIsRemoved();
testProseIsNeverCutForMentioningTheseThings();
testEmptyInputIsSafe();
testGoogleNewsStubIsAnEcho();
testAnAggregatorStubIsAnEchoWhenTheSuffixesDisagree();
testASourceWithRealReportingIsNotAnEchoHoweverItIsAttributed();
testAShortRealSummaryIsNotAnEcho();
testHeadlineFollowedByRealTextIsNotAnEcho();
testEmptyBodyIsAnEcho();

// Run #118's ranks 65 and 8: Readability returned Cascade PBS's house promo for
// a different programme as the article body, twice over, for an ABC-v-FCC
// lawsuit and a South Korea military-drills feature. A non-empty extraction is
// not a guarantee of article-shaped prose — it is the best block on a page whose
// article Readability could not see.

const CASCADE_PROMO =
  "Finding one\u2019s voice as a writer takes dedication, courage, and a willingness to " +
  "reimagine the world through words on a page. In this episode of \u201cBeyond the CANVAS,\u201d " +
  "we sit down with novelist Margaret Atwood, playwright Danai Gurira, and others to talk " +
  "about finding meaning as a writer.";

function testCascadePbsHousePromoIsRemoved() {
  const out = stripBoilerplate(`${CASCADE_PROMO}\n\nABC sued the FCC on Tuesday.`);
  assert.ok(!out.text.includes("Margaret Atwood"));
  assert.ok(out.text.includes("ABC sued the FCC"));
  assert.equal(out.dropped, 1);
}

function testAnArticleAboutWritersSurvives() {
  // The near-miss: a real piece that discusses finding a voice as a writer.
  const prose =
    "Finding one\u2019s voice as a writer is what the workshop teaches, its director said, " +
    "and the state has now cut its funding.";
  assert.equal(stripBoilerplate(prose).text, prose);
}

function testAParagraphRepeatedInsideOneDocumentIsDropped() {
  // No article says the same paragraph twice; a page template does, once per
  // slot. The cascadepbs extraction was this promo twice and nothing else, which
  // measured 574 characters against a 390-character feed teaser and won the
  // packet's longer-of-the-two comparison.
  const para = "The commission voted on Tuesday to open the proceeding, according to the filing.";
  const out = stripBoilerplate([para, para].join("\n\n"));
  assert.equal(out.text, para);
  assert.equal(out.dropped, 1);
}

function testDistinctParagraphsAreAllKept() {
  const a = "The commission voted on Tuesday to open the proceeding.";
  const b = "The company said it would appeal the decision.";
  const out = stripBoilerplate([a, b].join("\n\n"));
  assert.equal(out.text, [a, b].join("\n\n"));
  assert.equal(out.dropped, 0);
}

// --- truncated feed teasers ---
//
// Run #43's rank 15 (S62865, La Nación) is the case: a ~1,800-character feed
// body, well clear of the 800-char fetch floor, that stops mid-clause inside a
// quotation. The fetch skipped it as "already long enough", and the writer
// produced 180 words of real reporting and then narrated the break.

const LANACION_TEASER =
  "The Trump administration began deportation flights to Haiti on August 20, after " +
  "Temporary Protected Status for more than 300,000 people expired. The first flight " +
  "carried 161 people to Cap-Haïtien, on Haiti's north coast, according to Haiti's " +
  "National Migration Office.\n\n" +
  "Flights were routed to Cap-Haïtien because Port-au-Prince's airport is closed to " +
  "U.S. commercial flights amid gang violence. Hours before the first flight departed, " +
  "the DHS secretary posted on X.\n\n" +
  "Cap-Haïtien itself is overwhelmed. Its population has grown from 350,000 in 2003 to " +
  "roughly 800,000 as people displaced by the capital's crisis have flooded in. " +
  "Residents say the city cannot absorb more arrivals.\n\n" +
  "\u201cWe are not only receiving deportees from outside Haiti due to the political " +
  "crisis; we also have people from";

function testATeaserThatStopsMidClauseIsDetected() {
  assert.equal(endsMidSentence(LANACION_TEASER), true);
}

function testTheDanglingClauseIsCutBackToTheLastFinishedSentence() {
  const out = stripBoilerplate(LANACION_TEASER);
  assert.equal(out.truncatedTail, true);
  assert.ok(out.text.endsWith("cannot absorb more arrivals."));
  // The reporting above it survives untouched.
  assert.ok(out.text.includes("began deportation flights to Haiti on August 20,"));
  assert.ok(!out.text.includes("we also have people from"));
}

function testAnEllipsisIsATruncationMarkerNotAnEnding() {
  // Feed teasers trail off with an ellipsis; that is the publisher cutting the
  // article, not a stylistic choice, and it must not read as a finished body.
  assert.equal(endsMidSentence("The council met on Tuesday. It voted to\u2026"), true);
  assert.equal(endsMidSentence("The council met on Tuesday. It voted to..."), true);
  const out = stripBoilerplate("The council met on Tuesday. It voted to\u2026");
  assert.equal(out.text, "The council met on Tuesday.");
}

function testACompleteBodyIsUntouched() {
  const body =
    "Prosecutors indicted nine people on Monday.\n\n" +
    "The servers contained B300 units, which are banned from sale to China.";
  const out = stripBoilerplate(body);
  assert.equal(out.truncatedTail, false);
  assert.equal(out.text, body);
}

function testASentenceClosedInsideAQuotationIsComplete() {
  // The near-miss this rule must not fire on: the body ends properly, but the
  // last character is a quotation mark rather than the full stop.
  const body = "Barrack called it \u201can unnecessary escalation that does not help.\u201d";
  assert.equal(endsMidSentence(body), false);
  assert.equal(stripBoilerplate(body).text, body);
  assert.equal(endsMidSentence("She said the plan was \u201cdead on arrival.\u201d"), false);
}

function testTerminalPunctuationOutsideEnglishCounts() {
  // The paper carries Korean, Chinese and Japanese items; a full-width stop ends
  // a sentence exactly as a period does.
  assert.equal(endsMidSentence("\ud68c\uc758\uac00 \uc5f4\ub838\ub2e4\u3002"), false);
  assert.equal(endsMidSentence("\u4f1a\u8b70\u304c\u958b\u304b\u308c\u305f\u3002"), false);
}

function testABodyWithNoFinishedSentenceIsLeftAlone() {
  // Nothing to trim back to. Emptying it would destroy the only material there
  // is; materialLevelOf and isHeadlineEcho judge it on its length instead.
  const body = "Council weighs new rules on short-term rentals in the historic district";
  const out = stripBoilerplate(body);
  assert.equal(out.truncatedTail, false);
  assert.equal(out.text, body);
}

function testFeedFooterFurnitureDoesNotMakeAnArticleLookTruncated() {
  // The correction the source audit forced. Ars Technica closes every feed body
  // with "Read full article" / "Comments" — 92 of its 92 long bodies over the
  // 14-day window — and the Guardian with "Continue reading...". Judged raw,
  // none of them ends on terminal punctuation and all of them read as
  // truncated; judged after furniture removal, they are complete articles.
  // Across twelve outlets that are already 100% usable that was 611 fetch
  // requests we would have paid for and thrown away.
  const article =
    "The commission voted on Tuesday to open the proceeding.\n\n" +
    "Regulators said the review would take up to a year.";
  for (const footer of ["Read full article", "Comments", "Continue reading..."]) {
    const out = stripBoilerplate(`${article}\n\n${footer}`);
    assert.equal(out.endedMidSentence, false, footer);
    assert.equal(out.truncatedTail, false, footer);
    assert.equal(out.text, article, footer);
  }
  // And the raw body genuinely does look truncated, which is the whole point:
  // the check has to run downstream of the strip.
  assert.equal(endsMidSentence(`${article}\n\nRead full article`), true);
}

function testARealTruncationSurvivesFurnitureRemoval() {
  const out = stripBoilerplate(`${LANACION_TEASER}\n\nContinue reading...`);
  assert.equal(out.endedMidSentence, true);
  assert.equal(out.truncatedTail, true);
  assert.ok(!out.text.includes("we also have people from"));
}

function testAStructurelessBodyIsStillReportedIncomplete() {
  // trimTruncatedTail declines to cut here — the last finished sentence is in
  // the first half — but the body is incomplete all the same, and that is the
  // strongest reason to go and fetch the real article. The two flags differ on
  // purpose.
  const body = "Overview. " + "Names and figures without punctuation ".repeat(12);
  const out = stripBoilerplate(body);
  assert.equal(out.truncatedTail, false);
  assert.equal(out.endedMidSentence, true);
}

function testABoundaryThatWouldCostMostOfTheBodyIsNotHonoured() {
  // A body whose last finished sentence sits near its start is not prose with a
  // broken tail — it is a caption run or an extraction with no sentence
  // structure. Cutting back to that first full stop throws away nearly
  // everything to fix nothing, so the body is left whole. Same guard, and the
  // same reason, as trimToBoundary's.
  const body = "Overview. " + "Names and figures without punctuation ".repeat(12);
  const out = stripBoilerplate(body);
  assert.equal(endsMidSentence(body), true);
  assert.equal(out.truncatedTail, false);
  assert.equal(out.text, body.trimEnd());
}

function testFurnitureIsRemovedBeforeTheTailIsJudged() {
  // The trim must see the body the writer would read. A tail marker can leave a
  // different final sentence than the raw document had.
  const body =
    "The commission voted on Tuesday to open the proceeding.\n\n" +
    "READ ALSO\n\n" +
    "Some other headline that trails off";
  const out = stripBoilerplate(body);
  assert.equal(out.text, "The commission voted on Tuesday to open the proceeding.");
  assert.equal(out.truncatedTail, false);
}

function testAnAggregatorStubIsAnEchoWhenTheSuffixesDisagree() {
  // The gap the source audit found. title.ts strips a trailing bare *domain*
  // and nothing else — run #112 needed "… Goes Rogue? - Willamette Week" to
  // keep its suffix — so a Google News title reaches here ending "- AP News"
  // while its body ends "- apnews.com". The two normalized to different
  // strings, startsWith failed, and the stub was admitted to the packet as a
  // source. 99 of 106 Google News members over the 14-day window did this.
  assert.equal(
    isHeadlineEcho(
      "Wife of active-duty Army sergeant is deported to Honduras - AP News",
      "Wife of active-duty Army sergeant is deported to Honduras - apnews.com",
    ),
    true,
  );
  assert.equal(
    isHeadlineEcho(
      "DOGE tech employees resigned after refusing to comply with Musk - Mashable",
      "DOGE tech employees resigned after refusing to comply with Musk - mashable.com",
    ),
    true,
  );
}

function testASourceWithRealReportingIsNotAnEchoHoweverItIsAttributed() {
  // The near-miss. A body that opens with its own headline and then reports is
  // the ordinary shape of an article, and the length test is what separates it
  // from a stub. Widening the suffix strip must not touch that.
  assert.equal(
    isHeadlineEcho(
      "Wife of active-duty Army sergeant is deported to Honduras - AP News",
      "Wife of active-duty Army sergeant is deported to Honduras. Her husband, who " +
        "has served eleven years, said he learned of the removal from a neighbour.",
    ),
    false,
  );
  // A headline whose own last clause follows a dash still matches its article.
  assert.equal(
    isHeadlineEcho(
      "The plan is dead - officials say",
      "The plan is dead, officials say. The vote was postponed indefinitely after " +
        "three members withdrew their support on Tuesday afternoon.",
    ),
    false,
  );
}

function testApUnrenderedTimestampIsStrippedFromTheHeadOfTheLine() {
  // AP renders its timestamp client-side and ships the placeholders in the HTML,
  // so the dateline and the first sentence arrive behind seventy characters of
  // broken template. Five of twelve pages sampled on 2026-08-27 carried it.
  const ap =
    "Updated [hour]:[minute] [AMPM] [timezone], [monthFull] [day], [year] " +
    "BUÑOL, Spain (AP) — Thousands pelted one another with tomatoes on Wednesday.";
  const out = stripBoilerplate(ap);
  assert.equal(
    out.text,
    "BUÑOL, Spain (AP) — Thousands pelted one another with tomatoes on Wednesday.",
  );

  // The newsletter shape says "Published", and a byline may come first. Only
  // the placeholder run goes: the byline is real attribution.
  const wire =
    "By THE ASSOCIATED PRESS Updated [hour]:[minute] [AMPM] [timezone], " +
    "[monthFull] [day], [year] All Times EDT Thursday, Aug. 27.";
  assert.equal(
    stripBoilerplate(wire).text,
    "By THE ASSOCIATED PRESS All Times EDT Thursday, Aug. 27.",
  );

  const newsletter =
    "Published [hour]:[minute] [AMPM] [timezone], [monthFull] [day], [year] " +
    "This is our flagship newsletter Morning Wire.";
  assert.equal(
    stripBoilerplate(newsletter).text,
    "This is our flagship newsletter Morning Wire.",
  );
}

function testBracketedProseIsNotMistakenForATemplate() {
  // An editorial insertion in a quotation is bracketed too, and it is prose.
  const quote =
    'Updated guidance says the agency "will review [the] matter," a spokesperson said.';
  assert.equal(stripBoilerplate(quote).text, quote);

  // Two placeholders is not the pattern; the rule wants a run of three.
  const partial = "Updated [hour]:[minute] on the record, the mayor said.";
  assert.equal(stripBoilerplate(partial).text, partial);
}


testCascadePbsHousePromoIsRemoved();
testAnArticleAboutWritersSurvives();
testAParagraphRepeatedInsideOneDocumentIsDropped();
testDistinctParagraphsAreAllKept();
testATeaserThatStopsMidClauseIsDetected();
testTheDanglingClauseIsCutBackToTheLastFinishedSentence();
testAnEllipsisIsATruncationMarkerNotAnEnding();
testACompleteBodyIsUntouched();
testASentenceClosedInsideAQuotationIsComplete();
testTerminalPunctuationOutsideEnglishCounts();
testABodyWithNoFinishedSentenceIsLeftAlone();
testFeedFooterFurnitureDoesNotMakeAnArticleLookTruncated();
testARealTruncationSurvivesFurnitureRemoval();
testAStructurelessBodyIsStillReportedIncomplete();
testABoundaryThatWouldCostMostOfTheBodyIsNotHonoured();
testFurnitureIsRemovedBeforeTheTailIsJudged();
testApUnrenderedTimestampIsStrippedFromTheHeadOfTheLine();
testBracketedProseIsNotMistakenForATemplate();

console.log("writer boilerplate tests passed");
