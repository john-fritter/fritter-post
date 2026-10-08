# CLAUDE.md

Operational guidance for Claude Code working in this repository.

**Before changing a stage, read its section of `docs/design.md`.** That is where
the mechanism and the reason for each behaviour live. This file holds the rules
that apply on every turn, the commands, and how to work with production.
`docs/decisions.md` (dated, indexed, append-only) has the history behind each
rule, and `docs/open-items.md` has what is known to be wrong. The pre-2026-10-08
version of this file, with the full stage narratives, is at commit `55e6978`.

---

## The project

The Fritter Post is a self-hosted personal daily newspaper for one reader,
served at post.fritter.lol. A daily systemd timer runs a pipeline that collects,
judges, ranks, writes and publishes a finite paper from a curated source set.

**What this is:** a newspaper. A daily artifact. Curated synthesis.

**What this is not:** a feed, a chatbot, a dashboard, a public product, an
engagement-optimized anything, or an independent reporting tool. Do not add
features in the direction of any of these. When in doubt, less is more.

## Stack

- **TypeScript**, **Next.js** (App Router) for the reading view.
- **PostgreSQL + pgvector**, self-contained in the docker-compose stack on a
  private network. The app container also joins `seedbox_default` so Caddy can
  reach it.
- **LLMs** via the OpenAI SDK against OpenAI-compatible endpoints, wrapped in
  `src/llm/`. `provider:` per stage in `config/models.yaml` picks the
  credentials: `ollama-cloud` (default, `LLM_*`), `nanogpt` (`NANOGPT_*`),
  `openrouter` (`OPENROUTER_*`, which serves the embeddings). After changing
  any of these, recreate the app container.
- **Embeddings**: `qwen/qwen3-embedding-8b`, 4096 dimensions, in `item_embeddings`.
- **Cron**: a systemd timer generated from `pipeline.schedule` by
  `npm run pipeline -- --print-timer`. Never maintain the hour in two places.

## The pipeline

```
collect → preprocess → screen → cluster → score [→ novelty → thread → pile]
        → rank → fetch → write → publish [→ continuity]
```

| stage | does | dir (`src/pipeline/`) | config | formerly |
|---|---|---|---|---|
| collect | sources → `raw_items` | `collect/` | — | collector |
| preprocess | canonicalize, dedup, translate; junk filter on read | `preprocess/` | `preprocess` | preprocessor |
| screen | bio-aware cut / news / opinion | `screen/` | `screen` | prefilter |
| cluster | embeddings + split / attach / describe → events | `cluster/` | `cluster`, `embeddings` | grouping |
| score | two-axis bio-aware relevance | `score/` | `score` | grouping-pass-1, editor-pass-1 |
| novelty | new / development / minor / routine / rerun | `novelty/` | `novelty` | rerun check |
| thread | events → ongoing situations | `thread/` | `thread` | — |
| rank | pile, formula, tiers, tie-break | `rank/` | `rank` | editor |
| fetch | article text for feature and standard pieces | `fetch/` | `fetch` | fetch-text |
| write | packets and writer calls | `write/` | `write` | writers |
| publish | freeze the paper, source links | `publish/` | `publish` | publisher |
| continuity | the "previously" marker | `continuity/` | `publish.continuity` | lineage |

The runner (`runner/`) has nine stages: novelty, thread and the pile run inside
`score`, and continuity inside `publish`. **Tables and `--…-run` flags still
carry the old names** (`grouping_runs`, `editor_stories`, `--editor-run`, …);
`docs/design.md` §6 maps them. "Lineage" now means provenance only.

## Repo layout

```
config/          models.yaml (per-stage everything, in pipeline order), sources.yaml
docs/            concept, design, operations, decisions, open-items, bio, voice; gizmo/ task files
migrations/      numbered SQL (001–048; next is 049; 025 is used twice, harmlessly)
scripts/         one CLI per stage, inspect, pipeline, experiments, test runner
src/pipeline/    one directory per stage, plus runner/
src/llm/         callLLM (logging, streaming) and callWithBackoff
src/db/          pool, latest-run lookups, outlet counting
src/config/      Zod loaders for models.yaml / sources.yaml; one-run model overrides
src/lib/         shared utilities (text.ts: English text + caps; http.ts: UA policy)
src/app/         the reading view
tests/           node:assert scripts for the deterministic parts
```

---

## Rules

These are invariants. Each one was learned from a run that broke, and the dated
entry in `decisions.md` says which.

### LLM calls

- **Every LLM call is logged** to `generation_logs` with model, full prompts,
  output, tokens, cost, stage and run id. This is non-negotiable; it is the
  feedback loop. An empty response is recorded as an error *before* the row is
  written.
