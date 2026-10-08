# Gizmo task: deploy the novelty grading, then check the first paper it makes

Branch `ccr-621df9bb-r9xv44`, commit **`7786621`** or later. Production is on
`main` at `ccfdc54`. Migration 047 is **already applied**, from the preview run.

This **deploys the branch** to `/srv/fritter-post`, so the next 06:00 run uses
it. Do the deploy between 07:00 and 05:00 Pacific, and never during the
pipeline (05:45–06:45) or the backup (10:30 UTC). Do not run any pipeline stage
by hand, and do not edit config or `.env`.

## What changes in the paper

The rerun check now grades each story against the paper's last seven editions:

| Grade | What happens |
|---|---|
| new | nothing |
| development | the writer leads on what changed |
| minor update | score −12, at most a standard piece |
| routine | score −20, at most a brief |
| rerun | withheld, as before |

A war section of routine strike reports loses its prominence boost. For a story
the paper ran before, the writer is told yesterday's headline and what is new,
and must lead on what is new. You previewed this on papers #43–53 (rerun runs
53–66).

## 1. Deploy

```bash
cd /srv/fritter-post
git fetch origin ccr-621df9bb-r9xv44
git checkout ccr-621df9bb-r9xv44
git pull --ff-only
git log --oneline -1                     # expect 7786621 or later
docker compose up -d --build
docker network connect seedbox_default fritter-post-app-1   # always: the site 502s without it
docker compose exec -T app npm run migrate                  # expect "No pending migrations."
npm ci && npm test                                          # on the host; expect "All 39 test files passed."
```

Confirm the site answers. Then remove the preview image, which is no longer
needed: `docker image rm fritter-post-novelty:2b6960f`.

## 2. After the next 06:00 run: check the first paper it makes

Run these and save the output under `~/fritter-post-audit-2026-10-01/novelty-live/`:

```bash
docker compose exec -T app npm run inspect -- pipeline --id <today's pipeline run>
docker compose exec -T app npm run inspect -- reruns       # note today's rerun run id
docker compose exec -T app npm run inspect -- reruns --id <today's rerun run id> --all
docker compose exec -T app npm run inspect -- editor --id <today's editor run>
docker compose exec -T app npm run inspect -- publisher --id <today's paper id>
```

Then export today's paper the way you did for papers #43–52, as `paper-<id>-<date>.md`.

Then run two checks on the writing. Use the same tab-separated psql invocation
as in your last audit.

**a. The "what the reader already knows" block reached the writers.** List
every writer call whose prompt carries the block, with the piece it produced:

```sql
SELECT wp.rank, wp.ref, wp.tier, wp.headline, left(wp.body, 300) AS body_start,
       substring(gl.user_prompt from 'WHAT THE READER ALREADY KNOWS(.{0,600})') AS known_block
FROM writer_pieces wp
JOIN generation_logs gl ON gl.id = wp.generation_log_id
WHERE wp.run_id = <today's writer run>
  AND gl.user_prompt LIKE '%WHAT THE READER ALREADY KNOWS%'
ORDER BY wp.rank, wp.ref;
```

Briefs share a batch call. For those, list the batch prompts' `Note: The reader
already knows` lines and the briefs they produced.

**b. No published piece talks about the paper's own coverage.** Count and quote
any body or headline in today's paper matching:

```sql
SELECT pp.rank, pp.ref, pp.headline, pp.body FROM paper_pieces pp
WHERE pp.paper_id = <today's paper id>
  AND (pp.body ~* '(previously reported|already reported|as reported (yesterday|earlier)|earlier coverage|this paper|our earlier|reported yesterday)'
       OR pp.headline ~* '(previously|already reported)');
```

## Send back

- the files from section 2, raw;
- the outputs of queries a and b;
- `inspect pipeline` showing every gate's verdict.

Add a few lines on anything that looks wrong. Do not write a report.

## If it goes badly

If the run fails, or the paper comes out visibly worse (holes, a rank-1 story
that makes no sense, pieces talking about the paper), roll back:

```bash
cd /srv/fritter-post && git checkout main && docker compose up -d --build
docker network connect seedbox_default fritter-post-app-1
```

Then tell us. Migration 047 stays: it is additive, and `main` ignores it.
