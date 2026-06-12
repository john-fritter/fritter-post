-- Pile-merge pass: one LLM call over the assembled top-N pile that identifies
-- same-story duplicates the upstream clusterer missed and merges them before
-- the editor sees the pile. Merge-only: does not score, tier, or cut.
--
-- pile_merge_runs: one row per merge pass execution. merged_pile stores the
-- final merged entries as JSONB; the editor reads this when pile_merge_run_id
-- is set on the pile.
--
-- editor_piles.pile_merge_run_id: nullable FK. When set, the editor uses the
-- merged pile instead of the raw editor_pile_items + digest resolution.

CREATE TABLE pile_merge_runs (
  id                SERIAL PRIMARY KEY,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  editor_pile_id    INT NOT NULL REFERENCES editor_piles(id),
  model_used        TEXT NOT NULL,
  items_in          INT NOT NULL DEFAULT 0,
  groups_merged     INT NOT NULL DEFAULT 0,
  items_out         INT NOT NULL DEFAULT 0,
  merged_pile       JSONB,
  generation_log_id BIGINT REFERENCES generation_logs(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE editor_piles
  ADD COLUMN pile_merge_run_id INT REFERENCES pile_merge_runs(id);
