import assert from "node:assert/strict";
import {
  assembleSectionPackets,
  type ResolvedText,
} from "../src/pipeline/writers/assembler.js";
import { applyPaperBudget } from "../src/pipeline/writers/packets.js";
import {
  buildWriterUserPrompt,
  buildWriterSystemPrompt,
  buildBriefBatchUserPrompt,
} from "../src/pipeline/writers/prompt.js";
import { FailureBreaker, partitionByCallShape } from "../src/pipeline/writers/index.js";
import type {
  StoryMaterials,
  StoryMember,
  StoryArticle,
} from "../src/pipeline/writers/materials.js";
import type { WritersPacketConfig } from "../src/config/models.js";

// Run #3's T1 carried twelve members into one 500-word slot. Told to find a
// spine, the writer kept one and dropped eleven — including a story scoring 81,
// while the paper ran a 35-word brief on one scoring 56. A thread is a section
// now: a lead, sidebars, and a line for every remaining member.

const CFG: WritersPacketConfig = {
  section: { max_sidebars: 3 },
  min_dedup_paragraph_chars: 120,
  min_article_chars: 60,
  headline_only_words: [25, 60],
  tiers: {
    feature: {
      max_articles: 12,
      total_chars: 48000,
      per_article_chars: 6000,
      floor_chars: 800,
      target_words: [400, 600],
      thin_material_chars: 3000,
      full_material_chars: 12000,
    },
    standard: {
      max_articles: 6,
      total_chars: 12000,
      per_article_chars: 3000,
      floor_chars: 500,
      target_words: [120, 200],
      thin_material_chars: 900,
      full_material_chars: 3000,
    },
    brief: {
      max_articles: 3,
      total_chars: 2500,
      per_article_chars: 1200,
      floor_chars: 400,
      target_words: [25, 45],
      thin_material_chars: 300,
      full_material_chars: 900,
    },
    line: {
      max_articles: 1,
      total_chars: 900,
      per_article_chars: 900,
      floor_chars: 300,
      target_words: [15, 30],
      thin_material_chars: 200,
      full_material_chars: 600,
    },
  },
};

function article(id: number, memberRef: string): StoryArticle {
  const body = `Article ${id} reports something specific. `.padEnd(1200, "y").slice(0, 1200);
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
    publishedAt: new Date("2026-08-13T12:00:00Z"),
    alsoAppearedIn: [],
    feedText: body,
    feedTextChars: body.length,
  };
}

function member(ref: string, title: string, score: number, articleCount = 2): StoryMember {
  const base = ref.startsWith("C") ? Number(ref.slice(1)) * 100 : Number(ref.slice(1));
  return {
    ref,
    itemType: ref.startsWith("C") ? "cluster" : "singleton",
    clusterIndex: ref.startsWith("C") ? Number(ref.slice(1)) : null,
    title,
    summary: `Summary of ${title}`,
    score,
    sourceCount: articleCount,
    articles: Array.from({ length: articleCount }, (_, i) => article(base + i, ref)),
  };
}

/** T1's real shape, trimmed to six members. */
function threadStory(members: StoryMember[], tier = "feature"): StoryMaterials {
  return {
    storyId: 1,
    rank: 1,
    tier: tier as StoryMaterials["tier"],
    ref: "T1",
    itemType: "thread",
    threadId: 1,
    title: "Trump administration escalates immigration crackdown",
    summary: "A machine-generated label for the whole situation.",
    score: 83,
    sourceCount: 18,
    members,
    articles: members.flatMap((m) => m.articles),
    unresolved: [],
  };
}

const T1_MEMBERS = [
  member("S52849", "No minority is safe from the deportation machine", 83),
  member("S53537", "U.S. investigated left-leaning groups during Minnesota crackdown", 81),
  member("S53334", "Third person dies at New Jersey immigration detention center", 80),
  member("C33", "Controversial group awarded $158M contract for migrant children", 77),
  member("C28", "ICE plans to equip officers with electric shock gloves", 75),
  member("S53457", "Portland officials fund opposition to Newport ICE facility", 61),
];

// --- the split ---

function testEveryMemberBecomesAPiece() {
  // The whole point: nothing a thread absorbed disappears.
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  assert.equal(packets.length, 6);
  assert.deepEqual(
    packets.map((p) => p.ref),
    T1_MEMBERS.map((m) => m.ref),
  );
  // The Oregon item that vanished from run #3 is in the paper.
  assert.ok(packets.some((p) => p.ref === "S53457"));
}

function testRolesFollowMemberOrder() {
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  assert.deepEqual(
    packets.map((p) => p.section!.role),
    ["lead", "sidebar", "sidebar", "sidebar", "line", "line"],
  );
  assert.deepEqual(
    packets.map((p) => p.section!.rank),
    [0, 1, 2, 3, 4, 5],
  );
}

function testSidebarsRunOneTierBelowTheLead() {
  const feature = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  assert.equal(feature[0]!.tier, "feature");
  assert.equal(feature[1]!.tier, "standard");
  assert.equal(feature[4]!.tier, "brief");

  const standard = assembleSectionPackets(threadStory(T1_MEMBERS, "standard"), new Map(), CFG);
  assert.equal(standard[0]!.tier, "standard");
  assert.equal(standard[1]!.tier, "brief");
}

