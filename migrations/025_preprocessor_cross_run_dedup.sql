-- Track cross-run (persistent) deduplication added to the preprocessor stage.
-- A story re-ingested under a new URL/guid in a later run is now suppressed if
-- we already processed it within the configured lookback window. This counts
-- those drops separately from within-run duplicate / parent-dedup drops.

ALTER TABLE preprocessor_runs
  ADD COLUMN items_dropped_cross_run INT NOT NULL DEFAULT 0;
