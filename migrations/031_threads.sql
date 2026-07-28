-- Thread layer: groups related clusters and singletons into one ongoing
-- situation, above the event-level clustering that grouping produces.
--
-- Event clustering answers "is this the same event?". That is the right question
-- for the collector's raw feed, and the split pass (2026-07-25) made it stricter
-- to repair union-find over-merges. But it is the wrong question for a reader
-- looking at a finished paper: run #43 carried five separate Oregon wildfire
-- clusters, four of them in the top fifteen, because the fires are one ongoing
-- situation made of many distinct events. Threads answer the reader's question
-- without loosening the event question.
--
-- A thread is a first-class row the editor ranks, not presentation metadata. It
-- inherits max(member score) as relevance and sum(member source_count) as
-- prominence, so the existing editor formula applies unchanged.

CREATE TABLE thread_runs (
  id                     SERIAL       PRIMARY KEY,
  started_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMPTZ,
  grouping_pass1_run_id  INT          NOT NULL REFERENCES grouping_pass1_runs(id),
  model_used             TEXT         NOT NULL,
  -- How many top-scored rows were offered to the pass.
  candidates_in          INT,
  threads_formed         INT,
  -- Rows absorbed into threads. rows_absorbed - threads_formed is the number of
  -- pile slots the pass freed for other stories.
  rows_absorbed          INT,
  calls                  INT,
  -- Non-zero means some candidates were never considered and the run's
  -- de-duplication is incomplete. Same contract as grouping's failed_calls.
  failed_calls           INT,
  input_tokens           INT,
  output_tokens          INT,
  generation_log_id      BIGINT       REFERENCES generation_logs(id),
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE threads (
  id             BIGSERIAL    PRIMARY KEY,
  thread_run_id  INT          NOT NULL REFERENCES thread_runs(id),
  -- 0-based; the editor's ref for a thread is T<thread_index>.
  thread_index   INT          NOT NULL,
  title          TEXT         NOT NULL,
  summary        TEXT,
  -- Derived in software from the members, never asked of the model.
  score          INT          NOT NULL CHECK (score >= 0 AND score <= 100),
  source_count   INT          NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT threads_run_index_unique UNIQUE (thread_run_id, thread_index)
);

CREATE INDEX threads_run_idx ON threads (thread_run_id);

-- Full lineage: every thread member resolves back to the cluster or
-- preprocessed item it came from, and from there to raw items.
CREATE TABLE thread_members (
  id                    BIGSERIAL  PRIMARY KEY,
  thread_id             BIGINT     NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  item_type             TEXT       NOT NULL CHECK (item_type IN ('cluster', 'singleton')),
  cluster_index         INT,
  preprocessed_item_id  BIGINT     REFERENCES preprocessed_items(id),
  score                 INT        NOT NULL,
  source_count          INT        NOT NULL
);

CREATE INDEX thread_members_thread_idx ON thread_members (thread_id);

-- Threads enter the pile alongside clusters and singletons.
ALTER TABLE editor_pile_items
  ADD COLUMN thread_id BIGINT REFERENCES threads(id);

ALTER TABLE editor_pile_items
  DROP CONSTRAINT editor_pile_items_item_type_check;

ALTER TABLE editor_pile_items
  ADD CONSTRAINT editor_pile_items_item_type_check
  CHECK (item_type IN ('cluster', 'singleton', 'thread'));

-- Pile lineage back to the thread run that produced its threads.
ALTER TABLE editor_piles
  ADD COLUMN thread_run_id INT REFERENCES thread_runs(id);

-- A thread that reaches the paper is a published story like any other, so the
-- editor's output has to be able to name one. Without this the run would fail
-- at the final insert rather than anywhere useful.
ALTER TABLE editor_stories
  ADD COLUMN thread_id BIGINT REFERENCES threads(id);

ALTER TABLE editor_stories
  DROP CONSTRAINT editor_stories_item_type_check;

ALTER TABLE editor_stories
  ADD CONSTRAINT editor_stories_item_type_check
  CHECK (item_type IN ('cluster', 'singleton', 'thread'));
