/**
 * Reading the published paper.
 *
 * Everything the reading view needs, and nothing it doesn't. These queries hit
 * only the paper_* tables: once a paper is published it is self-contained, so
 * rendering it never touches the pipeline's working tables and never depends on
 * what the pipeline currently believes.
 */

import "dotenv/config";
import { getPool } from "../../db/index.js";
import type { PaperTier, SectionRole, Groupable } from "./assemble.js";

export interface PaperMeta {
  id: number;
  publishedOn: string;
  storyCount: number;
  pieceCount: number;
  sourceCount: number;
  wordCount: number;
}

/** A piece as the index shows it: enough to draw a row, not the whole article. */
export interface PaperPieceRow extends Groupable {
  id: number;
  rank: number;
  sectionRank: number;
  tier: PaperTier;
  ref: string;
  sectionRef: string | null;
  sectionTitle: string | null;
  sectionRole: SectionRole | null;
  headline: string | null;
  body: string;
  wordCount: number;
  /** The editor's count — what the story was ranked on. */
  sourceCount: number;
  /** How many of those actually resolved to links. Fewer means a gap. */
  resolvedSources: number;
  firstSource: string | null;
}

export interface PaperSourceRow {
  sourceName: string;
  title: string;
  url: string;
  publishedAt: Date | null;
}

export interface PaperPiece extends PaperPieceRow {
  sources: PaperSourceRow[];
}

interface RawPieceRow {
  id: string;
  rank: number;
  section_rank: number;
  tier: PaperTier;
  ref: string;
  section_ref: string | null;
  section_title: string | null;
  section_role: SectionRole | null;
  headline: string | null;
  body: string;
  word_count: number;
  source_count: number;
  resolved_sources: string;
  first_source: string | null;
}

function toRow(r: RawPieceRow): PaperPieceRow {
  return {
    id: Number(r.id),
    rank: r.rank,
    sectionRank: r.section_rank,
    tier: r.tier,
    ref: r.ref,
    sectionRef: r.section_ref,
    sectionTitle: r.section_title,
    sectionRole: r.section_role,
    headline: r.headline,
    body: r.body,
    wordCount: r.word_count,
    sourceCount: r.source_count,
    resolvedSources: Number(r.resolved_sources),
    firstSource: r.first_source,
  };
}

const PIECE_COLUMNS = `
  p.id::text, p.rank, p.section_rank, p.tier, p.ref, p.section_ref, p.section_title,
  p.section_role, p.headline, p.body, p.word_count, p.source_count,
  (SELECT COUNT(*) FROM paper_sources s WHERE s.paper_piece_id = p.id)::text
    AS resolved_sources,
  (SELECT s.source_name FROM paper_sources s WHERE s.paper_piece_id = p.id
    ORDER BY s.position LIMIT 1) AS first_source`;

/** The most recent edition, or null before the first paper is published. */
export async function loadLatestPaper(): Promise<PaperMeta | null> {
  const { rows } = await getPool().query<{
    id: number; published_on: string; story_count: number;
    piece_count: number; source_count: number; word_count: number;
  }>(
    `SELECT id, to_char(published_on, 'YYYY-MM-DD') AS published_on,
            story_count, piece_count, source_count, word_count
       FROM papers ORDER BY published_on DESC, id DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    publishedOn: r.published_on,
    storyCount: r.story_count,
    pieceCount: r.piece_count,
    sourceCount: r.source_count,
    wordCount: r.word_count,
  };
}

export async function loadPaperPieces(paperId: number): Promise<PaperPieceRow[]> {
  const { rows } = await getPool().query<RawPieceRow>(
    `SELECT ${PIECE_COLUMNS}
       FROM paper_pieces p WHERE p.paper_id = $1
      ORDER BY p.rank, p.section_rank`,
    [paperId],
  );
  return rows.map(toRow);
}

/** One piece with its links out. Null when the ref is not in this paper. */
export async function loadPaperPiece(paperId: number, ref: string): Promise<PaperPiece | null> {
  const pool = getPool();
  const { rows } = await pool.query<RawPieceRow>(
    `SELECT ${PIECE_COLUMNS}
       FROM paper_pieces p WHERE p.paper_id = $1 AND p.ref = $2`,
    [paperId, ref],
  );
  const r = rows[0];
  if (!r) return null;

  const { rows: srcs } = await pool.query<{
    source_name: string; title: string; url: string; published_at: Date | null;
  }>(
    `SELECT source_name, title, url, published_at
       FROM paper_sources WHERE paper_piece_id = $1 ORDER BY position`,
    [r.id],
  );

  return {
    ...toRow(r),
    sources: srcs.map((s) => ({
      sourceName: s.source_name,
      title: s.title,
      url: s.url,
      publishedAt: s.published_at,
    })),
  };
}

/** Every ref in a paper, for generating static routes. */
export async function loadPaperRefs(paperId: number): Promise<string[]> {
  const { rows } = await getPool().query<{ ref: string }>(
    "SELECT ref FROM paper_pieces WHERE paper_id = $1 ORDER BY rank, section_rank",
    [paperId],
  );
  return rows.map((r) => r.ref);
}
