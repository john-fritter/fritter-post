-- One row per grouping stage execution.
-- Mirrors triage_runs: same digest format, same flat cluster output,
-- so editor-pass-1 and the editor can consume it unchanged.

CREATE TABLE grouping_runs (
  id                   SERIAL       PRIMARY KEY,
  started_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  preprocessor_run_id  INT          NOT NULL,
  model_used           TEXT         NOT NULL,
  input_tokens         INT,
  output_tokens        INT,
  duration_ms          INT,
  digest               TEXT,
  generation_log_id    BIGINT       REFERENCES generation_logs(id),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
