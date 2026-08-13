import assert from "node:assert/strict";
import {
  assembleWriterPacket,
  selectArticles,
  dedupeParagraphs,
  allocateBudget,
  trimToBoundary,
  normalizeParagraph,
  type ResolvedText,
} from "../src/pipeline/writers/assembler.js";
import {
  buildWriterUserPrompt,
  buildWriterSystemPrompt,
  parseWriterOutput,
} from "../src/pipeline/writers/prompt.js";
import type { StoryMaterials, StoryArticle } from "../src/pipeline/writers/materials.js";
import type { WritersPacketConfig } from "../src/config/models.js";

// The shapes here are run #112's: T3 carried 27 articles across 12 members, T1
// carried 18 across 12, and 9 articles in the paper came from hosts that blocked
// every request — so a packet has to survive both too much material and none.

const CFG: WritersPacketConfig = {
  min_dedup_paragraph_chars: 120,
  min_article_chars: 60,
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
  },
};

function article(
  id: number,
  opts: Partial<StoryArticle> & { chars?: number } = {},
): StoryArticle {
  const chars = opts.chars ?? 500;
  const { chars: _drop, ...rest } = opts;
  // Distinct text per article, exact length. Identical bodies would be caught by
  // the paragraph dedup — correctly, but it would make every fixture a
  // syndication test by accident.
  const body = `Article ${id} body. `.padEnd(chars, "y").slice(0, chars);
  return {
    preprocessedItemId: id,
    memberRef: `S${id}`,
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
    ...rest,
  };
}

function story(tier: string, articles: StoryArticle[]): StoryMaterials {
  return {
    rank: 3,
    tier: tier as StoryMaterials["tier"],
    ref: "T3",
    itemType: "thread",
    threadId: 3,
    title: "Ukraine strikes Russian grain terminals as war grinds on",
    summary: "A summary from the describe pass.",
    score: 76,
    sourceCount: 27,
    members: [],
    articles,
    unresolved: [],
  };
}

// --- selection ---

function testOneArticlePerOutletBeforeSeconds() {
  // Run #112's T3 had 27 articles; several from the same outlet. The writer
  // wants the range of sources first.
  const articles = [
    article(1, { parentSource: "Guardian" }),
    article(2, { parentSource: "Guardian" }),
    article(3, { parentSource: "Meduza" }),
    article(4, { parentSource: "BBC" }),
  ];
  const { selected } = selectArticles(articles, 3);
  assert.deepEqual(
    selected.map((a) => a.preprocessedItemId),
    [1, 3, 4],
  );
}

function testSecondsFillRemainingSlotsInOrder() {
  const articles = [
    article(1, { parentSource: "Guardian" }),
    article(2, { parentSource: "Guardian" }),
    article(3, { parentSource: "Meduza" }),
  ];
  const { selected, omitted } = selectArticles(articles, 3);
  assert.deepEqual(
    selected.map((a) => a.preprocessedItemId),
    [1, 3, 2],
  );
  assert.equal(omitted.length, 0);
}

function testArticlesBeyondTheCapAreRecordedNotLost() {
  const articles = Array.from({ length: 27 }, (_, i) => article(i + 1));
  const { selected, omitted } = selectArticles(articles, 12);
  assert.equal(selected.length, 12);
  assert.equal(omitted.length, 15);
  assert.match(omitted[0]!.reason, /12-article cap/);
}

// --- paragraph dedup ---

function testVerbatimParagraphsAcrossSourcesAreDroppedOnce() {
  // Syndication: three outlets running the same AP paragraph under their own
  // ledes. The first keeps it; the rest do not repeat it.
  const wire = "The agency said the man died in custody on Wednesday morning. ".repeat(4);
  const { texts, dropped } = dedupeParagraphs(
    [`Guardian lede.\n\n${wire}`, `BBC lede.\n\n${wire}`, `PBS lede.\n\n${wire}`],
    120,
  );
  assert.ok(texts[0]!.includes("died in custody"));
  assert.ok(!texts[1]!.includes("died in custody"));
  assert.ok(texts[1]!.includes("BBC lede"));
  assert.deepEqual(dropped, [0, 1, 1]);
}

