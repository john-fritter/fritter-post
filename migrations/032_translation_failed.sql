-- Record which items fell back to original-language text instead of being
-- translated.
--
-- The preprocessor already computes this per item, but the flag lived only in
-- memory: on failure it copies the ORIGINAL text into english_title and moves
-- on, leaving nothing in the database to distinguish "this item is English" from
-- "this item is Russian and we failed to translate it". Run #44 lost 23 of 601
-- non-English items that way and the only evidence was a line of stdout.
--
-- That matters because the fallback is silent and effectively permanent: the
-- item embeds in its own language space, cannot cluster with same-event
-- coverage in other languages, and nothing downstream can tell. With the flag,
-- the loss is queryable, and a future pass can retry exactly the failed rows.
--
-- NULL means the row predates this migration — not the same as false.

ALTER TABLE preprocessed_items
  ADD COLUMN IF NOT EXISTS translation_failed BOOLEAN;

COMMENT ON COLUMN preprocessed_items.translation_failed IS
  'True when translation failed and english_title/english_body hold untranslated original text. Such items cannot cluster cross-language. NULL for rows predating migration 032.';

-- Partial index: the failures are the rare case and the only one worth querying.
CREATE INDEX IF NOT EXISTS preprocessed_items_translation_failed_idx
  ON preprocessed_items (preprocessor_run_id)
  WHERE translation_failed = TRUE;
