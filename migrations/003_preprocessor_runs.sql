-- Tracks each invocation of the preprocessor pipeline stage.
-- completed_at NULL means in progress or crashed before finishing.

CREATE TABLE preprocessor_runs (
  id                      SERIAL PRIMARY KEY,
  started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at            TIMESTAMPTZ,
  collector_run_id        INT,          -- which collector run this was built from; NULL = latest available

  -- Aggregate counters populated on completion.
  raw_items_considered    INT NOT NULL DEFAULT 0,
  items_kept              INT NOT NULL DEFAULT 0,
  items_dropped_recency   INT NOT NULL DEFAULT 0,
  items_dropped_duplicate INT NOT NULL DEFAULT 0,

  notes                   TEXT
);

CREATE INDEX preprocessor_runs_started_at_idx ON preprocessor_runs (started_at DESC);
