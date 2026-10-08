# Design

How The Fritter Post is built, stage by stage. This is the document to read
before changing anything.

- **Why** the paper exists and what it refuses to be is in `concept.md`.
- **Why each choice was made**, with the run that taught it, is in `decisions.md`.
  Entries are dated, and this document points at them by date.
- **What is known to be wrong** is in `open-items.md`.
- **How to deploy and operate it** is in `operations.md`.

---

## 1. Overview

A systemd timer runs `npm run pipeline` at 06:00 Pacific. The pipeline reads
111 sources, works out what happened and what matters to one reader, writes a
paper of about 150 pieces in a house voice, and freezes it into the database.
A Next.js app serves the latest paper at post.fritter.lol.

```
GATHER
  collect      every source into raw_items
  preprocess   clean, dedupe, translate
  screen       cut what the reader has no use for

UNDERSTAND
  cluster      which items report the same event?
  score        how much does each event matter to the reader?
  novelty      is it new to someone who read the last few papers?
  thread       which events are one ongoing situation?

PRODUCE
  rank         the front page, by formula
  fetch        full article text where the feed carried a teaser
  write        one LLM call per piece
  publish      the frozen paper, with source links
               (+ continuity: the "previously" marker)
```

A typical day, from pipeline run #3: **1,435** items collected, **486** events
and singletons out of `cluster`, a pile of **150**, **150** pieces written,
**279** source links, all in **18 minutes**. A 150-piece paper runs to about
22,000 words.

### Ideas that run through all of it

**LLMs judge and software decides.** Models answer narrow questions: is this
noise, are these the same event, how much does this matter to this reader, is
this new. Software turns the answers into decisions. Ranking is a formula over
model scores, and a model is never asked to rank the front page. Tiers come from
rank position. A thread's score is derived from its members' scores rather than
asked for.

**Two kinds of "same".** An *event* (cluster) is one thing that happened,
reported by several outlets. A *situation* (thread) is several events that are
one continuing story. Each question needs its own stage. Neither can do the
other's job, and keeping them apart is what lets clustering stay strict.

**A stage that exits 0 has not necessarily worked.** A rate-limited call that
returns an empty set looks exactly like a model saying "none". So every batched
call retries under backoff, every stage persists the counters that tell the two
apart, and the runner reads them back between stages (§3).

**A model relays what the prompt says about itself.** Tell a writer that its
material is "headline-only" or "truncated" and that sentence reaches the reader.
The writers learned this five times (§2.10). The rule is not to describe the
plumbing in the prompt.

**Every LLM call is logged** with its full prompts, output, tokens and cost
(`generation_logs`). **Every published piece traces back** through writer piece
→ ranked story → thread → cluster → preprocessed item → raw item.

**Graceful degradation.** A dead feed, a failed call or an unfetchable article
costs that item, never the edition. The paper has a deadline.

---

## 2. The pipeline

Each stage has the same layout. *Tables* are what it writes. Several still carry
pre-rename names; see §6. *Config* is its block in `config/models.yaml`.
Every model, budget, cap and threshold lives there, and a number hardcoded in a
stage is a bug.

### 2.1 collect

Fetches every source in `config/sources.yaml` into `raw_items`.

- **Tables:** `collector_runs`, `raw_items`
- **Model:** none
- **Code:** `src/pipeline/collect/`

It does no judgment and no deduplication. The same story from two outlets is
kept twice, because cross-source pickup is the prominence signal `rank` uses.
A dead feed is logged and skipped.

- **Formats.** RSS/Atom. A Google News sitemap (`format: news-sitemap`) is used
  when a publisher serves no feed, which is the case for AP. A sitemap carries
  no body, so those items travel on their titles until `fetch`.
- **Charset is ours.** The feed body is fetched and decoded by
  `collect/charset.ts` (header → XML declaration → UTF-8) before rss-parser sees
  it. rss-parser alone produced mojibake on Latin-1 feeds.