function testShortParagraphsAreExemptFromDedup() {
  // A dateline or a one-line attribution repeating is not the redundancy this
  // removes, and cutting it would reshape a lede.
  const { texts, dropped } = dedupeParagraphs(["PORTLAND, Ore.", "PORTLAND, Ore."], 120);
  assert.equal(texts[1], "PORTLAND, Ore.");
  assert.deepEqual(dropped, [0, 0]);
}

function testDedupIgnoresWhitespaceAndCase() {
  const para = "A ".repeat(80) + "sentence about the fire.";
  const { dropped } = dedupeParagraphs([para, `  ${para.toUpperCase()}  `], 120);
  assert.deepEqual(dropped, [0, 1]);
  assert.equal(normalizeParagraph("  Two   words \n"), "two words");
}

// --- budget ---

function testEveryArticleGetsItsFloorBeforeAnyGetsMore() {
  // The 12-member thread case: three long articles could eat the whole budget,
  // and then nine members would be invisible to the writer.
  const lengths = Array.from({ length: 12 }, () => 20000);
  const allocations = allocateBudget(lengths, CFG.tiers.feature);
  assert.ok(allocations.every((a) => a >= 800));
  assert.equal(
    allocations.reduce((a, b) => a + b, 0),
    48000,
  );
}

function testShortArticlesDoNotHoardBudget() {
  const allocations = allocateBudget([100, 100, 30000], CFG.tiers.feature);
  assert.deepEqual(allocations.slice(0, 2), [100, 100]);
  assert.equal(allocations[2], 6000); // per_article_chars ceiling
}

function testAllocationNeverExceedsAvailableText() {
  const allocations = allocateBudget([300, 450], CFG.tiers.standard);
  assert.deepEqual(allocations, [300, 450]);
}

function testTrimLandsOnAParagraphBoundary() {
  const text = "First paragraph here.\n\nSecond paragraph that runs past the cap and keeps going.";
  const trimmed = trimToBoundary(text, 40);
  assert.equal(trimmed, "First paragraph here.");
}

function testTrimFallsBackToASentenceEnd() {
  const text = "One sentence ends here. And a second sentence continues well past the cap.";
  const trimmed = trimToBoundary(text, 40);
  assert.ok(trimmed.endsWith("."));
  assert.ok(trimmed.length <= 40);
}

function testTrimLeavesShortTextAlone() {
  assert.equal(trimToBoundary("short", 100), "short");
}

// --- whole packets ---

function testFetchedTextIsPreferredButNeverShorterThanTheFeed() {
  const texts = new Map<number, ResolvedText>([
    [1, { text: "z".repeat(4000), origin: "fetched" }],
    // A thin extraction that came back shorter than the teaser: the teaser wins.
    [2, { text: "z".repeat(50), origin: "fetched" }],
  ]);
  const packet = assembleWriterPacket(
    story("standard", [article(1, { chars: 200 }), article(2, { chars: 600 })]),
    texts,
    CFG,
  );
  assert.equal(packet.articles[0]!.origin, "fetched");
  assert.equal(packet.articles[1]!.origin, "feed");
  assert.equal(packet.articles[1]!.chars, 600);
}

function testBlockedSourcesProduceAHeadlineOnlyPacketThatSaysSo() {
  // The nytimes.com / oregonlive.com case: nothing fetched, teasers only.
  const packet = assembleWriterPacket(
    story("standard", [article(1, { chars: 120 }), article(2, { chars: 150 })]),
    new Map(),
    CFG,
  );
  assert.equal(packet.materialLevel, "headline-only");
  assert.ok(packet.notes.some((n) => /headline-level/i.test(n)));
  // It still has the material it has — degraded, not empty.
  assert.equal(packet.articles.length, 2);
}

function testFullMaterialCarriesNoWarning() {
  // Feature tier wants 12,000 characters before it calls material full — a
  // 400–600 word piece with room for a second and third source.
  const texts = new Map<number, ResolvedText>([
    [1, { text: "z".repeat(14000), origin: "fetched" }],
  ]);
  const packet = assembleWriterPacket(story("feature", [article(1, { chars: 200 })]), texts, CFG);
  assert.equal(packet.materialLevel, "full");
  assert.deepEqual(packet.notes, []);
}

