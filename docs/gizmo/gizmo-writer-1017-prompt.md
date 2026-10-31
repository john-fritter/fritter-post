# Gizmo task: writer bake-off for DeepSeek V4.1 Flash 1017 at "xhigh"

**This is a measurement, not a deploy.** Nothing is built, nothing is
restarted, and no config changes. Every command runs through the existing
`fritter-post-app-1` on the code that is already deployed. The only rows written
are new `writer_runs`, `writer_pieces` and `generation_logs` rows. Production
never reads those unless someone publishes them, and nobody will.

**What must not happen.**
- Do not run `publish`, `pipeline`, `collect`, `preprocess`, `screen`,
  `cluster`, `score`, `rank` or `fetch`. **Do not publish any writer run this
  task creates.** Every one of them is a test run.
- Do not edit `config/models.yaml`, `.env` or anything else in
  `/srv/fritter-post`. If the candidate wins, the config change is made on a
  branch here, so the repo and the box don't drift.
- Do not rebuild, restart or `compose up` the stack.
- Do not run anything between 05:45 and 06:45 Pacific (the daily pipeline) or
  around 10:30 UTC (the backup). The whole task takes roughly 1.5 to 2.5 hours
  of wall time, so start it early enough to finish before 05:45 Pacific.

## Background

The writers run `deepseek/deepseek-v4.1-flash` on NanoGPT at
`reasoning_effort: "high"`, `max_tokens: 16000`, `timeout_ms: 300000`, chosen in
three blind bake-offs (`docs/decisions.md`, 2026-09-23 and 2026-09-25).

NanoGPT now serves a dated snapshot, **`deepseek/deepseek-v4.1-flash-1017:thinking`**
(October 17). The reader wants to move the writers to it at
`reasoning_effort: "xhigh"`. Here is what was checked from the dev side
(2026-10-31):

- The id is listed in NanoGPT's `/v1/models`. Its catalogue entry gives
  `reasoning_efforts: none, low, high, max`, so **"xhigh" is not a listed
  level**. A probe call with `"xhigh"` was accepted, and a nonsense value was
  rejected with "Supported values are: none, low, high, max". So "xhigh" is
  either an alias for one of those levels or passed through to the provider. A
  toy prompt could not show which. One job of this task is to find out.
- The snapshot is about 4.5× the per-token price of the current id
  (0.10 / 0.60 against 0.022 / 0.192 USD per million tokens, input / output).
  Both are listed as included in the subscription.
- The catalogue describes the current id, `deepseek/deepseek-v4.1-flash`, as
  "a rate-limited beta … intended for testing rather than production use". The
  1017 snapshot's entry has no such note.

**Why this needs a test and not just a config line.** Round 3 tried the
*previous* Flash at "xhigh" (decisions.md, 2026-09-25). It wrote the cleanest
prose in the set, then lost the rank-2 lead feature to 32,000 tokens of
reasoning with no text. It also took 2,853 s for 32 pieces against 111–123 s at
"high", with seven provider errors. The questions this time:

1. Does the 1017 snapshot at "xhigh" finish every piece, and inside what budget?
2. Is it more accurate than production on attribution (who said what), which is
   what decided every earlier round?
3. What does it cost in wall time? A 150-piece paper has to fit a 90-minute
   pipeline deadline, and the writers are about 4.5 minutes of it today.
4. Is "xhigh" really different from "high" or "max" on this model?

The prose itself is judged on the dev side, blind, against the packets. **You
don't need to judge the writing.** What we need from you is the runs, the
export, and the raw numbers.

## 0. Preconditions

```bash
cd /srv/fritter-post
git log --oneline -1          # expect c3b4dd3 or later (main)
git status --short            # expect clean
docker compose ps             # app and postgres up
```

This task uses the stage-named flags from commit `52618ed` (`--rank-run`). If
the deployed commit is older than that, use `--editor-run` everywhere this task
says `--rank-run`. Nothing else changes.

Workspace:

```bash
OUT=~/fritter-post-audit-2026-10-31/writer-1017
mkdir -p "$OUT"
```

Save every command's output into `$OUT` (use `2>&1 | tee "$OUT/<name>.log"`),
and write `sha256sum` of the files into `$OUT/SHA256SUMS` at the end.

## 1. Pick the input: one rank run, one fixed set of ranks