- **A 403 means "not to you".** The fetch retries once with a browser UA.
  404/410/5xx are never retried.
- **Windowing.** `max_age_hours` and `exclude_paths` apply per source to
  both formats (`collect/window.ts`). For RSS, `max_age_hours` is opt-in, so a
  new weekly's first collection does not dump its archive into the paper.

### 2.2 preprocess

Does the mechanical work no model should spend tokens on.

- **Tables:** `preprocessor_runs`, `preprocessed_items`
- **Model:** translation only
- **Config:** `preprocess`
- **Code:** `src/pipeline/preprocess/`

- **Canonicalize.** Strips tracking parameters and unwraps redirectors that
  carry their destination in the *path* (Folha's). Query strings are never
  unwrapped. Google News tokens are left alone.
- **Dedup.** Exact URL and normalized title, within a parent outlet and across
  recent runs. The cross-run part is why re-running from `collect` the same day
  comes back near-empty (§3).
- **Titles.** Strips the trailing ` - apnews.com` that Google News appends. Only
  a bare domain is stripped; an outlet name is kept.
- **Translate.** Non-English items get `english_title` and `english_body`, which
  every judgment stage reads (§4.1). Translation has a consecutive-failure
  breaker and never retries an auth error. An untranslated item keeps its
  original text.
- **The junk filter is the hard gate** (`junk-filter.ts`). It is applied when the
  kept set is read (`assembler.ts`, `getClusteringItems`), and that read is the
  only path into clustering and scoring. Link dumps and digests are cut here
  deterministically. Rules come from audit evidence only, and each one has a test
  for the cut and for the near-miss that must survive.

### 2.3 screen

A bio-aware relevance floor that gives each item one verdict.

- **Tables:** `prefilter_runs`, `prefilter_results`
- **Model:** batched judgment
- **Config:** `screen`
- **Code:** `src/pipeline/screen/`

| verdict | meaning |
|---|---|
| `cut` | noise this reader has no use for (routine scores, celebrity, market filler), non-articles, and every digest |
| `news` | flows on to `cluster` and `score` |
| `opinion` | kept but routed out of clustering, pooled for a future Longer Reads section |

The stage is conservative: when unsure, it keeps the item. A low-interest
topic is kept as soon as it has a substantive angle, and substantive foreign
coverage clears the floor without an obvious tie to the reader. A digest is
judged on its shape rather than its topic: its body lists many unrelated
stories, so it reads as *more* relevant than any single article. The junk filter
is the guarantee, and this prompt is the second line of defence.

### 2.4 cluster

Groups items that report the same event.

- **Tables:** `item_embeddings`, `grouping_runs` (the output is its `digest`)
- **Model:** embeddings plus three bounded LLM passes
- **Config:** `cluster`, `embeddings`
- **Code:** `src/pipeline/cluster/`

1. **Embed.** Title plus a body excerpt, in English, via
   `qwen/qwen3-embedding-8b` (4096 dimensions, pgvector). Upserted, so re-runs
   are cheap. An empty text is never sent, because one empty input fails the
   whole batch.
2. **Candidate groups.** Pure software: a cosine graph with
   `embedding.similarity_threshold` (**the stage's main tuning knob**) and a
   `top_k` neighbour cap, then union-find connected components.
3. **Split.** Union-find chains unrelated stories through a bridging article.
   Large, loosely connected components get one LLM call that re-partitions
   them. Looseness is measured as *cohesion* (density divided by its `top_k`
   ceiling), so the threshold means the same at every size.
4. **Attach.** Each cluster is offered its near-miss singletons in one call
   (Phase A). Leftover singletons can form new clusters (Phase B). A sequential
   **straggler re-ask** follows for any judgment lost to rate limits.
5. **Describe.** One batched call writes a neutral title and summary per
   cluster and says whether it is really **one event**. Clusters marked `MULTI`
   (two mine collapses on two continents: tightly connected, different events)
   go back through split. Split cannot catch these, because they are cohesive.

The persisted counters are what make a run judgeable. `attach_unrecovered` is
the one that matters: non-zero means the clusters understate real grouping.

### 2.5 score

Scores every event and singleton for how much it matters to this reader.

- **Tables:** `grouping_pass1_runs`, `grouping_pass1_results`
- **Model:** batched judgment
- **Config:** `score`
- **Code:** `src/pipeline/score/`

- **Two axes, not one.** The model returns `interest` and `consequence`, 0–50
  each, and software sums them to `score`. A single integer collapsed onto round
  attractors (55, 60, 65…) and tied 115 of 119 rows on one run. Two axes also
  describe a digest honestly: high interest, near-zero consequence.
- **Nearness raises interest.** This is guarded by one question: is the story
  out of the ordinary *for its place*? A local house fire stays low.
- **Source count is withheld from the scorer.** Prominence is applied by `rank`.
- **Clusters are scored** on their describe title and summary. **Singletons are
  scored** on title plus body excerpt. The two caps (`summary_cap`, `body_cap`)
  are the stage's quality lever.
- **The unit is the item, not the call.** A model can succeed and still omit a
  line. Every item that comes back unscored is re-asked in sequential
  stragglers. A row that is never judged scores **0**, not 50. A 50 would
  compete, and whether an unjudged story reached the reader would depend on
  where the cutoff landed.

The runner's `score` stage then runs **novelty** and **thread** and assembles
**the pile** (`rank/pile.ts`).

### 2.6 novelty

Grades how new each story is to someone who read the last few papers.

- **Tables:** `rerun_runs`, `rerun_assessments`
- **Model:** batched judge
- **Config:** `novelty`
- **Code:** `src/pipeline/novelty/`

Runs inside `score`, before threading.

| grade | meaning | effect (`novelty.grades`) |
|---|---|---|
| `new` | nothing like it was printed | none |
| `development` | something has changed | none; the writer leads on what changed |
| `minor` | the same news plus a small detail | score −12, at most `standard` |
| `routine` | more of what this situation does every day | score −20, at most `brief` |
| `rerun` | nothing new | withheld from threading and the pile |

**Why this stage exists.** The preprocessor catches duplicate *articles*, not
duplicate *news*. In the Sep 5–22 audit, about one in four of 257
"previously" links was the same news printed again because a later outlet
reported it. None of the 257 shared a URL, item or normalized title with its
predecessor, so no dedup key could have seen them. Retrieval uses the same embeddings as
continuity: the max cosine between today's articles and the articles behind
recent pieces, measured over the last `lookback_editions` papers. The judge
then reads each candidate against **everything** it resembles at once, because
"routine" is a fact about the paper's recent history, not about one pair.

**Fails open.** A wrongly dropped story is invisible to the reader, while a
missed rerun is just yesterday's paper again. So a failed or unreadable call
leaves the row ungraded, and only a stated `RERUN` withholds anything. Every
graded row is persisted, because that table is the only place a wrong drop can
be seen (`inspect novelty`).

Downstream, a reduced row keeps its reduced score through threading and the
pile, `rank` caps its tier, and the writer is told yesterday's headline and the
judge's one-sentence statement of what is new (`continuationLines`).

### 2.7 thread

Groups events that are one continuing situation.

- **Tables:** `thread_runs`, `threads`, `thread_members`
- **Model:** one call
- **Config:** `thread`
- **Code:** `src/pipeline/thread/`

`cluster` asks "same event?" and this stage asks "same story?". Five Oregon
wildfires are five events and one situation. A situation must be **concrete,
anchored in a place and a time**: one state's fire emergency, one war, one
city's fight over one project. "Data centers straining grids in three states" is
a topic, not a situation. Most rows belong to no thread.

- **Two tests.** A member belongs if it is current, *and* if it changes what the
  reader understands about the rest: consequence, mechanism, scale, human cost,
  or another instance of the same emergency. Something that merely also happened
  is an item, not a dimension, and does not belong.
- **The anchor comes first.** The output is `title;;anchor;;summary;;refs`, and
  the anchor is stored. "The Taliban's rule since 2021" is visibly not an
  anchor, where a headline would hide that.
- **One call over the whole candidate set.** A situation's members are spread
  across the score range, so chunking would hide them from each other.
- **Numbers are derived, not asked for:** `score = max(member score)` and
  `sources = sum(member sources)`, counting only unreduced members. That makes
  a thread an ordinary row for `rank`.

### 2.8 rank

The front page, ranked by formula.

- **Tables:** `editor_piles`, `editor_pile_items`, `editor_runs`, `editor_stories`
- **Model:** tie-break only
- **Config:** `rank`
- **Code:** `src/pipeline/rank/`

**The pile** (`pile.ts`, assembled at the end of `score`) is scored rows and
threads together. It takes the top `cluster.pile_target` (150) by score, minus
rows absorbed into a thread and rows novelty withheld. Then:

```
combined = score + source_weight × ln(distinct outlets)        source_weight = 9
```

- **Sources means newsrooms, not rows.** The count is distinct *parent* outlets
  (`src/db/outlets.ts`), never less than 1, so `ln` is never `-Infinity`. A
  singleton gets no lift (`ln 1 = 0`).
- **Tiers come from rank position:** feature 15, standard 60, brief 75. A
  novelty-capped story takes the largest slot its cap allows, and the slot it
  skipped goes to the next story down (`assignTiersWithCaps`).
- **The only model call is the tie-break.** Rows with identical combined scores
  are ordered by one small bio-aware call per tie group, under
  `callWithBackoff`. Its lost calls are counted, because an empty answer looks
  exactly like "no preference".

The editorial judgment happened in `screen` and `score`. This stage combines
it, which is why it is no longer called "editor" (decisions.md, 2026-06-16).

### 2.9 fetch

Fetches publisher article text for pieces that will need it.

- **Tables:** `article_texts`
- **Model:** none
- **Config:** `fetch`
- **Code:** `src/pipeline/fetch/`

Most feeds carry a teaser: 61% of one run's articles had under 800 characters.
So for **feature and standard** stories, each article whose feed body is short
**or ends mid-sentence** is fetched and extracted (Readability → html-to-text).

- **No whole-page fallback.** A page with no article extracts to `""`, not to
  navigation soup. A non-HTML response is never read.
- **Politeness is per host.** Hosts run concurrently, and each host's own URLs
  run one at a time with a delay between them. The fetch uses the honest UA
  first and a browser UA once on a 403.
- **Cooldown is learned, not configured.** A host that keeps refusing
  (DataDome: nytimes.com, oregonlive.com) is skipped until its failures age out.
- **A row the database refuses costs one article.** NUL bytes are stripped and
  failed upserts are counted, not thrown.
- **`article_texts` is the only table holding third-party full text.** It
  exists to write the paper, is never published, and is swept after
  `retention_days`.

### 2.10 write

Turns packets into the paper's own prose.

- **Tables:** `writer_runs`, `writer_pieces`
- **Model:** DeepSeek V4.1 Flash at reasoning `high`
- **Config:** `write`
- **Code:** `src/pipeline/write/`

The writer model was chosen over GLM 5.2 and 5.3 in three blind bake-offs
judged on attribution: who said what, and whether an analyst's view stays the
analyst's. Flash at `high` put one unsupported claim in 96 pieces
(decisions.md, 2026-09-23 and 2026-09-25).

**Materials** (`materials.ts`) walks a ranked story down to its articles:
thread → members → cluster digest → preprocessed items. It returns text
uncapped.

**The packet** (`assembler.ts`, `prompt.ts`) is built from those articles.

- *Selection* takes one article per parent outlet before a second from the same
  outlet.
- *Dedup* removes verbatim repeated paragraphs only. Embedding dedup would
  delete the corroboration a cluster exists to provide.
- *Furniture* (`boilerplate.ts`) is stripped from both the fetched text and the
  feed body before the longer of the two is chosen.
- A fetched page must share enough of the headline's words to count as the
  article the feed described (`pageMatchesTitle`).
- Live blogs and headline echoes leave the packet, but a packet is never
  emptied.
- **Source material is not rationed.** `max_articles` and `total_chars` are
  null. Deciding what bears on the story is the writer's job, and when a piece
  runs long the fix is guidance on what to keep, never less to read.

**What the writer is told.**

- The reader (`bio.md`), the standing memo (`voice.md`), a tier word target,
  the sources, and, for a story novelty graded, what the reader already knows.
- **Never anything about the plumbing.** No source counts, no "feed summary
  only", no "truncated". A model relays what the prompt says about itself.
- **The cluster label is not evidence.** It is generated from every article,
  including ones not in the packet, and the prompt says so.
- Thin material gets a word **ceiling** with no floor. A floor forces the writer
  to pad, and padding is where "No further details were available" came from.

**Sections.** A thread becomes a *section*, not one piece. Its highest-scoring
member with real material leads at the story's tier. Up to `max_sidebars` more
members become sidebars one tier below, and the rest become one-sentence
*lines*. Material is partitioned by member, and each piece is told what the
others cover, so no writer needs to see another's work. Sections lengthen the
paper, so `applyPaperBudget` drops standalone pieces from the bottom.

**Tier by material.** `resolveTiersByMaterial` swaps a story whose packet is
headline-only *at its tier* with the nearest story below it that can fill the
slot. Ranks and scores are never touched.

**Calls.** There is one call per feature or standard piece, and briefs go in
batches of `brief_batch_size` (the bio and memo are sent once per batch). Batch
output is `ref;;headline;;body` and is parsed forgivingly. Specifically:

- A missing headline costs the headline, not the piece.
- A one-line batch is split back apart on its refs.
- When a writer revises in the stream, the last labelled draft wins.

Each piece is written to the database as its call returns. A consecutive-failure
breaker stops the stage on an outage, and `--repair` re-asks only the failed
pieces. The runner does that automatically (§3).

### 2.11 publish

Freezes a writer run into the day's paper, with source links.

- **Tables:** `papers`, `paper_pieces`, `paper_sources`
- **Model:** none
- **Config:** `publish`
- **Code:** `src/pipeline/publish/`

This is a stage and not a view because a paper is an artifact. Re-running
`cluster` tomorrow must not change what this morning's paper said, and the
source URLs are three joins away, through the same walk `write/materials.ts`
does.

- Source rows carry **copies** of outlet, title and URL, because `raw_items` is
  swept and a paper must keep its links.
- **One paper per reader-local day.** Re-publishing a date replaces it, but
  `replacementShortfall` **refuses** to replace a paper with one much smaller.
  This is the one gate that refuses rather than warns, because the old paper
  would already be gone by the time anyone read a warning. `--force` is the
  deliberate path around it.
- Two kinds of hole are counted separately: `pieces_skipped` (the writer
  failed) and `pieces_unsourced` (lineage would not resolve).

### 2.12 continuity

The "previously" marker under a headline.

- **Tables:** `paper_piece_lineage`
- **Model:** one judge call per paper
- **Config:** `publish.continuity`
- **Code:** `src/pipeline/continuity/`

This runs inside `publish`, after the paper is frozen. It asks, for each piece,
whether a recent edition ran the same **situation**. If one did, the page
shows "Previously · <date> — <that piece's headline>" under the headline.

It never suppresses anything: continuity is the fix for a story still moving,
and `novelty` is the fix for a repeat.

- **Retrieval, then a judge.** Max pairwise cosine over the articles behind
  each piece, above `candidate_floor` (0.72). No threshold separates real
  continuations from "same kind of event, different instance" (a Gaza strike vs
  a Jenin strike), so an LLM decides. It reads body text, and a YES has to name
  something both texts say.
- **Fails closed**, the opposite of novelty. An unjudged "previously" line would
  print in the paper.
- The lookback is counted in **editions**, not days. The marker is text, not a
  link, because colour means a link out to someone else's reporting.
- A failure here warns and the paper still publishes.

---

## 3. The runner and its gates

`npm run pipeline` (`src/pipeline/runner/`) calls the nine runner stages in
order:

```
collect → preprocess → screen → cluster → score → rank → fetch → write → publish
```

Novelty and thread run inside `score`, and continuity runs inside `publish`.
After each stage a **gate** (`gates.ts`, pure and tested) reads the counters
the stage persisted and returns one of three verdicts:

- **ok**
- **warn**: the run continues and is recorded `degraded`
- **abort**: the next stage does not start

Only two things abort: there is nothing left for the next stage to work on, or
the writers came back below `min_written_fraction` after the automatic repair
pass. In that case yesterday's paper stays up. Thresholds live in
`pipeline.gates.*` because they are the reader's policy.

- **A warning must be an event, not a standing condition.** Two dead feeds out
  of 111, or nytimes.com in cooldown, are true every day, and a status that is
  always on teaches the reader to ignore it. The collector warns only above a
  failure fraction. The fetch warns only on a host newly in cooldown relative
  to every run in the cooldown window.
- **Repair is automatic.** After a delay, because the breaker trips on outages.
- **The deadline (`max_duration_minutes`) is checked between stages.** An
  in-flight LLM call cannot be cancelled. systemd's `TimeoutStartSec` is the
  hard kill.
- **Recovery is `--from <stage>`, never a re-run from the top.** Cross-run
  dedup makes a same-day full re-run near-empty *by design*, and publishing it
  would replace a good paper. A resume inherits the recorded run ids from
  `pipeline_runs`.
- **The schedule is configuration.** `--print-timer` generates the systemd unit
  from `pipeline.schedule`, so the hour lives in one place.

Writes `pipeline_runs` and `pipeline_stage_runs`. A stage row is written when the
stage starts, so a run that was killed still says where it died.

---

## 4. Cross-cutting

### 4.1 The LLM layer (`src/llm/`)

- `callLLM` goes through the OpenAI SDK to any OpenAI-compatible endpoint.
  `provider` in a stage's config selects the credentials (`ollama-cloud`,
  `nanogpt`, `openrouter`). Pass it the **whole** stage config: a missing
  `provider` or `timeout_ms` silently falls back to defaults.
- **Every call is logged** to `generation_logs`, failures included. An empty
  response is recorded as an error.
- **No SDK retries.** `callWithBackoff` (`backoff.ts`) retries rate limits,
  broken streams and budget-exhausted empty responses, with jitter and
  `Retry-After`. It **does not retry timeouts**. Every batched, concurrent
  stage uses it, because a lost call that returns an empty-but-valid answer is
  indistinguishable from a verdict.
- **Streaming** is on for reasoning models. Non-streamed calls get no headers
  until the model finishes, and undici gives up on them first.
- **Judgment stages read English**, through `src/lib/text.ts`, with the cap a
  named config field.

### 4.2 Configuration

- `config/models.yaml` holds per-stage model, provider, budgets, caps,
  thresholds and gates, in pipeline order, validated by Zod (`src/config/`).
- `config/sources.yaml` is the source list: `parent` (for counting outlets),
  `track` (news / analysis), `format`, and windowing.
- Comparison runs override a stage's model for one run (`--model`,
  `--reasoning-effort`, …; `src/config/overrides.ts`). A model comparison
  always includes a re-run of production, because a model differs from itself.

