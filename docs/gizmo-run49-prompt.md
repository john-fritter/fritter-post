# Gizmo task: re-run the pipeline with cross-run dedup OFF and report on run #49

## Why we are doing this again

Your run #48 report was accurate and well-built — the problem is with the run I
asked you to make, not with your measurement of it.

I had you run the whole pipeline from the beginning on the same day as run #47.
Cross-run dedup did what it is designed to do and suppressed everything run #47
had already processed: **preprocessor #37 considered 1,652 items and dropped
1,370 of them as cross-run duplicates, keeping 279.** So the pile that reached
editor #108 was built from roughly a fifth of a normal day's corpus.

That makes the headline number unusable. The pile was not even selective — pile
#58 had **0 items below the line and a score cutoff of 8**, meaning the editor
ranked every scored row including a long tail of low-relevance items that would
never reach a real paper. Comparing "101 of 119 rows tied" against run #107's
"127 of 150" is comparing two different things.

So: same measurement, on a full corpus this time.

## The one thing that changes

**Run the preprocessor with cross-run dedup disabled:**

```bash
npm run preprocess -- --skip-cross-run-dedup
```

It will print `[preprocessor] CROSS-RUN DEDUP DISABLED — testing mode, not for
production` and set `cross_run_dedup_skipped = true` on the run row. Confirm
both in your report. If `cross_run_dedup` drops more than a handful of items on
this run, something is wrong — stop and tell me.

**Do not re-run the collector.** The raw items are already in the database from
collectors #47 and #48, the preprocessor's window is a fixed 24 hours on
`fetched_at`, and re-collecting buys nothing while risking more rate-limit
failures — The American Prospect already returned 429 on run #48, almost
certainly because we hit it twice in a day.

Exception: there is a small collector change on the branch (below) that needs a
fresh collect to be exercised. Run the collector **only if** the rest of the
pipeline has completed and you are producing the collector section of the
report; run it last, separately, and note that its items are not what fed the
pipeline. If you would rather skip it entirely, skip it and say so — the pipeline
measurement matters more.

## Deploy

Same branch, **`claude/fritter-post-build-review-jkr933`**, but pull again —
there is a new commit on it. Rebuild the image (config and source are baked in
at build time, so a restart is not enough). Same verification as last time:
typecheck, 15 test files, no pending migrations, both networks attached, and the
live-caps grep showing `body_cap: 500` / `body_cap: 1000`.

The only code change since the commit you deployed is in the collector: the
browser-UA retry now logs when the escalation is *also* refused, and sends a few
more browser-ish headers on that second attempt. Nothing else changed, so it
cannot affect the tie measurement.

Your note that `docker compose exec -T app` could not see the manually recreated
container and that `docker exec fritter-post-app-1` worked instead — good catch,
keep doing that, and keep reporting it. That is a real operational wart and I
want it in every report until the compose file is fixed.

## Run

```bash
npm run preprocess -- --skip-cross-run-dedup     # ← the only changed command
npm run prefilter
npm run grouping
npm run grouping-pass1
npm run editor
npm run inspect -- editor --id <EDITOR_RUN>      # ← note the --id
```

**`--id` matters.** Last time I asked for `npm run inspect -- editor` with no
id, which prints the run-history table rather than the ranked story list. That
was my mistake in the prompt, and you were right to preserve the actual output
instead of dressing it up as something else. With `--id` it renders the ranked
tree, which is the artifact I actually need to read.

## What I need back

Everything from the run #48 report, in the same shape — it was the right shape.
The queries below are the same as last time with new run ids, plus two new ones.

### 1. Corpus sanity check (do this first)

```sql
SELECT raw_items_considered, items_kept, items_dropped_recency,
       items_dropped_duplicate, cross_run_dedup_skipped
FROM preprocessor_runs WHERE id = <PREPROCESSOR_RUN>;
```

I expect roughly 1,300–1,700 considered and nearly all of them kept. If items
kept is in the hundreds again, the flag did not take effect — stop and report
rather than running the rest.

Then the stage totals: preprocessor kept, prefilter in/kept/cut, grouping
clusters/singletons, pass-1 scored, thread formed/absorbed, pile
clusters/singletons/**below line**/cutoff, editor items/tiers.

