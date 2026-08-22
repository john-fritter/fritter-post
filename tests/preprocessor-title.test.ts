import assert from "node:assert/strict";
import { cleanTitle } from "../src/pipeline/preprocessor/title.js";

// Run #112 published nine headlines carrying a Google News domain suffix. The
// near-misses matter as much as the cuts: an outlet name is not a domain, and
// stripping publication names from headlines is a decision nobody has made.

function testGoogleNewsDomainSuffixIsStripped() {
  assert.equal(
    cleanTitle(
      "Poland says it thwarted a Russian plot to kill an American citizen in Warsaw - apnews.com",
    ),
    "Poland says it thwarted a Russian plot to kill an American citizen in Warsaw",
  );
  assert.equal(
    cleanTitle(
      "DHS cites recent policy shift after not disclosing death of Guatemalan man who had been in custody - apnews.com",
    ),
    "DHS cites recent policy shift after not disclosing death of Guatemalan man who had been in custody",
  );
  assert.equal(
    cleanTitle("A punishing European drought shrivels crops from Dutch potatoes to Bosnian corn - apnews.com"),
    "A punishing European drought shrivels crops from Dutch potatoes to Bosnian corn",
  );
}

function testOutletNamesAreNotStripped() {
  const withOutlet =
    "What Happens When the Most Powerful Law Enforcement Officer in a Rural County Goes Rogue? - Willamette Week";
  assert.equal(cleanTitle(withOutlet), withOutlet);
  const withOtherOutlet = "State Meditates Another Huge Pay Bump for Oregon Health Plan Operators - Willamette Week";
  assert.equal(cleanTitle(withOtherOutlet), withOtherOutlet);
}

function testHeadlinesContainingDashesSurvive() {
  const dashed = "Trump\u2019s Immigration Policy Echoes 1920s Crackdown, but This Time Congress Isn\u2019t Involved";
  assert.equal(cleanTitle(dashed), dashed);
  // A dash inside the headline, with a real domain suffix after it.
  assert.equal(
    cleanTitle("Bend-La Pine schools open a new campus - ktvz.com"),
    "Bend-La Pine schools open a new campus",
  );
}

function testDomainMentionedInProseIsNotASuffix() {
  const prose = "Researchers found a way to hijack devices through zoom.us screen sharing";
  assert.equal(cleanTitle(prose), prose);
}

function testAShortTitleIsLeftAlone() {
  // Stripping would leave almost nothing; more likely a malformed entry.
  const short = "Fire update - ktvz.com";
  assert.equal(cleanTitle(short), short);
}

function testWhitespaceIsTrimmed() {
  assert.equal(cleanTitle("  A perfectly ordinary headline about something  "), "A perfectly ordinary headline about something");
}

testGoogleNewsDomainSuffixIsStripped();
testOutletNamesAreNotStripped();
testHeadlinesContainingDashesSurvive();
testDomainMentionedInProseIsNotASuffix();
testAShortTitleIsLeftAlone();
testWhitespaceIsTrimmed();
console.log("preprocessor title tests passed");