function testLinesGetTheirOwnWordTarget() {
  // A well-sourced lead so the headline-only ceiling does not apply to it: the
  // point here is the line's target, not the cap.
  const members = [member("S52849", T1_MEMBERS[0]!.title, 83, 12), ...T1_MEMBERS.slice(1)];
  const packets = assembleSectionPackets(threadStory(members), new Map(), CFG);
  assert.deepEqual(packets[0]!.targetWords, [400, 600]);
  assert.deepEqual(packets[4]!.targetWords, [15, 30]);
}

function testLinesGetTheirOwnMaterialBudget() {
  // Run #8's lines came back at 40-47 words because they were budgeted as
  // briefs: three sources and 2,500 characters is enough raw material for a
  // second and third sentence, whatever the word target says. A line now gets
  // one source and 900 characters, so the material for a second sentence is
  // simply not there.
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const line = packets[4]!;
  assert.equal(line.section!.role, "line");
  assert.equal(line.articles.length, 1, "a line gets one source");
  assert.ok(line.totalChars <= 900, `line budget ${line.totalChars} exceeds 900`);

  // The sidebar beside it, one tier down, still gets a brief's material.
  const sidebar = packets[3]!;
  assert.equal(sidebar.section!.role, "sidebar");
  assert.ok(sidebar.articles.length > 1, "a sidebar still gets more than one source");
}

function testEachPieceCarriesOnlyItsOwnMembersMaterial() {
  // This is what makes coordination unnecessary: two pieces of a section cannot
  // draw on the same article, so they cannot overlap.
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const seen = new Set<number>();
  for (const packet of packets) {
    for (const a of packet.articles) {
      assert.ok(!seen.has(a.preprocessedItemId), `article ${a.preprocessedItemId} in two pieces`);
      seen.add(a.preprocessedItemId);
      assert.equal(a.memberRef, packet.ref);
    }
  }
}

function testSectionIdentityIsTheThreadNotTheMember() {
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  for (const packet of packets) {
    assert.equal(packet.section!.ref, "T1");
    assert.equal(packet.section!.title, "Trump administration escalates immigration crackdown");
    // All pieces of a section belong to one ranked story.
    assert.equal(packet.storyId, 1);
    assert.equal(packet.rank, 1);
  }
}

function testAOneMemberThreadIsAnOrdinaryStory() {
  const packets = assembleSectionPackets(threadStory([T1_MEMBERS[0]!]), new Map(), CFG);
  assert.equal(packets.length, 1);
  assert.equal(packets[0]!.section, null);
}

function testFetchedTextReachesSectionPieces() {
  const texts = new Map<number, ResolvedText>([
    [5337, { text: "z".repeat(5000), origin: "fetched" }],
  ]);
  const members = [
    member("S52849", "Lead development", 83),
    { ...member("S53537", "Sidebar development", 81), articles: [article(5337, "S53537")] },
  ];
  const packets = assembleSectionPackets(threadStory(members), texts, CFG);
  assert.equal(packets[1]!.articles[0]!.origin, "fetched");
}

// --- prompts ---

function testTheLeadIsToldWhatRunsBelowIt() {
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const prompt = buildWriterUserPrompt("bio", packets[0]!);
  assert.ok(prompt.includes("IN THIS SECTION"));
  assert.ok(prompt.includes("leads a section"));
  // The three sidebars, and not the lines.
  assert.ok(prompt.includes("U.S. investigated left-leaning groups during Minnesota crackdown"));
  assert.ok(prompt.includes("electric shock gloves") === false);
  assert.ok(/Do not retell those/.test(prompt));
  // The thread-wide "find a spine" instruction is gone: the piece is one member.
  assert.ok(!prompt.includes("several related events"));
}

function testASidebarIsToldWhatTheLeadCovers() {
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const prompt = buildWriterUserPrompt("bio", packets[1]!);
  assert.ok(prompt.includes("runs inside the section"));
  assert.ok(prompt.includes("No minority is safe from the deportation machine"));
  assert.ok(/do not recap the lead/i.test(prompt));
}

function testALineIsToldToWriteOneSentence() {
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const prompt = buildWriterUserPrompt("bio", packets[5]!);
  assert.ok(/A single sentence inside the section/.test(prompt));
  assert.ok(prompt.includes("15–30 words"));
}

function testLinesAndBriefsNeverShareACall() {
  // One call, one register. Run #8 batched a section line beside ordinary
  // briefs and the model wrote briefs for both.
  const section = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const standalone = { ...section[0]!, tier: "brief", section: null };
  const { longform, briefs, lines } = partitionByCallShape(
    [...section, standalone].map((packet) => ({ packet })),
  );

  assert.deepEqual(
    lines.map((p) => p.packet.section!.role),
    ["line", "line"],
  );
  assert.equal(briefs.length, 1, "only the standalone brief batches as a brief");
  assert.equal(briefs[0]!.packet.section, null);
  // A sidebar one tier below a feature is standard, so longform is the lead
  // plus all three sidebars.
  assert.equal(longform.length, 4);
  assert.ok(longform.every((p) => p.packet.section?.role !== "line"));
}

