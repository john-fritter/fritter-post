/**
 * Audit of what text the paper actually has before any fetching happens.
 *
 * The fetch policy is the first real decision of the writers stage, and it
 * cannot be made from intuition: "some articles need fetching" is either 30% of
 * the paper or 90% of it, and the difference decides whether the fetcher is a
 * convenience or the stage's critical path. RSS bodies range from a full
 * `content:encoded` article to a two-sentence teaser, and which is which is a
 * property of the outlet, not of the story.
 *
 * So this measures, per tier and per source, how much body text each underlying
 * article carries — and reports the numbers the fetcher's config needs: how many
 * URLs a feature+standard fetch would touch, and which outlets contribute the
 * articles that are all lede and no body.
 *
 * Pure functions over resolved materials. No database, no clock.
 */

import type { StoryMaterials, StoryArticle } from "./materials.js";
import type { EditorTier } from "../editor/index.js";
import { hostOf } from "../../lib/http.js";

/**
 * Below this many characters an article is a teaser, not a body: roughly a
 * headline plus a lede, which is what the pipeline's judgment stages run on and
 * what a writer cannot write 400 words from. Deliberately above prefilter's
 * 500-char cap and below pass-1's 1000, so "thin" means thinner than what the
 * scorer already saw.
 */
export const THIN_CHARS = 800;

/** Fetching is scoped to the tiers whose pieces get prose; briefs are one-liners. */
export const FETCH_TIERS: EditorTier[] = ["feature", "standard"];

const BUCKETS: Array<{ label: string; max: number }> = [
  { label: "empty", max: 0 },
  { label: "1–299", max: 299 },
  { label: "300–799", max: 799 },
  { label: "800–1999", max: 1999 },
  { label: "2000–4999", max: 4999 },
  { label: "5000+", max: Number.MAX_SAFE_INTEGER },
];

export interface SourceTextStats {
  sourceName: string;
  articles: number;
  medianChars: number;
  maxChars: number;
  thinCount: number;
  emptyCount: number;
}

export interface TierStats {
  tier: string;
  stories: number;
  articles: number;
  uniqueUrls: number;
  medianChars: number;
  thinCount: number;
  emptyCount: number;
}

export interface HostStats {
  host: string;
  articles: number;
  thinCount: number;
}

export interface BigStoryStats {
  rank: number;
  tier: string;
  ref: string;
  title: string;
  members: number;
  articles: number;
  totalChars: number;
  thinCount: number;
}

