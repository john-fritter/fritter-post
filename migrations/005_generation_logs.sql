-- Every LLM call in the pipeline gets a row here. Non-negotiable.

CREATE TABLE generation_logs (
  id              BIGSERIAL    PRIMARY KEY,
  stage           TEXT         NOT NULL,   -- 'triage' | 'researcher' | 'editor' | 'writer'
  stage_run_id    INT,
  model           TEXT         NOT NULL,
  system_prompt   TEXT         NOT NULL,
  user_prompt     TEXT         NOT NULL,
  response_text   TEXT,                    -- NULL if the call errored
  input_tokens    INT,
  output_tokens   INT,
  duration_ms     INT          NOT NULL,
  error           TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX generation_logs_stage_created_at_idx ON generation_logs (stage, created_at);
