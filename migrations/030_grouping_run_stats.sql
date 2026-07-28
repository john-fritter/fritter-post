-- Persist grouping's per-pass counters onto the run row.
--
-- These numbers already exist — they are printed to stdout by the attach and
-- split passes — but nothing durable records them, so a report regenerated from
-- the database cannot tell whether a run's grouping is trustworthy. Two of them
-- are load-bearing for exactly that judgment:
--
--   attach_failed_calls  a failed attach call returns an empty set, which is
--                        indistinguishable from the model declining every
--                        candidate. Non-zero means the cluster/singleton split
--                        understates real grouping.
--   split_failed_calls   a failed split call leaves its component intact, so
--                        non-zero means over-merges may have been retained.
--
-- The remaining split_* counters make the pass observable: how many components
-- were dense enough to skip, how many were re-partitioned, how many members were
-- freed back to the singleton pool.
--
-- All nullable: rows written before this migration have no values to backfill,
-- and NULL reads correctly as "not recorded" rather than "zero".

ALTER TABLE grouping_runs
  ADD COLUMN cluster_count            INT,
  ADD COLUMN singleton_count          INT,
  ADD COLUMN attach_calls             INT,
  ADD COLUMN attach_failed_calls      INT,
  ADD COLUMN split_examined           INT,
  ADD COLUMN split_suspect            INT,
  ADD COLUMN split_calls              INT,
  ADD COLUMN split_failed_calls       INT,
  ADD COLUMN split_components_split   INT,
  ADD COLUMN split_freed_singletons   INT;

COMMENT ON COLUMN grouping_runs.attach_failed_calls IS
  'Attach LLM calls that failed after retries. Non-zero means clusters were not offered their candidates and the run should not be used to judge cluster quality.';
COMMENT ON COLUMN grouping_runs.split_failed_calls IS
  'Split LLM calls that failed after retries. Non-zero means those components were left intact and may still be over-merged.';
