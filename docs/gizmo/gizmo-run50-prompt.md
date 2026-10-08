# Gizmo task: deploy the two-axis scorer + digest filter, report on run #50

Run #49 was exactly the measurement I needed — the corpus gate, the body census,
and the tie breakdown all did their job. Two changes came out of it. This run
tests both.

**There is a new migration this time (033).** That is the one thing that differs
operationally from the last two runs.

## What changed

**1. Grouping-pass-1 scores two axes instead of one.** The model now emits
`id;;interest;;consequence;;reason` — each 0–50 — and software sums them into
the same 0–100 `score`. Nothing downstream changes: the pile cutoff, the editor
formula, and a thread's `max(member score)` all read `score` exactly as before.
Migration 033 adds nullable `interest` and `consequence` columns to
`grouping_pass1_results` so the axes can be inspected separately.

Why: 115 of run #109's 119 tied rows were singletons tied at an *integer*.
A singleton gets `source_weight * ln(1) = 0` from the editor, so `combined ==
score` exactly and equal integers are exact ties. One integer also bunched onto
round attractors (55, 58, 60, 62, 65, 68, 70, 72). Two axes should spread it.

**2. Link dumps are cut deterministically.** Three new high-precision rules in
`junk-filter.ts`: date-only titles, digest mastheads anchored to a separator,
and digest boilerplate in the body. The prefilter prompt also gained a
shape-based digest section, and the consequence axis scores digests 0–4 — but
the pattern rules are the guarantee. `getClusteringItems` is the only path into
both grouping and pass-1, so a matched item can reach the pile as neither a
cluster member nor a singleton.

Why: run #109 put "Early Edition: August 10, 2026" at **rank 9, feature tier**,
with the joint-highest singleton score in the paper.

## Deploy

Same branch, `claude/fritter-post-build-review-jkr933`, pull again. Rebuild the
image. Same checks as last time, plus one:

**Run `npm run migrate` and confirm 033 applies.** It should report applying
`033_pass1_score_axes.sql` and nothing else. Then verify the columns exist:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'grouping_pass1_results'
  AND column_name IN ('interest','consequence');
```

If the migration does not apply, stop and report — the pass-1 insert writes
those columns and will fail without them.

Everything else is unchanged: typecheck, tests (**16 files now**, not 15 — there
is a new `junk-filter.test.ts`), both networks, the live-caps grep, and the
`docker exec` fallback for the manually recreated container. Keep reporting the
Compose stale-endpoint wart.

## Run

Same as run #49, and **again with cross-run dedup off** — this will be another
same-day re-run over the existing corpus:

```bash
npm run preprocess -- --skip-cross-run-dedup
npm run prefilter
npm run grouping
npm run grouping-pass1
npm run editor
npm run inspect -- editor --id <EDITOR_RUN>
```

Do not re-run the collector. Same reasoning as last time: the raw corpus is
already there and re-collecting only risks more rate-limit failures. The
collector's browser-UA change stays unexercised; that is fine, it is not what
this run is measuring.

Corpus gate first, as before — expect ~1,650 considered and nearly all kept, and
a selective pile with hundreds of rows below the line. If the corpus comes back
small, stop before spending money on the rest.

## What I need back

Everything from the run #49 report — it was the right shape, keep it. Plus the
following, which are what this run is actually for.

### 1. THE DIGEST CHECK — do this first and report it prominently

This is a pass/fail, not a metric. **Zero digests may appear in the paper.**

```sql
-- Every row in the paper whose title looks like a digest. Expect zero rows.
SELECT es.rank, es.tier, pi.source_name, pi.title
FROM editor_stories es
JOIN preprocessed_items pi ON pi.id = es.preprocessed_item_id
WHERE es.run_id = <EDITOR_RUN>
  AND (
    pi.title ~* '^(early edition|the download|catch-up weekend|daily briefing|morning briefing|evening briefing|what we''re reading)'
    OR pi.title ~* '^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+[0-9]{1,2},?\s+[0-9]{4}$'
    OR pi.title ~* '^[0-9]{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+[0-9]{4}$'
  )
