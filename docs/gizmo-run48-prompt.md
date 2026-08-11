# Gizmo task: deploy branch `claude/fritter-post-build-review-jkr933` and report on run #48

## What this is

Fritter Post has three changes that need a real pipeline run to evaluate. I need
you to deploy the branch, run the full pipeline once, and send back a report of
specific numbers. **Do not tune anything, do not change code, do not change
`config/models.yaml`.** If something looks wrong, put it in the report — that is
what the report is for. The point of this run is measurement.

Deploy the branch **`claude/fritter-post-build-review-jkr933`**, not `main`. Do
not merge it.

## What changed, so you know what you are looking at

1. **Body excerpt caps.** `prefilter` and `grouping-pass-1` were showing the LLM
   `title + body_text[:50]` — about eight words — via a hardcoded slice. That is
   now config: `prefilter.body_cap: 500` and `editor_pass_1.body_cap: 1000`.
   Three other caps that were hardcoded at 300 moved to config at the same
   value, so they should change nothing.

2. **English text in judgment stages.** Only `grouping` was reading the
   preprocessor's `english_title` / `english_body` columns. `prefilter`,
   `grouping-pass-1`, `thread` and the editor tie-break now read them too, via
   `src/lib/text.ts`. `inspect -- editor` also displays English titles now.

3. **Collector 403 retry.** A feed that 403s to the `FritterPost/0.1` UA is now
   retried once with a browser UA. Only 403 — 404/410/5xx are not retried. XML
   parse failures now log the markup around the failing line.

**No new migrations.** The next migration number is still 033. `npm run migrate`
should report nothing pending; if it wants to apply something, stop and tell me.

## Deploy

