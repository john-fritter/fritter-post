-- Per-round raw output for the multi-round incremental clusterer.
-- triage_runs.digest still holds the final round's text, unchanged.
-- round_digests holds every round's raw emitted text for inspection,
-- e.g. [{"name": "wire", "text": "..."}, {"name": "rest", "text": "..."}].

ALTER TABLE triage_runs
  ADD COLUMN round_digests JSONB;
