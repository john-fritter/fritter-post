-- The pipeline runner: one row per invocation of the whole pipeline.
--
-- WHY THIS TABLE EXISTS. Every stage already records its own run, and until now
-- that was the only record there was. Reconstructing "how was this morning's
-- paper made" therefore meant joining nine run tables by hand and guessing which
-- rows belonged together, because nothing ever wrote down that they did.
--
-- `inspect timing` is the proof that guessing is not good enough. It infers a
-- lineage by treating any stage whose run predates the newest by more than six
-- hours as belonging to an earlier one -- a heuristic that exists only because
-- the real answer was never recorded, and that discarded run #45's output
-- entirely when a replay from an existing preprocessor run made the inference
-- wrong. A recorded lineage is exact where an inferred one is a guess.
--
-- The second reason is the gates. The runner decides whether the next stage
-- should start by reading the counters the stage just persisted, and that
-- decision is the most interesting thing about an unattended run: it is why the
-- paper is short, or why there is no paper. It has to outlive the console.

CREATE TABLE pipeline_runs (
  id                    SERIAL       PRIMARY KEY,
  started_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,

  -- running  — in flight, or killed before it could finish (see below)
  -- ok       — every stage ran and every gate passed
  -- degraded — reached the end, but at least one gate warned. A paper exists.
  -- aborted  — a gate refused to let the next stage start. Deliberate.
  -- failed   — a stage threw. Not deliberate.
  status                TEXT         NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','ok','degraded','aborted','failed')),

  -- The stage this invocation began at. 'collect' for a full run; anything else
  -- is a resume, which matters when reading the row back: a run that starts at
  -- 'editor' has no collector lineage of its own and inherits one.
  started_from          TEXT         NOT NULL,

  -- Set when the run stopped early. NULL means it reached the end.
  stopped_at_stage      TEXT,
  stopped_reason        TEXT,

  -- The threaded lineage. Nullable throughout: a resumed run fills in only the
  -- stages it actually ran, and inherits the rest from the run it resumed.
  collector_run_id      INT,
  preprocessor_run_id   INT,
  prefilter_run_id      INT,
  grouping_run_id       INT,
  grouping_pass1_run_id INT,
  thread_run_id         INT,
  pile_id               INT,
  editor_run_id         INT,
  writer_run_id         INT,
  paper_id              INT,

  notes                 TEXT
);

CREATE INDEX pipeline_runs_started_at_idx ON pipeline_runs (started_at DESC);

-- One row per stage attempt, written when the stage STARTS and updated when it
-- finishes. That order is deliberate and is the writers' lesson applied to the
-- runner itself: run #29 made 94 calls, 90 of them successful, and persisted
-- zero rows because it held everything in memory until the end and was killed
-- before it got there. A pipeline killed by a systemd timeout must leave behind
-- which stage it died in -- which is exactly the thing nobody can reconstruct
-- afterwards, and exactly what a `status='running'` row with no completed_at
-- says without ambiguity.
CREATE TABLE pipeline_stage_runs (
  id               BIGSERIAL    PRIMARY KEY,
  pipeline_run_id  INT          NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage            TEXT         NOT NULL,
  -- Position in this invocation's order, so a resumed run reads in sequence.
  seq              INT          NOT NULL,
  started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  status           TEXT         NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running','ok','warn','abort','failed','skipped')),

  -- The id of the row this stage wrote in its own run table, which is what makes
  -- the lineage followable: pipeline_stage_runs.stage_run_id + stage names
  -- exactly one row in exactly one of the nine stage tables.
  stage_run_id     INT,

  gate_verdict     TEXT         CHECK (gate_verdict IN ('ok','warn','abort')),
  -- Why the gate said what it said, one reason per line. Prose, because the
  -- reader of this column is a person diagnosing a short paper.
  gate_reasons     TEXT,
  -- The counters the gate read, kept so a threshold can be re-tuned against
  -- history rather than against the next failure.
  metrics          JSONB,
  error            TEXT,

  CONSTRAINT pipeline_stage_runs_seq_unique UNIQUE (pipeline_run_id, seq)
);

CREATE INDEX pipeline_stage_runs_run_idx ON pipeline_stage_runs (pipeline_run_id, seq);
