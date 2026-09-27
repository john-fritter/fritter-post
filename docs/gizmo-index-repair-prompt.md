# Gizmo task — repair `raw_items`, pin the postgres image, add a nightly index check

Branch `claude/fritter-board-phase-three-wmh6tj` in `/srv/fritter-post`, at the
commit that adds this file or later. It follows your read-only diagnosis of
2026-09-26 (`fritter-index-diagnosis-20260926`).

## What we know, from your diagnosis

- **One corrupt index out of 110:** `raw_items_source_guid_unique`, with
  `item order invariant violated`.
- **The cause:** the cluster was initialised under `postgres:16-alpine`,
  whose musl libc sorts text by bytes. On June 11 it began running under
  `pgvector/pgvector:pg16`, which is Debian 12 with glibc 2.36 and sorts
  linguistically: punctuation such as `?p=` in the guids is ignored at the
  first comparison level.
  - The index was built under the old order, so glibc now searches the wrong
    part of it.
  - The collector's `ON CONFLICT … DO NOTHING` therefore misses existing rows,
    and the extra copies start on June 11.
  - `datcollversion` is blank because musl reports no collation version, so
    Postgres had nothing to warn with.
- **The damage:** 1,082 duplicate groups, 1,088 extra rows. 521 of them are
  referenced by `preprocessed_items`, and 9 reach a published paper. No other
  unique key has duplicates.
- **Your planner finding matters:** with the default plan, any query can read
  the damaged index and see no duplicates. Everything below that looks for
  duplicates turns index scans off first.

## What this task does

1. Take a fresh backup, and export an audit copy of every row the repair
   touches.
2. In **one transaction:**
   - move each `preprocessed_items.raw_item_id` that points at an extra copy
     to the original (the lowest id with the same key);
   - delete the extra copies;
   - verify, then rebuild the unique index.

   Nothing downstream reads `raw_items` through `raw_item_id`: every
   `preprocessed_items` row carries its own copy of the title, body, URLs and
   times. So re-pointing loses no data. It only states that the two fetches
   were the same feed item, which they were.
3. Rebuild the other nine collation-dependent `public` indexes too.
   `amcheck` passed them, but several predate June 11, and rebuilding them is
   cheap.
4. **Pin the postgres image by digest** (a `docker-compose.yml` change on the
   branch), so its base OS can never change silently again.
5. **Add a nightly integrity check** to the backup script, since Postgres
   can't warn about a collation change on this cluster.
6. Back up and run the restore test again. This time `pg_restore` must exit 0.

## Must not happen

- **Don't work during the pipeline window.** The pipeline timer fires at 13:00
  UTC. Start at least an hour before that, or after the day's run has
  finished, and **stop the timer first** (step 0).
- **Nothing outside this task's own statements.** No `REINDEX DATABASE`, no
  `VACUUM FULL`, and no catalog updates. Don't
  `ALTER DATABASE … REFRESH COLLATION VERSION` either: on a database whose
  `datcollversion` is NULL it errors, and it's not needed.
- **Don't pull a new postgres image.** The pin is the image already running.
  If `docker compose` wants to pull anything, stop and report.
- **Don't rebuild the app, and don't run pipeline stages.**
- **Stop and report if the transaction's numbers look wrong** (step 2). It
  rolls back on its own if any statement fails.

All SQL runs as:

```bash
cd /srv/fritter-post
docker compose exec -T postgres sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
…
SQL
```

Save each step's output to the workspace, as usual.

## 0. Preconditions, and stop the pipeline timer

```bash
cd /srv/fritter-post
date -u
systemctl list-timers fritter-post-pipeline.timer fritter-backup.timer
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, status, started_at FROM pipeline_runs ORDER BY id DESC LIMIT 1"'
systemctl stop fritter-post-pipeline.timer
systemctl list-timers fritter-post-pipeline.timer    # expect it gone from the list
```

If a pipeline run is `running` and started within the hour, wait for it to
finish before stopping the timer. `systemctl stop` doesn't disable the timer,
and step 7 starts it again.

## 1. Fresh backup, the audit export, and pull the branch

```bash
systemctl start fritter-backup.service
systemctl show fritter-backup.service -p Result      # expect Result=success
git fetch origin claude/fritter-board-phase-three-wmh6tj
git pull --ff-only
git log --oneline -1
```

Export exactly what the repair will change, with index scans off, to two CSVs
in the workspace:

