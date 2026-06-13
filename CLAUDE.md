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
- **Cron:** systemd timer on the host invoking the pipeline entrypoint

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
│   │   ├── filter/              # LLM garbage filter
│   │   ├── prefilter/           # bio-aware relevance floor + news/opinion routing
│   │   ├── triage/              # clustering: seed + parallel spines + merge
│   │   ├── grouping/            # alt clustering: embeddings + connected components + describe
│   │   ├── editor-pass-1/       # bio-aware scoring + pile assembly (triage AND grouping paths)
│   │   ├── editor/              # whole-pile tiering and ranking (triage or grouping pile)
│   │   ├── researcher/          # (stub)
│   │   ├── writers/             # (stub)
│   │   └── publisher/           # (stub)
│   ├── llm/                     # OpenAI SDK wrapper + logging + streaming
│   ├── db/                      # postgres connection, query helpers
│   ├── config/                  # models.yaml + sources.yaml loaders (Zod)
│   ├── app/                     # Next.js routes (the reading view)
│   └── lib/                     # shared utilities
├── scripts/                     # CLI entry points for each stage + inspect
├── migrations/                  # numbered SQL migrations (001–023)
└── tests/                       # unit tests for deterministic parsers
```

---

## Pipeline: implemented stages

The full concept is seven stages (see `docs/concept.md`). The following are
built and production-ready. Researcher, writers, and publisher are stubs.

Two parallel clustering paths exist — **triage** (LLM-based, the production
path) and **grouping** (embedding-based, the experimental comparison path).
Both terminate at the same editor stage; only one pile feeds the editor on
any given run.

```
collector  →  preprocessor  →  filter  →  prefilter
                                               │
                              ┌────────────────┴────────────────┐
                              ↓                                 ↓
                           triage                           grouping
                              ↓                                 ↓
                        editor-pass-1               grouping-pass-1
                              └────────────────┬────────────────┘
                                               ↓
                                        pile-merge (optional)
                                               ↓
                                            editor