### 4.3 Documents the pipeline reads

- `docs/bio.md` is **the reader**: who they are, where, and what they care about. It is
  read by screen, score, thread, the rank tie-break and the writers.
  `docs/bio.example.md` shows the shape.
- `docs/voice.md` is **the standing memo**, read verbatim into every writer's
  system prompt. Its wording is the paper's wording.

### 4.4 Provenance

```
paper_pieces ─► writer_pieces ─► editor_stories ─► threads / thread_members
             ─► grouping_runs.digest (cluster) ─► preprocessed_items ─► raw_items
paper_sources: copied outlet, title, URL per piece
generation_logs.id on each writer piece: the exact prompt that produced it
```

### 4.5 The reading view (`src/app/`)

Server components read only the `paper_*` tables.

- **The index is the paper.** It shows about 120 headline rows in rank order,
  with tier carried by type scale. A thread is the only container and expands in
  place. Every piece has a page.
- **Two addresses.** `/story/<ref>` resolves against today's paper, because
  refs are per-run. `/article/<id>` is permanent, keyed on `writer_pieces.id`,
  which survives a re-publish.
- **Colour means one thing: a link that leaves for someone else's
  reporting.** It appears only on an article's source list.
- **"Discuss on the board"** links to Fritter Board (`BOARD_URL`). The paper
  shows no counts.

