import assert from "node:assert/strict";
import {
  assembleWriterPacket,
  selectArticles,
  dedupeParagraphs,
  allocateBudget,
  trimToBoundary,
  normalizeParagraph,
  isLiveBlog,
  type ResolvedText,
} from "../src/pipeline/writers/assembler.js";
import {
  buildWriterUserPrompt,
  buildWriterSystemPrompt,
} from "../src/pipeline/writers/prompt.js";
import type { StoryMaterials, StoryArticle } from "../src/pipeline/writers/materials.js";
import type { WritersPacketConfig } from "../src/config/models.js";

// The shapes here are run #112's: T3 carried 27 articles across 12 members, T1
// carried 18 across 12, and 9 articles in the paper came from hosts that blocked
// every request — so a packet has to survive both too much material and none.

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
    storyId: 1,
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

function testLiveBlogsAreRankedBehindRealArticles() {
  // Le Monde's Ukraine live blog took 5,954 characters of rank 3's feature
  // budget in run #112. It is one page covering a day of many stories, so it is
  // a source of last resort — pushed behind articles, never deleted.
  const articles = [
    article(1, {
      parentSource: "Le Monde",
      title: "LIVE: Ukraine war: Russia claims it has not received a formal proposal",
    }),
    article(2, { parentSource: "BBC" }),
    article(3, { parentSource: "Meduza" }),
  ];
  const { selected } = selectArticles(articles, 2);
  assert.deepEqual(
    selected.map((a) => a.preprocessedItemId),
    [2, 3],
  );
}

function testALiveBlogIsStillUsedWhenItIsAllThereIs() {
  const only = article(1, { title: "Live updates: the fire near Bend" });
  const { selected, omitted } = selectArticles([only], 3);
  assert.equal(selected.length, 1);
  assert.equal(omitted.length, 0);
}

