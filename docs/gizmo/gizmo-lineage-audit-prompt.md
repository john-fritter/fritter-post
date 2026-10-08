# Gizmo task: audit the papers since the rerun check went live

**This is evidence gathering. Treat it as read-only.** Do not run `collect`,
`preprocess`, `prefilter`, `grouping`, `grouping-pass1`, `editor`, `fetch-text`,
`write`, `publish` or `pipeline`. Do not deploy, do not edit config or `.env`,
and do not restart anything. Section F has the only two commands that write
anything. They write audit rows only (`generation_logs`, plus `rerun_runs` /
`rerun_verdicts`), and production never reads those. Do not run anything
between 05:45 and 06:45 Pacific (the pipeline) or at 10:30 UTC (the backup).
Any repo change comes back here and goes on the branch, so the repo and the box
do not drift.

Save everything under a new workspace directory, for example
`~/fritter-post-audit-2026-10-02/`. Checksum it as usual and send back the
report plus the raw files listed at the end. Where a number matters, send the
raw file rather than a summary of it.

## Why we are doing this

On 2026-09-22 we changed how the paper handles stories it has already printed.
Your Sep 5–22 edition audit found that about one "previously" link in four
was the same news printed again because a different outlet reported it a day
later. AfD's 43.8% result ran on Sep 7, 8 and 10. LG TVs recording audio ran on
Sep 7, 8 and 9. The fixes, deployed that day:

1. **The rerun check** (migration 045), inside `grouping-pass1`. It runs after
   scoring and before threading. Each of the top 250 rows is compared with the
   pieces printed in the last 7 editions. Retrieval takes max-pairwise cosine
   with a floor of 0.74 and keeps the top 2 per row. A GLM 5.2 judge answers
   `RERUN` / `DEVELOPMENT` / `NEW`, and any row with a `RERUN` pair is withheld
   from the pile. It **fails open**: a failed or unreadable verdict keeps the
   row, and the prompt says "when unsure, DEVELOPMENT".
2. **The lineage lookback counts editions, not days.** Paper #42 had zero
   markers because its predecessor was eight days back.
3. **The lineage judge is unchanged**, and the 2026-09-25 model tests left it on
   GLM 5.2. It reads body text (`body_cap` 300), must name something both texts
   say, and **fails closed**: a missing or unreadable verdict means no link.

The 7-day backtest withheld 93 reruns and kept all eight known real
developments. This audit is the first look at the live result. We want to know:

- **Did the restatements go away?** What share of live "previously" links are
  still the same news printed again, compared with the old one in four?
- **Did the rerun check withhold anything it should not have?** This matters
  most. A wrongly dropped story never reaches the reader, and
  `rerun_verdicts` is the only place it can be seen.
- **Is the "previously" marker itself right?** That means false links,
  continuations it missed, and the policy question about broad campaigns
  (below).
- **How good are the papers overall** in this window? This is the first
  stretch since the writer moved to DeepSeek V4.1 Flash at reasoning `high`,
  and since the fetch NUL fix.

After you report back, we will turn your findings into a plan.

## How to run SQL

The same way as the last audit. We want tab-separated output with no pager:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -F $'"'"'\t'"'"' -P pager=off' <<'SQL'
-- query here
SQL
```

If a query errors on a column name, fix it against the schema and say what you
changed. Several joins below are written from the migrations, not from the
live database.

---

## 0. The window and the state of the box

0.1. Run these and save the output:

```bash
cd /srv/fritter-post
git status -sb; git log --oneline -5
docker inspect fritter-post-app-1 --format '{{.State.StartedAt}} {{.Config.Image}}'
docker compose exec -T app sh -c "sed -n '/^rerun:/,/^[a-z]/p' config/models.yaml"
docker compose exec -T app sh -c "grep -n -A40 '  lineage:' config/models.yaml"
systemctl list-timers --all | grep -i fritter
```

0.2. Every paper and pipeline run since Sep 20:

```sql
SELECT pr.id AS pipeline_run, pr.started_at, pr.completed_at, pr.status, pr.started_from,
       pr.stopped_at_stage, left(pr.stopped_reason, 200) AS stopped_reason,
       pr.grouping_pass1_run_id, pr.editor_run_id, pr.writer_run_id, pr.paper_id,
       p.published_on, p.story_count, p.piece_count, p.word_count, p.source_count,
       p.pieces_skipped, p.pieces_unsourced, p.pieces_with_lineage, left(pr.notes, 200) AS notes