- **Config, not code.** Model, provider, budgets, temperature, stream,
  timeout_ms, caps and thresholds all live in `config/models.yaml`. A hardcoded
  one is a bug. For Ollama Cloud, use canonical IDs from `/v1/models`.
- **Pass the whole stage config to `callLLM`.** Leaving off `provider`,
  `timeout_ms` or `stream` still works, on silently wrong defaults.
- **Stream reasoning models** (`stream: true`). Non-streamed calls get no
  headers until done, and undici's ~300s headers timeout kills them.
- **No SDK retries** (`maxRetries: 0`). Retries live in `callWithBackoff`
  (`src/llm/backoff.ts`): 429/503, broken streams, and budget-exhausted empty
  responses. **It never retries timeouts.**
- **Any batched, concurrent stage uses `callWithBackoff`.** A lost call that
  returns an empty-but-valid answer is indistinguishable from a real verdict, so
  the run reports success while losing work. Persist a counter that tells the
  two apart, and add a straggler re-ask where the unit can be lost silently.
- **Judgment stages read English** through `src/lib/text.ts`
  (`englishTitle`, `englishBodyExcerpt`). Never `slice()` a body inline. The cap
  is a named config field, and it is the biggest lever on what a stage knows.
- **Agentic loops have budgets**: a step limit and a token limit, both enforced.
- **Prefer structured output** when the consumer is software.

### Prompts

- **A model relays what the prompt says about itself.** Never describe the
  packet's plumbing to a writer: no source counts, no "feed summary only", no
  "truncated", no "N sources omitted". This has been learned five times. A note
  says what to *do* about a gap, never what the gap is.
- **The cluster label is not evidence.** It was generated from articles the
  packet may not include.
- **A number beats an instruction.** Thin material gets a word *ceiling* with no
  floor.
- **Don't change prompt text as a side effect.** A prompt edit is an LLM-judgment
  change and needs a noise-controlled measurement (§Gizmo).

### Stage-specific rules that bite

- **collect**: Decode charsets ourselves (`collect/charset.ts`); never hand
  rss-parser a URL. Retry once with a browser UA on a 403 only. `max_age_hours`
  stays opt-in for RSS. An undated item is kept.
- **preprocess**: The junk filter is the only hard gate (`getClusteringItems` is
  the sole path into cluster and score). Rules are extended **from audit
  evidence only**, each with a `tests/junk-filter.test.ts` case for the cut
  *and* the near-miss. Unwrap redirectors by path, never by query string. Strip
  a bare domain from titles, never an outlet name. Translation trips its breaker
  on auth errors.
- **cluster**: Never embed an empty string. `attach_unrecovered > 0` means the
  run must not be used to judge cluster quality or tune `similarity_threshold`.
  NULL counters mean "didn't run", not zero.
- **score**: The item is the unit, not the call. Every unscored item is
  re-asked. `FAIL_SAFE_SCORE` is 0, never mid-range. The scorer never sees
  source counts.
- **novelty**: It fails **open**; only a stated `RERUN` withholds. Extend
  `newsForWriter`'s cleanup from audit evidence, with tests. Every graded row is
  persisted.
- **thread**: One call over the whole candidate set. The anchor is stated by the
  model and deliberately not validated in software. Thread numbers are derived
  in software, never asked for.
- **rank**: Sources means distinct **parent outlets**, minimum 1 (`ln(0)` sorts
  silently to the bottom). Don't put an LLM ranker back.
- **fetch**: No whole-document fallback; a non-HTML response is not read. Strip
  NULs; a refused row costs one article. `article_texts` is the only table with
  third-party full text, and it is **never published**. Furniture rules in
  `write/boilerplate.ts` follow the junk filter's evidence-and-test rule.
- **write**: Source material is not rationed (`max_articles` / `total_chars`
  are null); when a piece runs long, fix the guidance, not the input.
  `endsMidSentence` and `isHeadlineEcho` are judged on the *stripped* body.
  Sidebars are never batched. Every repaired piece is an individual call.
  Parsing is forgiving and production is not retried: a missing headline costs
  the headline, and the last labelled draft wins. Pieces are persisted as each
  call returns; a failed call is a `failed` row, not an exception.
- **publish**: It refuses to replace a paper with a much smaller one
  (`--force` is deliberate). Source rows carry copies, not just FKs. No
  third-party text.
- **continuity**: It fails **closed**. A YES names something both texts say.
  Lookback is in editions. The marker is text, never a link. It never fails a
  paper.
- **runner**: A warning must be an event, not a standing condition. Gates
  (`runner/gates.ts`) stay pure and tested. The deadline is checked only
  between stages. Recovery is `--from`, never a same-day full re-run. A stage
  row is written when the stage starts.