function testLiveBlogDetection() {
  assert.equal(isLiveBlog("LIVE: Ukraine war: Russia claims it has not received"), true);
  assert.equal(isLiveBlog("EN DIRECT : guerre en Ukraine"), true);
  assert.equal(isLiveBlog("Live updates: Oregon wildfires"), true);
  // Near-misses: ordinary headlines that merely contain the word.
  assert.equal(isLiveBlog("Live music returns to the Old Mill District"), false);
  assert.equal(isLiveBlog("They live in fear of the next eviction notice"), false);
  assert.equal(isLiveBlog("Ukraine strikes Russian grain terminals"), false);
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

/** The feature tier as it was before source material stopped being rationed. */
const CAPPED = { ...CFG.tiers.feature, max_articles: 12, total_chars: 48000 };

function testAnUncappedTierHandsOverEveryCharacter() {
  // The normal case. Nothing survives collection, prefiltering, grouping and the
  // editor only to be trimmed here: deciding what bears on the piece is the
  // writer's judgment, and it cannot make it on text it never sees.
  const lengths = Array.from({ length: 12 }, () => 20000);
  assert.deepEqual(allocateBudget(lengths, CFG.tiers.feature), lengths);
}

function testEveryArticleGetsItsFloorBeforeAnyGetsMore() {
  // Only reachable when a tier is capped, which no tier is. Kept because a cap
  // may one day be needed for a page that would blow a context window, and the
  // rule that matters then is that the squeeze spreads: three long articles must
  // not eat the budget and leave nine members invisible.
  const lengths = Array.from({ length: 12 }, () => 20000);
  const allocations = allocateBudget(lengths, CAPPED);
  assert.ok(allocations.every((a) => a >= 800));
  assert.equal(
    allocations.reduce((a, b) => a + b, 0),
    48000,
  );
}

function testShortArticlesDoNotHoardBudget() {
  const allocations = allocateBudget([100, 100, 30000], CFG.tiers.feature);
  assert.deepEqual(allocations.slice(0, 2), [100, 100]);
  // The long one takes what the short two cannot use. per_article_chars caps
  // the fair-share pass, not the packet: with 47,800 characters of feature
  // budget unclaimed there is nobody to be fair to.
  assert.equal(allocations[2], 30000);
}

function testThePerArticleCapBindsOnlyWhileThereIsCompetition() {
  // Run #17's rank 32: one source, 9,892 characters, standard tier — cut to
  // 2,573 by per_article_chars: 3000 while using a fifth of a 12,000-character
  // budget. The writer then told the reader the article "does not specify which
  // benefits are now included", which was true of the text it was handed and
  // false of the article: the part naming them was in the 74% we cut.
  // Uncapped, which is how every tier ships: the whole article.
  assert.deepEqual(allocateBudget([9892], CFG.tiers.standard), [9892]);

  // The rest of this only applies if a tier is ever capped again.
  const capped = { ...CFG.tiers.standard, max_articles: 6, total_chars: 12000 };
  assert.deepEqual(allocateBudget([9892], capped), [9892], "nobody to be fair to");

  // With real competition the cap still does its job on the first pass.
  const shared = allocateBudget([9892, 9892, 9892, 9892, 9892], capped);
  assert.equal(shared.reduce((a, b) => a + b, 0), 12000);
  assert.ok(
    shared.every((a) => a <= capped.per_article_chars),
    "no article exceeds its fair share while others still want budget",
  );
  assert.ok(shared.every((a) => a >= capped.floor_chars));
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

function testAThinPacketIsDirectedNotDescribed() {
  // The nytimes.com / oregonlive.com case: nothing fetched, teasers only.
  //
  // The note used to open "Material is headline-level only", and six pieces in
  // run #13 relayed that to the reader — "No further detail was available."
  // The standing memo forbids writing about the sourcing and sits in the system
  // prompt; this note sits in the user prompt, about this piece, and won. It
  // says what to do now, and nothing about what the packet lacks.
  const packet = assembleWriterPacket(
    story("standard", [article(1, { chars: 120 }), article(2, { chars: 150 })]),
    new Map(),
    CFG,
  );
  assert.equal(packet.materialLevel, "headline-only");
  const note = packet.notes.join(" ");
  assert.ok(/write only what the sources below actually state/i.test(note));
  // It says what to do about a gap rather than describing the packet. The
  // bare prohibition "make no remark about how much they say" was removed on
  // the theory that naming the sourcing plants it; run #31 produced four
  // source-meta sentences, all in the material levels whose clause had gone,
  // so the actionable form of the memo's actor-versus-outlet rule is here
  // instead.
  assert.ok(/a gap is worth a sentence only when someone in the story withheld/i.test(note));
  assert.ok(
    !/(headline-level|only a summary|material is|feed|unavailable|how much they say)/i.test(note),
    `note describes the packet: ${note}`,
  );
  // It still has the material it has — degraded, not empty.
  assert.equal(packet.articles.length, 2);
}

function testLiveBlogDetectionAcceptsAnySeparator() {
  // Le Monde writes "EN DIRECT, guerre en Ukraine : …" with a comma, which the
  // original colon-or-dash pattern missed. Run #20's T1 lead was that live blog,
  // 45,000 characters covering the whole war, and it became a section lead's
  // entire material.
  for (const title of [
    "EN DIRECT, guerre en Ukraine : le nouveau ministre promet d'intensifier",
    "En direct : la guerre en Ukraine",
    "Live — Ukraine war",
    "Live: Ukraine war",
    "Ukraine war live updates",
    "Live blog: the strait",
  ]) {
    assert.ok(isLiveBlog(title), `not detected: ${title}`);
  }

  // And prose that merely contains the words is still an article.
  for (const title of [
    "Live music venue closes after 40 years",
    "Direct action campaign targets data centre",
    "A direct line to the minister",
  ]) {
    assert.ok(!isLiveBlog(title), `false positive: ${title}`);
  }
}

function testThePromptNeverDescribesItsOwnPlumbing() {
  // Three layers said the same thing at three distances, and each time the
  // outer one was fixed the inner one won. The standing memo forbids writing
  // about sourcing (system prompt); the packet note used to describe the
  // material (user prompt); and every source carried `[feed summary only]` and
  // `[truncated at N of M chars]` inline with its text. Run #15 relayed the
  // last one to the reader — "the source material was truncated before
  // detailing the specific benefits" — which read as a hallucination and was
  // accurate about the packet.
  const texts = new Map<number, ResolvedText>([[1, { text: "z".repeat(40000), origin: "fetched" }]]);
  const packet = assembleWriterPacket(
    story("standard", [article(1, { chars: 200 }), article(2, { chars: 80 })]),
    texts,
    CFG,
  );
  // Nothing is trimmed now that no tier is capped — but the packet still knows
  // where each source came from, so an audit still can.
  assert.ok(packet.articles.every((a) => !a.truncated));
  assert.ok(packet.articles.some((a) => a.origin === "fetched"));
  assert.ok(packet.articles.some((a) => a.origin === "feed"));

  const prompt = buildWriterUserPrompt("bio", packet);
  for (const leak of [
    /feed summary only/i,
    /truncated at/i,
    /no body text available/i,
    /chars\)?\]/i,
  ]) {
    assert.ok(!leak.test(prompt), `prompt describes its own plumbing: ${leak}`);
  }
}

