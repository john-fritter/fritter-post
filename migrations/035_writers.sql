-- Writers stage: the paper's own prose.
--
-- One row per execution, one row per piece. A piece is the finished article as
-- the reader will see it — the paper's headline and body, written from the
-- assembled packet — and it is the first place in this pipeline where the text
-- belongs to the paper rather than to a publisher.
--
-- LINEAGE. editor_story_id anchors every piece to the ranked story it came
-- from, and from there the existing keys reach the thread, the cluster, the
-- preprocessed items and the raw items. generation_log_id reaches the exact
-- prompt and response that produced it.
--
-- FAILURE IS A ROW, NOT AN EXCEPTION. A writer call that fails leaves a piece
-- with status='failed' and no body, and the run continues. The publisher is
-- designed to render what works and skip what doesn't; one bad call must never
-- cost the whole paper. `detail` says what happened.

CREATE TABLE writer_runs (
  id                SERIAL       PRIMARY KEY,
  started_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  editor_run_id     INT          NOT NULL REFERENCES editor_runs(id),
  model_used        TEXT         NOT NULL,
  pieces_in         INT          NOT NULL DEFAULT 0,
  pieces_written    INT          NOT NULL DEFAULT 0,
  pieces_failed     INT          NOT NULL DEFAULT 0,
  calls             INT          NOT NULL DEFAULT 0,
  -- Non-zero means part of the paper is missing. Same contract as grouping's
  -- failed_calls: a report must be able to say so without reading stdout.
  failed_calls      INT          NOT NULL DEFAULT 0,
  input_tokens      INT,
  output_tokens     INT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE writer_pieces (
  id                BIGSERIAL    PRIMARY KEY,
  run_id            INT          NOT NULL REFERENCES writer_runs(id),
  editor_story_id   BIGINT       REFERENCES editor_stories(id),

  -- Denormalized from the story so the paper can be rendered from this table
  -- alone, and so a piece stays readable if its story row is ever rewritten.
  rank              INT          NOT NULL,
  tier              TEXT         NOT NULL CHECK (tier IN ('feature', 'standard', 'brief', 'cut')),
  ref               TEXT         NOT NULL,

  headline          TEXT,
  body              TEXT,
  word_count        INT          NOT NULL DEFAULT 0,

  -- What the writer had to work with, kept for the feedback loop: a short piece
  -- with headline-only material is correct, and a short piece with full material
  -- is a prompt problem.
  material_level    TEXT         CHECK (material_level IN ('full', 'partial', 'headline-only')),
  source_count      INT          NOT NULL DEFAULT 0,
  articles_used     INT          NOT NULL DEFAULT 0,

  status            TEXT         NOT NULL CHECK (status IN ('ok', 'failed')),
  detail            TEXT,
  generation_log_id BIGINT       REFERENCES generation_logs(id),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX writer_pieces_run_rank_idx ON writer_pieces (run_id, rank);
CREATE INDEX writer_pieces_story_idx    ON writer_pieces (editor_story_id);
