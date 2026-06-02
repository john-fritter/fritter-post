-- Add priority score to editor_pass_1_results.
ALTER TABLE editor_pass_1_results
  ADD COLUMN score INT NOT NULL DEFAULT 50 CHECK (score >= 0 AND score <= 100);

CREATE INDEX editor_pass_1_results_score_idx
  ON editor_pass_1_results (run_id, score DESC);

-- Editor pile: assembled pile from editor-pass-1 scoring + triage clusters.
-- Clusters pass through unconditionally; singletons are selected by score.
CREATE TABLE editor_piles (
  id                     SERIAL       PRIMARY KEY,
  editor_pass_1_run_id   INT          NOT NULL REFERENCES editor_pass_1_runs(id),
  triage_run_id          INT          NOT NULL REFERENCES triage_runs(id),
  singleton_pile_target  INT          NOT NULL,
  clusters_included      INT          NOT NULL DEFAULT 0,
  singletons_in_pile     INT          NOT NULL DEFAULT 0,
  singletons_below_line  INT          NOT NULL DEFAULT 0,
  score_cutoff           INT,          -- score of last included singleton; NULL if all fit
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- editor_pile_items: one row per cluster (by triage digest index) or singleton.
-- Clusters always have in_pile = true. Singletons: true = selected, false = below line.
-- Cut singletons never appear here.
CREATE TABLE editor_pile_items (
  id                    BIGSERIAL    PRIMARY KEY,
  pile_id               INT          NOT NULL REFERENCES editor_piles(id),
  item_type             TEXT         NOT NULL CHECK (item_type IN ('cluster', 'singleton')),
  -- Cluster entry: 0-based position in triage_runs.digest clusters array
  cluster_index         INT,
  -- Singleton entry: the preprocessed item
  preprocessed_item_id  BIGINT       REFERENCES preprocessed_items(id),
  in_pile               BOOLEAN      NOT NULL DEFAULT TRUE,
  -- Singleton-only attributes from editor-pass-1 results
  bucket                TEXT         CHECK (bucket IN ('research', 'footer')),
  score                 INT          CHECK (score >= 0 AND score <= 100),
  reason                TEXT,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX editor_pile_items_pile_id_idx  ON editor_pile_items (pile_id);
CREATE INDEX editor_pile_items_in_pile_idx  ON editor_pile_items (pile_id, in_pile);