function testTheLineBatchAsksForOneSentence() {
  const section = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const lines = section.filter((p) => p.section?.role === "line");

  const linePrompt = buildBriefBatchUserPrompt("bio", lines, "line");
  assert.ok(/SECTION LINES TO WRITE/.test(linePrompt));
  assert.ok(/One sentence — not two, and not a compressed brief/.test(linePrompt));

  const briefPrompt = buildBriefBatchUserPrompt("bio", lines, "brief");
  assert.ok(/BRIEFS TO WRITE/.test(briefPrompt));
  assert.ok(!/SECTION LINES/.test(briefPrompt));
}

// --- the paper stays the size the editor said ---

function packetAt(rank: number, sectionRef: string | null = null) {
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const base = packets[0]!;
  return {
    ...base,
    rank,
    section: sectionRef === null ? null : base.section,
  };
}

function testOverflowDisplacesTheLowestRankedStandalonePieces() {
  const packets = [
    packetAt(1, "T1"),
    packetAt(2, "T1"),
    packetAt(3),
    packetAt(4),
    packetAt(5),
  ];
  const budgeted = applyPaperBudget(packets, 3);
  assert.equal(budgeted.length, 3);
  // Both section pieces survive; ranks 4 and 5 are gone.
  assert.deepEqual(
    budgeted.map((p) => p.rank),
    [1, 2, 3],
  );
}

function testSectionPiecesAreNeverDisplaced() {
  const packets = [packetAt(1, "T1"), packetAt(2, "T1"), packetAt(3, "T1"), packetAt(4)];
  const budgeted = applyPaperBudget(packets, 2);
  // Only the standalone piece can go, and one standalone always survives, so the
  // paper runs long rather than losing a section.
  assert.equal(budgeted.length, 4);
  assert.equal(budgeted.filter((p) => p.section !== null).length, 3);
}

function testAPaperUnderBudgetIsUntouched() {
  const packets = [packetAt(1), packetAt(2)];
  assert.equal(applyPaperBudget(packets, 10).length, 2);
}

// --- the provider giving up ---

function testTheBreakerTripsOnConsecutiveFailures() {
  // Run #4: 103 logical calls became 807 provider attempts, 775 of them errors,
  // over 31 minutes. Nothing about the hundredth request was going to succeed.
  const breaker = new FailureBreaker(3);
  breaker.record(false);
  breaker.record(false);
  assert.equal(breaker.isOpen, false);
  breaker.record(false);
  assert.equal(breaker.isOpen, true);
}

function testOneSuccessResetsTheRun() {
  // One hard piece among successes is a piece problem, not an outage.
  const breaker = new FailureBreaker(3);
  breaker.record(false);
  breaker.record(false);
  breaker.record(true);
  breaker.record(false);
  breaker.record(false);
  assert.equal(breaker.isOpen, false);
  assert.equal(breaker.consecutiveFailures, 2);
}

function testTheBreakerStaysOpenOnceTripped() {
  const breaker = new FailureBreaker(2);
  breaker.record(false);
  breaker.record(false);
  breaker.record(true);
  assert.equal(breaker.isOpen, true);
}

function testABreakerThresholdOfZeroIsDisabled() {
  const breaker = new FailureBreaker(0);
  for (let i = 0; i < 50; i++) breaker.record(false);
  assert.equal(breaker.isOpen, false);
}

function testSuperlativesNeedASource() {
  // The sentence the reviewer finally quoted: "the increases in APIDA arrests
  // outpaced every other group" against sources supporting "among the largest".
  const prompt = buildWriterSystemPrompt("voice");
  assert.ok(/Comparatives and superlatives are measurements/.test(prompt));
  assert.ok(/outpaced every other/.test(prompt));
}

testTheBreakerTripsOnConsecutiveFailures();
testOneSuccessResetsTheRun();
testTheBreakerStaysOpenOnceTripped();
testABreakerThresholdOfZeroIsDisabled();
testSuperlativesNeedASource();
testEveryMemberBecomesAPiece();
testRolesFollowMemberOrder();
testSidebarsRunOneTierBelowTheLead();
testLinesGetTheirOwnWordTarget();
testLinesGetTheirOwnMaterialBudget();
testEachPieceCarriesOnlyItsOwnMembersMaterial();
testSectionIdentityIsTheThreadNotTheMember();
testAOneMemberThreadIsAnOrdinaryStory();
testFetchedTextReachesSectionPieces();
testTheLeadIsToldWhatRunsBelowIt();
testASidebarIsToldWhatTheLeadCovers();
testALineIsToldToWriteOneSentence();
testLinesAndBriefsNeverShareACall();
testTheLineBatchAsksForOneSentence();
testOverflowDisplacesTheLowestRankedStandalonePieces();
testSectionPiecesAreNeverDisplaced();
testAPaperUnderBudgetIsUntouched();
console.log("writer sections tests passed");
