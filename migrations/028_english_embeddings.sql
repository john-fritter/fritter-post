-- Add english_title and english_body columns to preprocessed_items for cross-language
-- embedding support. Populated by the preprocessor at insert time: English items get
-- the original title/body copied through; non-English items get an LLM translation of
-- title + body[:2000]. Used by the grouping stage for embedding only — display, scoring,
-- and the final paper continue to read the original title/body_text. Nullable because
-- rows inserted before this migration have no english_* values; they cluster within
-- their own language until the next preprocessor run.

ALTER TABLE preprocessed_items
  ADD COLUMN IF NOT EXISTS english_title TEXT,
  ADD COLUMN IF NOT EXISTS english_body  TEXT;
