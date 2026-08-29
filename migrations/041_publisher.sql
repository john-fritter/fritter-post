-- The publisher: the paper as an artifact, not as a view.
--
-- WHY THESE TABLES EXIST AT ALL. Everything the reader needs is already in the
-- database -- writer_pieces holds the prose, and preprocessed_items holds the
-- attribution -- so the reading view could join its way there on every request.
-- It must not, for two reasons.
--
-- First, writer_pieces cannot produce a source link. It stores source_count and
-- nothing else; the URLs are three joins away through thread_members,
-- grouping_runs.digest and preprocessed_items, and that walk is exactly what
-- src/pipeline/writers/materials.ts exists to do. Repeating it per page load
-- would put the writers' resolver on the reader's critical path.
--
-- Second, and the real argument: a paper is a daily artifact. Re-running
-- grouping tomorrow must not change what yesterday's paper said. A view is a
-- window onto whatever the pipeline currently believes; these tables are what
-- was published, frozen at publication. That is also why the source rows carry
-- their own copies of the outlet name, title and URL rather than only a foreign
-- key: raw_items has a retention window, and a published paper must keep
-- pointing at its sources after its inputs have been swept.
--
-- WHAT IS NOT HERE. No third-party article text. article_texts stays the only
-- table holding that, it is used to write the paper and never to publish it,
-- and the publisher does not copy from it. The paper links to reporting; it
-- does not reproduce it.

-- One paper per day. Re-publishing a date replaces it (the publisher deletes
-- and re-inserts inside one transaction), so a re-run is idempotent rather than
-- a second paper for the same morning.
CREATE TABLE papers (
  id             SERIAL       PRIMARY KEY,
  -- The reader's local day, not UTC: "today's paper" means today in Bend.
  -- Derived from writer_runs.started_at at America/Los_Angeles.
  published_on   DATE         NOT NULL,
  writer_run_id  INT          NOT NULL REFERENCES writer_runs(id),
  editor_run_id  INT          NOT NULL REFERENCES editor_runs(id),

  started_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,

  -- Ranked stories the reader sees as rows; pieces is the larger number,
  -- because a thread is one row that expands into several pieces.
  story_count    INT          NOT NULL DEFAULT 0,
  piece_count    INT          NOT NULL DEFAULT 0,
  source_count   INT          NOT NULL DEFAULT 0,
  word_count     INT          NOT NULL DEFAULT 0,

  -- Graceful degradation, recorded rather than inferred. pieces_skipped counts
  -- writer pieces that failed and so were left out of the paper; pieces_unsourced
  -- counts published pieces whose articles could not be resolved, which is a
  -- piece the reader cannot follow to anyone's reporting. Both non-zero is a
  -- publishable paper with holes in it, and a report has to be able to say so.
  pieces_skipped    INT       NOT NULL DEFAULT 0,
  pieces_unsourced  INT       NOT NULL DEFAULT 0,

  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX papers_published_on_key ON papers (published_on);

-- One row per published piece. Shape follows writer_pieces deliberately: the
-- section columns are already denormalized there for the same reason they are
-- denormalized here, and keeping the shapes aligned means the publisher is a
-- copy with attribution attached rather than a re-modelling.
CREATE TABLE paper_pieces (
  id               BIGSERIAL   PRIMARY KEY,
  paper_id         INT         NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  writer_piece_id  BIGINT      REFERENCES writer_pieces(id),
  editor_story_id  BIGINT      REFERENCES editor_stories(id),

  rank             INT         NOT NULL,
  section_rank     INT         NOT NULL DEFAULT 0,
  tier             TEXT        NOT NULL CHECK (tier IN ('feature', 'standard', 'brief')),

  -- The ref is the URL. It is stable within a paper and unique within it, which
  -- is what lets /story/S65609 address a piece without a second identifier to
  -- keep in sync.
  ref              TEXT        NOT NULL,
  section_ref      TEXT,
  section_title    TEXT,
  section_role     TEXT        CHECK (section_role IS NULL OR section_role IN ('lead', 'sidebar', 'line')),

  -- NULL for a section line, which is written as a bare sentence and has no
  -- headline of its own. The reading view leads on the sentence when it is null.
  headline         TEXT,
  body             TEXT        NOT NULL,
  word_count       INT         NOT NULL DEFAULT 0,

  -- The editor's own count, kept so a piece can say "43 sources" even where
  -- fewer resolved to rows in paper_sources.
  source_count     INT         NOT NULL DEFAULT 0,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX paper_pieces_paper_ref_key ON paper_pieces (paper_id, ref);
CREATE INDEX paper_pieces_order_idx ON paper_pieces (paper_id, rank, section_rank);

-- The links out. Every row is somebody else's reporting, which is the whole
-- point: the paper's framing is its own and the article stays at the source.
CREATE TABLE paper_sources (
  id                   BIGSERIAL   PRIMARY KEY,
  paper_id             INT         NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  paper_piece_id       BIGINT      NOT NULL REFERENCES paper_pieces(id) ON DELETE CASCADE,
  preprocessed_item_id BIGINT      REFERENCES preprocessed_items(id),

  -- Copied, not joined. See the note at the top: a published paper outlives the
  -- retention window on the rows it was built from.
  source_name          TEXT        NOT NULL,
  source_type          TEXT,
  title                TEXT        NOT NULL,
  url                  TEXT        NOT NULL,
  published_at         TIMESTAMPTZ,

  -- Display order within the piece: the resolver's own order, which is
  -- chronological within a member, so a cluster reads as a timeline.
  position             INT         NOT NULL DEFAULT 0,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX paper_sources_piece_idx ON paper_sources (paper_piece_id, position);
CREATE INDEX paper_sources_paper_idx ON paper_sources (paper_id);

COMMENT ON TABLE papers IS
  'One published edition. Immutable once written: re-publishing a date replaces '
  'the row and cascades, so yesterday''s paper does not change when the pipeline '
  'is re-run.';
COMMENT ON COLUMN papers.pieces_unsourced IS
  'Published pieces with zero resolved sources. Non-zero means part of the paper '
  'cannot be followed back to anyone''s reporting.';
COMMENT ON TABLE paper_sources IS
  'Attribution, snapshotted at publication. Never article text -- the paper links '
  'to reporting and does not reproduce it.';
