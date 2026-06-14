-- Retire the leftover LLM `filter` stage tables. The standalone filter stage
-- was replaced by the prefilter stage long ago (prefilter absorbed its
-- junk-removal job); these tables were never read or written by current code.
--
-- Order matters: drop filter_results (references filter_runs) before filter_runs.

DROP TABLE IF EXISTS filter_results;
DROP TABLE IF EXISTS filter_runs;
