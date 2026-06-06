-- Track within-parent outlet deduplication added to the preprocessor stage.

ALTER TABLE preprocessor_runs
  ADD COLUMN items_dropped_parent_dedup INT NOT NULL DEFAULT 0;

ALTER TABLE preprocessed_items
  ADD COLUMN also_appeared_in TEXT;
