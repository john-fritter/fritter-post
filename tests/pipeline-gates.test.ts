import assert from "node:assert/strict";
import {
  evaluate,
  fraction,
  gateCollector,
  gateFetch,
  gateEditor,
  gateGrouping,
  gateGroupingPass1,
  gatePrefilter,
  gatePreprocessor,
  gatePublisher,
  gateThread,
  gateWriters,
} from "../src/pipeline/runner/gates.js";
import { loadModelConfig } from "../src/config/models.js";

// The gates are tested against the REAL thresholds from config/models.yaml, not
// against fixtures. The policy is the config; a test that invents its own
// numbers would pass while production published an empty paper.
const GATES = loadModelConfig().pipeline.gates;

// --- evaluate / fraction ---

function testEvaluateTakesMostSevere() {
  const r = evaluate([
    { when: true, verdict: "warn", reason: "a" },
    { when: true, verdict: "abort", reason: "b" },
    { when: false, verdict: "abort", reason: "never" },
  ]);
  assert.equal(r.verdict, "abort");
  // Both firing reasons are carried, not only the decisive one: the warning is
  // often the actual cause of the abort below it.
  assert.deepEqual(r.reasons, ["a", "b"]);
}

function testEvaluateWithNothingFiring() {
  const r = evaluate([{ when: false, verdict: "abort", reason: "x" }]);
  assert.equal(r.verdict, "ok");
  assert.deepEqual(r.reasons, []);
}

function testFractionOfNothingIsZero() {
  // An empty whole reads as 0, not NaN and not 1: a stage with nothing in it
  // had nothing go wrong, and the count checks catch the empty case directly.
  assert.equal(fraction(0, 0), 0);
  assert.equal(fraction(5, 0), 0);
  assert.equal(fraction(1, 4), 0.25);
}

// --- collector ---

function testCollectorHealthyRunPasses() {
  const r = gateCollector(
    { sourcesAttempted: 111, sourcesSucceeded: 111, itemsFetched: 900, itemsInserted: 400 },
    GATES.collector,
  );
  assert.equal(r.verdict, "ok");
}

function testCollectorIsSilentAboutTheSteadyState() {
  // Run #1, the real one: 2 of 111 failed and the paper was flawless — 150/150
  // written, 0 unsourced. The gate used to warn on any failure at all, which
  // made that run 'degraded' and would have made every run degraded. A status
  // that is always on is not a status.
  const r = gateCollector(
    { sourcesAttempted: 111, sourcesSucceeded: 109, itemsFetched: 2791, itemsInserted: 1043 },
    GATES.collector,
  );
  assert.equal(r.verdict, "ok");
}

function testCollectorWarnsOnAStepChange() {
  // Ten of 111 is not the usual couple of dead feeds.
  const r = gateCollector(
    { sourcesAttempted: 111, sourcesSucceeded: 101, itemsFetched: 2400, itemsInserted: 900 },
    GATES.collector,
  );
  assert.equal(r.verdict, "warn");
  assert.match(r.reasons.join(" "), /more than the usual couple/);
}

function testCollectorAbortsWhenMostFeedsFail() {
  // Not a feed problem: DNS, egress, or the proxy.
  const r = gateCollector(
    { sourcesAttempted: 111, sourcesSucceeded: 20, itemsFetched: 40, itemsInserted: 12 },
    GATES.collector,
  );
  assert.equal(r.verdict, "abort");
}

function testCollectorAbortsOnNothingNew() {
  const r = gateCollector(
    { sourcesAttempted: 111, sourcesSucceeded: 111, itemsFetched: 900, itemsInserted: 0 },
    GATES.collector,
  );
  assert.equal(r.verdict, "abort");
  assert.match(r.reasons.join(" "), /run on yesterday/);
}

// --- preprocessor ---

function testPreprocessorAbortsOnEmptyWindow() {
  const r = gatePreprocessor({ rawItemsConsidered: 0, itemsKept: 0 }, GATES.preprocessor);
  assert.equal(r.verdict, "abort");
}

