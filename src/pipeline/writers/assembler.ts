/**
 * The prompt assembler: resolved materials → one writer packet per story.
 *
 * Pure functions over the resolver's output. No database, no network, no LLM —
 * which is the point. The writer package (angle, length, editorial notes) was
 * once going to be produced by an LLM step between the editor and the writers;
 * it isn't, because there is no judgment left to make. The bio-aware judgment
 * already happened twice upstream. What is actually missing before a writer can
 * work is *material*, fitted to a budget, and that is arithmetic.
 *
 * Three jobs, in this order:
 *
 * 1. **Select** — cap the article count per tier, taking one article per outlet
 *    before a second from the same one. T3 in run #112 carried 27 articles across
 *    12 members; a writer needs the range of sources, not every wire copy of the
 *    same paragraph.
 *
 * 2. **Deduplicate paragraphs** — drop any paragraph an earlier article in the
 *    same packet already said, verbatim. This is what syndication actually looks
 *    like: three outlets running the same AP copy under different ledes.
 *
 *    Note what this deliberately does *not* do. An earlier plan for this stage
 *    had near-duplicate suppression by embedding cosine, using the vectors
 *    grouping already stores. That is exactly wrong here: every member of a
 *    cluster is the same event by construction — high cosine is why they
 *    clustered — so a cosine threshold would delete the corroboration the
 *    packet exists to provide. Verbatim repetition is the only duplication a
 *    writer does not want.
 *
 * 3. **Budget** — every selected article gets a floor allocation so a 12-member
 *    thread still shows every member, and the remainder goes to the top-ranked
 *    articles up to a per-article cap. Trimming lands on a paragraph boundary,
 *    never mid-sentence.
 *
 * The packet also records what it could *not* give the writer. A story whose
 * sources are all blocked (nytimes.com, oregonlive.com) arrives with headline
 * material and says so, and the prompt tells the writer to write short rather
 * than to fill the gap.
 */

import type { WritersPacketConfig, WritersTierPacketConfig } from "../../config/models.js";
import type { StoryMaterials, StoryArticle } from "./materials.js";
import { stripBoilerplate, isHeadlineEcho } from "./boilerplate.js";

/** Best available text for one article, and where it came from. */
export interface ResolvedText {
  text: string;
  origin: "fetched" | "feed";
}

export interface PacketArticle {
  preprocessedItemId: number;
  memberRef: string;
  sourceName: string;
  parentSource: string;
  title: string;
  url: string;
  publishedAt: Date | null;
  /** Text as it will appear in the prompt: deduplicated, then budget-trimmed. */
  text: string;
  chars: number;
  /** Characters available before the budget cut. */
  availableChars: number;
  truncated: boolean;
  origin: "fetched" | "feed";
  /** Paragraphs dropped because an earlier article in this packet said them. */
  duplicateParagraphs: number;
  /** Paragraphs removed as publisher furniture before anything else ran. */
  boilerplateParagraphs: number;
  translationFailed: boolean;
}

export interface PacketOmission {
  preprocessedItemId: number;
  sourceName: string;
  title: string;
  reason: string;
}

/**
 * How much real material the writer has. Tier sets the ceiling on length;
 * this sets the floor. A blocked-source story is written short and honestly.
 */
export type MaterialLevel = "full" | "partial" | "headline-only";

/**
 * A piece's place in a section. `lead` is the section's main piece, `sidebar`
 * its own development at one tier below, `line` a single sentence so a minor
 * member is still visible. Null for an ordinary standalone story.
 */
export type SectionRole = "lead" | "sidebar" | "line";

export interface PacketSection {
  /** The thread's ref, e.g. T3 — the heading every piece in the section shares. */
  ref: string;
  title: string;
  role: SectionRole;
  /** 0 for the lead, then 1..n in reading order. */
  rank: number;
  /**
   * What the *other* pieces in this section cover. The lead is told what runs
   * below it and a sidebar is told what the lead covers, so no two pieces retell
   * the same development — the only coordination a section needs, and it is
   * static text rather than a call.
   */
  siblingTitles: string[];
}