function testPacketKeepsTheEditorsSourceCountNotTheArticleCount() {
  // The editor ranked T3 on 27 sources; the packet holds 12. The writer must be
  // told the real prominence, not the budget's shadow of it.
  const articles = Array.from({ length: 27 }, (_, i) => article(i + 1, { chars: 300 }));
  const packet = assembleWriterPacket(story("feature", articles), new Map(), CFG);
  assert.equal(packet.sourceCount, 27);
  assert.equal(packet.articles.length, 12);
  assert.equal(packet.omitted.length, 15);
}

function testHeadlineEchoStubsAreLeftOut() {
  // The Google News stub from run #112 rank 3, next to a short but real summary.
  const stub = article(1, {
    title: "Poland says it thwarted a Russian plot to kill an American citizen in Warsaw - apnews.com",
    feedText:
      "Poland says it thwarted a Russian plot to kill an American citizen in Warsaw  apnews.com",
    feedTextChars: 87,
  });
  const real = article(2, {
    title: "Ukraine attacks key Russian grain terminal on Black Sea port",
    feedText:
      "Ukraine has damaged Russia’s grain export terminals in an attack on the Novorossiysk port.",
    feedTextChars: 89,
  });
  const packet = assembleWriterPacket(story("feature", [stub, real]), new Map(), CFG);
  assert.deepEqual(
    packet.articles.map((a) => a.preprocessedItemId),
    [2],
  );
  assert.match(packet.omitted[0]!.reason, /repeats the headline/);
}

function testAPacketIsNeverEmptied() {
  // Every source a stub: the best one stays rather than handing a writer nothing.
  const stub = article(1, {
    title: "Something happened somewhere today",
    feedText: "Something happened somewhere today",
    feedTextChars: 34,
  });
  const packet = assembleWriterPacket(story("brief", [stub]), new Map(), CFG);
  assert.equal(packet.articles.length, 1);
  assert.equal(packet.materialLevel, "headline-only");
}

function testPublisherFurnitureNeverReachesThePacket() {
  const body = [
    "A bomb attack in Crimea killed a former Ukrainian submarine commander.",
    "The-CNN-Wire",
    "\u2122 & \u00a9 2026 Cable News Network, Inc., a Warner Bros. Discovery Company. All rights reserved.",
    "The post Crimea bomb attack reportedly kills former commander appeared first on KTVZ.",
  ].join("\n\n");
  const withDebris = article(1, { feedText: body, feedTextChars: body.length });
  const packet = assembleWriterPacket(story("standard", [withDebris]), new Map(), CFG);
  assert.ok(packet.articles[0]!.text.includes("submarine commander"));
  assert.ok(!/CNN-Wire|All rights reserved|appeared first on/.test(packet.articles[0]!.text));
  assert.equal(packet.articles[0]!.boilerplateParagraphs, 3);
}

function testMaterialLevelIsJudgedPerTier() {
  // The Guardian standard story from run #112: ~1,000 characters of teaser is
  // thin for a feature and adequate for a 120–200 word standard piece.
  const guardian = article(1, { chars: 1000 });
  const asStandard = assembleWriterPacket(story("standard", [guardian]), new Map(), CFG);
  const asFeature = assembleWriterPacket(story("feature", [guardian]), new Map(), CFG);
  assert.equal(asStandard.materialLevel, "partial");
  assert.equal(asFeature.materialLevel, "headline-only");
}

function testUntranslatedSourceIsFlaggedToTheWriter() {
  const packet = assembleWriterPacket(
    story("standard", [article(1, { chars: 600, translationFailed: true })]),
    new Map(),
    CFG,
  );
  assert.ok(packet.notes.some((n) => /original language/i.test(n)));
}

function testUnresolvedSourcesAreDisclosed() {
  const s = story("standard", [article(1)]);
  s.unresolved = ["C25: member item 4 not found"];
  const packet = assembleWriterPacket(s, new Map(), CFG);
  assert.ok(packet.notes.some((n) => /could not be resolved/i.test(n)));
}