- **reading view**: Colour means a link out to someone else's reporting, and
  nothing else. `/article/<id>` is `writer_pieces.id`. `displayHeadline` never
  trims a line to a "first sentence" ("U.S." would become the headline). No
  counts or engagement metrics.
- **published schema**: Fritter Board reads only `published.articles` and
  `published.article_sources` (migration 046). Add columns freely; **never
  rename or drop one** without changing the board in the same breath.

### Pipeline runs

- **Graceful degradation.** A failed feed, cluster, article or writer call
  must never cost the edition. Log it, count it, render what works.
- **Full lineage.** Every published piece traces back to raw items; keep the
  foreign keys.
- **Idempotent where possible.** Re-running a stage on the same input gives a
  comparable output, not duplicate rows.

### Code

- **TypeScript strict.** No `any` without a comment justifying it.
- **No magic numbers.** Configuration goes in config files.
- **Small, focused modules.**
- **Tests where they earn their keep**: deterministic code, especially the
  flat-line parsers, the gates, the formulas and the filters. LLM stages are
  checked through the inspect CLI and measured runs.
- **No top-level await in scripts.** tsx runs them as CJS. Use
  `async function main()` and `main().catch(...)`.
- **Internal imports use `.js` specifiers** pointing at `.ts` files;
  `next.config.ts` aliases them for webpack.

### Postgres quirks

- **Top-level JS arrays become Postgres arrays**, not JSON. For a JSONB column
  holding an array, pass `JSON.stringify(value)` with an explicit `$1::jsonb`.
- **npm strips quotes from script args.** For arguments with spaces, run tsx
  directly: `./node_modules/.bin/tsx scripts/collect.ts --source "AP Top News"`.

### Docs

- `decisions.md` is append-only and newest first. Add an entry (and an index
  line) for any decision worth recording; supersede old entries, never edit them.
- `open-items.md` is a to-do list with evidence. Remove an item when it is fixed.
- When you change how a stage works, update its section in `docs/design.md`.

---

## Commands

Run with `npm run <script>`. In production, prefix with
`docker compose exec -T app`.

**Infrastructure**: `dev`, `build`, `typecheck`, `test` (every
`tests/*.test.ts`, each in its own process), `migrate`.

**The daily run**
- `pipeline`: every stage with a gate between each pair. This is what the timer
  runs.
- `pipeline -- --from <stage> [--to <stage>]`: resume from a stage, inheriting
  the last run's recorded ids. This is the recovery path.
- `pipeline -- --dry-run`: print the plan and inherited ids; run nothing.
- `pipeline -- --skip-cross-run-dedup`: **testing only.** It makes a full run
  possible on a day that has already run. The paper reuses published items.
- `pipeline -- --print-timer [--working-dir <path>]`: generate the systemd
  unit and timer.

**Stages by hand.** Each one defaults to its latest completed upstream run.
Hand runs skip the gates.
- `collect [-- --source <name>]`, `preprocess`, `screen`
- `cluster [-- --preprocessor-run-id <n>]`
- `score [-- --grouping-run-id <n>]`: also runs novelty and thread, and
  assembles the pile
- `rank [-- --pile-id <n>]`
- `fetch -- --editor-run <n> [--dry-run] [--limit <n>]`
- `write -- --editor-run <n> [--tier <t>] [--limit <n>] [--ranks 1-6,20]`
- `write -- --repair <writer-run-id>`: re-write only the failed pieces, in place
- `publish -- --writer-run <n> [--date YYYY-MM-DD] [--force]`

**Inspection** (`inspect -- <command>`; the old names still work)
- `count`, `list [--source <name>] [--limit <n>]`
- `collect`, `preprocess`, `screen`, `rank`, `write`, `publish` `[--id <n>]`: a
  stage's runs, or one in detail. `write --id <n> --full` prints the bodies.
  `publish --id` shows per-piece `resolved/ranked` sources and each
  "previously" link.
- `novelty [--id <n>] [--all]`: withheld and reduced rows, with the judge's
  sentence. It is the only place a wrong drop shows.
- `pipeline [--id <n>]`: how each daily run ended, with gate verdicts and
  metrics. Start here when you need to know why the paper is short.
- `timing`: per-stage durations and the time spent between stages.
- `materials --editor-run <n>`: body text behind each story, feed vs fetched.
- `packet --editor-run <n> [--rank <n>]`: packet sizes, headline-only counts,
  tier swaps, why sources were left out; `--rank` prints the full prompt.
