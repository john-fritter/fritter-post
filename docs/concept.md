# The Fritter Post — Concept

What the paper is for, and what it refuses to be. This document is the *why*.
How it's built is in `design.md`, and the reasoning behind each choice, dated,
is in `decisions.md`.

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

## How it works, in one paragraph

Every morning a pipeline collects about 1,400 items from 111 sources. It drops
what this reader has no use for, and groups the rest into events and the events
into ongoing situations. Each one is scored for how much it matters to the
reader, graded for how new it is against recent papers, and ranked by a
formula. About 150 pieces are then written in the paper's voice, and the paper
is frozen with links to every source. Models make narrow judgments and software
makes the decisions. `design.md` goes through it stage by stage.

## How the concept changed

The first plan was seven stages, with LLMs doing the editorial work: an LLM
triage step summarizing the day, an agentic researcher, and an LLM editor
assigning stories and writing a brief for each writer. Building it against real
days of news moved the judgment into narrower questions and the decisions into
software. In order:

- **The filter folded into the prefilter, now `screen`** (2026-06-13). Junk
  removal and reader relevance turned out to be one judgment. Digests are cut by
  deterministic rules as well, because a prompt alone let them through.
- **LLM triage gave way to embeddings, now `cluster`** (2026-06-14). An LLM
  clusterer (a wire seed, parallel topic spines, a semantic merge) was replaced
  by cosine similarity plus union-find, with small LLM passes that split, attach
  and describe. Clustering became cheap, repeatable and tunable with one knob.
- **The LLM editor became a formula, now `rank`** (2026-06-16). Ranking and
  tiering turned out to be a scoring problem: `score + 9·ln(outlets)`, with tiers
  by position. The judgment lives in `screen` and `score`, which both read the
  bio. A model only breaks exact ties.
- **The researcher was dropped** (2026-07-25). The ranked, tiered output feeds
  the writers directly. The writers are given the source articles themselves,
  fetched in full where a feed carries only a teaser, which is what the
  researcher was going to supply.
- **Threads were added** (2026-07-28, 2026-08-15). One run printed five separate
  Oregon wildfire stories. "Same event" and "same situation" proved to be
  different questions. A situation is now ranked as one row and written as a
  section: a lead, sidebars and one-line updates.
- **The writer's package is assembled, not authored** (2026-08-13). An LLM step
  writing a brief for each writer would have been a judgment stage with nothing
  new to judge. Software selects, dedupes and budgets the material, and the
  standing memo (`voice.md`) carries the voice.
- **The paper became an index** (2026-08-28). A paper of 150 pieces runs to about
  90 minutes of reading. A continuous scroll of all of it is a reading surface,
  not a newspaper, so the front page is a list of headlines in rank order.
- **Continuity became a judged link, and repeats became a novelty grade**
  (2026-09-03 → 2026-10-03). "Continuity matching against yesterday's clusters"
  was meant to live in the preprocessor. It became two things. One is a
  "previously" marker under a headline, decided by retrieval plus a judge. The
  other is a novelty grade that withholds yesterday's news restated by another
  outlet and shrinks minor and routine updates.
- **Comments went to a neighbour** (2026-09-26). Instead of a notes field on each
  card, every piece links to Fritter Board, a separate app that reads the
  published paper through a narrow set of views. The paper shows no counts.

The stages were renamed for what they now do on 2026-10-08. The old names
survive in older decision entries; `design.md` §6 has the map.

## Documents the system reads

Several human-readable files travel through the pipeline. Each has one role,
which keeps any of them from becoming a junk drawer.

- **The bio** (`bio.md`). Slow-changing. Who the reader is: location, work,
  interests, projects, values, what they care about and what they don't. Read
  by every judgment stage and by the writers.
- **The standing memo** (`voice.md`). The editorial document: voice, stance,
  and how register changes with size. It is written as instructions to a new
  writer, not as a spec. It is probably the single most consequential artifact
  in the project, and it is iterated on against real output.

Planned but not built: a **source policy** (how to treat police statements,
press releases, social media claims, paywalls), **pre-written preferences** ("I
keep marking Apple launches not interesting"), and **observed preferences**
learned from the reader's comments.

## Editorial principles

These came out of the planning conversations. The standing memo, `docs/voice.md`, now carries them in its own words and is read verbatim into every writer call.

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

## Reader interaction

- **Every piece has a page**, with its sources listed and linked. Colour on
  the page means a link out to someone else's reporting.
- **"Discuss on the board"** links each piece to Fritter Board. Conversation
  about the paper happens there, not inside it.
- **No interactive AI inside the paper.** The original spec had a RAG-grounded
  Q&A modal per story. Cutting it removed a lot of complexity and legal exposure
  for marginal benefit.

Search, archive browsing, read-later integration and reaction buttons would all
be reasonable to add later. None of them is needed, and reaction buttons never
will be.

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

## Decided since

- **Time of day for the run.** 06:00 in the reader's timezone, set in
  `pipeline.schedule` in `config/models.yaml` and generated into the systemd
  timer from there. It is constrained from both ends: the collector's window is
  24h on `fetched_at`, and the publisher dates the edition by the reader's
  local day.
- **What happens on a catastrophically bad day.** The runner's gates
  (`pipeline.gates.*`) decide. Most sources down aborts at collect. A provider
  outage during scoring aborts at score. If the writers end up below
  `min_written_fraction` after an automatic repair pass, nothing is published,
  so yesterday's paper stays up rather than a paper that is mostly holes.
  Everything short of that publishes and is recorded as `degraded`, because the
  paper has a deadline (2026-08-29).
- **Writing the client vs using a library.** A thin wrapper over the OpenAI SDK,
  with our own logging, budgets, streaming and backoff (`src/llm/`).

## What we haven't decided

- Archive browsing UX: a search box, a calendar, a tag filter, or some mix.
- Images. They would go on article pages rather than as index thumbnails, and
  whether to rehost or hotlink is a "curate, don't reproduce" question.
- The Longer Reads section that opinion and analysis items are already routed
  toward.
- The source policy and preference documents above.
- Whether and when to add an MCP layer so Gizmo can query the paper's database.

## What this is not

Not a feed. Not a chatbot. Not a dashboard. Not a public product. Not trying to be Perplexity or Apple News or Google News. Not optimizing for engagement.

It's a newspaper. It runs once a day. It produces a finite artifact. It respects the reader's time.

## North star

Every morning, make a personal newspaper that respects the reader's time. The reader can finish it. Then they're done.
