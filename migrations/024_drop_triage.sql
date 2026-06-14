-- Retire the LLM-based triage clustering path. The embedding-based grouping
-- path is now the sole clustering system, so the triage-only tables and the
-- now-unused triage_run_id / editor_pass_1_run_id columns are dropped.
--
-- Order matters: remove the columns and tables that reference triage_runs and
-- editor_pass_1_runs before dropping those tables themselves. Kept tables
-- (editor_runs, editor_piles) only lose their triage-path columns; piles now
-- reference a grouping run exclusively.

-- editor_runs: drop the triage FK column (grouping_run_id remains).
ALTER TABLE editor_runs
  DROP COLUMN IF EXISTS triage_run_id;

-- editor_piles: drop the triage-path FK columns (grouping_run_id and
-- grouping_pass1_run_id remain).
ALTER TABLE editor_piles
  DROP COLUMN IF EXISTS triage_run_id,
  DROP COLUMN IF EXISTS editor_pass_1_run_id;

-- Drop the triage-path scoring tables, then the triage runs themselves.
DROP TABLE IF EXISTS editor_pass_1_results;
DROP TABLE IF EXISTS editor_pass_1_runs;
DROP TABLE IF EXISTS triage_runs;
