# CLAUDE.md

Operational guidance for Claude Code working in this repository.

For the project's vision, principles, and pipeline architecture, read
`docs/concept.md` first. For the reasoning behind specific choices,
read `docs/decisions.md`.

---

## The project

The Fritter Post is a self-hosted personal daily newspaper for one reader,
served at post.fritter.lol. A daily cron runs a pipeline that collects,
synthesizes, and renders a finite paper from a curated source set.

**What this is:** a newspaper. A daily artifact. Curated synthesis.

**What this is not:** a feed, a chatbot, a dashboard, a public product, an
engagement-optimized anything, or an independent reporting tool. Do not add
features in the direction of any of these. When in doubt, less is more.

---

## Stack

- **Language:** TypeScript
- **Framework:** Next.js (App Router) — matches Fritterflix on the same box
- **Database:** Self-contained PostgreSQL inside the project's
  docker-compose stack, on a private internal network. The app container
  also attaches to `seedbox_default` so Caddy on the host can reach it.
- **LLM access:** OpenAI SDK pointed at OpenAI-compatible endpoints,
  wrapped in `src/llm/` for logging, typing, streaming, and per-stage
  budgets. Three provider credential pairs — select per-stage in
  `config/models.yaml`:
  - `provider: ollama-cloud` (default) — `LLM_BASE_URL` / `LLM_API_KEY`
  - `provider: nanogpt` — `NANOGPT_BASE_URL` / `NANOGPT_API_KEY`
  - `provider: openrouter` — `OPENROUTER_BASE_URL` / `OPENROUTER_API_KEY`
    (used for the embedding model)
- **Embeddings:** pgvector extension on the same PostgreSQL instance.
  Embedding vectors (4096-dim, `qwen/qwen3-embedding-8b` via OpenRouter)
  stored in `item_embeddings`. Used by the grouping stage.
- **Deployment:** Docker container, fronted by Caddy, on fritter.lol
- **Cron:** *planned* — a systemd timer on the host invoking a pipeline
  entrypoint. Not built. There is no single entrypoint script; the stages are
  run by hand, in order, threading run ids between them.

---

## Repo layout

```
fritter-post/
├── CLAUDE.md                    # this file
├── README.md
├── package.json
├── tsconfig.json
├── next.config.ts
├── Dockerfile
├── docker-compose.yml
├── docs/
│   ├── concept.md               # the vision document
│   ├── decisions.md             # decision log, append-only
│   ├── bio.md                   # the reader (written)
│   └── voice.md                 # the standing memo — voice, read by the writers
├── config/
│   ├── sources.yaml             # feed list
│   └── models.yaml              # per-stage LLM model and budget config
├── src/
│   ├── pipeline/                # the pipeline stages
│   │   ├── collector/
│   │   ├── preprocessor/
│   │   ├── prefilter/           # bio-aware relevance floor + junk removal + news/opinion routing
│   │   ├── grouping/            # clustering: embeddings + connected components + attach + describe
│   │   ├── editor-pass-1/       # bio-aware scoring + pile assembly (grouping path)
│   │   ├── thread/              # groups related rows into one ongoing situation
│   │   ├── editor/              # deterministic ranking + tiering (grouping pile)
│   │   ├── writers/             # materials + fetch + assembler + the writer calls
│   │   └── publisher/           # (not built — empty)
│   ├── llm/                     # OpenAI SDK wrapper + logging + streaming
│   ├── db/                      # postgres connection, query helpers
│   ├── config/                  # models.yaml + sources.yaml loaders (Zod)
│   ├── app/                     # Next.js routes (the reading view)
│   └── lib/                     # shared utilities
├── scripts/                     # CLI entry points for each stage + inspect
├── migrations/                  # numbered SQL migrations (001–036)
└── tests/                       # unit tests for deterministic parsers
```

---

## Pipeline: implemented stages

The pipeline is nine stages (see `docs/concept.md`). The eight below are built.
Only the publisher is not built; its directory is empty.

The researcher stage was dropped; the editor's tiered output feeds the writers
directly (see `docs/decisions.md`).

Clustering is the embedding-based **grouping** stage. (An earlier LLM-based
`triage` clusterer — seed + parallel spines + semantic merge — was removed once
grouping proved out; see `docs/decisions.md`.)

```
collector  →  preprocessor  →  prefilter  →  grouping  →  grouping-pass-1
           →  thread  →  editor  →  writers
```

### collector
Hits every configured source, writes raw items to `raw_items`. Failure-tolerant
— a dead feed is logged and skipped. No deduplication here; cross-source pickup
is signal, not noise.

**Charset handling is ours, not rss-parser's.** `fetch-feed.ts` fetches the body
itself and hands `parser.parseString` a decoded string; it never calls
`parseURL`. rss-parser reads the charset from the Content-Type header only — it
ignores the XML declaration and doesn't support `windows-1252` — so Latin-1
feeds decoded as UTF-8 and published mojibake. `collector/charset.ts` resolves
header → XML declaration → UTF-8, and retries when the decode produces U+FFFD.
See `docs/decisions.md`, 2026-07-28.

