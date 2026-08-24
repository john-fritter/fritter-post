import assert from "node:assert/strict";
import {
  materialLevelAtTier,
  resolveTiersByMaterial,
  type MaterialLevel,
  type TierCandidate,
} from "../src/pipeline/writers/assembler.js";
import type {
  StoryMaterials,
  StoryMember,
  StoryArticle,
} from "../src/pipeline/writers/materials.js";
import type { WritersPacketConfig } from "../src/config/models.js";

// Run #42 published 37 of its 150 pieces on headline-only material, three of
// them features. Rank 7 ran one sentence and then, under a horizontal rule, a
// note to the operator: "That's all the source carries." Rank 18 was 24 words
// ending "the New York Times reports". Neither was a writing failure — both were
// writers obeying a headline-only packet inside a slot that promised four
// hundred words. The editor tiers by rank alone and cannot see whether any text
// exists behind a story; this is the correction.

const CFG: WritersPacketConfig = {
  section: { max_sidebars: 3 },
  min_dedup_paragraph_chars: 120,
  min_article_chars: 60,
  headline_only_words: [25, 60],
  tiers_requiring_material: ["feature", "standard"],
  tiers: {
    feature: {
      max_articles: null,
      total_chars: null,
      per_article_chars: 6000,
      floor_chars: 800,
      target_words: [400, 600],
      thin_material_chars: 3000,
      full_material_chars: 12000,
    },
    standard: {
      max_articles: null,
      total_chars: null,
      per_article_chars: 3000,
      floor_chars: 500,
      target_words: [120, 200],
      thin_material_chars: 900,
      full_material_chars: 3000,
    },
    brief: {
      max_articles: null,
      total_chars: null,
      per_article_chars: 1200,
      floor_chars: 400,
      target_words: [25, 45],
      thin_material_chars: 300,
      full_material_chars: 900,
    },
    sidebar: {
      max_articles: null,
      total_chars: null,
      per_article_chars: 2000,
      floor_chars: 600,
      target_words: [45, 70],
      thin_material_chars: 400,
      full_material_chars: 1200,
    },
    line: {
      max_articles: null,
      total_chars: null,
      per_article_chars: 900,
      floor_chars: 300,
      target_words: [15, 30],
      thin_material_chars: 200,
      full_material_chars: 600,
    },
  },
};

const LADDER = ["feature", "standard"];

// --- the resolver, over plain data ---

function candidate(
  ref: string,
  rank: number,
  tier: string,
  levels: Partial<Record<string, MaterialLevel>>,
): TierCandidate {
  return {
    ref,
    rank,
    tier,
    levels: new Map(Object.entries(levels) as [string, MaterialLevel][]),
  };
}

/** Run #42's shape in miniature: a stub on the front page, real material below. */
function runFortyTwo(): TierCandidate[] {
  return [
    candidate("C30", 2, "feature", { feature: "full", standard: "full" }),
    // Rank 7's OregonLive story: a headline and nothing else, at either tier.
    candidate("S61342", 7, "feature", { feature: "headline-only", standard: "headline-only" }),
    candidate("S61392", 16, "standard", { feature: "partial", standard: "full" }),
    candidate("S60940", 17, "standard", { feature: "partial", standard: "full" }),
    candidate("S61332", 62, "standard", { feature: "headline-only", standard: "headline-only" }),
    candidate("S60977", 76, "brief", { feature: "partial", standard: "full" }),
  ];
}

function testAStubCannotHoldAFeatureSlot() {
  const { tiers } = resolveTiersByMaterial(runFortyTwo(), LADDER);
  assert.notEqual(tiers.get("S61342"), "feature");
}

function testTheSlotGoesToTheNearestStoryThatCanFillIt() {
  // Rank 16 and rank 17 can both hold a feature. The nearer one takes it, so the
  // promotion reaches as short a distance down the ranking as it can.
  const { tiers } = resolveTiersByMaterial(runFortyTwo(), LADDER);
  assert.equal(tiers.get("S61392"), "feature");
  assert.equal(tiers.get("S60940"), "standard");
}

function testTierCountsAreUnchanged() {
  // The paper keeps its shape: a day the local outlets block us still has the
  // same number of features, not three fewer.
  const before = runFortyTwo();
  const { tiers } = resolveTiersByMaterial(before, LADDER);
  const count = (source: Iterable<string>) => {
    const out = new Map<string, number>();
    for (const tier of source) out.set(tier, (out.get(tier) ?? 0) + 1);
    return out;
  };
  assert.deepEqual(count(tiers.values()), count(before.map((c) => c.tier)));
}

function testASwapIsRecordedForTheAudit() {
  const { swaps } = resolveTiersByMaterial(runFortyTwo(), LADDER);
  const feature = swaps.find((s) => s.tier === "feature");
  assert.ok(feature);
  assert.equal(feature.ref, "S61342");
  assert.equal(feature.rank, 7);
  assert.equal(feature.takerRef, "S61392");
  assert.equal(feature.takerRank, 16);
  assert.equal(feature.takerFrom, "standard");
  assert.equal(feature.demotedTo, "standard");
}

