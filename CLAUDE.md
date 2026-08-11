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
│   └── bio.md                   # the reader (written)
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
│   │   ├── writers/             # (not built — empty)
│   │   └── publisher/           # (not built — empty)
│   ├── llm/                     # OpenAI SDK wrapper + logging + streaming
│   ├── db/                      # postgres connection, query helpers
│   ├── config/                  # models.yaml + sources.yaml loaders (Zod)
│   ├── app/                     # Next.js routes (the reading view)
│   └── lib/                     # shared utilities
├── scripts/                     # CLI entry points for each stage + inspect
├── migrations/                  # numbered SQL migrations (001–032)
└── tests/                       # unit tests for deterministic parsers
```

---

## Pipeline: implemented stages

The pipeline is nine stages (see `docs/concept.md`). The seven below are built
and production-ready. Writers and publisher are not built — their directories
are empty.

The researcher stage was dropped; the editor's tiered output feeds the writers
directly (see `docs/decisions.md`).

Clustering is the embedding-based **grouping** stage. (An earlier LLM-based
`triage` clusterer — seed + parallel spines + semantic merge — was removed once
grouping proved out; see `docs/decisions.md`.)

```
collector  →  preprocessor  →  prefilter  →  grouping  →  grouping-pass-1
           →  thread  →  editor
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

### prefilter
Bio-aware relevance floor between the preprocessor and the clusterer. Batched,
concurrency-capped (p-limit). Per-item verdict: `cut`, `news`, or `opinion`.
- `cut` — obvious noise this reader has no interest in (routine sports scores,
  celebrity tabloid, market-movement wire filler) plus non-article material
  (event calendars, horoscopes, photo galleries, house ads, link-dump roundups)
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
4. **Describe** — batched LLM call that writes a neutral `title;;summary` for
   every multi-item cluster. Singletons skip this pass. Controlled by
   `grouping.describe.*`.

All three LLM passes go through `callWithBackoff`. This is not optional: a
failed attach call returns an empty set, which is indistinguishable from the
model saying "none of these belong," so the cluster silently doesn't grow and
the run still reports success.

Per-pass counters are persisted onto `grouping_runs` (migration 030) so a
report regenerated from the database can judge a run without the console log:
`cluster_count`, `singleton_count`, `attach_calls`, `attach_failed_calls`, and
`split_examined` / `split_suspect` / `split_calls` / `split_failed_calls` /
`split_components_split` / `split_freed_singletons`.

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
clusters and singletons on the same scale. Clusters are scored on their
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
- **429/503 backoff is `src/llm/backoff.ts`.** `callWithBackoff` wraps a
  `callLLM` thunk with exponential backoff and jitter, honoring a
  `Retry-After` hint when the provider sends one. Configured per-stage via
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
number is ambiguous. The next migration is **033**.

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

**Inspection**
- `npm run inspect -- count [--source <name>]`
- `npm run inspect -- list [--source <name>] [--limit <n>]`
- `npm run inspect -- collector [--id <n>]`
- `npm run inspect -- preprocessor [--id <n>]`
- `npm run inspect -- prefilter [--id <n>]` — shows cut/news/opinion breakdown
- `npm run inspect -- editor [--id <n>]` — ranked/tiered list with resolved titles

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
- `docs/bio.md` — the reader; read by prefilter, grouping-pass-1, and editor
- `config/sources.yaml` — current feed list
- `config/models.yaml` — per-stage model, provider, budget, stream config