FROM pipeline_runs pr LEFT JOIN papers p ON p.id = pr.paper_id
WHERE pr.started_at >= '2026-09-20'
ORDER BY pr.id;
```

0.3. **Define the window W.** It starts with the first paper whose pipeline
run's `grouping-pass1` stage recorded a rerun run:

```sql
SELECT pr.id, pr.paper_id, psr.metrics->>'rerunRunId' AS rerun_run_id, psr.metrics
FROM pipeline_runs pr JOIN pipeline_stage_runs psr ON psr.pipeline_run_id = pr.id
WHERE psr.stage = 'grouping-pass1' AND pr.started_at >= '2026-09-20'
ORDER BY pr.id;
```

We expect W to run from paper #43 (Sep 23) to today's paper. If a paper was
published by a resumed run (`started_from` is not `collect`), follow the lineage
back to the run that did `grouping-pass1`. Use the
`metrics->>'rerunRunId'` values as **the production rerun runs**. Never pick
"the latest rerun run for a pass-1 run": section F adds more of those.

Also name any day in W with **no paper**, and say why.

**The baseline B** is papers #39, #40 and #41 (Sep 11, 13 and 14). That is the
old audit's window, before the rerun check. You will classify it with the same
rubric so the two are directly comparable (section C4).

---

## A. Run health across W

A1. Stage timings, gate verdicts and the metrics each gate read:

```sql
SELECT pr.id AS pipeline_run, psr.seq, psr.stage, psr.status, psr.gate_verdict,
       round(extract(epoch FROM (psr.completed_at - psr.started_at))/60, 1) AS minutes,
       psr.stage_run_id, replace(coalesce(psr.gate_reasons, ''), E'\n', ' | ') AS gate_reasons,
       left(coalesce(psr.error, ''), 300) AS error, psr.metrics
FROM pipeline_runs pr JOIN pipeline_stage_runs psr ON psr.pipeline_run_id = pr.id
WHERE pr.started_at >= '2026-09-22'
ORDER BY pr.id, psr.seq;
```

A2. LLM calls per stage per day, with errors and latency:

```sql
SELECT (created_at AT TIME ZONE 'America/Los_Angeles')::date AS day, stage, model,
       count(*) AS calls, count(*) FILTER (WHERE error IS NOT NULL) AS errors,
       sum(input_tokens) AS in_tok, sum(output_tokens) AS out_tok,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
       max(duration_ms) AS max_ms
FROM generation_logs
WHERE created_at >= '2026-09-22' AND stage NOT IN ('lineage-check')
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

A3. Writer runs in W: `pieces_in`, `pieces_written`, `pieces_failed`, `calls`,
`failed_calls` and tokens. Also say whether the automatic repair pass ran, and
what it recovered.

A4. Fetch: for each run in W, the cooldown host list and `newlyCooled`, from
the fetch-text stage's `metrics`. Then:

```bash
docker compose exec -T app npm run inspect -- fetch --days 10
```

**The Nugget** gets its own line. It returned 429s in run #59 and now often
leads the paper.

---

## B. The rerun check, live

B1. Run totals per day:

```sql
SELECT rr.*, round(extract(epoch FROM (rr.completed_at - rr.started_at)), 1) AS seconds
FROM rerun_runs rr WHERE rr.id IN (<production rerun run ids from 0.3>) ORDER BY rr.id;
```

B2. **Every verdict**, whatever it says, with the pass-1 score of the row.
`row_key` is `C<clusterIndex>` or `S<preprocessedItemId>`. Join it to
`grouping_pass1_results` for that pass-1 run, by whatever key that table
carries (its ref, or item type plus index or id). Fix the join against the
schema.

```sql
SELECT rr.id AS rerun_run, rr.grouping_pass1_run_id, v.row_key, v.row_title,
       v.verdict, v.similarity, v.prior_published_on, v.prior_headline,
       prior.body AS prior_body, v.reason, v.generation_log_id
FROM rerun_verdicts v
JOIN rerun_runs rr ON rr.id = v.rerun_run_id
LEFT JOIN paper_pieces prior ON prior.id = v.prior_paper_piece_id
WHERE rr.id IN (<production rerun run ids>)
ORDER BY rr.id, v.row_key, v.similarity DESC;
```

