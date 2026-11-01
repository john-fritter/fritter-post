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
  /**
   * The article's permanent id: writer_pieces.id. paper_pieces.id changes on
   * every re-publish; this one survives a re-publish of the same writer run, and
   * is what /article/<id> and Fritter Board address. Null only for a row
   * written without one, which the publisher never does.
   */
  articleId: number | null;
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

/**
 * What this paper said about this story before.
 *
 * Text, not a link. `/story/<ref>` resolves refs against the *latest* paper
 * only; yesterday's piece does have a permanent address (`/article/<id>`), but
 * the reading view's rule is that colour means exactly one thing, a link that
 * leaves for someone else's reporting, and a "previously" line is the paper
 * talking about itself.
 */
export interface PaperLineageRow {
  publishedOn: string;
  headline: string | null;
  ref: string;
}

export interface PaperPiece extends PaperPieceRow {
  sources: PaperSourceRow[];
  /** Null when this piece continues nothing, which is the common case. */
  previously: PaperLineageRow | null;
}

interface RawPieceRow {
  id: string;
  writer_piece_id: string | null;
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
    articleId: r.writer_piece_id === null ? null : Number(r.writer_piece_id),
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
  p.id::text, p.writer_piece_id::text, p.rank, p.section_rank, p.tier, p.ref, p.section_ref, p.section_title,
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

  const { rows: prev } = await pool.query<{
    prior_published_on: string; prior_headline: string | null; prior_ref: string;
  }>(
    `SELECT to_char(prior_published_on, 'YYYY-MM-DD') AS prior_published_on,
            prior_headline, prior_ref
       FROM paper_piece_lineage WHERE paper_piece_id = $1`,
    [r.id],
  );
  const pv = prev[0];

  return {
    ...toRow(r),
    sources: srcs.map((s) => ({
      sourceName: s.source_name,
      title: s.title,
      url: s.url,
      publishedAt: s.published_at,
    })),
    previously: pv
      ? {
          publishedOn: pv.prior_published_on,
          headline: pv.prior_headline,
          ref: pv.prior_ref,
        }
      : null,
  };
}

/**
 * An article by its permanent id, from the latest paper that carries it, plus
 * that paper's date. Null when no published paper has it -- a paper replaced
 * from a different writer run takes its old ids with it.
 */
export async function loadArticle(
  articleId: number,
): Promise<{ piece: PaperPiece; publishedOn: string; paperId: number } | null> {
  const { rows } = await getPool().query<{ paper_id: number; published_on: string; ref: string }>(
    `SELECT p.id AS paper_id, to_char(p.published_on, 'YYYY-MM-DD') AS published_on, pp.ref
       FROM paper_pieces pp JOIN papers p ON p.id = pp.paper_id
      WHERE pp.writer_piece_id = $1
      ORDER BY p.published_on DESC, p.id DESC LIMIT 1`,
    [articleId],
  );
  const r = rows[0];
  if (!r) return null;
  const piece = await loadPaperPiece(r.paper_id, r.ref);
  return piece ? { piece, publishedOn: r.published_on, paperId: r.paper_id } : null;
}

/** Every ref in a paper, for generating static routes. */
export async function loadPaperRefs(paperId: number): Promise<string[]> {
  const { rows } = await getPool().query<{ ref: string }>(
    "SELECT ref FROM paper_pieces WHERE paper_id = $1 ORDER BY rank, section_rank",
    [paperId],
  );
  return rows.map((r) => r.ref);
}

// --- the price -------------------------------------------------------------

/**
 * The paper's price in dollars, or null when it has none: a paper published
 * before prices were recorded, or one whose pricing failed. The masthead shows
 * no price box rather than a wrong one.
 */
export async function loadPaperPriceTotal(paperId: number): Promise<number | null> {
  const { rows } = await getPool().query<{ n: string; total: string | null }>(
    `SELECT COUNT(*)::text AS n, SUM(cost_usd)::text AS total
       FROM paper_costs WHERE paper_id = $1`,
    [paperId],
  );
  const r = rows[0];
  if (!r || r.n === "0") return null;
  return Number(r.total ?? 0);
}

export interface PaperStepRow {
  step: string;
  startedAt: Date | null;
  durationMs: number | null;
  itemsOut: number | null;
  sources: number | null;
}

export interface PaperCostRow {
  step: string;
  model: string;
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  modelMs: number;
  /** Null when the model had no list price: unpriced, not free. */
  modelLabel: string | null;
  modelName: string | null;
  maker: string | null;
  inputPerMtok: number | null;
  outputPerMtok: number | null;
  priceSource: string | null;
  priceAsOf: string | null;
  costUsd: number | null;
}

export interface PaperPrice {
  steps: PaperStepRow[];
  costs: PaperCostRow[];
  /** Pieces by tier, for "12 features, 38 standard, 84 briefs". */
  tiers: Record<PaperTier, number>;
}

/** Everything the /price page shows. Null when the paper has no price. */
export async function loadPaperPrice(paperId: number): Promise<PaperPrice | null> {
  const pool = getPool();
  const { rows: costRows } = await pool.query<{
    step: string; model: string; calls: number; failed_calls: number;
    input_tokens: string; output_tokens: string; model_ms: string;
    model_label: string | null; model_name: string | null; maker: string | null;
    input_per_mtok: string | null; output_per_mtok: string | null;
    price_source: string | null; price_as_of: string | null; cost_usd: string | null;
  }>(
    `SELECT step, model, calls, failed_calls, input_tokens::text, output_tokens::text,
            model_ms::text, model_label, model_name, maker, input_per_mtok::text,
            output_per_mtok::text, price_source,
            to_char(price_as_of, 'YYYY-MM-DD') AS price_as_of, cost_usd::text
       FROM paper_costs WHERE paper_id = $1
      ORDER BY step, model`,
    [paperId],
  );
  if (costRows.length === 0) return null;

  const { rows: stepRows } = await pool.query<{
    step: string; started_at: Date | null; duration_ms: string | null;
    items_out: number | null; sources: number | null;
  }>(
    `SELECT step, started_at, duration_ms::text, items_out, sources
       FROM paper_steps WHERE paper_id = $1 ORDER BY seq`,
    [paperId],
  );

  const { rows: tierRows } = await pool.query<{ tier: PaperTier; n: string }>(
    "SELECT tier, COUNT(*)::text AS n FROM paper_pieces WHERE paper_id = $1 GROUP BY tier",
    [paperId],
  );
  const tiers: Record<PaperTier, number> = { feature: 0, standard: 0, brief: 0 };
  for (const t of tierRows) tiers[t.tier] = Number(t.n);

  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  return {
    steps: stepRows.map((s) => ({
      step: s.step,
      startedAt: s.started_at,
      durationMs: num(s.duration_ms),
      itemsOut: s.items_out,
      sources: s.sources,
    })),
    costs: costRows.map((c) => ({
      step: c.step,
      model: c.model,
      calls: c.calls,
      failedCalls: c.failed_calls,
      inputTokens: Number(c.input_tokens),
      outputTokens: Number(c.output_tokens),
      modelMs: Number(c.model_ms),
      modelLabel: c.model_label,
      modelName: c.model_name,
      maker: c.maker,
      inputPerMtok: num(c.input_per_mtok),
      outputPerMtok: num(c.output_per_mtok),
      priceSource: c.price_source,
      priceAsOf: c.price_as_of,
      costUsd: num(c.cost_usd),
    })),
    tiers,
  };
}
