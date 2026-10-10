# Gizmo task: confirm the list prices, deploy the paper's price (migration 049)

## What changed

Branch `claude/beautiful-shannon-18l0zi` gives every paper a **price**: a boxed
figure in the masthead's top corner, linking to a new page, `/price`, that
breaks it down by pipeline step and by model and explains how the paper is
made.

The price is the paper's model calls at **list prices**: the tokens each call
logged in `generation_logs`, times each model's published API price per million
tokens. It is an estimate, and the page says so. The paper actually runs on a
flat-rate NanoGPT subscription.

- **`config/models.yaml` has a new `pricing:` section** (at the end), one entry
  per model, each with `input_per_mtok`, `output_per_mtok`, `source` (the price
  page) and `as_of`.
- **Migration 049** adds two tables, `paper_steps` and `paper_costs`, holding
  each paper's price frozen at publish. It also adds an index on
  `generation_logs (stage, stage_run_id)`. On a large `generation_logs` that
  index build is the slow part of the migration, so expect it to take a little
  while.
- **The publisher prices every new paper** after continuity, and logs
  `[publisher] price: $X.XX at list prices over N model call(s)`. A pricing
  error only warns; it never stops a paper.
- **`npm run price -- --all`** prices the papers already published. Until it
  runs, the front page shows no price box. Showing no box when a paper has no
  price is by design.
- No prompt text, model, threshold or stage behaviour changed.

## Part 1: confirm the list prices (before deploying)

The build session could not reach the model makers' price pages, so three of
these four prices came from price trackers that quote them. John read the Qwen
price off Alibaba's page himself. Please check all four against the official
pages:

| model ID in config | maker's page | in config now ($ per 1M in / out) |
|---|---|---|
| `zai-org/glm-5.2` and `:thinking` | https://docs.z.ai/guides/overview/pricing | 1.40 / 4.40 |
| `deepseek/deepseek-v4.1-flash` | https://api-docs.deepseek.com/quick_start/pricing | 0.30 / 1.20 |
| `Qwen/Qwen3.6-35B-A3B` | https://www.alibabacloud.com/help/en/model-studio/model-pricing | 0.248 / 1.485 |
| `qwen/qwen3-embedding-8b` | https://openrouter.ai/qwen/qwen3-embedding-8b | 0.01 / — |

**The rule** (it is written at the top of `pricing:` in `models.yaml`):
- Use the **maker's own standard list price**: the uncached input price and the
  output price. Never the cached-input, off-peak or batch rate. DeepSeek has an
  off-peak rate at half price. Use the standard one.
- If a page has tiers by prompt length, use the **lowest tier**. The paper's
  calls are short.
- If a page lists several regions, use the **international** one, not
  mainland China.
- **Qwen3 Embedding 8B is the exception:** use OpenRouter's price, because
  OpenRouter is who serves it to us. On OpenRouter's page, read the
  per-provider table, and report the **provider list** as well as the headline
  price. The headline is the cheapest provider's price, and for another Qwen
  model that was a single host at a fraction of the others' price.

Save each page as text in your workspace (or screenshot it), with the date, and
send the files back.

**If every price matches the config, change nothing** and go to Part 2.

**If a price differs**, update it in the source checkout and commit it to the
branch, so the repo and the box stay the same:

```bash
cd /srv/fritter-post
git fetch origin && git checkout claude/beautiful-shannon-18l0zi && git pull
# edit ONLY the pricing: section of config/models.yaml: the changed
# input_per_mtok / output_per_mtok values, and as_of on every entry you checked
npm test                                  # expect all 41 test files to pass
git diff config/models.yaml               # send this diff back
git commit -am "Pricing: list prices confirmed against the makers' pages"
git push origin claude/beautiful-shannon-18l0zi
```

If you can't push, **stop before deploying** and send back the diff and the
evidence. The change will be made on the branch here.

## Must not happen

- **Don't deploy between 05:50 and 06:30 America/Los_Angeles.** The timer
  starts the pipeline at 06:00.
- **Don't run `collect`, `preprocess`, `screen`, `cluster`, `score`, `rank`,
  `fetch`, `write` or `publish`.** `npm run price` and
  `pipeline -- --dry-run` are the only pipeline commands in this task.
  `price` writes only `paper_steps` and `paper_costs`.
- **Don't edit `.env`, and don't edit any part of `config/models.yaml` other
  than `pricing:`.** Any edit goes through a commit, as above.

## Part 2: deploy

