-- The paper's price: what its model calls would cost at list prices.
--
-- WHY FROZEN AT PUBLISH, not computed per page load. The price is a fact about
-- the edition, like its prose and its source links, and the paper is frozen
-- for the same reason those are (041): yesterday's paper must not become a view
-- of today's database. Here the moving part is the price list. A model maker
-- that cuts its price next month would otherwise reprice every edition in the
-- archive; frozen, each paper keeps the prices it was made at, and the rows say
-- which ones those were.
--
-- The second reason is what the reading view may touch. generation_logs holds
-- every prompt and every response in full. The reading view reads only the
-- paper_* tables, and these are two more of them.
--
-- Both tables hang off papers with ON DELETE CASCADE, because a re-publish
-- deletes and re-inserts the date's paper; the publisher writes them again for
-- the new row. Lineage from a paper to its calls is the run tables' own foreign
-- keys (writer run -> editor run -> pile -> score/thread/novelty runs -> cluster
-- run -> preprocess run), so nothing here duplicates it.

-- One row per pipeline step that made this paper, in pipeline order: what it
-- produced and how long it took. No money here; that is paper_costs.
CREATE TABLE paper_steps (
  paper_id     INT          NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  step         TEXT         NOT NULL
                 CHECK (step IN ('collect','preprocess','screen','cluster','score',
                                 'rank','fetch','write','publish')),
  seq          INT          NOT NULL,
  -- NULL when the step left no record of when it ran (fetch has no run table,
  -- and is found only through the runner's own rows).
  started_at   TIMESTAMPTZ,
  duration_ms  BIGINT,
  -- What the step handed on: articles collected, kept, screened in; events
  -- formed; articles fetched; pieces written; stories published. NULL means
  -- not recorded, not zero.
  items_out    INT,
  -- collect only: feeds that answered.
  sources      INT,
  PRIMARY KEY (paper_id, step)
);

-- One row per (step, model): the calls that model made for this paper, and
-- what they cost at the price recorded beside them.
CREATE TABLE paper_costs (
  paper_id         INT            NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  step             TEXT           NOT NULL,
  -- The model exactly as generation_logs names it.
  model            TEXT           NOT NULL,
  calls            INT            NOT NULL,
  -- Failed calls are counted in `calls` too: a provider bills the tokens a
  -- failed call consumed, and the log records them when it got that far.
  failed_calls     INT            NOT NULL,
  -- Calls whose provider reported no token usage. They cost nothing here, so a
  -- non-zero count means the price is understated, and inspect says so.
  calls_without_usage INT         NOT NULL,
  input_tokens     BIGINT         NOT NULL,
  output_tokens    BIGINT         NOT NULL,
  -- Sum of call durations. Calls run concurrently, so this exceeds wall time.
  model_ms         BIGINT         NOT NULL,
  -- The price list entry used, copied rather than referenced: config changes,
  -- and the point of this table is that the paper does not. NULL prices mean
  -- the model had no entry in config/models.yaml `pricing`, and cost_usd is
  -- NULL with them -- unpriced is not free.
  -- `model_label` names this ID beside its step ("GLM-5.2 (thinking)");
  -- `model_name` names the price entry in the model table ("GLM-5.2"), which
  -- can bill several IDs at one price.
  model_label      TEXT,
  model_name       TEXT,
  maker            TEXT,
  input_per_mtok   NUMERIC(10,4),
  output_per_mtok  NUMERIC(10,4),
  price_source     TEXT,
  price_as_of      DATE,
  cost_usd         NUMERIC(12,6),
  PRIMARY KEY (paper_id, step, model)
);

-- Finding a paper's calls means filtering generation_logs by (stage,
-- stage_run_id), and the only index was (stage, created_at). Without this, each
-- lookup reads every row a stage has ever logged, prompts and all.
CREATE INDEX generation_logs_stage_run_idx ON generation_logs (stage, stage_run_id);
