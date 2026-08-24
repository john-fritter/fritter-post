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
 * 1. **Select** — order the articles, one per parent outlet before a second from
 *    the same one, so the packet reads across the story's sources rather than
 *    down one of them. It does **not** ration: `max_articles` is null on every
 *    tier, and an item that survived collection, prefiltering, grouping and the
 *    editor reaches the writer. Deciding what bears on the piece is the writer's
 *    judgment and nothing upstream can make it — which is the point of gathering
 *    and grouping sources at all.
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
 * 3. **Budget** — normally a no-op, because `total_chars` is null. If a tier is
 *    ever capped, every article gets a floor first so a 12-member thread still
 *    shows every member, then the remainder is shared out under
 *    `per_article_chars`, then whatever is left goes to the articles still
 *    truncated. Trimming lands on a paragraph boundary, never mid-sentence.
 *
 *    A cap here discards reporting, and run #17 showed what that costs: one
 *    source of 9,892 characters was cut to 2,573, and the writer told the reader
 *    the article "does not specify which benefits … are now included" — true of
 *    the text it held and false of the article, because the part naming them was
 *    in the 74% the cap removed.
 *
 * The packet also records what it could *not* give the writer. A story whose
 * sources are all blocked (nytimes.com, oregonlive.com) arrives with headline
 * material and says so, and the prompt tells the writer to write short rather
 * than to fill the gap.
 */

