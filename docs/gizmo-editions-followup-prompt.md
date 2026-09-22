# Gizmo task — follow-up to the Sep 5–22 edition audit

**Read-only.** Do not run `collect`, `preprocess`, `prefilter`, `grouping`,
`write`, `publish` or `pipeline`, do not edit config, and do not deploy. This is
evidence gathering only; any repo change is made on the branch here, so the
repo and the box do not drift.

Branch `claude/fritter-post-quality-review-e9ltv5` — nothing on it needs
deploying for this task; production stays on `main` (1258edd).

Context: your edition report (generated 2026-09-22T19:57Z) raised four questions
the report can't answer by itself. Each section below says what we're trying to
learn. Save raw output under a workspace directory, checksum it as usual, and
send the files back. Raw files beat summaries wherever a number matters.

SQL runs as:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -F $'"'"'\t'"'"' -P pager=off' <<'SQL'
-- query here
SQL
```

(Or however you ran the report's queries; tab-separated output is what we want.)

---

## A. The Sep 15–21 outage: what took six hours?

Runs 16–22 each spent 316–391 minutes before prefilter, i.e. inside `collect`
and `preprocess`. A normal full run is 15–18 minutes end to end. The leading
hypothesis is **preprocessor translation**: it splits a batch in half and
retries when a call fails, sequentially and with no circuit breaker, so if the
translation provider times out on every call, a batch of 10 costs 19 calls ×
180 s ≈ 57 minutes. At ~60 batches and concurrency 8 that is 5–7 hours — the
observed figure. We want to confirm or kill that before changing code.

A1. Stage timings for every run in the window:

```sql
SELECT pr.id AS pipeline_run, pr.started_at, pr.status, psr.stage, psr.status AS stage_status,
       psr.started_at AS stage_started, psr.completed_at AS stage_completed,
       round(extract(epoch FROM (psr.completed_at - psr.started_at))/60, 1) AS minutes,
       psr.stage_run_id, left(coalesce(psr.error, psr.gate_reasons, ''), 300) AS note
FROM pipeline_runs pr JOIN pipeline_stage_runs psr ON psr.pipeline_run_id = pr.id
WHERE pr.started_at >= '2026-09-10' ORDER BY pr.id, psr.seq;
```

A2. Translation calls per day — volume, errors, latency. `stage='preprocessor'`
is the translation stage in `generation_logs`:

```sql
SELECT date_trunc('day', created_at AT TIME ZONE 'America/Los_Angeles') AS day,
       model, count(*) AS calls,
       count(*) FILTER (WHERE error IS NOT NULL) AS errors,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
       max(duration_ms) AS max_ms,
       min(created_at) AS first_call, max(created_at) AS last_call
FROM generation_logs
WHERE stage = 'preprocessor' AND created_at >= '2026-09-10'
GROUP BY 1, 2 ORDER BY 1, 2;
```

A3. What the errors said, per day:

```sql
SELECT date_trunc('day', created_at AT TIME ZONE 'America/Los_Angeles') AS day,
       left(error, 120) AS error, count(*)
FROM generation_logs
WHERE stage = 'preprocessor' AND created_at >= '2026-09-10' AND error IS NOT NULL
GROUP BY 1, 2 ORDER BY 1, 3 DESC;
```

A4. Translation fallbacks per preprocessor run (items that fell back to
original-language text):

```sql
SELECT preprocessor_run_id, count(*) AS items,
       count(*) FILTER (WHERE translation_failed) AS translation_failed
FROM preprocessed_items
WHERE preprocessor_run_id IN (
  SELECT preprocessor_run_id FROM pipeline_runs WHERE started_at >= '2026-09-10')
