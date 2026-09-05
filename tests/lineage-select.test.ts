import assert from "node:assert/strict";
import {
  selectLineageLinks,
  lineageLabel,
  type LineageCandidate,
} from "../src/pipeline/lineage/select.js";

const THRESHOLD = { threshold: 0.8 };

function candidate(over: Partial<LineageCandidate> = {}): LineageCandidate {
  return {
    paperPieceId: "1",
    ref: "C71",
    headline: "Nvidia buys Hugging Face for $12.93 billion",
    body: "Nvidia confirmed the purchase on Thursday.",
    priorPaperId: 2,
    priorPaperPieceId: "10",
    priorPublishedOn: "2026-08-27",
    priorRef: "C23",
    priorHeadline: "Nvidia moves to acquire Hugging Face for roughly $13 billion",
    priorBody: "Business Insider reported the talks.",
    similarity: 0.9,
    ...over,
  };
}

// --- threshold ---

function testKeepsCandidateAtOrAboveThreshold() {
  const links = selectLineageLinks([candidate({ similarity: 0.8 })], THRESHOLD);
  assert.equal(links.length, 1, "a candidate exactly at the threshold must be kept");
}

function testDropsCandidateBelowThreshold() {
  const links = selectLineageLinks([candidate({ similarity: 0.799 })], THRESHOLD);
  assert.equal(links.length, 0, "below the threshold must produce no link");
}

// --- one link per piece ---

function testOneLinkPerPieceAndHighestSimilarityWins() {
  const links = selectLineageLinks(
    [
      candidate({ priorRef: "C23", priorPaperPieceId: "10", similarity: 0.84 }),
      candidate({ priorRef: "S65873", priorPaperPieceId: "11", similarity: 0.91 }),
    ],
    THRESHOLD,
  );
  assert.equal(links.length, 1, "a piece continues at most one story");
  assert.equal(links[0]!.priorRef, "S65873", "the strongest match must win");
}

function testTieBreaksTowardTheMoreRecentPrior() {
  // A story running several days straight would otherwise anchor to its first
  // appearance forever; the useful thing to say is what the paper said last.
  const links = selectLineageLinks(
    [
      candidate({ priorPublishedOn: "2026-08-27", priorRef: "C23", priorPaperPieceId: "10", similarity: 0.88 }),
      candidate({ priorPublishedOn: "2026-09-02", priorRef: "C27", priorPaperPieceId: "11", similarity: 0.88 }),
    ],
    THRESHOLD,
  );
  assert.equal(links.length, 1);
  assert.equal(links[0]!.priorPublishedOn, "2026-09-02", "the more recent prior must win a tie");
}

function testTieBreaksDeterministicallyOnRefWhenDateAlsoTies() {
  const shared = { priorPublishedOn: "2026-09-02", similarity: 0.88 };
  const a = selectLineageLinks(
    [
      candidate({ ...shared, priorRef: "S9", priorPaperPieceId: "11" }),
      candidate({ ...shared, priorRef: "C1", priorPaperPieceId: "12" }),
    ],
    THRESHOLD,
  );
  const b = selectLineageLinks(
    [
      candidate({ ...shared, priorRef: "C1", priorPaperPieceId: "12" }),
      candidate({ ...shared, priorRef: "S9", priorPaperPieceId: "11" }),
    ],
    THRESHOLD,
  );
  assert.equal(a[0]!.priorRef, b[0]!.priorRef, "input order must not change the result");
  assert.equal(a[0]!.priorRef, "C1");
}

function testTwoPiecesMayContinueTheSamePriorPiece() {
  // One day's coverage can legitimately split into two the next.
  const links = selectLineageLinks(
    [
      candidate({ paperPieceId: "1", ref: "C5" }),
      candidate({ paperPieceId: "2", ref: "C6" }),
    ],
    THRESHOLD,
  );
  assert.equal(links.length, 2, "distinct pieces may share one prior piece");
}

function testOutputIsOrderedByTodaysRef() {
  const links = selectLineageLinks(
    [
      candidate({ paperPieceId: "2", ref: "S70701" }),
      candidate({ paperPieceId: "1", ref: "C21" }),
    ],
    THRESHOLD,
  );
  assert.deepEqual(links.map((l) => l.ref), ["C21", "S70701"], "stable output order");
}

function testAPriorSectionLineNeverTakesTheSlot() {
  // A prior line has no headline, so lineageLabel renders nothing for it. It
  // used to win the one slot per piece anyway and silently discard a
  // renderable second place, so the reader saw no marker where one existed.
  const links = selectLineageLinks(
    [
      candidate({ priorRef: "S99", priorPaperPieceId: "10", priorHeadline: null, similarity: 0.95 }),
      candidate({ priorRef: "C23", priorPaperPieceId: "11", similarity: 0.84 }),
    ],
    THRESHOLD,
  );
  assert.equal(links.length, 1, "the renderable candidate must still link");
  assert.equal(links[0]!.priorRef, "C23", "an unrenderable prior must not take the slot");
}

function testAPriorWithABlankHeadlineIsAlsoSkipped() {
  const links = selectLineageLinks(
    [candidate({ priorHeadline: "   ", similarity: 0.95 })],
    THRESHOLD,
  );
  assert.equal(links.length, 0, "whitespace is not a headline");
}

function testEmptyCandidatesProduceNoLinks() {
  assert.deepEqual(selectLineageLinks([], THRESHOLD), []);
}

// --- label ---

const stubDate = (iso: string) => iso.slice(5);

function testLabelCarriesDateAndHeadline() {
  assert.equal(
    lineageLabel({ priorPublishedOn: "2026-08-27", priorHeadline: "Nvidia moves to acquire Hugging Face" }, stubDate),
    "08-27 — Nvidia moves to acquire Hugging Face",
  );
}

function testLabelIsNullForAPriorSectionLine() {
  // A prior line has no headline of its own — a pointer to a pointer.
  assert.equal(lineageLabel({ priorPublishedOn: "2026-08-27", priorHeadline: null }, stubDate), null);
  assert.equal(lineageLabel({ priorPublishedOn: "2026-08-27", priorHeadline: "   " }, stubDate), null);
}

testKeepsCandidateAtOrAboveThreshold();
testDropsCandidateBelowThreshold();
testOneLinkPerPieceAndHighestSimilarityWins();
testTieBreaksTowardTheMoreRecentPrior();
testTieBreaksDeterministicallyOnRefWhenDateAlsoTies();
testTwoPiecesMayContinueTheSamePriorPiece();
testOutputIsOrderedByTodaysRef();
testAPriorSectionLineNeverTakesTheSlot();
testAPriorWithABlankHeadlineIsAlsoSkipped();
testEmptyCandidatesProduceNoLinks();
testLabelCarriesDateAndHeadline();
testLabelIsNullForAPriorSectionLine();

console.log("lineage select tests passed");
