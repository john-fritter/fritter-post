-- Retire the pile-merge pass. The same-story dedup step between pile assembly
-- and the editor is no longer used; the editor reads the grouping digest path
-- exclusively. Drop the pile-merge run table and the now-unused FK column.
--
-- Order matters: remove the editor_piles column that references pile_merge_runs
-- before dropping the table itself.

-- editor_piles: drop the pile-merge FK column (grouping_run_id and
-- grouping_pass1_run_id remain).
ALTER TABLE editor_piles
  DROP COLUMN IF EXISTS pile_merge_run_id;

-- Drop the pile-merge run table.
DROP TABLE IF EXISTS pile_merge_runs;
