# Decisions

Append-only log of significant choices, with context and rationale.
Newest entries at the top.

When making a decision worth recording, add an entry. Don't edit old
entries — if a decision is reversed, add a new entry that supersedes it
and reference the old one. The point of this document is that future
agents and future-you can understand why things are the way they are.

Entry format:

```
## YYYY-MM-DD — Short title
**Decision:** What we decided.
**Context:** What we knew at the time.
**Rationale:** Why this over alternatives.
**Supersedes:** (optional) Reference to an earlier entry, if reversing one.
```

---

## 2026-05-27 — Self-contained Postgres inside the compose stack

**Decision:** Postgres runs as a service inside the project's own
docker-compose stack on a private internal network. The app service joins
both the internal network (to reach Postgres by service name) and the
external `seedbox_default` network (so Caddy can reach the app by container
name). No Postgres port is published to the host.

**Context:** The original stack design assumed a shared host-level Postgres
instance that both Fritterflix and Fritter Post would use (see 2026-05-26
stack entry). A subsequent implementation attempt (see 2026-05-27
host.docker.internal entry) tried to reach that host Postgres via
`host.docker.internal`. Both were wrong: there is no shared host Postgres on
fritter.lol. Fritterflix runs its own Postgres inside its own compose stack
on a private internal network, and Caddy on the host proxies to the app
container via the `seedbox_default` Docker network.

**Rationale:** Mirroring the Fritterflix pattern is the right call for several
reasons:
- Each project owns its database: no cross-project coupling, no shared failure
  modes, independent backup and upgrade paths.
- The `seedbox_default` network is already established on the host for Caddy
  routing. Joining it is the correct mechanism for host-side Caddy to reach
  app containers without publishing ports.
- `host.docker.internal` on Linux requires `extra_hosts: host-gateway`, works
  differently across Docker versions, and becomes moot if there is no host
  Postgres to reach.

**Supersedes:** 2026-05-26 "Stack: TypeScript + Next.js, reuse Postgres" (the
database portion only); 2026-05-27 "Docker → host Postgres via
host.docker.internal".

---

## 2026-05-27 — Lazy database pool initialization

**Decision:** `src/db/index.ts` exports `getPool()` (lazy, cached) instead of
a module-level singleton that throws at import time.

**Context:** The previous implementation threw immediately if DATABASE_URL was
unset, which meant Next.js build would fail unless a dummy value was provided.
The Dockerfile had a dummy value hard-coded for exactly this reason.

**Rationale:** The pool is only needed when a database call is actually made.
Deferring initialization to first use means importing `src/db/index.ts` is
always safe, and the build no longer requires a dummy DATABASE_URL. The
dummy was a maintenance hazard — if it were a valid connection string in a
CI environment, it could cause unexpected database connections.

---

## 2026-05-27 — Collector RSS library: rss-parser

**Decision:** Use `rss-parser` for RSS and Atom feed parsing.

**Context:** Alternatives considered: `feedparser` (Node.js streams, less
TypeScript-friendly), `@extractus/feed-extractor` (newer but smaller ecosystem),
rolling our own XML parser with `xml2js` (unnecessary complexity).

**Rationale:** `rss-parser` handles RSS 1.0, 2.0, and Atom in one package,
has first-party TypeScript types with useful generic type parameters for custom
fields, supports `timeout` and custom `headers` directly in the constructor,
and is the most widely used feed-parsing library for Node.js. The custom field
generics let us type `content:encoded` and `dc:creator` without resorting to
`any`.

---

## 2026-05-27 — Synthesized guid: SHA-256 of source + url + title

**Decision:** When a feed item lacks a guid, synthesize one as
`"synth:" + SHA-256(source_name + "\0" + original_url + "\0" + title).slice(0, 40)`.

**Context:** The `(source_name, item_guid)` unique constraint enforces
idempotency. If two runs disagree on the synthesized guid for the same logical
item, the constraint fails to deduplicate and you get duplicate rows.

**Rationale:** The three fields (source, URL, title) together identify a news
item with high confidence. NUL-byte separators prevent ambiguous concatenation.
The `"synth:"` prefix visually distinguishes synthetic guids from feed-supplied
ones in debugging contexts. SHA-256 is deterministic across platforms and
truncated to 40 hex chars (160 bits) is more than sufficient for uniqueness at
any realistic feed volume.

---

## 2026-05-27 — Docker → host Postgres via host.docker.internal

