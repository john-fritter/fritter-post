-- Grouping-pass-1 scores on two axes instead of one.
--
-- WHY: run #109 published 150 rows carrying only 48 distinct combined scores,
-- with 119 rows sitting in a tie group. 115 of those 119 were singletons tied
-- at an integer value, which is structural rather than a scoring failure: a
-- singleton has one source, the editor formula adds source_weight * ln(1) = 0,
-- so combined == score exactly and any two singletons with the same integer
-- score are precisely tied. With ~119 singletons landing in an effective band
-- of 57-88 — 32 integers — the pigeonhole principle puts at least 87 of them in
-- a tie no matter how good the scorer is.
--
-- The fix is to make the score itself finer-grained rather than to patch the
-- formula. The prompt already told the model its score "blends two things: how
-- much this reader cares about the subject AND how much actually happened", so
-- the two axes were already there conceptually — they were just being collapsed
-- into one integer inside the model, where they bunched onto round attractors
-- (55, 58, 60, 62, 65, 68, 70, 72, 75, 78). Asking for both and summing them in
-- software spreads the distribution without changing the 0-100 scale, so the
-- pile cutoff, the editor formula, and a thread's max(member score) all keep
-- working exactly as before.
--
-- Storing the axes separately is the feedback loop: it makes it answerable
-- whether a tie comes from one axis or both, and whether the consequence axis
-- is doing its second job (below).
--
-- SECOND JOB: the consequence axis is also the principled defence against link
-- roundups. Run #109 put "Early Edition: August 10, 2026" — Just Security's
-- daily list of other people's stories — at rank 9 in the feature tier with the
-- joint-highest singleton score in the paper, because a roundup's body is a
-- dense list of exactly the topics this reader cares about. High interest is the
-- correct reading of that item. Its consequence is near zero: nothing happened
-- in the item itself. One number could not express that; two can.
--
-- Nullable because rows scored before this migration have no axis breakdown,
-- and because the parser still fail-safes to a bare sum when a line is
-- unreadable. score remains the authoritative value and stays NOT NULL.

ALTER TABLE grouping_pass1_results
  ADD COLUMN interest    INT CHECK (interest    >= 0 AND interest    <= 50),
  ADD COLUMN consequence INT CHECK (consequence >= 0 AND consequence <= 50);

COMMENT ON COLUMN grouping_pass1_results.interest IS
  'Bio-relevance axis, 0-50. How much this reader cares about the subject. NULL for rows scored before migration 033 or fail-safed.';

COMMENT ON COLUMN grouping_pass1_results.consequence IS
  'Event-weight axis, 0-50. How much actually happened in this item. Near zero for digests and roundups, which index other stories rather than reporting one. NULL for rows scored before migration 033 or fail-safed.';
