-- The rerun check: before a scored row can reach the pile, is it news the
-- paper already printed?
--
-- The Sep 5-22 audit found roughly one continuity link in four was the same
-- news run again from another outlet -- AfD's 43.8% result on Sep 7, 8 and 10;
-- LG TVs recording audio on Sep 7, 8 and 9 -- each with a "previously" line on
-- top. Cross-run dedup matches URLs and titles, and none of the 257 links shared
-- either. See src/pipeline/rerun/.
--
-- One row per judged pair, kept whatever the verdict: a dropped story never
-- reaches the paper, so this table is the only place a wrong drop can be seen.

CREATE TABLE rerun_runs (
  id                     SERIAL       PRIMARY KEY,
  grouping_pass1_run_id  INT          NOT NULL REFERENCES grouping_pass1_runs(id),
  model_used             TEXT         NOT NULL,
  started_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMPTZ,
  candidates_in          INT,
  pairs_judged           INT,
  rows_dropped           INT,
  calls                  INT,
  failed_calls           INT
);

CREATE TABLE rerun_verdicts (
  id                    BIGSERIAL    PRIMARY KEY,
  rerun_run_id          INT          NOT NULL REFERENCES rerun_runs(id) ON DELETE CASCADE,
  row_key               TEXT         NOT NULL,   -- C<clusterIndex> or S<preprocessedItemId>
  row_title             TEXT         NOT NULL,
  prior_paper_piece_id  BIGINT       REFERENCES paper_pieces(id) ON DELETE SET NULL,
  prior_published_on    DATE         NOT NULL,
  prior_headline        TEXT,
  similarity            REAL         NOT NULL,
  -- NULL when the judge's call failed or its line was unreadable: kept, unjudged.
  verdict               TEXT         CHECK (verdict IS NULL OR verdict IN ('new', 'development', 'rerun')),
  reason                TEXT,
  generation_log_id     BIGINT
);

CREATE INDEX rerun_verdicts_run_idx ON rerun_verdicts (rerun_run_id);

COMMENT ON TABLE rerun_verdicts IS
  'Every pair the rerun judge saw. A row is withheld from the pile when any of its '
  'pairs is ''rerun''. The prior piece''s date and headline are copied beside the FK '
  'so a correction to an old paper does not erase why a story was dropped.';