function testPreprocessorAbortsWhenCrossRunDedupTookEverything() {
  // The expected shape of a same-day re-run, and still an abort: there is no
  // paper in an empty kept set. The reason says so, since this is the one an
  // operator will hit by hand.
  const r = gatePreprocessor({ rawItemsConsidered: 800, itemsKept: 0 }, GATES.preprocessor);
  assert.equal(r.verdict, "abort");
  assert.match(r.reasons.join(" "), /cross-run dedup/);
}

// --- prefilter ---

function testPrefilterNormalCutRatePasses() {
  const r = gatePrefilter({ itemsIn: 1200, itemsKept: 686, itemsCut: 514 }, GATES.prefilter);
  assert.equal(r.verdict, "ok");
}

function testPrefilterAbortsWhenItShreds() {
  // A relevance floor does not cut 99%. The bio or the prompt did not load.
  const r = gatePrefilter({ itemsIn: 1200, itemsKept: 12, itemsCut: 1188 }, GATES.prefilter);
  assert.equal(r.verdict, "abort");
}

// --- grouping ---

function testGroupingCleanRunPasses() {
  const r = gateGrouping(
    {
      clusterCount: 90,
      singletonCount: 400,
      attachUnrecovered: 0,
      attachFailedCalls: 0,
      splitFailedCalls: 0,
      resplitFailedCalls: 0,
    },
    GATES.grouping,
  );
  assert.equal(r.verdict, "ok");
}

function testGroupingWarnsOnUnrecoveredAttach() {
  // Migration 039's whole point: the run must not be used to tune
  // similarity_threshold, and nothing else would say so.
  const r = gateGrouping(
    {
      clusterCount: 90,
      singletonCount: 400,
      attachUnrecovered: 1,
      attachFailedCalls: 25,
      splitFailedCalls: 0,
      resplitFailedCalls: 0,
    },
    GATES.grouping,
  );
  assert.equal(r.verdict, "warn");
  assert.match(r.reasons.join(" "), /similarity_threshold/);
}

function testGroupingSeparatesFailedCallsFromLostWork() {
  // Run #56's shape: failed calls that the straggler re-ask recovered. Costs
  // money and time, costs no grouping — so it says the opposite thing.
  const r = gateGrouping(
    {
      clusterCount: 90,
      singletonCount: 400,
      attachUnrecovered: 0,
      attachFailedCalls: 24,
      splitFailedCalls: 0,
      resplitFailedCalls: 0,
    },
    GATES.grouping,
  );
  assert.equal(r.verdict, "warn");
  assert.match(r.reasons.join(" "), /not lost work/);
}

function testGroupingNullCountersDoNotFireWarnings() {
  // NULL means "not recorded" (a run before the migration), which is not zero
  // and is not evidence of a defect either.
  const r = gateGrouping(
    {
      clusterCount: 90,
      singletonCount: 400,
      attachUnrecovered: null,
      attachFailedCalls: null,
      splitFailedCalls: null,
      resplitFailedCalls: null,
    },
    GATES.grouping,
  );
  assert.equal(r.verdict, "ok");
}

function testGroupingAbortsOnNoRows() {
  const r = gateGrouping(
    {
      clusterCount: 0,
      singletonCount: 0,
      attachUnrecovered: 0,
      attachFailedCalls: 0,
      splitFailedCalls: 0,
      resplitFailedCalls: 0,
    },
    GATES.grouping,
  );
  assert.equal(r.verdict, "abort");
}

// --- grouping-pass-1 ---

function testPass1CleanRunPasses() {
  const r = gateGroupingPass1({ itemsIn: 490, unscored: 0, pileItems: 150 }, GATES.grouping_pass1);
  assert.equal(r.verdict, "ok");
}

function testPass1WarnsOnASingleUnscoredRow() {
  // Run #39's batch 7 of 8 parsed 39 of 40, so one item competed unjudged
  // inside an otherwise clean run. One row is worth a line.
  const r = gateGroupingPass1({ itemsIn: 490, unscored: 1, pileItems: 150 }, GATES.grouping_pass1);
  assert.equal(r.verdict, "warn");
  assert.match(r.reasons.join(" "), /scores 0/);
}

