-- Allow editor_runs to reference a grouping run instead of a triage run,
-- mirroring migration 021's change to editor_piles. The editor can now consume
-- grouping-sourced piles (grouping_run_id set, triage_run_id null). Exactly one
-- of the two run ids is set per editor run. Existing triage-based editor runs
-- are unaffected.

ALTER TABLE editor_runs
  ALTER COLUMN triage_run_id DROP NOT NULL;

ALTER TABLE editor_runs
  ADD COLUMN grouping_run_id INT REFERENCES grouping_runs(id);