**403 means "not to you", so we ask again as a browser.** Every feed is fetched
first with the honest `FritterPost/0.1` UA. On a 403 — and only a 403 — the
fetch retries once with a browser UA and logs the source if that works. Run #47
lost The Baffler, TechCrunch, and Inside Climate News to CDN bot rules that
serve the same feed to any browser. 404/410/5xx are never retried: those mean
the feed is actually gone or broken, and a second request buys nothing.

**Parse failures log their neighbourhood.** A malformed feed throws a sax error
naming a line and column but not the markup, and by the time anyone reads the
log the feed body is gone. `parseFeedText` prints the surrounding lines before
rethrowing (run #47: Labor Notes, "Unexpected close tag, Line 64").

### preprocessor
URL canonicalization, exact-URL dedup within-source, junk-filter (deterministic
pattern rules in `junk-filter.ts`), track/group assignment from source config.
Writes `preprocessed_items`. The assembler (`assembler.ts`) queries the kept set
for downstream stages, composing prefilter and junk-filter results by
simple set intersection.

**The junk filter is the hard gate, and it is the only one.** `getClusteringItems`
is the sole path into both grouping and grouping-pass-1, so an item it drops
cannot reach the pile as a cluster member or as a singleton. That is why the
link-dump rules live there rather than in a prompt: the prefilter prompt had
said "cut link-dump roundups" since it was written and still let Just
Security's daily "Early Edition" reach the feature tier in run #109. Rules are
high-precision and evidence-driven — extend them from audit logs, never
speculatively, and add a `tests/junk-filter.test.ts` case for both the cut and
the near-miss that must survive.

**Aggregator title suffixes are stripped.** Google News RSS appends the
publisher's domain to every headline, and run #112 published nine of them
("… who had been in custody - apnews.com"). `title.ts` removes a trailing
separator plus a *bare domain* only — an outlet name is not a domain, so
"… Goes Rogue? - Willamette Week" keeps its suffix.

### prefilter
Bio-aware relevance floor between the preprocessor and the clusterer. Batched,
concurrency-capped (p-limit). Per-item verdict: `cut`, `news`, or `opinion`.
- `cut` — obvious noise this reader has no interest in (routine sports scores,
  celebrity tabloid, market-movement wire filler) plus non-article material
  (event calendars, horoscopes, photo galleries, house ads) and **every digest**
  — roundups, link dumps, newsletter editions, date-only titles. A digest is
  judged on shape, not topic: its body lists many unrelated stories, so it reads
  as more relevant than any single article. That density is the tell. The
  deterministic junk filter is the actual guarantee here; the prompt is the
  second line.
- `news` — flows into clustering (grouping) and grouping-pass-1 scoring
- `opinion` — kept but routed out of clustering; pools with `track=analysis`
  items for a future Longer Reads section
Conservative bias: when unsure, keep as `news`; a low-interest topic becomes a
keep the moment it carries a substantive angle, and substantive foreign
coverage clears the floor regardless of an obvious reader tie. Reads
`docs/bio.md`. Absorbs the junk-removal job that the former standalone LLM
`filter` stage handled. Reads English text, capped at `prefilter.body_cap`.

### grouping
The clustering stage. Embedding-based, running on the kept `news` items. Four
steps:
1. **Embed** — each item's title + body excerpt (capped at `body_cap` chars)
   is embedded via `qwen/qwen3-embedding-8b` (OpenRouter, 4096 dims) and
   stored in `item_embeddings` (upserted, so re-runs are cheap).
2. **Candidate groups** — pure software: cosine-similarity graph with
   `similarity_threshold` edge cutoff and `top_k` neighbour cap, then
   union-find connected components. Groups of size ≥ 2 become candidate
   clusters; isolated items are singletons.
2b. **Split** — repairs over-merges that union-find creates. A connected
   component only requires a *path* between members, so a bridging article
   chains unrelated stories into one cluster, and until this pass no LLM ever
   saw a step-2 component. Components that are large enough to chain
   (`min_size`) and loosely connected (cohesion < `density_floor`) get one LLM
   call that re-partitions them; dense components pass through without a call.
   Freed members rejoin the singleton pool for attach to place.
   **Cohesion, not raw density:** `top_k` caps each item's neighbours, so raw
   density has a ceiling that falls as components grow — a 37-item component
   cannot exceed `top_k/(n-1)`. Cohesion divides that ceiling out so the
   threshold means the same thing at every size. Controlled by
   `grouping.split.*`.
3. **Attach** — cluster-centric, two phases. Phase A offers each cluster its
   candidate singletons (title-cosine ≥ `candidate_floor`) in one LLM call;
   Phase B forms new clusters from leftover singletons via proto-groups. One
   bounded cascade re-pass follows. Controlled by `grouping.attach.*`.
4. **Describe** — batched LLM call over every multi-item cluster. It emits
   `index;;verdict;;title;;summary`: a neutral label, plus whether the cluster is
   really **one event**. Singletons skip this pass. Controlled by
   `grouping.describe.*`.
4b. **Re-split** — the clusters describe called `MULTI` go through the split
   prompt again and are re-partitioned; freed members rejoin the singleton pool
   and the new pieces are re-described. **This exists because step 2b cannot see
   this class of over-merge.** Split selects suspects by *cohesion*, since it was
   built to repair chaining; two gold mine collapses on different continents are
   the opposite shape — tightly connected, because they are the same kind of
   event in the same words. Run #50 produced four of these, and describe wrote
   one straight into its own title ("Gold mine collapses kill dozens in Central
   African Republic **and** Colombia") where nothing read it. Deliberately a
   re-partition, not a dissolve: a flagged cluster of ten may hold two real
   groups of five. A failed call leaves the cluster intact.

All three LLM passes go through `callWithBackoff`. This is not optional: a
failed attach call returns an empty set, which is indistinguishable from the
model saying "none of these belong," so the cluster silently doesn't grow and
the run still reports success.

Per-pass counters are persisted onto `grouping_runs` (migration 030) so a
report regenerated from the database can judge a run without the console log:
`cluster_count`, `singleton_count`, `attach_calls`, `attach_failed_calls`,
`split_examined` / `split_suspect` / `split_calls` / `split_failed_calls` /
`split_components_split` / `split_freed_singletons`, and (migration 038)
`describe_flagged` / `resplit_calls` / `resplit_failed_calls` /
`resplit_clusters_split` / `resplit_freed_singletons`.

**If `attach_failed_calls` is non-zero, the cluster/singleton split understates
real grouping and the run must not be used to judge cluster quality or tune
`similarity_threshold`.** If `split_failed_calls` is non-zero, those components
were left intact and may still be over-merged. NULL means the pass didn't run,
which is not the same as zero.

Output: `grouping_runs.digest` — flat `title;;summary;;ids` lines. The
**primary tuning lever** is `embedding.similarity_threshold` in `models.yaml`:
higher = fewer, tighter groups; lower = more, looser groups.

### grouping-pass-1
Scoring stage for the grouping path. Lives in `src/pipeline/editor-pass-1/`
(the directory keeps the historical name; the `editor_pass_1.*` config block
supplies its model and prompt). Two functions:

`runGroupingPass1` — bio-aware 0–100 scoring of every grouping output row,
clusters and singletons on the same scale. **The model emits two axes, not one**
(`id;;interest;;consequence;;reason`, each 0–50); software sums them into
`score`, and both axes are persisted (migration 033). One integer collapsed the
distribution onto round attractors — 55, 58, 60, 62, 65, 68, 70, 72 — and since
a singleton's editor lift is `ln(1) = 0`, its combined score *is* its relevance
score, so equal integers are exact ties. Run #109 put 115 of 119 tied rows in
that shape. Two axes also give the pipeline its principled defence against
digests: a link roundup is legitimately high **interest** and near-zero
**consequence**, which one number could not express. See `docs/decisions.md`,
2026-08-11.
Clusters are scored on their
describe-pass title + summary (capped at `editor_pass_1.summary_cap`);
singletons on their English title + body excerpt (capped at
`editor_pass_1.body_cap`). Those two caps are the stage's quality lever: when
they are far apart the scorer has real material for clusters and a bare
headline for singletons, and singleton scores collapse onto a handful of
values — see `docs/decisions.md`, 2026-08-11.
Source count is stored on each `grouping_pass1_results` row but the scorer
never sees it — scoring is purely reader-relevance. Reads `docs/bio.md`.
Writes to `grouping_pass1_runs` / `grouping_pass1_results`.

`assembleGroupingPile` — ranks threads and un-threaded rows together by score
descending, takes the top `grouping.pile_target` (config: 150), and writes to
`editor_piles` + `editor_pile_items`. Rows absorbed into a thread are withheld:
a threaded row must not also appear on its own.

### thread
**Groups related clusters and singletons into one ongoing situation.** Runs
between grouping-pass-1 scoring and pile assembly. `src/pipeline/thread/`.

Grouping asks *"is this the same event?"*; threading asks *"is this the same
continuing story?"*. Both are needed and neither can do the other's job — which
is precisely what lets the split pass keep event clustering strict. Run #43
published five separate Oregon wildfire clusters, four in the top fifteen,
because the fires are one situation made of many distinct events.

The merge criterion is a **concrete situation anchored in a place and a time**
(one state's fire emergency, one war, one city's fight over one project) — not
an abstract theme spanning unrelated places and actors (data centers straining
grids in three states is a topic, not a situation). Most items belong to no
thread; that is the expected answer. Reads `docs/bio.md`.

**Two tests, and time alone is not enough.** Run #22's T1 passed the time test —
a defence minister's appointment, a prisoner exchange, a strike on a police
station and a family's story from the occupied east are all current developments
in one war — and produced a section its reviewer preferred as a single article. A
survey of all eleven of that run's sections found the second test: a member
belongs when it **changes what the reader understands about the rest** — as a
consequence, a mechanism, a scale, a human cost, or another instance of the same
emergency. A member that merely also happened is an *item*, not a *dimension*.
Four of the eleven sections were built from items. Member count predicted
nothing: T0 worked with nine and T1 failed with eleven, T3 worked with four and
T8 failed with three.

A thread's numbers are derived in software, never asked of the model:

```
relevance = max(member score)      sources = sum(member source counts)
```

That is what makes a thread a first-class row the editor ranks with its
existing formula, unchanged. On run #43's data the five fire rows thread to
`score=85, sources=23` → `combined=113.22`, ahead of that day's actual lead at
111.64, and free four pile slots for other stories.

**One LLM call covers the whole candidate set.** This is deliberate: a thread's
members are spread across the score range (the fires scored 85, 80, 80, 78, 60),
so chunking by score would hide members of one situation from each other.
`thread.candidate_target` (config: 220) is therefore bounded by what a single
call can hold, not by cost.

**The model states the anchor before it lists members.** The criterion has always
been "a concrete situation anchored in a place and a time", and the prompt has
always said so — and it still produced two topic-bundles: run #8's "immigration
crackdown" (rank 1) and run #113's "Afghanistan under Taliban" (five members
spanning 2021–2026). Both pattern-match the positive example "one war, or one
front of one war". The discriminator the prompt never asked for is **time**:
every thread that held gathers developments from the same news cycle, while both
failures gather coverage of a condition years old. The output line is now
`title;;anchor;;summary;;refs`, and the anchor is stored (migration 037) so a bad
thread is legible in the audit — "the Taliban's rule since 2021" is visibly not
an anchor, where a front-page title conceals it. Deliberately **not** validated in
software: Ukraine and Gaza are countries too, and a heuristic would cost real
threads.

Writes `thread_runs` / `threads` / `thread_members` (migration 031). A failed
call yields zero threads — the pass not running, rather than a wrong answer —
recorded in `thread_runs.failed_calls`.

### editor
**Deterministic formula, not an LLM ranker.** Reads all clusters and
singletons from the editor pile and ranks them by a combined score:

```
combined = relevance + source_weight * ln(sources)
```

`relevance` is the grouping-pass-1 score (0–100), or `max(member score)` for a
thread; `sources` is the cluster member count (1 for singletons, and
`ln(1) = 0`, so singletons get no lift), or `sum(member sources)` for a thread;
`source_weight` is `editor.source_weight` in `models.yaml` (config: 9).
Rows sort by combined descending, then relevance, then ref.

Tiers are assigned by rank position from fixed counts in `editor.tiers`
(config: feature 15, standard 60, brief 75). Features fill first, then
standard, then brief — the last tier absorbs the shortfall on a smaller pile.

The only LLM in this stage is the **tie-break**: items sharing an identical
combined score are grouped and ranked against each other by one small
bio-aware call per tie group, run concurrently under
`editor.tie_break.concurrency`. Reads `docs/bio.md`. Ties that the LLM
doesn't resolve fall back to ref ordering.

Exported pure functions `combinedScore`, `assignTier`, `parseTieBreakOutput`,
and `applySortWithTieRanks` are unit-tested (`tests/editor-formula.test.ts`,
`tests/editor-tie-break.test.ts`).

Resolves cluster details from `grouping_runs.digest` via `grouping_run_id`.

(This replaced an earlier whole-pile LLM tierer with retry-once-then-fallback
resilience. `editor.fallback` no longer exists in `models.yaml`. See
`docs/decisions.md`, 2026-06-16.)

### writers

Three pieces: the materials resolver, the article-text fetch, and the prompt
assembler, then the writer calls themselves.

**`materials.ts` — the resolver.** Walks a ranked editor story to the articles
underneath it: thread → `thread_members` → cluster → `grouping_runs.digest` →
`preprocessed_items`. It does the walk and nothing else — no fetching, capping,
dedup, or formatting — and returns body text **uncapped**, because the assembler
owns the budget and a second cap here would be a second place to look for
missing text. Unresolvable rows are recorded on the story (`unresolved`) with the
source count the editor ranked it on left intact.

**`fetch-text.ts` + `extract.ts` — article text.** 61% of editor run #112's 305
underlying articles carried under 800 characters of feed body, and thinness is a
property of the outlet rather than the story, so the fetch is per item: feature
and standard tiers, only where the feed body is under
`writers.fetch.feed_chars_floor`. Extraction is Readability + html-to-text, with
**no whole-document fallback** — a page with no article is marked `thin` and the
assembler falls back to the feed text rather than feeding a writer nav soup.

Politeness is per host, not per source: hosts run concurrently, each host's own
URLs run sequentially with `per_host_delay_ms` between them. The honest UA goes
first and a browser UA is tried once on a 403 only — the collector's rule, now
shared via `src/lib/http.ts`.

**Hosts that keep refusing are skipped**, learned from `article_texts` rather
than configured: a host with `min_attempts` failures and no success inside
`cooldown.window_days` is left alone, and recovers by itself when those failures
age out. nytimes.com and oregonlive.com serve a DataDome device check the
browser UA does not get past.

**`assembler.ts` + `prompt.ts` — the packet.** Pure functions: select, dedupe,
budget. Selection takes one article per parent outlet before a second from the
same one, capped per tier. Deduplication is **verbatim paragraph** removal across
the packet — not embedding similarity, which would delete the corroboration a
cluster exists to provide, since every member of a cluster is the same event by
construction. Trimming lands on a paragraph or sentence boundary. Config is
`writers.packet.*`.

**Source material is not rationed.** `max_articles` and `total_chars` are `null`
on every tier: an item that survived collection, prefiltering, grouping and the
editor reaches the writer, and nothing is dropped for being the 13th source or
the 48,001st character. They were 12/48,000 for a feature, justified as
redundancy control — wrong twice over, because selection already reads one
article per outlet before a second from the same one and `dedupeParagraphs`
already removes what another source said verbatim, so the caps were a third
mechanism for a solved problem that discarded whole sources rather than repeated
text. Run #114's Iran thread lost 5 of 17 articles that way, and run #17's rank
32 printed a false statement because `per_article_chars` cut the article before
the part that answered the question. **Deciding what bears on a piece is the
writer's judgment** — it reads the sources and works out what the story is, which
is why the pipeline gathers and groups them at all. When a piece comes out too
long the fix is guidance on how to editorialize, never less to read.

`per_article_chars` and `floor_chars` are inert while `total_chars` is null. If a
cap is ever needed — a page that would blow a context window — they make the
squeeze spread across outlets instead of letting two long sources take it all.

**`boilerplate.ts` — furniture removal, and it is a junk-filter-style rule set.**
Readability keeps the article but cannot know that `The-CNN-Wire`, a WordPress
"appeared first on" footer, a `READ ALSO` list or Le Monde's live-blog comment box
are not sentences. Rules are whole-paragraph, high-precision, and each names the
run and source it came from; `tests/writer-boilerplate.test.ts` pins both the cut
and the near-miss prose that must survive. Sources whose body only repeats the
headline (`isHeadlineEcho` — the Google News shape) lose their packet slot, but a
packet is never emptied.

A packet records what it could not supply: `materialLevel` is judged against the
tier's own thresholds — the same 1,000 characters is thin for a feature and
adequate for a standard piece. **The notes are directions, never a description
of the packet.** They used to open "Material is headline-level only", and six
pieces in run #13 relayed that to the reader — "No further detail was available",
"The outlet did not specify the new development in its public feed". The standing
memo forbids writing about the sourcing and sits in the *system* prompt; the note
sat in the user prompt, about that specific piece, and the nearer instruction won.

**The prompt never describes its own plumbing.** `formatArticle` used to label
every source `[feed summary only]` and `[truncated at 1200 of 4800 chars]`, and
run #15 relayed both — "Further detail was not available from the published
portion of the report", "the source material was truncated before detailing the
specific benefits". The second read as a hallucination (the persisted article
body has those details) and was accurate about the *packet*, because the budget
cut the text and the label said so, in numbers, inches from the text. That was
the third and closest of three layers saying the same thing, and fixing the outer
two left this one winning. The rule, learned three times: **a model relays what
the prompt tells it about itself, so the fix is not to tell it.** Only the
untranslated flag survives — whether the writer can read the text is a real
decision. Origin, truncation, dedup and furniture counts moved to
`inspect packet --rank`, where an audit needs them. Voice comes from `docs/voice.md`
(the standing memo), read like `docs/bio.md` with a fallback.

