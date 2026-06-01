-- Filter stage tables.
-- filter_runs: one row per filter stage execution.
-- filter_results: per-item keep/drop classification.

CREATE TABLE filter_runs (
  id                   SERIAL       PRIMARY KEY,
  started_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  preprocessor_run_id  INT          NOT NULL,
  model_used           TEXT         NOT NULL,
  items_in             INT          NOT NULL DEFAULT 0,
  items_kept           INT          NOT NULL DEFAULT 0,
  items_dropped        INT          NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE filter_results (
  id                    BIGSERIAL    PRIMARY KEY,
  filter_run_id         INT          NOT NULL REFERENCES filter_runs(id),
  preprocessed_item_id  BIGINT       NOT NULL REFERENCES preprocessed_items(id),
  keep                  BOOLEAN      NOT NULL,
  reason                TEXT         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX filter_results_filter_run_id_idx ON filter_results (filter_run_id);
CREATE INDEX filter_results_item_id_idx       ON filter_results (preprocessed_item_id);
