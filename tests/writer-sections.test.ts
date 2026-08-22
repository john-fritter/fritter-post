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

/** A member whose only article is a teaser — below every tier's thin floor. */
function thinMember(ref: string, title: string, score: number): StoryMember {
  const teaser = "Short teaser. ".padEnd(150, "y").slice(0, 150);
  const base = Number(ref.slice(1));
  return {
    ...member(ref, title, score, 1),
    articles: [{ ...article(base, ref), feedText: teaser, feedTextChars: teaser.length }],
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

function testALineStillSeesAllItsMembersSources() {
  // Run #8's lines came back at 40-47 words against a 15-30 target, and the fix
  // then was to cut a line's material to one source and 900 characters. That
  // fix is reverted: a piece being short is not a reason to under-inform its
  // writer, and the same run also introduced a separate line-register batch
  // call, so which of the two actually worked was never established. The
  // governor is the word target and the register instruction; the material is
  // whatever the member has.
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const line = packets[4]!;
  assert.equal(line.section!.role, "line");
  assert.deepEqual(line.targetWords, [15, 30], "still asked for one sentence");
  assert.equal(line.articles.length, line.sourceCount, "and still shown every source");
  assert.equal(line.omitted.length, 0);
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
  const fetched = packets.find((p) => p.ref === "S53537")!;
  assert.equal(fetched.articles[0]!.origin, "fetched");
}

function testAMemberWithNothingToSayCannotLead() {
  // Run #13's Gaza section led with a 47-word headline-only piece while a
  // 180-word fully-sourced one ran underneath it as a sidebar. The lead
  // establishes the situation the rest of the section hangs off, and a headline
  // cannot do that. Score still decides the thread's rank; it no longer decides
  // this on its own.
  const texts = new Map<number, ResolvedText>([
    [5337, { text: "z".repeat(20000), origin: "fetched" }],
  ]);
  const members = [
    thinMember("S52849", "Top scorer, headline only", 83),
    { ...member("S53537", "Lower scorer, real material", 81), articles: [article(5337, "S53537")] },
  ];
  const packets = assembleSectionPackets(threadStory(members), texts, CFG);

  assert.equal(packets[0]!.ref, "S53537", "the member with material leads");
  assert.equal(packets[0]!.section!.role, "lead");
  assert.notEqual(packets[0]!.materialLevel, "headline-only");
  assert.equal(packets[1]!.ref, "S52849", "the top scorer still runs, below");
}

function testWhenNoMemberHasMaterialScoreOrderStands() {
  // A section that is thin all the way down is thin; nothing here invents a
  // lead. It just must not reorder for no reason.
  const members = [
    thinMember("S52849", "First", 83),
    thinMember("S53537", "Second", 81),
  ];
  const packets = assembleSectionPackets(threadStory(members), new Map(), CFG);
  assert.equal(packets[0]!.ref, "S52849");
  assert.equal(packets[0]!.section!.role, "lead");
}

function testAMemberWithNothingToSayGetsALineNotASidebar() {
  // A line is a pointer and a headline is enough for one. A sidebar is a
  // paragraph, and an empty paragraph-shaped slot is an invitation to fill it:
  // run #13 filled two with prose about the sources and one with an asserted
  // development the packet did not contain.
  const texts = new Map<number, ResolvedText>([
    [5284, { text: "z".repeat(20000), origin: "fetched" }],
    [5333, { text: "z".repeat(20000), origin: "fetched" }],
  ]);
  const members = [
    { ...member("S52849", "Lead", 83), articles: [article(5284, "S52849")] },
    { ...member("S53334", "Real sidebar", 80), articles: [article(5333, "S53334")] },
    thinMember("S53537", "Nothing to say", 81),
  ];
  const packets = assembleSectionPackets(threadStory(members), texts, CFG);
  const byRef = new Map(packets.map((p) => [p.ref, p]));

  assert.equal(byRef.get("S52849")!.section!.role, "lead");
  assert.equal(byRef.get("S53334")!.section!.role, "sidebar");
  assert.equal(byRef.get("S53537")!.section!.role, "line", "a headline gets a line");
  assert.deepEqual(byRef.get("S53537")!.targetWords, [15, 30]);

  // Demoting it must not cost the section a sidebar slot it could have used.
  assert.equal(packets.filter((p) => p.section!.role === "sidebar").length, 1);
  // The lead is told about both — sidebars first, then lines. Run #20's lead was
  // told only about sidebars and wrote up two members that had lines below it.
  assert.deepEqual(byRef.get("S52849")!.section!.siblingTitles, [
    "Real sidebar",
    "Nothing to say",
  ]);
}

function testEveryPieceKnowsWhatTheOthersCover() {
  // The lead sees everything below it; a sidebar or line sees the lead plus the
  // others, minus itself. Nothing in a section should be invisible to the piece
  // most likely to write it up by accident.
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const titles = T1_MEMBERS.map((m) => m.title);
  const lead = packets[0]!;

  assert.equal(lead.section!.role, "lead");
  assert.equal(lead.section!.siblingTitles.length, T1_MEMBERS.length - 1);
  assert.ok(!lead.section!.siblingTitles.includes(lead.title));
  for (const t of titles.filter((t) => t !== lead.title)) {
    assert.ok(lead.section!.siblingTitles.includes(t), `lead not told about "${t}"`);
  }

  for (const packet of packets.slice(1)) {
    const siblings = packet.section!.siblingTitles;
    assert.equal(siblings[0], lead.title, "every piece is told what leads");
    assert.ok(!siblings.includes(packet.title), "and never about itself");
    assert.equal(new Set(siblings).size, siblings.length, "no repeats");
  }
}

// --- prompts ---

function testTheLeadIsToldWhatRunsBelowIt() {
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  const prompt = buildWriterUserPrompt("bio", packets[0]!);
  assert.ok(prompt.includes("IN THIS SECTION"));
  assert.ok(prompt.includes("leads a section"));
  // Sidebars *and* lines. Run #20's lead was told only about its sidebars and
  // wrote full paragraphs on two members that had lines below it.
  assert.ok(prompt.includes("U.S. investigated left-leaning groups during Minnesota crackdown"));
  assert.ok(prompt.includes("electric shock gloves"), "the lead must know about the lines too");
  assert.ok(/leave those to them/.test(prompt));
  // And it is warned that its own source may cover them anyway.
  assert.ok(/live blog or a wrap-up/.test(prompt));
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

function testABriefTierSidebarIsBudgetedAsASidebar() {
  // A sidebar under a standard lead lands on `brief` by the tier ladder. Run
  // #10's four such sidebars all wrote 48-53 words against a brief's 25-45 —
  // the parameter was wrong, not the writing.
  const packets = assembleSectionPackets(threadStory(T1_MEMBERS, "standard"), new Map(), CFG);
  const sidebar = packets[1]!;
  assert.equal(sidebar.section!.role, "sidebar");
  assert.equal(sidebar.tier, "brief", "still published as a brief");
  assert.deepEqual(sidebar.targetWords, [45, 70], "but budgeted as a sidebar");
  assert.ok(sidebar.totalChars <= 3500);

  // A sidebar under a feature lead is standard-tier and unaffected.
  const underFeature = assembleSectionPackets(threadStory(T1_MEMBERS), new Map(), CFG);
  assert.equal(underFeature[1]!.tier, "standard");
  assert.deepEqual(underFeature[1]!.targetWords, [120, 200]);
}

function testASidebarIsNeverBatched() {
  // Only buildWriterUserPrompt renders the section instruction, so a batched
  // sidebar is written with no idea it belongs to a section — and the batch
  // prompt tells it the items around it are unrelated. Run #10's T4 sent three
  // sidebars through the brief batch and got three unrelated briefs under a
  // heading, the exact failure sections exist to prevent.
  const section = assembleSectionPackets(threadStory(T1_MEMBERS, "standard"), new Map(), CFG);
  const standalone = { ...section[0]!, tier: "brief", section: null };
  const { longform, briefs, lines } = partitionByCallShape(
    [...section, standalone].map((packet) => ({ packet })),
  );

  assert.equal(briefs.length, 1, "only the standalone brief batches");
  assert.equal(briefs[0]!.packet.section, null);
  assert.ok(
    longform.every((p) => p.packet.section?.role !== "line"),
    "no line reached the individual-call pool",
  );
  const sidebars = longform.filter((p) => p.packet.section?.role === "sidebar");
  assert.equal(sidebars.length, 3, "all three sidebars get their own call");
  assert.ok(sidebars.every((p) => p.packet.tier === "brief"), "even at brief tier");
  assert.equal(lines.length, 2);

  // And the instruction they were being denied is present on that path.
  const prompt = buildWriterUserPrompt("bio", sidebars[0]!.packet);
  assert.ok(/IN THIS SECTION/.test(prompt));
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
testALineStillSeesAllItsMembersSources();
testEachPieceCarriesOnlyItsOwnMembersMaterial();
testSectionIdentityIsTheThreadNotTheMember();
testAOneMemberThreadIsAnOrdinaryStory();
testFetchedTextReachesSectionPieces();
testAMemberWithNothingToSayCannotLead();
testWhenNoMemberHasMaterialScoreOrderStands();
testAMemberWithNothingToSayGetsALineNotASidebar();
testEveryPieceKnowsWhatTheOthersCover();
testTheLeadIsToldWhatRunsBelowIt();
testASidebarIsToldWhatTheLeadCovers();
testALineIsToldToWriteOneSentence();
testLinesAndBriefsNeverShareACall();
testTheLineBatchAsksForOneSentence();
testABriefTierSidebarIsBudgetedAsASidebar();
testASidebarIsNeverBatched();
testOverflowDisplacesTheLowestRankedStandalonePieces();
testSectionPiecesAreNeverDisplaced();
testAPaperUnderBudgetIsUntouched();
console.log("writer sections tests passed");