**Sections: a thread is not one piece.** Threading absorbs a situation's rows
into one ranked story, and one 500-word slot cannot hold twelve events — run #3's
T1 dropped a story scoring 81 while the paper ran a brief on one scoring 56. A
thread expands into a lead at the story's tier, up to
`packet.section.max_sidebars` members one tier below, and a one-sentence line for
every remaining member, all sharing `section_ref` and the story's rank.

**Slots are assigned by score *and* by material**, because a slot the material
cannot fill is worse than no slot. A headline-only member cannot lead — run #13's
Gaza section led with a 47-word stub while a 180-word fully-sourced piece ran
below it — so the highest scorer with real material leads instead, and score
order stands only when no member has any. A headline-only member gets a line
rather than a sidebar: a line is a pointer and a headline is enough for one,
while an empty paragraph-shaped slot is an invitation to fill it, which run #13
did twice with prose about the sources and once with an asserted development the
packet did not contain. Neither rule touches the thread's own score or rank.

**Material partitions by member, and every piece is told what the others cover.**
Each piece is assembled from its own member's articles alone, so two pieces
cannot draw on the same source — but that guarantees nothing about *content*: a
live blog assigned to one member carries every other member's events, which is
why `isLiveBlog` exists and why it accepts any separator after "EN DIRECT" (run
#20's T1 lead was Le Monde's `EN DIRECT, guerre en Ukraine`, 45,000 characters of
the whole war). The guarantee is the sibling list: the lead is told every piece
below it and a sidebar or line is told the lead plus the others. It used to name
sidebars only, which cost nothing at three members and cost two duplicated
paragraphs at eleven. Static text, not a call — writers still never see each
other's work.

