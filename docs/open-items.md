# Open items

Known defects and deferred work, with the evidence for each. Append and remove
freely — unlike `decisions.md` this file is not a log, it is a to-do list, and
an item leaves it when it is fixed or deliberately dropped.

Each entry says what is wrong, how we know, and what the fix looks like. An item
with no evidence behind it does not belong here; speculation belongs in
`concept.md` under what we haven't decided.

---

## Ranked by what costs the reader most

### 1. A section line has no headline

The writers' line contract is `ref;;the sentence`, so twelve pieces a day have
no headline at all. That was right for a continuous-reading layout, where a line
sat under a lead that had already established the situation. The reading view is
an index, and a row with no headline shows its whole sentence — three or four
lines tall next to rows that are one.

`displayHeadline` falls back to the sentence whole and deliberately does not
trim it: every cheap way to find a first sentence is wrong on news prose, since
a period plus a space ends "U.S." and "Adm." as readily as a clause.

**Fix:** restore the headline field to the line contract in
`src/pipeline/writers/prompt.ts` and `parseBriefBatchOutput`, so a line is
`ref;;headline;;sentence`. Note the consequence: **a line with a headline is
structurally a brief inside a section** — same shape, same fields — and the
publisher would stop needing to tell them apart. `section_role` still earns its
place for word targets.

Needs a pipeline run to see. Agreed with the reader 2026-08-28.

### 2. Hosts in fetch cooldown are costing top-of-paper stories

Paper #3's rank 10 — a judge throwing out Khalid Shaikh Mohammed's confession as
torture-tainted — published as a **brief**. `resolveTiersByMaterial` demoted it
two tiers because it was headline-only even at standard, and the cause is in the
fetch log: `nytimes.com` is in cooldown. The mechanism worked; the input was
missing.

`oregonlive.com` has the same problem and is the Oregon local beat, which the
bio weights hardest. Both serve a DataDome device check the browser UA does not
pass.

**Run #2 added two more:** `washingtonpost.com` and `newsinfo.inquirer.net`
entered cooldown on 2026-08-31, taking the total to seven. That is the warning
working, and it is also two more outlets whose stories now run on headline-level
material at whatever rank they earn. Worth a look at *why* those two started
refusing before they settle in as permanent like the first five.

As of the runner, a host **entering** cooldown warns on the pipeline run
(`pipeline.gates.fetch.warn_on_newly_cooled_hosts`), so a new one is noticed the
morning it happens rather than whenever someone next reads `inspect fetch`. The
five standing ones — `npr.org`, `oregonlive.com`, `thediplomat.com`,
`nytimes.com`, `insideclimatenews.org` as of run #1 — stay silent by design and
are on `pipeline_stage_runs.metrics` every run. That watches for the problem
getting worse; it does nothing about the hosts already lost.

**Also watch The Nugget**: three of its article fetches in run #59 returned HTTP
429 even after the browser-UA retry. It now leads the paper, so if it enters
cooldown its stories run headline-only at rank 1 — the same failure, at the
worst possible position. A per-host delay for it may be enough.

### 3. The nearness change nudged non-local scores

Measured on grouping run #58 (pass-1 #44 old / #45 old control / #46 new): the
signal was confined to local items as intended, and the carve-out held — routine
local business fell 17 to 31 points, p ~ 5.6e-15 against measured noise. But
mean interest across all items moved **-0.90**, and some non-local stories moved
2-3 sigma: an AP Kurds/SDF piece -10, an NYT Meta/Anthropic piece -11, an Ars
Technica piece -15.

Ranking is relative, so a uniform shift is harmless. Whether the *ordering* of
non-local items got worse is not established. Re-measure if the top of the paper
starts looking wrong in a way nearness does not explain.

---

## Structural, no reader impact yet

### 4. The outlet count is derived in two places

`src/db/outlets.ts` is called from grouping-pass-1, which stores the count on
`grouping_pass1_results`, and again from the editor, which re-derives it from
the digest instead of reading the stored value. Both call the same helper, so
they agree today. Two derivations of one number is two places to be wrong.

**Fix:** have the editor read `grouping_pass1_results.source_count` through the
pile, and delete its own derivation. It is a bigger change than it sounds
because the editor currently reaches the digest and not the pass-1 run.

### 5. A thread's source count can still double-count an outlet

`deriveThreadScores` sums its members' counts. Each member's count is now
distinct outlets *within that member*, but two clusters in one thread that both
contain AP still count AP twice. Correcting it means counting distinct outlets
across every member's items, which the thread pass does not currently load.