```bash
W=/home/seeduser/workspace/fritter-index-repair-$(date -u +%Y%m%d)
mkdir -p "$W"
docker compose exec -T postgres sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$W/extra-raw-items.csv" <<'SQL'
SET enable_indexscan = off; SET enable_indexonlyscan = off; SET enable_bitmapscan = off;
COPY (
  SELECT r.*, d.keep_id
    FROM raw_items r
    JOIN (SELECT source_name, item_guid, min(id) AS keep_id
            FROM raw_items GROUP BY 1, 2 HAVING count(*) > 1) d
   USING (source_name, item_guid)
   WHERE r.id <> d.keep_id
   ORDER BY r.id
) TO STDOUT WITH CSV HEADER;
SQL
docker compose exec -T postgres sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$W/preprocessed-repoint.csv" <<'SQL'
SET enable_indexscan = off; SET enable_indexonlyscan = off; SET enable_bitmapscan = off;
COPY (
  SELECT p.id AS preprocessed_item_id, p.raw_item_id AS old_raw_item_id, d.keep_id AS new_raw_item_id
    FROM preprocessed_items p
    JOIN raw_items r ON r.id = p.raw_item_id
    JOIN (SELECT source_name, item_guid, min(id) AS keep_id
            FROM raw_items GROUP BY 1, 2 HAVING count(*) > 1) d
   USING (source_name, item_guid)
   WHERE r.id <> d.keep_id
   ORDER BY p.id
) TO STDOUT WITH CSV HEADER;
SQL
wc -l "$W"/*.csv      # rows + 1 header: expect ~1,089 and ~522, a little more if the collector ran since
sha256sum "$W"/*.csv > "$W/SHA256SUMS"
```

## 2. The repair: one transaction

```sql
BEGIN;
SET LOCAL enable_indexscan = off;
SET LOCAL enable_indexonlyscan = off;
SET LOCAL enable_bitmapscan = off;

CREATE TEMP TABLE dup_map ON COMMIT DROP AS
  SELECT r.id AS extra_id, d.keep_id
    FROM raw_items r
    JOIN (SELECT source_name, item_guid, min(id) AS keep_id
            FROM raw_items GROUP BY 1, 2 HAVING count(*) > 1) d
   USING (source_name, item_guid)
   WHERE r.id <> d.keep_id;

SELECT count(*) AS extra_rows_to_remove FROM dup_map;

UPDATE preprocessed_items p SET raw_item_id = m.keep_id
  FROM dup_map m WHERE p.raw_item_id = m.extra_id;

DELETE FROM raw_items r USING dup_map m WHERE r.id = m.extra_id;

SELECT count(*) AS duplicate_groups_left
  FROM (SELECT 1 FROM raw_items GROUP BY source_name, item_guid HAVING count(*) > 1) x;
SELECT count(*) AS dangling_preprocessed
  FROM preprocessed_items p LEFT JOIN raw_items r ON r.id = p.raw_item_id WHERE r.id IS NULL;

REINDEX INDEX raw_items_source_guid_unique;
COMMIT;
```

Expected:

- `extra_rows_to_remove` equals the audit CSV's row count.
- `UPDATE` equals the re-point CSV's row count.
- `DELETE` equals `extra_rows_to_remove`.
- `duplicate_groups_left` is 0 and `dangling_preprocessed` is 0.
- `REINDEX` succeeds, which is itself proof that no duplicates remain.

If anything differs, the statement that failed rolls the whole transaction
back. Stop and report.

## 3. Rebuild the other collation-dependent indexes

`CONCURRENTLY` keeps the reading view (`paper_pieces`) and everything else
readable while it runs. Run these as separate statements, not in a
transaction:

```sql
REINDEX INDEX CONCURRENTLY public._migrations_pkey;
REINDEX INDEX CONCURRENTLY public.raw_items_url_idx;
REINDEX INDEX CONCURRENTLY public.raw_items_source_name_idx;
REINDEX INDEX CONCURRENTLY public.idx_preprocessed_items_run_track;
REINDEX INDEX CONCURRENTLY public.preprocessed_items_source_name_idx;
REINDEX INDEX CONCURRENTLY public.generation_logs_stage_created_at_idx;
REINDEX INDEX CONCURRENTLY public.article_texts_url_idx;
REINDEX INDEX CONCURRENTLY public.article_texts_host_idx;
REINDEX INDEX CONCURRENTLY public.paper_pieces_paper_ref_key;
```

