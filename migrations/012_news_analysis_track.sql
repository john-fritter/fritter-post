-- Add news/analysis track discriminator to preprocessed_items.
-- Derived at preprocess time from sources.yaml; 'news' is the default.

ALTER TABLE preprocessed_items
  ADD COLUMN track TEXT NOT NULL DEFAULT 'news'
    CHECK (track IN ('news', 'analysis'));

CREATE INDEX idx_preprocessed_items_run_track
  ON preprocessed_items (preprocessor_run_id, track);
