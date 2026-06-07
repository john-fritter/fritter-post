-- Editor stage tables.
-- editor_runs: one row per execution — a single whole-pile ranking + tiering call.
-- editor_stories: one row per pile item — tier, rank (line order), full lineage.

CREATE TABLE editor_runs (
  id                SERIAL       PRIMARY KEY,
  started_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  pile_id           INT          NOT NULL REFERENCES editor_piles(id),
  triage_run_id     INT          NOT NULL REFERENCES triage_runs(id),
  model_used        TEXT         NOT NULL,
  items_in          INT          NOT NULL DEFAULT 0,
  items_feature     INT          NOT NULL DEFAULT 0,
  items_standard    INT          NOT NULL DEFAULT 0,
  items_brief       INT          NOT NULL DEFAULT 0,
  items_cut         INT          NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- One row per pile item, in ranked order (rank = line order in the model's output,
-- with fail-safed items appended at the bottom). Lineage is mechanical: a story
-- points to a cluster (cluster_index into the triage digest's clusters array,
-- whose item_ids resolve back to preprocessed_items) or a singleton
-- (preprocessed_item_id directly), never both.
CREATE TABLE editor_stories (
  id                    BIGSERIAL    PRIMARY KEY,
  run_id                INT          NOT NULL REFERENCES editor_runs(id),
  item_type             TEXT         NOT NULL CHECK (item_type IN ('cluster', 'singleton')),
  cluster_index         INT,
  preprocessed_item_id  BIGINT       REFERENCES preprocessed_items(id),
  tier                  TEXT         NOT NULL CHECK (tier IN ('feature', 'standard', 'brief', 'cut')),
  rank                  INT          NOT NULL,
  reason                TEXT         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX editor_stories_run_id_rank_idx ON editor_stories (run_id, rank);
CREATE INDEX editor_stories_item_id_idx     ON editor_stories (preprocessed_item_id);
