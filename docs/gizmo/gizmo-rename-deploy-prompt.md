# Gizmo task: deploy the stage rename (migration 048)

## What changed

Branch `ccr-785664db-kb4wby` (or `main`, once John merges it) renames the
pipeline stages for what they do. **Behaviour is unchanged.** No prompt text
changed, and `config/models.yaml` parses to the same values, only reordered
and with renamed keys.

| now | was |
|---|---|
| `npm run screen` | `npm run prefilter` |
| `npm run cluster` | `npm run grouping` |
| `npm run score` | `npm run grouping-pass1` |
| `npm run rank` | `npm run editor` |
| `npm run fetch` | `npm run fetch-text` |
| `npm run novelty-check` | `npm run rerun-check` |
| `npm run continuity-check` | `npm run lineage-check` |
| `inspect -- collect / preprocess / screen / rank / write / publish / novelty` | `collector / preprocessor / prefilter / editor / writers / publisher / reruns` (the old names still work) |

`collect`, `preprocess`, `write`, `publish`, `pipeline` and `inspect` keep
their names. The runner's stages are now `collect, preprocess, screen, cluster,
score, rank, fetch, write, publish`. **Tables and columns are unchanged**
(`grouping_runs`, `editor_stories`, …). Run-id flags are now `--<stage>-run`
(`--rank-run`, `--write-run`, …), and the old ones (`--editor-run`,
`--writer-run`, …) still work.
`docs/design.md` §6 has the full map.

**Migration 048 is data only.** It rewrites old stage names to the new ones in
`pipeline_runs.started_from`, `pipeline_runs.stopped_at_stage`,
`pipeline_stage_runs.stage` and `generation_logs.stage`. It has to run with
this deploy. The fetch gate reads earlier `pipeline_stage_runs` rows
`WHERE stage = 'fetch'` to build its cooldown baseline, so without the
migration the first week would compare against an empty baseline.

## Must not happen

- **Don't deploy between 05:50 and 06:30 America/Los_Angeles.** The timer
  starts the pipeline at 06:00.
- **Don't run any pipeline stage** other than `pipeline -- --dry-run`. The
  06:00 run is the real test.
- **Don't edit config or `.env`.**

## Steps

```bash
cd /srv/fritter-post
git fetch origin
git checkout ccr-785664db-kb4wby && git pull     # or main, if it has been merged
git log --oneline -4                             # report the head commit

# Before: what the migration will touch
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT stage, count(*) FROM pipeline_stage_runs GROUP BY 1 ORDER BY 1;
  SELECT stage, count(*) FROM generation_logs GROUP BY 1 ORDER BY 1;"'

npm test                                         # from the host checkout; expect 39 of 39

docker compose up -d --build
docker network connect seedbox_default fritter-post-app-1
docker compose exec -T app npm run migrate      # applies 048_stage_renames.sql only

# After
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT stage, count(*) FROM pipeline_stage_runs GROUP BY 1 ORDER BY 1;
  SELECT stage, count(*) FROM generation_logs GROUP BY 1 ORDER BY 1;
  SELECT started_from, stopped_at_stage, count(*) FROM pipeline_runs GROUP BY 1, 2 ORDER BY 1, 2;"'

docker compose exec -T app npm run pipeline -- --dry-run
docker compose exec -T app npm run inspect -- pipeline
docker compose exec -T app npm run inspect -- rank          # was: inspect editor
curl -sS -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/
```

## What to check

1. `npm test`: 39 of 39.
2. Migration: the "after" counts match the "before" counts under the new names
   (`prefilter` → `screen`, `grouping` → `cluster`, `grouping-pass1` → `score`,
   `editor` → `rank`, `fetch-text` → `fetch`; and in `generation_logs`,
   `preprocessor`, `grouping-pass-1`, `rerun`, `editor-tie-break`, `writers`,
   `writers-briefs`, `lineage`, `lineage-check` likewise). No old name
   should remain, and the totals should not change.
3. `--dry-run` prints
   `collect → preprocess → screen → cluster → score → rank → fetch → write → publish`
   and exits without a config error. The config is validated at load, so a
   renamed key that was missed would fail here.
4. The site returns 200 and an article page still shows its "Previously" line
   where it had one.

## After the next 06:00 run

```bash
docker compose exec -T app npm run inspect -- pipeline --id <that run>
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT stage, count(*) FROM generation_logs WHERE created_at > now() - interval '"'"'12 hours'"'"' GROUP BY 1 ORDER BY 1;"'
```

Report: the run's status. Report each stage's gate verdict, and in particular
whether the **fetch** gate names any host as newly in cooldown. A newly named
host could be real, but if it names hosts that have been in cooldown for weeks,
the baseline is broken. Also report the new `generation_logs` stage names
(expect `preprocess`, `screen`, `cluster`, `score`, `novelty`, `thread`,
`rank-tie-break`, `write`, `write-briefs`, `continuity`) and the paper's piece
count compared with recent days.

Please send the raw output files as well as the summary.
