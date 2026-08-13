# Gizmo task: writer materials audit (no pipeline run)

Different shape of task from the last four. **No pipeline run, no migration, no
model calls.** The editor path is done and run #51/#112 is the reference paper;
what I need now is a measurement of the material that paper is made of, before I
build the stage that writes it.

Deploy a branch, run one new read-only inspect command against the editor run
that is already in the database, and report what it says. Plus one small live
probe described in section 3.

## Background — why this measurement

The writers stage needs the actual text of each story's underlying articles. We
have RSS bodies, which run from a full `content:encoded` article to a
two-sentence teaser, and which one you get is a property of the outlet, not of
the story. So some articles need fetching from the publisher, and the fetch
policy — how many URLs, which hosts, how hard to try — cannot be set from
intuition.

New code on the branch resolves each of the 150 ranked stories down to the
articles underneath it (thread → members → clusters → items) and reports how
much body text each carries. That walk is new; nothing before this needed more
than one level of it.

## Deploy

Branch: **`claude/prompt-assembler-writers-r41chi`**

```bash
git fetch origin claude/prompt-assembler-writers-r41chi
git checkout claude/prompt-assembler-writers-r41chi
git pull origin claude/prompt-assembler-writers-r41chi
```

Then the usual: rebuild the app image, recreate the app container, keep
preserving your local deployment edits from the named stash the way you have
been, and keep reporting the Compose dual-network stale-endpoint wart if it
happens again.

Gates before running anything:

- Host typecheck passes.
- **18 test files pass** (was 16; `writer-materials.test.ts` is new, and
  `npm ci` may be needed if `@types/node` is missing).
- `npm run migrate` reports **nothing pending**. There is no migration in this
  branch. If it wants to apply something, stop and tell me.
- Postgres healthy, both networks attached, Caddy upstream 200, public HTTPS 200.

## 1. The audit

```bash
docker compose exec -T app npm run inspect -- materials --editor-run 112 --sources 60
```

Editor run **#112** — the run your last report covered (pile #62, grouping #47).
If for any reason #112 is not the newest editor run, run it for #112 anyway and
tell me what the newest is.

**Paste the entire output verbatim.** Every section: totals, per tier, the body
length distribution, the per-source table, biggest stories, fetch scope with the
host list, and unresolved. It is long; I want all of it. This is the primary
deliverable — everything else in this task is corroboration.

Then say plainly, in your own words:

- What fraction of the paper's articles have a real body versus a teaser?
- Is thinness concentrated in a few outlets, or spread across all of them?
- Does the `UNRESOLVED` section have anything in it? **It should be empty.**
  Anything there means the walk lost material the editor thought it had, and
  it is the most important thing in the report if it happens.

## 2. Corroborate the walk against the database

The audit's numbers come from new code, so check them against SQL rather than
trusting them.

```sql
-- Story counts by tier, and how many are threads/clusters/singletons.
SELECT tier, item_type, count(*)
FROM editor_stories WHERE run_id = 112
GROUP BY 1,2 ORDER BY 1,2;

-- Articles underneath the threads: members, and each member's own source count.
SELECT t.thread_index, t.source_count, count(m.id) AS members,
       sum(m.source_count) AS member_sources
FROM threads t
JOIN thread_members m ON m.thread_id = t.id
JOIN editor_stories es ON es.thread_id = t.id AND es.run_id = 112
GROUP BY 1,2 ORDER BY 1;

-- Body length distribution straight from preprocessed_items, for the items the
-- paper's singleton stories point at. Should line up with the audit's numbers.
SELECT
  count(*) AS singletons,
  count(*) FILTER (WHERE coalesce(length(coalesce(pi.english_body, pi.body_text)), 0) = 0) AS empty,
  count(*) FILTER (WHERE coalesce(length(coalesce(pi.english_body, pi.body_text)), 0) < 800) AS thin,
  percentile_disc(0.5) WITHIN GROUP (
    ORDER BY coalesce(length(coalesce(pi.english_body, pi.body_text)), 0)
  ) AS median_chars
FROM editor_stories es
JOIN preprocessed_items pi ON pi.id = es.preprocessed_item_id
WHERE es.run_id = 112 AND es.item_type = 'singleton';
```

State whether the audit and the SQL agree. If they disagree, the SQL wins and I
need to know where.

## 3. Live probe — will these URLs actually give us text?

The measurement above says how much text we *have*. This says how much we could
*get*. The fetcher does not exist yet, so do this by hand, small and polite.

Take **one canonical URL from each of the 15 sources at the top of the audit's
per-source table** (the thin-first ones — that table is sorted so the fetcher's
worklist is at the top). You can pull them with:

```sql
SELECT DISTINCT ON (pi.source_name) pi.source_name, pi.canonical_url
FROM editor_stories es
JOIN preprocessed_items pi ON pi.id = es.preprocessed_item_id
WHERE es.run_id = 112 AND es.tier IN ('feature','standard')
ORDER BY pi.source_name, pi.id;
```

For each URL, one GET with our honest agent, and — **only on a 403** — one retry
with a browser agent. This mirrors what the collector already does for feeds and
what the fetcher will do for articles.

```bash
curl -sS -o /tmp/probe.html -w '%{http_code} %{content_type} %{size_download}\n' \
  -A 'FritterPost/0.1 (+https://post.fritter.lol)' \
  -H 'Accept: text/html,application/xhtml+xml' \
  --max-time 20 -L "<URL>"
```

Report a table: source, host, status, content-type, bytes, and — where the
status was 200 — a rough sense of whether the HTML looks like a full article or
a paywall/consent wall (a one-line judgment is fine; do not build an extractor).
On any 403, say whether the browser-agent retry got through.

**One request per URL** (plus at most one retry), a second or two between them,
15 URLs total. Do not crawl, do not follow in-page links, do not fetch anything
not on that list. If a host returns 429 or asks you to slow down, stop that host
and note it.

## 4. Retention sanity

The fetcher will store extracted article text, so I need to know what that
costs and how long we keep things today.

```sql
SELECT pg_size_pretty(pg_total_relation_size('raw_items'))        AS raw_items,
       pg_size_pretty(pg_total_relation_size('preprocessed_items')) AS preprocessed,
       pg_size_pretty(pg_total_relation_size('generation_logs'))  AS generation_logs,
       pg_size_pretty(pg_database_size(current_database()))       AS total;

SELECT min(fetched_at)::date AS oldest, max(fetched_at)::date AS newest, count(*)
FROM raw_items;
```

Plus the disk free on the host volume. If anything is close to a limit, say so —
a full-text table is the biggest thing this project will have stored.

## Rules

- **Do not change code, `config/models.yaml`, `config/sources.yaml`,
  `docker-compose.yml`, or Caddy config. Do not merge the branch.**
- No pipeline stages. No LLM calls. Nothing in this task should write a
  `generation_logs` row — if one appears, something ran that should not have.
- Preserve Postgres and its volume. Ask before anything destructive.
- Exact output where I asked for a command or a query. Paste, do not summarize,
  the audit in section 1.
- Report bad news plainly. If the new inspect command errors, paste the stack
  trace and stop — do not work around it.