```bash
cd /srv/fritter-post
git fetch origin
git checkout claude/beautiful-shannon-18l0zi && git pull
git log --oneline -4                             # report the head commit

npm test                                         # from the host checkout; expect all 41 test files to pass

docker compose up -d --build
docker network connect seedbox_default fritter-post-app-1
docker compose exec -T app npm run migrate      # applies 049_paper_price.sql only
docker compose exec -T app npm run pipeline -- --dry-run

# Price every paper already published, oldest first. One line per paper.
docker compose exec -T app npm run price -- --all 2>&1 | tee price-backfill.txt

curl -sS -o /dev/null -w '/       %{http_code}\n' https://post.fritter.lol/
curl -sS -o /dev/null -w '/price  %{http_code}\n' https://post.fritter.lol/price
curl -sS https://post.fritter.lol/ | grep -o 'ear-p">[^<]*' | head -1   # the masthead price
```

Then these checks. They read only the new tables and `generation_logs`:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  -- 1. Each paper: price, calls, and anything understated.
  SELECT p.id, p.published_on, round(sum(c.cost_usd), 2) AS usd, sum(c.calls) AS calls,
         sum(c.failed_calls) AS failed, sum(c.calls_without_usage) AS no_usage,
         string_agg(DISTINCT c.model, '"'"', '"'"') FILTER (WHERE c.cost_usd IS NULL) AS unpriced
    FROM papers p LEFT JOIN paper_costs c ON c.paper_id = p.id
   GROUP BY p.id, p.published_on ORDER BY p.published_on DESC LIMIT 15;

  -- 2. The latest paper, step by step.
  SELECT s.step, s.items_out, s.sources, round(s.duration_ms / 60000.0, 1) AS min,
         round(sum(c.cost_usd), 3) AS usd, sum(c.calls) AS calls
    FROM paper_steps s LEFT JOIN paper_costs c ON c.paper_id = s.paper_id AND c.step = s.step
   WHERE s.paper_id = (SELECT id FROM papers ORDER BY published_on DESC, id DESC LIMIT 1)
   GROUP BY s.seq, s.step, s.items_out, s.sources, s.duration_ms ORDER BY s.seq;"'
```

The next check tests whether lineage found every call. For the latest paper's
pipeline run, compare the calls logged during the run's time window with the
calls the price counted. Calls from a stage that ran twice, or from an aborted
attempt, will be in the window but not in the price, which is correct. Anything
else that differs is worth reporting.

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  WITH run AS (
    SELECT r.started_at, COALESCE(r.completed_at, now()) AS ended_at
      FROM pipeline_runs r
     WHERE r.paper_id = (SELECT id FROM papers ORDER BY published_on DESC, id DESC LIMIT 1)
     ORDER BY r.id DESC LIMIT 1)
  SELECT g.stage, count(*) AS logged_in_window,
         sum(coalesce(g.input_tokens, 0) + coalesce(g.output_tokens, 0)) AS tokens
    FROM generation_logs g, run
   WHERE g.created_at BETWEEN run.started_at AND run.ended_at
   GROUP BY g.stage ORDER BY g.stage;
  SELECT step, model, calls, input_tokens + output_tokens AS tokens
    FROM paper_costs
   WHERE paper_id = (SELECT id FROM papers ORDER BY published_on DESC, id DESC LIMIT 1)
   ORDER BY step, model;"'
```

## What to check

1. `npm test`: all 41 test files pass. `tests/paper-price.test.ts` fails if a
   model the pipeline calls has no price.
2. The migration applies 049 only, and `--dry-run` exits without a config
   error. The `pricing:` section is validated when the config loads.
3. `price-backfill.txt` has one line per paper and no errors. Papers from
   before the runner existed (before migration 042) may say `untimed: ...`.
   That is expected. Any `unpriced: ...` is not expected: report it.
4. `/` and `/price` both return 200, and the front page has the price box.
   Please screenshot `/price` on a phone and on a desktop browser if you can.
5. For the latest paper, check 1 shows a price, and check 2 has all nine steps
   with plausible counts. Collect's `items_out` is the articles considered, and
   publish's is the story count.
6. The window comparison: in the window, every stage label is one of
   `preprocess`, `screen`, `cluster`, `score`, `novelty`, `thread`,
   `rank-tie-break`, `write`, `write-briefs`, `continuity`. For each step, the
   calls the price counted are no more than the calls logged in the window.
   Report any label outside that list, and any step where the price counted
   *fewer* calls with no re-run to explain it.

## After the next 06:00 run

```bash
docker compose exec -T app npm run inspect -- pipeline --id <that run>
journalctl -u fritter-post-pipeline.service --since today --no-pager | grep 'publisher\] price'
```

Report: the publisher's `price:` line, `priceUsd` in the publish stage's
metrics, and whether `/price` shows the new date. **The price must never fail
a paper**, so if the run's status is anything other than its usual one, say so.

Please send the raw output files, the price evidence from Part 1 and your
summary, and keep the workspace path.
