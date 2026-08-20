-- The describe pass now answers a question as well as writing a label, and the
-- clusters it flags get re-partitioned. These counters make that legible from
-- the database, the same way attach_* and split_* already are.
--
-- Why the pass exists: step 2b's split selects suspects by *cohesion*, because
-- it was built to repair chaining — union-find joining A~B~C where A and C are
-- unrelated. Two gold mine collapses on different continents are the opposite
-- shape: tightly connected, because they are the same kind of event described in
-- the same words. High cohesion, never suspected, never examined. Run #50
-- produced four of these and the describe pass wrote one of them into its own
-- title: "Gold mine collapses kill dozens in Central African Republic and
-- Colombia".
--
-- NULL means the pass did not run, which is not the same as zero.
-- resplit_failed_calls > 0 means some flagged clusters were left intact.

ALTER TABLE grouping_runs ADD COLUMN describe_flagged          INT;
ALTER TABLE grouping_runs ADD COLUMN resplit_calls             INT;
ALTER TABLE grouping_runs ADD COLUMN resplit_failed_calls      INT;
ALTER TABLE grouping_runs ADD COLUMN resplit_clusters_split    INT;
ALTER TABLE grouping_runs ADD COLUMN resplit_freed_singletons  INT;
