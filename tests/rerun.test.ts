import assert from "node:assert/strict";
import {
  parseNoveltyGrades,
  buildNoveltyUserPrompt,
} from "../src/pipeline/rerun/prompt.js";
import {
  adjustedScore,
  chunk,
  effectOf,
  groupPriors,
  mostPermissiveTier,
  withinCap,
  type GradeEffects,
} from "../src/pipeline/rerun/select.js";
import { previewRanking, type PreviewRow } from "../src/pipeline/rerun/preview.js";
import { assignTier, assignTiersWithCaps } from "../src/pipeline/editor/index.js";
import { deriveThreadScores, type ThreadCandidate } from "../src/pipeline/thread/index.js";
import { resolveTiersByMaterial, type TierCandidate, type WriterPacket } from "../src/pipeline/writers/assembler.js";
import { buildWriterUserPrompt, buildBriefBatchUserPrompt, continuationLines, newsForWriter } from "../src/pipeline/writers/prompt.js";
import { gateRerun } from "../src/pipeline/runner/gates.js";
import { loadModelConfig } from "../src/config/models.js";

// The rerun check grades how new a story is to a reader who read the paper's
// last editions. The cases below are the 2026-10-02 audit's: papers #43-52 read
// by headline, about two repeats a day, six in the top five.

const GRADES: GradeEffects = {
  minor: { penalty: 12, max_tier: "standard" },
  routine: { penalty: 20, max_tier: "brief" },
};

// --- parseNoveltyGrades ---

{
  const g = parseNoveltyGrades(
    [
      "1;;Christa Pike is in critical condition and courts have stayed further attempts.;;MINOR",
      "2;;Russian drones struck Kyiv's bridges for the first time in the war.;;DEVELOPMENT",
      "3;;Russian strikes killed two in Kyiv overnight.;;ROUTINE",
      "4;;The US and China extended their trade truce by two months.;;RERUN",
      "5;;A Bend judge issued an arrest warrant for a man held by ICE.;;NEW",
    ].join("\n"),
    5,
  );
  assert.equal(g.get(0)?.grade, "minor");
  assert.match(g.get(0)!.news!, /critical condition/);
  assert.equal(g.get(1)?.grade, "development");
  assert.equal(g.get(2)?.grade, "routine");
  assert.equal(g.get(3)?.grade, "rerun");
  assert.equal(g.get(4)?.grade, "new");
}

// Shape is forgiven: bold, lower case, the fields reversed, a missing sentence.
{
  const g = parseNoveltyGrades(
    "Grades:\n**1**;;**minor**;;She remains in hospital.\n2 ;; development\n3;;Some news;;Routine.",
    3,
  );
  assert.equal(g.get(0)?.grade, "minor");
  assert.equal(g.get(0)?.news, "She remains in hospital.");
  assert.equal(g.get(1)?.grade, "development");
  assert.equal(g.get(1)?.news, null, "a missing sentence costs the sentence, not the grade");
  assert.equal(g.get(2)?.grade, "routine");
}

// Fail open: an unknown grade, an out-of-range number or a line without the
// delimiter yields nothing -- and nothing means the row is neither reduced nor
// withheld. A news sentence that merely contains a grade word is not a grade.
{
  const g = parseNoveltyGrades(
    "1;;unsure;;MAYBE\n7;;x;;RERUN\n2 RERUN no delimiter\n3;;This is not new news at all;;",
    3,
  );
  assert.equal(g.size, 0);
}

// The first answer for a number stands: a model that revises later does not
// get to turn a keep into a withhold.
{
  const g = parseNoveltyGrades("1;;A ruling;;DEVELOPMENT\n1;;Same;;RERUN", 1);
  assert.equal(g.get(0)?.grade, "development");
}

// --- the prompt ---

