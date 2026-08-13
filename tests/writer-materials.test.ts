import assert from "node:assert/strict";
import {
  buildStoryMaterials,
  type EditorStoryRow,
  type MaterialsInputs,
  type PreprocessedItemRow,
  type ThreadMemberRow,
  type ThreadRow,
} from "../src/pipeline/writers/materials.js";
import {
  summarizeMaterials,
  THIN_CHARS,
} from "../src/pipeline/writers/materials-report.js";
import type { ParsedGroupingCluster } from "../src/pipeline/editor-pass-1/index.js";

// Shapes and numbers come from editor run #112: T0 is the Oregon wildfire
// thread (6 members, score 85, 9 sources) whose members include the C25
// Grasshopper Fire cluster and four singletons. That is the case the resolver
// exists for — three levels deep, mixed member types — and the one no earlier
// stage in the pipeline has ever had to walk.

function item(
  id: number,
  overrides: Partial<PreprocessedItemRow> = {},
): PreprocessedItemRow {
  return {
    id: String(id),
    source_name: `Source ${id}`,
    source_type: "journalism",
    title: `Title ${id}`,
    english_title: null,
    body_text: `Body ${id}`,
    english_body: null,
    translation_failed: false,
    canonical_url: `https://example.com/${id}`,
    original_url: `https://example.com/${id}?utm_source=feed`,
    published_at: "2026-08-13T12:00:00.000Z",
    also_appeared_in: null,
    ...overrides,
  };
}

function cluster(
  index: number,
  memberIds: number[],
  title = `Cluster ${index}`,
): ParsedGroupingCluster {
  return { clusterIndex: index, title, summary: `Summary ${index}`, memberIds };
}

function threadMember(
  threadId: number,
  ref: string,
  score: number,
  sourceCount = 1,
): ThreadMemberRow {
  const isCluster = ref.startsWith("C");
  return {
    thread_id: String(threadId),
    item_type: isCluster ? "cluster" : "singleton",
    cluster_index: isCluster ? parseInt(ref.slice(1), 10) : null,
    preprocessed_item_id: isCluster ? null : ref.slice(1),
    score,
    source_count: sourceCount,
  };
}

function story(overrides: Partial<EditorStoryRow> = {}): EditorStoryRow {
  return {
    item_type: "singleton",
    cluster_index: null,
    preprocessed_item_id: null,
    thread_id: null,
    tier: "standard",
    rank: 1,
    ...overrides,
  };
}

function inputs(overrides: Partial<MaterialsInputs> = {}): MaterialsInputs {
  return {
    stories: [],
    threadsById: new Map(),
    threadMembersByThreadId: new Map(),
    clustersByIndex: new Map(),
    itemsById: new Map(),
    scoreByRef: new Map(),
    parentOf: (name) => name,
    ...overrides,
  };
}

// --- the three-level walk ---

function testThreadResolvesThroughClustersToArticles() {
  const thread: ThreadRow = {
    id: 7,
    thread_index: 0,
    title: "Oregon wildfire season strains state budget",
    summary: "Fires near Mount Hood",
    score: 85,
    source_count: 9,
  };
  const result = buildStoryMaterials(
    inputs({
      stories: [story({ item_type: "thread", thread_id: "7", tier: "feature", rank: 4 })],
      threadsById: new Map([[7, thread]]),
      threadMembersByThreadId: new Map([
        [
          7,
          [
            threadMember(7, "C25", 85, 4),
            threadMember(7, "S52283", 80),
            threadMember(7, "C53", 70, 2),
          ],
        ],
      ]),
      clustersByIndex: new Map([
        [25, cluster(25, [1, 2, 3, 4], "Grasshopper Fire burns 83,000 acres")],
        [53, cluster(53, [5, 6])],
      ]),
      itemsById: new Map([1, 2, 3, 4, 5, 6, 52283].map((id) => [id, item(id)])),
    }),
  );

  assert.equal(result.length, 1);
  const t0 = result[0]!;
  assert.equal(t0.ref, "T0");
  assert.equal(t0.itemType, "thread");
  assert.equal(t0.tier, "feature");
  assert.equal(t0.score, 85);
  assert.equal(t0.sourceCount, 9);
  assert.equal(t0.members.length, 3);
  // Every leaf article, not just the member rows.
  assert.equal(t0.articles.length, 7);
  assert.deepEqual(t0.unresolved, []);
  // Each article knows which member it arrived through — the lineage the
  // assembler needs to allocate budget per member.
  assert.equal(t0.articles.filter((a) => a.memberRef === "C25").length, 4);
  assert.equal(t0.articles.filter((a) => a.memberRef === "S52283").length, 1);
}