Use the rank (editor) run behind the **most recent published paper**. That is a
new day of news, which round 3 lacked because it reused editor run 145.

```bash
docker compose exec -T app npm run inspect -- pipeline 2>&1 | tee "$OUT/pipeline.log"
docker compose exec -T app npm run inspect -- publish  2>&1 | tee "$OUT/publish.log"
```

Call that rank run `R`. Then look at its packets:

```bash
docker compose exec -T app npm run inspect -- packet --rank-run R 2>&1 | tee "$OUT/packet-R.log"
```

Choose a `--ranks` spec of **about 30–35 pieces**, matching the earlier rounds.
Start from `1-6,16-25,76-85` and adjust it so the set contains:
- at least 4 features, including one **thread section** (a lead with sidebars
  and lines). A rank is a whole story, so a thread's rank brings its whole
  section. If no thread falls in 1–6, add the highest-ranked thread's rank.
- at least 8 standards;
- at least one full brief batch (10 briefs);
- if one is visible in the packet listing, a story whose sources are mostly
  non-English, and one that swapped tier for lack of material.

Record the final spec as `RANKS` and the per-tier counts it gives. **Every run
below uses the identical `R` and `RANKS`.** That is what makes the export
comparable.

## 2. Smoke test (one feature)

Before spending an hour, confirm the candidate writes at all through our
streaming path at "xhigh":

```bash
docker compose exec -T app npm run write -- --rank-run R --ranks 1 \
  --model deepseek/deepseek-v4.1-flash-1017:thinking --provider nanogpt \
  --reasoning-effort xhigh --max-tokens 48000 --timeout-ms 900000 \
  2>&1 | tee "$OUT/smoke.log"
```

Then check the piece with `npm run inspect -- write --id <run> --full`. Expect
status `ok`, a headline, and a body of feature length. If it fails, errors, or
comes back empty, **stop and send back `smoke.log`** with the
`generation_logs.error` and `output_tokens` of that call. Don't try other
settings. This run is excluded from the export.

## 3. The five runs

Run them **one at a time, in this order**, never concurrently, so the wall times
measure the model and not each other. The order puts the two production runs at
either end, so they also bracket any drift in provider load across the session.

| label | model | effort | max tokens | timeout ms | purpose |
|---|---|---|---|---|---|
| P1 | production (no overrides) | high | 16000 | 300000 | noise control |
| N-high | `deepseek/deepseek-v4.1-flash-1017:thinking` | high | 16000 | 300000 | the snapshot alone, like for like |
| N-xhigh | `deepseek/deepseek-v4.1-flash-1017:thinking` | xhigh | 48000 | 900000 | **the proposal** |
| N-max | `deepseek/deepseek-v4.1-flash-1017:thinking` | max | 48000 | 900000 | tells us what "xhigh" maps to |
| P2 | production (no overrides) | high | 16000 | 300000 | noise control, repeat |

```bash
# P1
docker compose exec -T app npm run write -- --rank-run R --ranks "$RANKS" \
  2>&1 | tee "$OUT/run-P1.log"

# N-high
docker compose exec -T app npm run write -- --rank-run R --ranks "$RANKS" \
  --model deepseek/deepseek-v4.1-flash-1017:thinking --provider nanogpt \
  --reasoning-effort high --max-tokens 16000 --timeout-ms 300000 \
  2>&1 | tee "$OUT/run-N-high.log"

# N-xhigh
docker compose exec -T app npm run write -- --rank-run R --ranks "$RANKS" \
  --model deepseek/deepseek-v4.1-flash-1017:thinking --provider nanogpt \
  --reasoning-effort xhigh --max-tokens 48000 --timeout-ms 900000 \
  2>&1 | tee "$OUT/run-N-xhigh.log"

# N-max
docker compose exec -T app npm run write -- --rank-run R --ranks "$RANKS" \
  --model deepseek/deepseek-v4.1-flash-1017:thinking --provider nanogpt \
  --reasoning-effort max --max-tokens 48000 --timeout-ms 900000 \
  2>&1 | tee "$OUT/run-N-max.log"

# P2
docker compose exec -T app npm run write -- --rank-run R --ranks "$RANKS" \
  2>&1 | tee "$OUT/run-P2.log"
```

