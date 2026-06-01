-- Categorizer stage tables and categorized triage run table.

-- One row per categorizer stage execution.
CREATE TABLE categorizer_runs (
  id                   SERIAL       PRIMARY KEY,
  started_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  preprocessor_run_id  INT          NOT NULL,
  model_used           TEXT         NOT NULL,
  items_in             INT          NOT NULL DEFAULT 0,
  items_categorized    INT          NOT NULL DEFAULT 0,
  fallback_count       INT          NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Per-item section assignments from the categorizer.
CREATE TABLE categorizer_results (
  id                    BIGSERIAL    PRIMARY KEY,
  categorizer_run_id    INT          NOT NULL REFERENCES categorizer_runs(id),
  preprocessed_item_id  BIGINT       NOT NULL REFERENCES preprocessed_items(id),
  sections              JSONB        NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX categorizer_results_run_id_idx  ON categorizer_results (categorizer_run_id);
CREATE INDEX categorizer_results_item_id_idx ON categorizer_results (preprocessed_item_id);

-- One row per categorized triage run (parallel path to triage_runs for A/B comparison).
CREATE TABLE categorized_triage_runs (
  id                   SERIAL       PRIMARY KEY,
  started_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  categorizer_run_id   INT          NOT NULL REFERENCES categorizer_runs(id),
  preprocessor_run_id  INT          NOT NULL,
  model_used           TEXT         NOT NULL,
  total_clusters       INT,
  combined_output      JSONB,
  straddle_report      JSONB,
  integrity_flags      JSONB,
  residual_item_ids    JSONB,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX categorized_triage_categorizer_run_id_idx ON categorized_triage_runs (categorizer_run_id);
