import assert from "node:assert/strict";
import { canonicalizeUrl, unwrapRedirect } from "../src/pipeline/preprocessor/canonicalize.js";

// URL canonicalization is the preprocessor's dedup key and, through it, the URL
// the fetcher goes to and the host the cooldown is learned against. A wrapper
// stored here is a wrong host everywhere downstream.

const FOLHA_WRAPPED =
  "https://redir.folha.com.br/redir/online/emcimadahora/rss091/*" +
  "https://www1.folha.uol.com.br/mundo/2026/08/juiz-dos-eua-rejeita-acao.shtml";
const FOLHA_ARTICLE = "https://www1.folha.uol.com.br/mundo/2026/08/juiz-dos-eua-rejeita-acao.shtml";

function testFolhaRedirectorIsUnwrapped() {
  // Run #118 stored 42 article rows under redir.folha.com.br. The fetch went to
  // the redirector and the cooldown was learned against a host that is not a
  // publisher.
  assert.equal(unwrapRedirect(FOLHA_WRAPPED), FOLHA_ARTICLE);
  assert.equal(new URL(canonicalizeUrl(FOLHA_WRAPPED)).hostname, "www1.folha.uol.com.br");
}

function testGoogleNewsTokensAreLeftAlone() {
  // The /rss/articles/CBMi… token is an opaque identifier, not an encoded URL.
  // There is nothing to unwrap and guessing would produce a URL that is not the
  // article.
  const google =
    "https://news.google.com/rss/articles/CBMirAFBVV95cUxPY1Fhd2FfOTlyUHFXUC1aOXRu?oc=5";
  assert.equal(unwrapRedirect(google), google);
}

function testAnEmbeddedUrlInTheQueryIsNotARedirect() {
  // One outlet's article carrying a referrer is not a redirect to another, and
  // unwrapping it would replace the story with whatever the parameter pointed at.
  const withRef = "https://www.example.com/2026/08/a-story?ref=https://aggregator.example/x";
  assert.equal(unwrapRedirect(withRef), withRef);
}

function testOrdinaryUrlsAreUntouched() {
  const plain = "https://www.opb.org/article/2026/08/20/umatilla-tribes-see-lower-fish-returns/";
  assert.equal(unwrapRedirect(plain), plain);
  assert.equal(canonicalizeUrl(plain), plain);
}

function testMalformedInputSurvives() {
  assert.equal(unwrapRedirect("not a url at all"), "not a url at all");
  assert.equal(canonicalizeUrl("not a url at all"), "not a url at all");
}

function testTrackingParamsAreStripped() {
  const tracked = "https://www.bbc.co.uk/news/c62eyn5ggnzo?at_medium=RSS&utm_source=feed";
  const out = canonicalizeUrl(tracked);
  assert.ok(!out.includes("utm_source"));
  // at_medium is not in the strip list; only the named tracking params go.
  assert.ok(out.includes("at_medium"));
}

function testAmpVariantsAreNormalized() {
  assert.equal(
    canonicalizeUrl("https://amp.example.com/2026/08/story"),
    "https://www.example.com/2026/08/story",
  );
  assert.equal(
    canonicalizeUrl("https://www.example.com/amp/2026/08/story"),
    "https://www.example.com/2026/08/story",
  );
  assert.equal(
    canonicalizeUrl("https://www.example.com/2026/08/story/amp"),
    "https://www.example.com/2026/08/story",
  );
}

function testHostnameIsLowercasedAndDefaultPortsGo() {
  assert.equal(canonicalizeUrl("https://WWW.Example.COM:443/story"), "https://www.example.com/story");
}

testFolhaRedirectorIsUnwrapped();
testGoogleNewsTokensAreLeftAlone();
testAnEmbeddedUrlInTheQueryIsNotARedirect();
testOrdinaryUrlsAreUntouched();
testMalformedInputSurvives();
testTrackingParamsAreStripped();
testAmpVariantsAreNormalized();
testHostnameIsLowercasedAndDefaultPortsGo();
console.log("canonicalize tests passed");
