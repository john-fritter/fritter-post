-- Scoring tables for the grouping pipeline path.
-- grouping_pass1_runs: one scoring run per grouping_run.
-- grouping_pass1_results: one scored row per cluster or singleton.
--
-- Also extends editor_piles to support grouping-based piles:
-- triage_run_id and editor_pass_1_run_id become nullable so a pile can
-- reference a grouping run instead. The editor stage reads triage_run_id to
-- fetch cluster metadata; editor support for grouping piles is a follow-on
-- change. Existing triage-based piles are unaffected.

CREATE TABLE grouping_pass1_runs (
  id               SERIAL       PRIMARY KEY,
  started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  grouping_run_id  INT          NOT NULL REFERENCES grouping_runs(id),
  model_used       TEXT         NOT NULL,
  items_in         INT          NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One row per scored item: either a cluster (identified by its 0-based index
-- in the grouping digest) or a singleton (identified by preprocessed_item_id).
-- source_count = number of member items; always 1 for singletons. Carried
-- through to the pile unchanged — the scorer never sees or uses it.
CREATE TABLE grouping_pass1_results (
  id                    BIGSERIAL    PRIMARY KEY,
  run_id                INT          NOT NULL REFERENCES grouping_pass1_runs(id),
  item_type             TEXT         NOT NULL CHECK (item_type IN ('cluster', 'singleton')),
  cluster_index         INT,
  preprocessed_item_id  BIGINT       REFERENCES preprocessed_items(id),
  source_count          INT          NOT NULL DEFAULT 1,
  score                 INT          NOT NULL CHECK (score >= 0 AND score <= 100),
  reason                TEXT         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX grouping_pass1_results_run_score_idx
  ON grouping_pass1_results (run_id, score DESC);

-- Allow editor_piles to reference a grouping run instead of a triage run.
ALTER TABLE editor_piles
  ALTER COLUMN triage_run_id DROP NOT NULL;

ALTER TABLE editor_piles
  ADD COLUMN grouping_run_id INT REFERENCES grouping_runs(id);

ALTER TABLE editor_piles
  ALTER COLUMN editor_pass_1_run_id DROP NOT NULL;

ALTER TABLE editor_piles
  ADD COLUMN grouping_pass1_run_id INT REFERENCES grouping_pass1_runs(id);
