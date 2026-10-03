-- Novelty: the rerun check grades how new each story is, not only whether it
-- is a rerun.
--
-- WHY. The 2026-10-02 audit read papers #43-52 the way the reader does, by
-- headline, and found about two repeats a day, six of them in the top five:
-- the US-China trade truce at rank 1 on 9/27 after running 9/24 and 9/26,
-- OpenAI's training pause at rank 1 on 9/28 after rank 2 on 9/27, Christa
-- Pike's failed execution at rank 2 on 10/1 and 10/2. Every one carried a
-- "previously" line, so the paper knew. They got through because the judge's
-- question was "does the candidate say anything the printed piece did not?",
-- and a day-later article always does: a quote, a condition update, an
-- analyst. So the story ran again, at full size, and the writer -- told
-- nothing about yesterday -- wrote the old event again with the new detail in
-- paragraph three.
--
-- The reader's ruling (2026-10-03): a minor update is not dropped, it is
-- reduced -- a lower score, which may move it down the ranking or out of the
-- pile, and a smaller piece. Routine news inside a continuing situation (the
-- daily strikes of a war) is reduced the same way. A rerun is still withheld.
--
-- One row per judged candidate, whatever the grade. rerun_verdicts (045) held
-- one row per *pair*; the judge now sees a candidate against every printed
-- piece it resembles at once, because "is this routine for this situation"
-- can only be answered against the history, not against one prior piece.

CREATE TABLE rerun_assessments (
  id                    BIGSERIAL    PRIMARY KEY,
  rerun_run_id          INT          NOT NULL REFERENCES rerun_runs(id) ON DELETE CASCADE,
  row_key               TEXT         NOT NULL,   -- C<clusterIndex> or S<preprocessedItemId>
  row_title             TEXT         NOT NULL,
  -- NULL when the judge's call failed or its line was unreadable: kept,
  -- unjudged, unpenalised. The check fails open.
  grade                 TEXT         CHECK (grade IS NULL OR grade IN
                                       ('new', 'development', 'minor', 'routine', 'rerun')),
  -- Today's news in one sentence, as the judge stated it. For a development or
  -- a minor update this is what the writer is told to lead on.
  news                  TEXT,
  -- The closest printed piece. Copied beside the FK, the paper_sources rule: a
  -- correction to an old paper must not erase why today's story was reduced.
  prior_paper_piece_id  BIGINT       REFERENCES paper_pieces(id) ON DELETE SET NULL,
  prior_published_on    DATE,
  prior_headline        TEXT,
  similarity            REAL,
  priors_shown          INT          NOT NULL DEFAULT 0,
  -- What the grade did. score_before is the pass-1 score; the pile and the
  -- thread pass ranked on score_before - penalty.
  score_before          INT,
  penalty               INT          NOT NULL DEFAULT 0,
  max_tier              TEXT         CHECK (max_tier IS NULL OR max_tier IN ('feature', 'standard', 'brief')),
  generation_log_id     BIGINT
);

CREATE INDEX rerun_assessments_run_idx ON rerun_assessments (rerun_run_id, row_key);

ALTER TABLE rerun_runs ADD COLUMN rows_judged  INT;
ALTER TABLE rerun_runs ADD COLUMN rows_reduced INT;

-- The pile records which check shaped it, so the editor (tier caps) and the
-- writers (what to lead on) read the same assessments the pile ranked on.
ALTER TABLE editor_piles ADD COLUMN rerun_run_id INT REFERENCES rerun_runs(id);

-- The largest piece a story may run as. Kept on the story so the writers' tier
-- swap (resolveTiersByMaterial) cannot promote a minor update back into a
-- feature slot. NULL is uncapped.
ALTER TABLE editor_stories ADD COLUMN max_tier TEXT
  CHECK (max_tier IS NULL OR max_tier IN ('feature', 'standard', 'brief'));

COMMENT ON TABLE rerun_assessments IS
  'Every candidate the rerun check graded. rerun withholds the row; minor and routine '
  'lower its score by penalty and cap its size at max_tier; new and development pass '
  'unchanged. A failed call leaves grade NULL and changes nothing.';
COMMENT ON COLUMN thread_members.score IS
  'The score the thread pass ranked on: the pass-1 score less any novelty penalty '
  '(rerun_assessments.penalty, from migration 047).';