export interface MaterialsReport {
  editorRunId: number;
  stories: number;
  articles: number;
  uniqueUrls: number;
  medianChars: number;
  thinCount: number;
  emptyCount: number;
  translationFailed: number;
  tiers: TierStats[];
  buckets: Array<{ label: string; count: number }>;
  sources: SourceTextStats[];
  biggestStories: BigStoryStats[];
  /** Hosts in fetch scope, busiest first — the fetcher serializes per host. */
  hosts: HostStats[];
  fetchScope: {
    tiers: string[];
    articles: number;
    uniqueUrls: number;
    thinCount: number;
    hosts: number;
  };
  unresolved: Array<{ ref: string; rank: number; notes: string[] }>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function bucketOf(chars: number): string {
  for (const b of BUCKETS) {
    if (chars <= b.max) return b.label;
  }
  return BUCKETS[BUCKETS.length - 1]!.label;
}

function articleStats(articles: StoryArticle[]) {
  const chars = articles.map((a) => a.feedTextChars);
  return {
    medianChars: median(chars),
    thinCount: articles.filter((a) => a.feedTextChars < THIN_CHARS).length,
    emptyCount: articles.filter((a) => a.feedTextChars === 0).length,
    uniqueUrls: new Set(articles.map((a) => a.canonicalUrl)).size,
  };
}

export function summarizeMaterials(
  editorRunId: number,
  stories: StoryMaterials[],
  bigStoryLimit = 15,
): MaterialsReport {
  const allArticles = stories.flatMap((s) => s.articles);
  const overall = articleStats(allArticles);

  const tierOrder = ["feature", "standard", "brief", "cut"];
  const tiers: TierStats[] = [];
  for (const tier of tierOrder) {
    const inTier = stories.filter((s) => s.tier === tier);
    if (inTier.length === 0) continue;
    const articles = inTier.flatMap((s) => s.articles);
    const stats = articleStats(articles);
    tiers.push({
      tier,
      stories: inTier.length,
      articles: articles.length,
      uniqueUrls: stats.uniqueUrls,
      medianChars: stats.medianChars,
      thinCount: stats.thinCount,
      emptyCount: stats.emptyCount,
    });
  }

  const bucketCounts = new Map<string, number>(BUCKETS.map((b) => [b.label, 0]));
  for (const a of allArticles) {
    const label = bucketOf(a.feedTextChars);
    bucketCounts.set(label, (bucketCounts.get(label) ?? 0) + 1);
  }

  const bySource = new Map<string, StoryArticle[]>();
  for (const a of allArticles) {
    const list = bySource.get(a.sourceName) ?? [];
    list.push(a);
    bySource.set(a.sourceName, list);
  }
  const sources: SourceTextStats[] = [...bySource.entries()]
    .map(([sourceName, list]) => {
      const stats = articleStats(list);
      return {
        sourceName,
        articles: list.length,
        medianChars: stats.medianChars,
        maxChars: Math.max(...list.map((a) => a.feedTextChars)),
        thinCount: stats.thinCount,
        emptyCount: stats.emptyCount,
      };
    })
    // Thin-first, then by volume: the top of this table is the fetcher's
    // worklist, and an outlet with 20 teaser articles matters more than one
    // with a single teaser.
    .sort((a, b) => b.thinCount - a.thinCount || b.articles - a.articles);

  const biggestStories: BigStoryStats[] = [...stories]
    .sort((a, b) => b.articles.length - a.articles.length || a.rank - b.rank)
    .slice(0, bigStoryLimit)
    .map((s) => ({
      rank: s.rank,
      tier: s.tier,
      ref: s.ref,
      title: s.title,
      members: s.members.length,
      articles: s.articles.length,
      totalChars: s.articles.reduce((sum, a) => sum + a.feedTextChars, 0),
      thinCount: s.articles.filter((a) => a.feedTextChars < THIN_CHARS).length,
    }));

  const fetchArticles = stories
    .filter((s) => (FETCH_TIERS as string[]).includes(s.tier))
    .flatMap((s) => s.articles);
  const fetchStats = articleStats(fetchArticles);

  const byHost = new Map<string, StoryArticle[]>();
  for (const a of fetchArticles) {
    const host = hostOf(a.canonicalUrl);
    const list = byHost.get(host) ?? [];
    list.push(a);
    byHost.set(host, list);
  }
  const hosts: HostStats[] = [...byHost.entries()]
    .map(([host, list]) => ({
      host,
      articles: list.length,
      thinCount: list.filter((a) => a.feedTextChars < THIN_CHARS).length,
    }))
    .sort((a, b) => b.articles - a.articles || a.host.localeCompare(b.host));

  return {
    editorRunId,
    stories: stories.length,
    articles: allArticles.length,
    uniqueUrls: overall.uniqueUrls,
    medianChars: overall.medianChars,
    thinCount: overall.thinCount,
    emptyCount: overall.emptyCount,
    translationFailed: allArticles.filter((a) => a.translationFailed).length,
    tiers,
    buckets: BUCKETS.map((b) => ({ label: b.label, count: bucketCounts.get(b.label) ?? 0 })),
    sources,
    biggestStories,
    hosts,
    fetchScope: {
      tiers: FETCH_TIERS,
      articles: fetchArticles.length,
      uniqueUrls: fetchStats.uniqueUrls,
      thinCount: fetchStats.thinCount,
      hosts: hosts.length,
    },
    unresolved: stories
      .filter((s) => s.unresolved.length > 0)
      .map((s) => ({ ref: s.ref, rank: s.rank, notes: s.unresolved })),
  };
}

function pct(part: number, whole: number): string {
  if (whole === 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

export function formatMaterialsReport(report: MaterialsReport, sourceLimit = 40): string {
  const lines: string[] = [];

  lines.push(`Writer materials audit — editor run #${report.editorRunId}`);
  lines.push(`  Stories:        ${report.stories}`);
  lines.push(`  Articles:       ${report.articles} (${report.uniqueUrls} unique URLs)`);
  lines.push(`  Median body:    ${report.medianChars} chars`);
  lines.push(
    `  Thin (<${THIN_CHARS}):    ${report.thinCount} (${pct(report.thinCount, report.articles)})`,
  );
  lines.push(
    `  Empty body:     ${report.emptyCount} (${pct(report.emptyCount, report.articles)})`,
  );
  lines.push(
    `  Untranslated:   ${report.translationFailed} ` +
      `(translation failed; text is still original-language)`,
  );

  lines.push("");
  lines.push("── PER TIER");
  lines.push("  tier      stories  articles  urls  median  thin  empty");
  for (const t of report.tiers) {
    lines.push(
      `  ${t.tier.padEnd(9)} ${String(t.stories).padStart(7)}  ${String(t.articles).padStart(8)}  ` +
        `${String(t.uniqueUrls).padStart(4)}  ${String(t.medianChars).padStart(6)}  ` +
        `${String(t.thinCount).padStart(4)}  ${String(t.emptyCount).padStart(5)}`,
    );
  }

  lines.push("");
  lines.push("── BODY LENGTH DISTRIBUTION");
  for (const b of report.buckets) {
    const bar = "#".repeat(Math.round((b.count / Math.max(1, report.articles)) * 50));
    lines.push(
      `  ${b.label.padEnd(10)} ${String(b.count).padStart(4)} ` +
        `${pct(b.count, report.articles).padStart(4)}  ${bar}`,
    );
  }

  lines.push("");
  lines.push(`── PER SOURCE (thin-first, top ${sourceLimit})`);
  lines.push("  source                                   articles  median   max  thin  empty");
  for (const s of report.sources.slice(0, sourceLimit)) {
    lines.push(
      `  ${s.sourceName.slice(0, 40).padEnd(40)} ${String(s.articles).padStart(8)}  ` +
        `${String(s.medianChars).padStart(6)} ${String(s.maxChars).padStart(5)}  ` +
        `${String(s.thinCount).padStart(4)}  ${String(s.emptyCount).padStart(5)}`,
    );
  }

  lines.push("");
  lines.push("── BIGGEST STORIES (article count — the dedup and budget pressure)");
  for (const s of report.biggestStories) {
    lines.push(
      `  ${String(s.rank).padStart(3)}. [${s.tier.padEnd(8)}] ${s.ref.padEnd(7)} ` +
        `members=${String(s.members).padStart(2)} articles=${String(s.articles).padStart(2)} ` +
        `chars=${String(s.totalChars).padStart(6)} thin=${s.thinCount}`,
    );
    lines.push(`       ${s.title.slice(0, 100)}`);
  }

  lines.push("");
  lines.push("── FETCH SCOPE");
  lines.push(`  Tiers:          ${report.fetchScope.tiers.join(" + ")}`);
  lines.push(
    `  Articles:       ${report.fetchScope.articles} (${report.fetchScope.uniqueUrls} unique URLs)`,
  );
  lines.push(
    `  Of those thin:  ${report.fetchScope.thinCount} ` +
      `(${pct(report.fetchScope.thinCount, report.fetchScope.articles)})`,
  );
  lines.push(`  Hosts:          ${report.fetchScope.hosts}`);
  lines.push("  Busiest hosts (per-host serialization sizes the run):");
  for (const h of report.hosts.slice(0, 12)) {
    lines.push(
      `    ${h.host.slice(0, 40).padEnd(40)} ${String(h.articles).padStart(4)} articles, ` +
        `${h.thinCount} thin`,
    );
  }

  lines.push("");
  if (report.unresolved.length === 0) {
    lines.push("── UNRESOLVED: none — every story resolved to its articles");
  } else {
    lines.push(`── UNRESOLVED (${report.unresolved.length} stories)`);
    for (const u of report.unresolved) {
      for (const note of u.notes) {
        lines.push(`  ${String(u.rank).padStart(3)}. ${u.ref.padEnd(7)} ${note}`);
      }
    }
  }

  return lines.join("\n");
}
