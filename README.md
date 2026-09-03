# The Fritter Post

A self-hosted personal daily newspaper. Runs on a daily cron, gathers and
synthesizes news from a curated source set, and serves a clean ad-free page
at `post.fritter.lol`.

See `docs/concept.md` for the vision and pipeline architecture.

---

## Development setup

**Prerequisites:** Node 22+, a Postgres instance (local or remote).

```bash
# 1. Install dependencies
npm install

# 2. Set up environment — uncomment and fill in DATABASE_URL for local dev
cp .env.example .env

# 3. Run migrations
npm run migrate

# 4. Start the dev server
npm run dev
```

The app runs at http://localhost:3000.

**Type checking and tests:**
```bash
npm run typecheck
npm test
```

**Pipeline inspection** (requires a running database with data):
```bash
# Outside Docker (needs DATABASE_URL in .env):
npm run inspect -- count
npm run inspect -- list --source "AP Top News" --limit 10

# Inside the compose stack:
docker compose exec app npm run inspect -- count
```

---

## Production setup

The compose stack is self-contained: Postgres and the app run as services in
the same stack. Postgres has no published port and is reachable only within
the stack. The app container joins the external `seedbox_default` network so
Caddy on the host can reach it by container name.

### Architecture

```
[Caddy on host]
    └── seedbox_default network
            └── fritter-post-app-1:3000
                    └── internal network
                            └── postgres:5432 (no published port)
```

Caddy proxies `post.fritter.lol → fritter-post-app-1:3000` via the shared
`seedbox_default` Docker network, which it also joins. This mirrors the
Fritterflix pattern on the same host.

### First-time deployment

```bash
# 1. Clone the repo and set up environment
cp .env.example .env
# Edit .env: set POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD.
# Leave DATABASE_URL commented out — the compose stack builds it automatically.

# 2. Bring up the stack
docker compose up -d --build

# 3. Run migrations inside the app container
docker compose exec app npm run migrate
```

### Ongoing deployments

```bash
git pull
docker compose up -d --build
docker network connect seedbox_default fritter-post-app-1
```

That third line every time. The app service declares only the internal network
and joins `seedbox_default` by hand, so every `up -d --build` drops Caddy's route
and the site 502s until it runs. See below for how to check.

### The daily run

The paper is produced by a systemd timer on the host that runs the whole
pipeline inside the app container:

```bash
docker compose exec -T app npm run pipeline
```

That runs the nine stages in order and evaluates a gate between each pair, so a
stage that fails while exiting 0 stops the run instead of publishing a broken
paper. The schedule lives in `pipeline.schedule` in `config/models.yaml`
(06:00 America/Los_Angeles), and the systemd unit and timer are generated from
it rather than maintained separately:

```bash
docker compose exec -T app npm run pipeline -- --print-timer --working-dir /srv/fritter-post
```

Read a run back with `npm run inspect -- pipeline [--id <n>]`, which shows the
lineage, each gate's verdict and the metrics it read.

**Re-running from the top is not a retry.** Cross-run dedup means a same-day full
re-run comes back near-empty by design, so recovery is `npm run pipeline --
--from <stage>`, which inherits the recorded lineage. This is also why the
generated unit has no `Restart=on-failure`.

### Running CLI scripts on the deployed stack

Migrations, inspection, and the collector run inside the app container where
DATABASE_URL is already set by the compose environment:

```bash
docker compose exec -T app npm run migrate
docker compose exec -T app npm run collect
docker compose exec -T app npm run inspect -- collector
docker compose exec -T app npm run inspect -- list --source "AP Top News"
```

The production image intentionally includes the project CLI runtime
(`scripts/`, `migrations/`, `config/`, `src/`, and `node_modules`) in addition
to the Next standalone server bundle. Do not remove those copies unless
migrations and pipeline stages move to a separate worker image.

After rebuilding/recreating `app`, verify that it is attached to both the
internal project network and `seedbox_default`:

```bash
docker inspect fritter-post-app-1 \
  -f '{{range $name,$net := .NetworkSettings.Networks}}{{println $name $net.IPAddress}}{{end}}'
```

If the app is missing from `seedbox_default`, reconnect it before testing the
public Caddy route:

```bash
docker network connect seedbox_default fritter-post-app-1
```

### Caddy

Caddy runs on the host and is connected to the `seedbox_default` Docker
network. It proxies `post.fritter.lol → fritter-post-app-1:3000` by
container name. The Caddy configuration lives outside this repo.

---

## Project layout

```
src/pipeline/   Nine-stage pipeline (collector → publisher) plus runner/
src/llm/        OpenAI SDK wrapper with logging and budgets
src/db/         Postgres connection pool
src/app/        Next.js App Router — the reading view
src/lib/        Shared utilities
scripts/        CLI tools (migrate, inspect, test, pipeline, one per stage)
migrations/     Numbered SQL migrations
config/         sources.yaml, models.yaml
docs/           concept.md, decisions.md, open-items.md, bio.md, voice.md
```

All nine stages are built and the pipeline runs itself on a daily timer:

```
collector → preprocessor → prefilter → grouping → grouping-pass-1
          → thread → editor → writers → publisher
```

`docs/concept.md` has the vision and what each stage is for; `CLAUDE.md` has the
operational detail and the reasoning behind specific behaviours;
`docs/decisions.md` is the append-only log of why things are the way they are;
`docs/open-items.md` is what is known to be wrong or deferred.