export interface WriterPacket {
  /** editor_stories.id, carried through for the written piece's lineage. */
  storyId: number | null;
  /** Set when this piece is part of a thread's section. */
  section: PacketSection | null;
  rank: number;
  tier: string;
  ref: string;
  itemType: string;
  title: string;
  summary: string;
  score: number;
  /** Source count as the editor ranked it — not the article count in this packet. */
  sourceCount: number;
  targetWords: [number, number];
  materialLevel: MaterialLevel;
  articles: PacketArticle[];
  omitted: PacketOmission[];
  /** Things the writer must know about the material, in plain language. */
  notes: string[];
  totalChars: number;
}

const PARAGRAPH_SPLIT = /\n{2,}/;

/** Normalized form for duplicate detection: whitespace and case are not content. */
export function normalizeParagraph(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Drops paragraphs already said, verbatim, by an earlier article in the packet.
 * Short paragraphs are exempt: a dateline, a one-line attribution, or "Reuters
 * contributed to this report" repeating across outlets is not the redundancy
 * this is for, and dropping them would silently reshape a lede.
 */
export function dedupeParagraphs(
  texts: string[],
  minChars: number,
): { texts: string[]; dropped: number[] } {
  const seen = new Set<string>();
  const out: string[] = [];
  const dropped: number[] = [];

  for (const text of texts) {
    let dropCount = 0;
    const kept: string[] = [];
    for (const para of text.split(PARAGRAPH_SPLIT)) {
      const trimmed = para.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.length < minChars) {
        kept.push(trimmed);
        continue;
      }
      const key = normalizeParagraph(trimmed);
      if (seen.has(key)) {
        dropCount++;
        continue;
      }
      seen.add(key);
      kept.push(trimmed);
    }
    out.push(kept.join("\n\n"));
    dropped.push(dropCount);
  }

  return { texts: out, dropped };
}

/**
 * A live blog is not an article. It is one page carrying a day of entries about
 * many stories, wrapped in comment boxes and pointers to other coverage, and its
 * extracted text is mostly not about the story it was clustered into. Run #112's
 * rank 3 spent 5,954 characters of feature budget on Le Monde's Ukraine live
 * blog, and the reviewer flagged it twice.
 *
 * Detected from the title, which live blogs announce plainly, and used only to
 * push them behind real articles in selection — never to delete them. On a
 * 27-candidate thread the live blog falls out of the packet; on a story where it
 * is the only source, it is still the source.
 */
export function isLiveBlog(title: string): boolean {
  return /^\s*(?:live|en direct|direct)\b\s*[::-]|^\s*live blog\b|\blive updates?\b/i.test(
    title,
  );
}

/**
 * Selects which articles reach the packet: one per parent outlet first, then
 * seconds and thirds in the same order, up to the tier's cap.
 *
 * Members arrive score-ordered and their articles chronological, so the first
 * pass takes the best source from each outlet in editorial order. Live blogs go
 * last within each pass. Everything beyond the cap is recorded as an omission
 * rather than silently dropped.
 */
