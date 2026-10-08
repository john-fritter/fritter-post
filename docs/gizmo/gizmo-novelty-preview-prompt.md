# Gizmo task: preview the novelty grades on papers #43–52, without deploying

**Do not deploy this branch to `/srv/fritter-post`.** The production checkout and
`fritter-post-app-1` stay on `main`, exactly as they are, because tomorrow's
06:00 run must not use this code until the reader has seen the preview. The task
builds a **separate image** from a separate worktree and runs one-off containers
from it. It applies one additive migration to the database, and every other
write is an audit row that production never reads.

Do not run `collect`, `preprocess`, `prefilter`, `grouping`, `grouping-pass1`,
`editor`, `fetch-text`, `write`, `publish` or `pipeline`. Do not edit config or
`.env`. Do not restart, rebuild or `compose up` the production stack. Do not run
anything between 05:45 and 06:45 Pacific (the pipeline) or at 10:30 UTC (the
backup).

Branch `ccr-621df9bb-r9xv44`, commit **`2b6960f`** or later.

## What changed, and why

The audit you sent (papers #43–51), plus a headline-by-headline reading of
#43–52, found about two repeated stories a day. Six of them were in the top five:
- the US–China trade truce at rank 1 on 9/27, after 9/24 and 9/26;
- OpenAI's training pause at rank 1 on 9/28, after rank 2 on 9/27;
- the Supreme Court's third-country ruling leading on both 9/30 and 10/1;
- Christa Pike's failed execution at rank 2 on 10/1 and again on 10/2;
- Trump rejecting Iran's Hormuz plan at rank 2 on 9/26 and 9/28;
- CNN kept off Air Force One at rank 5 on 9/26 and 9/27.

The rerun check let them through. It kept anything the printed piece had not
said, and a day-later article always adds something. A Russia/Ukraine story also
reached the top ten on nine of ten days.

The check now **grades** each candidate against up to five printed pieces:

| Grade | Effect |
|---|---|
| new | none |
| development | none; the writer leads on what changed |
| minor | score −12 and at most a standard piece |
| routine | score −20 and at most a brief |
| rerun | withheld, as before |

A war section of routine stories loses its prominence boost. The writer is also
told yesterday's headline and what is new. Migration 047 adds `rerun_assessments`
and two columns.

`npm run novelty-preview` grades each past paper as of its own date. It then
re-ranks the day from the stored scores twice, with and without the grades, so
the reader can compare the two front pages. That is what we need from you.

## 1. Build the preview image from a separate worktree

```bash
cd /srv/fritter-post
git fetch origin ccr-621df9bb-r9xv44
git worktree add /srv/fritter-post-novelty origin/ccr-621df9bb-r9xv44
cd /srv/fritter-post-novelty
git log --oneline -1                      # expect 2b6960f or later
docker build -t fritter-post-novelty:2b6960f .
```

Then run the tests on the host, from the worktree (the image has no `tests/`):

```bash
cd /srv/fritter-post-novelty && npm ci && npm test   # expect "All 39 test files passed."
```

## 2. One-off containers on the stack's network

Confirm the compose network name; we expect `fritter-post_internal`:

```bash
docker network ls | grep internal
```

Every command below runs as:

```bash
cd /srv/fritter-post
set -a; . ./.env; set +a
OUT=~/fritter-post-audit-2026-10-01/novelty
mkdir -p "$OUT" && chmod 777 "$OUT"
RUN="docker run --rm --network fritter-post_internal --env-file /srv/fritter-post/.env \
  -e DATABASE_URL=postgresql://$POSTGRES_USER:$POSTGRES_PASSWORD@postgres:5432/$POSTGRES_DB \
  -e NODE_ENV=production -v $OUT:/out fritter-post-novelty:2b6960f"
```

(Use the real network name if it differs.)

## 3. Apply migration 047

```bash
$RUN npm run migrate          # expect "Applying 047_novelty.sql…" and nothing else
```

The migration is additive: one new table and three nullable columns. The
production code on `main` neither reads nor writes any of them. The migration
runner ignores applied names it does not know, so `main`'s next `migrate` is
unaffected.

## 4. Run the preview

```bash
$RUN npm run novelty-preview -- --papers 43-52 --out /out/preview.md 2>&1 | tee "$OUT/preview.log"
```

If paper #53 (Oct 3) exists by then, use `--papers 43-53`. Expect about 2–3
minutes per paper. The script writes `preview.md` and `preview.md.tsv`, and only
`rerun_runs`, `rerun_assessments` and `generation_logs` rows. Note the new rerun
run id it reports for each paper.

## 5. Noise control: grade three papers again

```bash
$RUN npm run novelty-preview -- --papers 50-52 --out /out/preview-repeat.md 2>&1 | tee "$OUT/preview-repeat.log"
```

The judge runs at temperature 0.1, so a grade can flip between runs. Comparing
the two gradings of the same rows tells us how much of any difference is noise.

## 6. Two quick checks

```bash
# Every judge call: count, failures, time
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -F $'"'"'\t'"'"' -P pager=off' <<'SQL'
SELECT date_trunc('minute', created_at) AS minute, count(*) AS calls,
       count(*) FILTER (WHERE error IS NOT NULL) AS errors,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms, max(duration_ms) AS max_ms
FROM generation_logs WHERE stage = 'rerun' AND created_at > now() - interval '6 hours'
GROUP BY 1 ORDER BY 1;
SQL
```

Also save `$RUN npm run inspect -- reruns` (the list of runs) into `$OUT`.

## 7. Clean up

Remove the worktree and leave the image in place, since we may re-run the preview
with different penalties:

```bash
cd /srv/fritter-post && git worktree remove /srv/fritter-post-novelty
```

Confirm `/srv/fritter-post` is still on `main`, clean, and that the site answers.

## Send back

- `preview.md` and `preview.md.tsv`;
- `preview-repeat.md` and `preview-repeat.md.tsv`;
- both `.log` files;
- the output of section 6 and the `inspect reruns` list;
- the `npm test` and `migrate` output.

Send raw output only. **Do not classify or write a report.** We will read the
grades ourselves against the regression list:
- the six top-five repeats above must be withheld or reduced;
- the developments the old check wrongly withheld must come back unreduced
  (Pezeshkian at the UN, the Madrid march, the McLaughlin lawsuit, Malaysia's
  deportations starting);
- routine strike nights must be reduced, while Kyiv's bridges, the winter grid
  plan and the third carrier group must not be.

Add a few lines on anything that broke or looked odd. If any command errors,
stop and send the error rather than working around it.