GROUP BY 1 ORDER BY 1;
```

A5. If the collector, not the preprocessor, turns out to be the slow stage in
A1: the collector run rows for those runs (`inspect collector --id <n>` for each)
and anything in the logs showing which feed hung.

A6. **systemd.** The generated unit sets `TimeoutStartSec` at 150 minutes, yet
the runs reached 316–391 minutes and still recorded their own abort — which
suggests systemd killed the `docker compose exec` client and the process inside
the container kept running. Please send:

```bash
systemctl cat fritter-post-pipeline.service
systemctl show fritter-post-pipeline.service -p TimeoutStartUSec -p Result -p ExecMainStatus
journalctl -u fritter-post-pipeline.service --since 2026-09-14 --until 2026-09-23 --no-pager
```

A7. **What changed on Sep 22?** Run 23 finished in 18.6 minutes. Did anyone
(you, the reader, anything automated) restart the container, change `.env`,
rotate a key, or touch the provider between Sep 21 and Sep 22? The report
mentions a "separate credential refresh" — which credential, and when exactly
(UTC)? `docker inspect fritter-post-app-1 --format '{{.State.StartedAt}}'` too.

## B. Sep 12: the embedding 400

Run 13 failed at grouping: `Embed call failed: 400 [`. The error is truncated in
the report. We want the full provider response and what was sent.

```sql
SELECT * FROM grouping_runs WHERE id = 72;
SELECT id, created_at, model, duration_ms, error, length(user_prompt) AS prompt_chars, left(user_prompt, 500)
FROM generation_logs
WHERE created_at BETWEEN '2026-09-12' AND '2026-09-13' AND error IS NOT NULL
ORDER BY created_at;
```

Also the console/journal output for that run if it still exists. If the error
names an input index, the corresponding item's title, body length, and whether
its text is empty or unusual.

## C. Repeated stories — the main question

The paper's continuity markers are working as designed, and that design is the
problem: the judge is told that "a second report on one event still continues
it", so the same news published a day later by a different outlet gets a
"previously" line and runs again. From the headlines alone we count roughly 60
of the 257 links as the same news with nothing new (AfD's 43.8% result ran Sep
7, 8 and 10; LG TVs Sep 7, 8, 9; Australia's algorithm-feed law Sep 6, 7, 8;
Canada's counter-tariffs Sep 8, 9, 10). We want to measure that properly before
changing anything.

C1. Every link, with both texts — **full bodies**, not excerpts (these are our
own pieces, not third-party text):

```sql
SELECT p.published_on, pp.rank, pp.section_rank, pp.tier, pp.ref, pp.headline, pp.body,
       l.prior_published_on, l.prior_ref, l.prior_headline, prior.body AS prior_body,
       l.similarity, l.judge_reason
FROM paper_piece_lineage l
JOIN paper_pieces pp ON pp.id = l.paper_piece_id
JOIN papers p ON p.id = l.paper_id
LEFT JOIN paper_pieces prior ON prior.id = l.prior_paper_piece_id
WHERE p.id BETWEEN 33 AND 42
ORDER BY p.published_on, pp.rank, pp.section_rank;
```

C2. The judge's full input and output for each paper, so we can see the pairs
it said **NO** to as well — some reruns went unlinked (Imelda Marcos acquitted,
Sep 9 and 11; China's 99% duty on a Japanese chip chemical, Sep 7 and 8):

```sql
SELECT id, created_at, stage_run_id, model, user_prompt, response_text, error
FROM generation_logs WHERE stage = 'lineage' AND created_at >= '2026-09-05'
ORDER BY created_at;
```

C3. For the linked pairs, where today's material came from: for each piece in
C1, its `paper_sources` rows (outlet, URL) joined to `preprocessed_items` for
`published_at` and the `raw_items` `fetched_at`. The question is whether the
repeat is a *different outlet reporting late*, the *same outlet re-publishing*,
or a *weekly/analysis source* whose item is days old when collected.

## D. Two broken section leads

D1. **Sep 8 rank 2, `S77154`** — a feature lead published with the headline
"Source material for Ukraine section does not contain reporting on the
conflict". Its source is La Nación. We want the packet and the text behind it:

```bash
docker compose exec -T app npm run inspect -- packet --editor-run <Sep 8 editor run> --rank 2
docker compose exec -T app npm run inspect -- writers --id <Sep 8 writer run> --full   # just the S77154 entry
```

plus the `article_texts` row(s) for its source URL(s): status, char count, the
first 1,500 characters of the extracted text, and the URL itself.

D2. **Sep 8 rank 3** — the "US blockade of Iran" section led with "Somali piracy
returns to decade-high levels". Same `inspect packet --rank 3` output, and each
member's material level. We want to know whether the more central members were
headline-only (so the lead fell through to the one with text) or whether
something else picked it.

## E. Material by tier

The report counts 306 headline-only pieces across ten papers. Split that by
tier and role (lead / sidebar / line / standalone), per paper, and list the
headline-only **features** with their rank and outlet(s).

---

**Report back:** the raw files for A–E, plus a short note of anything that
surprised you. If any query errors on a column name, fix it against the schema
and say what you changed.
