# The Fritter Post — Project Document

A planning document for a personal newspaper project. The concept and the pipeline architecture are the load-bearing parts. Most other details below are starting points, written down so they're not lost, but subject to revision once implementation gets real.

---

## What it is

A self-hosted personal newspaper at `post.fritter.lol`. Runs on a daily cron, gathers and synthesizes news from a curated source set, and serves a clean ad-free page. Knows who its reader is and what matters to him. Has an editorial perspective. Built to be finite — when you're done reading it, you're done.

Not a feed. Not a chatbot. Not a dashboard. Not optimizing for engagement.

## Core principles

These are the things the project is *for*. Implementation details exist to serve these.

- **One reader.** Built for one person. Personalization is declarative — the reader maintains a bio file, and the system reads it — not inferred from clicks.
- **Ranked, not sectioned.** Stories ordered by relevance, with small domain tags for orientation. Top stories get larger visual treatment so the morning-glance affordance survives.
- **Variable register.** Some stories deserve a feature; some a paragraph; some a line; some just an acknowledgment in a footer. The system decides per-story.
- **Anti-clickbait, anti-media-ism.** Headlines say what happened. No teasing, no hooks, no manufactured stakes. Plain, direct, slightly conversational but still formal.
- **Editorial perspective.** Events covered from the perspective of ordinary people affected by decisions, not from the perspective of institutions making them. Active voice with named actors. Symmetric skepticism. Influences: I.F. Stone, Howard Zinn, Jacobin at its best, ProPublica's accountability journalism.
- **Curate, don't reproduce.** Other people's writing surfaced by pointing at it. The paper's framing and summaries are its own; full text stays at the source.
- **Slow days are honored.** Short paper on a quiet day, not padded paper. The system is allowed to say "light news today."
- **Continuity matters.** Today's paper is aware of yesterday's. Stories develop or quietly don't recur.
- **Finite artifact.** The reader can finish it.

## Pipeline architecture

The paper is produced by a daily cron running nine stages.

```
1. Collector (software)
   ↓
2. Preprocessor (software)
   ↓
3. Prefilter (bio-aware relevance floor, LLM)
   ↓
4. Grouping (embedding-based clustering — same event?)
   ↓
5. Grouping-pass-1 (bio-aware scoring, LLM)
   ↓
6. Thread (same ongoing situation?, LLM)
   ↓
7. Editor (deterministic ranking + tiering, LLM tie-break only)
   ↓
8. Writers (parallel LLM calls)
   ↓
9. Publisher (software)
```

All nine stages are built.

**This section has been reconciled with what was actually built.** The
original conception had seven stages including an agentic *Researcher*
between grouping and the editor. That stage was dropped — see
`docs/decisions.md`. The editor's ranked, tiered output feeds the writers
directly.

### Stage 1: Collector (software)

Hits every configured source. RSS where available; direct fetches for places that don't publish feeds. Writes raw items to storage. Aggressively dumb — no judgment, no deduplication, no extraction. Failure-tolerant: a dead feed is logged and skipped.

Cross-source duplication is preserved here because later stages use it as signal.

### Stage 2: Preprocessor (software)

Sits between collector and grouping. Does the obvious mechanical work the LLM shouldn't be wasting tokens on:

- URL canonicalization (strip tracking params, normalize AMP, etc.)
- Exact-URL deduplication
- Title similarity clustering (token Jaccard or normalized Levenshtein)
- Source-count aggregation per cluster (prominence signal)
- Timestamp normalization
- Category inheritance from source config
- Continuity matching against yesterday's clusters

The LLM should never be the first entity to notice that ten articles have nearly identical headlines. Software handles it deterministically.

### Stage 3: Prefilter (bio-aware relevance floor)

A relevance floor between the preprocessor and the clusterer, and the first stage that reads the bio. Each item gets one of three verdicts: `cut` for noise this reader has no interest in and non-article material, `news` for anything flowing into clustering, `opinion` for pieces routed out of clustering toward a Longer Reads section.

Conservative by design: when unsure, keep. A low-interest topic becomes a keep the moment it carries a substantive angle.

