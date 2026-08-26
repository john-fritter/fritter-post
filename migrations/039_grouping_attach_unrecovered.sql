-- Separate "a call failed" from "a judgment was lost".
--
-- `attach_failed_calls` has carried both meanings since migration 030, because
-- until now they were the same thing: a failed attach call returned an empty set,
-- the cluster silently did not grow, and the judgment was gone. The rule written
-- around it — a non-zero value means the cluster/singleton split understates real
-- grouping, so do not tune similarity_threshold on that run — followed from that.
--
-- The attach pass now makes one sequential re-ask for the judgments its
-- concurrent phases lost. Run #56 is why: 158 provider attempts for 133
-- successes, 24 recoverable 429s and one 300,006 ms timeout, on a news lane that
-- had just grown 42% (483 kept-news to 686). The corpus outgrew the concurrency
-- budget, and callWithBackoff does not retry timeouts — correctly, since a call
-- that ran to its ceiling will do it again, which is true of a slow call and
-- false of one that spent its budget queued behind a rate-limit storm.
--
-- So a failed call is now recoverable, and the two counts diverge:
--
--   attach_failed_calls   provider calls that failed, storm and re-ask alike.
--                         A cost in time and tokens. Not itself a defect.
--   attach_unrecovered    judgments still missing after the re-ask. THIS is the
--                         one the "do not judge cluster quality on this run"
--                         rule attaches to.
--
-- NULL means the run predates this column and cannot distinguish the two; read
-- attach_failed_calls as unrecovered for those, which is what it meant then.

ALTER TABLE grouping_runs
  ADD COLUMN attach_unrecovered INT;

COMMENT ON COLUMN grouping_runs.attach_unrecovered IS
  'Attach judgments still lost after the sequential straggler re-ask. Non-zero '
  'means the cluster/singleton split understates real grouping and the run must '
  'not be used to judge cluster quality or tune similarity_threshold. NULL for '
  'runs before migration 039, where attach_failed_calls carried this meaning.';