- `fetch [--days <n>]`: per-outlet fetch outcomes and the hosts in cooldown.
- There is no `inspect cluster` or `inspect score` yet. Query `grouping_runs`
  and `grouping_pass1_results` by hand.

**Experiments.** Override flags: `write`, `screen`, `score`, `novelty-check`,
`continuity-check` and `thread-check` take `--model`, `--provider`,
`--reasoning-effort <level|omit>`, `--max-tokens` and `--timeout-ms` for one run.
**Always run production beside the candidate as a noise control**, and test a
reasoning model at more than one level. Raise `--max-tokens` with the level.
`screen` writes the run that cluster will read, so never test it on today's
preprocessor run.
- `probe-source -- --robots <host>`: start here. robots.txt names the feeds
  and news sitemaps. Also `--feeds <host>`, `--sitemap <url>` (runs the real
  extractor), and `--resolve <url>` / `--resolve-source <name>` (aggregator
  links, verified against the title).
- `embedding-experiment -- --probe <provider>`: which embedding models a
  provider really serves (`/v1/models` lists chat models only).
- `writer-bakeoff-export -- --runs <a,b> --out <dir> [--blind]`: read every
  piece against its packet before opening the key.
- `novelty-check -- --grouping-pass1-run <n> --as-of YYYY-MM-DD`: the novelty
  judge alone, as of a date.
- `novelty-preview -- --papers 43-52 --out <file.md>`: the front pages with and
  without the grades. This is how `novelty.grades` is calibrated.
- `continuity-check -- (--last <n> | --papers <a,b>) --out <file.md>`: replay
  the "previously" judge and diff it against the printed links.
- `thread-check -- --pass1-runs <a,b> [--export --out <file.md> [--blind]]`
- `translation-experiment -- --preprocessor-run-id <n> --limit <n> --model <p>:<id> --out <file.md>`

---

## Working with Gizmo (the production agent)

**You do not have access to the production box.** post.fritter.lol, its compose
stack and its database live on fritter.lol, and this session can't reach them.
The egress proxy blocks the host, and there's no DATABASE_URL here. Anything
that has to touch production is done by **Gizmo**, the agent that runs there.
The reader relays between you. `docs/operations.md` describes the box.

- **Deliver every Gizmo task as a file**, via SendUserFile, not as a code block
  in chat. Put it in `docs/gizmo/` as `gizmo-<topic>-prompt.md`.
- **Write it for an agent with no context.** State the branch and commit, what
  changed, what you're trying to learn, and what to report back.
- **Give exact commands**: `docker compose exec -T app npm run <script> -- <args>`.
- **Tests aren't in the production image.** Have Gizmo run `npm test` from the
  source checkout on the host.
- **Always include the network reconnect** after a rebuild:
  `docker network connect seedbox_default fritter-post-app-1`. This is the most
  common way a deploy goes wrong.
- **Include `npm run migrate`** when the change carries a migration.
- **Say what must not happen.** A read-only investigation says so: no
  `collect` / `preprocess` / `write` / `publish`, and no config edits. Findings
  come back here and the change is made on the branch, so the repo and the box
  don't drift.
- **Ask for raw evidence and a workspace path.** Gizmo keeps command output and
  checksums it. When a number matters, take the raw files over the summary.
- **Fritter Board shares the database** (`board` schema, role `fritter_board`,
  `/srv/fritter-board`). It reads only the `published` views.
- **The postgres image is pinned by digest; upgrading it means a reindex.** The
  nightly backup runs `amcheck`. See `docs/operations.md`.

**Verify Gizmo's claims, and expect it to verify yours.** It has caught real
errors here and has also reported correct queries as defective. Its aggregate
statistics can be the wrong test for a targeted change: a mean over 469 rows
can't see an effect confined to the 100 local ones.

**Measuring a change on the box.**
- An **LLM-judgment change** (a prompt, the bio) needs a noise control. Score
  the same input three times: the existing run, a re-run on the old code, and a
  run on the new code. Check the `system_prompt` hash in `generation_logs` to
  prove the prompts differed.
- A **deterministic change** (a formula, a count) needs no control. Re-run the
  one stage over the same input at both commits and diff.

---

## Out of scope for V1

Documented so these don't get built by accident:

- Interactive AI inside the paper (RAG modal, chat-with-this-article, etc.)
- Search across the archive
- Calendar/tag navigation of the archive
- Read-later integration
- Reaction buttons or any engagement metric
- Public/multi-user support. This is for one reader.
- Independent reporting from primary sources (Federal Register, court filings,
  city council agendas). The paper is an aggregator and synthesizer.
- Authentication beyond what's needed for the comment field

If you find yourself reaching for any of these, stop and raise it for
discussion first.
