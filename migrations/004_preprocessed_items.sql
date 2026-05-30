-- Preprocessed items: cleaned, deduped output of the preprocessor stage.
-- One row per surviving raw_item after recency filter and URL deduplication.

CREATE TABLE preprocessed_items (
  id                   BIGSERIAL PRIMARY KEY,
  preprocessor_run_id  INT         NOT NULL REFERENCES preprocessor_runs(id),
  raw_item_id          BIGINT      NOT NULL REFERENCES raw_items(id),

  -- Source metadata copied from raw_items / sources.yaml
  source_name          TEXT        NOT NULL,
  source_type          TEXT        NOT NULL,  -- wire | journalism | advocacy | newsletter

  -- Content fields
  title                TEXT        NOT NULL,
  canonical_url        TEXT        NOT NULL,
  original_url         TEXT        NOT NULL,
  body_text            TEXT,                  -- cleaned plain text; NULL if body was absent or empty

  -- Timestamps
  published_at         TIMESTAMPTZ,
  fetched_at           TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX preprocessed_items_run_id_idx      ON preprocessed_items (preprocessor_run_id);
CREATE INDEX preprocessed_items_source_name_idx ON preprocessed_items (source_name);
CREATE INDEX preprocessed_items_published_at_idx ON preprocessed_items (published_at DESC);
