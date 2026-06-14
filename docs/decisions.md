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

## 2026-06-14 — Recency window keyed off previous run; cross-run dedup added

**Decision:** Two preprocessor changes. (1) Replace the fixed
`NOW() - 48 hours` recency window with one keyed off the previous successful
preprocessor run: an item is in-window when its `fetched_at` is at or after
that run's `started_at`. First run / empty history falls back to a fixed
`fallback_hours` window. An optional `max_age_days` backstop on `published_at`
guards against a feed dumping its archive. (2) Add a persistent cross-run dedup
pass: before the in-run dedup, candidates matching a recently-processed
`preprocessed_items` row (same canonical URL, or same normalized title ≥30
chars, within source/parent, over a `lookback_days` window) are dropped. All
three knobs live in the new `preprocessor` block in `config/models.yaml`.

**Context:** On a once-a-day cadence the 48h window made every item eligible on
two consecutive runs, so yesterday's stories bled into today's pile. Separately,
when a source republishes a story under a changed URL/guid, the collector's
`(source_name, item_guid)` constraint and the preprocessor's *in-run-only*
dedup maps both miss it, so it reappears as a "new" row in a later run.

**Rationale:** Keying eligibility off the previous run gives each newly-seen
item exactly one window — no overlap, no boundary jitter — while still letting a
lagging feed's late-surfaced (old-dated) story through once, because we key on
`fetched_at` ("first time we saw it") rather than `published_at`. A fixed 24h
window was rejected: it still bleeds/gaps under run-time drift and a
publish-date variant would drop lagging stories. Cross-run dedup is deterministic
and reuses the existing canonical-URL / normalized-title keys; genuinely
reworded-headline duplicates are deliberately left to the downstream grouping +
pile-merge semantic layer rather than guessed at here.

---

## 2026-06-14 — Triage clusterer removed; grouping is the sole clustering path

**Decision:** Remove the LLM-based `triage` clusterer (wire seed + parallel
spines + deterministic id-union merge + semantic merge/attach) entirely and make
the embedding-based `grouping` stage the only clustering path. Deleted
`src/pipeline/triage/`, the triage-path scorer/pile functions in
`editor-pass-1/` (`runEditorPass1`, `assemblePile`), the `triage`/`assemble`/
`editor-pass-1` scripts and npm entries, the `triage` config block, the
`inspect -- triage` and `inspect -- editor-pass-1` subcommands, and the triage
branches in `editor` and `pile-merge`. Shared code that grouping reused moved to
neutral homes: `parseFlatClusterOutput` + the `Cluster` type to
`src/lib/cluster.ts`; `getTriageItems`/`formatTriageItemBlocks` renamed to
`getClusteringItems`/`formatItemBlocks` in the preprocessor assembler. Migration
`024_drop_triage.sql` drops `triage_runs`, `editor_pass_1_runs`,
`editor_pass_1_results`, and the now-unused `editor_piles.triage_run_id` /
`editor_piles.editor_pass_1_run_id` / `editor_runs.triage_run_id` columns.

**Context:** The two clustering paths had run in parallel for comparison (see the
2026-06-07/08 triage entries and the grouping entries below). Grouping —
embeddings + connected components + an LLM attach pass + a describe pass — proved
out as the production choice: simpler, cheaper, no whole-pile-timeout failure
mode, and no spine-tuning upkeep. Keeping triage alive meant maintaining two
clusterers, a dead config block, and dual-path branches in every downstream
stage.

**Rationale:** One clustering path is less to maintain and reason about. The
downstream stages (`editor`, `pile-merge`) were already path-agnostic, so
collapsing to grouping-only removed dead branches rather than adding complexity.
The triage history in this log is preserved for context; the drop migration
accepts loss of stored triage run rows, which were experimental and not part of
any published paper.