Then add the row's pass-1 score, its rank by score inside that pass-1 run, and
its source count. Also add the row's own text: the describe-pass title and
summary for a cluster, or the English title and the first 600 characters of
the body for a singleton. **That is the text the judge saw.** Save it as
`B2_verdicts.tsv`.

B3. Also run, for each day, and save:

```bash
docker compose exec -T app npm run inspect -- reruns --id <n> --all
```

B4. **Read every `RERUN` verdict** and classify it. This is the core of the
audit:

- **correct**: nothing of substance the printed piece did not already say.
- **wrong: development**: something happened since. Name the new fact.
- **wrong: two-fact**: the row carries one printed fact and one new one, and
  the judge matched on the printed one. Sep 9 C86 (Houthis *and* Saudi-backed
  airstrikes) is the backtest's example.
- **wrong: different story**: same kind of event, different instance, or
  a shared background fact only.
- **unclear**: say what you would need to decide.

For every **wrong** one, also give the row's pass-1 score, the editor rank it
would roughly have reached (where its score falls in that day's
`editor_stories`), and whether a related piece ran that day anyway. An
eventual section line costs less than a lost feature.

B5. Read the `DEVELOPMENT` verdicts with similarity ≥ 0.85 and spot-check
them. Are any of these plainly reruns the judge let through? Count them, and
quote the five clearest.

B6. The withheld fraction per day against the gate's 0.2. Did the pile come up
short because of withholding? Compare `editor_piles` size with `pile_target`
150.

---

## C. The "previously" marker, live

C1. Every link in W with both full texts. These are our own pieces, not
third-party text, so full bodies are fine:

```sql
SELECT p.id AS paper_id, p.published_on, pp.rank, pp.section_rank, pp.tier, pp.section_role,
       pp.ref, pp.section_ref, pp.headline, pp.body,
       l.prior_published_on, (p.published_on - l.prior_published_on) AS days_back,
       l.prior_ref, l.prior_headline, prior.body AS prior_body,
       l.similarity, l.judge_reason
FROM paper_piece_lineage l
JOIN paper_pieces pp ON pp.id = l.paper_piece_id
JOIN papers p ON p.id = l.paper_id
LEFT JOIN paper_pieces prior ON prior.id = l.prior_paper_piece_id
WHERE p.id IN (<W paper ids>)
ORDER BY p.published_on, pp.rank, pp.section_rank;
```

Run the same query for B (papers 39–41). Save the two outputs as
`C1_links_W.tsv` and `C1_links_B.tsv`.

C2. For each linked piece in C1, list today's sources from `paper_sources`
(outlet, URL, `published_at`) and the prior piece's sources. Restatements were
mostly a different outlet reporting late, so we need to see whether that shape
is still there.

C3. The judge's full input and output, so the **NO** verdicts can be read:

```sql
SELECT id, created_at, stage_run_id AS paper_id, model, user_prompt, response_text, error
FROM generation_logs WHERE stage = 'lineage' AND created_at >= '2026-09-22'
ORDER BY created_at;
```

Parse each into pairs: today's piece, the prior piece, similarity if it
appears in the prompt, the verdict and the reason. Save the result as
`C3_lineage_pairs_W.tsv`.

C4. **Read every link in W, and every link in B**, and classify each one:

- **development**: the same situation, and today's piece reports something
  new. Name it in a few words.
- **restatement**: the same news with nothing of substance new. This is the
  class the rerun check exists to remove.
- **broad campaign**: a separate event inside one ongoing campaign. Examples:
  a different Gaza strike inside one ceasefire, a Kyiv strike on a different
  day, Flock expansion against Flock cancellations. Open item 3b calls this a
  policy question, not a defect. Count it separately and quote each one.
- **false link**: a different situation. That means same kind of event,
  different instance, or the same institution doing an unrelated thing.
- **unclear**.

Report the counts and rates per paper, and in total, for W and for B. The
headline number is **restatements as a share of links, W against B.**

C5. **Trace every restatement in W back through the rerun check.** For each
one, tell us which happened:

- the row was judged and called `DEVELOPMENT` or `NEW`: quote the verdict and
  the reason;
- the row was never offered to the judge: give its pass-1 score rank (was it
  outside the top 250?), and the max-pairwise similarity to the prior piece if
  you can compute it (query in D1). Below 0.74 means the floor missed it;
- the piece came in through a **thread**, and its member row was judged
  separately or not at all;
- something else.

We need this split to know whether to fix the prompt, the floor, the candidate
count or threading.