function testPass1AbortsWhenProviderWasDown() {
  const r = gateGroupingPass1({ itemsIn: 490, unscored: 470, pileItems: 150 }, GATES.grouping_pass1);
  assert.equal(r.verdict, "abort");
  assert.match(r.reasons.join(" "), /noise/);
}

function testPass1AbortsOnEmptyPile() {
  const r = gateGroupingPass1({ itemsIn: 490, unscored: 0, pileItems: 0 }, GATES.grouping_pass1);
  assert.equal(r.verdict, "abort");
}

// --- thread ---

function testThreadZeroThreadsIsNotAFailure() {
  // Most items belong to no thread; that is the expected answer.
  const r = gateThread({ candidatesIn: 220, threadsFormed: 0, failedCalls: 0 }, GATES.thread);
  assert.equal(r.verdict, "ok");
}

function testThreadWarnsOnALostCall() {
  // Run #50: one broken stream, zero threads, three wildfire rows in the top ten.
  const r = gateThread({ candidatesIn: 220, threadsFormed: 0, failedCalls: 1 }, GATES.thread);
  assert.equal(r.verdict, "warn");
}

// --- editor ---

function testEditorCleanRunPasses() {
  const r = gateEditor(
    {
      itemsIn: 150,
      itemsFeature: 15,
      itemsStandard: 60,
      itemsBrief: 75,
      tieBreakCalls: 25,
      tieBreakFailedCalls: 0,
    },
    GATES.editor,
  );
  assert.equal(r.verdict, "ok");
}

function testEditorWarnsOnTieBreakFailures() {
  // Run #125: 12 of 25 groups lost to one 429 each, ranked by ref order —
  // alphabetical, at the boundary deciding feature versus standard.
  const r = gateEditor(
    {
      itemsIn: 150,
      itemsFeature: 15,
      itemsStandard: 60,
      itemsBrief: 75,
      tieBreakCalls: 25,
      tieBreakFailedCalls: 12,
    },
    GATES.editor,
  );
  assert.equal(r.verdict, "warn");
  assert.match(r.reasons.join(" "), /alphabetical/);
}

function testEditorNullTieBreakCountersAreSilent() {
  const r = gateEditor(
    {
      itemsIn: 150,
      itemsFeature: 15,
      itemsStandard: 60,
      itemsBrief: 75,
      tieBreakCalls: null,
      tieBreakFailedCalls: null,
    },
    GATES.editor,
  );
  assert.equal(r.verdict, "ok");
}

// --- writers: the gate that decides whether a paper exists ---

function testWritersCompleteRunPasses() {
  const r = gateWriters(
    { piecesIn: 150, piecesWritten: 150, piecesFailed: 0, failedCalls: 0, repairAttempts: 0 },
    GATES.writers,
  );
  assert.equal(r.verdict, "ok");
}

function testWritersThreeHolesPublishesDegraded() {
  // Run #3 finished 147 of 150. That is a paper.
  const r = gateWriters(
    { piecesIn: 150, piecesWritten: 147, piecesFailed: 3, failedCalls: 3, repairAttempts: 1 },
    GATES.writers,
  );
  assert.equal(r.verdict, "warn");
  assert.match(r.reasons.join(" "), /after 1 repair pass/);
}

function testWritersTrippedBreakerAborts() {
  // The failure a `write && publish` shell chain would publish: the breaker
  // tripped, runWriters returned normally, and the process exited 0.
  const r = gateWriters(
    { piecesIn: 150, piecesWritten: 12, piecesFailed: 138, failedCalls: 138, repairAttempts: 1 },
    GATES.writers,
  );
  assert.equal(r.verdict, "abort");
  assert.match(r.reasons.join(" "), /--repair/);
}

function testWritersFloorBoundaryIsInclusive() {
  // Exactly at the floor publishes. Below it does not.
  const atFloor = Math.ceil(150 * GATES.writers.min_written_fraction);
  assert.notEqual(
    gateWriters(
      {
        piecesIn: 150,
        piecesWritten: atFloor,
        piecesFailed: 150 - atFloor,
        failedCalls: 0,
        repairAttempts: 0,
      },
      GATES.writers,
    ).verdict,
    "abort",
  );
  assert.equal(
    gateWriters(
      {
        piecesIn: 150,
        piecesWritten: atFloor - 2,
        piecesFailed: 150 - atFloor + 2,
        failedCalls: 0,
        repairAttempts: 0,
      },
      GATES.writers,
    ).verdict,
    "abort",
  );
}

