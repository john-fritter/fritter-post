-- The continuity judge's reason, on the row it decided.
--
-- The 2026-09-04 measurement could establish *that* the judge accepted a wrong
-- pair and never *why*: the output contract was `number;;YES or NO` and nothing
-- more, so a rejected pair and a badly-accepted one look identical afterwards.
-- Gizmo's report named that as a real limitation of the measurement, and it is.
--
-- This is the thread pass's lesson arriving one stage later. That pass emits an
-- ANCHOR before its refs (migration 037) for exactly this reason -- "a bad
-- thread is legible in the audit, where a front-page title conceals the defect"
-- -- and it found that naming the criterion also made the model apply it rather
-- than pattern-match it. Same shape here.
--
-- The reason is stored on the link rather than only in `generation_logs`
-- because the log is positional: it says pair 41 was YES, and joining that back
-- to a piece means replaying the prompt's ordering. A column is what an audit
-- can actually read, and `inspect publisher --id` prints it beside the link.

ALTER TABLE paper_piece_lineage
  ADD COLUMN judge_reason TEXT;

COMMENT ON COLUMN paper_piece_lineage.judge_reason IS
  'Why the continuity judge called this the same situation. NULL for rows '
  'written before migration 044, when the judge returned a bare verdict.';
