# Gizmo task: run #51 — off-grid score bands, thread retry, digest re-check

Your run #50 report was right to call the run degraded, and the two things it
flagged were the two things worth flagging. One of the FAILs turns out to be a
false alarm — with a cause worth knowing — and the other is a real bug that is
now fixed. Details below so you can judge this run against the corrected
picture.

**No new migration this time.** 033 is already applied.

## Corrections to run #50's findings

**The digest filter was not broken.** Your `FAIL — digest filter upstream` was
based on two observations that are both consistent with the filter working:

1. The five digest items were still in `preprocessed_items`. They always will
   be — the junk filter runs at *read* time inside `getClusteringItems`, not at
   preprocess time, so that table always holds everything the preprocessor kept.
   Presence there proves nothing either way. That was my query's fault, not
   your reading of it.
2. No `[junk-filter] DROP … link-dump-digest` line appeared. Also expected:
   `getClusteringItems` applies the prefilter first and the junk filter only to
   the survivors. The prefilter cut them — it cut 440 items this run against
   422 in run #29 — so the junk filter never saw them and logged nothing.

I replayed all five of your observed titles through `classifyItem` locally and
every one is caught by the deterministic rules, so the backstop is real; it just
had nothing to do. **Your evidence was correct and your conclusion was the
reasonable reading of it.** The queries were wrong.

Two genuine gaps your output did expose, both now fixed: the two Just Security
editions differed by one word — "a curated guide to" vs "a curated **weekday**
guide to" — which the original pattern would have split on. And STAT's "This is
the online version of STAT's weekly email newsletter Health Care Inc." is a real
newsletter edition that survived every rule. Good catches, both from your raw
evidence.

**The thread failure was a real bug and is fixed.** `callWithBackoff` only
retried 429/503, so `Stream broke at 311715ms after 0 bytes … terminated` was
never retried and the single call the whole pass depends on was lost. It now
retries transport failures (broken streams, ECONNRESET, socket hang up,
premature close, fetch failed). Timeouts stay un-retried on purpose.

**On the ties:** you reported the change did not improve them, and by the
headline number you are right — 41 distinct vs run #109's 48. The axis
histograms you pulled explain why, and they were the most useful thing in the
report: ~88% of both axes landed on a multiple of five, and two multiples of
five sum to a multiple of five. That was my band definitions handing the model a
five-point lattice. Bands now end at 43/33/22/12/5 instead of 44/34/24/14/5.

## Deploy

Same branch, pull again, rebuild. Same checks as run #50 — typecheck, **16 test
files**, both networks, live-caps grep, `docker exec` fallback, and please keep
reporting the Compose stale-endpoint wart.

`npm run migrate` should report **nothing pending**. If it wants to apply
something, stop and report.

## Run

Same sequence, cross-run dedup off again:

```bash
npm run preprocess -- --skip-cross-run-dedup
npm run prefilter
npm run grouping
npm run grouping-pass1
npm run editor
npm run inspect -- editor --id <EDITOR_RUN>
```

Collector not rerun. Corpus gate first, as always.

## What I need back

Everything from the run #50 report — the shape is right, keep it. The items
below are what this run is specifically testing.

### 1. Did the thread pass survive?

```sql
SELECT id, candidates_in, threads_formed, rows_absorbed, calls, failed_calls,
       input_tokens, output_tokens
FROM thread_runs WHERE id = <THREAD_RUN>;
```

And every `[thread]` line from stdout, including any
`[thread] transport attempt N/5: retrying in …` — that line is new and means the
retry did its job. **`failed_calls` must be 0.** If it is 1 again, paste the
full error; a second failure in a row means the fix is aimed at the wrong thing.

Run #6 (the last healthy one) formed 6 threads absorbing 42 rows. Run #7 formed
zero. Anything in that range is fine; zero is not.

### 2. Did the off-grid bands spread the scores?

The axis histograms again — these are the diagnostic:

```sql
SELECT 'interest' AS axis, interest AS value, count(*)
FROM grouping_pass1_results WHERE run_id = <PASS1_RUN> AND interest IS NOT NULL
GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 15;

SELECT 'consequence' AS axis, consequence AS value, count(*)
FROM grouping_pass1_results WHERE run_id = <PASS1_RUN> AND consequence IS NOT NULL
GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 15;
```

Plus, directly: **what fraction of each axis is still a multiple of five?**

```sql
SELECT
  count(*) FILTER (WHERE interest    % 5 = 0)::float / count(*) AS interest_on_5s,
  count(*) FILTER (WHERE consequence % 5 = 0)::float / count(*) AS consequence_on_5s,
  count(*) AS scored
FROM grouping_pass1_results
WHERE run_id = <PASS1_RUN> AND interest IS NOT NULL;
```

Run #29 was ~88% on both. If that number has not moved, the prompt cannot fix
this and I will stop trying — say so plainly.

### 3. Ties — and please report the boundary separately

The three standard tie queries, but I want the **tier boundary result called out
on its own**, because it is the number that actually matters and the headline
count has been misleading me:

```sql
SELECT rank, tier, substring(reason from 'combined=([0-9.]+)') AS combined
FROM editor_stories
WHERE run_id = <EDITOR_RUN> AND rank BETWEEN 12 AND 19
ORDER BY rank;

SELECT rank, tier, substring(reason from 'combined=([0-9.]+)') AS combined
FROM editor_stories
WHERE run_id = <EDITOR_RUN> AND rank BETWEEN 72 AND 79
ORDER BY rank;
```

For each boundary, state **how many rows share the boundary value**. Baselines:
run #109 had 4-row and 12-row boundary ties; run #110 had 2-row and 2-row.

Also, for each of the largest tie groups, say **which tiers its rows fall in**.
In run #110 every large group sat entirely inside one tier, which makes it
nearly harmless. If that stops being true, that is a real regression and worth
flagging even if the headline count improves.

### 4. Digest check — same as before

The paper-level digest query (expect zero rows) and every `[junk-filter] DROP`
line. This time the drop lines may genuinely appear or may not, depending on
whether the prefilter gets there first; either is fine. What matters is zero
digests in the paper.

Please also check specifically whether **STAT+ newsletter editions** appear
anywhere in the ranked list — "STAT+: Ban prior auth? And hospitals cut jobs" is
the shape. Those are the newly-covered case.

And keep doing the manual scan of the ranked list for index-shaped items. Your
"5 things to know before Wednesday's vote on Moda Center negotiations" flag was
the right instinct — I looked at it and decided to keep it, because it is one
story about one vote rather than an index of unrelated stories, and there is now
a test asserting it survives. Keep flagging that class; I would rather decide
case by case than widen a regex.

### 5. Everything else

Stage totals, corpus gate, prompt sizes, body census, translated rows,
per-stage telemetry, tie-break telemetry, integrity checks, edge health,
warnings, and the full ranked list.

Grouping has now thrown 30–33 recovered 429s two runs running, at concurrency 4.
Note the count; I am watching whether it is trending.

## Rules

Unchanged.

- One run. Report bad news plainly.
- If a number contradicts what I predicted, trust your measurement. You have now
  been right three times doing this, and the one FAIL that turned out to be a
  false alarm was a bad query on my side, not a bad reading on yours.
- Do not change code, `config/models.yaml`, `docker-compose.yml`, Caddy config,
  or `sources.yaml`. Do not merge the branch.
- Preserve Postgres and its volume. Ask before anything destructive.
- Exact SQL output where I asked for a query.
