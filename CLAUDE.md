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
- **LLM access:** OpenAI SDK pointed at OpenAI-compatible endpoints
  (Ollama Cloud, NanoGPT), wrapped in `src/llm/` for logging, typing,
  streaming, and per-stage budgets. Two provider credential pairs:
  `LLM_BASE_URL` / `LLM_API_KEY` (Ollama Cloud) and
  `NANOGPT_BASE_URL` / `NANOGPT_API_KEY` (NanoGPT). Provider is
  selected per-stage in `config/models.yaml`.
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
│   ├── standing-memo.md         # editorial voice (written)
│   ├── bio.md                   # the reader (written)
│   ├── source-policy.md         # operational rules for sources (TBD)
│   ├── preferences-written.md   # standing reader instructions (TBD)
│   └── preferences-observed.md  # agent-updated, dated entries (TBD)
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
│   │   ├── editor-pass-1/       # bio-aware per-item scoring + pile assembly
│   │   ├── editor/              # whole-pile tiering and ranking
│   │   ├── researcher/          # (stub)
│   │   ├── writers/             # (stub)
│   │   └── publisher/           # (stub)
│   ├── llm/                     # OpenAI SDK wrapper + logging + streaming
│   ├── db/                      # postgres connection, query helpers
│   ├── config/                  # models.yaml + sources.yaml loaders (Zod)
│   ├── app/                     # Next.js routes (the reading view)
│   └── lib/                     # shared utilities
├── scripts/                     # CLI entry points for each stage + inspect
├── migrations/                  # numbered SQL migrations (001–017)
└── tests/                       # unit tests for deterministic parsers
```

---

## Pipeline: implemented stages

The full concept is seven stages (see `docs/concept.md`). The following are
built and production-ready. Researcher, writers, and publisher are stubs.

```
collector  →  preprocessor  →  filter  →  prefilter
                                               ↓
                            editor  ←  editor-pass-1  ←  triage
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

### editor-pass-1
Bio-aware per-item scoring (0–100) of the news pile: all triage clusters plus
residual singletons above the prefilter floor. Batched, concurrency-capped.
Reads `docs/bio.md`. Output determines which singletons reach the editor pile
and at what priority. Also assembles the `editor_piles` and `editor_pile_items`
tables that the editor reads.

### editor
Whole-pile single LLM call. Reads all clusters and high-scoring singletons,
ranks and tiers them: `feature`, `standard`, `brief`, or `cut`. Emits
`tier;;ref;;reason` lines in rank order; software derives rank from line
position. Streaming is always on (`stream: true`) to bypass undici's ~300s
headers timeout for long reasoning calls. Retry-once-then-fallback resilience:
primary → retry primary once → optional fallback model (configured in
`models.yaml` under `editor.fallback`). Reads `docs/bio.md` and
`docs/standing-memo.md`.

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
- **provider selects credentials.** `provider: ollama-cloud` (default) uses
  `LLM_BASE_URL` / `LLM_API_KEY`. `provider: nanogpt` uses
  `NANOGPT_BASE_URL` / `NANOGPT_API_KEY`. Set per-stage in `models.yaml`.
- **Structured outputs preferred** over freeform parsing wherever the schema
  is knowable. Use JSON mode or tool-call shapes when the consumer is
  software; freeform text only when the consumer is the reader.
- **Agentic loops have budgets.** Step limit and token limit, both enforced.
  An unbounded agentic loop is how you discover a $40 bug.
- **No SDK-level retries.** `callLLM` sets `maxRetries: 0` on the OpenAI
  client. The SDK's default silent retries masked a 903s hang on one run.
  Retry logic, where needed, lives in stage code (e.g. editor's
  retry-once-then-fallback), not in the wrapper.

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

**Pipeline stages** (run in order for a full paper)
- `npm run collect` — collect raw source items
- `npm run preprocess` — deduplicate/canonicalize collected items
- `npm run filter` — LLM garbage filter
- `npm run prefilter` — bio-aware relevance floor + news/opinion routing
- `npm run triage [-- --model <id>]` — cluster items; `--model` pins one
  model across seed + spines + semantic-merge for a clean bake-off
- `npm run editor-pass-1` — bio-aware per-item scoring + pile assembly
- `npm run editor [-- --model <id>]` — whole-pile tiering and ranking

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
change to `LLM_BASE_URL`, `LLM_API_KEY`, `NANOGPT_BASE_URL`,
`NANOGPT_API_KEY`, or model config, recreate/rebuild the app container
before assuming `docker compose exec` sees the new values.

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
- `docs/standing-memo.md` — editorial voice; the editor's brief
- `docs/bio.md` — the reader; read by prefilter, editor-pass-1, and editor
- `config/sources.yaml` — current feed list
- `config/models.yaml` — per-stage model, provider, budget, stream config