### Stage 4: Grouping (embedding-based clustering)

Clusters the kept news items into same-story groups. Each item's title and body excerpt is embedded; a cosine-similarity graph plus union-find produces candidate clusters, an LLM attach pass pulls in near-miss singletons, and a final LLM describe pass writes a neutral title and summary for each multi-item cluster. The output is a flat digest of clusters and singletons.

Mostly software, with two cheap bounded LLM passes (attach, describe). The primary tuning lever is the similarity threshold: higher means fewer, tighter groups; lower means more, looser groups.

(This replaces the original conception of an LLM "triage" digest. The earlier LLM-based triage clusterer was removed once embedding-based grouping proved out — see `docs/decisions.md`.)

### Stage 5: Grouping-pass-1 (bio-aware scoring)

Scores every grouping output row — clusters and singletons on the same 0–100 scale — for relevance to this reader. Clusters are scored on their describe-pass title and summary; singletons on title plus body excerpt. Source count is deliberately withheld from the scorer: this judgment is purely about reader relevance, and prominence is applied later by the editor's formula.

Sorts by score and takes the top `grouping.pile_target` rows as the editor pile.

### Stage 6: Thread (same ongoing situation?)

Groups related clusters and singletons into one continuing story. Grouping asks whether two articles cover the same *event*; threading asks whether several events are the same *situation* — a state's fire emergency, one war, one city's fight over one project.

Both questions are needed and neither can answer the other. That separation is what lets event clustering stay strict: grouping can split an over-merge without the paper losing the connection, because threading puts it back at the right level.

A thread carries `max(member score)` as relevance and `sum(member sources)` as prominence, so it is a first-class row the editor ranks with the same formula as everything else — not presentation metadata.

The line to hold is between a concrete situation anchored in a place and a time, and an abstract theme spanning unrelated places and actors. Fires in Oregon and fires in Spain are two threads. Data centers straining grids in three states is a topic, not a situation.

### Stage 7: Editor (deterministic ranking + tiering)

Not an LLM ranker. The editor combines the pass-1 relevance score with a prominence lift derived from cross-source pickup:

```
combined = relevance + source_weight * ln(sources)
```

Rows sort by combined score, and tiers are assigned by rank position from fixed counts (feature / standard / brief). The only LLM involvement is a bio-aware tie-break among items sharing an identical combined score.

This replaced an earlier conception of the editor as an orchestrated multi-call LLM producing per-piece writer packages. Ranking and tiering turned out to be a scoring problem, not a judgment problem — the judgment lives in prefilter and grouping-pass-1, both of which read the bio. See `docs/decisions.md`.

**Resolved (2026-08-13):** the writer package is assembled by software, not authored by a model. Tier sets the length target and register, the bio says who the piece is for, a standing memo carries the voice, and a materials resolver plus an article-text fetch supply the source material. A package-creation LLM step would be a judgment stage with nothing new to judge on — the bio-aware judgment already happened in the prefilter and grouping-pass-1. See `docs/decisions.md`.

### Stage 8: Writers (parallel LLM calls)

One call per piece. Writers run in parallel — no inter-dependencies. Each writer receives the source material for its story, a target length driven by tier, and the paper's voice.

Writers don't see each other's work.

The stage is three pieces, of which the first two are built:

