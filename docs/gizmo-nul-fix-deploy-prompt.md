# Gizmo task — deploy the NUL fix and publish today's paper (2026-09-29)

## Context

Your report on pipeline #30 was right. It stopped in `fetch-text` on
`invalid byte sequence for encoding "UTF8": 0x00`. PostgreSQL TEXT cannot hold
U+0000. A NUL byte in a publisher's HTML survives linkedom, Readability and
html-to-text unchanged (this is now reproduced in a unit test). The upsert that
failed had no error handling, so it took the whole stage down.

The fix is on branch **`ccr-9eedd1ae-6ly7og`**, commit **`26cab8f`**
(`26cab8fa09b32b1e4fb99a5e43b11cc6698ec69c`). That branch is based on `main`
at `6a08e46`, which merged `claude/fritter-board-phase-three-wmh6tj`. Your
checkout is at `3a000f5` on that branch, so the only other new commit is
`dc77e4a`, which changes docs only.

What changed:
- `extractArticle` strips NULs before counting characters.
- `sanitizeArticleTextRow` strips NULs from every TEXT parameter of the
  `article_texts` upsert and recounts `text_chars`. When it removes any, it
  logs `[fetch-text] removed NUL characters from item <id> (<host>): <fields>`.
- If the database still refuses a row, that row costs one article, not the
  stage. The article is logged as `[fetch-text] STORE FAILED item <id> <host> …
  (<url>)`, never with its body. It is counted as `storeFailed` in the stage
  metrics, and the fetch gate warns, so the run is recorded `degraded`.
- No migrations and no config changes.

## Goal

1. Deploy the fix.
2. Resume today's run from `fetch-text`, reusing editor run #150, so today's
   paper gets published.
3. Report back whether the NUL showed up again and which article carried it.

## Steps

All commands run from `/srv/fritter-post`.

1. **Check the working tree is clean, then check out the fix.**
   ```bash
   git status --short
   git fetch origin ccr-9eedd1ae-6ly7og
   git checkout ccr-9eedd1ae-6ly7og
   git log --oneline -3   # HEAD must be 26cab8f
   ```

2. **Run the tests from the host checkout.** They are not in the image.
   ```bash
   npm test
   ```
   Expect `All 39 test files passed.` Stop and report if any fail.

3. **Rebuild the app container and reconnect the network.** Without the
   reconnect, the site returns 502.
   ```bash
   docker compose up -d --build app
   docker network connect seedbox_default fritter-post-app-1
   curl -sS -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/
   ```
   Confirm the container runs the new code:
   ```bash
   docker compose exec -T app grep -c sanitizeArticleTextRow src/pipeline/writers/fetch-text.ts
   ```
   This must print a number of 1 or more.

4. **Dry-run the resume.** It must inherit from pipeline run **#30**, with
   `editor_run_id = 150`.
   ```bash
   docker compose exec -T app npm run pipeline -- --from fetch-text --dry-run
   ```
   If it would inherit from a different run, or from a different editor run,
   **stop and report**. Do not run step 5.

5. **Run the resume.** It should take about 10 minutes.
   ```bash
   docker compose exec -T app npm run pipeline -- --from fetch-text 2>&1 | tee ~/fritter-resume-20260929.log
   ```

## Report back

- The `git log --oneline -1` line and the `npm test` summary line.
- The pipeline run id and final status (`npm run inspect -- pipeline --id <n>`),
  including every gate verdict and reason.
- From the log: every `removed NUL characters` and `STORE FAILED` line,
  verbatim. If there are any, include the item id, host and URL. This tells us
  which article carried the NUL.
- The fetch `done:` summary line.
- `npm run inspect -- publisher` for today: the paper id, piece count,
  `pieces_skipped` and `pieces_unsourced`.
- The saved log path and its checksum.

## Must not happen

- **Do not** run `npm run pipeline` without `--from`. Do not start from
  `collect` either. Cross-run dedup makes a same-day full rerun come back
  near-empty, and it would publish a tiny paper.
- **Do not** pass `--force` to publish.
- **Do not** edit config or source files on the box. If something needs
  changing, report it and the change will be made on the branch.
- **Do not** change the systemd timer. Tomorrow's 06:00 run will use the rebuilt
  container.
