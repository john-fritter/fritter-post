-- Tracks each invocation of the collector pipeline stage.
-- completed_at NULL means the run is in progress or crashed before finishing.

CREATE TABLE collector_runs (
  id                   SERIAL PRIMARY KEY,
  started_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  source_filter        TEXT,           -- set when run was scoped to one source

  -- Aggregate counters populated on completion.
  sources_attempted    INT NOT NULL DEFAULT 0,
  sources_succeeded    INT NOT NULL DEFAULT 0,
  items_fetched        INT NOT NULL DEFAULT 0,
  items_inserted       INT NOT NULL DEFAULT 0,

  -- Array of per-source result objects:
  -- { source_name, status, items_fetched, items_inserted, error_message?, duration_ms }
  per_source_results   JSONB,

  notes                TEXT
);

CREATE INDEX collector_runs_started_at_idx ON collector_runs (started_at DESC);
