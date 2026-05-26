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

The paper is produced by a daily cron running seven stages. Four are software, three are LLM-driven. The architecture is the main thing this document is trying to nail down — most other details below can move.

```
1. Collector (software)
   ↓
2. Preprocessor (software)
   ↓
3. Triage (one LLM call)
   ↓
4. Researcher (agentic LLM loop)
   ↓
5. Editor (orchestrated multi-call LLM)
   ↓
6. Writers (parallel LLM calls, only for real articles)
   ↓
7. Publisher (software)
```

### Stage 1: Collector (software)

Hits every configured source. RSS where available; direct fetches for places that don't publish feeds. Writes raw items to storage. Aggressively dumb — no judgment, no deduplication, no extraction. Failure-tolerant: a dead feed is logged and skipped.

Cross-source duplication is preserved here because later stages use it as signal.

### Stage 2: Preprocessor (software)

Sits between collector and triage. Does the obvious mechanical work the LLM shouldn't be wasting tokens on:

- URL canonicalization (strip tracking params, normalize AMP, etc.)
- Exact-URL deduplication
- Title similarity clustering (token Jaccard or normalized Levenshtein)
- Source-count aggregation per cluster (prominence signal)
- Timestamp normalization
- Category inheritance from source config
- Continuity matching against yesterday's clusters

The LLM should never be the first entity to notice that ten articles have nearly identical headlines. Software handles it deterministically.

### Stage 3: Triage (one LLM call)

Single call, large context. Reads the preprocessed pile and produces an analytical digest for the researcher. Its job is interpretation, not exploration — no tools, no looping.

Output covers: cluster meaning and angle, cross-source synthesis, representative quotes, prominence scoring beyond raw source counts, continuity flags against yesterday, gap analysis, anomaly notes, items that didn't cluster but might matter.

Not agentic. Single interpretive pass.

### Stage 4: Researcher (agentic LLM loop)

Reads the triage digest, decides what's worth investigating deeper, fetches full text where useful, follows threads via search when context is needed beyond the configured sources. Produces a stack of article ideas — self-contained units with title, category, prominence tag, source list, image references, cliffs-notes summary, and a note on why flagged.

The researcher clusters during research, since it has the article texts available — three sources covering one story becomes one idea with three source entries.

Genuinely agentic. The job requires runtime decisions about what to chase next based on what each tool call surfaces. Step and token budgets enforced.

### Stage 5: Editor (orchestrated multi-call LLM)

Not one big call, not a full agent. Software orchestrates a known sequence of focused calls. Current thinking is roughly four phases:

1. **Evaluation.** Reads all article ideas, bio, preferences, source policy, standing memo, yesterday's paper. Outputs structured per-idea ratings: include/exclude, category, prominence, relevance, continuity link, brief reasoning.
2. **Ranking and sizing.** Reads the evaluation output and a smaller working set. Outputs ordered list with size tiers assigned (footer / one-liner / blurb / standard / feature).
3. **Short writing.** For one-liners and blurbs, produces final text directly. These are essentially rewrites of the researcher's summary in the paper's voice; no separate writing stage needed.
4. **Package creation.** For standard and feature pieces, produces a writer package per piece: angle, distilled voice brief, source material references, editorial notes, target length, cross-references.

The phases are knowable in advance and proceed in sequence, so software orchestrates rather than the LLM deciding what to do next. Each call has tight focus and bounded context. If one phase produces something weird, you regenerate that phase, not the whole stage.

This is the heaviest stage and probably warrants the strongest model.

### Stage 6: Writers (parallel LLM calls)

One call per standard or feature piece. Writers run in parallel — no inter-dependencies. Each writer receives one writing package with everything needed: source materials, angle, voice brief distilled from the standing memo, editorial notes, length target.

Writers don't see each other's work. Cross-article references are handled by the editor's metadata.

### Stage 7: Publisher (software)

Pure rendering. Takes the structured document from the editor (ordered list of stories with size tiers, body text, image refs, sources) and produces the page according to layout rules. No judgment. All editorial work happened upstream.

Top stories get hero treatment; standard cards fill the body; small cards and one-liners populate the lower section; headlines-only items go to a footer "also today" section. Same visual shape every day, different content. Output is static HTML.

The publisher is designed to be tolerant: structured metadata (story order, size tiers, source attributions) is schema-validated and must be correct; prose bodies are markdown rendered as-is. Graceful degradation when a single piece fails — render what works, log what didn't, never crash the whole paper for one bad article.

---

## Storage

Postgres. Already running for Fritterflix on the same box, so this is a reuse rather than new infrastructure.

Tables roughly: raw items (collector output), preprocessed clusters, triage digests, article ideas (researcher output), writing packages, finished stories, papers, sources, feeds, feedback, generation logs. Raw items get a retention window (rolling deletion); everything else is durable.

Schema details are not decided. The point is: structured data through the pipeline, full lineage from raw input to published story, every LLM call logged with model, prompts, outputs, token counts.

---

## Models and configuration

Every LLM stage is independently configurable via a config file. The pipeline is model-agnostic; any OpenAI-compatible provider works. Starting plan uses Ollama Cloud Pro.

Current thinking on assignments (subject to revision once we see how each stage actually performs):

- **Triage:** Gemini 3 Flash Preview — large context handles the full preprocessed pile
- **Researcher:** Kimi K2.6 — strong synthesizer, low hallucination, manageable in loops with explicit stopping criteria
- **Editor:** Kimi K2.6 or GLM — the most important assignment, may warrant tuning per phase
- **Writers:** GLM — strong prose quality, comfortable in the editorial register

All tunable. Per-stage parameters in config include model, token budgets, step limits for agentic loops, temperature, retry behavior.

---

## Documents the system reads

Several human-readable files travel through the pipeline. Each has a defined role; keeping them separate prevents any one from becoming a junk drawer.

- **Bio file.** Slow-changing. Who the reader is — location, work, interests, projects, values, what they care about, what they don't.
- **Standing memo.** The editorial document. Voice, stance, ranking principles, what the paper covers, how it sounds, how it handles register across sizes. Written as instructions to a new editor, not as a spec. Lives with the editor; distilled into focused voice briefs for each writer package.
- **Source policy.** Operational. Source tier list, how to handle police statements, press releases, social media claims, rumors, paywalled sources, primary-source preferences, cross-source verification thresholds. Lives with researcher and editor.
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

## Card and output format

Each card has: image, headline, blurb, expandable body, source links, comment field.

Four size tiers, currently:
- **Footer one-liner** — headline only, in an "also today" section, no card.
- **Blurb / small card** — headline, image, 1-2 sentence body, source link. Doesn't expand.
- **Standard card** — headline, image, blurb visible, expandable to paragraph-length body, multiple source links possible.
- **Feature card** — headline, image, longer expandable body (300-600 words), substantial source treatment.

Image strategy: prefer OG image from source articles when available and not a logo or tracker. Fall back to a curated stock folder (~30 images, photography-leaning, no people, organized by domain tag). Mixed papers look more like real papers than uniform image grids.

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
