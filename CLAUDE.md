# CLAUDE.md

Operational guidance for Claude Code working in this repository.

For the project's vision, principles, and pipeline architecture, read
`docs/concept.md` first. For the reasoning behind specific choices,
read `docs/decisions.md`.

---

## The project

The Fritter Post is a self-hosted personal daily newspaper for one reader,
served at post.fritter.lol. A daily cron runs a seven-stage pipeline that
collects, synthesizes, and renders a finite paper from a curated source set.

**What this is:** a newspaper. A daily artifact. Curated synthesis.

**What this is not:** a feed, a chatbot, a dashboard, a public product, an
engagement-optimized anything, or an independent reporting tool. Do not add
features in the direction of any of these. When in doubt, less is more.

---

## Stack

- **Language:** TypeScript
- **Framework:** Next.js (App Router) — matches Fritterflix on the same box
- **Database:** PostgreSQL — existing instance on fritter.lol, shared with
  Fritterflix in a separate database/schema
- **LLM access:** OpenAI SDK pointed at OpenAI-compatible endpoints
  (Ollama Cloud, OpenRouter, etc.), wrapped in `src/llm/` for logging,
  typing, retries, and stage-level budgets
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
│   ├── standing-memo.md         # editorial voice (TBD)
│   ├── source-policy.md         # operational rules for sources (TBD)
│   ├── bio.md                   # the reader (TBD)
│   ├── preferences-written.md   # standing reader instructions (TBD)
│   └── preferences-observed.md  # agent-updated, dated entries (TBD)
├── config/
│   ├── sources.yaml             # feed list
│   └── models.yaml              # per-stage model config (TBD)
├── src/
│   ├── pipeline/                # the seven stages
│   │   ├── collector/
│   │   ├── preprocessor/
│   │   ├── triage/
│   │   ├── researcher/
│   │   ├── editor/
│   │   ├── writers/
│   │   └── publisher/
│   ├── llm/                     # OpenAI SDK wrapper + logging
│   ├── db/                      # postgres connection, query helpers
│   ├── app/                     # Next.js routes (the reading view)
│   └── lib/                     # shared utilities
├── scripts/                     # CLI tools for inspection
├── migrations/                  # schema migrations
└── tests/
```

Stages map directly to the architecture in `docs/concept.md`. Keep each
stage's code self-contained — its input/output contract with the next
stage is the abstraction.

---

## Conventions

### LLM calls

- **Every LLM call is logged.** A `generation_logs` table records model,
  full prompts, full output, token counts, cost estimate, stage, run id.
  This is non-negotiable — it's the feedback loop.
- **Per-stage configuration** lives in `config/models.yaml`. Model, token
  budgets, step limits for agentic loops, temperature, retry behavior.
  Hardcoding any of these in stage code is a bug.
- **Structured outputs preferred** over freeform parsing wherever the
  schema is knowable. Use JSON mode or tool-call shapes when the consumer
  is software; freeform text only when the consumer is the reader.
- **Agentic loops have budgets.** Step limit and token limit, both
  enforced. An unbounded agentic loop is how you discover a $40 bug.

### Pipeline runs

- **Graceful degradation.** A single failed feed, cluster, article, or
  writer call should never crash the whole paper. Log it, render what
  works, move on. The publisher in particular is designed to be tolerant.
- **Full lineage.** Every published story can be traced back through
  writing package → article idea → cluster → raw item(s). The schema
  preserves these foreign keys.
- **Idempotent where possible.** Re-running a pipeline stage with the
  same inputs should produce a comparable output, not duplicate rows.

### Code

- **TypeScript strict mode.** No `any` without comment justifying it.
- **No magic numbers.** Configuration goes in config files, not source.
- **Small, focused modules.** A stage submodule that grows past a few
  hundred lines probably wants to be split.
- **Tests where they earn their keep.** Preprocessor logic (URL
  canonicalization, dedup, clustering) needs tests — it's deterministic
  software with clear inputs and outputs. LLM stages don't get
  conventional unit tests; their feedback loop is the inspection CLI.

---

## Commands

To be filled in as the project is set up. Expected:

- `npm run dev` — Next.js dev server
- `npm run build` — production build
- `npm run pipeline:run` — execute the daily pipeline once
- `npm run pipeline:stage <name>` — execute one stage (for iteration)
- `npm run inspect <stage> <run-id>` — pretty-print stage output
- `npm run db:migrate` — run pending migrations

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
- `docs/decisions.md` — why specific choices were made
- `config/sources.yaml` — current feed list
- The standing memo (`docs/standing-memo.md`) is the editorial document;
  it's the single most consequential artifact in the project once written.
  Write carefully when the time comes.
