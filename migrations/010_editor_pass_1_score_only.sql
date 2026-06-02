-- Score-only editor-pass-1: remove bucket columns from stage detail tables.
-- Buckets are gone from the LLM output; assembly now uses score ordering only.
ALTER TABLE editor_pass_1_results
  DROP COLUMN IF EXISTS bucket;

ALTER TABLE editor_pile_items
  DROP COLUMN IF EXISTS bucket;