**Decision:** The container reaches the host's Postgres instance via the
hostname `host.docker.internal`, backed by `extra_hosts: host-gateway` in
docker-compose.yml.

**Context:** Postgres runs on the host alongside Fritterflix and is not part
of the compose stack. The container needs a stable way to address the host.

**Rationale:** Three options considered:
1. `network_mode: host` — the container shares the host's network namespace.
   Simple, but eliminates container network isolation and port-mapping control.
2. Hardcoded host IP — fragile; breaks if the host's IP changes.
3. `host.docker.internal` + `extra_hosts: host-gateway` — explicit, portable
   across Docker versions on Linux, matches the Docker Desktop behavior on
   Mac/Windows, and keeps the compose file self-documenting. Preferred.

---

## 2026-05-27 — Migration runner: custom tsx script, not a library

**Decision:** Migrations are plain numbered .sql files in `migrations/`.
A small `scripts/migrate.ts` runner discovers, applies, and records them.
No third-party migration library (Flyway, node-pg-migrate, Umzug, etc.).

**Context:** The project uses `pg` directly (no ORM), and the migration
surface is expected to be small and infrequent.

**Rationale:** A custom runner is ~70 lines and has zero hidden behaviour. It
applies files in filename order (alphabetical = numeric order for the `NNN_`
prefix scheme), wraps each in a transaction, and records completions in a
`_migrations` table. That's the whole contract. A library would add a
dependency for essentially the same logic.

---

## 2026-05-27 — raw_items table shape

**Decision:** `raw_items` columns: `id`, `source_name`, `source_type`,
`feed_url`, `item_guid`, `original_url`, `url` (nullable, set by
preprocessor), `title`, `body` (nullable), `author` (nullable),
`published_at` (nullable), `fetched_at`, `raw_entry` (JSONB).
Unique constraint on `(source_name, item_guid)`.

**Context:** The collector writes one row per item per feed fetch. The
preprocessor reads these rows and adds canonical URLs. Later stages only
read from preprocessed clusters, not directly from raw_items.

**Rationale:**
- `item_guid` is the feed's own identifier (RSS `<guid>`, Atom `<id>`).
  When absent, the collector synthesizes one (e.g. hash of source + URL).
  This is the idempotency key — re-running the collector ON CONFLICT DO NOTHING.
- `original_url` is what came out of the feed; `url` is populated later by
  the preprocessor after canonicalization (tracking params stripped, AMP
  normalized). Keeping both preserves debugging lineage.
- `body` and `author` are nullable because many feeds don't provide them.
- `published_at` is nullable for the same reason (feed omissions are common).
- `raw_entry` JSONB preserves the full feed entry so no information is lost;
  extraction can be improved later without re-fetching.
- Indexes on `source_name`, `fetched_at`, and `url` cover the expected query
  patterns: source filtering, retention window management, and preprocessor
  deduplication.

---

## 2026-05-26 — Build pipeline before publisher

**Decision:** Build the upstream stages (collector → preprocessor →
triage → researcher) first, before designing the publisher and the
visual layout.

**Context:** The original instinct was to mock up a target paper first
and reverse-engineer the publisher schema from it. After working through
sizing, it became clear that the unknown isn't "what does a newspaper
look like" — newspapers are a largely-solved layout problem — but "what
does a real day's worth of relevant-to-John content actually look like
after triage." That's information you can't get without running the
pipeline.

**Rationale:** The output of the researcher stage is the answer to "how
much content is there per day, of what kinds." Once that's running for a
couple of weeks, the layout decisions become tractable because there's
real data to design for. Starting with the publisher would mean
designing around guesses.

**Tradeoff:** Several weeks of work where the only artifact is JSON in a
database, before there's anything visual to look at.

---

## 2026-05-26 — Drop primary sources for V1

**Decision:** Federal Register, SEC EDGAR, CourtListener, OLIS, Bend
city council agendas, and similar primary-source feeds are out of scope.

**Context:** The earlier source draft included a "Primary Sources"
section in the spirit of I.F. Stone reading the documents others ignore.

**Rationale:** The Fritter Post is a news aggregator and synthesizer,
not an independent reporting tool. Primary sources are a different kind
of project. They'd also blow up the collector's volume — the Federal
Register publishes hundreds of items a day. Worth keeping in mind for a
future project; not appropriate for this one's V1.

---

## 2026-05-26 — Drop the "state-media" source type