function testFurnitureComesOffBeforeEitherCandidateIsMeasured() {
  // Run #28's four cascadepbs.org sources each had a 574-character extraction
  // beat a ~390-character feed body on raw length, then strip down to 286 —
  // worse than the teaser it replaced. Comparing raw lengths picks the text that
  // loses more of itself to stripping, which the raw comparison cannot see.
  const furniture = ["The-CNN-Wire", "© 2026 Example Media. All rights reserved."].join("\n\n");
  const texts = new Map<number, ResolvedText>([
    [1, { text: `Two short real sentences.\n\n${"z".repeat(700)}\n\n${furniture}`, origin: "fetched" }],
    // Longer raw than the 600-char feed body, shorter once the furniture is off.
    [
      2,
      {
        text: ["A single real sentence.", ...Array.from({ length: 12 }, () => furniture)].join("\n\n"),
        origin: "fetched",
      },
    ],
  ]);
  const packet = assembleWriterPacket(
    story("standard", [article(1, { chars: 200 }), article(2, { chars: 600 })]),
    texts,
    CFG,
  );
  assert.equal(packet.articles[0]!.origin, "fetched");
  // The teaser wins on stripped length, so the packet keeps all 600 characters
  // rather than falling to the fetched text's one surviving sentence.
  assert.equal(packet.articles[1]!.origin, "feed");
  assert.equal(packet.articles[1]!.chars, 600);
}

function testAnEmptySourceIsNotReportedAsLeftOutForLength() {
  // Run #28's C187: both its Hankyoreh items came back with zero characters, one
  // kept its packet slot empty and one was omitted for "no usable body text" —
  // and the prompt told the writer a further source had been "left out for
  // length". Nothing was withheld; there was nothing there. The piece it wrote
  // ends "No further details were available from the report."
  const packet = assembleWriterPacket(
    story("standard", [article(1, { chars: 300 }), article(2, { chars: 0 })]),
    new Map(),
    CFG,
  );
  assert.ok(packet.omitted.some((o) => o.kind === "no-text"));
  assert.ok(!packet.omitted.some((o) => o.kind === "length"));
  assert.ok(!/left out for length/i.test(buildWriterUserPrompt("bio", packet)));
}

