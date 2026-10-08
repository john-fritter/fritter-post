# Gizmo task — deploy the outage fixes and backtest the rerun check

Branch `claude/fritter-post-quality-review-e9ltv5`, head `a22dbed` or later.
Production is on `main` at `1258edd`. This task **deploys the branch**, applies
one migration, and then runs a **measurement that writes only audit rows**. Do
not run `collect`, `preprocess`, `prefilter`, `grouping`, `grouping-pass1`,
`editor`, `write`, `publish` or `pipeline` by hand, and do not edit config on the
box. If something looks wrong, report it back; the repo change is made on the
branch.

## What changed (from your follow-up report)

1. **Translation breaker.** Sep 15–21's 4,875 failed translation calls: the
   preprocessor now stops translating after 10 consecutive failures, and stops at
   once on an authentication error. `callWithBackoff` no longer retries auth
   errors, including the `429 … repeated invalid credentials` lockout.
   Untranslated items keep their original text, and the preprocessor gate warns.
2. **Empty embedding input.** Sep 12's `400 too_small` at input 179 (KTVZ item
   80915, empty title): a missing title now borrows the body's opening, and an
   item with neither is left out.
3. **Lineage lookback counts editions, not days.** This is why paper #42 had zero
   markers.
4. **Fetched page vs headline.** Sep 8 rank 2's La Nación real-estate page is
   rejected when it shares under a fifth of the headline's distinctive words.
5. **The rerun check (new, migration 045).** Runs inside `grouping-pass1`, after
   scoring and before threading. Each top-scoring row is compared with the pieces
   printed in the last 7 editions. A judge answers RERUN / DEVELOPMENT / NEW, and
   RERUN rows are withheld from the pile. **This is the change to measure before
   tomorrow's 06:00 run uses it.**

## 1. Deploy

```bash
cd /srv/fritter-post
git fetch origin claude/fritter-post-quality-review-e9ltv5
git checkout claude/fritter-post-quality-review-e9ltv5
git pull --ff-only
git log --oneline -1          # expect a22dbed or later
docker compose up -d --build
docker network connect seedbox_default fritter-post-app-1   # always — the site 502s without it
docker compose exec -T app npm run migrate                  # expect 045_reruns.sql applied
docker compose exec -T app npm test                         # expect "All 38 test files passed."
```

Confirm the site answers after the reconnect.

## 2. Find the grouping-pass-1 run behind each paper

```sql
SELECT p.id AS paper_id, p.published_on, pr.id AS pipeline_run, pr.grouping_pass1_run_id
FROM papers p JOIN pipeline_runs pr ON pr.paper_id = p.id
WHERE p.id BETWEEN 34 AND 41 ORDER BY p.published_on;
```

## 3. Backtest

For each of **Sep 7, 8, 9, 10, 11 and 14**, run the check against that day's
pass-1 run, **as of that paper's date**. `--as-of` makes it compare only with the
papers that existed that morning. The script writes `rerun_runs`,
`rerun_verdicts` and `generation_logs` rows only. It does not build a pile, a
thread run or a paper.

```bash
docker compose exec -T app npm run rerun-check -- --grouping-pass1-run <n> --as-of 2026-09-08
docker compose exec -T app npm run inspect -- reruns --id <rerun run id it prints> --all
```

Save the full output of both commands for every day.

## 4. What we expect, and what to report

Checked against the published headlines (row titles will differ, so match by
topic):

**Should be withheld (RERUN)**
- Sep 7: Australia algorithmic-feed law (printed Sep 6); Seattle Times/Newsday
  suing OpenAI (Sep 6); Isar Aerospace launch (Sep 6); Egypt TV presenter death
  sentence (Sep 6).
- Sep 8: AfD wins Saxony-Anhalt 43.8% (Sep 7); JLR 4,000 jobs (Sep 7); ECHR 879
  complaints (Sep 7); LG TVs recording (Sep 7); US union membership +411,000
  (Sep 7); Australia feed law again; Russia–North Korea road bridge (Sep 7);
  Ohio fair attack on Amy Acton (Sep 7).
- Sep 9: Canada's counter-tariffs take effect (Sep 8); LG TVs again; PISA scores
  (Sep 8); Mistral €3bn (Sep 8); Stoke Space $1bn (Sep 8).
- Sep 10: IAEA Yongbyon facility (Sep 9); AfD 43.8% again; DeepSeek V4.1 Flash
  (Sep 9); NYC school AI ban (Sep 3/5).
- Sep 11: Oregon tsunami evacuation structure (Sep 9); Bend 45-unit housing
  (Sep 10); Denver suing over armed ICE at polls (Sep 10); Imelda Marcos
  acquittal (Sep 9).
- Sep 14: FEMA staffing ruling (Sep 13); Java Sea ferry (Sep 13); Turkish
  LGBTQ+ raids (Sep 13).

**Must be kept (a real development)**
- Sep 8: Romualdez **arrested** (after being charged Sep 7).
- Sep 9: U.S. destroys **five** tankers (after three on Sep 6). Medical examiner's
  finding in the Portland Taser death (after the death Sep 4).
- Sep 10: Portland council's **final** Cesar Chavez vote.
- Sep 11: Supreme Court **blocks** Missouri's map. Oregon **approves** $123M for
  wildfire costs (after "weighs" Sep 7). Nepal's $4.78bn reconstruction figure.
- Sep 13 (run it too if cheap): LG **denies** the recording claims.

For each day, report:
1. rows checked, pairs judged, rows withheld, failed calls
2. every RERUN verdict with its reason, marked as **correct** (was already printed) or **wrong** (a real development, or a different story)
3. which expected reruns above were **missed**, and what the judge said about them. If a pair was never offered, say so: that means retrieval missed it, and the similarity floor needs changing, not the prompt.
4. whether any of the "must be kept" stories was withheld. **This is the result that matters most.** A wrongly withheld story never reaches the reader.

Also send the `generation_logs` rows for `stage='rerun'` from the backtest
(prompts and responses), and the wall-clock time of each `rerun-check` run.

## 5. If it goes badly

If the backtest withholds a real development, or withholds more than about 20
rows on any day, **say so before 06:00 Pacific tomorrow**. The fix is to set
`rerun.enabled: false` on the branch, not on the box. The other four changes are
independent of it and should stay deployed.
