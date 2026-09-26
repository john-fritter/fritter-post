# Gizmo task — nightly encrypted backups of the database to Google Drive

## Why

The Fritter Post database has **no backup**. You found that during the Fritter
Board deploy. The `fritter_post` database, in the `postgres_data` volume, holds:

- every published paper;
- the embeddings that lineage and the rerun check depend on;
- `generation_logs`;
- Fritter Board's `board` schema (members, posts, private messages).

The pipeline can't regenerate any of that. John has chosen **his Google
Drive** (a Google One 100 GB plan) as the off-box destination.

What to build:

1. A nightly `pg_dump` of the whole database, plus the roles and the config
   files you'd need to rebuild the box.
2. **Encryption on the box** before upload, with rclone's `crypt` remote.
   Google stores only ciphertext.
3. Upload to Drive with rclone, using the **`drive.file` scope**, so the token
   can see only the files rclone creates and nothing else in John's Drive.
4. Keep 7 daily, 4 weekly and 6 monthly copies, pruned automatically.
5. **One real restore test** into a scratch database. A dump that has never
   been restored is only assumed to work.

## Must not happen

- **Never restore into, drop or write to `fritter_post`.** The live database
  is only ever read, by `pg_dump`. The restore test goes into a new database,
  `restore_test`, which you drop afterwards.
- **Don't schedule anything near the pipeline,** which starts at 06:00
  America/Los_Angeles and takes about 20 minutes. The backup runs at 10:30 UTC
  (03:30 PDT / 02:30 PST).
- **Don't run pipeline stages,** and don't change either app's code, config or
  containers.
- **Don't use the full `drive` scope.** Use `drive.file` only.
- **Keep secrets out of the report.** That means the encryption passphrases
  and the OAuth token. The passphrases go to John directly (step 3).

## 0. Measure first, and report before building anything

```bash
cd /srv/fritter-post
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size;
  SELECT n.nspname || '"'"'.'"'"'|| c.relname AS rel, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = '"'"'r'"'"' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10;"'
df -h / /var /srv
docker volume inspect $(docker volume ls -q | grep postgres_data) --format '{{.Mountpoint}}'
```

Then take one trial dump, to see its real compressed size:

```bash
mkdir -p /var/backups/fritter && chmod 700 /var/backups/fritter
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > /var/backups/fritter/trial.dump
ls -lh /var/backups/fritter/trial.dump
docker compose exec -T postgres pg_restore --list < /var/backups/fritter/trial.dump | head -5   # proves it's a readable archive
```

Also find the path of the Caddyfile that serves `post.fritter.lol` and
`board.fritter.lol`. You located it during the board deploy.

**The budget.** Planned Drive use is the trial dump size × 17
(7 daily + 4 weekly + 6 monthly). John's 100 GB is shared with his Gmail and
Photos. Ask him how much is free, or read it from `rclone about gdrive:` once
step 2 is done.

- If 17 × dump fits comfortably, meaning under half of the free space, go
  ahead.
- If it doesn't, cut monthly copies to 3. If it still doesn't fit, stop and
  report the numbers.

## 1. Install rclone

Use the official install (`https://rclone.org/install/`), not an old distro
package. Record `rclone version` in your report. The config lives at
`/root/.config/rclone/rclone.conf`, mode 600.

## 2. The Google Drive remote: needs John for one sign-in

```bash
rclone config
```

Create a remote named **`gdrive`**:

- type `drive`;
- **scope `drive.file`**;
- leave client id and secret blank;
- no service account, no shared drive.

When rclone asks "Use web browser to automatically authenticate?", answer
**no**. Rclone then prints an `rclone authorize "drive" "…"` command, and
**John must do the Google sign-in himself.** Help him with whichever way suits
him:

- **On his computer:** install rclone, run the printed `rclone authorize …`
  command, sign in to his Google account in the browser that opens, and paste
  the token it prints back to you.
- **Over SSH:** he forwards port 53682
  (`ssh -L 53682:localhost:53682 <box>`), you run rclone's authorization on the
  box, and he opens the URL it prints in his own browser.

Then check:

```bash
rclone about gdrive:        # quota, if the scope allows it
rclone mkdir gdrive:fritter-backups
rclone lsd gdrive:
```

## 3. The encryption layer

Generate two passphrases and create a crypt remote over that folder:

```bash
P1=$(openssl rand -base64 32 | tr -d '\n'); P2=$(openssl rand -base64 32 | tr -d '\n')
rclone config create fritter-crypt crypt remote=gdrive:fritter-backups \
  filename_encryption=standard directory_name_encryption=true \
  password="$P1" password2="$P2" --obscure
( umask 077; printf 'Fritter backups (rclone crypt remote over gdrive:fritter-backups)\npassword:  %s\npassword2: %s\n' "$P1" "$P2" > /root/fritter-backup-keys.txt )
```

**Tell John to copy both passphrases into his password manager now.** If the
box dies, the backups are unreadable without them. The copy on the box goes
down with the box, so his copy is the one that counts. Don't put them in the
report.

## 4. The backup script

Install this as `/usr/local/bin/fritter-backup` (owner root, mode 700).
Substitute `CADDYFILE` with the real path from step 0.

