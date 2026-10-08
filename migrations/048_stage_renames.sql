-- The stages were renamed for what they do (docs/decisions.md, 2026-10-08):
--
--   prefilter       -> screen        grouping        -> cluster
--   grouping-pass1  -> score         rerun           -> novelty
--   editor          -> rank          fetch-text      -> fetch
--   lineage         -> continuity    writers         -> write
--
-- Data only. No table or column changes here: those follow in a later
-- migration, so this one is safe to apply ahead of or alongside the code.
--
-- WHY THE OLD ROWS CHANGE TOO. Stage names are read back, not just written.
-- The runner's fetch gate builds its cooldown baseline from earlier
-- `pipeline_stage_runs` rows WHERE stage = 'fetch', so without this the first
-- week after the rename would compare against an empty baseline. And a
-- `generation_logs` query by stage should not need to know which side of
-- 2026-10-08 a call fell on.

UPDATE pipeline_stage_runs SET stage = CASE stage
    WHEN 'prefilter'      THEN 'screen'
    WHEN 'grouping'       THEN 'cluster'
    WHEN 'grouping-pass1' THEN 'score'
    WHEN 'editor'         THEN 'rank'
    WHEN 'fetch-text'     THEN 'fetch'
  END
 WHERE stage IN ('prefilter', 'grouping', 'grouping-pass1', 'editor', 'fetch-text');

UPDATE pipeline_runs SET started_from = CASE started_from
    WHEN 'prefilter'      THEN 'screen'
    WHEN 'grouping'       THEN 'cluster'
    WHEN 'grouping-pass1' THEN 'score'
    WHEN 'editor'         THEN 'rank'
    WHEN 'fetch-text'     THEN 'fetch'
  END
 WHERE started_from IN ('prefilter', 'grouping', 'grouping-pass1', 'editor', 'fetch-text');

UPDATE pipeline_runs SET stopped_at_stage = CASE stopped_at_stage
    WHEN 'prefilter'      THEN 'screen'
    WHEN 'grouping'       THEN 'cluster'
    WHEN 'grouping-pass1' THEN 'score'
    WHEN 'editor'         THEN 'rank'
    WHEN 'fetch-text'     THEN 'fetch'
  END
 WHERE stopped_at_stage IN ('prefilter', 'grouping', 'grouping-pass1', 'editor', 'fetch-text');

-- Translation logged as 'preprocessor'; it now logs as 'preprocess'.
UPDATE generation_logs SET stage = CASE stage
    WHEN 'preprocessor'     THEN 'preprocess'
    WHEN 'prefilter'        THEN 'screen'
    WHEN 'grouping'         THEN 'cluster'
    WHEN 'grouping-pass-1'  THEN 'score'
    WHEN 'rerun'            THEN 'novelty'
    WHEN 'editor-tie-break' THEN 'rank-tie-break'
    WHEN 'writers'          THEN 'write'
    WHEN 'writers-briefs'   THEN 'write-briefs'
    WHEN 'lineage'          THEN 'continuity'
    WHEN 'lineage-check'    THEN 'continuity-check'
  END
 WHERE stage IN ('preprocessor', 'prefilter', 'grouping', 'grouping-pass-1', 'rerun',
                 'editor-tie-break', 'writers', 'writers-briefs', 'lineage', 'lineage-check');
