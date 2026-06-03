-- Score-only editor-pass-1: remove bucket-derived columns.
-- Buckets are gone from the LLM output; assembly now uses score ordering only.
ALTER TABLE editor_pass_1_results
  DROP COLUMN IF EXISTS bucket;

ALTER TABLE editor_pass_1_runs
  DROP COLUMN IF EXISTS items_research,
  DROP COLUMN IF EXISTS items_footer,
  DROP COLUMN IF EXISTS items_cut;

ALTER TABLE editor_pile_items
  DROP COLUMN IF EXISTS bucket;
