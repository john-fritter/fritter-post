-- Cross-day story lineage: what this paper already said about this story.
--
-- WHY THIS EXISTS. The 2026-09-03 repeated-headline audit found three causes
-- behind the reader's "same story every day" complaint. One was syndicated
-- copies re-ingested under another masthead, fixed deterministically in the
-- preprocessor's cross-run title key. The other two are not dedup problems at
-- all, and share a single missing capability: **the paper has no cross-edition
-- story identity.** Daily refs like T0 and C27 are run-local, so the
-- same-looking ref on another date is not the same object, and nothing in the
-- pipeline reads `papers` except the publisher that writes it.
--
-- Nvidia/Hugging Face is the case that names the defect. It ran on 8/27 as a
-- report, on 8/28 as a further report, and on 9/3 as a six-source confirmation.
-- The 9/3 piece was legitimately new and must not be suppressed. What was
-- missing was any marker telling the reader it was the same transaction
-- advancing. The same is true of the Nepal floods, the Iran war and the USPS
-- mail-ballot fight: every day carried a real new development, and every day
-- read like a rerun because nothing said otherwise.
--
-- WHAT THIS IS NOT. It is not a suppression mechanism. Nothing reads these rows
-- to drop a story. Continuity is the fix for a continuing story; deletion is the
-- fix for a duplicate, and that one already happened upstream.
--
-- THE RELATION IS "SAME SITUATION", NOT "SAME STORY", and that is deliberate.
-- Distinguishing "same story resurfacing" from "same story advancing" is a hard
-- judgment and would need an LLM. A *continuity marker* does not need it: two
-- consecutive days of Iran war coverage are different developments, and
-- "previously, on Sept 2" is the correct and useful thing to say about both.
-- The distinction would only matter if we were deleting something.
--
-- ONE LINK PER PIECE, enforced by the unique index. A piece continues one story.

CREATE TABLE paper_piece_lineage (
  id                   BIGSERIAL   PRIMARY KEY,
  paper_id             INT         NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  paper_piece_id       BIGINT      NOT NULL REFERENCES paper_pieces(id) ON DELETE CASCADE,

  -- The prior coverage. Both FKs are nullable and ON DELETE SET NULL rather than
  -- CASCADE: re-publishing an earlier date deletes and re-inserts its pieces, and
  -- what today's paper said about yesterday must not silently vanish because
  -- yesterday was corrected. The copied columns below are what actually renders.
  prior_paper_id       INT         REFERENCES papers(id) ON DELETE SET NULL,
  prior_paper_piece_id BIGINT      REFERENCES paper_pieces(id) ON DELETE SET NULL,

  -- Copied, not joined -- the same rule paper_sources follows, for the same
  -- reason: a published paper is an artifact and has to keep saying what it said.
  prior_published_on   DATE        NOT NULL,
  prior_ref            TEXT        NOT NULL,
  -- NULL for a section line, which is published with no headline of its own.
  prior_headline       TEXT,

  -- Max cosine similarity between any article behind this piece and any article
  -- behind the prior one. Persisted because it is the tuning lever: a report has
  -- to be able to ask what the links looked like without re-running the pass.
  similarity           REAL        NOT NULL,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A piece continues at most one story.
CREATE UNIQUE INDEX paper_piece_lineage_piece_key ON paper_piece_lineage (paper_piece_id);
CREATE INDEX paper_piece_lineage_paper_idx ON paper_piece_lineage (paper_id);

-- Migration 030's reason: a report must be able to judge a paper after the
-- console log is gone. Zero here on a day with obvious continuing situations
-- means the threshold is wrong, and nothing else would say so.
ALTER TABLE papers
  ADD COLUMN pieces_with_lineage INT NOT NULL DEFAULT 0;

COMMENT ON TABLE paper_piece_lineage IS
  'What this paper already said about this story. A continuity marker, never a '
  'suppression signal -- the relation is "same situation", which is what a '
  '"previously" line needs and what deletion would not.';
