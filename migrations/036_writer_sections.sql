-- Sections: a thread becomes several pieces under one heading, not one piece.
--
-- Threading absorbs a situation's rows into a single ranked story, which was
-- right for ranking and wrong for writing. Run #3 made the cost visible: T1
-- carried twelve members into one 500-word slot, and once the writer was told to
-- find a spine it wrote one of them and silently dropped eleven — including a
-- story scoring 81 (federal surveillance of left-leaning groups) while the paper
-- ran a 35-word brief on a story scoring 56. Nobody made that editorial
-- judgment; it fell out of the structure.
--
-- A thread now produces a lead piece, sidebars for its next-ranked members, and
-- one-line entries for the tail. Material is partitioned by member, so two
-- pieces in a section cannot overlap and the writers still never see each
-- other's work.
--
-- All pieces of a section share editor_story_id — they are one ranked story —
-- and order within the section is section_rank, so paper order is
-- (rank, section_rank).

ALTER TABLE writer_pieces
  -- The thread's ref (T3). NULL for an ordinary standalone piece.
  ADD COLUMN IF NOT EXISTS section_ref   TEXT,
  -- The thread's title, denormalized so the publisher can render the heading
  -- without resolving the thread.
  ADD COLUMN IF NOT EXISTS section_title TEXT,
  --   lead     the section's main piece
  --   sidebar  its own development, written at one tier below the lead
  --   line     a single sentence so a minor member is still visible
  ADD COLUMN IF NOT EXISTS section_role  TEXT
    CHECK (section_role IS NULL OR section_role IN ('lead', 'sidebar', 'line')),
  -- 0 for the lead, then 1..n in the order the section reads.
  ADD COLUMN IF NOT EXISTS section_rank  INT NOT NULL DEFAULT 0;

-- Paper order.
CREATE INDEX IF NOT EXISTS writer_pieces_run_order_idx
  ON writer_pieces (run_id, rank, section_rank);

COMMENT ON COLUMN writer_pieces.section_ref IS
  'Thread ref when this piece belongs to a section. All pieces of one section share editor_story_id and rank; section_rank orders them.';