C6. **Misses.** In C3, list the NO verdicts with similarity ≥ 0.80, and read
them. Which ones are real continuations the marker missed? Also look for any
case where a piece's best candidate was refused and a worse one linked.

C7. Distributions for W, and for B where you have it:
- links per paper, and `pieces_with_lineage` against `piece_count`;
- links by tier and section role;
- the similarity histogram in steps of 0.02 for linked pairs and for judged-NO
  pairs;
- `days_back`, and how often the link skips the immediately previous edition.

C8. **Chains.** Follow `prior_paper_piece_id` back to build each story's run
of consecutive editions. List every chain of 4 or more editions, with the
headline each day. Mark each step development or restatement, using C4. A
story that genuinely moves every day is fine. A chain that is mostly
restatement is the defect showing up at the scale of a week.

C9. **The Flock false link** (open item 3b) is the regression case: `S72939`
on 2026-09-04, linked to `S65838` on 2026-08-28. Has anything shaped like it
appeared in W? That means a link whose reason names a shared identity that one
of the two texts does not state. Quote any you find.

C10. Open a few linked pieces on the live site: `/story/<ref>` for today and
`/article/<writer_piece_id>` for an older one. Confirm the "previously" line
renders under the headline, unlinked, with the right date. A screenshot or the
HTML is fine.

---

## D. Repeats that neither check saw

D1. Embedding sweep over consecutive editions in W. For each pair of
consecutive papers, take each piece's articles through
`paper_sources.preprocessed_item_id` and `item_embeddings`, and compute the
max-pairwise cosine between every piece in paper N and every piece in paper
N−1. Keep pairs ≥ 0.80. This mirrors the lineage retrieval; see
`src/pipeline/lineage/index.ts` near line 151 for the exact form.

```sql
WITH pe AS (
  SELECT ps.paper_id, ps.paper_piece_id, ie.embedding
  FROM paper_sources ps JOIN item_embeddings ie ON ie.preprocessed_item_id = ps.preprocessed_item_id
  WHERE ps.paper_id IN (<W ids, plus the paper before the first>)
)
SELECT t.paper_id, t.paper_piece_id, y.paper_id AS prior_paper_id, y.paper_piece_id AS prior_piece_id,
       max(1 - (t.embedding <=> y.embedding)) AS similarity
FROM pe t JOIN pe y ON y.paper_id = <the edition before t.paper_id>
GROUP BY 1, 2, 3, 4
HAVING max(1 - (t.embedding <=> y.embedding)) >= 0.80;
```

Adapt this so it runs per consecutive pair. It may be easiest to loop over the
pairs in a shell script. Join on headlines, and mark each pair **linked** (it
has a `paper_piece_lineage` row to that prior piece) or **unlinked**.

D2. Read the **unlinked** pairs with similarity ≥ 0.85. These pieces reached
the paper, so the rerun check let them through, and they have no marker.
Classify each one: restatement / development missing its marker / different
story. Quote the restatements in full, both headlines and both first
paragraphs.

D3. **Headline repeats.** Normalize the headlines (lowercase, strip
punctuation) and list any story whose headline in W is near-identical to one
in the previous 7 editions, linked or not. Fuzzy is fine; say how you matched.

---

## E. Overall quality of the papers in W

E1. **Export every paper in W as markdown**, one file per paper, named
`paper-<id>-<date>.md`. For each piece, in rank order with sections nested,
include:
- rank, section rank, tier, role and ref;
- the headline (or `(line)`) and the full body, with word count;
- `material_level`, taken from `writer_pieces` through `writer_piece_id`;
- the "previously" line with its date, similarity and judge reason;
- the source list, as outlet and URL.

**These files matter most to us.** We will read the papers ourselves.

E2. Per paper, per tier and per role (lead, sidebar, line, standalone): piece
count, word count (median, p10, p90), and the count by `material_level`. List
the headline-only **features and standards** with rank and outlet. Open item 2
is about this.

E3. Text scans over every published body and headline in W. For each pattern,
give the count and up to five quoted examples with paper, rank and ref:
- **talking about its own sourcing**: "source material", "the source",
  "sources do not", "not available", "did not specify", "no further details",
  "the report does not", "according to the feed", "cuts off";
- **refusal or operator note** (open item 4): "I can't", "I cannot", "didn't
  come through", "as an AI", a horizontal rule (`---`) inside a body, text
  addressed to an editor or operator;