function testMembersOrderedByScoreDescending() {
  const result = buildStoryMaterials(
    inputs({
      stories: [story({ item_type: "thread", thread_id: "7", rank: 1 })],
      threadsById: new Map([
        [7, { id: 7, thread_index: 3, title: "T", summary: null, score: 76, source_count: 27 }],
      ]),
      threadMembersByThreadId: new Map([
        [7, [threadMember(7, "S10", 60), threadMember(7, "S20", 76), threadMember(7, "S30", 70)]],
      ]),
      itemsById: new Map([10, 20, 30].map((id) => [id, item(id)])),
    }),
  );
  assert.deepEqual(
    result[0]!.members.map((m) => m.ref),
    ["S20", "S30", "S10"],
  );
}

function testClusterArticlesAreChronological() {
  const result = buildStoryMaterials(
    inputs({
      stories: [story({ item_type: "cluster", cluster_index: 25, tier: "feature" })],
      clustersByIndex: new Map([[25, cluster(25, [3, 1, 2])]]),
      itemsById: new Map([
        [1, item(1, { published_at: "2026-08-13T09:00:00.000Z" })],
        [2, item(2, { published_at: "2026-08-13T11:00:00.000Z" })],
        [3, item(3, { published_at: "2026-08-13T07:00:00.000Z" })],
      ]),
      scoreByRef: new Map([["C25", 85]]),
    }),
  );
  assert.deepEqual(
    result[0]!.articles.map((a) => a.preprocessedItemId),
    [3, 1, 2],
  );
  assert.equal(result[0]!.score, 85);
  assert.equal(result[0]!.sourceCount, 3);
}

function testArticlesWithNoTimestampSortLast() {
  const result = buildStoryMaterials(
    inputs({
      stories: [story({ item_type: "cluster", cluster_index: 1 })],
      clustersByIndex: new Map([[1, cluster(1, [1, 2])]]),
      itemsById: new Map([
        [1, item(1, { published_at: null })],
        [2, item(2, { published_at: "2026-08-13T11:00:00.000Z" })],
      ]),
    }),
  );
  assert.deepEqual(
    result[0]!.articles.map((a) => a.preprocessedItemId),
    [2, 1],
  );
}

// --- degradation: the walk must never lose a story ---

function testMissingClusterIsRecordedNotThrown() {
  const result = buildStoryMaterials(
    inputs({
      stories: [story({ item_type: "cluster", cluster_index: 99, tier: "feature", rank: 7 })],
      clustersByIndex: new Map([[25, cluster(25, [1])]]),
      itemsById: new Map([[1, item(1)]]),
    }),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0]!.ref, "C99");
  assert.equal(result[0]!.articles.length, 0);
  assert.match(result[0]!.unresolved[0]!, /not present in the grouping digest/);
}

function testMissingItemLeavesTheEditorsSourceCountIntact() {
  // The editor ranked this cluster as 4 sources. If one member row is missing
  // we must still report 4 and say what went missing, rather than quietly
  // presenting a 3-source cluster as if that were the truth.
  const result = buildStoryMaterials(
    inputs({
      stories: [story({ item_type: "cluster", cluster_index: 25 })],
      clustersByIndex: new Map([[25, cluster(25, [1, 2, 3, 4])]]),
      itemsById: new Map([1, 2, 3].map((id) => [id, item(id)])),
    }),
  );
  assert.equal(result[0]!.sourceCount, 4);
  assert.equal(result[0]!.articles.length, 3);
  assert.match(result[0]!.unresolved[0]!, /member item 4 not found/);
}