function testAStubDemotedOutOfFeatureIsReconsideredAtStandard() {
  // S61342 has no material at either tier. Landing in standard must not park it
  // in a second slot it cannot fill; the top-down pass catches it again and it
  // ends up a brief, two tiers below where the editor's rank put it.
  const { tiers, swaps } = resolveTiersByMaterial(runFortyTwo(), LADDER);
  assert.equal(tiers.get("S61342"), "brief");
  assert.deepEqual(
    swaps.filter((s) => s.ref === "S61342").map((s) => `${s.tier}->${s.demotedTo}`),
    ["feature->standard", "standard->brief"],
  );
}

function testTheSpareMaterialRunsOutBeforeTheStubsDo() {
  // runFortyTwo() has one brief with material and two headline-only standards
  // (S61342 arrives from the feature pass, S61332 was already there). The first
  // takes the spare; the second has nothing left to trade with and keeps its
  // slot. Its packet ceiling still holds the piece to a headline's worth.
  const { tiers } = resolveTiersByMaterial(runFortyTwo(), LADDER);
  assert.equal(tiers.get("S60977"), "standard");
  assert.equal(tiers.get("S61332"), "standard");
}

function testEveryStubIsPlacedWhenThereIsMaterialForAllOfThem() {
  const candidates = [
    ...runFortyTwo(),
    candidate("S61742", 84, "brief", { feature: "partial", standard: "full" }),
  ];
  const { tiers } = resolveTiersByMaterial(candidates, LADDER);
  assert.equal(tiers.get("S61342"), "brief");
  assert.equal(tiers.get("S61332"), "brief");
  assert.equal(tiers.get("S60977"), "standard");
  assert.equal(tiers.get("S61742"), "standard");
}

function testABriefMayBeHeadlineOnly() {
  // A brief is a pointer and a headline is enough for one. `brief` is off the
  // ladder, so nothing moves a headline-only brief.
  const candidates = [
    candidate("C30", 1, "feature", { feature: "full", standard: "full" }),
    candidate("S99", 80, "brief", { feature: "headline-only", standard: "headline-only" }),
  ];
  const { tiers, swaps } = resolveTiersByMaterial(candidates, LADDER);
  assert.equal(tiers.get("S99"), "brief");
  assert.deepEqual(swaps, []);
}

function testAStoryIsNeverPromotedIntoASlotItCannotFillEither() {
  // The only story below the hole is headline-only at feature too. Promoting it
  // would move the problem, not fix it.
  const candidates = [
    candidate("S1", 3, "feature", { feature: "headline-only", standard: "full" }),
    candidate("S2", 20, "standard", { feature: "headline-only", standard: "full" }),
  ];
  const { tiers, swaps } = resolveTiersByMaterial(candidates, LADDER);
  assert.equal(tiers.get("S1"), "feature");
  assert.equal(tiers.get("S2"), "standard");
  assert.deepEqual(swaps, []);
}

function testADayWithNoMaterialAnywhereLeavesTheSlotsAlone() {
  // Nothing below has material either. The packet's own ceiling still keeps each
  // piece short and honest; shuffling stubs between stubs buys nothing.
  const candidates = [
    candidate("S1", 1, "feature", { feature: "headline-only", standard: "headline-only" }),
    candidate("S2", 2, "feature", { feature: "headline-only", standard: "headline-only" }),
    candidate("S3", 3, "standard", { feature: "headline-only", standard: "headline-only" }),
  ];
  const { tiers, swaps } = resolveTiersByMaterial(candidates, LADDER);
  assert.deepEqual([...tiers.values()], ["feature", "feature", "standard"]);
  assert.deepEqual(swaps, []);
}

function testAnEmptyLadderDisablesTheRule() {
  const before = runFortyTwo();
  const { tiers, swaps } = resolveTiersByMaterial(before, []);
  assert.deepEqual([...tiers.values()], before.map((c) => c.tier));
  assert.deepEqual(swaps, []);
}

function testRanksAreNeverTouched() {
  // Only the treatment moves. A story can sit high in the ranking and run short,
  // which is the honest outcome when a story matters and the text is not there.
  const before = runFortyTwo();
  const { swaps } = resolveTiersByMaterial(before, LADDER);
  assert.ok(swaps.length > 0);
  assert.deepEqual(
    before.map((c) => [c.ref, c.rank]),
    runFortyTwo().map((c) => [c.ref, c.rank]),
  );
}

function testEveryStoryKeepsExactlyOneTier() {
  const before = runFortyTwo();
  const { tiers } = resolveTiersByMaterial(before, LADDER);
  assert.equal(tiers.size, before.length);
  for (const c of before) assert.ok(tiers.has(c.ref));
}

