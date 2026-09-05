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

**The list churns, and the churn is not recovery.** Run #2 added
`washingtonpost.com` and `newsinfo.inquirer.net`, taking it to seven; run #3
showed five, because `thediplomat.com` and `insideclimatenews.org` aged out of
the 7-day lookback rather than starting to work. A blocked host is skipped, so it
writes no attempt rows, ages out, gets retried, fails and returns — the set
oscillates around a stable core of chronically blocked outlets. Do not read a
shrinking list as improvement; `inspect fetch` is where a host's actual history
is.

Worth a look at *why* washingtonpost.com and newsinfo.inquirer.net started
refusing, before they settle in as permanent like nytimes.com and oregonlive.com.

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

### 3b. One lineage false link the paper's own text cannot resolve

Measured three times. The judge with body text stands at **167 links, one
obviously wrong (0.60%)**, against 1.75% for the threshold it replaced. The
survivor:

> 2026-09-04 `S72939` "Ex-police officer charged with using Flock cameras to
> stalk girlfriend" linked to 2026-08-28 `S65838` "Georgia officer used Flock
> surveillance cameras to track his ex and another cop", 0.7525.
> Judge reason: *"same officer and stalking case, investigation then arrest"*.

**This one is not fixable with more body text.** Today's piece is a
141-character brief that never says Oregon and never names the officer; the
prior says "a Georgia police officer" and also names no one. The distinguishing
fact was never printed. The 2026-09-05 change constrains the *reason* instead —
a YES must name something both texts say — and **is untested**.

**If that does not hold, the next thing to try is source outlet names**
(`oregonlive.com` against `wired.com` is what the reviewer used). It is a weak
signal alone, because the syndication cases this work started from are precisely
different outlets carrying one story, so it needs its own measurement.

**A broad-campaign class remains undecided and is a policy question, not a
defect:** separate Gaza strikes inside one ceasefire, a Kyiv-region campaign
across days, Tesla Cybercab against the Waymo camera-vs-lidar dispute, Flock
expansion against Flock cancellations. Five such links in the last run. A reader
could accept any of them as one situation continuing. Decide it explicitly rather
than letting temperature decide it run to run.

**Noise:** the repeat run gave 34 of 35 identical links (one appeared,
`S70968 → S68485`) and one of 71 verdicts flipped. Stable at the marker level,
not at the verdict level.

**`candidate_floor` is 0.72 and still unswept.**

**The regression set** is Gizmo's three reviews under
`fritter-post-lineage-*` on the box, and from migration 044 every link carries
the judge's reason.

### 3c. Continuity is recorded but only the reader sees it

The lineage pass writes `paper_piece_lineage` and the story page renders it. The
two consumers that would fix the *headlines* rather than annotate them are not
built:

- **The writers** could foreground what changed instead of restating the
  situation, which is what Nvidia/Hugging Face and the Leipzig drone story needed.
- **The thread pass** could avoid regenerating an umbrella title three editions
  running, which is what put "six months" on the Iran section on 8/27, 8/28 and
  8/30.

Both are deferred on purpose until the threshold above is measured, because both
work by putting text about the paper into a prompt, and this project has five
recorded instances of a model relaying exactly that to the reader. Precision
first, then the prompt.

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

### 5b. `getParent` falls back to the source name, so a config rename orphans history

`loadOutletMap` is built from `sources.yaml`, and `getParent` returns the source
name itself for anything not in it. So the moment a source is renamed or removed,
every historical `preprocessed_items` row carrying the old name stops resolving
to its parent — silently.

Found while reading the 2026-09-03 cross-run replay. `AP Top News` and
`AP Politics` both declared `parent: "AP"` until commit `9ad8e72` (2026-08-26)
replaced them with a single `AP News`. Their rows are still in the database and
now resolve to two distinct outlets. It cost nothing here — the two affected rows
are from feeds that cannot produce more — but the same fallback governs the
cross-run URL key and `countDistinctOutlets`, so a future rename of a
high-volume source would quietly un-group its recent history and inflate the
editor's `ln(sources)` lift for a few days.

**Fix:** either an `aliases:` list on a source, or a small persisted
`source_name → parent` history. Neither is worth building until a rename is
actually planned; the note exists so the next rename is done deliberately.

### 5c. The under-30-character title population has never been measured

The cross-run title key has a 30-character floor, and the 2026-09-03 replay
observed a minimum matched length of 32. That is not evidence that nothing sits
below 30 — the supplemental boundary query errored and was correctly left
unrepaired, so the population is simply unmeasured. The risk direction is a miss,
not a false positive, so it does not block anything. Worth one query next time
someone is in that data.

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

Run #3 fired **no gate at all** — the first run to do so, and the retune's real
vindication.

What is still a guess is everything none of the three runs exercised, because
all three were good days: `max_cut_fraction` (0.95 against 36.4%, 32.3%, 33.5%),
`max_unscored_fraction` and `abort_unscored_fraction` (0 unscored every run),
`min_written_fraction` (150/150 every run), the collector's abort floor of 0.5
(98.2%, 99.1%, 98.2% succeeded), and the publisher's
`min_replacement_fraction` (only its permissive path has run in production).
Every one has an order of magnitude between it and the observed data. **A
threshold that has never been near a bad run has not been tested, only unused**
— so keep resisting the urge to tune them on another good day.

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
