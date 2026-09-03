/**
 * Cross-day story lineage — "what this paper already said about this story".
 *
 * Runs inside the publisher, after the paper is frozen. It is not a stage of its
 * own because it has no independent input: it reads the paper that was just
 * written and the papers before it, and the publisher is already the place that
 * turns a writer run into an artifact with attribution attached. Adding
 * continuity there keeps the pipeline at nine stages.
 *
 * THE DATA WAS ALREADY THERE. `item_embeddings` is keyed on
 * `preprocessed_item_id`, is upserted by every grouping run, and — unlike
 * `article_texts` — is never swept. `paper_sources.preprocessed_item_id` links
 * every published piece back to the items behind it. So "did we cover this
 * before" is a vector query over rows that have been accumulating since the
 * project started; nothing had to be collected first, and no backfill is needed.
 *
 * THE VECTOR MATHS STAYS IN POSTGRES. pgvector computes 4096-dimension cosine
 * distance in C, next to the data. Pulling those vectors into Node to compare
 * them here would ship megabytes per run to do the same arithmetic slower. What
 * crosses the boundary is a small scored candidate list; the policy over it is
 * pure and tested in `select.ts`.
 */

import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { selectLineageLinks, type LineageCandidate } from "./select.js";

export interface LineageResult {
  linked: number;
  /** Pieces that had a candidate scored but none above the threshold. */
  nearMisses: number;
  skipped: boolean;
}

interface CandidateRow {
  paper_piece_id: string;
  ref: string;
  prior_paper_id: number;
  prior_paper_piece_id: string;
  prior_published_on: string;
  prior_ref: string;
  prior_headline: string | null;
  similarity: number;
}

/**
 * Score every piece of `paperId` against the pieces of recent papers and record
 * the best link per piece.
 *
 * Additive and idempotent: it deletes this paper's existing lineage rows first,
 * so re-publishing a date recomputes rather than accumulating. Runs outside the
 * publisher's own transaction on purpose — a paper with no "previously" markers
 * is a complete paper, and a failure here must not roll back an edition that is
 * otherwise ready to read.
 */
export async function buildPaperLineage(
  paperId: number,
  publishedOn: string,
): Promise<LineageResult> {
  const cfg = loadModelConfig().publisher.lineage;
  if (!cfg.enabled) return { linked: 0, nearMisses: 0, skipped: true };

  const pool = getPool();

  // One statement, because the alternative is shipping every vector twice.
  //
  //   today  — this paper's pieces and the items behind them
  //   prior  — the same for papers inside the lookback, strictly earlier
  //   pairs  — max cosine between ANY article of one and ANY article of the
  //            other. Max rather than centroid: a cluster's items are the same
  //            event by construction and a section's pieces are partitioned by
  //            member, so the strongest single pairing is the honest measure of
  //            "these two pieces are about the same thing". A centroid over a
  //            thread's eleven members would dilute exactly the signal wanted.
  //   ranked — top_k per piece, so an audit can see the near misses that say
  //            whether the threshold sits in the right place.
  const { rows } = await pool.query<CandidateRow>(
    `
    WITH today AS (
      SELECT pp.id AS piece_id, pp.ref, ps.preprocessed_item_id AS item_id
      FROM paper_pieces pp
      JOIN paper_sources ps ON ps.paper_piece_id = pp.id
      WHERE pp.paper_id = $1 AND ps.preprocessed_item_id IS NOT NULL
    ),
    prior AS (
      SELECT pp.id AS piece_id, pp.ref, pp.headline,
             p.id AS paper_id, p.published_on,
             ps.preprocessed_item_id AS item_id
      FROM paper_pieces pp
      JOIN papers p ON p.id = pp.paper_id
      JOIN paper_sources ps ON ps.paper_piece_id = pp.id
      WHERE p.id <> $1
        AND p.published_on <  $2::date
        AND p.published_on >= $2::date - $3::int
        AND ps.preprocessed_item_id IS NOT NULL
    ),
    pairs AS (
      SELECT t.piece_id, t.ref,
             pr.paper_id AS prior_paper_id, pr.piece_id AS prior_piece_id,
             pr.published_on AS prior_published_on, pr.ref AS prior_ref,
             pr.headline AS prior_headline,
             max(1 - (te.embedding <=> pe.embedding)) AS similarity
      FROM today t
      JOIN item_embeddings te ON te.preprocessed_item_id = t.item_id
      CROSS JOIN prior pr
      JOIN item_embeddings pe ON pe.preprocessed_item_id = pr.item_id
      GROUP BY t.piece_id, t.ref, pr.paper_id, pr.piece_id,
               pr.published_on, pr.ref, pr.headline
    ),
    ranked AS (
      SELECT *, row_number() OVER (
               PARTITION BY piece_id ORDER BY similarity DESC, prior_ref
             ) AS rn
      FROM pairs
    )
    SELECT piece_id::text            AS paper_piece_id,
           ref,
           prior_paper_id,
           prior_piece_id::text      AS prior_paper_piece_id,
           to_char(prior_published_on, 'YYYY-MM-DD') AS prior_published_on,
           prior_ref,
           prior_headline,
           similarity::float8        AS similarity
    FROM ranked
    WHERE rn <= $4
    `,
    [paperId, publishedOn, cfg.lookback_days, cfg.top_k],
  );

  const candidates: LineageCandidate[] = rows.map((r) => ({
    paperPieceId: r.paper_piece_id,
    ref: r.ref,
    priorPaperId: r.prior_paper_id,
    priorPaperPieceId: r.prior_paper_piece_id,
    priorPublishedOn: r.prior_published_on,
    priorRef: r.prior_ref,
    priorHeadline: r.prior_headline,
    similarity: r.similarity,
  }));

  const links = selectLineageLinks(candidates, {
    threshold: cfg.similarity_threshold,
  });

  const linkedPieces = new Set(links.map((l) => l.paperPieceId));
  const scoredPieces = new Set(candidates.map((c) => c.paperPieceId));
  const nearMisses = [...scoredPieces].filter((id) => !linkedPieces.has(id)).length;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM paper_piece_lineage WHERE paper_id = $1", [paperId]);
    for (const l of links) {
      await client.query(
        `INSERT INTO paper_piece_lineage
           (paper_id, paper_piece_id, prior_paper_id, prior_paper_piece_id,
            prior_published_on, prior_ref, prior_headline, similarity)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          paperId, l.paperPieceId, l.priorPaperId, l.priorPaperPieceId,
          l.priorPublishedOn, l.priorRef, l.priorHeadline, l.similarity,
        ],
      );
    }
    await client.query("UPDATE papers SET pieces_with_lineage = $1 WHERE id = $2", [
      links.length, paperId,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { linked: links.length, nearMisses, skipped: false };
}