**Supersedes:** The triage-clusterer architecture entries (2026-06-07
"ordered group-rounds → wire seed + parallel spines + id-union merge",
2026-06-08 "semantic merge/attach pass added", 2026-06-10 "split international
spine into three region spines"). Those remain for historical context but no
longer describe live code.

---

## 2026-06-14 — Prefilter prompt tightened; explicit foreign-coverage floor

**Decision:** Refactor the prefilter system prompt (`buildSystemPrompt` in
`src/pipeline/prefilter/prompt.ts`) for concision — same three-way
cut/news/opinion contract, same non-article-junk cut, same output format, just
shorter and clearer prose. One substantive rule is added: substantive foreign
coverage is a KEEP regardless of geography or an obvious reader tie —
governance and politics, economic disruption, and science or health with real
substance all clear the floor.

**Context:** The folded-in prompt (see entry below) had grown long and
repetitive after absorbing the filter's junk list. Separately, the floor was
cutting foreign stories that lacked an obvious tie to this reader even when the
underlying news was substantial, because the keep bias leaned on
reader-proximity. The prefilter is a floor, not a ranking, so substance should
clear it even without a local hook; relative importance is the editor's job
downstream.

**Rationale:** Tightening the prompt lowers token cost per batch and reduces
the chance the model fixates on one over-explained clause. Making the
foreign-coverage rule explicit fixes a real false-cut pattern at the single
choke point that has the bio, rather than trying to recover wrongly-cut foreign
news later (there is no recovery path). Keeps the prefilter's existing
keep-when-unsure bias intact.

---

## 2026-06-13 — Filter stage folded into the prefilter; standalone filter removed

**Decision:** Remove the standalone LLM `filter` stage and have the
`prefilter` absorb its job. The prefilter's Step 1 ("KEEP OR CUT") prompt
gains a directive to also cut non-article material — event listings and
calendars, horoscopes, weather forecasts, photo galleries and video-only
posts, house ads and self-promotion, and link-dump roundups.
Everything else about the prefilter is unchanged. Deleted: `src/pipeline/filter/`,
`scripts/filter.ts`, the `filter` npm script, the `inspect -- filter`
subcommand, and the assembler's `getFilterKeptIds` gate. The `filter_runs` /
`filter_results` tables and migration `007` are retained as history — old runs
stay inspectable in the DB; no migration drops them.

**Context:** The mechanical filter ("is this a real news article?") ran before
the prefilter and dropped very little — its DROP list (calendars, horoscopes,
galleries, house ads, link dumps) is squarely a subset of "noise this reader
has no interest in," which the prefilter's broader LLM call already judges per
item. Two LLM passes over the full item set where one suffices. Both stages had
been working well, so the prefilter's behavior was changed as little as
possible. The deterministic `junk-filter.ts` in the preprocessor/assembler is
unrelated and stays.

**Rationale:** One bio-aware LLM gate is cheaper and simpler than a mechanical
gate plus a bio-aware gate doing overlapping work. The assembler already
composed both kept-sets by set intersection with graceful fallback when a run
is absent, so dropping the filter gate is a clean deletion — the prefilter gate
and junk filter still apply. Keeping the filter tables/migration honors the
append-only schema convention and preserves lineage for past paper runs.

**Supersedes:** the filter-stage portion of the 2026-06-07 prefilter entry,
which noted filter and prefilter "compose by intersection — exactly like the
LLM `filter` stage and the junk filter already do today." The LLM filter stage
no longer exists; only the prefilter and the deterministic junk filter remain.

---

## 2026-06-13 — Editor prompt redesign: static system prompt, bio in user message, standing memo dissolved

**Decision:** Rewrite the editor's prompt structure so that (1) the system
prompt is fully static — no runtime file reads, no bio — and carries only the
task spec and output contract; (2) the bio travels in the user message alongside
the pile; (3) `docs/standing-memo.md` is dissolved — its editorial judgment
principles move into a new `## How to weigh stories` section in `docs/bio.md`
and its task content is absorbed into the system prompt.

`buildSystemPrompt()` now takes no arguments. `buildUserPrompt()` and
`buildMergedUserPrompt()` prepend `"The reader:\n\n${bio}\n\n---\n\n"` before
the pile section. `docs/standing-memo.md` is deleted.

The five principles that moved into `docs/bio.md → ## How to weigh stories`:
- Power skepticism applied evenly, not just at one political pole.
- Attribution is a claim ("police say X"), not a fact.
- The people a decision lands on matter more than the people making it.
- Weight non-Western stories by consequence, not by American attention.
- Significance earns prominence, not drama; resist outrage-bait and horse-race framing.

**Context:** Earlier prompt structure put the bio and standing memo in the
system message and pile in the user message. Reasoning models treated the
system message as a persistent identity and narrated editorial theory before
producing output ("I will prioritize…", "Let me consider the reader's
interests…"), ignoring the `Begin immediately` instruction. Moving the bio to
the user message alongside the pile — the material being acted on — produced
clean, immediate `tier;;ref;;reason` output on the next run.

**Rationale:**
- **Static system prompt = stable model identity.** A prompt whose content
  changes daily (bio gets updated, standing memo gets revised) creates
  inconsistent model behavior. A prompt that says only "here is your task and
  output format" is stable by construction.
- **Bio belongs with the pile it governs.** The user message is "the reader +
  today's pile" — the full context for a single editorial decision. Keeping
  them together reflects what the call is actually doing.
- **Dissolving the standing memo eliminates a two-document maintenance surface.**
  The editorial voice principles don't need a separate file: they're reader
  preferences and belong with the reader. The task framing (tiers, ranking,
  output contract) belongs in the system prompt. There was no third category
  that needed its own document.
- **Additive for the scorer.** `editor-pass-1` and `grouping-pass-1` also read
  `docs/bio.md` for interest signals (high/low interest, geography, work). The
  new `## How to weigh stories` section is purely additive — the scorer uses
  bio for relevance scoring, not editorial craft, so extra principles cause no
  harm and may improve marginal scoring decisions.

---

## 2026-06-13 — Editor tier vocabulary simplified to three tiers (cut removed from prompt)

**Decision:** Remove `cut` from the editor's system prompt tier vocabulary.
The active tiers are now `feature`, `standard`, and `brief`. The parser
(`VALID_TIERS`) and DB schema (`items_cut`) retain `cut` as a recognized tier
for backwards compatibility, but the model is no longer instructed to use it.

**Context:** After the prompt redesign, the `brief` tier already serves as the
low end of the paper and the explicit `cut` tier introduced marginal ambiguity
("doesn't earn a place" vs. "worth noting, ~30-60 words") at the boundary
between brief and cut. The system prompt was rewritten with only three tiers
and the `cut` instruction removed.

**Rationale:** Fewer tiers = simpler decision surface at the margins. Every
item assigned `brief` appears somewhere in the paper (briefly), which is
arguably a better policy than silent omission. The `cut` value remains
parseable in case a future model emits it despite not being instructed to.

**Supersedes:** The `cut` tier description in "Editor stage: whole-pile single
call, three tiers + cut, line-order ranking" (2026-06-07).

---

## 2026-06-13 — Editor output parser made recognition-based to handle model format variation

**Decision:** Replace the positional `;;`-column parser in `parseEditorOutput`
with a recognition-based scanner that finds tier and ref by pattern, not by
column index. For each non-empty `;;`-containing line, the parser scans all
`;;`-delimited segments: the first segment whose lowercase content is one of
`{feature, standard, brief, cut}` is the tier; the first non-tier segment
containing a `[CS]\d+` ref pattern (after `normalizeRef`) is the ref; all
remaining segments join as the reason.

**Context:** Run #78 — kimi-k2.6:thinking returned lines in two variant
formats on the same output: `1. C3;;feature;;US-Iran war escalation` (numbered
prefix + swapped to `ref;;tier;;reason`) and `C3;;feature;;reason` (no tier
field at the correct position for positional parsing). The prior parser read
column 0 as tier, column 1 as ref — which meant `"1. C3"` was the tier
(invalid, fail-safed), `"feature"` was the ref (no C/S pattern, dropped), and
every item in the run was lost. This produced 0/145 valid lines — a complete
parse collapse, worse than the all-standard collapse from run #74.

**Rationale:**
- **The model's tier keywords and ref patterns are unambiguous.** `feature`,
  `standard`, `brief`, `cut` don't appear in titles or reasons as standalone
  `;;`-delimited segments. `C\d+`/`S\d+` patterns are structurally distinct
  from both tier words and reason text. Recognition over these two signals is
  robust to any column permutation.
- **Backwards-compatible with clean output.** On well-formed `tier;;ref;;reason`
  lines, the recognition scan finds tier in segment 0 and ref in segment 1 —
  identical outcome to the positional parser. No behavioral change for
  well-behaved model output.
- **`badTierCount` retired.** The positional parser incremented this counter
  when column 0 wasn't a tier keyword; since the recognition parser searches
  all segments for the tier, a line with no valid tier keyword simply produces
  no match and is skipped silently. The counter no longer has meaning and was
  zeroed.

---

## 2026-06-13 — Editor timeout raised to 900s; reasoning_effort kept at medium

**Decision:** Raise `editor.timeout_ms` from 600000 to 900000. Keep
`editor.reasoning_effort` at `"medium"`.

**Context:** Run #76 was killed at exactly 603s — 3s past the 600s limit —
having produced no output. First attempted fix: change `reasoning_effort` from
`"medium"` to `"low"` to reduce thinking time. Result (run #77): kimi at
`"low"` effort stopped emitting `tier;;ref;;reason` lines entirely and instead
dumped raw reasoning text ("Top tier candidates:", "Let's verify total…"),
producing 0/145 valid parsed lines — a worse outcome than the timeout. Reverted
`reasoning_effort` to `"medium"`; raised `timeout_ms` to 900000.

**Rationale:** At `"medium"` effort, kimi-k2.6:thinking produces well-formed
output and correctly ranks 145-item piles. At `"low"` effort, it appears to
skip the formatting step and emit thinking scratchpad text directly — the model
doesn't apply the output contract at low effort. Extending the timeout to 900s
is the correct fix: the 603s run was close to finishing, and 15 more minutes of
headroom covers the realistic tail without changing model behavior.

---

## 2026-06-13 — New stage: pile-merge (same-story dedup before the editor)

**Decision:** Add an optional `pile-merge` stage between pile assembly
(editor-pass-1 / grouping-pass-1) and the editor. The stage presents the
assembled pile to a reasoning model and asks it to identify item groups that
cover the same specific event, then merges each flagged group into one entry:
the primary item is kept (cluster over singleton, then highest source count,
then lex ref for determinism), secondary source IDs are absorbed, and a merged
singleton's excerpt is promoted to the summary field.

Schema: `pile_merge_runs` table (migration 023) with `editor_pile_id`,
`model_used`, `items_in`, `items_out`, `groups_merged`, `merged_pile JSONB`,
and `generation_log_id`. `editor_piles` gains a nullable `pile_merge_run_id`
FK. The editor checks this column first: when set, it reads `merged_pile` JSONB
directly from `pile_merge_runs` and skips digest resolution.

Model: `moonshotai/kimi-k2.6:thinking`, nanogpt, `reasoning_effort: "medium"`,
`stream: true`, `timeout_ms: 600000`. Output format: `MERGE: C0, S12345` lines
(or `NONE` if no merges needed). Parser uses `extractRefs()` from
`src/lib/refs.ts` to tolerate trailing punctuation and brackets.

**Context:** After editor-pass-1 / grouping-pass-1 assemble the pile, it
occasionally contains multiple entries covering the same specific event — e.g.
two clusters formed from disjoint source sets, or a cluster and a singleton
that both cover the same ruling or announcement. These show up in the editor
pile as separate items and, if both are tiered `feature`, produce redundant
entries in the day's paper. Triage's semantic-merge pass already catches most of
these during clustering, but some slip through — especially cross-path
divergence (triage and grouping can form different cluster boundaries) and items
that scored highly as singletons.

**Rationale:**
- **Same-specific-event threshold, not topic similarity.** The prompt's
  definition is identical to triage's clustering standard: merge only when two
  items describe the same event (same vote, same ruling, same strike), not
  merely the same running story or the same cast of actors. Conservative bias:
  when in doubt, keep separate. A missed merge is a minor duplication; a
  wrongful merge collapses distinct stories into one and loses information.
- **Optional, not required.** The stage is a clean step on the pile's FK:
  `pile_merge_run_id IS NULL` means the editor uses the standard digest path,
  `IS NOT NULL` means it uses the merged pile. No flag in the editor; no
  required ordering. It can be run or skipped on any given day.
- **JSONB for the merged pile.** The merged pile is a structured list written
  with `JSON.stringify(mergedPile)` and an explicit `::jsonb` cast (per the
  existing pg-library JSONB quirk in CLAUDE.md). The editor reads it with a
  typed cast back to `MergedPileEntry[]`.
- **Merged singletons promoted to cluster type.** When a singleton is absorbed
  into a cluster (or two singletons are merged together), the surviving entry
  becomes `itemType: "cluster"` with the singleton's excerpt promoted to the
  summary field, so the editor's merged-pile formatter presents it the same way
  as a cluster (title + summary, source count), not as a bare excerpt.

---

## 2026-06-13 — Shared ref normalizer: src/lib/refs.ts

**Decision:** Add `src/lib/refs.ts` with two exported functions:

- `normalizeRef(token: string): string | null` — extracts the first `[CS]\d+`
  pattern from a token and returns it upper-cased (`"[C3]"` → `"C3"`,
  `"S17566."` → `"S17566"`, `"cut"` → `null`).
- `extractRefs(text: string): string[]` — returns all `[CS]\d+` matches in a
  string, upper-cased (`"S17544, S17566."` → `["S17544", "S17566"]`).

Both functions are used to route LLM-returned ref tokens to pile Map lookups
without trusting the raw string. `parseEditorOutput` uses `normalizeRef` on
each ref segment; `parseMergeOutput` uses `extractRefs` on each `MERGE:` line.

**Context:** Two separate ref-brittleness bugs surfaced in the same session:

1. **Editor run #74 — all 150 items fail-safed to standard** (unknown-refs=78,
   missing=150). Cause: the prompt labels items as `[C3]` (bracketed) but the
   parser did `byRef.get(rawRef)` with the bracket-containing string, which
   matched nothing in the bare-key Map. Result: every `byRef.get` call missed →
   every item was "unknown ref" → every item was fail-safed.

2. **Pile-merge parser dropped valid group** because the model wrote
   `MERGE: S17544, S17566.` (trailing period). The parser split on `,` and
   trimmed, leaving `"S17566."` which had no exact match in `validRefs`.

**Rationale:** Both bugs are the same brittleness: trusting the raw LLM token
as the Map key. The fix extracts the canonical `[CS]\d+` pattern rather than
cleaning ad-hoc, so any future variation (spacing, case, punctuation) is
normalized at the lookup site. `src/lib/` is the established home for shared
utilities per CLAUDE.md; the two functions are general enough that either could
be re-used by a future parser that handles C/S refs.

---

## 2026-06-12 — Grouping clusterer: validated threshold 0.72, attach pass design, operational lessons

**Decision:** Commit the grouping clusterer's production configuration as validated on
preprocessor run #15 / grouping run #7:

- `embedding.similarity_threshold: 0.72` (was 0.82 on the branch; see lessons below)
- `attach.attach_floor: 0.60` (unchanged; intentionally low — see Bias section)
- `refine.enabled: false` (unchanged)

**Architecture (final):** embed (Qwen3-Embedding-8B, 4096d, OpenRouter, pgvector)
→ connected-components grouping at cosine ≥ 0.72
→ attach pass: per-cluster glm-5.1 LLM call over singletons in the [0.60, 0.72) near-miss
  band, attach-only
→ describe pass: glm-5.1 neutral title + summary for every multi-item cluster.

No refine pass (code kept, flag stays false). Runs in parallel with the existing triage
(seed + spines + semantic-merge) path for comparison; both terminate at the same editor.

**Context: why 0.72**

0.72 forms confident same-event clusters with no observed false merges. Below ~0.69,
distinct-story chains begin to form (items that share a topic and a cast of actors but
cover different events get connected transitively through a sequence of above-threshold
pairs). 0.72 sits cleanly above that chain-formation floor.

The embedding layer cannot separate same-event-different-framing pairs from
distinct-event-same-topic pairs by threshold alone. Measured on run #7: same-event pairs
ranged 0.59–0.89 (wide spread, reflecting how differently outlets frame identical facts);
distinct-event pairs reached 0.71 (a UN statement on the Iran war scored 0.71 against the
missile-exchange cluster — same cast, same week, different event). A threshold high enough
to exclude all 0.71 distinct-event pairs would also exclude many genuine same-event pairs
in the 0.59–0.71 range.

The attach pass is what recovers those stranded same-event items. On run #7 the Iran war
cluster formed from 8 sources at the 0.72 threshold; the attach pass brought it to 22
by absorbing near-misses the threshold correctly excluded from the connected-components
graph (UN condemnation, fuel-price dispatch, War Powers congressional response — all the
same specific event, all scoring in the [0.60, 0.72) band against the core cluster).

**Bias: prefer over-attaching over under-attaching**

`attach_floor: 0.60` is intentionally low. The failure asymmetry for the attach pass:

- An incorrectly-attached source (present in the cluster but covering a related-but-not-
  identical event) is harmless: the editor and reader can ignore a slightly-wrong source
  in a 22-item cluster.
- A missed same-event source (left as a singleton because the floor was too high) is lost:
  it scores against the backdrop of today's full pile, may never reach the editor pile
  at all, and never joins the cluster it belongs in.

Do not raise the floor to reduce false attachments. The cost of false attachments is low;
the cost of misses is high. If over-attaching becomes a real problem, the correct fix is
tightening the LLM prompt's "same specific event" definition, not raising the floor.

**Operational lessons**

**(A) Cluster SIZE is not an over-merge signal.** A 66-item cluster is not evidence of a
wrongful merge — a global war with 66 sources covering it is the correct output. Judge
merge quality by reading the cluster CONTENTS (are these all the same specific event?),
never by item count. Applying a size-based heuristic will produce false positives on every
genuinely large story and cause the operator to re-tune away from correct behavior.

**(B) `similarity_threshold` is the highest-leverage knob in the pipeline.** An unintended
value of 0.82 (left over from an earlier tuning run) caused every same-event pair with
cosine similarity 0.72–0.81 to be split into separate singletons. The full run produced
~1226 singletons and ~16 clusters — a result that looked exactly like a broken clusterer
but was a single misconfigured YAML value. When the grouping output looks wrong (pile
dominated by singletons, few multi-item clusters), check this value first.

---

## 2026-06-10 — Model bake-off picks: triage clusterer and editor_pass_1 scorer

**Decision:** Two model selections from bake-offs run on identical pipeline input:

- **Triage clusterer:** `alibaba/qwen3.6-27b:thinking` (`provider: nanogpt`, replacing
  `qwen3.5:397b`). Used for both the seed/spine calls and the semantic_merge pass
  (pinned together in the `--model` override path; they must match).

- **editor_pass_1 scorer:** `zai-org/glm-5.1:thinking` (`provider: nanogpt`, replacing
  plain `zai-org/glm-5.1`).

**Context:**

*Clusterer bake-off:* qwen3.6-27b:thinking was stable across runs, consolidated the
regression item pairs reliably, and handled the region-split international spines
cleanly. (The spine split itself is logged in the entry immediately below; this entry
records only the model selection.)

*Scorer bake-off:* Three candidates — `moonshotai/kimi-k2.6:thinking` (the editor's
whole-pile winner), plain `zai-org/glm-5.1`, and `zai-org/glm-5.1:thinking`. kimi is
a poor scorer for pass-1 despite being the best editor: pass-1 is high-volume per-item
batch work, and kimi silently defaults un-engaged items to a flat score of 50 in that
regime — confirmed in the bake-off on bio-relevant items that should have scored 80+.
Plain glm-5.1 showed a milder version of the same flat-score behavior. glm-5.1:thinking
engages per-item and avoids it.

**Rationale:** The flat-50 failure mode is specifically a batch-scoring regime problem:
a model that reasons well over a single whole pile (the editor's task) can still
disengage when asked to score hundreds of individual items in parallel batches (pass-1's
task). The `:thinking` variant of glm-5.1 applies per-item reasoning that prevents the
disengagement without the latency hit of a model sized for whole-pile relational work.

**Operational note:** A high count of exactly-50 scores in an editor_pass_1 run is a
smell — model not engaging items, possibly batch_size too large — not a neutral middle.
Worth checking when it appears; the fix is smaller batches, never a second pass.

---

## 2026-06-10 — Triage: split international spine into three region spines

**Decision:** Replace the single `international` triage spine (groups `[intl_broad,
intl_regional]`, ~528 items) with three narrower region spines: `intl_broad`
(`[intl_broad]`), `intl_asia` (`[intl_asia]`), and `intl_americas`
(`[intl_americas]`). Sources previously carrying `group: intl_regional` are
retagged to the appropriate region group in `config/sources.yaml`; the spine
map in `config/models.yaml` is updated to match; `max_concurrent_spines` raised
from 3 to 10. `intl_regional` is retired and removed from the group schema
comment.

**Context:** The international spine was producing two symptoms from one cause:

- **Transcribing instead of clustering.** ~480 of ~528 items fell as singletons
  — the model was re-emitting items individually rather than grouping them.
  Output ballooned to ~16k tokens; healthy clustering calls are far smaller than
  their input.
- **Timeout risk.** 400–600s per spine run, the same wall that prompted the
  ordered-rounds → seed + parallel spines redesign (see 2026-06-07 entry).

Both symptoms have one cause: the bucket was past the output-token runaway
threshold. A model clustering N items produces O(clusters) output tokens if it
is actually clustering. Past some bucket-size ceiling it flips to transcribing
— producing O(N) output tokens, one trivial single-item "cluster" per item. The
~528-item international bucket had crossed that threshold; the spike in
singletons and the spike in output tokens appeared together, confirming the
diagnosis.

**Rationale:**

- **Spine size is bounded by output-token behavior, not input item count.**
  The transcription flip is the operative signal: output proportional to input
  means the model isn't clustering. Input item count matters only insofar as it
  drives the model past the flip point. Splitting the bucket into three
  thematically narrower region spines brings each one back into the clustering
  regime. Result on preprocessor run #12: singletons 1 / 40 / 0 across the three
  spines, output tokens in the hundreds-to-low-thousands per spine, slowest spine
  ~110–130s.

- **Regional coherence is a secondary benefit.** Keeping all international items
  in one bucket asks the model to hold Middle East, Africa, Europe, Asia, and
  Latin America simultaneously — a pile where intra-region same-event pairs are
  diluted by unrelated cross-region noise. Narrower buckets give the model a
  smaller, more coherent slice to reason over, making the genuine same-event
  pairs easier to find.

- **max_concurrent_spines raised to 10.** Six spines vs. four; a cap of 3 would
  serialise the run. Raising to 10 effectively uncaps concurrency at the current
  spine count and keeps the parallel structure intact.

**Supersedes:** The `international` spine entry in "Triage clusterer: ordered
group-rounds → wire seed + parallel spines + id-union merge" (2026-06-07).

---

## 2026-06-09 — Editor model: kimi-k2.6:thinking primary, glm-5.1:thinking fallback, retry-once-then-fallback resilience

**Decision:** The editor stage's production model is `moonshotai/kimi-k2.6:thinking`
on NanoGPT (`provider: nanogpt`, `reasoning_effort: "medium"`). A fallback model
`zai-org/glm-5.1:thinking` (also NanoGPT, `reasoning_effort: "medium"`) is
configured in a new optional `editor.fallback` block in `config/models.yaml`.
`StageConfigSchema` is not touched; a new `EditorStageConfigSchema` extends it
with the optional fallback sub-config — editor-specific only, not generalized to
all stages.

Resilience logic lives in `src/pipeline/editor/index.ts` (not in `callLLM`):
attempt the primary model → retry the primary once on failure → invoke the fallback
once. A failure is: `callLLM` throws (timeout, stream break, empty response) OR the
parse collapses (fewer than 50% of pile items produce valid output lines). A paper
that parses with fail-safed missing items but ≥ 50% lines is a success — do not
fall back on a merely-imperfect-but-parsed paper. If the fallback also fails, the
run throws loudly; no silent all-fail-safe paper is produced and presented as a
success. Each transition is logged explicitly (primary attempt 1, retry, fallback
invocation). The `model_used` column of `editor_runs` is updated to the fallback
model's ID if the fallback produced the accepted output, so inspection logs show
whether any given day's paper came from kimi or glm.

**Context:** A bake-off over multiple runs on identical input evaluated several
NanoGPT reasoning models. `kimi-k2.6:thinking` ranked best overall and was the
most stable across runs (consistent tier assignments, minimal collapse, clean line
format). `glm-5.1:thinking` produced clean papers and failed predictably on
difficult inputs — no silent garbage, just clean errors — making it the safest
fallback choice. Primary model failures have been intermittent, not deterministic,
so a single clean retry is cheap and often sufficient before reaching for the
fallback.

**Rationale:**
- **Retry-once-then-fallback, not retry-forever.** The bake-off showed that primary
  failures are transient (network hiccup, stream break), not systematic. One retry
  is cheap; more would mask real problems. Reaching the fallback is a signal the
  operator should notice (via `model_used` in `editor_runs`), not suppress.
- **Collapse threshold at 50% of pile items.** A collapse is operationally
  distinguishable from a merely-imperfect paper: a reasoning model that is working
  produces output for most items even if the tier assignments are imperfect; a
  collapsed call produces almost nothing. 50% is a clear, generous threshold — far
  below any normal run's output — that avoids false positives on legitimate papers
  while reliably catching empty-or-near-empty responses.
- **model_used reflects the real producer.** The `editor_runs` row is created with
  the primary model as `model_used` and updated on fallback use. This makes fallback
  frequency observable over time in the DB without any separate tracking column.
- **Fallback is editor-specific, not generalized.** Other stages have different
  failure modes and different costs; adding fallback to all stages without failure
  data to design from would be speculative. The `EditorStageConfigSchema` extension
  keeps the change local to the editor.

---

## 2026-06-09 — Editor LLM call switched to streaming to bypass undici headers timeout

**Decision:** The editor stage's `callLLM` call now uses `stream: true`. The
OpenAI SDK's streaming path accumulates all `delta.content` chunks into one
string and passes that to the existing `parseEditorOutput` parser, which is
completely unchanged. `stream` is a per-stage boolean in `models.yaml`
(`StageConfigSchema`); other stages continue to use non-streaming. The editor
config is also set to `timeout_ms: 600000` as a generous body/stream timeout.

**Context:** Non-streaming reasoning calls against NanoGPT (and any other
provider) were dying at exactly ~300 seconds — regardless of model, regardless
of the provider's own timeout — with `UND_ERR_HEADERS_TIMEOUT`. The root cause
was diagnosed by sending a raw fetch to a deliberately-slow LOCAL server inside
the app container: the connection died at 300.893s with the same
`UND_ERR_HEADERS_TIMEOUT`. This is Node's undici HTTP client enforcing its
default `headersTimeout` of ~300s. A non-streaming LLM call does not send HTTP
response headers until the model finishes generating — so any model that thinks
for more than ~300s before producing output is killed by our own HTTP client,
not by the provider. A streaming version of the identical deepseek call received
headers at 2.8s and completed successfully at 248s.

**Rationale:** Streaming sidesteps the headers-timeout problem at its root: the
provider sends HTTP response headers (and the first SSE chunk) within seconds of
receiving the request, keeping the connection alive while the model reasons. The
assembled string from accumulated chunks is byte-identical in structure to what
the non-streaming path produces (same lines, same format), so the parser and all
downstream logic are unaffected. Error handling mid-stream is explicit: if the
stream breaks partway, the call fails cleanly with a logged message that includes
stage, model, bytes received, and elapsed time — a broken stream is treated as a
failure, not a partial parse. `stream: true` is a flag in `LLMCallOptions` and
`StageConfigSchema` rather than hardcoded to the editor, so other stages can opt
in when they face the same constraint.

---

## 2026-06-08 — NanoGPT added as alternate LLM provider

**Decision:** Added `nanogpt` as a second selectable provider alongside the
existing `ollama-cloud` default. Provider is now a per-stage config field
(`provider: ollama-cloud | nanogpt`) in `config/models.yaml`. When set to
`nanogpt`, `callLLM` uses `NANOGPT_BASE_URL` + `NANOGPT_API_KEY` instead of
`LLM_BASE_URL` + `LLM_API_KEY`. The editor stage is the first to expose this
— override with `provider: nanogpt`, `model: deepseek/deepseek-v4-pro:thinking`,
`reasoning_effort: "high"` to run it through NanoGPT. All other stages continue
to use ollama-cloud by default (no change to any other stage's config or code).

A `timeout_ms` per-stage config field was added at the same time, so stages
that need a longer or shorter deadline can set it explicitly. The default
remains 360s for all providers.

**Context:** Ollama Cloud imposes a 182s hard gateway timeout per request.
Reasoning models — particularly `deepseek/deepseek-v4-pro:thinking` on a
whole-pile editor call — routinely exceed this ceiling. The editor's
whole-pile call is intentionally a single large call (see "Editor stage:
whole-pile single call" entry); it cannot be batched or shortened without
losing the relational ranking judgment that is the editor's entire purpose.
NanoGPT is OpenAI-compatible and has no equivalent per-request cap, making
it a viable host for long-running reasoning calls.

**Rationale:**
- **Provider as config, not code.** Any stage can target either provider with
  a one-line yaml change and the right env vars present — no stage-specific
  code branches, no hardcoded URLs. The LLM client selects credentials and
  constructs the OpenAI client based on the `provider` field, the same way
  it already selects model, temperature, and token budget from config.
- **NanoGPT's reasoning parameter matches the existing code path.** NanoGPT
  uses `reasoning_effort` (values: `none`/`minimal`/`low`/`medium`/`high`/
  `xhigh`) passed directly in the request body — exactly the same double-cast
  approach the client already uses for Ollama Cloud. No new parameter wiring
  was needed.
- **Committed default unchanged.** The editor's committed config stays
  `provider: ollama-cloud` (implicit default), `model: qwen3.5:397b`,
  `reasoning_effort: "none"`. The NanoGPT setting is applied as a runtime
  override; no production run is affected until the operator explicitly changes
  the config or passes an override.

---

## 2026-06-08 — Triage clusterer: semantic merge/attach pass added as final clustering step

**Decision:** Add one more LLM call to the end of the clustering pipeline,
after the deterministic id-union merge produces its cluster list and before
the digest is finalized: a semantic merge/attach pass that (1) merges cluster
pairs that are the same specific EVENT but share no item ids, and (2) attaches
high-relevance orphaned singletons — especially cross-language items and
tangential angles of the same specific event — to a cluster they clearly
belong in. The threshold is strictly same-specific-event — identical to the
base clustering prompt's — with no broader "umbrella" or "running story"
grouping exception (see the **Update** below for why that exception was
removed before this pass shipped). Configured at
`triage.clustering.semantic_merge` (model, `max_tokens`, `reasoning_effort`,
`max_singletons`, `max_cluster_share`, and an `enabled` toggle); uses the same
`qwen3.5:397b` model as the rest of triage, `reasoning_effort: "none"`,
default `max_singletons: 60`, default `max_cluster_share: 0.30`.

The pass operates on a deliberately SMALL input — the merged cluster list
(already-formed `label;;summary;;ids` lines) plus a bounded slice of the
highest-relevance unclustered singletons (the top `max_singletons` residuals
by recency, since pass-1 scoring hasn't run yet at triage time and there's no
score to rank by) — never the whole pile. It re-emits the COMPLETE updated
cluster list in the same flat format, which is then run through the existing
`parseFlatClusterOutput` (same fabricated/duplicate/sub-2-id validation as
every other clustering call) and becomes the final `digest`. Editor,
assemble-pile, and pass-1 are completely unaffected — the contract
(`parseFlatClusterOutput`, `cluster_index` semantics, the flat line format)
is unchanged. The raw output is stored in `round_digests` under the key
`semantic_merge`, alongside `seed`, `spine:*`, and `merged`, so a run remains
inspectable stage by stage. An integrity check logs clusters before vs. after,
how many pre-pass clusters fused into each post-pass cluster ("merged"), how
many offered singletons made it into the final list ("attached"), and any
previously-clustered id that vanished from the output entirely (logged loudly
as LOST — it falls back to residual, exactly like the existing seed/spine LOST
handling, because this is now the final clustering step with no further chance
to recover it). A runaway guard rejects the pass's entire output — falling
back to the pre-pass id-union merge result — if any single cluster ends up
holding more than `max_cluster_share` (default 30%) of all clustered ids; see
the **Update** below for why this exists.

**Context:** Two recall failures at the edges of clustering kept showing up in
production, both invisible to the deterministic id-union merge because it can
only fuse clusters that share at least one seed item id:

- Same-story clusters covered by disjoint source sets, sharing no ids — e.g.
  two separate "Intel on the brink, AI revival" clusters surfaced as two
  separate features instead of one.
- High-relevance singletons that belonged in an existing cluster but stayed
  orphaned — especially cross-language items (a Portuguese "Iran attacks
  Israel" report) and tangential angles (a "War Powers Resolution on Iran"
  explainer) — both floated up as standalone features instead of joining the
  Iran-war cluster.

The id-union merge's `possibleDuplicates` heuristic (Jaccard title similarity)
already *flagged* the first case for inspection but explicitly couldn't
resolve it — that requires editorial judgment a string-similarity check can't
make. This pass is the resolution that heuristic was always meant to lead to;
see the "Deferred: A semantic merge pass…" note in the entry below, which this
entry fulfills.

**Rationale:**

- **One call, at the end, on a small input — not a redesign of clustering.**
  Earlier whole-pile clustering attempts timed out because every round's
  prompt carried the full item texts for hundreds of items plus an
  ever-reinflating carry-forward pool (see the entry below: "495 → 714 items
  by round 10"). This pass sidesteps that failure mode entirely by construction:
  its input is the already-formed cluster list (a few dozen short lines) plus
  at most `max_singletons` (default 60) item blocks — capped, not the ~500
  residual singletons a typical run produces. It is structurally incapable of
  re-creating the timeout problem, regardless of pile size, because its input
  size is bounded by config, not by the day's news volume.

- **Re-emit-the-complete-list, not a diff format.** The pass reuses the exact
  mechanic `buildIncrementalUserPrompt` already proved out for the spine
  rounds: show the model the current list verbatim in the format it must
  also output, plus new material, and ask for a complete re-emission. This
  means zero new output-format surface, zero new parsing code (the existing
  `parseFlatClusterOutput` — with its fabricated-id, duplicate-id, and
  sub-2-id validation — handles it unchanged), and the same robust
  loud-logging-on-loss behavior the seed/spine merge already has. A bespoke
  "merge cluster #3 into #7, attach singleton #4821 to #12" diff format would
  have required new parsing, new validation, and a new failure surface for no
  benefit — the re-emission mechanic was already battle-tested.

- **Recency as the singleton ranking signal, not a score.** Pass-1 — the
  stage that actually scores bio-relevance — runs *after* triage, so no score
  exists yet to rank residual singletons by at this point in the pipeline.
  Recency is the most meaningful signal directly available: a recently
  published orphan is the likeliest candidate to be a same-day angle on, or a
  cross-language report of, a running story — precisely the case this pass
  exists to catch. "Source-count" was considered and rejected as a ranking
  signal for *true singletons* — by definition, an item that didn't cluster
  has no sibling items to count sources across, so the signal would be
  degenerate (always 1) for exactly the population this pass is selecting from.

- **Strictly same-specific-event threshold — identical to the base
  clustering prompt's, no broader exception.** The prompt keeps the existing
  clustering rules' bias in full: merge or attach only on confidence that two
  things are the SAME SPECIFIC EVENT, and when unsure, don't — under-merging
  is recoverable, a wrongful merge destroys structure permanently. Breadth
  across a running story (gathering a conflict's strikes, legislative
  responses, and economic fallout into one place) is the writer's job, done
  later by searching the full pool — not the clusterer's, at any stage. See
  the **Update** below for why an "umbrella" exception was tried and removed
  before this pass ever shipped.

- **`max_cluster_share` runaway guard — defense in depth against an unstable
  prompt resolution.** Even with a strictly same-event threshold, an LLM pass
  making merge/attach judgments can occasionally over-merge in a way that
  produces a single oversized cluster — the unmistakable shape of an
  "umbrella"/"conflict blob" mistake (a tight same-event cluster should never
  hold a large share of a day's clustered ids). Rather than rely on the
  prompt alone to prevent this, the pass validates its own output's shape: if
  the largest cluster exceeds `max_cluster_share` (default 30%) of all
  clustered ids, the entire output is discarded — not trimmed or
  partially salvaged, since a blob's membership can't be un-mixed after the
  fact — and the pre-pass id-union merge result is used as the final digest
  instead. This is the same "validate the shape, fall back cleanly on failure"
  posture the pass already takes for unparseable output; a magnitude check is
  just as mechanical and just as safe to automate as a syntax check.

- **Cross-language matching named explicitly.** The base clustering system
  prompt already says items may be in any language, but the production miss
  (the Portuguese Iran item) showed that guidance alone wasn't enough to make
  the model attach across a language boundary at the edges. This pass's prompt
  calls it out directly: match on the underlying event, not the language or
  the wording.

- **Toggleable and isolated.** `semantic_merge.enabled: false` falls back
  cleanly to the id-union merge result with no other code path changes — the
  pass is purely additive at the end of the pipeline, so it can be disabled
  for cost/latency reasons, or if it proves to be a net-negative (over-merging),
  without touching the spine/seed clustering or the deterministic merge at all.

**Update (2026-06-08, before deploy):** The first version of this prompt
included an explicit "umbrella" exception — fold a major running story's later
developments, regional angles, and explainers into one cluster, framed as
"still the same story, just a big one." Across three test runs on identical
input, that exception produced two distinct modes: restrained/correct (4–7
singletons attached, the genuine Intel duplicate fused, the cross-language
Iran item attached — exactly the recall fixes this pass exists for) and
runaway (one run attached 45 singletons, producing a 183-item "South Korea
Ballot Shortage" mega-bucket and an Iran "conflict blob" that swallowed
missile-exchange coverage, fuel-shock reporting, inflation stories, and Trump's
messaging about the war as if they were one event).

The cause: the prompt simultaneously told the model "merge only the same
specific event" AND "but also gather a running story's breadth into one
bucket" — two instructions in tension, which the model resolved
unpredictably from run to run on identical input. The fix removes the
contradiction rather than tuning around it: the umbrella exception is gone
entirely, the threshold is now identical to the base clustering prompt's
(same specific event, full stop), and the rationale for *why* breadth doesn't
belong here is now explicit in the prompt itself — it's the writer's job,
done later via the full-pool search, not the clusterer's at any stage. A
`max_cluster_share` fallback guard (see Rationale above) was added as a second
line of defense — not a substitute for the prompt fix, but a backstop in case
a future prompt change (or this model's quirks) reintroduces a similar
instability, so a runaway result can never reach the digest even if the prompt
momentarily produces one.

---

## 2026-06-07 — New stage: bio-aware pre-cluster relevance filter (prefilter)

**Decision:** Add a `prefilter` stage between the preprocessor and the
clusterer (triage). It is batched, concurrency-capped at 3, bio-aware, and
mirrors editor-pass-1's structure closely (per-item batches, `p-limit`,
flat-line parsing, run+results tables, `glm-5.1`). For each `track = 'news'`
preprocessed item it makes a binary **keep/cut** verdict — not a score — and
the prompt is deliberately conservative: cut only what the bio makes clear
this reader has affirmatively no interest in (routine sports/box scores,
celebrity gossip, market-movement noise); when unsure, KEEP. A sports or
entertainment item with a substantive labor/political/legal/cultural angle is
explicitly a KEEP. Schema: `prefilter_runs` (per-execution counts) and
`prefilter_results` (`run_id`, `preprocessed_item_id`, `keep BOOLEAN`,
`reason TEXT`) — migration 016. The assembler (`getTriageItems`) applies a
completed prefilter run's kept-set exactly the way it already applies the LLM
filter run's kept-set (`getPrefilterKeptIds` mirrors `getFilterKeptIds`,
including the graceful "no run → include everything" fallback); the two
compose by simple set intersection, so order between them doesn't matter.
Nothing is deleted from `preprocessed_items` — cut items remain in the full
pool for a future writer stage that searches across all items; this stage
only records a verdict.

**Context:** The clusterer and editor were spending context budget on items
the reader has no interest in at all — routine box scores, tabloid items,
wire filler that isn't garbage (so the deterministic junk filter correctly
keeps it) but also isn't anything this specific reader would ever want. That
is a *relevance* judgment, not a *garbage* judgment, and it requires the bio.

**Rationale:**

- **Why a separate stage from the junk filter, not folded into it.**
  Garbage-vs-not (calendars, photo galleries, house ads — see
  `src/pipeline/preprocessor/junk-filter.ts`) and relevant-to-this-reader-vs-not
  are different judgments with different evidence. The junk filter is
  high-precision pattern matching that needs no bio and stays deterministic
  and fast; the prefilter needs the bio and an LLM call per item. Conflating
  them would force the deterministic filter's rules to start encoding
  reader-specific taste (fragile, unreviewable) or force every garbage call
  through an LLM (slow, costly, and a worse fit for "this regex always means
  press-release boilerplate"). They stay separate, parallel passes that
  compose by intersection — exactly like the LLM `filter` stage and the junk
  filter already do today.

- **Conservative keep-bias, not a percentile quota.** This is a *floor* that
  strips obvious noise, not a relevance ranking with a target size (that's
  editor-pass-1 and the editor's job, downstream, with full cluster context).
  A quota-based cut here would force borderline calls before the pile is even
  assembled, when the reader-relevance evidence is thinnest. Fail-safe
  direction is KEEP for the same reason editor-pass-1 fail-safes toward the
  middle of its range rather than toward zero: an over-inclusive floor costs
  the clusterer and editor a little context; a wrongly-cut story is gone and
  cannot be recovered by any later stage.

- **Retained-pool design.** Cut verdicts are recorded, never enacted as
  deletes. `preprocessed_items` keeps the full day's pool so a future writer
  stage — one that can search across everything collected, not just what made
  the paper — has the complete record to work from. This is purely a
  "don't pass this forward to clustering" signal, not a "this didn't happen"
  signal.

- **Built to become a scorer.** The output format —
  `id;;verdict;;reason` with `verdict` in the same column position as
  editor-pass-1's `score` — and the `prefilter_results` schema (an additive
  `score INT` column would let `keep` become a derived threshold) are chosen
  so that, once the keep/cut version is validated against real daily output,
  promoting it to an absolute-floor *scorer* is a prompt change plus one
  additive migration — not a rebuild. If that promotion happens, it can
  absorb editor-pass-1's bio-aware scoring entirely (collapsing the two
  passes into one earlier, cheaper one) — deferred until the binary version
  has run long enough to show whether a finer-grained floor is worth it.

---

## 2026-06-08 — Prefilter now classifies kept items as news vs opinion, routing opinion to Longer Reads

**Decision:** Extend the prefilter's per-item judgment from a binary
keep/cut verdict to a three-way verdict: `cut`, `news`, or `opinion`. The
output line shape is unchanged (`id;;verdict;;reason`, same delimiter, same
column position) — only the vocabulary in the middle column widens. `cut`
keeps its meaning; `news` and `opinion` both map to `keep = true` but split
on a new `kind` column. Items the prefilter keeps as `news` flow into
clustering exactly as `keep` did before; items it keeps as `opinion` are
excluded from clustering and pool for the Longer Reads section — the same
destination `track = 'analysis'` items already accumulate in. Schema:
additive migration 017 adds `kind TEXT NOT NULL DEFAULT 'news' CHECK (kind
IN ('news', 'opinion'))` to `prefilter_results`. Both consumers of the
prefilter's kept-set — the triage assembler's `getPrefilterKeptIds` (backing
`getTriageItems`) and editor-pass-1's `getPrefilterKeptIds` (backing its
residual-singleton query) — now additionally filter `AND kind = 'news'`, so
an item reaches the clusterer or gets scored only if it is `track = 'news'`
AND prefilter-kept AND `kind = 'news'`. No Longer Reads consumer is built
yet; opinion-kept items simply accumulate, unconsumed, alongside analysis
items until that stage exists.

**Context:** Opinion and commentary pieces — a blog post arguing "LLMs are
eroding my career," a column making the case for or against the Iran
war — were flowing into clustering alongside reporting. They don't cluster
(each is a one-off argument, not a recurring story other sources also
cover), they score high on bio-relevance (the topics are exactly what this
reader cares about), and so they surfaced as residual singletons that
floated up through editor-pass-1 and the editor as bogus "features" — a
single columnist's opinion presented with the weight of a major story. That
is a routing problem, not a quality problem: these pieces have real value,
just not as news-pile candidates.

**Rationale:**

- **Fix it upstream, at the prefilter, not in the clusterer or editor.**
  The clusterer and editor only ever see what the assembler hands them; by
  the time an opinion piece reaches either, the damage (a bogus feature
  slot, wasted context) is already done. The prefilter is the single choke
  point between the preprocessor and clustering where every `track = 'news'`
  item already gets one bio-aware LLM judgment — adding a second axis to
  that same judgment (rather than a new pass) is the cheapest place to catch
  this, and it composes naturally with the existing keep/cut floor: an item
  must first clear the relevance bar before its news-vs-opinion character
  even matters.

- **Same routing primitive as `track = 'analysis'`.** The pipeline already
  has a clean mechanism for "this is valuable to the reader but is not a
  news-pile candidate" — the `track` field set at preprocess time routes
  analysis pieces out of clustering into the (future) Longer Reads pool.
  Opinion pieces need exactly the same treatment, just decided later (the
  prefilter has the bio; the preprocessor's `track` assignment does not).
  Reusing the destination — rather than inventing a new pool or a new
  status — keeps "things that aren't news-pile candidates" a single concept
  with two on-ramps (structural at preprocess time, judgment-based at
  prefilter time).

- **Conservative news-default, mirroring the keep-bias.** When genuinely
  unsure between news and opinion, the prompt instructs NEWS. This mirrors
  the prefilter's existing keep-over-cut bias for the same reason: a
  wrongly-opinion-routed story never reaches the daily paper (it's gone, the
  same as a wrongly-cut one), while a wrongly-news-routed opinion piece is
  merely a minor miscategorization the clusterer and editor can absorb —
  recoverable, not fatal. The fail-safe direction for unparseable lines and
  unknown verdict tokens is therefore `keep = true, kind = 'news'`, the
  single safest combination of the three-way space.

- **One token, same line shape — no format churn.** Widening the verdict
  vocabulary from two values to three, in the same delimited column, keeps
  `parseBatchOutput`'s structure (split on first two `;;`, defensive
  reconciliation, fail-safe-by-id) untouched apart from the mapping itself.
  This preserves the parser's kinship with editor-pass-1's, and keeps intact
  the design noted in the prefilter's original entry above — that promoting
  this stage to a numeric scorer later remains a prompt-plus-migration
  change, not a rebuild.

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