```bash
#!/usr/bin/env bash
# Nightly backup of the fritter_post database (Fritter Post + Fritter Board).
# Dumps, encrypts via the rclone crypt remote, uploads, prunes. Read-only
# against the live database.
set -euo pipefail
umask 077

POST_DIR=/srv/fritter-post
CADDYFILE=/path/to/Caddyfile                 # <- substitute
LOCAL=/var/backups/fritter
REMOTE=fritter-crypt:
DAY=$(TZ=America/Los_Angeles date +%Y-%m-%d)
DOW=$(TZ=America/Los_Angeles date +%u)       # 7 = Sunday
DOM=$(TZ=America/Los_Angeles date +%d)
OUT="$LOCAL/$DAY"

mkdir -p "$OUT"
cd "$POST_DIR"

# The whole database, custom format (compressed; pg_restore can pick tables).
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$OUT/fritter_post.dump"
# Roles (fritter_post, fritter_board) with their password hashes.
docker compose exec -T postgres sh -c 'pg_dumpall -U "$POSTGRES_USER" --globals-only' \
  > "$OUT/globals.sql"
# What a rebuild needs besides the repos: both .env files and the Caddyfile.
tar -czf "$OUT/config.tar.gz" \
  "$POST_DIR/.env" /srv/fritter-board/.env "$CADDYFILE"

# Refuse to upload a dump pg_restore cannot read.
docker compose exec -T postgres pg_restore --list < "$OUT/fritter_post.dump" > /dev/null

rclone copy "$OUT" "$REMOTE/daily/$DAY"
[ "$DOW" = 7 ]  && rclone copy "$OUT" "$REMOTE/weekly/$DAY"
[ "$DOM" = 01 ] && rclone copy "$OUT" "$REMOTE/monthly/$DAY"

# Retention: 7 daily, 4 weekly, 6 monthly (by upload age).
rclone delete --min-age 7d  "$REMOTE/daily"   && rclone rmdirs --leave-root "$REMOTE/daily"
rclone delete --min-age 29d "$REMOTE/weekly"  && rclone rmdirs --leave-root "$REMOTE/weekly"
rclone delete --min-age 185d "$REMOTE/monthly" && rclone rmdirs --leave-root "$REMOTE/monthly"

# Keep two nights locally for a fast restore; the rest lives on Drive.
find "$LOCAL" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf {} +

date -u +%FT%TZ > "$LOCAL/LAST_OK"
echo "fritter-backup: $DAY ok, $(du -sh "$OUT" | cut -f1)"
```

If step 0 cut the monthly copies to 3, change `185d` to `95d`. The weekly and
monthly copies are full uploads rather than server-side copies. That's
simpler, and costs one extra upload a week.

## 5. Schedule it

`/etc/systemd/system/fritter-backup.service`:

```ini
[Unit]
Description=Nightly backup of the fritter_post database to Google Drive
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/fritter-backup
TimeoutStartSec=2h
```

`/etc/systemd/system/fritter-backup.timer`:

```ini
[Unit]
Description=Nightly fritter_post backup (10:30 UTC, clear of the 06:00 Pacific pipeline)

[Timer]
OnCalendar=*-*-* 10:30:00 UTC
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload
systemctl enable --now fritter-backup.timer
systemctl list-timers fritter-backup.timer
```

## 6. First run, now

```bash
rm -f /var/backups/fritter/trial.dump
systemctl start fritter-backup.service
journalctl -u fritter-backup.service --no-pager -n 30
rclone ls fritter-crypt:daily      # decrypted names: fritter_post.dump, globals.sql, config.tar.gz
rclone ls gdrive:fritter-backups   # what Google sees: encrypted names
```

## 7. Restore test from Drive, into a scratch database

This proves the whole chain: download, decrypt, restore. First check there's
free disk for a second copy of the database (step 0's size, plus headroom).

```bash
DAY=$(TZ=America/Los_Angeles date +%Y-%m-%d)
mkdir -p /var/tmp/restore-test && chmod 700 /var/tmp/restore-test
rclone copy "fritter-crypt:daily/$DAY/fritter_post.dump" /var/tmp/restore-test/
cd /srv/fritter-post
docker compose exec -T postgres sh -c 'createdb -U "$POSTGRES_USER" restore_test'
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d restore_test' \
  < /var/tmp/restore-test/fritter_post.dump; echo "pg_restore exit $?"
```

An error saying schema `public` already exists is expected and harmless: the
new database already has one. Report any other error.

Compare counts between the live database and the restore. Run this once with
`-d "$POSTGRES_DB"` and once with `-d restore_test`:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d restore_test -Atc "
  SELECT (SELECT count(*) FROM papers), (SELECT count(*) FROM paper_pieces),
         (SELECT count(*) FROM item_embeddings), (SELECT count(*) FROM generation_logs),
         (SELECT count(*) FROM board.users), (SELECT count(*) FROM board.posts),
         (SELECT count(*) FROM published.articles)"'
```

The live counts can be slightly higher if something was written since the dump.
Then clean up:

```bash
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" restore_test'
rm -rf /var/tmp/restore-test
```

## Report back

- Step 0: database size, the top tables, disk free, the trial dump size, and
  the retention you chose with the arithmetic behind it.
- `rclone version`, and `rclone about gdrive:` if it works.
- Confirmation that John has the passphrases in his password manager. His
  word, not the passphrases.
- The installed script as installed (with the real Caddyfile path),
  `systemctl list-timers`, the first run's journal lines, and both `rclone ls`
  listings.
- The restore test: `pg_restore`'s exit code and any errors, and the two count
  rows side by side.
- Anything that differed from what this task expected.