### 4.6 The database

There is one Postgres with pgvector, inside the compose stack. Migrations are
numbered SQL in `migrations/` (`npm run migrate`), and the next one is 049.

**Fritter Board shares the database and reads only the `published` schema**
(migration 046): the views `published.articles` and
`published.article_sources`. Its role has no grant in `public`, so it can never
see `article_texts`. Add columns to those views freely. Never rename or drop one
without changing the board at the same time.

---

## 5. Glossary

| term | meaning |
|---|---|
| **item** | one article from one source (`raw_items` → `preprocessed_items`) |
| **cluster / event** | items that report the same thing happening; refs `C27` |
| **singleton** | an item no cluster took; refs `S60167` |
| **thread / situation** | events that are one continuing story; refs `T3` |
| **row** | a cluster, singleton or thread being scored or ranked |
| **pile** | the ~150 rows `rank` chooses from |
| **tier** | feature, standard or brief: the slot size, from rank position |
| **piece** | one thing the reader reads, with a headline and a body |
| **section** | a thread as written: a lead, sidebars and lines under one heading |
| **line** | a one-sentence section member, with no headline |
| **packet** | everything a writer call is given for one piece |
| **material level** | full / partial / headline-only, judged against the tier |
| **gate** | the runner's ok / warn / abort check between stages |
| **edition / paper** | one day's frozen output (`papers`) |
| **Gizmo** | the agent that operates the production box (`operations.md`) |