The board's indexes were built in September under glibc and don't need this.
If a concurrent rebuild fails, it leaves an invalid `*_ccnew` index behind.
Report it and drop that leftover (`DROP INDEX CONCURRENTLY public.<name>_ccnew`),
never the original.

## 4. Verify

```sql
SET client_min_messages = notice;
DO $$
DECLARE r record; ok int := 0; bad int := 0;
BEGIN
  FOR r IN
    SELECT c.oid, n.nspname, c.relname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_am am ON am.oid = c.relam
     WHERE am.amname = 'btree' AND i.indisvalid AND i.indisready
       AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  LOOP
    BEGIN
      PERFORM bt_index_check(r.oid, true);
      ok := ok + 1;
    EXCEPTION WHEN OTHERS THEN
      bad := bad + 1;
      RAISE NOTICE 'CORRUPT %.%: %', r.nspname, r.relname, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'checked %, corrupt %', ok + bad, bad;
END $$;

-- no invalid leftovers
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;

-- duplicates: both plans must now agree on 0
SELECT count(*) AS dup_groups_default_plan
  FROM (SELECT 1 FROM raw_items GROUP BY source_name, item_guid HAVING count(*) > 1) x;
SET enable_indexscan = off; SET enable_indexonlyscan = off; SET enable_bitmapscan = off;
SELECT count(*) AS dup_groups_heap_scan
  FROM (SELECT 1 FROM raw_items GROUP BY source_name, item_guid HAVING count(*) > 1) x;
```

Expect `checked 110, corrupt 0`, no invalid indexes, and 0 and 0.

## 5. Pin the postgres image (same image, new compose line)

`docker-compose.yml` now names the image by the digest you reported running:
`pgvector/pgvector:pg16@sha256:00ba258a66dac104fd5171074a0084462a64a1369d8513f3d0a634e2f24d15bc`.
That's the image already running, but the image string changed, so Compose
**recreates the postgres container once**. It keeps the same volume and image
ID, with a few seconds of database downtime. The apps reconnect on their own.

```bash
cd /srv/fritter-post
docker compose config | grep -A1 'postgres:' | head -3
docker compose up -d --no-deps postgres        # must NOT pull; stop and report if it does
docker inspect $(docker compose ps -q postgres) --format 'image={{.Image}} started={{.State.StartedAt}}'
# expect image=sha256:be2dedd215733ac25f6d3d2413f5f579f35c82bd659e09ef47fc0f2a4bada0eb
docker compose ps
curl -s -o /dev/null -w 'post %{http_code}\n'  https://post.fritter.lol/
curl -s -o /dev/null -w 'board %{http_code}\n' https://board.fritter.lol/
```

If the app container was recreated too, reconnect it
(`docker network connect seedbox_default fritter-post-app-1`), as always.

## 6. The nightly integrity check, then back up and restore again

`docs/gizmo-backups-prompt.md` step 4 has the updated script. It's the one you
installed, plus an index-integrity block at the end, after the upload. That
block runs the same check as step 4 above and fails the service if any index
is corrupt. Install it as `/usr/local/bin/fritter-backup`, keeping your real
Caddyfile path and any retention change you made. Diff it against the
installed copy and report the diff. Then:

```bash
systemctl start fritter-backup.service
journalctl -u fritter-backup.service --no-pager -n 20   # expect "index integrity ok"
systemctl show fritter-backup.service -p Result         # expect Result=success
```

Repeat the backup task's step 7 restore test on tonight's dump, into
`restore_test`, and add `raw_items` to the count comparison.
**`pg_restore` must now exit 0.** Then drop `restore_test` and remove the
temporary files, as before.

## 7. Restart the pipeline timer

```bash
systemctl start fritter-post-pipeline.timer
systemctl list-timers fritter-post-pipeline.timer fritter-backup.timer
```

## Report back

- Step 0's timers and pipeline row.
- Step 1's backup result, `git log -1`, and the CSV row counts and checksums.
- Step 2's output in full: every count, and each `UPDATE`, `DELETE` and
  `REINDEX` result.
- Steps 3 and 4 in full, with the `checked N, corrupt M` line.
- Step 5's image and start line, `docker compose ps`, and both HTTP codes.
- Step 6: the script diff, the journal lines, the `pg_restore` exit code, and
  the count rows side by side.
- Step 7's timers.
- The workspace path, and anything that differed from what this task expected.