export function selectArticles(
  articles: StoryArticle[],
  maxArticles: number,
): { selected: StoryArticle[]; omitted: PacketOmission[] } {
  const selected: StoryArticle[] = [];
  const takenIds = new Set<number>();
  const seenParents = new Set<string>();

  // Stable: real articles keep their editorial order, live blogs keep theirs,
  // and the second group only ever fills slots the first did not want.
  const ordered = [
    ...articles.filter((a) => !isLiveBlog(a.title)),
    ...articles.filter((a) => isLiveBlog(a.title)),
  ];

  // First pass: one article per parent outlet, in order.
  for (const article of ordered) {
    if (selected.length >= maxArticles) break;
    if (seenParents.has(article.parentSource)) continue;
    seenParents.add(article.parentSource);
    selected.push(article);
    takenIds.add(article.preprocessedItemId);
  }

  // Second pass: fill remaining slots with the rest, still in order.
  for (const article of ordered) {
    if (selected.length >= maxArticles) break;
    if (takenIds.has(article.preprocessedItemId)) continue;
    selected.push(article);
    takenIds.add(article.preprocessedItemId);
  }

  const omitted: PacketOmission[] = ordered
    .filter((a) => !takenIds.has(a.preprocessedItemId))
    .map((a) => ({
      preprocessedItemId: a.preprocessedItemId,
      sourceName: a.sourceName,
      title: a.title,
      reason: isLiveBlog(a.title)
        ? `live blog, ranked behind articles (cap ${maxArticles})`
        : `beyond the ${maxArticles}-article cap for this tier`,
    }));

  return { selected, omitted };
}

/**
 * Trims to at most `cap` characters, preferring a paragraph boundary and
 * falling back to a sentence end. A writer quoting a half-sentence is a defect
 * the assembler can prevent for free.
 */
export function trimToBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const window = text.slice(0, cap);

  const lastPara = window.lastIndexOf("\n\n");
  // Only honour a paragraph break that keeps most of the allowance; otherwise a
  // long final paragraph would throw away nearly the whole budget.
  if (lastPara > cap * 0.5) return window.slice(0, lastPara).trimEnd();

  const lastSentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf(".\n"),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
  );
  if (lastSentence > cap * 0.5) return window.slice(0, lastSentence + 1).trimEnd();

  return window.trimEnd();
}

/**
 * Distributes the tier's character budget across the selected articles.
 *
 * Every article gets a floor first, so a 12-member thread shows every member
 * even when the first three could fill the budget alone. The remainder is
 * handed out in order, capped per article. Anything an article does not need
 * stays in the pool for the ones that do.
 */
export function allocateBudget(
  lengths: number[],
  cfg: WritersTierPacketConfig,
): number[] {
  const allocations = lengths.map((len) => Math.min(len, cfg.floor_chars));
  let remaining = cfg.total_chars - allocations.reduce((a, b) => a + b, 0);

  if (remaining <= 0) return allocations;

  for (let i = 0; i < lengths.length && remaining > 0; i++) {
    const ceiling = Math.min(lengths[i]!, cfg.per_article_chars);
    const extra = Math.min(ceiling - allocations[i]!, remaining);
    if (extra > 0) {
      allocations[i]! += extra;
      remaining -= extra;
    }
  }

  return allocations;
}

/**
 * Material level is judged against the tier's own thresholds, not one global
 * pair. A standard piece is 120–200 words and a feature is 400–600, so the same
 * 1,000 characters of source is thin for one and adequate for the other — and
 * with a single threshold, run #112 labelled a Guardian standard story
 * "headline-only" while it carried four usable facts.
 */
function materialLevelOf(chars: number, cfg: WritersTierPacketConfig): MaterialLevel {
  if (chars >= cfg.full_material_chars) return "full";
  if (chars >= cfg.thin_material_chars) return "partial";
  return "headline-only";
}

/**
 * Builds one story's packet. `textsById` supplies fetched text where the
 * fetcher got any; anything missing falls back to the feed body, which is why
 * a blocked host degrades the piece rather than emptying it.
 */