### 6. `exclude_paths` on RSS has no user

It works on both formats since 2026-08-29, and no source sets it. KTVZ's CNN
contamination — the case that motivated it — was fixed by swapping to a
local-only feed instead, which is the better fix. Keep the option; it is the
tool for a source that is worth having but publishes a section we do not want.

### 7. No inspection view for grouping or grouping-pass-1

Named in `CLAUDE.md` and still true. The project's convention is that an LLM
stage's feedback loop is its inspection view, and the two stages that decide
what the reader sees have none — the local-coverage investigation ran on raw
SQL because there was nothing else. `grouping.embedding.similarity_threshold` is
the pipeline's primary tuning lever and is inspected by hand.

**Fix:** `inspect grouping-pass1 [--id <n>] [--source <name>]` — score
distribution across both axes, the fail-safe count, and a source filter so
"where does the local beat land" is one command.

### 8. The runner's thresholds have seen exactly one run

Run #1 (2026-08-30) retuned the two that were visibly wrong — the collector now
warns on a step change rather than any dead feed, and the fetch warns only on a
host newly in cooldown. `max_duration_minutes` is 90 on a measured 14m 44s. See
`docs/decisions.md`, 2026-08-30.

Run #2 confirmed the retune from both sides: collect went silent at 1/111, and
fetch warned naming the two hosts that were genuinely new. Neither needed
touching again.

What is still a guess is everything neither run exercised, because both were
good days: `max_cut_fraction` (0.95 against 36.4% and 32.3%),
`max_unscored_fraction` and `abort_unscored_fraction` (0 unscored both runs),
`min_written_fraction` (150/150 both runs), and the collector's abort floor of
0.5 (98.2% and 99.1% succeeded). Every one has an order of magnitude between it
and the observed data.

Every gate persists what it read to `pipeline_stage_runs.metrics`, so this
answers itself: after a couple of weeks, query the column, see where real runs
sit, and move the thresholds to where they would have fired only on the runs
that deserved it. Resist tuning them on one more good day — a threshold that has
never been near a bad run has not been tested, only unused.

**Still open on timing:** 14m 44s and 16m 43s across two runs, so 06:00 puts the
paper up around 06:17. The variance is grouping-pass-1 tracking the day's row
count. The timer has not been installed and no unattended run has happened.

### 9. `--collector-run-id` on the preprocessor is provenance, not a filter

The preprocessor selects `raw_items` by a fixed `fetched_at` window and stores
the collector run id without ever filtering on it, so collect → preprocess is
joined by the clock. The runner passes it because recording which collection a
run was meant to follow is the only honest thing it can mean, but the flag reads
like a filter and is not one.

**Fix:** either make it real (filter on it when given) or rename it to say what
it is. Making it real is the better shape and changes what a hand-run
preprocessor collects, so it wants a decision rather than a patch.

---

## Deferred by decision, not defect

- **Images.** No pipeline exists. `.art-figure` is reserved in `globals.css` so
  adding them is not a re-layout. When they come: article pages only, not index
  thumbnails (120 thumbnails turn a list back into a feed and cost 120 image
  loads on cellular), and features first. The hard part is OG-image extraction,
  logo and tracker rejection, and rehost-versus-hotlink, which is a
  "curate, don't reproduce" question more than a technical one.
- **Per-story comments and copy-as-markdown.** `concept.md` V1.5. The comment
  field feeds the next day's editor, which is a feedback loop the pipeline does
  not have.
- **Paper #5's "HEADLINE:" headline stays.** Paper #5 (2026-08-31) rank 65, ref
  S68421, is published with the literal headline `HEADLINE:` and its real
  headline as the first line of its body. The parser defect is fixed
  (`docs/decisions.md`, 2026-08-31) but a fix does not reach back into a
  published paper, and `--repair` only re-writes pieces marked failed, so
  correcting it would mean clearing that row's status by hand and re-publishing
  an edition already read. Left as-is by decision 2026-09-01: one headline in one
  back number, and the archive is a record of what was published. Noted here so
  nobody re-diagnoses it as a live defect.
- **In-paper AI Q&A.** Explicitly out of scope in `CLAUDE.md`, and the reasoning
  holds: answering questions about a story means grounding in `article_texts`,
  the one table that holds third-party full text and is never published. Raised
  2026-08-28 and left cut; `concept.md`'s answer is that Gizmo handles
  conversation about a story via copy-as-markdown.