function testWritersNoPacketsAborts() {
  const r = gateWriters(
    { piecesIn: 0, piecesWritten: 0, piecesFailed: 0, failedCalls: 0, repairAttempts: 0 },
    GATES.writers,
  );
  assert.equal(r.verdict, "abort");
}

// --- fetch-text: the standing-condition-versus-event distinction ---

function testFetchIsSilentAboutStandingCooldown() {
  // Run #1's five: nytimes.com and oregonlive.com have served a DataDome check
  // for months and are tracked in open-items. True, and not news.
  const r = gateFetch(
    {
      requested: 148,
      ok: 129,
      thin: 14,
      newlyCooledHosts: [],
      cooldownHosts: [
        "npr.org",
        "oregonlive.com",
        "thediplomat.com",
        "nytimes.com",
        "insideclimatenews.org",
      ],
    },
    GATES.fetch,
  );
  assert.equal(r.verdict, "ok");
}

function testFetchWarnsOnAHostThatJustStoppedAnswering() {
  // An outlet we were reading yesterday and are not reading today.
  const r = gateFetch(
    {
      requested: 148,
      ok: 120,
      thin: 10,
      newlyCooledHosts: ["reuters.com"],
      cooldownHosts: ["nytimes.com", "reuters.com"],
    },
    GATES.fetch,
  );
  assert.equal(r.verdict, "warn");
  assert.match(r.reasons.join(" "), /reuters\.com/);
  assert.match(r.reasons.join(" "), /newly in cooldown/);
}

function testFetchWarnsWhenNothingUsableCameBack() {
  const r = gateFetch(
    { requested: 148, ok: 0, thin: 0, newlyCooledHosts: [], cooldownHosts: [] },
    GATES.fetch,
  );
  assert.equal(r.verdict, "warn");
  assert.match(r.reasons.join(" "), /none yielded usable text/);
}

function testFetchThatRequestedNothingIsSilent() {
  // Every story's feed body cleared the floor. Not a failure.
  const r = gateFetch(
    { requested: 0, ok: 0, thin: 0, newlyCooledHosts: [], cooldownHosts: [] },
    GATES.fetch,
  );
  assert.equal(r.verdict, "ok");
}

// --- publisher ---

function testPublisherCleanPaperPasses() {
  const r = gatePublisher(
    { pieceCount: 150, piecesSkipped: 0, piecesUnsourced: 0 },
    GATES.publisher,
  );
  assert.equal(r.verdict, "ok");
}

function testPublisherWarnsOnUnsourcedPieces() {
  // Never an abort: the paper is written by the time this is known. Never
  // silent either — a piece the reader cannot follow to anyone's reporting is
  // the one thing the paper promises.
  const r = gatePublisher(
    { pieceCount: 150, piecesSkipped: 0, piecesUnsourced: 40 },
    GATES.publisher,
  );
  assert.equal(r.verdict, "warn");
}

function testPublisherAbortsOnEmptyPaper() {
  const r = gatePublisher({ pieceCount: 0, piecesSkipped: 150, piecesUnsourced: 0 }, GATES.publisher);
  assert.equal(r.verdict, "abort");
}

// --- run #1, replayed ---

/**
 * The whole of production run #1 (2026-08-30), metrics verbatim from
 * pipeline_stage_runs, asserted to pass every gate without a warning.
 *
 * That run published paper #4: 150 of 150 pieces written, 0 failed, 0 skipped,
 * 0 unsourced, 0 empty bodies, 267 source links. By every measure the pipeline
 * records it was a clean paper, and the runner called it 'degraded' — on two
 * standing conditions that would have fired every night forever. This is the
 * test that stops that coming back, and it is the reason the thresholds are
 * what they are.
 */
