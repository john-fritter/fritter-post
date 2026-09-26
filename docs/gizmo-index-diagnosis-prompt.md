# Gizmo task — diagnose the corrupt `raw_items` index (read-only)

## Background

The first backup restore test found a real problem in the live database:

- `pg_restore` could not recreate `raw_items_source_guid_unique`, because the
  live table holds **1,082 duplicate `(source_name, item_guid)` groups**.
- `amcheck` reports an **ordering-invariant violation** in that index.

The index is out of order, and a UNIQUE index that's out of order stops
enforcing uniqueness. Inserts search the wrong part of the tree, so the
collector's `ON CONFLICT (source_name, item_guid) DO NOTHING` misses an
existing row and inserts a second copy.

**Working hypothesis: a collation change.** Text indexes are ordered by the
C library's collation rules. The postgres service uses the floating image tag
`pgvector/pgvector:pg16`, and if a re-pull moved it to a new Debian base
(new glibc), indexes built under the old rules disagree with the new ones.
Postgres 16 records the collation version each database was created with,
which makes this checkable.

**This task is read-only diagnosis.** A repair plan will follow once the
results are in. Run it outside the 05:45–06:45 Pacific pipeline window.

## Must not happen

- **Nothing that writes or changes the database:** no `REINDEX`, `DELETE`,
  `UPDATE`, `ALTER`, `VACUUM FULL`, or
  `ALTER DATABASE … REFRESH COLLATION VERSION`. `amcheck` is already
  installed; don't create or drop extensions.
- **Don't restart, recreate or re-pull the postgres container** or its image.
- **Don't touch the pipeline timer or the apps.**

`bt_index_check` takes only an `AccessShareLock`, the same lock as a `SELECT`,
so it doesn't block the apps or the collector.

All SQL below runs as:

```bash
cd /srv/fritter-post
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
…
SQL
```

## 1. Is it a collation change, and when did it happen?

```bash
cd /srv/fritter-post
docker compose images postgres
docker inspect $(docker compose ps -q postgres) --format 'container created {{.Created}}  image {{.Image}}'
docker image inspect pgvector/pgvector:pg16 --format 'image built {{.Created}}  id {{.Id}}'
docker compose exec -T postgres sh -c 'head -3 /etc/os-release; ldd --version | head -1'
docker compose logs --no-log-prefix postgres 2>&1 | grep -i 'collation version' | head
```

```sql
SELECT datname, datcollate, datcollversion,
       pg_database_collation_actual_version(oid) AS actual_version
  FROM pg_database ORDER BY datname;
```

If `datcollversion` differs from `actual_version`, the hypothesis is
confirmed. Also look in your own notes and shell history for when the
postgres image was last pulled, or the box's OS or Docker was upgraded.

## 2. Which indexes are damaged? Check every B-tree index

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
     ORDER BY pg_relation_size(c.oid)
  LOOP
    BEGIN
      PERFORM bt_index_check(r.oid, true);   -- heapallindexed: every heap row is in the index
      ok := ok + 1;
    EXCEPTION WHEN OTHERS THEN
      bad := bad + 1;
      RAISE NOTICE 'CORRUPT %.%: %', r.nspname, r.relname, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'checked %, corrupt %', ok + bad, bad;
END $$;
```

The larger indexes take a while, because `heapallindexed` reads the whole
table.

Then list every index whose ordering depends on collation, i.e. everything a
collation change can break:

```sql
SELECT i.indexrelid::regclass AS index, i.indisunique AS is_unique,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS size
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
   AND EXISTS (SELECT 1 FROM unnest(i.indcollation) coll WHERE coll <> 0)
 ORDER BY 1::text;
```

## 3. Duplicates behind every text-keyed UNIQUE index

```sql
-- raw_items: the known case
WITH d AS (
  SELECT source_name, item_guid, count(*) AS n, min(id) AS keep_id
    FROM raw_items GROUP BY 1, 2 HAVING count(*) > 1
)
SELECT count(*) AS groups, sum(n - 1) AS extra_rows, max(n) AS worst_group FROM d;

-- when the extra copies were inserted (this dates the start of the problem)
WITH d AS (
  SELECT source_name, item_guid, min(id) AS keep_id
    FROM raw_items GROUP BY 1, 2 HAVING count(*) > 1
)
SELECT date_trunc('day', r.fetched_at)::date AS day, count(*) AS extra_rows
  FROM raw_items r JOIN d USING (source_name, item_guid)
 WHERE r.id <> d.keep_id
 GROUP BY 1 ORDER BY 1;

-- are the extra copies referenced downstream?
WITH d AS (
  SELECT source_name, item_guid, min(id) AS keep_id
    FROM raw_items GROUP BY 1, 2 HAVING count(*) > 1
), extra AS (
  SELECT r.id FROM raw_items r JOIN d USING (source_name, item_guid) WHERE r.id <> d.keep_id
)
SELECT
  (SELECT count(*) FROM extra) AS extra_rows,
  (SELECT count(*) FROM preprocessed_items p JOIN extra e ON e.id = p.raw_item_id) AS referenced_by_preprocessed,
  (SELECT count(*) FROM paper_sources s
     JOIN preprocessed_items p ON p.id = s.preprocessed_item_id
     JOIN extra e ON e.id = p.raw_item_id) AS reached_a_published_paper;

-- the other text-keyed unique indexes
SELECT 'paper_pieces (paper_id, ref)' AS key, count(*) AS dup_groups
  FROM (SELECT 1 FROM paper_pieces GROUP BY paper_id, ref HAVING count(*) > 1) x
UNION ALL
SELECT '_migrations (name)', count(*)
  FROM (SELECT 1 FROM _migrations GROUP BY name HAVING count(*) > 1) x
UNION ALL
SELECT 'board._migrations (name)', count(*)
  FROM (SELECT 1 FROM board._migrations GROUP BY name HAVING count(*) > 1) x;
```

For any other UNIQUE index that step 2 marks corrupt, run the same
`GROUP BY <its columns> HAVING count(*) > 1` count.

## 4. A sample of the duplicates

```sql
WITH d AS (
  SELECT source_name, item_guid FROM raw_items GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 5
)
SELECT r.id, r.source_name, left(r.item_guid, 80) AS guid, r.fetched_at
  FROM raw_items r JOIN d USING (source_name, item_guid)
 ORDER BY r.source_name, r.item_guid, r.id;
```

Include the output as-is. The guid shapes (punctuation, non-ASCII) show
whether a collation change could plausibly have reordered them.

## Report back

- Step 1's output in full: the image and container dates, the OS/glibc lines,
  the `pg_database` rows, any collation-mismatch log lines, and what you know
  about when the image changed.
- Step 2: every `CORRUPT` line, the checked/corrupt totals, and the list of
  collation-dependent indexes.
- Step 3 and step 4's outputs as-is.
- How long step 2 took.
- Raw output files and their workspace path, as usual.
