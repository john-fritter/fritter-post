-- Tie-break call counters on editor_runs.
--
-- The tie-break is the editor's only LLM, and until 2026-08-28 it ran on a raw
-- callLLM with no backoff at concurrency 10. Run #125 lost 12 of its 25 tie
-- groups to single 429s and ranked 60-odd items by ref order instead of by
-- reader relevance -- and nothing in the database said so. The run recorded
-- `model_used = formula:combined-score+tie-rank:<model>`, 150 items in, tier
-- counts out, and looked exactly like a clean run.
--
-- The same argument as migrations 030 and 039: a report regenerated from the
-- database has to be able to judge a run without the console log, because by
-- the time anyone asks the log is gone. failed_calls is the degradation --
-- every item in a failed group falls back to ref order, which is alphabetical
-- and therefore arbitrary, and at a tier boundary that decides whether a story
-- is a feature or a standard.
--
-- NULL means a run before this migration, where the console was the only record.

ALTER TABLE editor_runs
  ADD COLUMN tie_break_calls        INT,
  ADD COLUMN tie_break_failed_calls INT;

COMMENT ON COLUMN editor_runs.tie_break_calls IS
  'Tie groups the run asked the model to order. One call per group.';
COMMENT ON COLUMN editor_runs.tie_break_failed_calls IS
  'Of those, calls that failed after backoff. Every item in a failed group is '
  'ordered by ref instead, so a non-zero value means part of the ranking is '
  'arbitrary. NULL = a run before migration 040.';
