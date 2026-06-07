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

## 2026-06-07 — Triage clusterer: ordered group-rounds → wire seed + parallel spines + id-union merge

**Decision:** Replace the single-chain ordered-rounds clusterer with three
phases: a **seed** call that clusters only `group: wire` items, a set of
**spines** — thematic group-sets defined in config — that each accrete onto
the seed's cluster list independently and run *concurrently*, and a
**deterministic software merge** that unions the spines' outputs into the
final digest by shared item ids. No semantic-matching LLM call is needed for
the merge.

**Context:** The group-based round chain (entry directly below) also failed,
just later: it got through `wire` → `national` → ... → `local` (round 9), but
the carry-forward "loose pool" of unclustered items kept re-inflating round
over round — 495 → 637 → 647 → 714 items by `tech` (round 10) — until that
round's prompt hit the same `qwen3.5:397b` 903s wall and produced no digest.

Root cause was structural, not a tuning problem: a **single accretion chain**
is sequential (call N+1 can't start until call N returns) **and** every round
inherits every prior round's unclustered items, so the loose pool only ever
grows. Splitting groups into more, smaller, better-ordered rounds delays the
blowup; it can't prevent it, because the chain's defining property — one
shared, ever-growing carry-forward pool — is what causes it.

**Rationale:** Removing the chain removes both failure modes at once:

- **No sequencing.** Each spine is an independent call from the same
  starting point (the seed's cluster list) — there is no "prior round" to
  wait on, so spines run concurrently (capped at `max_concurrent_spines`,
  reusing editor-pass-1's `p-limit` concurrency-limiter pattern: provider
  caps us at 3 simultaneous connections).
- **No shared, growing carry-forward pool.** A spine sees only its own
  group-set's items as "new items," never another spine's leftovers. Its
  prompt size is bounded by its own slice of the pile — config-controlled,
  not emergent — so it stays in the model's proven working range (~130 items,
  per the original `wire` round's clean 40s run) regardless of total pile
  size or how clustering is going elsewhere.

The seed-shared-id insight is what makes the merge deterministic and
semantic-matching-free: every spine accretes onto the *same* seed cluster
list and re-emits it as part of its output, so the same major story appears
in multiple spines' outputs sharing the seed's item ids — an exact merge key.
Any two clusters (across any spines, including re-emitted copies of the same
seed cluster) sharing >= 1 id are unioned transitively, ids deduped
keep-first, canonical label/summary taken from the largest contributing
cluster. Clusters that cover the same story but share zero ids (e.g. a story
covered only by sources split across two different spines) can't be caught
this way — those are flagged as `possible unmerged duplicates` via a
title-similarity heuristic (Jaccard over normalized word sets) and logged for
inspection, not auto-merged.

`config/models.yaml`'s `triage.clustering` changed from `{rounds}` to `{seed,
spines, max_concurrent_spines}`. `seed` and each spine's `groups` are matched
against `preprocessed_items.group` (unchanged structural axis — see the
entries below). Any group claimed by neither `seed` nor a configured spine is
swept into an implicit fallback `rest` spine at runtime, so nothing is
silently excluded.

The contract with everything downstream is unchanged: `triage_runs.digest`
holds the merged list in the same flat `label;;summary;;ids` format,
`cluster_index` is the position in that list (item-count descending, "biggest
story first" — the same convention the system prompt already asks the model
to follow), and `parseFlatClusterOutput`/the editor/assemble-pile required no
changes. `round_digests` (migration 014) now stores the seed's raw output,
each spine's raw output (`spine:<name>`), and the final merged list
(`merged`), so a run remains inspectable stage by stage.

Validation is unchanged in kind: ids are checked against the full news-item
id set for the run, with fabricated/duplicate/sub-2-id handling exactly as
before — applied per spine output before the merge, so the merge only ever
combines already-validated clusters and is guaranteed to produce disjoint,
>= 2-id, fabrication-free results. The lost-id check is adapted to the new
shape: any id clustered by the seed but absent from *every* spine's output is
gone from the final digest (no further round exists to give it another
chance, unlike the old chain) — logged loudly as `LOST ... absent from every
spine's output`.

**Deferred:** A semantic merge pass over the `possible unmerged duplicates`
list — clusters with no shared ids but highly similar titles — to fold them
together with editorial judgment the deterministic merge can't apply. Not
built; the title-similarity heuristic only logs candidates for inspection.
Add this only if the flagged list shows real, recurring same-story splits
across spines.

**Supersedes:** The "ordered group-based rounds" portion of the entry
immediately below (which itself superseded the original two-round
`wire`/`rest` chain).

---

## 2026-06-07 — Triage clusterer: two-round split → group-based rounds

**Decision:** Replace the two-round `wire` / `rest` split with an ordered
sequence of thirteen rounds keyed on a new `preprocessed_items.group` field,
in spine-first order: `wire`, `national`, `intl_broad`, `accountability`,
`legal`, `intl_regional`, `local`, `labor`, `climate`, `tech`, `ai`,
`science`, then a final catch-all (`*`) `rest` round.

**Context:** The two-round split (below) failed in practice. Round 1 (133
wire items) completed in ~40s; round 2 (~1,234 remaining items, the entire
non-wire pile) timed out `qwen3.5:397b` at 903s and produced no digest —
confirmed twice. Diagnosis: `rest` wasn't a round, it was the whole pile
again. `source_type` couldn't provide finer-grained rounds either — 1,168 of
~1,174 non-wire items share `source_type: journalism`.

**Rationale:** Round 1 proved the model handles ~130 items cleanly, so the
fix is to keep every round's prompt in that working range. That requires an
axis finer than `source_type`. We added `group` — a new, optional field on
each source in `config/sources.yaml` (and `preprocessed_items.group`,
migration 015, set at preprocess time exactly like `track`: looked up by
`source_name`, inherited, nullable, no default). `group` is a **structural
clustering axis only** — it controls which round an item enters and nothing
else. It is NOT an editorial or topic tag: it never reaches the paper, the
editor, or the reader, and is orthogonal to both `type` (wire / journalism /
advocacy / newsletter) and `track` (news / analysis). The thirteen group
values map directly onto the organizational sections `config/sources.yaml`
already had in comments (wire, national news, accountability/investigative,
PNW/Oregon local, international broad vs. regional, technology, AI, climate,
labor, legal, science, plus a `national` default for genuinely ambiguous
sources).

Round order is spine-first by design: wire and national-prominence groups go
first so the major stories of the day already exist as clusters before the
regional/topical tail (local, labor, climate, tech, ai, science, ...)
accretes onto them or forms its own smaller clusters — rather than the tail
forming its own competing clusters that later have to be merged with the
spine's. `config/models.yaml`'s `triage.clustering.rounds` schema changed
from `{name, types}` (matched against `source_type`) to `{name, groups}`
(matched against `preprocessed_items.group`); the catch-all `"*"` semantics
are unchanged. The re-emit-full-list mechanism, loose-item carry-forward, and
lost-id detection from the prior decision are unchanged — this is purely
"more, smaller, better-ordered rounds," not a new clustering strategy.

New per-round logging makes the loose pool observable: `new=` (this round's
group items), `loose=` (carried-forward unclustered items), and
`total_prompt_items=` (the number to watch — if it climbs back toward
full-pile size in late rounds, the split isn't holding and items are piling
up as loose carry-forward instead of landing in clusters).

**Deferred:** A final cluster-only merge pass over just the emitted cluster
lines (no items) to catch residual same-story duplicates across rounds —
cheap and timeout-safe because it sees only ~60 lines of cluster summaries,
not items. Not built; add only if duplicates persist after this multi-round
split proves insufficient on its own.

**Supersedes:** The "start with exactly two rounds: `wire` and `rest`"
portion of the entry immediately below.

---

## 2026-06-07 — Triage clusterer: single-pass → multi-round incremental clustering

**Decision:** Replace the triage clusterer's single whole-pile LLM call with
an ordered sequence of rounds, each admitting a config-defined subset of
items by `preprocessed_items.source_type`. Each round shows the model the
complete cluster list built so far (the prior round's raw emitted text,
verbatim) plus a "new items" batch — this round's items, plus any item from
earlier rounds that hasn't landed in a cluster yet — and asks it to fold the
new batch in and **re-emit the complete updated cluster list** in the
existing flat `label;;summary;;ids` format. Adding a member, creating a
cluster, and merging two clusters all become the same operation: edit the
re-emitted list. No new instruction language or output schema was needed.

`config/models.yaml` gains `triage.clustering.rounds`: an ordered list of
`{name, types}`. `types` may name explicit `source_type` values or include
the catch-all `"*"`, which admits everything not yet claimed by an earlier
round. Round membership is purely config-driven — adding, removing, or
reordering rounds is a config edit, not a code change. We start with exactly
two rounds: `wire` (types: `[wire]`) and `rest` (types: `[*]`).

The contract with everything downstream is unchanged: `triage_runs.digest`
still holds the **final** round's raw text, in the same flat format.
`parseFlatClusterOutput`, `cluster_index` semantics, the editor, and
assemble-pile required no changes. A new nullable `round_digests JSONB`
column (migration 014) additionally stores every round's raw text — `[{name,
text}, ...]` — purely for round-by-round inspection (`npm run inspect --
triage --id <n> --rounds`); it plays no role in the pipeline.

Validation is extended, not replaced: ids are still checked against the full
news-item id set for the run (the union across all rounds — broader than any
single round's pile, exactly as the old whole-pile validation was), with
fabricated/duplicate/sub-2-id handling unchanged. The new failure mode this
staging introduces — a re-emission round silently dropping a previously-
clustered id or whole cluster — is caught explicitly: after each round we diff
its clustered-id set against the prior round's, log anything that disappeared
as **lost**, loudly, and feed those ids back into the next round's loose-item
pool so they get another chance rather than vanishing.

**Context:** Consistency checks on the old whole-pile call showed the model
losing track at full pile size — 86 to 223 duplicate cluster ids per run
(the same story split into multiple clusters) and missed merges of obvious
near-duplicates. The pile is too large for the model to hold in working
memory as a single reasoning pass.

**Rationale:** Staging never asks the model to reason over the whole pile at
once — each call sees a manageable slice plus a running summary it already
produced (and can therefore trust and edit, rather than re-derive from raw
items). Re-emit-the-complete-list is the simplest mechanism that unifies
"add," "create," and "merge" into one operation the model already knows how
to do (it's the same output shape as round one), so no prompt-engineering for
new operations was needed — only an instruction to treat the prior list as
editable rather than fixed. Keeping the digest format, validation contract,
and downstream consumers untouched means this is purely an internal staging
change to triage; nothing else in the pipeline needs to know clustering now
happens in rounds. We deliberately did not loosen the conservative merge
threshold in this pass — we're isolating whether staging alone fixes the
duplicate-cluster problem before changing what "same story" means.

**Known limitation:** With only two rounds and this source list, the second
round (`rest` — everything that isn't wire) is still large; staging reduces
the pile the model reasons over per call but doesn't eliminate big single
calls. Finer-grained round membership (e.g. splitting `journalism` further,
or admitting by volume rather than type) is deferred until the inspection
harness shows the two-round split isn't enough — we'd rather learn that from
real `lost-from-prior` and duplicate-id data than guess at a finer split now.

---

## 2026-06-07 — Editor stage: whole-pile single call, three tiers + cut, line-order ranking

**Decision:** The editor stage reads the assembled `editor_pile` (clusters +
in-pile singletons) and makes ONE whole-pile LLM call that produces a single
ranked, tiered list — not batched. Each pile item gets one of four
dispositions: `feature`, `standard`, `brief`, or `cut`. The model emits items
in ranked order, best first, as flat lines `tier;;ref;;reason` (`ref` is
`C{cluster_index}` or `S{preprocessed_item_id}`); software derives `rank` from
line position — the model never emits a rank number. Reconciliation is
defensive in the same spirit as pass-1: every pile item must appear exactly
once, with unknown refs dropped+logged, duplicate refs keeping the first
occurrence, invalid tiers fail-safed to `brief`, and — critically — pile items
missing from the model's output fail-safed to `brief` (appended at the bottom
of the rank order) rather than silently dropped, because an editor that drops
items truncates the paper. New tables `editor_runs` (one row per execution,
with per-tier counts) and `editor_stories` (one row per pile item, `rank`
NOT NULL, full lineage to cluster or singleton) record the result.

**Context:** Pass-1 batches hundreds of items through independent per-item
scoring calls — order and relative comparison don't matter there, so batching
and concurrency are free wins. The editor's job is the opposite: it has to
decide which story leads, which runs second, and how the rest fall away
relative to each other. That's an inherently relational judgment that requires
the whole pile in view at once. The pile is sized precisely so this fits in one
call (clusters pass through unconditionally; `singleton_pile_target` bounds the
rest), so there's no batching problem to solve, and splitting the call would
mean re-introducing the cross-batch consistency problems pass-1 exists to
avoid downstream of it.

**Rationale for four flat tiers over JSON:** Same reasoning as pass-1's flat
line format — flat text is cheaper to emit, harder for the model to malform
into invalid JSON under load, and trivially diffable in logs. Four
dispositions (three sizes the publisher already has cards for, plus an
explicit `cut`) map directly onto the paper's "variable register" principle
without inventing new vocabulary; `cut` makes "this doesn't make today's paper"
a first-class, auditable decision rather than an absence.

**Rationale for deriving rank in software:** Asking the model to emit both an
explicit rank number and a line order invites contradictions (what does rank 3
on the 7th line mean?) that would need their own reconciliation logic. Line
order *is* the ranking signal the model is naturally producing by writing the
list best-first — encoding it twice would be redundant and error-prone. This
mirrors how pass-1 lets the model emit only a score and lets software do the
sorting and slicing.

**Rationale for cluster/singleton presentation order:** Clusters (cross-source
coverage, the strongest prominence signal available) are presented first,
ordered by item count descending — cluster_index is parsed from the digest the
same line-counting way `assemble-pile.ts` and pass-1's `extractClusteredIds`
do, so it lines up with `editor_pile_items.cluster_index`. Singletons follow,
ordered by their pass-1 score descending. This gives the model a stable,
inspectable starting arrangement to re-rank from, the same spirit as triage's
source-count ordering — a mechanical proxy, not a judgment call left to chance.

---

## 2026-06-06 — News/analysis track split

**Decision:** Added a `track` field (`news` | `analysis`, default `news`) to
sources.yaml and a corresponding `track` column to `preprocessed_items`.
Longform analysis sources (The Atlantic, The New Yorker, Harper's Magazine,
The New York Review of Books, London Review of Books, Reason, Foreign Affairs,
The Marshall Project, Aeon, Noema, The Baffler, n+1, Jacobin, The Nation,
Naked Capitalism, Le Monde Diplomatique (English)) are marked `track:
analysis`. Everything else defaults to `news`.

The two "piles" are just two WHERE clauses against one table — no new tables,
stages, or plumbing. Analysis items are never consumed by any current stage:
the assembler, triage, and editor-pass-1 all filter to `track = 'news'`.
Analysis items pool in `preprocessed_items` unconsumed until a Longer Reads
selector is built.

**Why it's a source property, not a per-story judgment:** `track` is stable
for a given outlet — The Atlantic reliably publishes longform analysis, AP
reliably publishes news wire. This is fundamentally different from
story-level topic (whether a given piece is about climate, labor, etc.),
which varies within a source and is correctly assigned by the editor stage.
We explicitly rejected a per-story news/analysis classification in earlier
design: we have no budget for an extra LLM pass over every item, and the
source-level signal is sufficient to separate the two populations.

**Why derived at preprocess time:** `track` is looked up from the source
config at preprocess time and written onto the row, so it is immediately
queryable by all downstream stages without re-joining to the config file.
It is trivially re-derivable on re-run — no new information is consumed.

**Why not a new table or stage:** Adding a separate analysis table would
duplicate schema and require all downstream queries to union two tables.
A separate pipeline stage would be waste until there is a consumer. One
discriminator column on an existing table, filtered by WHERE clause, is
the right shape for a feature that is currently only one side of the query
useful.

---

## 2026-05-30 — Triage is neutral by design

**Decision:** The triage stage applies no editorial judgment, reader context, or research recommendations. It groups items into clusters and describes them neutrally. All judgment happens downstream.

**Context:** Triage is the first LLM stage and the only one that reads every item. The temptation is to have it rank, score, or flag items for investigation.

**Rationale:** Judgment requires context triage doesn't have: the reader's bio, the standing memo, yesterday's paper, the source policy. Asking triage to make editorial calls would produce premature filtering based on incomplete context. The editor stage, which has all of that context, is where those calls belong. Triage's only job is to make the pile navigable — a filing clerk, not an editor.

---

## 2026-05-30 — Clusters ordered by source count descending

**Decision:** The triage prompt instructs the LLM to order clusters by source count, descending. Most-covered story first.

**Context:** An alternative was to let the LLM use its own judgment about ordering, or to order chronologically.

**Rationale:** Source count is a mechanical, observable proxy for coverage volume. Ordering by it gives a consistent, inspectable signal without asking the LLM to exercise judgment about importance. The most-covered story reliably leads. If source-count ordering turns out to be a bad signal in practice, the prompt can be revised.

---

## 2026-05-30 — Continuity system deferred

**Decision:** Triage does not compare today's clusters to yesterday's. No continuity matching at this stage.

**Context:** The concept doc mentions continuity as a first-class feature: today's paper is aware of yesterday's.

**Rationale:** Continuity matching requires published papers to compare against, and the publisher doesn't exist yet. Implementing a continuity check now would mean writing against a hypothetical schema. The decision is documented so it gets added once the publisher exists and there's real data to match against.

---

## 2026-05-30 — LLM wrapper thin by design

**Decision:** `src/llm/index.ts` wraps the OpenAI SDK with only two additions: generation_logs insertion and a typed interface. No retry logic, no streaming, no middleware chain.

**Context:** Alternatives considered: LangChain-style middleware, a heavier abstraction with pluggable providers, retry with exponential backoff.

**Rationale:** The OpenAI SDK handles HTTP/SSE transport. The only project-specific requirements are logging every call to Postgres and providing a typed interface for stage code. Adding retry logic before there's real failure data would be speculative. The wrapper is intentionally thin so it's easy to read and easy to extend when specific needs emerge.

---

## 2026-05-30 — No retry logic in V1

**Decision:** callLLM() does not retry on failure. If the LLM call throws, the error is logged to generation_logs and rethrown immediately.

**Context:** Retry logic with exponential backoff is standard practice for API calls.

**Rationale:** The right retry policy depends on failure patterns we don't have yet. Transient rate limits need different treatment than timeout failures, which need different treatment than model errors. Adding generic retry now risks masking real failures or running up token costs during debugging. Add retry logic once there's real failure data to design from.

---

## 2026-05-30 — Triage document is flat chronological, not pre-grouped

**Decision:** The assembler produces a flat list of items sorted by
published_at ascending (nulls last). No section headers, no grouping by
source or topic.

**Context:** An earlier instinct was to group items by source or cluster
them by title similarity before feeding them to the triage LLM.

**Rationale:** LLM clustering is smarter than mechanical clustering. The
triage model has a large context window and can recognize cross-source
coverage, semantic clusters, and story threads on its own — with better
precision than Jaccard similarity on titles. Pre-grouping would bias the
LLM toward the preprocessor's grouping decisions and obscure the raw
signal. Flat chronological order preserves all signal and puts the
analytical work where it belongs: in the LLM call that was designed for it.

---

## 2026-05-30 — Deduplication is canonical-URL-within-source, not cross-source

**Decision:** The preprocessor deduplicates on `(canonical_url, source_name)`.
Two items with the same canonical URL from different sources are both kept.

**Context:** A simpler approach would deduplicate globally on canonical URL,
keeping only one item per URL regardless of source.

**Rationale:** Cross-source coverage of the same URL is signal, not noise.
If AP, Reuters, and NPR all link to the same Washington Post story, that
pickup count is meaningful prominence signal for the triage stage. Dropping
the duplicates would discard that information. Deduplication within a single
source is still correct: one source shouldn't contribute two rows for the
same story just because it appeared twice in the feed.

---

## 2026-05-30 — Recency window is 48 hours, not 24

**Decision:** The preprocessor includes raw_items where published_at or
fetched_at is within the past 48 hours.

**Context:** A 24-hour window matches the paper's daily cadence but risks
dropping items that should appear in today's paper.

**Rationale:** Some feeds lag — an item published at 11pm may not be fetched
until the next day's run. A newsletter might summarize a story from yesterday
that's still worth including. 48 hours provides a buffer without meaningfully
increasing noise, because the recency filter is followed by triage, which
filters by relevance, not just recency. True duplicates from across the window
are handled by URL deduplication.

---

## 2026-05-30 — html-to-text for HTML stripping

**Decision:** Use the `html-to-text` npm package to convert feed body content
from HTML to clean plain text.

**Context:** Alternatives considered: `cheerio` (full DOM parser, then
text extraction); stripping tags with a regex; rolling a simple tag-stripper.

**Rationale:** `html-to-text` handles document structure correctly — it
turns `<p>` and `<br>` into newlines, `<li>` into list items, converts
`<a>` to link text (href discarded), and ignores `<img>`, `<figure>`,
`<script>`, and `<style>`. A regex strip would produce collapsed text with
no whitespace between paragraphs, making it harder to read and harder to
truncate meaningfully. Cheerio would work but requires two steps (parse +
extract) for the same result. `html-to-text` is the right tool for the job.

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