{
  const p = buildNoveltyUserPrompt([
    {
      date: "2026-10-02",
      title: "Tennessee fails to execute Christa Pike",
      text: "Her lawyers said Thursday she is in critical condition.",
      printed: [
        { date: "2026-10-01", headline: "Tennessee fails to execute Christa Pike after two doses", body: "Officials gave two doses..." },
        { date: "2026-09-29", headline: "Tennessee governor denies clemency for Christa Pike", body: "" },
        { date: "2026-09-28", headline: null, body: "Pike's lawyers filed a final appeal. More text." },
      ],
    },
  ]);
  assert.match(p, /1\.\n {2}CANDIDATE \(today, 2026-10-02\): Tennessee/);
  assert.match(p, /PRINTED:\n {3}- 2026-10-01: Tennessee fails to execute Christa Pike after two doses\n {7}Officials gave two doses/);
  // A headline-only prior shows no body; a section line shows its opening as its label.
  assert.match(p, /- 2026-09-29: Tennessee governor denies clemency for Christa Pike\n {3}- 2026-09-28/);
  assert.match(p, /- 2026-09-28: \(one-line item\) Pike's lawyers filed a final appeal\./);
}

// --- what a grade does ---

{
  assert.deepEqual(effectOf("rerun", GRADES), { withhold: true, penalty: 0, maxTier: null });
  assert.deepEqual(effectOf("minor", GRADES), { withhold: false, penalty: 12, maxTier: "standard" });
  assert.deepEqual(effectOf("routine", GRADES), { withhold: false, penalty: 20, maxTier: "brief" });
  assert.deepEqual(effectOf("development", GRADES), { withhold: false, penalty: 0, maxTier: null });
  assert.deepEqual(effectOf("new", GRADES), { withhold: false, penalty: 0, maxTier: null });
  assert.deepEqual(effectOf(null, GRADES), { withhold: false, penalty: 0, maxTier: null },
    "an ungraded row -- a failed call -- is untouched: the check fails open");

  assert.equal(adjustedScore(80, 12), 68);
  assert.equal(adjustedScore(10, 20), 0, "a score never goes below zero");

  assert.equal(withinCap("feature", null), true);
  assert.equal(withinCap("feature", "standard"), false);
  assert.equal(withinCap("standard", "standard"), true);
  assert.equal(withinCap("brief", "standard"), true);
  assert.equal(withinCap("standard", "brief"), false);

  // A section runs as large as its biggest real news allows.
  assert.equal(mostPermissiveTier(["brief", "standard"]), "standard");
  assert.equal(mostPermissiveTier(["brief", null]), null, "one uncapped member uncaps the section");
  assert.equal(mostPermissiveTier([]), null);
}

// --- grouping priors for the judge ---

{
  const grouped = groupPriors(
    [
      { rowKey: "C35", similarity: 0.83, publishedOn: "2026-10-01", id: "a" },
      { rowKey: "C35", similarity: 0.79, publishedOn: "2026-09-30", id: "b" },
      { rowKey: "C35", similarity: 0.88, publishedOn: "2026-09-25", id: "c" },
      { rowKey: "S1", similarity: 0.75, publishedOn: "2026-09-29", id: "d" },
    ],
    2,
  );
  const c35 = grouped.get("C35")!;
  assert.deepEqual(c35.map((p) => p.id), ["a", "b", "c"], "newest first: what the reader has freshest");
  assert.deepEqual(c35.map((p) => p.withBody), [true, false, true], "the two closest carry their text");
  assert.equal(grouped.get("S1")!.length, 1);
}

assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepEqual(chunk([], 3), []);

// --- a section's numbers read today's news only ---

function member(ref: string, score: number, sourceCount: number, reduced = false): ThreadCandidate {
  return {
    ref,
    itemType: "cluster",
    clusterIndex: null,
    preprocessedItemId: null,
    score,
    sourceCount,
    title: ref,
    summary: "",
    ...(reduced ? { reduced: true } : {}),
  };
}

{
  // Paper #48's T4: one night's Kyiv strikes (routine, reduced to 70-20) beside
  // a genuinely new data-centre campaign. The reduced member's sources stop
  // counting; the section is as important as its best *adjusted* member.
  const { score, sourceCount } = deriveThreadScores([
    member("C19", 50, 4, true),
    member("C22", 66, 2),
  ]);
  assert.equal(score, 66);
  assert.equal(sourceCount, 2, "routine coverage is not coverage of today's news");

  const allRoutine = deriveThreadScores([member("C1", 60, 5, true), member("C2", 55, 3, true)]);
  assert.equal(allRoutine.sourceCount, 1, "a section of nothing but routine news gets no lift (ln 1 = 0)");

  // Unreduced threads are exactly what they were.
  assert.deepEqual(deriveThreadScores([member("C1", 85, 5), member("C2", 78, 12)]), { score: 85, sourceCount: 17 });
}

// --- tiers with caps ---

{
  // No caps: identical to the rank ladder.
  const plain = assignTiersWithCaps(Array(8).fill(null), 3, 3);
  assert.deepEqual(plain, Array.from({ length: 8 }, (_, i) => assignTier(i, 3, 3)));

  // A minor update at rank 2 cannot be a feature. It takes a standard slot, and
  // the feature slot it skipped goes to the next story down -- the paper keeps
  // three features. Ranks never move.
  const capped = assignTiersWithCaps([null, "standard", null, null, "brief", null, null], 3, 3);
  assert.deepEqual(capped, ["feature", "standard", "feature", "feature", "brief", "standard", "standard"]);
}

// --- the writers' material swap respects the cap ---

{
  const cand = (ref: string, rank: number, tier: string, maxTier: "standard" | "brief" | null): TierCandidate => ({
    ref,
    rank,
    tier,
    levels: new Map([
      ["feature", ref === "S1" ? "headline-only" : "full"],
      ["standard", ref === "S1" ? "headline-only" : "full"],
    ]),
    maxTier,
  });
  // S1 holds a feature slot on headline-only material. The nearest story below
  // that could fill it is a minor update capped at standard, so it must be
  // skipped for the next one.
  const { tiers } = resolveTiersByMaterial(
    [cand("S1", 3, "feature", null), cand("C2", 16, "standard", "standard"), cand("C3", 17, "standard", null)],
    ["feature", "standard"],
  );
  assert.equal(tiers.get("C2"), "standard", "a capped story is never promoted past its cap");
  assert.equal(tiers.get("C3"), "feature");
  assert.equal(tiers.get("S1"), "standard");
}

// --- the writer is told what the reader already knows ---

function packet(continuation: WriterPacket["continuation"]): WriterPacket {
  return {
    storyId: 1,
    section: null,
    rank: 2,
    tier: "standard",
    ref: "S98000",
    itemType: "singleton",
    title: "Tennessee fails to execute Christa Pike",
    summary: "",
    score: 75,
    sourceCount: 1,
    targetWords: [120, 200],
    materialLevel: "full",
    articles: [],
    omitted: [],
    notes: [],
    totalChars: 0,
    continuation,
  };
}

{
  const known = packet({
    grade: "minor",
    news: "Pike is in critical condition and an appeals court has stayed further attempts.",
    priorHeadline: "Tennessee fails to execute Christa Pike after two doses of pentobarbital",
    priorDate: "2026-10-01",
  });
  const prompt = buildWriterUserPrompt("bio", known);
  assert.match(prompt, /WHAT THE READER ALREADY KNOWS/);
  assert.match(prompt, /from 2026-10-01: "Tennessee fails to execute Christa Pike after two doses/);
  assert.match(prompt, /What is new today: Pike is in critical condition/);
  assert.match(prompt, /headline must report today's news/);
  assert.match(prompt, /this piece is short/, "a minor update is told to run short");
  // The paper's lesson, five times over: a model relays what the prompt tells it
  // about itself. The block must not hand the writer the words to do it.
  assert.doesNotMatch(continuationLines(known)!.join("\n"), /previously|this paper|we reported|earlier coverage/i);

  const development = continuationLines(packet({ ...known.continuation!, grade: "development" }))!;
  assert.ok(!development.some((l) => /this piece is short/.test(l)), "a development keeps its full size");

  assert.equal(continuationLines(packet(null)), null);
  assert.doesNotMatch(buildWriterUserPrompt("bio", packet(null)), /ALREADY KNOWS/);

  const batch = buildBriefBatchUserPrompt("bio", [known]);
  assert.match(batch, /Note: The reader already knows "Tennessee fails to execute Christa Pike after two doses of pentobarbital" \(2026-10-01\)\. New today: Pike is in critical condition/);
}

// --- the judge's sentence never brings the paper's coverage to the writer ---
// Real sentences from the novelty preview over papers #43-53.

{
  assert.equal(
    newsForWriter("An independent review found that Charlie Kirk's aides insisted he speak outdoors, adding detail to yesterday's report on security failures before his death"),
    "An independent review found that Charlie Kirk's aides insisted he speak outdoors.",
  );
  assert.equal(
    newsForWriter("Four complaints have now been filed with the Oregon Secretary of State over Portland Police Chief Bob Day's political activity, up from two previously reported."),
    "Four complaints have now been filed with the Oregon Secretary of State over Portland Police Chief Bob Day's political activity.",
  );
  assert.equal(
    newsForWriter("An Idealista spokesperson criticized Spain's new rental laws, saying they will not add housing supply; the decree itself was already reported on September 29."),
    "An Idealista spokesperson criticized Spain's new rental laws, saying they will not add housing supply.",
  );
  assert.equal(
    newsForWriter("Meta's Muse chatbot creates detailed profiles of users' friends and family, raising new privacy concerns beyond the filesystem exposure previously reported"),
    "Meta's Muse chatbot creates detailed profiles of users' friends and family.",
  );
  // No clean clause to cut at: the whole sentence goes, and the writer leads
  // on the known headline alone.
  assert.equal(
    newsForWriter("A Durban house party shooting that killed 11 people is reported alongside the tavern shootings already covered"),
    null,
  );
  // Near-misses that must survive: "already" about the world, not the coverage.
  const ok = "An analysis finds total claims to the UN fund already exceed pledges by three to one";
  assert.equal(newsForWriter(ok), ok);
  const ok2 = "Tennessee Gov. Bill Lee halted all remaining executions for the rest of the year after Christa Pike survived two doses of pentobarbital.";
  assert.equal(newsForWriter(ok2), ok2);
  assert.equal(newsForWriter(null), null);

  const prompt = buildWriterUserPrompt("bio", packet({
    grade: "minor",
    news: "Oregon doctors urged prevention measures as flu activity began rising, adding detail to the previous day's call for vaccinations",
    priorHeadline: "Oregon health officials urge vaccinations ahead of expected severe respiratory season",
    priorDate: "2026-10-01",
  }));
  assert.match(prompt, /What is new today: Oregon doctors urged prevention measures as flu activity began rising\.\n/);
  assert.doesNotMatch(prompt, /previous day's/);
}

// --- the preview re-ranks a day the way the pipeline would ---

{
  const row = (key: string, score: number, sourceCount = 1): PreviewRow => ({ key, title: key, score, sourceCount });
  const rows = [row("S1", 90), row("S2", 85), row("S3", 80), row("C4", 70, 4), row("S5", 60), row("C6", 75, 3), row("C7", 72, 2)];
  const threads = [{ key: "T0", title: "war", members: [row("C6", 75, 3), row("C7", 72, 2)] }];
  const cfg = { pileTarget: 10, sourceWeight: 9, featureCount: 2, standardCount: 2 };

  const before = previewRanking(rows, threads, new Map(), cfg);
  // T0 = 75 + 9·ln(5) = 89.5, C4 = 70 + 9·ln(4) = 82.5: the editor's formula.
  assert.deepEqual(before.map((s) => s.key), ["S1", "T0", "S2", "C4", "S3", "S5"]);
  assert.deepEqual(before.map((s) => s.tier), ["feature", "feature", "standard", "standard", "brief", "brief"]);

  const after = previewRanking(
    rows,
    threads,
    new Map([
      ["S1", effectOf("rerun", GRADES)],
      ["C6", effectOf("routine", GRADES)],
      ["C7", effectOf("routine", GRADES)],
      ["S2", effectOf("minor", GRADES)],
    ]),
    cfg,
  );
  assert.ok(!after.some((s) => s.key === "S1"), "a rerun is withheld");
  const t0 = after.find((s) => s.key === "T0")!;
  assert.equal(t0.score, 55);
  assert.equal(t0.sourceCount, 1, "an all-routine section loses its lift");
  assert.equal(t0.maxTier, "brief");
  assert.equal(t0.tier, "brief");
  const s2 = after.find((s) => s.key === "S2")!;
  assert.equal(s2.score, 73);
  assert.notEqual(s2.tier, "feature", "a minor update is capped below feature");
}

// --- gate ---

{
  const cfg = loadModelConfig().pipeline.gates.rerun;
  assert.equal(gateRerun({ candidatesIn: 250, rowsDropped: 6, failedCalls: 0 }, cfg).verdict, "ok",
    "about six a day is the audited rate, and is the check working, not news");
  assert.equal(gateRerun({ candidatesIn: 250, rowsDropped: 6, failedCalls: 1 }, cfg).verdict, "warn");
  assert.equal(gateRerun({ candidatesIn: 250, rowsDropped: 90, failedCalls: 0 }, cfg).verdict, "warn",
    "a judge dropping a third of the paper is the failure a reader cannot see");
  assert.equal(gateRerun({ candidatesIn: 0, rowsDropped: 0, failedCalls: 0 }, cfg).verdict, "ok");
}

// --- config ---

{
  const cfg = loadModelConfig().rerun;
  assert.equal(cfg.candidate_floor, loadModelConfig().publisher.lineage.candidate_floor,
    "the rerun floor matches lineage's: a pair lineage links as 'previously' must be one this check saw");
  assert.ok(cfg.grades.routine.penalty >= cfg.grades.minor.penalty, "routine is reduced at least as much as minor");
}

console.log("rerun tests passed");
