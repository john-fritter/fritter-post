-- Add the source `group` axis to preprocessed_items, set at preprocess time
-- from config/sources.yaml (looked up by source_name, inherited — same
-- mechanism as `track`). Nullable, no default: sources that don't declare a
-- group leave it null.
--
-- group is purely a clustering-staging axis (which round of the triage
-- clusterer an item enters, per config/models.yaml triage.clustering.rounds).
-- It is NOT an editorial or topic tag and never reaches the paper.

ALTER TABLE preprocessed_items
  ADD COLUMN "group" TEXT;