`config/models.yaml` is **copied into the image at build time** (see the
Dockerfile's runner stage), so this needs a real rebuild — restarting the
container will run the old caps and the whole run will be worthless.

1. Fetch and check out `claude/fritter-post-build-review-jkr933` in
   `/srv/fritter-post`. Record the commit SHA.
2. Run the host checks first: `npm run typecheck` and `npm test` (15 test files
   expected, all passing). If either fails, **stop and report** — do not deploy.
3. Rebuild the image and recreate the app container.
4. `docker compose exec -T app npm run migrate` — expect "no pending
   migrations".
5. Confirm the running container is on the new image, and confirm the app is
   attached to both `fritter-post_internal` and `seedbox_default`.

**Known deploy hazard:** last run, `docker compose up -d` failed with a stale
dual-network endpoint error and you recreated `fritter-post-app-1` by hand from
the new image. `docker-compose.yml` declares only `internal` on the `app`
service while `seedbox_default` is attached manually, which is probably why.
Handle it the same way if it recurs, but **do not edit `docker-compose.yml`** —
just note in the report exactly what you had to do. Postgres, its volume, and
both networks must be preserved.

**Verify the new caps are actually live** before running the pipeline:

```bash
docker compose exec -T app sh -c "grep -A2 'body_cap' config/models.yaml | head -40"
```

If that does not show `body_cap: 500` and `body_cap: 1000`, the image is stale.
Stop and report.

## Run the pipeline

Run these in order inside the app container, capturing full stdout for each to a
file. **Record the run id each stage prints** — I need the exact lineage.

```bash
docker compose exec -T app npm run collect
docker compose exec -T app npm run preprocess
docker compose exec -T app npm run prefilter
docker compose exec -T app npm run grouping
docker compose exec -T app npm run grouping-pass1
docker compose exec -T app npm run editor
docker compose exec -T app npm run inspect -- editor
```

If a stage fails, stop there, keep the stdout, and report. Do not retry a failed
stage more than once, and say so if you did.

## What I need back

### 1. Lineage and deploy facts

Commit SHA, the full run-id chain (collector → preprocessor → prefilter →
grouping → grouping-pass1 → thread → pile → editor), host test/typecheck result,
migration check result, and anything unusual you had to do to get the container
running.

### 2. The headline metric — did the tie storm break up?

This is the main question. Run #107 had **38 distinct combined scores across 150
rows, with 127 rows sitting in a tie group** (largest group: 22 rows). Both tier
boundaries fell inside a tie.

```sql
-- Tie group sizes. Substitute the new editor run id.
SELECT substring(reason from 'combined=([0-9.]+)') AS combined,
       count(*) AS rows_at_this_score
FROM editor_stories
WHERE run_id = <EDITOR_RUN>
GROUP BY 1
ORDER BY rows_at_this_score DESC, combined DESC;

-- Summary line.
SELECT count(DISTINCT substring(reason from 'combined=([0-9.]+)')) AS distinct_combined,
       count(*) AS total_rows,
       count(*) FILTER (
         WHERE substring(reason from 'combined=([0-9.]+)') IN (
           SELECT substring(reason from 'combined=([0-9.]+)')
           FROM editor_stories WHERE run_id = <EDITOR_RUN>
           GROUP BY 1 HAVING count(*) > 1
         )
       ) AS rows_in_a_tie
FROM editor_stories
WHERE run_id = <EDITOR_RUN>;

-- Do the tier boundaries still fall inside a tie group?
SELECT rank, tier, substring(reason from 'combined=([0-9.]+)') AS combined
FROM editor_stories
WHERE run_id = <EDITOR_RUN> AND rank IN (14,15,16,17, 74,75,76,77)
ORDER BY rank;
```

Report all three verbatim.

### 3. The score distribution that drives it

```sql
-- Singletons vs clusters, separately. The whole point of the fix was that
-- singletons were being scored on 50 characters while clusters got a summary,
-- so the two distributions should now look more alike.
SELECT item_type, score, count(*)
FROM grouping_pass1_results
WHERE run_id = <PASS1_RUN>
GROUP BY item_type, score
ORDER BY item_type, score DESC;

SELECT item_type,
       count(*) AS n,
       count(DISTINCT score) AS distinct_scores,
       min(score), round(avg(score)::numeric,2) AS avg, max(score)
FROM grouping_pass1_results
WHERE run_id = <PASS1_RUN>
GROUP BY item_type;
```

For reference, run #26 across both types was: 499 items, min 8, avg 44.04,
max 85.

### 4. Proof the bigger excerpts actually reached the model

```sql
-- Prompt sizes. Run #27's prefilter averaged ~3,200 input tokens per call.
SELECT count(*) AS calls,
       sum(input_tokens) AS in_tok,
       sum(output_tokens) AS out_tok,
       round(avg(length(user_prompt))) AS avg_prompt_chars,
       max(duration_ms) AS slowest_ms,
       count(*) FILTER (WHERE error IS NOT NULL) AS errors
FROM generation_logs
WHERE stage = 'prefilter' AND stage_run_id = <PREFILTER_RUN>;

SELECT count(*) AS calls,
       sum(input_tokens) AS in_tok,
       round(avg(length(user_prompt))) AS avg_prompt_chars,
       count(*) FILTER (WHERE error IS NOT NULL) AS errors
FROM generation_logs
WHERE stage = 'grouping-pass-1' AND stage_run_id = <PASS1_RUN>;
```

Also paste **the first 1,200 characters of one prefilter `user_prompt`** so I can
see an actual `body_excerpt` field with my own eyes. That is the single most
direct check that the config change took effect.

### 5. Did the English text land?

```sql
-- How many rows in the finished paper are translated items?
SELECT count(*) AS translated_rows_in_paper
FROM editor_stories es
JOIN preprocessed_items pi ON pi.id = es.preprocessed_item_id
WHERE es.run_id = <EDITOR_RUN>
  AND pi.english_title IS NOT NULL
  AND pi.english_title <> pi.title;

-- Any item that reached the paper WITHOUT a translation? These are the ones
-- that fell back to original-language text.
SELECT es.rank, es.tier, pi.source_name, pi.title
FROM editor_stories es
JOIN preprocessed_items pi ON pi.id = es.preprocessed_item_id
WHERE es.run_id = <EDITOR_RUN>
  AND (pi.english_title IS NULL OR pi.english_title = '')
ORDER BY es.rank;
```

And confirm from the `inspect -- editor` output that the ranked list now reads in
English. Run #107 had 33+ rows in Chinese, Russian and Korean. **Paste the full
`inspect -- editor` output** — that is the artifact I actually read.

### 6. Collector: did the 403 retry work?

From the collector stdout, report:

- Every line containing `served with a browser UA` — these name the sources the
  retry rescued. I expect **The Baffler, TechCrunch, Inside Climate News**.
- The full source failure list (name + status), same format as last run.
- Sources that succeeded but returned **zero items**. Last run there were seven,
  including **all three Reuters feeds** — I specifically want to know whether
  Reuters is still empty.
- If **Labor Notes** failed again, paste the new `[collector] Labor Notes: XML
  parse failed` block *with the surrounding markup lines*. That is new
  diagnostic output and it tells me exactly what to fix.
- **Mail & Guardian** is expected to still 404 — its feed URL is dead and I have
  not replaced it. Just confirm.

Totals: sources attempted / succeeded / failed, items fetched, items inserted.

### 7. Editor tie-break health

From the editor stdout, report every line containing `tie-break` — specifically
any `omitted N ref(s)` warnings. Run #107 had one group drop 14 refs, which
silently fell back to alphabetical ref ordering. Plus:

```sql
SELECT count(*) AS calls, sum(input_tokens), sum(output_tokens),
       sum(duration_ms) AS total_ms,
       count(*) FILTER (WHERE error IS NOT NULL) AS errors
FROM generation_logs
WHERE stage = 'editor-tie-break' AND stage_run_id = <EDITOR_RUN>;
```

### 8. Two failures from last time I want re-checked

**(a) The tier-count integrity check failed** in your last report, but both
artifacts showed 15/60/75/0 summing to 150. I think your checker is wrong rather
than the data. Settle it:

```sql
SELECT tier, count(*) FROM editor_stories WHERE run_id = <EDITOR_RUN> GROUP BY tier;
SELECT items_in, items_feature, items_standard, items_brief, items_cut
FROM editor_runs WHERE id = <EDITOR_RUN>;
```

If those agree with each other and your checker still reports FAIL, the checker
has the bug — say so.

**(b) Public HTTPS returned HTTP 0** while the Caddy upstream probe passed. HTTP
0 means nothing answered at all, so this is DNS/TLS/routing at the edge, not the
app. Re-probe both and, if it still fails, dig one level: does
`post.fritter.lol` resolve from the host, does the TLS handshake complete, is
there a cert, what does Caddy's log say. Report findings — **do not change Caddy
config** without asking me first. Note that the served page is still a
placeholder, so a 200 with an almost-empty page is the expected success case.

### 9. Everything else

Per-stage telemetry from `generation_logs` (calls, tokens, duration, errors,
429s, 503s) for every stage, as in your last report. Any warning printed by any
stage. Anything that surprised you.

## Rules

- Report what happened, including anything that went badly. A report that says
  "the tie groups did not break up" is a useful report — do not soften it and do
  not re-run the pipeline hoping for a better number. One run.
- If a number contradicts what I said to expect above, trust your measurement
  and flag the contradiction.
- Do not change code, config, `docker-compose.yml`, Caddy config, or
  `sources.yaml`. Do not merge the branch. Ask before anything destructive.
- Preserve Postgres and its volume.
- Include exact SQL output rather than summaries where I asked for a query.
