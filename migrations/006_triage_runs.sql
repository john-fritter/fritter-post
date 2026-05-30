-- One row per triage stage execution.

CREATE TABLE triage_runs (
  id                   SERIAL       PRIMARY KEY,
  started_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  preprocessor_run_id  INT          NOT NULL,
  model_used           TEXT         NOT NULL,
  input_tokens         INT,
  output_tokens        INT,
  duration_ms          INT,
  digest               TEXT,        -- full LLM output, stored verbatim
  generation_log_id    BIGINT       REFERENCES generation_logs(id),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
