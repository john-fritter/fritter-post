-- Editor-pass-1 stage tables.
-- editor_pass_1_runs: one row per stage execution.
-- editor_pass_1_results: per-item bucket assignment with full lineage.

CREATE TABLE editor_pass_1_runs (
  id                   SERIAL       PRIMARY KEY,
  started_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  triage_run_id        INT          NOT NULL REFERENCES triage_runs(id),
  model_used           TEXT         NOT NULL,
  items_in             INT          NOT NULL DEFAULT 0,
  items_research       INT          NOT NULL DEFAULT 0,
  items_footer         INT          NOT NULL DEFAULT 0,
  items_cut            INT          NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Bucket values: 'research' | 'footer' | 'cut'
CREATE TABLE editor_pass_1_results (
  id                    BIGSERIAL    PRIMARY KEY,
  run_id                INT          NOT NULL REFERENCES editor_pass_1_runs(id),
  preprocessed_item_id  BIGINT       NOT NULL REFERENCES preprocessed_items(id),
  bucket                TEXT         NOT NULL CHECK (bucket IN ('research', 'footer', 'cut')),
  reason                TEXT         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX editor_pass_1_results_run_id_idx  ON editor_pass_1_results (run_id);
CREATE INDEX editor_pass_1_results_item_id_idx ON editor_pass_1_results (preprocessed_item_id);
CREATE INDEX editor_pass_1_results_bucket_idx  ON editor_pass_1_results (run_id, bucket);