ORDER BY es.rank;
```

Then confirm the filter actually fired upstream, and on what:

```sql
-- Items the junk filter would now drop. Compare against the prefilter's input
-- count to see how many the rule caught.
SELECT source_name, title, left(coalesce(english_body,''), 120) AS body_head
FROM preprocessed_items
WHERE preprocessor_run_id = <PREPROCESSOR_RUN>
  AND (
    title ~* '^(early edition|the download|catch-up weekend|daily briefing|morning briefing|evening briefing|what we''re reading)'
    OR title ~* '^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+[0-9]{1,2},?\s+[0-9]{4}$'
    OR coalesce(english_body,'') ~* 'a curated (guide|roundup|list) to'
    OR coalesce(english_body,'') ~* 'here''s today''s news'
  )
ORDER BY source_name, title;
```

And from the **grouping stdout**, every line containing `[junk-filter] DROP`
with reason `link-dump-digest`. That is the filter announcing each catch by
name. Paste them all — I want to read what it caught and check for anything it
should not have.

**If the digest query returns rows, that is the headline finding of the run and
I want it at the top of the report, above everything else.**

Separately, please scan the full ranked list yourself and flag anything that
reads like an index of other stories rather than a story — even if it does not
match the patterns above. Newsletter editions and "N things to know" items are
the shapes to watch for. You have better eyes on the actual output than a regex
does.

### 2. Did two axes break up the ties?

Same three tie queries as before (group sizes, distinct/total/tied summary,
ranks 14–17 and 74–77), plus the new axis breakdown:

```sql
SELECT item_type,
       count(*) AS n,
       count(DISTINCT score)       AS distinct_sums,
       count(DISTINCT interest)    AS distinct_interest,
       count(DISTINCT consequence) AS distinct_consequence,
       count(*) FILTER (WHERE interest IS NULL) AS fail_safed
FROM grouping_pass1_results
WHERE run_id = <PASS1_RUN>
GROUP BY item_type;

-- Which axis is bunchy? Top 15 values of each.
SELECT 'interest' AS axis, interest AS value, count(*)
FROM grouping_pass1_results WHERE run_id = <PASS1_RUN> AND interest IS NOT NULL
GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 15;

SELECT 'consequence' AS axis, consequence AS value, count(*)
FROM grouping_pass1_results WHERE run_id = <PASS1_RUN> AND consequence IS NOT NULL
GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 15;
```

Baselines, both from full-corpus runs:
- run #107: 38 distinct combined, 127 of 150 tied, largest group 22
- run #109: 48 distinct combined, 119 of 150 tied, largest group 19

If one axis is bunchy and the other is not, that tells me which set of prompt
bands to rewrite next, so please state which it is.

### 3. Did the consequence axis catch digests on its own?

Independent of the pattern rules — if any digest survived to be scored, I want
to know how it scored:

```sql
SELECT r.score, r.interest, r.consequence, r.reason, pi.title
FROM grouping_pass1_results r
JOIN preprocessed_items pi ON pi.id = r.preprocessed_item_id
WHERE r.run_id = <PASS1_RUN>
  AND r.reason ~* 'digest|roundup|round-up|link'
ORDER BY r.score DESC
LIMIT 20;
```

An empty result is a good outcome here — it means nothing digest-shaped reached
the scorer at all.

### 4. Everything else from run #49

Stage totals, prompt sizes, tie-break telemetry and lines, per-stage telemetry,
body census (the same three queries — I want to watch it move as sources
change), translated-row counts, integrity checks, edge health, warnings, and the
full `inspect -- editor --id <n>` ranked list.

One thing to note: the pile cutoff will probably move, because the score
distribution is changing shape. That is expected, not a fault. Report the new
cutoff and below-line count.

## Rules

Unchanged, and they have held up well across three runs:

- One run. Report bad news plainly. Do not re-run for a better number; if you do
  re-run anything, say so.
- If a number contradicts what I predicted, trust your measurement and flag it.
  You have been right twice doing this.
- Do not change code, `config/models.yaml`, `docker-compose.yml`, Caddy config,
  or `sources.yaml`. Do not merge the branch.
- Preserve Postgres and its volume. Ask before anything destructive.
- Exact SQL output where I asked for a query.