export function assembleWriterPacket(
  story: StoryMaterials,
  textsById: Map<number, ResolvedText>,
  cfg: WritersPacketConfig,
): WriterPacket {
  const tierCfg = cfg.tiers[story.tier as keyof typeof cfg.tiers] ?? cfg.tiers.brief;

  const { selected, omitted } = selectArticles(story.articles, tierCfg.max_articles);

  const resolvedAll = selected.map((article) => {
    const fetched = textsById.get(article.preprocessedItemId);
    // The longer of the two, not simply the fetched one: a `thin` extraction can
    // come back shorter than the feed teaser, and then the teaser is the better
    // material. The fetcher records the status; the packet just takes the best.
    const best =
      fetched && fetched.text.length > article.feedText.length
        ? { text: fetched.text, origin: fetched.origin }
        : { text: article.feedText, origin: "feed" as const };
    // Furniture comes off before anything measures the text, so a source is not
    // judged usable on the strength of a copyright line.
    const stripped = stripBoilerplate(best.text);
    return { article, text: stripped.text, origin: best.origin, boilerplate: stripped.dropped };
  });

  // A source whose body says nothing the headline did not adds a slot and no
  // information. Run #112's rank 3 spent one of its twelve on a Google News stub
  // reading `Poland says it thwarted a Russian plot … apnews.com` — the headline
  // and the domain. Length alone cannot make this call: a 90-character Al
  // Jazeera summary in the same packet carries a real fact, so the test is
  // whether the body echoes the headline, plus a floor for the empties.
  //
  // The story's source count is the editor's and is unaffected — this is about
  // what the writer reads. And the packet is never emptied: if every article is
  // a stub the best one stays, and the material level says what it is.
  const usable = resolvedAll.filter(
    (r) => r.text.length >= cfg.min_article_chars && !isHeadlineEcho(r.article.title, r.text),
  );
  const resolved = usable.length > 0 ? usable : resolvedAll.slice(0, 1);
  for (const r of resolvedAll) {
    if (resolved.includes(r)) continue;
    omitted.push({
      preprocessedItemId: r.article.preprocessedItemId,
      sourceName: r.article.sourceName,
      title: r.article.title,
      reason:
        r.text.length < cfg.min_article_chars
          ? `no usable body text (${r.text.length} chars after cleanup)`
          : "body text only repeats the headline",
    });
  }

  const { texts: deduped, dropped } = dedupeParagraphs(
    resolved.map((r) => r.text),
    cfg.min_dedup_paragraph_chars,
  );

  const allocations = allocateBudget(
    deduped.map((t) => t.length),
    tierCfg,
  );

  const articles: PacketArticle[] = resolved.map((r, i) => {
    const full = deduped[i]!;
    const text = trimToBoundary(full, allocations[i]!);
    return {
      preprocessedItemId: r.article.preprocessedItemId,
      memberRef: r.article.memberRef,
      sourceName: r.article.sourceName,
      parentSource: r.article.parentSource,
      title: r.article.title,
      url: r.article.canonicalUrl,
      publishedAt: r.article.publishedAt,
      text,
      chars: text.length,
      availableChars: full.length,
      truncated: text.length < full.length,
      origin: r.origin,
      duplicateParagraphs: dropped[i]!,
      boilerplateParagraphs: r.boilerplate,
      translationFailed: r.article.translationFailed,
    };
  });

  const totalChars = articles.reduce((sum, a) => sum + a.chars, 0);
  // Measured on what the story *has*, not on what the budget chose to show. A
  // brief's budget is 2,500 characters, so scoring the trimmed total would label
  // every brief "partial" and attach a warning about thin sourcing to stories
  // that are merely short by design.
  const availableChars = articles.reduce((sum, a) => sum + a.availableChars, 0);
  const materialLevel = materialLevelOf(availableChars, tierCfg);

  const notes: string[] = [];
  if (materialLevel === "headline-only") {
    notes.push(
      "Material is headline-level only. Write to the short end of the target and " +
        "state only what the sources state — do not supply detail they do not carry.",
    );
  } else if (materialLevel === "partial") {
    notes.push(
      "Material is partial: some sources gave only a summary. Stay close to what is here.",
    );
  }
  const duplicatesDropped = articles.reduce((sum, a) => sum + a.duplicateParagraphs, 0);
  if (duplicatesDropped > 0) {
    notes.push(
      `${duplicatesDropped} paragraph(s) repeated verbatim across sources were removed; ` +
        "the outlets carrying them are still listed.",
    );
  }
  if (articles.some((a) => a.translationFailed)) {
    notes.push(
      "One or more sources are in their original language — translation failed. " +
        "Use them only if you can read them.",
    );
  }
  if (story.unresolved.length > 0) {
    notes.push(
      `${story.unresolved.length} of the editor's source(s) could not be resolved; ` +
        "the source count above still reflects what the editor ranked.",
    );
  }

  return {
    storyId: story.storyId,
    section: null,
    rank: story.rank,
    tier: story.tier,
    ref: story.ref,
    itemType: story.itemType,
    title: story.title,
    summary: story.summary,
    score: story.score,
    sourceCount: story.sourceCount,
    targetWords: tierCfg.target_words,
    materialLevel,
    articles,
    omitted,
    notes,
    totalChars,
  };
}