Sections make the paper longer than the editor's story count, so
`applyPaperBudget` drops standalone pieces from the bottom of the rank order to
compensate. Section pieces are never dropped and one standalone always survives.

**A sidebar is never batched, and a brief-tier sidebar is budgeted as a sidebar.**
Only `buildWriterUserPrompt` renders `sectionInstruction`, so a batched sidebar is
written with no idea it belongs to a section and no idea what the lead covers —
while the batch prompt tells it the items around it are unrelated. Run #10's T4
sent three sidebars through the brief batch and got three unrelated briefs under a
heading, the exact failure sections exist to prevent. `partitionByCallShape` now
keeps every sidebar out of the batch pools. Separately, a sidebar under a
standard-tier lead lands on `brief` by the tier ladder and inherited a brief's
25–45 words; all four in run #10 wrote 48–53 and read well, so `packet.tiers.
sidebar` gives them 45–70 and the material for it.

**A short piece is short in its target, not in what its writer may read.** The
`line` and `sidebar` tiers exist to set word targets — 15–30 and 45–70 —
selected through `assembleWriterPacket`'s `budgetTier` override so the piece is
still published as a brief. They no longer ration material: run #8's lines came
back at 40–47 words and the fix then was to cut them to one source and 900
characters, but the same run also introduced a separate line-register batch call,
so which of the two worked was never established. A headline-only packet's word
target is still capped element-wise against `packet.headline_only_words` whatever
its tier — a note saying "write short" competes with a number and loses, and run
#8's T1 sidebar filled a 120–200-word ask with detail about the 1924
Johnson–Reed Act that no source carried. **It renders as a ceiling with no
floor**: run #24 produced five pieces ending "No further details were available
from the source", all headline-only, because fifteen words of material against a
25-word minimum leaves ten words to fill. The memo, the packet note and the
source labels had all been cleaned of that already; the floor was the last thing
still asking for it.

**`index.ts` — the writer calls.** One call per feature and standard piece;
briefs go in batches of `brief_batch_size`, because 75 separate calls would each
re-send the bio and the standing memo and the scaffolding would outweigh the
writing. Batched briefs come back as `ref;;headline;;body` lines, keyed on ref so
a brief cannot be written against the wrong story, and a ref missing from the
output becomes a failed piece rather than a silent gap.

**One call, one register.** `partitionByCallShape` returns three pools — longform,
briefs, section lines — and lines never batch with briefs. The batch prompt frames
the whole set, so a mixed call asks for one register and gets it for both; run #8
did exactly that.

**Reading the output is forgiving; producing it is not retried.** Run #3 lost two
pieces to a parser that demanded a labelled headline on the first line — the
calls had succeeded. `parseWriterOutput` now scans the opening lines for a label,
ignores code fences, and falls back to a short unlabelled first line, while still
refusing a first line that is plainly prose. A brief missing from a batch gets
one follow-up call for the stragglers.

**`npm run write -- --repair <run>`** re-writes only the failed pieces of a run,
in place. A paper is one run: filling three holes must not cost 150 calls.

**A run stops asking when the provider stops answering.** Run #4 met an outage
and, because `callWithBackoff` correctly retries broken streams, 103 logical
calls became 807 provider attempts with 775 errors over 31 minutes. Per-call
backoff cannot see that the provider is down — each call only sees itself — so
the stage aborts after `abort_after_consecutive_failures` consecutive failures,
marks the rest as failed, and names the `--repair` command. Consecutive rather
than a rate: one hard piece among successes is a piece problem; a hundred in a
row is an outage.

**A failed call is a row, not an exception.** The paper has a deadline; one call
that times out must cost one piece, not the edition. Failures are stored as
`status='failed'` pieces with the reason, and `writer_runs.failed_calls` says how
much of the paper is missing without anyone reading stdout. Every call goes
through `callWithBackoff`.

Writes `writer_runs` / `writer_pieces` (migration 035). `editor_story_id` anchors
each piece to the ranked story, and from there the existing keys reach the
thread, cluster, preprocessed items and raw items; `generation_log_id` reaches
the exact prompt that produced it.

**The cluster label is not evidence and the prompt says so.** A describe-pass
title and summary are generated from every article in the cluster, including the
ones the budget left out, so they routinely name events no included source
reports. A writer treating the label as reporting produces unsupported claims in
the paper's own voice — the one failure nothing downstream can catch.

**`article_texts` (migration 034) is the only table holding third-party full
text.** It exists to write the paper, is never published — "curate, don't
reproduce" — and is swept on `writers.fetch.retention_days` by the fetch script.
Failures and skips are stored too, so a report can say what fraction of the paper
is running on feed excerpts.

---

## Conventions

### LLM calls

- **Every LLM call is logged.** A `generation_logs` table records model,
  full prompts, full output, token counts, cost estimate, stage, run id.
  This is non-negotiable — it's the feedback loop.
- **Per-stage configuration** lives in `config/models.yaml`. Model, token
  budgets, step limits, temperature, provider, stream, timeout_ms.
  Hardcoding any of these in stage code is a bug. For Ollama Cloud, use
  canonical model IDs from `/v1/models` such as `deepseek-v4-pro` or
  `deepseek-v4-flash`, not display names or guessed suffixes.
- **Streaming for long reasoning calls.** Any stage running a thinking model
  must set `stream: true` in `models.yaml`. Non-streaming calls don't receive
  HTTP response headers until the model finishes generating — undici's default
  ~300s `headersTimeout` kills them before the model is done. The streaming
  path receives headers within seconds of the request, keeping the connection
  alive. See `docs/decisions.md` "Editor LLM call switched to streaming."
- **provider selects credentials.** Three providers, set per-stage in
  `models.yaml`. `provider: ollama-cloud` (default) uses `LLM_BASE_URL` /
  `LLM_API_KEY`. `provider: nanogpt` uses `NANOGPT_BASE_URL` /
  `NANOGPT_API_KEY`. `provider: openrouter` uses `OPENROUTER_BASE_URL` /
  `OPENROUTER_API_KEY` (currently used for embeddings only). After changing
  any of these env vars, recreate the app container before running via
  `docker compose exec`.
- **Judgment stages read English; text caps are config.** Every stage that asks
  an LLM to judge an item — prefilter, grouping-pass-1, thread, the editor
  tie-break — selects text through `src/lib/text.ts` (`englishTitle`,
  `englishBodyExcerpt`), which prefers the preprocessor's `english_*`
  translation and falls back to the original. Grouping already did this for
  embeddings; the other four did not, so run #47 scored 33+ non-Latin-script
  rows in their original scripts. Never `slice()` a body inline: the cap is a
  named field in `models.yaml` (`body_cap` / `summary_cap`), because it is the
  single biggest lever on what a judgment stage actually knows. A `body_cap`
  above 2000 is meaningless for non-English items — see the ceiling note in
  `src/lib/text.ts`.
- **Pass the whole stage config to `callLLM`.** `provider`, `timeout_ms`, and
  `stream` are easy to leave off, and the call still works — on the default
  provider and the default 360s timeout, silently disagreeing with
  `models.yaml`. Prefilter did exactly that until 2026-08-11.
- **Structured outputs preferred** over freeform parsing wherever the schema
  is knowable. Use JSON mode or tool-call shapes when the consumer is
  software; freeform text only when the consumer is the reader.
- **Agentic loops have budgets.** Step limit and token limit, both enforced.
  An unbounded agentic loop is how you discover a $40 bug.
- **No SDK-level retries.** `callLLM` sets `maxRetries: 0` on the OpenAI
  client. The SDK's default silent retries masked a 903s hang on one run.
  Retry logic lives in application code, not in the HTTP layer.
- **Retry backoff is `src/llm/backoff.ts`.** `callWithBackoff` wraps a
  `callLLM` thunk with exponential backoff and jitter, honoring a
  `Retry-After` hint when the provider sends one. It retries two classes —
  rate limits (429/503) and transport failures where the connection died
  mid-flight (`Stream broke`, `ECONNRESET`, `socket hang up`, …). It
  deliberately does **not** retry timeouts: a call that ran to its configured
  ceiling will likely do it again, and the run #40 lesson was to bound those.
  Run #50's thread pass lost its single call to a broken stream and produced
  zero threads, which put three separate wildfire rows in the top ten. Configured per-stage via
  optional `retry_max_attempts` / `retry_base_ms`. Used by preprocessor
  translation, prefilter, and grouping (attach + describe).
  **Any new batched, concurrent stage needs it.** The failure mode is
  quiet: a rate-limited call that returns a degraded-but-valid-looking
  result (an empty attach set, a fallback label) is indistinguishable from
  a real model verdict, so the run reports success while losing work. See
  `docs/decisions.md`, 2026-07-25.
- **No top-level await in scripts.** tsx runs scripts under the CJS output
  format, which rejects top-level `await`. Wrap all async entry-point logic
  in `async function main()` and call it as `main().catch(err => { ... })`.
  All existing scripts in `scripts/` follow this pattern.

### Pipeline runs

- **Graceful degradation.** A single failed feed, cluster, article, or
  writer call should never crash the whole paper. Log it, render what
  works, move on. The publisher in particular is designed to be tolerant.
- **Full lineage.** Every published story can be traced back through
  writing package → article idea → cluster → raw item(s). The schema
  preserves these foreign keys.
- **Idempotent where possible.** Re-running a pipeline stage with the
  same inputs should produce a comparable output, not duplicate rows.

### Postgres quirks

Two operational quirks discovered during initial development — record them
here so future agents don't rediscover them the hard way:

- **Arrays and JSONB.** The `pg` library treats top-level JavaScript arrays
  as PostgreSQL arrays, not JSON. For JSONB columns that hold an array at
  the top level, use `JSON.stringify(value)` and an explicit `::jsonb` cast
  in the query: `... = $1::jsonb`. Plain objects are fine — `pg` calls
  `JSON.stringify` on them automatically.

- **npm strips quotes from script args.** When calling CLI scripts via
  `npm run`, quoted arguments with spaces (e.g., source names) can be
  mangled by npm's argument passing. Prefer running tsx directly for
  anything with quoted arguments:
  `./node_modules/.bin/tsx scripts/collect.ts --source "AP Top News"`

### Code

- **TypeScript strict mode.** No `any` without comment justifying it.
- **No magic numbers.** Configuration goes in config files, not source.
- **Small, focused modules.** A stage submodule that grows past a few
  hundred lines probably wants to be split.
- **Tests where they earn their keep.** Deterministic code with clear
  inputs and outputs needs tests: URL canonicalization, dedup, flat-line
  parsers (cluster digest, prefilter, grouping-pass-1). LLM stages don't get
  conventional unit tests; their feedback loop is the inspection CLI.

---

## Commands

All scripts are run with `npm run <script>` or invoked directly with
`tsx scripts/<script>.ts` (see the npm-strips-quotes quirk above for
anything with quoted arguments).

**Infrastructure**
- `npm run dev` — Next.js dev server
- `npm run build` — production build
- `npm run typecheck` — TypeScript check
- `npm test` — run every `tests/*.test.ts` file (each in its own tsx process)
- `npm run migrate` — apply numbered SQL migrations

Migration numbering note: `025` was used twice (`025_drop_pile_merge.sql` and
`025_preprocessor_cross_run_dedup.sql`). The runner discovers, sorts, and
tracks by *filename*, so both apply correctly and in a stable order — but the
number is ambiguous. The next migration is **039**.

**Pipeline stages**
- `npm run collect` — collect raw source items
- `npm run preprocess` — deduplicate/canonicalize collected items
- `npm run prefilter` — bio-aware relevance floor + junk removal + news/opinion routing
- `npm run grouping [-- --preprocessor-run-id <n>] [-- --model <id>]` —
  embed items, build candidate groups, run attach + describe passes, write digest
- `npm run grouping-pass1 [-- --grouping-run-id <n>] [-- --model <id>]` —
  score all clusters + singletons on 0–100 bio-relevance scale, run the thread
  pass (`thread.enabled`), assemble pile
- `npm run editor [-- --pile-id <n>] [-- --model <id>]` — whole-pile ranking
- `npm run fetch-text -- --editor-run <n> [--dry-run] [--limit <n>]` — fetch
  publisher article text for the stories of an editor run
- `npm run write -- --editor-run <n> [--tier <tier>] [--limit <n>]` — write the
  paper's pieces
- `npm run write -- --repair <writer-run-id>` — re-write only that run's failed
  pieces, in place

**Inspection**
- `npm run inspect -- count [--source <name>]`
- `npm run inspect -- list [--source <name>] [--limit <n>]`
- `npm run inspect -- collector [--id <n>]`
- `npm run inspect -- preprocessor [--id <n>]`
- `npm run inspect -- prefilter [--id <n>]` — shows cut/news/opinion breakdown
- `npm run inspect -- editor [--id <n>]` — ranked/tiered list with resolved titles
- `npm run inspect -- materials --editor-run <n>` — writer materials audit: how
  much body text each story's underlying articles carry, per tier, per source and
  per host, plus the fetch scope. Reports **feed body and after-fetch side by
  side** — run #113's audit said the median article carried 560 characters while
  the same run's fetch had taken body text from 33,903 to 405,351, and reading
  the feed column alone says the features were written from teasers
- `npm run inspect -- packet --editor-run <n> [--rank <n>]` — assembled writer
  packets: sizes for every story, or the full prompt for one
- `npm run inspect -- writers [--id <n>] [--full]` — writer runs, then every
  written piece; `--full` prints the bodies

**Experiments**
- `npm run embedding-experiment -- --probe <provider> [--candidate <id>]` —
  determine which embedding models a provider actually serves, by making a
  one-text embedding call per candidate and reporting the returned dimension.
  **This is the discovery mechanism for embedding models, not `--list`.** On both
  nanogpt and openrouter, `/v1/models` enumerates chat models only: it returned
  295 and 367 entries respectively with zero embedding models, omitting even
  `qwen/qwen3-embedding-8b`, which production embeds through successfully. A
  catalog absence therefore proves nothing.
- `npm run embedding-experiment -- --list <provider>` — raw `/v1/models` dump.
  Useful for chat models; see above for why it can't answer embedding
  availability.
- `npm run embedding-experiment -- --model <provider>:<id> [--model …]
  [--body-cap <n>] [--grouping-run-id <n>] [--max-pairs <n>]` — measures whether
  translation earns its keep. Uses existing clusters as ground truth: a cluster
  with both English and non-English members is a validated same-event
  cross-language pair. Embeds the **originals** with each candidate model and
  reports same-event vs different-event cosine separation, against the
  translated-text numbers production gets today. If a model's original-text
  same-event p10 clears the threshold while its diff-event p90 stays below it,
  the translation stage can be deleted rather than hardened. Repeating
  `--body-cap` also measures truncation sensitivity. Read-only apart from the
  `generation_logs` rows every LLM call writes.

There is **no** `inspect grouping` or `inspect grouping-pass1` subcommand yet.
Those two stages currently have no inspection view, which is a gap: the
project convention is that LLM stages' feedback loop is the inspection CLI,
and `grouping.embedding.similarity_threshold` is the pipeline's primary tuning
lever. Inspecting either stage means querying `grouping_runs` /
`grouping_pass1_results` by hand.

In production, run CLI stages inside the app container:

```bash
docker compose exec -T app npm run migrate
docker compose exec -T app npm run grouping
docker compose exec -T app npm run inspect -- editor
```

`docker-compose.yml` uses `env_file: .env` for the app service. After any
env var or model config change, recreate/rebuild the app container before
assuming `docker compose exec` sees the new values.

---

## Out of scope for V1

These are documented so they don't get built by accident:

- Interactive AI inside the paper (RAG modal, chat-with-this-article, etc.)
- Search across the archive
- Calendar/tag navigation of the archive
- Read-later integration
- Reaction buttons or any engagement metric
- Public/multi-user support — this is for one reader
- Independent reporting from primary sources (Federal Register, court
  filings, city council agendas) — the paper is an aggregator/synthesizer
- Authentication beyond what's needed for the comment field

If you find yourself reaching for any of these, stop and surface it for
discussion first.

---

## Pointers

- `docs/concept.md` — vision, principles, pipeline architecture
- `docs/decisions.md` — why specific choices were made (append-only)
- `docs/bio.md` — the reader; read by prefilter, grouping-pass-1, editor, writers
- `docs/voice.md` — the standing memo; read verbatim into every writer prompt
- `config/sources.yaml` — current feed list
- `config/models.yaml` — per-stage model, provider, budget, stream config