function testBriefTierStaysSmall() {
  const articles = Array.from({ length: 8 }, (_, i) => article(i + 1, { chars: 5000 }));
  const packet = assembleWriterPacket(story("brief", articles), new Map(), CFG);
  assert.equal(packet.articles.length, 3);
  assert.ok(packet.totalChars <= CFG.tiers.brief.total_chars);
  assert.deepEqual(packet.targetWords, [25, 45]);
  // A brief is short by design, not for want of material: its 2,500-char budget
  // must not read as thin sourcing and must not warn the writer about it.
  assert.equal(packet.materialLevel, "full");
  assert.deepEqual(packet.notes, []);
}

// --- prompts ---

function testUserPromptCarriesBioMaterialAndSources() {
  const packet = assembleWriterPacket(
    story("feature", [article(1, { chars: 3000, sourceName: "Meduza" })]),
    new Map(),
    CFG,
  );
  const prompt = buildWriterUserPrompt("John, b. 1983. Bend, Oregon.", packet);
  assert.ok(prompt.includes("Bend, Oregon"));
  assert.ok(prompt.includes("Meduza"));
  assert.ok(prompt.includes("400–600 words"));
  assert.ok(prompt.includes("rank 3"));
  assert.ok(prompt.includes("Sources behind this story: 27"));
  // The upstream title is a machine label, and the prompt says so — including
  // that it is not evidence, because a cluster label routinely names events the
  // included sources do not cover.
  assert.ok(/Write your own headline/.test(prompt));
  assert.ok(/NOT source material and NOT evidence/.test(prompt));
}

function testSystemPromptCarriesTheVoiceDocument() {
  const prompt = buildWriterSystemPrompt("VOICE MEMO CONTENTS");
  assert.ok(prompt.includes("VOICE MEMO CONTENTS"));
  assert.ok(prompt.includes("HEADLINE:"));
}

function testWriterOutputParsing() {
  const parsed = parseWriterOutput("HEADLINE: Third person dies in ICE custody\n\nA man died...");
  assert.equal(parsed!.headline, "Third person dies in ICE custody");
  assert.equal(parsed!.body, "A man died...");

  // Models decorate the label; losing a whole piece to a bold marker would be absurd.
  assert.equal(
    parseWriterOutput("**Headline:** A plain headline\n\nBody text here.")!.headline,
    "A plain headline",
  );
  assert.equal(
    parseWriterOutput("## HEADLINE: Quoted one\n\nBody.")!.headline,
    "Quoted one",
  );

  assert.equal(parseWriterOutput("Just some prose with no headline line."), null);
  assert.equal(parseWriterOutput("HEADLINE: no body follows"), null);
}

testOneArticlePerOutletBeforeSeconds();
testSecondsFillRemainingSlotsInOrder();
testArticlesBeyondTheCapAreRecordedNotLost();
testVerbatimParagraphsAcrossSourcesAreDroppedOnce();
testShortParagraphsAreExemptFromDedup();
testDedupIgnoresWhitespaceAndCase();
testEveryArticleGetsItsFloorBeforeAnyGetsMore();
testShortArticlesDoNotHoardBudget();
testAllocationNeverExceedsAvailableText();
testTrimLandsOnAParagraphBoundary();
testTrimFallsBackToASentenceEnd();
testTrimLeavesShortTextAlone();
testFetchedTextIsPreferredButNeverShorterThanTheFeed();
testBlockedSourcesProduceAHeadlineOnlyPacketThatSaysSo();
testFullMaterialCarriesNoWarning();
testPacketKeepsTheEditorsSourceCountNotTheArticleCount();
testHeadlineEchoStubsAreLeftOut();
testAPacketIsNeverEmptied();
testPublisherFurnitureNeverReachesThePacket();
testMaterialLevelIsJudgedPerTier();
testUntranslatedSourceIsFlaggedToTheWriter();
testUnresolvedSourcesAreDisclosed();
testBriefTierStaysSmall();
testUserPromptCarriesBioMaterialAndSources();
testSystemPromptCarriesTheVoiceDocument();
testWriterOutputParsing();
console.log("writer assembler tests passed");
