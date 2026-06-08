-- Adds news/opinion classification to prefilter results.
--
-- The prefilter now also decides, among items it keeps, whether each is news
-- (reporting of what happened) or opinion (an argument/analysis/personal take
-- about events — columns, op-eds, commentary, personal essays). Opinion-kept
-- items are routed to the Longer Reads pool the same way track='analysis'
-- items already are — they never reach clustering. See docs/decisions.md.
--
-- Additive: existing rows default to 'news' (their prior meaning under the
-- binary keep/cut judgment).

ALTER TABLE prefilter_results
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'news' CHECK (kind IN ('news', 'opinion'));