- **parser leakage**: a body or headline containing `HEADLINE:`, a `;;`
  separator, a ref-shaped token (`\b[CST]\d+\b`), or a code fence;
- **double drafts**: a body that restates its own opening further down;
- **headline problems**: a null headline on a non-line piece, a headline over
  120 characters, or a headline identical to its body's first sentence;
- **untranslated text** in a body, and mojibake (`Ã`, `â€`, U+FFFD);
- **digests or roundups** that made the paper (open item: the junk filter is
  the hard gate);
- **over length**: pieces over their tier's word ceiling. The targets are in
  `writers.packet.tiers` in `models.yaml`.

E4. The front page. For each paper, the top 20 rows: rank, tier, headline,
pass-1 score, `combined`, source count, outlets, and whether it carries a
"previously" line. Then, in your words, what led each day and whether that
looks right for this reader. `docs/bio.md` is the reader.

E5. Sections. For each thread in W, give the title, anchor, member count, and
each member's role and headline. Flag:
- topic bundles, where the anchor is a condition, not a development in a place
  and time;
- duplicated content across pieces in one section;
- **section titles that recur across editions** (open item 3c, the umbrella
  title regenerated daily).

E6. Source mix. Pieces per outlet across W (top 25), outlet share of features,
and how much Oregon or local coverage reached the top 30 each day.

E7. **Your read as a reader.** Read three papers front to back the way the
reader would: the first in W, one from the middle, and the latest. For each,
give the five worst things on it and the three best, with rank and ref. Be
specific and quote. Your impressions are useful here as long as they are
labelled as impressions.

---

## F. Noise controls (these are the only commands that write)

F1. **Lineage judge replay.** This is dry-run and writes `generation_logs` rows
only, with `stage='lineage-check'`:

```bash
docker compose exec -T app npm run lineage-check -- --papers <W ids, comma-separated> --out /tmp/lineage-replay-W.md
docker cp fritter-post-app-1:/tmp/lineage-replay-W.md ~/fritter-post-audit-2026-10-02/
docker cp fritter-post-app-1:/tmp/lineage-replay-W.tsv ~/fritter-post-audit-2026-10-02/
```

Report how many printed links the replay reproduced, dropped or added. Say
whether the added or dropped ones are mostly in your **broad campaign** class.
That would make the policy question the noise source.

F2. **Rerun judge replay** for two days in W: the one with the most drops and
one ordinary day. Run each as-of its own date, against its own pass-1 run:

```bash
docker compose exec -T app npm run rerun-check -- --grouping-pass1-run <n> --as-of <YYYY-MM-DD>
docker compose exec -T app npm run inspect -- reruns --id <new rerun run id> --all
```

Diff the verdicts against the production run for the same pass-1 run. Report
the rows withheld in one run and not the other, with both reasons. The
backtest never had a GLM 5.2 noise control, so this is the first one.

---

## What to send back

**`report.md`**, with these headings:

1. **Summary.** Ten lines at most. The restatement rate in W against B, the
   wrong-drop count, the false-link count, missing papers, and the worst
   quality problem you saw.
2. **Window and box state** (section 0)
3. **Run health** (A)
4. **Rerun check** (B), with B4's table and every wrong drop quoted in full
5. **"Previously" marker** (C), with the C4 counts table for W and B, the C5
   trace table, C6 misses, C8 chains and C9
6. **Unseen repeats** (D)
7. **Paper quality** (E), with E3's pattern table and E7's reading
8. **Noise controls** (F)
9. **What surprised you**, and anything you think we are measuring wrong

**Raw files:** everything under the workspace, at minimum:
- 0.2, 0.3, A1 and A2;
- `B2_verdicts.tsv`, B3's outputs, and `B4_rerun_classified.tsv` (one row per
  `RERUN` verdict, with your class and note);
- `C1_links_W.tsv`, `C1_links_B.tsv`, C2, and `C3_lineage_pairs_W.tsv`;
- `C4_links_classified.tsv`, covering W and B, one row per link, with your
  class and note;
- the D1 pair list, with linked or unlinked and your D2 class;
- the `paper-*.md` exports;
- the F1 replay `.md` and `.tsv`, and the F2 diff;
- the checksums.

Label every classification as **your judgment**, and keep it apart from the
data it rests on. We will re-read a sample of your C4 and B4 calls against the
texts before we act on the rates.