// --- material level, read at a tier the story does not hold ---

function article(id: number, memberRef: string, chars: number): StoryArticle {
  const body = `Article ${id} reports something specific about the day. `
    .padEnd(chars, "y")
    .slice(0, chars);
  return {
    preprocessedItemId: id,
    memberRef,
    sourceName: `Source ${id}`,
    parentSource: `Source ${id}`,
    sourceType: "journalism",
    title: `Title ${id}`,
    originalTitle: `Title ${id}`,
    translationFailed: false,
    canonicalUrl: `https://example.com/${id}`,
    originalUrl: `https://example.com/${id}`,
    publishedAt: new Date("2026-08-24T12:00:00Z"),
    alsoAppearedIn: [],
    feedText: body,
    feedTextChars: body.length,
  };
}

function singleton(ref: string, tier: string, chars: number): StoryMaterials {
  return {
    storyId: 1,
    rank: 7,
    tier: tier as StoryMaterials["tier"],
    ref,
    itemType: "singleton",
    threadId: null,
    title: "Portland area leaders are dismantling a third of the shelter system",
    summary: "",
    score: 84,
    sourceCount: 1,
    members: [],
    articles: [article(1, ref, chars)],
    unresolved: [],
  };
}

function testMaterialLevelIsReadAtTheTierAsked() {
  // The same 1,500 characters: not enough for a feature, plenty for a standard.
  // This is what makes a demotion mean something rather than relabel a stub.
  const story = singleton("S61342", "feature", 1500);
  assert.equal(materialLevelAtTier(story, new Map(), CFG, "feature"), "headline-only");
  assert.equal(materialLevelAtTier(story, new Map(), CFG, "standard"), "partial");
  assert.equal(materialLevelAtTier(story, new Map(), CFG, "brief"), "full");
}

function testAskingDoesNotMutateTheStory() {
  const story = singleton("S61342", "feature", 1500);
  materialLevelAtTier(story, new Map(), CFG, "brief");
  assert.equal(story.tier, "feature");
}

function testAHeadlineIsHeadlineOnlyAtEveryTier() {
  const story = singleton("S61618", "standard", 140);
  for (const tier of ["feature", "standard", "brief"]) {
    assert.equal(materialLevelAtTier(story, new Map(), CFG, tier), "headline-only");
  }
}

function member(ref: string, score: number, chars: number): StoryMember {
  const base = Number(ref.slice(1));
  return {
    ref,
    itemType: "singleton",
    clusterIndex: null,
    title: `Member ${ref} title`,
    summary: `Summary of ${ref}`,
    score,
    sourceCount: 1,
    articles: [article(base, ref, chars)],
  };
}

function thread(members: StoryMember[], tier: string): StoryMaterials {
  return {
    storyId: 2,
    rank: 1,
    tier: tier as StoryMaterials["tier"],
    ref: "T0",
    itemType: "thread",
    threadId: 1,
    title: "Oregon's record 2026 wildfire season strains response",
    summary: "A machine-generated label for the whole situation.",
    score: 88,
    sourceCount: 4,
    members,
    articles: members.flatMap((m) => m.articles),
    unresolved: [],
  };
}

function testAThreadIsJudgedOnItsSectionLead() {
  // A thread holds its slot with its lead, and the section rule has already put
  // the best-sourced member there — so the top scorer having nothing does not
  // make the thread a stub.
  const story = thread([member("S1", 88, 150), member("S2", 80, 20000)], "feature");
  assert.equal(materialLevelAtTier(story, new Map(), CFG, "feature"), "full");
}

function testAThreadWithNothingBehindAnyMemberIsAStub() {
  const story = thread([member("S1", 88, 150), member("S2", 80, 150)], "feature");
  assert.equal(materialLevelAtTier(story, new Map(), CFG, "feature"), "headline-only");
}

testAStubCannotHoldAFeatureSlot();
testTheSlotGoesToTheNearestStoryThatCanFillIt();
testTierCountsAreUnchanged();
testASwapIsRecordedForTheAudit();
testAStubDemotedOutOfFeatureIsReconsideredAtStandard();
testTheSpareMaterialRunsOutBeforeTheStubsDo();
testEveryStubIsPlacedWhenThereIsMaterialForAllOfThem();
testABriefMayBeHeadlineOnly();
testAStoryIsNeverPromotedIntoASlotItCannotFillEither();
testADayWithNoMaterialAnywhereLeavesTheSlotsAlone();
testAnEmptyLadderDisablesTheRule();
testRanksAreNeverTouched();
testEveryStoryKeepsExactlyOneTier();
testMaterialLevelIsReadAtTheTierAsked();
testAskingDoesNotMutateTheStory();
testAHeadlineIsHeadlineOnlyAtEveryTier();
testAThreadIsJudgedOnItsSectionLead();
testAThreadWithNothingBehindAnyMemberIsAStub();
console.log("writer tier material tests passed");
