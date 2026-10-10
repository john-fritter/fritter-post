# Gizmo task: deploy the run-id flag rename (PR #44)

## What changed

`main` at **`c3b4dd3`** (the merge of PR #44). It follows on from the stage
rename you deployed with migration 048.

The CLI flags that name a stage's run are now `--<stage>-run`:

| now | was |
|---|---|
| `--rank-run` | `--editor-run` |
| `--cluster-run` | `--grouping-run-id` |
| `--score-run` / `--score-runs` | `--grouping-pass1-run` / `--pass1-runs` |
| `--write-run` | `--writer-run` |
| `--preprocess-run` | `--preprocessor-run-id` |
| `--collect-run` | `--collector-run-id` |
| `--novelty-runs` | `--rerun-runs` |

`--pile-id` is unchanged. **The old spellings still work.** They're rewritten
to the new ones before each script reads its arguments
(`src/lib/cli-flags.ts`). Please use the new names from now on.

There is **no migration**, no config change and no prompt change. The pipeline
itself is unaffected: the systemd timer runs `npm run pipeline`, which passes
run ids internally rather than through flags. The tables and columns keep their
old names (`editor_runs`, `grouping_run_id`, …).

## Must not happen

- **Don't deploy between 05:50 and 06:30 America/Los_Angeles.** The timer
  starts the pipeline at 06:00.
- **Don't run `collect`, `preprocess`, `screen`, `cluster`, `score`, `rank`,
  `fetch`, `write` or `publish`.** The checks below either read only or fail
  argument validation before touching the database.
- **Don't edit config or `.env`.**

## Steps

```bash
cd /srv/fritter-post
git fetch origin
git checkout main && git pull
git log --oneline -3                             # expect c3b4dd3 at the top

npm test                                         # from the host checkout; expect 40 of 40

docker compose up -d --build
docker network connect seedbox_default fritter-post-app-1
curl -sS -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/
```

### Check the flags, read-only

Each of these is refused at argument validation, before any database work.
The old and new spellings should print the **same** message:

```bash
docker compose exec -T app npm run write -- --editor-run x     # expect: --rank-run must be a number
docker compose exec -T app npm run write -- --rank-run x       # expect: --rank-run must be a number
docker compose exec -T app npm run publish -- --writer-run x   # expect: --write-run must be a number
docker compose exec -T app npm run publish -- --write-run x    # expect: --write-run must be a number
```

These two read only. Use the latest rank run id from
`npm run inspect -- rank`:

```bash
docker compose exec -T app npm run inspect -- rank
docker compose exec -T app npm run inspect -- materials --rank-run <id>   > /tmp/materials-new.txt
docker compose exec -T app npm run inspect -- materials --editor-run <id> > /tmp/materials-old.txt
diff /tmp/materials-new.txt /tmp/materials-old.txt && echo IDENTICAL
docker compose exec -T app npm run pipeline -- --dry-run
```

## Report back

1. The head commit and the `npm test` result.
2. The site's HTTP status after the rebuild and reconnect.
3. The four validation messages, which should be identical in pairs.
4. Whether the two `materials` outputs were identical.
5. After the next 06:00 run: `npm run inspect -- pipeline --id <that run>`,
   with its status and each gate's verdict. Nothing about the run should differ
   from a normal day, so anything unusual is worth flagging.

Please include the raw output alongside the summary.
