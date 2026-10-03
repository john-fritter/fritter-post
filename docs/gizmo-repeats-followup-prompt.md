# Gizmo task: repeats as the reader sees them

**Read-only.** Do not run any pipeline stage, deploy, edit config, or write to
the database. The `rerun-check` and `lineage-check` replays from the last audit
are **not** wanted this time. Do not run anything between 05:45 and 06:45
Pacific or at 10:30 UTC.

Save the output under `~/fritter-post-audit-2026-10-01/followup/`, checksum it,
and send back the files. Run SQL the way you did for the last audit, as
tab-separated output with no pager. If a column name is wrong, fix it against
the schema and say what you changed.

## Why

Your audit reported only about 1.5 repeated stories a day. The reader sees far
more. Their test is different from the one the audit used. The audit asked
whether a piece's **body** contains anything new. The reader asks whether the
**headline** reports news they have not already read. A piece can pass the
first test and fail the second when:

- its sources are follow-ups that recap the original event, and the writer led
  on the recap;
- or it is a daily section on an ongoing war ("Russia and Ukraine trade drone
  strikes", "Iran war disrupts Hormuz") that is technically new every day.

We will do the headline-level read ourselves. We need the papers, and a few
facts about how particular stories got through.

## 1. The papers

Send every `paper-*.md` export you already made, for papers #43–#51. Export
**#52 (2026-10-02)** the same way, and also today's paper if it exists by the
time you run this. Use the same format: rank, section, tier, role, ref,
headline, full body, material level, the "previously" line with its date,
similarity and reason, and the sources with each one's `published_at`.

## 2. Renee Good

Today's paper has "Renee Good's family sues Trump officials and the ICE agent
who shot her" at rank 4. The reader read it yesterday.

a. Every published piece mentioning her since Sep 23:

```sql
SELECT p.id AS paper_id, p.published_on, pp.rank, pp.section_rank, pp.tier, pp.ref, pp.headline,
       left(pp.body, 400) AS body_start, pp.id AS paper_piece_id
FROM paper_pieces pp JOIN papers p ON p.id = pp.paper_id
WHERE p.published_on >= '2026-09-23' AND (pp.headline ILIKE '%Renee Good%' OR pp.body ILIKE '%Renee Good%')
ORDER BY p.published_on, pp.rank;
```

b. What the rerun check said about today's row. Use the rerun run from today's
pipeline run (`pipeline_stage_runs.metrics->>'rerunRunId'` on the
`grouping-pass1` stage):

```sql
SELECT v.row_key, v.row_title, v.verdict, v.similarity, v.prior_published_on,
       v.prior_headline, v.reason
FROM rerun_verdicts v
WHERE v.rerun_run_id = <today's rerun run id>
  AND (v.row_title ILIKE '%Good%' OR v.prior_headline ILIKE '%Renee Good%');
```

If nothing comes back, the row was never offered to the judge. In that case,
give its pass-1 score and rank, and the max-pairwise similarity between its
articles and yesterday's piece (the query from audit section D1).

c. Its lineage row today, if it has one (similarity and judge reason), and its
sources with each one's `published_at`.

## 3. The war sections

For each paper from #43 to today, list every **thread** (section) ranked in the
top 10. Give:
- the paper and rank;
- the thread title and anchor;
- the score, the source count and the editor's combined score, from
  `editor_stories` (show the columns it has);
- the member count;
- the lead piece's headline;
- whether the lead carries a "previously" line.

```sql
SELECT p.id AS paper_id, p.published_on, pp.rank, pp.section_ref, pp.section_title,
       pp.headline AS lead_headline, pp.source_count,
       (SELECT count(*) FROM paper_pieces m WHERE m.paper_id = pp.paper_id AND m.section_ref = pp.section_ref) AS pieces_in_section,
       EXISTS (SELECT 1 FROM paper_piece_lineage l WHERE l.paper_piece_id = pp.id) AS lead_has_previously
FROM paper_pieces pp JOIN papers p ON p.id = pp.paper_id
WHERE p.published_on >= '2026-09-23' AND pp.section_role = 'lead' AND pp.rank <= 10
ORDER BY p.published_on, pp.rank;
```

Then join each row to its `threads` row (title, anchor, score, source_count)
and its `editor_stories` row. Sections are where the war stories live.

## 4. Stale leads

For papers #50, #51 and #52, and for each piece in the top 30 that has a
"previously" line, give its sources' `published_at` and the prior piece's
date. A piece whose sources were all published after the prior piece, but
whose headline describes the prior piece's event, is the shape we are looking
for. List the candidates; we will read them ourselves. No classification is
needed this time.

## Send back

The files, and a few lines on anything odd. Raw output only. Do not write a
report.