(`npm` strips quotes from script args. If the `RANKS` spec has no spaces, as
above, that's harmless. If something goes wrong, run
`./node_modules/.bin/tsx scripts/write.ts …` inside the container instead.)

Each run prints `[write] run #<id>`. **Write the label → run-id → settings
mapping into `$OUT/settings.md` as you go.** This matters because neither
`writer_runs.model_used` nor `generation_logs` records the reasoning effort:
N-high, N-xhigh and N-max all show the same model string, and P1 and P2 are
identical. Without that file the runs can't be told apart afterwards.

If a run's breaker trips (`abort_after_consecutive_failures`), don't repair it
and don't re-run it. Note it, keep going, and report it. A provider that can't
hold up for 30 pieces is a finding.

If N-high and N-xhigh are done and you're short on time before 05:45 Pacific,
skip N-max and say so. Never skip P2.

## 4. The blind export

```bash
docker compose exec -T app npm run writer-bakeoff-export -- \
  --runs <P1>,<N-high>,<N-xhigh>,<N-max>,<P2> --out /tmp/bakeoff-1017 --blind \
  2>&1 | tee "$OUT/export.log"
docker cp fritter-post-app-1:/tmp/bakeoff-1017 "$OUT/bakeoff"
```

This writes `pieces.md` and `packets.md`, which are read blind, and `key.md` and
`summary.md`, which hold the mapping. **Don't put any of the key, the
summary or `settings.md` in your report body**, and don't describe which writer
letter is which. Send those three files separately and label them "key — do not
open until the reading is done".

## 5. Per-call numbers

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -F $'"'"'\t'"'"' -P pager=off' <<'SQL' | tee "$OUT/calls.tsv"
SELECT stage_run_id AS writer_run, stage, count(*) AS calls,
       count(*) FILTER (WHERE error IS NOT NULL) AS errors,
       count(*) FILTER (WHERE coalesce(response_text,'') = '') AS empty,
       sum(output_tokens) AS out_tok,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY output_tokens) AS p50_out,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY output_tokens) AS p95_out,
       max(output_tokens) AS max_out,
       count(*) FILTER (WHERE output_tokens > 16000) AS over_16k,
       count(*) FILTER (WHERE output_tokens > 32000) AS over_32k,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
       max(duration_ms) AS max_ms
FROM generation_logs
WHERE stage LIKE 'write%' AND stage_run_id IN (<P1>,<N-high>,<N-xhigh>,<N-max>,<P2>)
GROUP BY 1, 2 ORDER BY 1, 2;
SQL
```

And every errored or empty call, in full:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -F $'"'"'\t'"'"' -P pager=off' <<'SQL' | tee "$OUT/failed-calls.tsv"
SELECT id, stage_run_id, stage, model, output_tokens, duration_ms, created_at, error,
       left(coalesce(response_text,''), 300) AS response_head
FROM generation_logs
WHERE stage LIKE 'write%' AND stage_run_id IN (<P1>,<N-high>,<N-xhigh>,<N-max>,<P2>)
  AND (error IS NOT NULL OR coalesce(response_text,'') = '')
ORDER BY stage_run_id, id;
SQL
```

Also save `npm run inspect -- write --id <id>` (without `--full`) for each of
the five runs, plus the smoke run.

## 6. Clean up and confirm

Nothing to remove: the export copy inside the container is in `/tmp` and goes
away with the container. Confirm that `/srv/fritter-post` is still clean and on
the same commit as in step 0, that the site answers, and that the latest
published paper is the one from step 1 (no test run got published).

## Send back

1. **Report body** (no key information):
   - the deployed commit, `R`, the final `RANKS` spec and its per-tier counts;
   - for each run *by label*: pieces in / written / failed, failed calls,
     breaker trips, wall seconds (from the run log or `inspect write`);
   - the smoke-test outcome;
   - anything odd: provider errors, broken streams, budget-exhaustion messages,
     a piece that reads like a refusal or a note to the operator.

   Per-run numbers by label are fine in the report: wall time, tokens and
   failures aren't prose, and they're what the cost question needs. Just don't
   mention the writer letters.
2. **Raw files**: `pieces.md`, `packets.md`, `calls.tsv`, `failed-calls.tsv`,
   all the `*.log` files, and `SHA256SUMS`, with the workspace path.
3. **Separately, labelled "key — do not open until the reading is done"**:
   `key.md`, `summary.md`, `settings.md`.