function testDuplicateArticleAcrossMembersIsKeptOnce() {
  const result = buildStoryMaterials(
    inputs({
      stories: [story({ item_type: "thread", thread_id: "7" })],
      threadsById: new Map([
        [7, { id: 7, thread_index: 1, title: "T", summary: null, score: 83, source_count: 18 }],
      ]),
      threadMembersByThreadId: new Map([
        [7, [threadMember(7, "C1", 83, 2), threadMember(7, "S1", 80)]],
      ]),
      clustersByIndex: new Map([[1, cluster(1, [1, 2])]]),
      itemsById: new Map([1, 2].map((id) => [id, item(id)])),
    }),
  );
  assert.equal(result[0]!.articles.length, 2);
  assert.match(result[0]!.unresolved[0]!, /already claimed by an earlier member/);
}

function testPromotedSingletonShapeResolvesAsSingleton() {
  // item_type='cluster' with a null cluster_index and a real item id — the
  // merged-entry shape the inspect view already special-cases.
  const result = buildStoryMaterials(
    inputs({
      stories: [
        story({ item_type: "cluster", cluster_index: null, preprocessed_item_id: "52283" }),
      ],
      itemsById: new Map([[52283, item(52283)]]),
      scoreByRef: new Map([["S52283", 80]]),
    }),
  );
  assert.equal(result[0]!.ref, "S52283");
  assert.equal(result[0]!.itemType, "singleton");
  assert.equal(result[0]!.score, 80);
  assert.equal(result[0]!.articles.length, 1);
}

function testStoryNamingNothingIsStillReturned() {
  const result = buildStoryMaterials(inputs({ stories: [story({ rank: 42 })] }));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.rank, 42);
  assert.match(result[0]!.unresolved[0]!, /names neither a thread, cluster, nor item/);
}

// --- text selection ---

function testEnglishTranslationIsPreferredAndFailureIsFlagged() {
  const result = buildStoryMaterials(
    inputs({
      stories: [
        story({ preprocessed_item_id: "1", rank: 1 }),
        story({ preprocessed_item_id: "2", rank: 2 }),
      ],
      itemsById: new Map([
        [
          1,
          item(1, {
            title: "В Орске после удара дронов остановлен НПЗ",
            english_title: "Refinery halted in Orsk after drone strike",
            body_text: "оригинальный текст",
            english_body: "Original text, translated.",
          }),
        ],
        [
          2,
          item(2, {
            title: "飢餓緬甸",
            english_title: "飢餓緬甸",
            english_body: "軍政府封鎖",
            translation_failed: true,
          }),
        ],
      ]),
    }),
  );
  const translated = result[0]!.articles[0]!;
  assert.equal(translated.title, "Refinery halted in Orsk after drone strike");
  assert.equal(translated.feedText, "Original text, translated.");
  assert.equal(translated.originalTitle, "В Орске после удара дронов остановлен НПЗ");
  assert.equal(translated.translationFailed, false);

  // english_* is populated but holds the original — the flag is the only tell.
  assert.equal(result[1]!.articles[0]!.translationFailed, true);
}

function testFeedTextIsUncapped() {
  const long = "x".repeat(9000);
  const result = buildStoryMaterials(
    inputs({
      stories: [story({ preprocessed_item_id: "1" })],
      itemsById: new Map([[1, item(1, { body_text: long })]]),
    }),
  );
  assert.equal(result[0]!.articles[0]!.feedTextChars, 9000);
}

function testNullBodyBecomesEmptyString() {
  const result = buildStoryMaterials(
    inputs({
      stories: [story({ preprocessed_item_id: "1" })],
      itemsById: new Map([[1, item(1, { body_text: null })]]),
    }),
  );
  assert.equal(result[0]!.articles[0]!.feedText, "");
  assert.equal(result[0]!.articles[0]!.feedTextChars, 0);
}

function testParentOutletIsAttached() {
  const result = buildStoryMaterials(
    inputs({
      stories: [story({ preprocessed_item_id: "1" })],
      itemsById: new Map([
        [1, item(1, { source_name: "AP Politics", also_appeared_in: "AP Top News, AP US News" })],
      ]),
      parentOf: (name) => (name.startsWith("AP ") ? "AP Top News" : name),
    }),
  );
  const article = result[0]!.articles[0]!;
  assert.equal(article.parentSource, "AP Top News");
  assert.deepEqual(article.alsoAppearedIn, ["AP Top News", "AP US News"]);
}