function testRunOneIsNotDegraded() {
  const verdicts = [
    gateCollector(
      { sourcesAttempted: 111, sourcesSucceeded: 109, itemsFetched: 2791, itemsInserted: 1043 },
      GATES.collector,
    ),
    gatePreprocessor({ rawItemsConsidered: 1039, itemsKept: 1009 }, GATES.preprocessor),
    gatePrefilter({ itemsIn: 950, itemsKept: 604, itemsCut: 346 }, GATES.prefilter),
    gateGrouping(
      {
        clusterCount: 48,
        singletonCount: 277,
        attachUnrecovered: 0,
        attachFailedCalls: 0,
        splitFailedCalls: 0,
        resplitFailedCalls: 0,
      },
      GATES.grouping,
    ),
    gateGroupingPass1({ itemsIn: 325, unscored: 0, pileItems: 150 }, GATES.grouping_pass1),
    gateThread({ candidatesIn: 220, threadsFormed: 9, failedCalls: 0 }, GATES.thread),
    gateEditor(
      {
        itemsIn: 150,
        itemsFeature: 15,
        itemsStandard: 60,
        itemsBrief: 75,
        tieBreakCalls: 30,
        tieBreakFailedCalls: 0,
      },
      GATES.editor,
    ),
    gateFetch(
      {
        requested: 148,
        ok: 129,
        thin: 14,
        // Nothing entered cooldown that run; all five were already there.
        newlyCooledHosts: [],
        cooldownHosts: [
          "npr.org",
          "oregonlive.com",
          "thediplomat.com",
          "nytimes.com",
          "insideclimatenews.org",
        ],
      },
      GATES.fetch,
    ),
    gateWriters(
      { piecesIn: 150, piecesWritten: 150, piecesFailed: 0, failedCalls: 0, repairAttempts: 0 },
      GATES.writers,
    ),
    gatePublisher({ pieceCount: 150, piecesSkipped: 0, piecesUnsourced: 0 }, GATES.publisher),
  ];

  const noisy = verdicts.filter((v) => v.verdict !== "ok");
  assert.deepEqual(
    noisy.flatMap((v) => v.reasons),
    [],
    "run #1 published a clean paper and must not be recorded degraded",
  );
}

testRunOneIsNotDegraded();
testEvaluateTakesMostSevere();
testEvaluateWithNothingFiring();
testFractionOfNothingIsZero();
testCollectorHealthyRunPasses();
testCollectorIsSilentAboutTheSteadyState();
testCollectorWarnsOnAStepChange();
testCollectorAbortsWhenMostFeedsFail();
testCollectorAbortsOnNothingNew();
testPreprocessorAbortsOnEmptyWindow();
testPreprocessorAbortsWhenCrossRunDedupTookEverything();
testPrefilterNormalCutRatePasses();
testPrefilterAbortsWhenItShreds();
testGroupingCleanRunPasses();
testGroupingWarnsOnUnrecoveredAttach();
testGroupingSeparatesFailedCallsFromLostWork();
testGroupingNullCountersDoNotFireWarnings();
testGroupingAbortsOnNoRows();
testPass1CleanRunPasses();
testPass1WarnsOnASingleUnscoredRow();
testPass1AbortsWhenProviderWasDown();
testPass1AbortsOnEmptyPile();
testThreadZeroThreadsIsNotAFailure();
testThreadWarnsOnALostCall();
testEditorCleanRunPasses();
testEditorWarnsOnTieBreakFailures();
testEditorNullTieBreakCountersAreSilent();
testWritersCompleteRunPasses();
testWritersThreeHolesPublishesDegraded();
testWritersTrippedBreakerAborts();
testWritersFloorBoundaryIsInclusive();
testWritersNoPacketsAborts();
testFetchIsSilentAboutStandingCooldown();
testFetchWarnsOnAHostThatJustStoppedAnswering();
testFetchWarnsWhenNothingUsableCameBack();
testFetchThatRequestedNothingIsSilent();
testPublisherCleanPaperPasses();
testPublisherWarnsOnUnsourcedPieces();
testPublisherAbortsOnEmptyPaper();
console.log("pipeline gate tests passed");