1. **Materials resolver** — walks a ranked story back to the articles underneath it, across threads, clusters and singletons.
2. **Article-text fetch** — most feeds carry a teaser rather than a body (61% of run #112's articles were under 800 characters), so the articles the feed left short are fetched from the publisher and extracted. The text is used to write the paper and never published.
3. **Prompt assembler** — selects, deduplicates and budgets that material into one prompt per piece, then makes the calls: one per feature and standard piece, briefs in batches. A failed call costs one piece, never the edition.

A thread does not become one piece. It becomes a **section**: a lead, several sidebars at one tier below, and a one-sentence line for each remaining member, all under one heading. One slot cannot hold a situation — either the writer tours every event and produces a list, or it picks one and silently drops the rest. Because a thread's members are distinct events by construction, material partitions cleanly by member and the pieces of a section cannot overlap, so no writer needs to see another's work. Sections displace the lowest-ranked standalone stories, keeping the paper finite.

### Stage 9: Publisher (software)

Pure rendering. Takes the writer run and freezes it into a paper: the prose as
written, plus the attribution resolved from the lineage underneath it. No
judgment — every editorial decision was made upstream, and this stage reorders
nothing and drops nothing except pieces the writers never produced.

It exists as a stage rather than as a query because a paper is a daily artifact.
Re-running grouping tomorrow must not change what yesterday's paper said, and
`writer_pieces` cannot produce a source link on its own — the URLs are three
joins away, through the walk the writers' materials resolver already does.

The publisher is designed to be tolerant, and records what it tolerated: a
failed writer piece is skipped and counted, and a piece whose lineage will not
resolve is published without links and counted separately. Neither costs the
edition.

---

## Storage

Postgres. Already running for Fritterflix on the same box, so this is a reuse rather than new infrastructure.

Tables roughly: raw items (collector output), preprocessed items, grouping digests, pass-1 scores, editor piles, finished stories, papers, sources, feeds, feedback, generation logs. Raw items get a retention window (rolling deletion); everything else is durable.

Schema details are not decided. The point is: structured data through the pipeline, full lineage from raw input to published story, every LLM call logged with model, prompts, outputs, token counts.

---

## Models and configuration

Every LLM stage is independently configurable via a config file. The pipeline is model-agnostic; any OpenAI-compatible provider works. Starting plan uses Ollama Cloud Pro.

Current thinking on assignments (subject to revision once we see how each stage actually performs):

- **Grouping:** embedding model (`qwen/qwen3-embedding-8b`) for clustering, plus a cheap LLM (GLM) for the attach and describe passes
- **Prefilter and grouping-pass-1:** GLM — bio-aware judgment at batch scale; these carry the editorial weight that was once imagined for the editor
- **Editor:** no primary model — the ranking is a deterministic formula. GLM handles only the tie-break calls
- **Writers:** GLM — strong prose quality, comfortable in the editorial register

All tunable. Per-stage parameters in config include model, token budgets, step limits for agentic loops, temperature, retry behavior.

---

## Documents the system reads

Several human-readable files travel through the pipeline. Each has a defined role; keeping them separate prevents any one from becoming a junk drawer.

- **Bio file.** Slow-changing. Who the reader is — location, work, interests, projects, values, what they care about, what they don't.
- **Standing memo.** The editorial document. Voice, stance, what the paper covers, how it sounds, how it handles register across sizes. Written as instructions to a new editor, not as a spec. Not currently written — an earlier draft was dissolved into the prefilter and editor prompts (see `docs/decisions.md`, 2026-06-13). Now that ranking is deterministic, its remaining job is *voice*, which makes it a writers-stage document rather than an editor one.
- **Source policy.** Operational. Source tier list, how to handle police statements, press releases, social media claims, rumors, paywalled sources, primary-source preferences, cross-source verification thresholds. Lives with the writers.
- **Pre-written preferences.** Human-maintained. Standing instructions from the reader: "I keep marking Apple launches not interesting, please honor that."
- **Observed preferences.** Agent-updated based on reader comments. Dated entries so they can be pruned when they drift. Carries less weight than pre-written preferences.

The standing memo is probably the single most consequential artifact in the project. Worth writing carefully before the code, and worth iterating on as the paper produces output that reveals its gaps.

---

## Editorial principles the standing memo will need to encode

These came out of the planning conversations and should make it into the memo in some form. Not exhaustive, and exact wording is for the memo itself.

- Anti-media-isms: no trailing-question headlines, no "what you need to know about," no "sparked outrage," no manufactured stakes, no hook-and-payoff cadence designed to drive scroll.
- Active voice with named actors as default. "Police shot a man" not "an officer-involved shooting occurred."
- "Alleged" only for genuine factual uncertainty or pending legal process. Not as verbal genuflection to power, not applied asymmetrically.
- Attribution as a claim, not a fact. "Police say X" is a claim by police, not a fact about X.
- Symmetric skepticism — the lens applies to all actors with power, not selectively.
- Center the people affected by decisions, not the people making them.
- Earn vivid phrases through sourcing. Card-length writing stays close to plain description; metaphor and analytical framing belong in features where evidence supports them.
- Mainstream sources cited where they support unconventional claims — pre-empts framing fights.
- Slow news days produce short papers. Don't pad.
- Continuity: today's paper aware of yesterday's, develops or quietly drops threads.

---

## Reader interaction

Starting simple, with room to grow.

- **Comments per story.** A field on each card. The reader writes notes; the next day's editor stage reads them. Inline-collapsed in the UI (small "add note" link expanding to a textarea) so the reading view stays clean.
- **"Copy as markdown" per card.** Exports the article with attribution header in a format suitable for pasting into another tool. The paper is the primary artifact; conversation about it happens elsewhere.
- **Outside long-reads** are surfaced with substantial context paragraphs and prominent links. No reproduction of others' text.

No interactive AI inside the paper for now. The original spec had a RAG-grounded Q&A modal per story; cutting it removes a lot of complexity and legal exposure for marginal benefit, and Gizmo can handle conversation about specific articles by being passed the markdown.

Search, archive browsing, read-later integration, reaction buttons — all reasonable to add later, none needed for V1.

---

## Reading view

**The index is the paper.** A run is around 150 pieces and roughly 22,000 words —
about ninety minutes — so the front page is a list of headlines in rank order,
not a continuous scroll of the whole thing. The reader gets through it in a few
minutes and goes deeper only where he wants to. That is the "finite artifact"
principle meeting the fact of how much the pipeline actually produces.

**Containers expand, pieces open.** A thread is the only container: its row
expands in place to reveal the stories inside it. Every piece — feature,
standard and brief alike — has its own page, reached by tapping its row.

Four registers, distinguished by type scale rather than by badges:

- **thread** — a tinted row, the situation as a standing head, a count of what is
  inside, and a chevron. Expands.
- **feature** — the largest headline. Opens a page with 400–600 words.
- **standard** — a medium headline. Opens a page with 150–200 words.
- **brief** — small and lighter. Opens a page with a sentence or two.

A section line has no headline by design, so its row and its page lead on its
sentence. That is a known rough edge: in a continuous-reading layout a line
needed no headline, and in an index it does.

**Colour means one thing: a link that leaves for someone else's reporting.** The
index carries no accent at all; the blue appears only on an article's source
list. "Curate, don't reproduce" made visible — the only coloured thing on a page
is the way out of it.

Mobile-first, and the same single column on desktop, where the rank figure moves
into the gutter. The paper ends on a printer's `— 30 —`.

Images are not built. When they come, they belong on article pages rather than as
index thumbnails: 120 thumbnails turn a list back into a feed and cost 120 image
loads on cellular. The hard part is OG-image extraction, logo and tracker
rejection, and whether to rehost or hotlink — a "curate, don't reproduce"
question more than a technical one.

---

## What we haven't decided

- Schema details. Roughly known shape, but column-level decisions are for implementation time.
- Exact source list. The structure of how sources are configured matters more than the initial picks; sources are a config file to be tuned over time.
- Exact prompts for each stage. The hardest content work in the project, and worth doing iteratively with real output to evaluate.
- Standing memo specifics. The memo itself needs to be written — these notes are not the memo.
- Source policy specifics. Same — the operational document needs to be drafted.
- UI specifics beyond rough layout principles.
- Archive browsing UX — search box, calendar, tag filter, some mix.
- Time-of-day for the cron.
- LLM client library vs. writing it ourselves — leaning toward writing it, but not decided.
- Failure-mode policy for catastrophically bad days (most sources down, etc.).
- Whether yesterday's paper gets read in full or in distilled form by the editor.
- Whether and when to add MCP layer for Gizmo to query the paper's database.

---

## What this is not

Not a feed. Not a chatbot. Not a dashboard. Not a public product. Not trying to be Perplexity or Apple News or Google News. Not optimizing for engagement.

It's a newspaper. It runs once a day. It produces a finite artifact. It respects the reader's time.

---

## North star

Every morning, make a personal newspaper that respects the reader's time. The reader can finish it. Then they're done.