**The pile's `below_line` count and `score_cutoff` are the tell.** A healthy run
has a real cutoff (run #57's was 52) and hundreds of rows below the line. If
below_line is 0 again the pile is not selecting and the tie numbers are still not
comparable.

### 2. The headline metric

Same three queries as last time against the new editor run id: tie group sizes,
the distinct/total/tied summary, and the ranks 14–17 / 74–77 tier-boundary check.

Baselines to compare against, both from run #107 on a full corpus:
- 38 distinct combined scores across 150 rows
- 127 of 150 rows in a tie group
- largest tie group 22 rows
- both tier boundaries inside a tie

### 3. Pass-1 score distribution

Same two queries (histogram by `item_type`, and the per-type summary) against the
new pass-1 run id.

### 4. Proof the excerpts reached the model

Same two prompt-size queries, plus the first 1,200 characters of one prefilter
`user_prompt`. Run #48's showed `avg_prompt_chars` of 18,046 over batches of 40,
so the caps are demonstrably live — I mostly want to confirm it again at full
volume.

### 5. NEW — how much of the corpus actually has a body

This is the most important new question, and run #48's prompt sample is what
raised it. That sample showed Hacker News items arriving with
`body_excerpt: "Comments"` and the AP Google-News-proxy items arriving with the
body just repeating the headline. For those sources a larger `body_cap` buys
exactly nothing, because there is no body to show.

I need to know how big that group is:

```sql
SELECT
  count(*) AS items,
  count(*) FILTER (WHERE coalesce(length(english_body), 0) = 0)          AS body_empty,
  count(*) FILTER (WHERE length(english_body) BETWEEN 1 AND 100)         AS body_under_100,
  count(*) FILTER (WHERE length(english_body) BETWEEN 101 AND 500)       AS body_100_500,
  count(*) FILTER (WHERE length(english_body) BETWEEN 501 AND 2000)      AS body_500_2000,
  count(*) FILTER (WHERE length(english_body) > 2000)                    AS body_over_2000
FROM preprocessed_items
WHERE preprocessor_run_id = <PREPROCESSOR_RUN>;

-- Same cut, per source, worst first. Truncate to the top 30 rows.
SELECT source_name,
       count(*) AS items,
       round(avg(coalesce(length(english_body), 0))) AS avg_body_chars,
       max(coalesce(length(english_body), 0)) AS max_body_chars
FROM preprocessed_items
WHERE preprocessor_run_id = <PREPROCESSOR_RUN>
GROUP BY source_name
ORDER BY avg_body_chars ASC, items DESC
LIMIT 30;
```

And the same body-length histogram restricted to the items that actually reached
the paper:

```sql
SELECT
  count(*) AS paper_rows,
  count(*) FILTER (WHERE coalesce(length(pi.english_body), 0) = 0)    AS body_empty,
  count(*) FILTER (WHERE length(pi.english_body) BETWEEN 1 AND 500)   AS body_under_500,
  count(*) FILTER (WHERE length(pi.english_body) > 500)               AS body_over_500
FROM editor_stories es
JOIN preprocessed_items pi ON pi.id = es.preprocessed_item_id
WHERE es.run_id = <EDITOR_RUN>;
```

This number decides how much further the excerpt lever can be pushed at all, and
it feeds a bigger decision about the writers stage, so please do not skip it even
if the rest of the run goes badly.

### 6. English text

Same two queries as last time, plus — this time — the **full ranked list** from
`inspect -- editor --id <EDITOR_RUN>`. Run #48 verified 46 translated rows in the
paper and zero rows missing an English title, which is exactly what I wanted to
see; I just never got to look at the rendered list.

### 7. Collector

Only if you ran it (see above). Report the same things as last time, and
specifically **every line containing `browser UA`** — there are now two variants,
one for a rescued source and one for a source that refused the browser UA too.
Run #48 could only tell me no rescue happened; this run should say which of the
two it was.

Also note: TechCrunch succeeded directly on run #48 after 403ing on run #47, so
its block appears to be intermittent or rate-based rather than a standing UA
rule. Worth confirming.

### 8. Labor Notes — solved, no action needed

Your diagnostic block did its job completely. The markup shows a PuzzleMe
crossword embed whose `//--><!]]>` on line 63 terminates the CDATA section
early, so the `</script>` on line 64 lands in the XML as an unexpected close
tag — which is exactly the reported error position, column 9 of a 9-character
tag. That is a malformed feed on the publisher's end, not a bug on ours.

**Do not try to fix it.** I have not decided between repairing the CDATA in code
and dropping the source, and a wrong "repair" of XML is worse than a clean
failure. Just confirm whether it fails again and move on.

### 9. Integrity and edge health

Same as last time. Note that your run #48 conclusion was right and I want it
stated the same way if it recurs: the tier counts agreed with `editor_runs` at
15/60/44 summing to 119, and a checker asserting 150 is the thing that is wrong.
Public HTTPS returning 200 with a valid Let's Encrypt cert resolves the failure
from run #47 — confirm it is still 200.

### 10. Per-stage telemetry, warnings, surprises

Same as last time.

## Rules

Unchanged from the last prompt, and they held up well:

- One run. Report what happened, including bad news. Do not re-run hoping for a
  better number, and if you do re-run anything, say so.
- If a number contradicts what I predicted above, trust your measurement and
  flag the contradiction. You did this correctly on run #48 twice — the
  `inspect` output and the tier-count checker — and both were right.
- Do not change code, `config/models.yaml`, `docker-compose.yml`, Caddy config,
  or `sources.yaml`. Do not merge the branch.
- Preserve Postgres and its volume. Ask before anything destructive.
- Exact SQL output where I asked for a query, not a summary of it.