**Decision:** Removed `state-media` as a value of the source `type`
field. All journalistic sources are `journalism`; institutional alignment
goes in the notes.

**Context:** Earlier draft labeled Xinhua as `state-media`. BBC, Al
Jazeera, and NPR all have institutional alignment with their funders but
weren't labeled the same way.

**Rationale:** Every outlet has institutional alignment that affects
coverage of certain topics. Singling out outlets aligned with adversarial
governments while treating Western state-funded outlets as neutral is
itself a politically loaded frame. The honest move is to drop the
category and put context in notes for the sources where alignment
matters — BBC, Al Jazeera, NPR, Xinhua, SCMP all get brief factual notes
about their institutional position.

There's still a meaningful operational distinction (operationally
independent outlets vs. outlets whose editorial line is directly set by
government) but it's a spectrum, not a binary, and the source policy
document can handle the operational nuance.

---

## 2026-05-26 — Source schema: no tiers, no categories

**Decision:** Sources have `name`, `url`, `type`, and `notes`. No
prominence tiers. No pre-assigned topic categories.

**Context:** Earlier draft assigned each source a tier (1/2/3) and a
category (us-national, world, tech, etc.).

**Rationale:**

Tiers ask for a confidence judgment on every source before there's any
data to ground that judgment in. The functional purpose of tiers
(prominence weighting in the preprocessor) is something the triage LLM
can do fine on its own based on source identity and cross-source pickup.
If triage gets prominence wrong in practice, tiers can be added back.

Categories belong on stories, not sources. The Markup writes both tech
and accountability pieces; The Guardian covers everything. A source-level
category is either ambiguous (which is wrong) or duplicated (which is
overhead). Story-level tagging by the editor stage is the right model.

`type` stays because the source policy genuinely treats wires,
journalism, advocacy, and newsletters differently in operational ways
(volume, voice, trust handling).

---

## 2026-05-26 — Longer Reads as both source category and section

**Decision:** The paper includes a Longer Reads section curating 1-3
long-form pieces per week. Several sources are added primarily as feeders
for this section (The Atlantic, New Yorker, NYRB, LRB, Reason, Foreign
Affairs, Harper's, Aeon, Noema, etc.). Long pieces from other sources
(Jacobin features, ProPublica investigations, Le Monde Diplomatique)
also feed it.

**Context:** The concept doc already specified "Outside long-reads are
surfaced with substantial context paragraphs and prominent links. No
reproduction of others' text," but it wasn't architecturally surfaced.

**Rationale:** Longer Reads is curatorially distinct from daily news.
The decision is "which 1-3 long pieces from the past 1-7 days should
this reader make time for," not "which stories from today belong in the
paper." Different cadence, different judgment. The editor stage will
need a separate sub-process for it.

---

## 2026-05-26 — Stack: TypeScript + Next.js, reuse Postgres

**Decision:**
- Language: TypeScript
- Framework: Next.js (App Router)
- Database: existing PostgreSQL on fritter.lol, separate database
- Deployment: Docker behind Caddy at post.fritter.lol

**Context:** Fritterflix on the same box is already TypeScript/Next.js.
Postgres is already running. Reader develops conversationally with
coding agents, doesn't write code directly.

**Rationale:** Match the existing stack for operational simplicity (one
language, one database, one Docker pattern) and because coding agents
handle Next.js + TypeScript exceptionally well. Astro would be slightly
more on-aesthetic for a content site but doesn't earn the cost of
introducing a second framework.

**Alternatives considered:** Astro (content-first, ships less JS), plain
Node with templating (minimal). Rejected on framework-cost grounds.

---

## 2026-05-26 — LLM client: OpenAI SDK + thin internal wrapper

**Decision:** Use the OpenAI SDK as the HTTP/SSE client, pointed at
OpenAI-compatible endpoints (Ollama Cloud, OpenRouter). Wrap it in
`src/llm/` for project-specific concerns: logging every call to Postgres,
typed stage configs, retry policy, step-and-token budgets for agentic
loops.

**Context:** Considered rolling our own client. Considered LangChain-
style heavyweight frameworks.

**Rationale:** The HTTP/SSE layer is solved — rolling our own gets
nothing. Heavyweight frameworks introduce abstractions we'd need to
fight to get the lineage and logging this project specifically requires.
The thin wrapper is 100-200 lines and contains the parts that matter for
this project (full call lineage in Postgres, budget enforcement, typed
per-stage config). "Use the library for the boring part, write our own
for the project-specific part."

---