import type { WritersPacketConfig, WritersTierPacketConfig } from "../../config/models.js";
import type { StoryMaterials, StoryArticle, StoryMember } from "./materials.js";
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
  /**
   * Why the source is not in the packet, as the writer needs to understand it.
   *
   * `length` is a source with reporting in it that the budget could not fit —
   * worth telling the writer exists, so it does not go looking for the rest of
   * the story. `no-text` is a source that turned out to have nothing: an empty
   * body, or a body that only repeats its own headline. Nothing is being
   * withheld from the writer there, and saying otherwise is the prompt
   * describing its own plumbing. Run #28's C187 was handed a packet with zero
   * characters and a note claiming one further source had been "left out for
   * length"; the piece it wrote ends "No further details were available from the
   * report."
   */
  kind: "length" | "no-text";
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
  // The separator is whatever the outlet felt like using. Run #20's T1 lead was
  // Le Monde's "EN DIRECT, guerre en Ukraine : …" — a comma, which the original
  // colon-or-dash pattern missed, so 45,000 characters of live blog became a
  // section lead's entire material and it wrote up two other members' stories.
  return /^\s*(?:live|en direct|direct)\b\s*[::,\-–—]|^\s*live blog\b|\blive updates?\b/i.test(
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
  maxArticles: number | null,
): { selected: StoryArticle[]; omitted: PacketOmission[] } {
  const selected: StoryArticle[] = [];
  const takenIds = new Set<number>();
  const seenParents = new Set<string>();
  const full = () => maxArticles !== null && selected.length >= maxArticles;

  // Stable: real articles keep their editorial order, live blogs keep theirs,
  // and the second group only ever fills slots the first did not want.
  const ordered = [
    ...articles.filter((a) => !isLiveBlog(a.title)),
    ...articles.filter((a) => isLiveBlog(a.title)),
  ];

  // First pass: one article per parent outlet, in order.
  for (const article of ordered) {
    if (full()) break;
    if (seenParents.has(article.parentSource)) continue;
    seenParents.add(article.parentSource);
    selected.push(article);
    takenIds.add(article.preprocessedItemId);
  }

  // Second pass: fill remaining slots with the rest, still in order.
  for (const article of ordered) {
    if (full()) break;
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
      kind: "length" as const,
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
 * Three passes, in order:
 *
 * 1. **Floor** — every article gets `floor_chars`, so a 12-member thread shows
 *    every member even when the first three could fill the budget alone.
 * 2. **Fair share** — the remainder is handed out in order, capped at
 *    `per_article_chars`. That cap is a fairness device: it stops one long
 *    source eating a packet that several outlets should share.
 * 3. **Leftovers** — if budget still remains after everyone has hit their cap,
 *    it goes to the articles still truncated, in order.
 *
 * Pass 3 exists because the per-article cap was acting as an absolute ceiling
 * and starving packets that had no one to be fair to. Run #17's rank 32 is one
 * source, 9,892 characters, on a standard tier with a 12,000-character total —
 * and it was cut to 2,573 by `per_article_chars: 3000`, using a fifth of the
 * budget with nothing else competing for it. The writer then told the reader
 * the article "does not specify which benefits … are now included", which was
 * a true observation about the text it was handed and false about the article:
 * the part naming them was in the 74% we cut.
 *
 * So the cap now binds only while there is competition. A 12-article feature
 * still shares fairly first; a single-source piece gets its article.
 */
export function allocateBudget(
  lengths: number[],
  cfg: WritersTierPacketConfig,
): number[] {
  // No cap: every article arrives whole. This is the normal case — see the
  // schema note in src/config/models.ts on why source material is not rationed.
  if (cfg.total_chars === null) return [...lengths];

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

  for (let i = 0; i < lengths.length && remaining > 0; i++) {
    const extra = Math.min(lengths[i]! - allocations[i]!, remaining);
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
  budgetTier?: string,
): WriterPacket {
  // `budgetTier` decouples the budget from the piece's published tier, which
  // only section lines need: a line is stored as a brief and read as a brief,
  // but a brief's 2,500-character budget is what made run #8's lines run 40–47
  // words against a 15–30 target. See assembleSectionPackets.
  const tierKey = budgetTier ?? story.tier;
  const tierCfg = cfg.tiers[tierKey as keyof typeof cfg.tiers] ?? cfg.tiers.brief;

  const { selected, omitted } = selectArticles(story.articles, tierCfg.max_articles);

  const resolvedAll = selected.map((article) => {
    const fetched = textsById.get(article.preprocessedItemId);
    // The longer of the two, not simply the fetched one: a `thin` extraction can
    // come back shorter than the feed teaser, and then the teaser is the better
    // material. The fetcher records the status; the packet just takes the best.
    //
    // **Both are stripped before either is measured**, because furniture is not
    // material and a comparison of raw lengths picks the text that loses more of
    // itself to stripping. Run #28's four cascadepbs.org sources each had a
    // 574-character extraction beat a ~390-character feed body and then strip
    // down to 286 — worse than the teaser it replaced, and worse in a way the
    // raw comparison could not see.
    const feed = stripBoilerplate(article.feedText);
    const fetchedText = fetched ? stripBoilerplate(fetched.text) : null;
    const useFetched = fetchedText !== null && fetchedText.text.length > feed.text.length;
    const stripped = useFetched ? fetchedText : feed;
    const origin = useFetched ? fetched!.origin : ("feed" as const);
    return { article, text: stripped.text, origin, boilerplate: stripped.dropped };
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
      kind: "no-text" as const,
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

  // A headline-only packet gets a structural ceiling, not just a note. Run #8's
  // T1 sidebar S53521 was asked for 120–200 words on headline material and
  // filled the gap with the 1924 Johnson–Reed Act — detail no source carried.
  // Telling a writer to "write short" leaves the target standing; this removes
  // it. Element-wise min, so a tier already shorter than the ceiling keeps its
  // own target.
  const targetWords: [number, number] =
    materialLevel === "headline-only"
      ? [
          Math.min(tierCfg.target_words[0], cfg.headline_only_words[0]),
          Math.min(tierCfg.target_words[1], cfg.headline_only_words[1]),
        ]
      : tierCfg.target_words;

  // These notes are *directions*, not a description of the packet — a
  // distinction run #13 made expensive. They used to open "Material is
  // headline-level only" and "some sources gave only a summary", and six pieces
  // relayed exactly that to the reader: "No further detail was available", "The
  // outlet did not specify the new development in its public feed". The standing
  // memo forbids writing about the sourcing, and the memo is in the system
  // prompt — but the note sat in the user prompt, about this specific piece,
  // handing over the vocabulary. The nearer instruction won.
  //
  // So say what to do and never what the packet is short of. The word target is
  // already capped for a headline-only packet; the note only has to stop the
  // writer reaching past the sources.
  // **A note says what to do, never what the packet is or is not.** The
  // unresolved-sources note used to say how many sources were counted but not
  // reproduced; that named the plumbing and is gone.
  //
  // The two clauses ending "and make no remark about how much they say" went with
  // it, on the theory that a prohibition naming the sourcing plants the sourcing.
  // **Run #31 did not support that theory.** Genuine source-meta sentences went
  // from one piece to two to four as layers came off, and all four of run #31's
  // were in the two material levels whose clause had just been removed —
  // "The article did not specify how many states are expected to act",
  // "The source material previews a broadcast discussion". So a clause comes
  // back, but as the actionable rule rather than the bare prohibition: the memo's
  // actor-versus-outlet distinction, restated at the near distance where this
  // session has repeatedly found the winning instruction lives.
  const notes: string[] = [];
  const gapRule =
    "If a source stops short, the sentence stops with it — write what you have and " +
    "go no further. A gap is worth a sentence only when someone in the story " +
    "withheld something.";
  if (materialLevel === "headline-only") {
    notes.push(
      "Write only what the sources below actually state. If that is two sentences, " +
        "write two sentences and stop. Add no background, context or consequence " +
        "they do not carry. " +
        gapRule,
    );
  } else if (materialLevel === "partial") {
    notes.push(
      `Stay inside what the sources below state; do not extend them. ${gapRule}`,
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
    targetWords,
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

  const sidebarTier = tierBelow(story.tier);
  // A sidebar that lands on brief is budgeted as a sidebar; see below.
  const sidebarBudget = sidebarTier === "brief" ? "sidebar" : undefined;

  /** One member's own material, assembled by the ordinary rules. */
  const storyFor = (member: StoryMember, tier: string): StoryMaterials => ({
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
  });

  const packetFor = (member: StoryMember, tier: string, budgetTier?: string) =>
    assembleWriterPacket(storyFor(member, tier), textsById, cfg, budgetTier);

  // Slot assignment is by score *and* by material, because a slot the material
  // cannot fill is worse than no slot. Members arrive score-ordered; these two
  // rules move them, and neither changes the thread's own score or rank.
  //
  // **A member with nothing to say cannot lead.** The lead establishes the
  // situation the rest of the section hangs off, and a headline cannot do that.
  // Run #13's Gaza section led with a 47-word headline-only piece while a
  // 180-word fully-sourced one ran underneath it as a sidebar. The highest
  // scorer that has real material leads instead; if none does, score order
  // stands and the section is thin in the way its material is thin.
  const leadIndex = members.findIndex(
    (m) => packetFor(m, story.tier).materialLevel !== "headline-only",
  );
  const ordered =
    leadIndex > 0
      ? [members[leadIndex]!, ...members.filter((_, i) => i !== leadIndex)]
      : members;

  // **A member with nothing to say gets a line, not a sidebar.** A line is a
  // pointer and a headline is enough for one; a sidebar is a paragraph, and an
  // empty paragraph-shaped slot is an invitation to fill it. Run #13 filled two
  // of them with prose about the sources — "The outlet did not specify the new
  // development in its public feed" — and one with an asserted development the
  // packet did not contain.
  let sidebarsUsed = 0;
  const roles: SectionRole[] = ordered.map((member, index) => {
    if (index === 0) return "lead";
    if (sidebarsUsed >= cfg.section.max_sidebars) return "line";
    if (packetFor(member, sidebarTier, sidebarBudget).materialLevel === "headline-only") {
      return "line";
    }
    sidebarsUsed++;
    return "sidebar";
  });

  // **The lead is told about every member below it, not just the sidebars.**
  // Run #20's T1 lead wrote a full paragraph on Fedorov's election demand and
  // another on Mudra's corruption resignation — both of which had their own
  // lines further down the section, and neither of which the lead had been told
  // existed. It was only ever handed the sidebar titles, which did not matter
  // while a thread had three or four members and matters a great deal at eleven.
  const titlesOf = (want: SectionRole) =>
    ordered.filter((_, i) => roles[i] === want).map((m) => m.title);
  const sidebarTitles = titlesOf("sidebar");
  const lineTitles = titlesOf("line");
  const belowTheLead = [...sidebarTitles, ...lineTitles];

  return ordered.map((member, index) => {
    const role = roles[index]!;
    const tier = role === "lead" ? story.tier : role === "sidebar" ? sidebarTier : "brief";

    // Section pieces are published at their tier and budgeted at their role.
    //
    // A line is published as a brief because a brief is what a reader sees, but
    // run #8's lines came in at 40–47 words against a 15–30 target: a brief's
    // budget handed them 2,500 characters across several sources, which is
    // enough raw material for a second and third sentence whatever the target
    // says. One source and 900 characters removes the material itself.
    //
    // A sidebar under a standard-tier lead lands on `brief` by the tier ladder
    // and inherits a brief's 25–45 words. Run #10's four such sidebars all wrote
    // 48–53 and read well — a wrong parameter rather than a writing failure,
    // since a sidebar carries one development of a situation the lead already
    // established and that is not a brief's job.
    const budgetTier = role === "line" ? "line" : role === "sidebar" ? sidebarBudget : undefined;
    const packet = packetFor(member, tier, budgetTier);

    // The lead is told everything that runs below it; everything else is told
    // what leads, plus the other pieces it must not step on.
    const siblingTitles =
      role === "lead"
        ? belowTheLead
        : [ordered[0]!.title, ...belowTheLead.filter((t) => t !== member.title)];

    return {
      ...packet,
      section: {
        ref: story.ref,
        title: story.title,
        role,
        rank: index,
        siblingTitles,
      },
    };
  });
}

/**
 * The material level a story would have if it were written at `tier`.
 *
 * Material level is tier-relative by design — `materialLevelOf` reads the
 * tier's own thresholds, so 1,000 characters is headline-only for a feature and
 * partial for a standard piece. That is exactly the property the slot resolver
 * needs: asking "could this story fill a feature slot?" is asking for its level
 * at the feature tier, not at the one the editor happened to assign it.
 *
 * For a thread the answer is its **section lead's** level, because the lead is
 * what occupies the slot. `assembleSectionPackets` has already reordered members
 * so the best-sourced one leads, so the first packet is the right one to read.
 */
export function materialLevelAtTier(
  story: StoryMaterials,
  textsById: Map<number, ResolvedText>,
  cfg: WritersPacketConfig,
  tier: string,
): MaterialLevel {
  const at =
    tier === story.tier ? story : { ...story, tier: tier as StoryMaterials["tier"] };
  return story.itemType === "thread"
    ? assembleSectionPackets(at, textsById, cfg)[0]!.materialLevel
    : assembleWriterPacket(at, textsById, cfg).materialLevel;
}

/** One story as the slot resolver sees it: where it sits, and what it could fill. */
export interface TierCandidate {
  ref: string;
  rank: number;
  tier: string;
  /** Material level this story would have at each tier the resolver considers. */
  levels: Map<string, MaterialLevel>;
}

/** A slot that changed hands, kept so the run can say what it did and why. */
export interface TierSwap {
  tier: string;
  /** The story that could not fill the slot, and where it went instead. */
  ref: string;
  rank: number;
  demotedTo: string;
  /** The story that took the slot, and what it gave up to take it. */
  takerRef: string;
  takerRank: number;
  takerFrom: string;
}

/**
 * Reassigns tier slots a story's material cannot fill.
 *
 * **A slot the material cannot fill is worse than no slot.** The editor assigns
 * tiers by rank position alone — feature 15, standard 60, brief 75 — and its
 * formula is `relevance + source_weight·ln(sources)`, which knows nothing about
 * whether any text exists behind the story. Nothing downstream corrected that,
 * so run #42 published 37 of 150 pieces on headline-only material, including
 * three of its fifteen features. Rank 7 (S61342, OregonLive) ran one sentence
 * and then, below a horizontal rule, a note to whoever was reading: "That's all
 * the source carries." Rank 18 (S61618) was twenty-four words ending "the New
 * York Times reports". Rank 62 (S61332, a Google News item, which `sources.yaml`
 * already records as structurally unfetchable) wrote "No further details on the
 * outbreak's scale, location, or the vaccination campaign were available from
 * the source."
 *
 * Those are not writing failures. Every one of them is a writer obeying a
 * headline-only packet's own instruction — write what you have and stop — inside
 * a slot that promised four hundred words. The pipeline knew the material was
 * absent before the call was made: the fetch cooldown had already given up on
 * oregonlive.com and nytimes.com, and a Google News link has never had an
 * article behind it.
 *
 * **This is the section rule, applied to the paper.** `assembleSectionPackets`
 * has picked a thread's lead by material rather than by score since run #13, for
 * the same reason at a smaller scale. Here the unit is the paper's tiers.
 *
 * **It swaps rather than demotes**, so the paper keeps its shape: fifteen
 * features every day, not twelve on a day the local outlets blocked us. A
 * headline-only story trades tiers with the nearest-ranked story below it that
 * *can* fill the slot, which is also the fix for the other half of the problem —
 * run #42's ranks 16 and 17 were fully-sourced 208- and 213-word standards that
 * would have made real features. Score and rank are never touched; only the
 * treatment moves. A story can therefore sit high in the ranking and run short,
 * which is the honest outcome when a story matters and the text is not there.
 *
 * `ladder` is the tiers, most prominent first, whose slots require real
 * material; anything outside it (brief) is below all of them and accepts
 * headline material, because a brief is a pointer and a headline is enough for
 * one. An empty ladder disables the rule.
 */
export function resolveTiersByMaterial(
  candidates: TierCandidate[],
  ladder: string[],
): { tiers: Map<string, string>; swaps: TierSwap[] } {
  const tiers = new Map(candidates.map((c) => [c.ref, c.tier]));
  const swaps: TierSwap[] = [];
  if (ladder.length === 0) return { tiers, swaps };

  const byRank = [...candidates].sort((a, b) => a.rank - b.rank);
  // Anything off the ladder sits below every tier on it.
  const depth = (tier: string) => {
    const i = ladder.indexOf(tier);
    return i === -1 ? ladder.length : i;
  };
  const canFill = (c: TierCandidate, tier: string) =>
    (c.levels.get(tier) ?? "headline-only") !== "headline-only";

  // Top-down, so a story demoted out of feature is reconsidered for the standard
  // slot it lands in and demoted again if it cannot fill that either. Each swap
  // moves the failing story strictly downwards, so this terminates.
  for (const tier of ladder) {
    for (const hole of byRank) {
      if (tiers.get(hole.ref) !== tier || canFill(hole, tier)) continue;

      // The nearest story below this tier that can fill it. Nearest, so the
      // promotion reaches as short a distance down the ranking as it can.
      const taker = byRank.find(
        (c) => depth(tiers.get(c.ref)!) > depth(tier) && canFill(c, tier),
      );
      // A day on which nothing below has material either. Leave the slot alone:
      // the packet's own ceiling still keeps the piece short and honest.
      if (taker === undefined) break;

      const takerFrom = tiers.get(taker.ref)!;
      tiers.set(hole.ref, takerFrom);
      tiers.set(taker.ref, tier);
      swaps.push({
        tier,
        ref: hole.ref,
        rank: hole.rank,
        demotedTo: takerFrom,
        takerRef: taker.ref,
        takerRank: taker.rank,
        takerFrom,
      });
    }
  }

  return { tiers, swaps };
}
