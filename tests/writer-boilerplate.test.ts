import assert from "node:assert/strict";
import { stripBoilerplate, isHeadlineEcho } from "../src/pipeline/writers/boilerplate.js";

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
  assert.deepEqual(stripBoilerplate(""), { text: "", dropped: 0 });
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
testReadAlsoCutsTheTail();
testGuardianTeaserMarkerIsRemoved();
testLeMondeLiveChromeIsRemoved();
testNprImageCreditIsRemoved();
testProseIsNeverCutForMentioningTheseThings();
testEmptyInputIsSafe();
testGoogleNewsStubIsAnEcho();
testAShortRealSummaryIsNotAnEcho();
testHeadlineFollowedByRealTextIsNotAnEcho();
testEmptyBodyIsAnEcho();
console.log("writer boilerplate tests passed");