```

### collector
Hits every configured source, writes raw items to `raw_items`. Failure-tolerant
— a dead feed is logged and skipped. No deduplication here; cross-source pickup
is signal, not noise.

### preprocessor
URL canonicalization, exact-URL dedup within-source, junk-filter (deterministic
pattern rules in `junk-filter.ts`), track/group assignment from source config.
Writes `preprocessed_items`. The assembler (`assembler.ts`) queries the kept set
for downstream stages, composing filter, prefilter, and junk-filter results by
simple set intersection.

### filter
LLM-based garbage filter: JSON-structured output per batch, keep/discard with
reason. Needs no reader context — pure "is this a legitimate news item" judgment.

### prefilter
Bio-aware relevance floor between the preprocessor and the clusterer. Batched,
concurrency-capped (p-limit). Per-item verdict: `cut`, `news`, or `opinion`.
- `cut` — obvious noise this reader has no interest in (routine sports scores,
  celebrity tabloid, market-movement wire filler)
- `news` — flows into clustering (triage) and editor-pass-1 scoring
- `opinion` — kept but routed out of clustering; pools with `track=analysis`
  items for a future Longer Reads section
Conservative bias: when unsure, keep as `news`. Reads `docs/bio.md`.

### triage
Clusters the kept `news` items. Four-phase architecture:
1. **Seed** — one LLM call, wire items only. Produces the day's major-story
   clusters. Every spine accretes onto this same list, so seed item ids become
   the free merge key in phase 3.
2. **Spines** — thematic group-sets (domestic, international, local, tech), each
   one LLM call that accretes onto the seed's cluster list independently. Spines
   run concurrently (capped at `max_concurrent_spines`). Every spine starts fresh
   from the same seed, so its prompt stays bounded regardless of total pile size.
3. **Deterministic merge** — software union of any two clusters sharing ≥ 1 item
   id, transitively. No LLM call needed.
4. **Semantic merge/attach** — one final LLM call on a small input (the merged
   cluster list + up to `max_singletons` recent singletons) that fuses same-story
   clusters the id-union missed and attaches orphaned singletons (including
   cross-language items). Guarded by a `max_cluster_share` runaway check that
   falls back to the id-union result if the output looks like an over-merge blob.

Output: `triage_runs.digest` (flat `label;;summary;;ids` lines). Per-round
raw outputs stored in `round_digests` (seed, spine:*, merged, semantic_merge)
for stage-by-stage inspection.

### grouping
Embedding-based alternative to triage, running on the same preprocessed item
set. Three steps:
1. **Embed** — each item's title + body excerpt (capped at `body_cap` chars)
   is embedded via `qwen/qwen3-embedding-8b` (OpenRouter, 4096 dims) and
   stored in `item_embeddings` (upserted, so re-runs are cheap).
2. **Candidate groups** — pure software: cosine-similarity graph with
   `similarity_threshold` edge cutoff and `top_k` neighbour cap, then
   union-find connected components. Groups of size ≥ 2 become candidate
   clusters; isolated items are singletons.
3. **Describe** — batched LLM call (glm-5.1, nanogpt) that writes a neutral
   `title;;summary` for every multi-item cluster. Singletons skip this pass.
   Controlled by `grouping.describe.*` in `models.yaml`.

An optional **boundary-refine** step (one LLM call per large candidate group
asking "same event or split?") exists in the code behind `refine.enabled`
(default `false`). Keep the code; toggle the flag to re-enable.

Output: `grouping_runs.digest` — same flat `title;;summary;;ids` format as
triage. The **primary tuning lever** is `embedding.similarity_threshold` in
`models.yaml`: higher = fewer, tighter groups; lower = more, looser groups.

### grouping-pass-1
Scoring stage for the grouping path; lives in `src/pipeline/editor-pass-1/`
alongside the triage-path scorer. Two functions:

`runGroupingPass1` — bio-aware 0–100 scoring of every grouping output row,
clusters and singletons on the same scale. Clusters are scored on their
describe-pass title + summary; singletons on their title + body excerpt.
Source count is stored on each `grouping_pass1_results` row but the scorer
never sees it — scoring is purely reader-relevance. Uses the same model and
prompt as `editor-pass-1` (`editor_pass_1.*` config block). Writes to
`grouping_pass1_runs` / `grouping_pass1_results`.

`assembleGroupingPile` — sorts all scored rows by score descending, takes the
top `grouping.pile_target` (config: 150), and writes to `editor_piles` (with
`grouping_run_id` set, `triage_run_id` null) + `editor_pile_items`. Source
count travels to the editor via the grouping digest's id-list length.

### editor-pass-1
**Triage path** (original function): bio-aware 0–100 scoring of residual
singletons — items that survived prefilter but landed in no triage cluster.
Batched, concurrency-capped. Reads `docs/bio.md`. Assembles `editor_piles` +
`editor_pile_items` (all triage clusters included unconditionally; top-N
singletons by score up to `singleton_pile_target`).

The `editor-pass-1` module also houses the grouping-path scorer above
(`runGroupingPass1` / `assembleGroupingPile`). The two functions share the
same scoring prompt, model config, and `parseBatchOutput` parser.

### pile-merge
Optional same-story dedup pass that runs after pile assembly and before the
editor. Presents the assembled pile to a reasoning model (`moonshotai/kimi-k2.6:
thinking`, nanogpt) and asks it to identify items that cover the same specific
event. For each flagged merge group, one primary item is kept (cluster over
singleton, then highest source count, then lex ref for determinism) and
secondary items are absorbed: their source IDs are merged in and the excerpt of
a merged singleton is promoted to the summary field of the surviving entry.
Items not flagged survive unchanged.

Output: `pile_merge_runs` table (model used, items in/out, groups merged,
`merged_pile` JSONB). The pile's `pile_merge_run_id` FK is set; the editor
checks this column first and, when set, reads the merged pile directly from
`pile_merge_runs.merged_pile` instead of resolving digest rows from scratch.
Threshold is strictly same-specific-event — identical to triage's clustering
standard. Conservative bias: when in doubt, keep separate. Controlled by
`pile_merge.*` in `models.yaml`.

### editor
Whole-pile single LLM call. Reads all clusters and singletons from the editor
pile (or the merged pile, if pile-merge ran), ranks and tiers them: `feature`,
`standard`, `brief`, or `cut`. Emits `tier;;ref;;reason` lines in rank order;
software derives rank from line position. Streaming always on (`stream: true`).
Retry-once-then-fallback resilience: primary → retry primary once → optional
fallback model (`editor.fallback` in `models.yaml`). Reads `docs/bio.md`.

The system prompt is fully static (no runtime file reads). The bio travels in
the user message alongside the pile. The output parser is recognition-based:
each `;;`-delimited line is scanned for a tier keyword (`feature`, `standard`,
`brief`, `cut`) and a C/S ref pattern (`C\d+` / `S\d+`) independently of
column position, so format variation from the model (swapped columns, leading
numbering) doesn't break parsing.

Consumes piles from **three paths**: when `editor_piles.pile_merge_run_id` is
set it reads the merged pile JSONB directly; when `grouping_run_id` is set it
resolves cluster details from `grouping_runs.digest`; when `triage_run_id` is
set it uses `triage_runs.digest`. All three paths produce the same prompt
structure (`MergedPileBlock` list for the merged path, `EditorClusterPileItem` +
`EditorSingletonPileItem` for the digest paths).

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
- **Structured outputs preferred** over freeform parsing wherever the schema
  is knowable. Use JSON mode or tool-call shapes when the consumer is
  software; freeform text only when the consumer is the reader.
- **Agentic loops have budgets.** Step limit and token limit, both enforced.
  An unbounded agentic loop is how you discover a $40 bug.
- **No SDK-level retries.** `callLLM` sets `maxRetries: 0` on the OpenAI
  client. The SDK's default silent retries masked a 903s hang on one run.
  Retry logic, where needed, lives in stage code (e.g. editor's
  retry-once-then-fallback), not in the wrapper.
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
  parsers (triage, prefilter, editor-pass-1). LLM stages don't get
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
- `npm run migrate` — apply numbered SQL migrations

**Pipeline stages** (triage path — production)
- `npm run collect` — collect raw source items
- `npm run preprocess` — deduplicate/canonicalize collected items
- `npm run filter` — LLM garbage filter
- `npm run prefilter` — bio-aware relevance floor + news/opinion routing
- `npm run triage [-- --model <id>]` — cluster items; `--model` pins one
  model across seed + spines + semantic-merge for a clean bake-off
- `npm run editor-pass-1` — score residual singletons + assemble triage pile
- `npm run pile-merge [-- --pile-id <n>]` — same-story dedup pass on assembled pile
- `npm run editor [-- --pile-id <n>] [-- --model <id>]` — whole-pile ranking

**Pipeline stages** (grouping path — experimental parallel)
- (collect / preprocess / filter / prefilter same as above)
- `npm run grouping [-- --preprocessor-run-id <n>] [-- --model <id>]` —
  embed items, build candidate groups, run describe pass, write digest
- `npm run grouping-pass1 [-- --grouping-run-id <n>] [-- --model <id>]` —
  score all clusters + singletons on 0–100 bio-relevance scale, assemble pile
- `npm run pile-merge [-- --pile-id <n>]` — same-story dedup (shared with triage path)

**Inspection**
- `npm run inspect -- count [--source <name>]`
- `npm run inspect -- list [--source <name>] [--limit <n>]`
- `npm run inspect -- collector [--id <n>]`
- `npm run inspect -- preprocessor [--id <n>]`
- `npm run inspect -- filter [--id <n>]`
- `npm run inspect -- prefilter [--id <n>]` — shows cut/news/opinion breakdown
- `npm run inspect -- triage [--id <n>] [--rounds]` — `--rounds` shows each
  round's raw output (seed, spine:*, merged, semantic_merge)
- `npm run inspect -- editor-pass-1 [--id <n>]` — score distribution + pile info
- `npm run inspect -- editor [--id <n>]` — ranked/tiered list with resolved titles

**Assemble** (used for spot-checking, not the production pipeline)
- `npm run assemble` — assembles a preprocessor run into a triage document
  to see exactly what triage will receive as input

In production, run CLI stages inside the app container:

```bash
docker compose exec -T app npm run migrate
docker compose exec -T app npm run triage
docker compose exec -T app npm run inspect -- triage
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
- `docs/bio.md` — the reader; read by prefilter, editor-pass-1, grouping-pass-1, and editor
- `config/sources.yaml` — current feed list
- `config/models.yaml` — per-stage model, provider, budget, stream config
