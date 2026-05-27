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

# 2. Set up environment
cp .env.example .env
# Edit .env: set DATABASE_URL to point at your Postgres instance.
# The expected database name is fritter_post.

# 3. Run migrations
npm run migrate

# 4. Start the dev server
npm run dev
```

The app runs at http://localhost:3000.

**Type checking:**
```bash
npm run typecheck
```

**Pipeline inspection** (requires a running database with data):
```bash
npm run inspect -- count
npm run inspect -- list --source "AP Top News" --limit 10
```

---

## Production setup

Production runs in Docker behind Caddy on `fritter.lol`. Postgres runs on the
host, not in the compose stack, shared with Fritterflix.

### First-time setup

```bash
# On the host, create the database and user:
psql -U postgres -c "CREATE DATABASE fritter_post;"
psql -U postgres -c "CREATE USER fritter_post WITH PASSWORD 'your-password';"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE fritter_post TO fritter_post;"

# Build and start the container:
docker compose up -d --build

# Run migrations inside the container (or from the host with DATABASE_URL set):
DATABASE_URL=postgresql://fritter_post:your-password@localhost:5432/fritter_post \
  npm run migrate
```

### Ongoing deployments

```bash
git pull
docker compose up -d --build
```

### How the container reaches Postgres

The container uses `host.docker.internal` as the Postgres hostname, which
resolves to the host machine via the `extra_hosts: host-gateway` entry in
`docker-compose.yml`. This is Linux-specific Docker behaviour. On Mac/Windows
Docker Desktop, `host.docker.internal` works without the extra configuration.

See `docs/decisions.md` for the rationale behind this choice.

### Caddy

Caddy runs on the host and proxies `post.fritter.lol → localhost:3000`. The
Caddy configuration lives outside this repo on the host at the standard Caddy
config path.

---

## Project layout

```
src/pipeline/   Seven-stage pipeline (collector → publisher)
src/llm/        OpenAI SDK wrapper with logging and budgets
src/db/         Postgres connection pool
src/app/        Next.js App Router (the reading view)
src/lib/        Shared utilities
scripts/        CLI tools (migrate, inspect)
migrations/     Numbered SQL migrations
config/         sources.yaml, models.yaml
docs/           concept.md, decisions.md, standing-memo.md, …
```