function testTheWriterIsToldNothingAboutSourcesItCannotSee() {
  // "Sources behind this story: 2 (1 included below)" is the editor's count plus
  // a parenthetical naming the gap. C187 read it and wrote "No further details
  // were available from the source" in run #28 and again in run #30, after the
  // packet's omission note had already been fixed.
  const packet = assembleWriterPacket(
    story("standard", [article(1, { chars: 300 }), article(2, { chars: 0 })]),
    new Map(),
    CFG,
  );
  // The story was ranked on 27 sources and the packet holds one usable article.
  assert.equal(packet.sourceCount, 27);
  assert.equal(packet.articles.length, 1);
  const prompt = buildWriterUserPrompt("bio", packet);
  assert.ok(!/sources behind this story/i.test(prompt));
  assert.ok(!/included below/i.test(prompt));
  assert.ok(!/not reproduced below/i.test(prompt));
  assert.ok(!/\b27\b/.test(prompt), "the editor's source count reached the writer");
  // The count is still on the packet, for `inspect packet` and the audit.
  assert.ok(/SOURCE MATERIAL \(1 article/.test(prompt));
}

function testAnUntranslatedSourceIsStillFlaggedInThePrompt() {
  // The one flag that survives, because it is the one a writer can act on:
  // whether it can read the text at all.
  const packet = assembleWriterPacket(
    story("standard", [article(1, { chars: 600, translationFailed: true })]),
    new Map(),
    CFG,
  );
  assert.ok(/NOT TRANSLATED/.test(buildWriterUserPrompt("bio", packet)));
}

function testAThinPieceIsGivenACeilingAndNoFloor() {
  // Run #24 produced five pieces ending "No further details were available from
  // the source", every one of them headline-only. The memo, the packet note and
  // the source labels had all been cleaned of that already; what was left asking
  // for it was the floor. Fifteen words of material against a 25-word minimum
  // leaves ten words to fill, and the writer filled them the only way it could.
  const thin = assembleWriterPacket(story("standard", [article(1, { chars: 150 })]), new Map(), CFG);
  assert.equal(thin.materialLevel, "headline-only");
  const prompt = buildWriterUserPrompt("bio", thin);
  assert.ok(/up to 60 words, and fewer is correct/.test(prompt));
  assert.ok(!/25–60/.test(prompt), "a range states a floor");
  assert.ok(!/25-60/.test(prompt));

  // A piece with real material keeps its range: the floor is doing useful work
  // there, and a 40-word feature is a different failure.
  const full = assembleWriterPacket(story("feature", [article(1, { chars: 40000 })]), new Map(), CFG);
  assert.equal(full.materialLevel, "full");
  assert.ok(/400–600 words/.test(buildWriterUserPrompt("bio", full)));

  // **Partial material gets the ceiling too.** Run #32's S60167 was asked for
  // 120–200 words from one thin source and filled the gap with "The source
  // material does not specify the legal mechanism of the guidance, which states
  // might act on it first…". The note beside it said to stay inside the sources;
  // the number won, the same way it won at headline-only in run #24.
  const partial = assembleWriterPacket(
    story("standard", [article(1, { chars: 1200 })]),
    new Map(),
    CFG,
  );
  assert.equal(partial.materialLevel, "partial");
  const partialPrompt = buildWriterUserPrompt("bio", partial);
  assert.ok(/up to 200 words, and fewer is correct/.test(partialPrompt));
  assert.ok(!/120–200/.test(partialPrompt), "a range states a floor");
}

function testAPartialPacketIsAlsoDirectedNotDescribed() {
  const packet = assembleWriterPacket(
    story("feature", [article(1, { chars: 5000 })]),
    new Map(),
    CFG,
  );
  assert.equal(packet.materialLevel, "partial");
  const note = packet.notes.join(" ");
  assert.ok(/stay inside what the sources below state/i.test(note));
  assert.ok(!/(only a summary|material is)/i.test(note), `note describes the packet: ${note}`);
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
  // The editor ranked T3 on 27 sources and the writer now sees all 27. The two
  // numbers can still diverge — a source can be dropped for having no usable
  // body, or for echoing its own headline — so the count stays the editor's.
  const articles = Array.from({ length: 27 }, (_, i) => article(i + 1, { chars: 300 }));
  const packet = assembleWriterPacket(story("feature", articles), new Map(), CFG);
  assert.equal(packet.sourceCount, 27);
  assert.equal(packet.articles.length, 27);
  assert.equal(packet.omitted.length, 0);

  // An unresolvable source still leaves the editor's count intact.
  const withStub = story("feature", [...articles, article(99, { chars: 0 })]);
  const stubbed = assembleWriterPacket(withStub, new Map(), CFG);
  assert.equal(stubbed.sourceCount, 27);
  assert.equal(stubbed.omitted.length, 1);
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

function testHeadlineOnlyMaterialCapsTheWordTarget() {
  // Run #8's T1 sidebar S53521 had a headline and a lede and was asked for
  // 120-200 words; it filled the gap with detail about the 1924 Johnson-Reed
  // Act that no source carried. The note telling a writer not to invent
  // competes with the length target, so the target goes instead.
  const thin = assembleWriterPacket(story("standard", [article(1, { chars: 150 })]), new Map(), CFG);
  assert.equal(thin.materialLevel, "headline-only");
  assert.deepEqual(thin.targetWords, [25, 60]);

  // A tier already shorter than the ceiling keeps its own target — the cap is
  // element-wise minimum, not a replacement.
  const thinBrief = assembleWriterPacket(story("brief", [article(1, { chars: 150 })]), new Map(), CFG);
  assert.equal(thinBrief.materialLevel, "headline-only");
  assert.deepEqual(thinBrief.targetWords, [25, 45]);

  // Real material leaves the tier's target alone.
  const full = assembleWriterPacket(story("standard", [article(1, { chars: 4000 })]), new Map(), CFG);
  assert.equal(full.materialLevel, "full");
  assert.deepEqual(full.targetWords, [120, 200]);
}

function testUntranslatedSourceIsFlaggedToTheWriter() {
  const packet = assembleWriterPacket(
    story("standard", [article(1, { chars: 600, translationFailed: true })]),
    new Map(),
    CFG,
  );
  assert.ok(packet.notes.some((n) => /original language/i.test(n)));
}

function testUnresolvedSourcesAreNotDisclosed() {
  // This note used to say "N source(s) counted above are not reproduced below."
  // It was the counterpart to the source-count line, and both were the prompt
  // pointing at a gap. A writer cannot act on the existence of a source it
  // cannot read; being told one exists is only an invitation to write about the
  // sourcing, which is what C187 did in runs #28 and #30.
  //
  // The resolver still records them on the story, and `inspect materials`
  // reports them, which is where a missing item is actually diagnosed.
  const s = story("standard", [article(1)]);
  s.unresolved = ["C25: member item 4 not found"];
  const packet = assembleWriterPacket(s, new Map(), CFG);
  const prompt = buildWriterUserPrompt("bio", packet);
  assert.ok(!/not reproduced below/i.test(prompt));
  assert.ok(!/counted above/i.test(prompt));
}

function testABriefIsShortButNotUnderInformed() {
  // A brief is short because the *piece* is short, not because the writer was
  // given less to read. All eight sources reach it; the 25-45 word target is
  // what makes it a brief.
  const articles = Array.from({ length: 8 }, (_, i) => article(i + 1, { chars: 5000 }));
  const packet = assembleWriterPacket(story("brief", articles), new Map(), CFG);
  assert.equal(packet.articles.length, 8);
  assert.equal(packet.omitted.length, 0);
  assert.equal(packet.totalChars, 40000);
  assert.deepEqual(packet.targetWords, [25, 45]);
  // Short by design must not read as thin sourcing or warn about it.
  assert.equal(packet.materialLevel, "full");
  assert.deepEqual(packet.notes, []);
}

function testNoSourceIsEverDroppedForBeingTheNthOne() {
  // Run #114's Iran thread carried 17 articles and the writer saw 12 of them —
  // five whole sources discarded by max_articles, which was a third mechanism
  // aimed at redundancy that selection and dedupeParagraphs already handle.
  const articles = Array.from({ length: 17 }, (_, i) =>
    article(i + 1, { chars: 4000, parentSource: `Outlet ${i % 9}` }),
  );
  const { selected, omitted } = selectArticles(articles, null);
  assert.equal(selected.length, 17);
  assert.equal(omitted.length, 0);

  // Ordering still reads across outlets before down one of them.
  const firstNine = selected.slice(0, 9).map((a) => a.parentSource);
  assert.equal(new Set(firstNine).size, 9);
}

// --- prompts ---

function testUserPromptCarriesBioMaterialAndSources() {
  const packet = assembleWriterPacket(
    story("feature", [article(1, { chars: 40000, sourceName: "Meduza" })]),
    new Map(),
    CFG,
  );
  const prompt = buildWriterUserPrompt("John, b. 1983. Bend, Oregon.", packet);
  assert.ok(prompt.includes("Bend, Oregon"));
  assert.ok(prompt.includes("Meduza"));
  assert.ok(prompt.includes("400–600 words"));
  assert.ok(prompt.includes("rank 3"));
  // The editor's source count does not reach the writer. See
  // testTheWriterIsToldNothingAboutSourcesItCannotSee.
  assert.ok(!prompt.includes("Sources behind this story"));
  // The upstream title is a machine label, and the prompt says so — including
  // that it is not evidence, because a cluster label routinely names events the
  // included sources do not cover.
  assert.ok(/Write your own headline/.test(prompt));
  assert.ok(/NOT source material and NOT evidence/.test(prompt));
}

function testThreadPromptTellsTheWriterToFindASpine() {
  // Run #1's two sprawling features were both 12-member threads; the tight one
  // had four members. Sprawl tracks the number of distinct events, so a thread
  // is told to lead with one development rather than tour all of them.
  const packet = assembleWriterPacket(
    story("feature", [article(1, { chars: 3000 }), article(2, { chars: 3000 })]),
    new Map(),
    CFG,
  );
  const prompt = buildWriterUserPrompt("bio", packet);
  assert.ok(prompt.includes("FOCUS"));
  assert.ok(/several related events/.test(prompt));
  assert.ok(/not required to use every source|leave out what does not/.test(prompt));
  assert.ok(/ceiling, not a/.test(prompt));
}

function testASingleSourceStoryGetsNoFocusBlock() {
  const single = story("standard", [article(1, { chars: 900 })]);
  single.itemType = "singleton";
  const prompt = buildWriterUserPrompt("bio", assembleWriterPacket(single, new Map(), CFG));
  assert.ok(!prompt.includes("FOCUS"));
}

function testAMultiSourceClusterIsToldItIsOneEvent() {
  const cluster = story("standard", [article(1, { chars: 900 }), article(2, { chars: 900 })]);
  cluster.itemType = "cluster";
  const prompt = buildWriterUserPrompt("bio", assembleWriterPacket(cluster, new Map(), CFG));
  assert.ok(/cover one event/.test(prompt));
  assert.ok(!/several related events/.test(prompt));
}

function testSystemPromptCarriesTheVoiceDocument() {
  const prompt = buildWriterSystemPrompt("VOICE MEMO CONTENTS");
  // Naming the requirement is what took the batch contract's headline-less
  // briefs from ten to zero in run #40. The individual prompt showed the shape
  // and never said the label was mandatory; four of run #40's individual pieces
  // came back without it.
  assert.ok(/Begin with the literal word HEADLINE and a colon/.test(prompt));
  assert.ok(/a brief has a headline exactly as a feature does/.test(prompt));
  assert.ok(prompt.includes("VOICE MEMO CONTENTS"));
  assert.ok(prompt.includes("HEADLINE:"));
}

testOneArticlePerOutletBeforeSeconds();
testSecondsFillRemainingSlotsInOrder();
testLiveBlogsAreRankedBehindRealArticles();
testALiveBlogIsStillUsedWhenItIsAllThereIs();
testLiveBlogDetection();
testArticlesBeyondTheCapAreRecordedNotLost();
testVerbatimParagraphsAcrossSourcesAreDroppedOnce();
testShortParagraphsAreExemptFromDedup();
testDedupIgnoresWhitespaceAndCase();
testAnUncappedTierHandsOverEveryCharacter();
testEveryArticleGetsItsFloorBeforeAnyGetsMore();
testShortArticlesDoNotHoardBudget();
testThePerArticleCapBindsOnlyWhileThereIsCompetition();
testAllocationNeverExceedsAvailableText();
testTrimLandsOnAParagraphBoundary();
testTrimFallsBackToASentenceEnd();
testTrimLeavesShortTextAlone();
testFetchedTextIsPreferredButNeverShorterThanTheFeed();
testAThinPacketIsDirectedNotDescribed();
testAPartialPacketIsAlsoDirectedNotDescribed();
testAThinPieceIsGivenACeilingAndNoFloor();
testLiveBlogDetectionAcceptsAnySeparator();
testThePromptNeverDescribesItsOwnPlumbing();
testFurnitureComesOffBeforeEitherCandidateIsMeasured();
testAnEmptySourceIsNotReportedAsLeftOutForLength();
testTheWriterIsToldNothingAboutSourcesItCannotSee();
testAnUntranslatedSourceIsStillFlaggedInThePrompt();
testFullMaterialCarriesNoWarning();
testPacketKeepsTheEditorsSourceCountNotTheArticleCount();
testHeadlineEchoStubsAreLeftOut();
testAPacketIsNeverEmptied();
testPublisherFurnitureNeverReachesThePacket();
testMaterialLevelIsJudgedPerTier();
testHeadlineOnlyMaterialCapsTheWordTarget();
testUntranslatedSourceIsFlaggedToTheWriter();
testUnresolvedSourcesAreNotDisclosed();
testABriefIsShortButNotUnderInformed();
testNoSourceIsEverDroppedForBeingTheNthOne();
testUserPromptCarriesBioMaterialAndSources();
testThreadPromptTellsTheWriterToFindASpine();
testASingleSourceStoryGetsNoFocusBlock();
testAMultiSourceClusterIsToldItIsOneEvent();
testSystemPromptCarriesTheVoiceDocument();
console.log("writer assembler tests passed");