/** A sidebar runs one tier below its lead; a line is always brief-tier. */
function tierBelow(tier: string): string {
  if (tier === "feature") return "standard";
  return "brief";
}

/**
 * Expands a thread into the pieces of a section: a lead, sidebars, and lines.
 *
 * **Why this exists.** Threading absorbs a situation's rows into one ranked
 * story, which is right for ranking and wrong for writing. Run #3 put T1's
 * twelve members into one 500-word slot; the writer, told to find a spine, wrote
 * one of them and dropped eleven — including a story scoring 81 while the paper
 * ran a 35-word brief on one scoring 56. Nobody chose that; it fell out of the
 * structure.
 *
 * **Why no coordination is needed.** A thread's members are distinct events by
 * construction — grouping separated them, threading gathered them — so material
 * partitions cleanly by member. Each piece is assembled from its own member's
 * articles alone, which makes overlap between two pieces of a section
 * structurally impossible. The writers still never see each other's work; they
 * are only told, in static text, what the others cover so nobody retells it.
 *
 * Members arrive score-ordered from the resolver, so the split is deterministic:
 * the top member leads, the next `max_sidebars` get their own piece one tier
 * down, and everything else gets a line. Nothing is dropped.
 */
export function assembleSectionPackets(
  story: StoryMaterials,
  textsById: Map<number, ResolvedText>,
  cfg: WritersPacketConfig,
): WriterPacket[] {
  const members = story.members.filter((m) => m.articles.length > 0);
  if (members.length === 0) return [assembleWriterPacket(story, textsById, cfg)];

  // A one-member thread is not a section; it is a story that happens to have
  // been threaded. Write it the ordinary way.
  if (members.length === 1) return [assembleWriterPacket(story, textsById, cfg)];

  const sidebarCount = Math.min(cfg.section.max_sidebars, members.length - 1);
  const roleOf = (index: number): SectionRole =>
    index === 0 ? "lead" : index <= sidebarCount ? "sidebar" : "line";

  return members.map((member, index) => {
    const role = roleOf(index);
    const tier =
      role === "lead" ? story.tier : role === "sidebar" ? tierBelow(story.tier) : "brief";

    // One member's own material, assembled by the ordinary rules.
    const memberStory: StoryMaterials = {
      ...story,
      ref: member.ref,
      itemType: member.itemType,
      title: member.title.length > 0 ? member.title : story.title,
      summary: member.summary,
      score: member.score,
      sourceCount: member.sourceCount,
      tier: tier as StoryMaterials["tier"],
      members: [member],
      articles: member.articles,
    };

    const packet = assembleWriterPacket(memberStory, textsById, cfg);

    // The lead is told what runs below it; everything else is told what leads.
    const siblingTitles =
      role === "lead"
        ? members.slice(1, sidebarCount + 1).map((m) => m.title)
        : [members[0]!.title];

    return {
      ...packet,
      section: {
        ref: story.ref,
        title: story.title,
        role,
        rank: index,
        siblingTitles,
      },
      // A line is one sentence whatever its tier's usual target says.
      targetWords: role === "line" ? cfg.section.line_words : packet.targetWords,
    };
  });
}