// --- the audit ---

function testReportCountsThinArticlesAndScopesTheFetch() {
  const full = "x".repeat(4000);
  const teaser = "x".repeat(200);
  const stories = buildStoryMaterials(
    inputs({
      stories: [
        story({ item_type: "cluster", cluster_index: 1, tier: "feature", rank: 1 }),
        story({ preprocessed_item_id: "10", tier: "standard", rank: 2 }),
        story({ preprocessed_item_id: "11", tier: "brief", rank: 3 }),
      ],
      clustersByIndex: new Map([[1, cluster(1, [1, 2])]]),
      itemsById: new Map([
        [1, item(1, { body_text: full, source_name: "ProPublica" })],
        [2, item(2, { body_text: teaser, source_name: "Reuters World News" })],
        [10, item(10, { body_text: teaser, source_name: "Reuters World News" })],
        [11, item(11, { body_text: teaser, source_name: "Reuters World News" })],
      ]),
    }),
  );

  const report = summarizeMaterials(112, stories);
  assert.equal(report.stories, 3);
  assert.equal(report.articles, 4);
  assert.equal(report.thinCount, 3);
  assert.ok(teaser.length < THIN_CHARS && full.length >= THIN_CHARS);

  // The brief tier is out of fetch scope: a one-liner needs no article body.
  assert.equal(report.fetchScope.articles, 3);
  assert.equal(report.fetchScope.thinCount, 2);

  // Per-source table is thin-first, so the fetcher's worklist reads off the top.
  assert.equal(report.sources[0]!.sourceName, "Reuters World News");
  assert.equal(report.sources[0]!.thinCount, 3);
  assert.equal(report.sources[0]!.medianChars, 200);

  const feature = report.tiers.find((t) => t.tier === "feature")!;
  assert.equal(feature.articles, 2);
  assert.equal(feature.stories, 1);
}

function testReportCountsUniqueUrlsNotArticles() {
  // Cross-source pickup is preserved deliberately, but two outlets syndicating
  // one wire story can carry the same canonical URL — the fetcher pays once.
  const stories = buildStoryMaterials(
    inputs({
      stories: [story({ item_type: "cluster", cluster_index: 1, tier: "feature" })],
      clustersByIndex: new Map([[1, cluster(1, [1, 2])]]),
      itemsById: new Map([
        [1, item(1, { canonical_url: "https://ap.example/story" })],
        [2, item(2, { canonical_url: "https://ap.example/story" })],
      ]),
    }),
  );
  const report = summarizeMaterials(112, stories);
  assert.equal(report.articles, 2);
  assert.equal(report.uniqueUrls, 1);
  assert.equal(report.fetchScope.uniqueUrls, 1);
}

function testReportSurfacesUnresolvedStories() {
  const stories = buildStoryMaterials(
    inputs({
      stories: [story({ item_type: "cluster", cluster_index: 99, tier: "feature", rank: 3 })],
    }),
  );
  const report = summarizeMaterials(112, stories);
  assert.equal(report.unresolved.length, 1);
  assert.equal(report.unresolved[0]!.rank, 3);
}

testThreadResolvesThroughClustersToArticles();
testMembersOrderedByScoreDescending();
testClusterArticlesAreChronological();
testArticlesWithNoTimestampSortLast();
testMissingClusterIsRecordedNotThrown();
testMissingItemLeavesTheEditorsSourceCountIntact();
testDuplicateArticleAcrossMembersIsKeptOnce();
testPromotedSingletonShapeResolvesAsSingleton();
testStoryNamingNothingIsStillReturned();
testEnglishTranslationIsPreferredAndFailureIsFlagged();
testFeedTextIsUncapped();
testNullBodyBecomesEmptyString();
testParentOutletIsAttached();
testReportCountsThinArticlesAndScopesTheFetch();
testReportCountsUniqueUrlsNotArticles();
testReportSurfacesUnresolvedStories();
console.log("writer materials tests passed");
