-- The paper's public read interface: what Fritter Board may see.
--
-- WHY A SCHEMA OF VIEWS, not grants on the tables. Fritter Board lives in the
-- same database (its own `board` schema) and links its discussion threads to
-- Fritter Post articles. It needs to read published pieces -- a thread shows an
-- article card, and the board's bots will read the article they discuss -- and
-- nothing else. The views below are the whole contract: the board's role gets
-- USAGE on this schema and SELECT on these views, and nothing in `public`. A
-- view runs with its owner's privileges, so the board reads published prose and
-- source links without being able to see article_texts (third-party full text,
-- which must never be published and which the board's bots would send to a
-- model provider), generation_logs, or any pipeline working table.
--
-- The grants are not in this migration because the board's role is created on
-- the box, not here, and may not exist in a development database:
--
--   GRANT USAGE ON SCHEMA published TO fritter_board;
--   GRANT SELECT ON ALL TABLES IN SCHEMA published TO fritter_board;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA published GRANT SELECT ON TABLES TO fritter_board;
--
-- THE ARTICLE ID IS writer_pieces.id, and paper_pieces.id cannot be. A
-- re-publish deletes and re-inserts the date's paper, so every paper_pieces id
-- changes whenever a morning is corrected; a board thread keyed on one would
-- lose its article the first time a repair was published. writer_pieces.id is
-- minted once per written piece and never reused. `--repair` rewrites failed
-- pieces in place, so re-publishing the same writer run keeps every id; a paper
-- replaced from a *different* writer run is different writing, and its old ids
-- resolve to nothing. That is the property that matters: a stale id can go
-- missing, but it can never come back pointing at a different story. A date +
-- ref address cannot promise that -- C27 and T0 are run-local, and a same-day
-- replacement run can hand C27 to another cluster.
--
-- A writer run published under two dates (`--date`) puts one article in two
-- papers; the views take the latest.
--
-- THE CONTRACT. Add columns freely; do not rename or drop one without changing
-- the board in the same breath. CREATE OR REPLACE VIEW keeps the grants; DROP
-- VIEW loses them unless the default privileges above were set.

CREATE INDEX paper_pieces_writer_piece_idx ON paper_pieces (writer_piece_id);

CREATE SCHEMA published;

-- One row per published article, from the latest paper that carries it.
CREATE VIEW published.articles AS
SELECT DISTINCT ON (pp.writer_piece_id)
       pp.writer_piece_id AS id,
       p.published_on,
       pp.ref,
       pp.rank,
       pp.section_rank,
       pp.tier,
       pp.section_ref,
       pp.section_title,
       pp.section_role,
       -- NULL for a section line, which is a bare sentence with no headline.
       pp.headline,
       pp.body,
       pp.word_count,
       pp.source_count,
       COALESCE(p.completed_at, p.started_at) AS published_at
  FROM paper_pieces pp
  JOIN papers p ON p.id = pp.paper_id
 WHERE pp.writer_piece_id IS NOT NULL
 ORDER BY pp.writer_piece_id, p.published_on DESC, p.id DESC;

-- The links out, per article, in display order. Attribution only: titles and
-- URLs of other outlets' reporting, never their text.
CREATE VIEW published.article_sources AS
SELECT cur.writer_piece_id AS article_id,
       s.position,
       s.source_name,
       s.title,
       s.url,
       s.published_at
  FROM (SELECT DISTINCT ON (pp.writer_piece_id) pp.id, pp.writer_piece_id
          FROM paper_pieces pp
          JOIN papers p ON p.id = pp.paper_id
         WHERE pp.writer_piece_id IS NOT NULL
         ORDER BY pp.writer_piece_id, p.published_on DESC, p.id DESC) cur
  JOIN paper_sources s ON s.paper_piece_id = cur.id;

COMMENT ON SCHEMA published IS
  'Read interface for Fritter Board: published articles and their source links. '
  'The board''s role is granted this schema and nothing else.';
COMMENT ON VIEW published.articles IS
  'Published pieces keyed on writer_pieces.id, which survives a re-publish of the '
  'same writer run. Latest paper wins when a piece was published twice.';