---

## 6. Names

The stages were renamed on 2026-10-08 so each has one name that says what it
does. Older `decisions.md` entries, open items and Gizmo reports use the old
names. **Database tables and columns, and the `--…-run` CLI flags that name
them, have not been renamed yet**, so this map is also how to read the schema.

| stage | formerly | tables | run-id flag |
|---|---|---|---|
| collect | collector | `collector_runs`, `raw_items` | |
| preprocess | preprocessor | `preprocessor_runs`, `preprocessed_items` | `--preprocessor-run-id` |
| screen | prefilter | `prefilter_runs`, `prefilter_results` | |
| cluster | grouping | `grouping_runs`, `item_embeddings` | `--grouping-run-id` |
| score | grouping-pass-1, editor-pass-1, `editor_pass_1` | `grouping_pass1_runs`, `grouping_pass1_results` | `--grouping-pass1-run` |
| novelty | rerun, the rerun check | `rerun_runs`, `rerun_assessments` | |
| thread | (unchanged) | `thread_runs`, `threads`, `thread_members` | |
| rank | editor | `editor_piles`, `editor_pile_items`, `editor_runs`, `editor_stories` | `--pile-id`, `--editor-run` |
| fetch | fetch-text (lived in `writers/`) | `article_texts` | |
| write | writers | `writer_runs`, `writer_pieces` | `--writer-run` |
| publish | publisher | `papers`, `paper_pieces`, `paper_sources` | |
| continuity | lineage, the lineage pass | `paper_piece_lineage` | |

"Lineage" now means provenance only: where a piece came from, and the chain of
run ids the runner records.

The grade called `rerun` is still called that. It is one of novelty's five
answers.
