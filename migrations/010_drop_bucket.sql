-- Drop bucket column from editor_pass_1_results and related index.
-- Test data is throwaway; scoring is the only output of this stage.
DROP INDEX IF EXISTS editor_pass_1_results_bucket_idx;
ALTER TABLE editor_pass_1_results DROP COLUMN bucket;

-- Drop bucket-derived count columns from editor_pass_1_runs.
-- items_in is sufficient; bucket counts were premature aggregation.
ALTER TABLE editor_pass_1_runs
  DROP COLUMN items_research,
  DROP COLUMN items_footer,
  DROP COLUMN items_cut;

-- Drop bucket column from editor_pile_items.
-- The pile cutoff is determined by score sort; "research/footer/cut" has no meaning here.
ALTER TABLE editor_pile_items DROP COLUMN bucket;
