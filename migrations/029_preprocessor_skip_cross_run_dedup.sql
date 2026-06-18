-- Add audit column to record whether a preprocessor run bypassed cross-run dedup.
-- Defaults FALSE so all existing rows are treated as normal (dedup-on) runs.
ALTER TABLE preprocessor_runs
  ADD COLUMN IF NOT EXISTS cross_run_dedup_skipped BOOLEAN NOT NULL DEFAULT FALSE;
