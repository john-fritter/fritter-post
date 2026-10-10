# Operations

How The Fritter Post is deployed and kept running on fritter.lol. For how it
works, see `design.md`.

---

## The box

```
[Caddy on host]  post.fritter.lol
    └── seedbox_default network
            └── fritter-post-app-1:3000        Next.js reading view + the pipeline CLI
                    └── internal network
                            └── postgres:5432   pgvector; no published port
```

The compose stack is self-contained: Postgres and the app are services in one
stack, and Postgres can only be reached from inside it. The app container also
joins the host's `seedbox_default` network so Caddy can reach it by name. That's
the same pattern Fritterflix uses on this host. The Caddy configuration lives
outside this repo.

The production image contains the Next standalone server **and** the pipeline
runtime (`src/`, `scripts/`, `migrations/`, `config/`, `docs/`,
`node_modules`). That's how stages and migrations run inside the app container.
`tests/` is not in the image, so `npm test` runs from the source checkout on the
host.

**Fritter Board** (`/srv/fritter-board`, container `fritter-board-app-1`) shares
this database. It lives in the `board` schema as role `fritter_board` and reads
only the `published` views (migration 046).

---

## Deploying

### First time

```bash
cp .env.example .env
# Set POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD and the provider keys.
# Leave DATABASE_URL commented out: the compose stack builds it.
docker compose up -d --build
docker network connect seedbox_default fritter-post-app-1
docker compose exec -T app npm run migrate
docker compose exec -T app npm run pipeline -- --print-timer --working-dir /srv/fritter-post
# install the printed unit and timer under /etc/systemd/system, then:
systemctl daemon-reload && systemctl enable --now fritter-post-pipeline.timer
```

### Every time

```bash
git pull
docker compose up -d --build
docker network connect seedbox_default fritter-post-app-1
docker compose exec -T app npm run migrate      # when the change carries a migration
```

**Run the third line every time.** The app service declares only the internal
network, and `seedbox_default` is attached by hand. So every `up -d --build`
drops Caddy's route, and the site returns 502 until you reconnect it. This is
the most common way a deploy goes wrong. To check:

```bash
docker inspect fritter-post-app-1 \
  -f '{{range $name,$net := .NetworkSettings.Networks}}{{println $name $net.IPAddress}}{{end}}'
```

After changing `.env` or `config/models.yaml`, recreate the container before
trusting `docker compose exec` to see the new values.

---

## The daily run

A systemd timer runs `docker compose exec -T app npm run pipeline` at 06:00
America/Los_Angeles. A full run takes 15 to 18 minutes. The schedule is set in
`pipeline.schedule` in `config/models.yaml`, and the unit is generated from it
(`--print-timer`). If you change the hour, regenerate the unit. The
timezone-qualified `OnCalendar` needs systemd 252 or newer.

Read a run back:

```bash
docker compose exec -T app npm run inspect -- pipeline          # recent runs and how each ended
docker compose exec -T app npm run inspect -- pipeline --id <n> # run ids, gate verdicts, metrics
docker compose exec -T app npm run inspect -- timing
```

`ok` means every gate passed. `degraded` means a paper was published and at
least one gate warned. `aborted` means a gate stopped the run, and yesterday's
paper stays up. `failed` means a stage threw.

### Recovering

**Re-running from the top is not a retry.** Cross-run dedup means a same-day
full re-run comes back near-empty *by design*. The publisher would then refuse
to replace a good paper with it, or, with `--force`, would replace it. Resume
instead:

```bash
docker compose exec -T app npm run pipeline -- --from <stage>   # inherits the last run's ids
docker compose exec -T app npm run pipeline -- --from write --dry-run
docker compose exec -T app npm run write -- --repair <writer-run-id>
docker compose exec -T app npm run publish -- --write-run <n>
```

The stages are: `collect`, `preprocess`, `screen`, `cluster`, `score`, `rank`,
`fetch`, `write`, `publish`. This is why the generated unit has no
`Restart=on-failure`.

**Testing end to end** on a day the pipeline has already run:
`npm run pipeline -- --skip-cross-run-dedup`. The paper it produces reuses
items that were already published, and the run's notes say so.

---

## Backups

The whole database is dumped every night at 10:30 UTC, well clear of the
pipeline, by `fritter-backup.service`/`.timer` (`/usr/local/bin/fritter-backup`).
The dump is encrypted on the box with an rclone `crypt` remote and uploaded to
John's Google Drive using the `drive.file` scope. It keeps 7 daily, 4 weekly and
6 monthly copies. The roles and the config files needed to rebuild the box go
with it.

After the upload, the same service runs `amcheck` on every B-tree index. A
failed `fritter-backup.service` therefore means either the backup failed or an
index is corrupt, and `journalctl -u fritter-backup.service` says which. A
restore needs the crypt passphrases, which John keeps in a password manager.
The full build and restore-test procedure is in
`gizmo/gizmo-backups-prompt.md`.

**The postgres image is pinned by digest. Upgrading it means a reindex.** A C
library change under the database misorders text indexes, and this cluster
can't warn about it (`datcollversion` is NULL). A new image means: pull,
`REINDEX` every collation-dependent index, then run `amcheck`.
(`decisions.md`, 2026-09-27.)

---

## Gizmo

The production box is operated by **Gizmo**, an agent that runs there.
Development sessions can't reach the box or its database, so anything that has
to touch production is written up as a task file and relayed to Gizmo by John.
Past tasks are in `docs/gizmo/`. Each one states the branch and commit, what
changed, what to run (exact `docker compose exec -T app npm run …` commands),
what must not happen, and what to report back. `CLAUDE.md` has the conventions
for writing them.

### Measuring a change on the box

- **A change to an LLM judgment** (a prompt, the bio) needs a noise control,
  because the model differs from itself between runs. Score the same input
  three times: the existing run, a re-run on the old code, and a run on the new
  code. Old-vs-old is the noise; new-vs-old is the signal. Check the
  `system_prompt` hash in `generation_logs` to prove the prompts really differed.
- **A deterministic change** (a formula, a count) needs no control. Re-run the
  one stage over the same input at both commits and diff the results.
