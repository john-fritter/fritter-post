-- Prefilter stage tables.
-- Bio-aware relevance filter that runs between the preprocessor and the
-- clusterer: a binary keep/cut floor on track='news' items the junk filter
-- and same-parent dedup have already passed. Distinct judgment from the junk
-- filter (reader-relevance vs. garbage) — see docs/decisions.md.
--
-- prefilter_runs: one row per stage execution.
-- prefilter_results: per-item keep/cut verdict with reason.
--
-- Designed to become an absolute-floor scorer with only a prompt change:
-- `keep` stays derivable from a future `score` column via threshold, so
-- adding `score` later is additive (see decisions.md).

CREATE TABLE prefilter_runs (
  id                   SERIAL       PRIMARY KEY,
  started_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  preprocessor_run_id  INT          NOT NULL,
  model_used           TEXT         NOT NULL,
  items_in             INT          NOT NULL DEFAULT 0,
  items_kept           INT          NOT NULL DEFAULT 0,
  items_cut            INT          NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE prefilter_results (
  id                    BIGSERIAL    PRIMARY KEY,
  run_id                INT          NOT NULL REFERENCES prefilter_runs(id),
  preprocessed_item_id  BIGINT       NOT NULL REFERENCES preprocessed_items(id),
  keep                  BOOLEAN      NOT NULL,
  reason                TEXT         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX prefilter_results_run_id_idx  ON prefilter_results (run_id);
CREATE INDEX prefilter_results_item_id_idx ON prefilter_results (preprocessed_item_id);
