/**
 * Stage 9: the publisher.
 *
 * Takes a writer run and freezes it into a paper — the prose as written, plus
 * the attribution resolved from the lineage underneath it. No judgment: every
 * editorial decision was made upstream, and this stage reorders nothing,
 * rewrites nothing and drops nothing except pieces the writers never produced.
 *
 * The one thing it adds is source links, and that is the reason it exists as a
 * stage rather than as a query. writer_pieces stores a source *count* and no
 * URLs; reaching the articles means the three-deep walk in writers/materials.ts.
 * Doing that per page load would put the writers' resolver on the reader's
 * critical path, and — the real argument — would make yesterday's paper a view
 * of today's database. See migrations/041_publisher.sql.
 *
 * TOLERANT BY DESIGN, and it records what it tolerated. A writer piece that
 * failed is skipped and counted; a piece whose articles will not resolve is
 * published anyway, with no links, and counted separately. Neither costs the
 * edition. `papers.pieces_skipped` and `papers.pieces_unsourced` are how a
 * report says which happened without anyone reading stdout.
 */

import "dotenv/config";
import { getPool } from "../../db/index.js";
import { latestWriterRunId, resolveRunId } from "../../db/latest.js";
import { loadModelConfig } from "../../config/models.js";
import { buildPaperLineage } from "../lineage/index.js";
import { loadEditorRunMaterials, type StoryMaterials } from "../writers/materials.js";
import {
  buildIndex,
  replacementShortfall,
  resolvePieceSources,
  type PublishablePiece,
  type PaperTier,
  type SectionRole,
} from "./assemble.js";

/**
 * The reader's local day. "Today's paper" means today in Bend, not in UTC, and
 * a run that starts at 5pm Pacific must not publish tomorrow's date. Overridable
 * because the timezone is deployment configuration, not a fact about the code.
 */
const PAPER_TIMEZONE = process.env["PAPER_TIMEZONE"] ?? "America/Los_Angeles";

export interface PaperSummary {
  paperId: number;
  publishedOn: string;
  writerRunId: number;
  editorRunId: number;
  storyCount: number;
  pieceCount: number;
  sourceCount: number;
  wordCount: number;
  piecesSkipped: number;
  piecesUnsourced: number;
  replaced: boolean;
  /** Pieces carrying a "previously" marker into a recent paper. */
  lineageLinked: number;
  /** Pieces in the paper this one replaced, or null if it replaced nothing. */
  replacedPieceCount: number | null;
}

interface WriterPieceRow {
  id: string;
  editor_story_id: string | null;
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
}

function toPublishable(row: WriterPieceRow): PublishablePiece {
  return {
    writerPieceId: Number(row.id),
    editorStoryId: row.editor_story_id === null ? null : Number(row.editor_story_id),
    rank: row.rank,
    sectionRank: row.section_rank,
    tier: row.tier,
    ref: row.ref,
    sectionRef: row.section_ref,
    sectionTitle: row.section_title,
    sectionRole: row.section_role,
    headline: row.headline,
    body: row.body,
    wordCount: row.word_count,
    sourceCount: row.source_count,
  };
}

export interface RunPublisherOptions {
  /** Defaults to the latest completed writer run, as the middle stages do. */
  writerRunId?: number;
  /** Override the edition date (YYYY-MM-DD). Defaults to the run's local day. */
  date?: string;
  /**
   * Replace an existing paper even when the replacement is substantially
   * smaller. The deliberate path for a re-publish that is meant to shrink the
   * edition; without it the publisher refuses rather than destroying a bigger
   * paper the reader already has.
   */
  force?: boolean;
}

export async function runPublisher(options: RunPublisherOptions): Promise<PaperSummary> {
  const pool = getPool();
  const writerRunId = await resolveRunId(options.writerRunId, latestWriterRunId, "writer run");

  const { rows: runRows } = await pool.query<{ editor_run_id: number; local_day: string }>(
    `SELECT editor_run_id,
            to_char((started_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS local_day
       FROM writer_runs WHERE id = $1`,
    [writerRunId, PAPER_TIMEZONE],
  );
  const run = runRows[0];
  if (!run) throw new Error(`Writer run #${writerRunId} not found`);

  const publishedOn = options.date ?? run.local_day;
  const editorRunId = run.editor_run_id;

  // 'cut' is a tier writer_pieces allows and a paper has no slot for.
  const { rows: pieceRows } = await pool.query<WriterPieceRow>(
    `SELECT id::text, editor_story_id::text, rank, section_rank, tier, ref,
            section_ref, section_title, section_role, headline, body,
            word_count, source_count
       FROM writer_pieces
      WHERE run_id = $1 AND status = 'ok' AND body IS NOT NULL AND tier <> 'cut'
      ORDER BY rank, section_rank`,
    [writerRunId],
  );

  const { rows: skipRows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM writer_pieces
      WHERE run_id = $1 AND (status <> 'ok' OR body IS NULL)`,
    [writerRunId],
  );
  const piecesSkipped = Number(skipRows[0]?.n ?? 0);

  if (pieceRows.length === 0) {
    throw new Error(
      `Writer run #${writerRunId} has no publishable pieces ` +
        `(${piecesSkipped} failed). Try: npm run write -- --repair ${writerRunId}`,
    );
  }

  const pieces = pieceRows.map(toPublishable);

  // **A re-publish must not be able to shrink the edition by accident.**
  //
  // Re-publishing a date replaces it, which is right for correcting a morning
  // and wrong for a second run on the same day: cross-run dedup means that run
  // sees only the hours since the first, so it assembles a small paper and every
  // stage's counters look healthy, because each one is fine in isolation. Run
  // four hours after the timer, a 150-piece edition becomes a 56-piece one with
  // nine `ok` gates and nothing to read afterwards saying what happened.
  //
  // This is the only place in the pipeline where a stage guards something the
  // reader already has, so it refuses rather than warns. A warning arrives after
  // the delete, and the smaller paper is strictly worse than the one it
  // destroyed. `--force` is the deliberate path.
  const { rows: existingRows } = await pool.query<{ piece_count: number }>(
    "SELECT piece_count FROM papers WHERE published_on = $1",
    [publishedOn],
  );
  const existingPieceCount = existingRows[0]?.piece_count ?? null;

  if (existingPieceCount !== null && !options.force) {
    const floor = loadModelConfig().pipeline.gates.publisher.min_replacement_fraction;
    const short = replacementShortfall(existingPieceCount, pieces.length, floor);
    if (short !== null) {
      throw new Error(
        `Refusing to replace the paper for ${publishedOn}: it has ${short.existingPieceCount} ` +
          `piece(s) and writer run #${writerRunId} would publish ${short.newPieceCount} ` +
          `(${(short.ratio * 100).toFixed(0)}%, floor ${(floor * 100).toFixed(0)}%).\n` +
          `If this is a second run today, cross-run dedup has already given the earlier ` +
          `run today's news and this one saw only the hours since — the existing paper is ` +
          `the better one.\nTo replace it anyway: npm run publish -- --writer-run ` +
          `${writerRunId} --force`,
      );
    }
  }

  // The writers' own resolver, reused rather than reimplemented. It is the only
  // thing that knows how to walk thread -> cluster -> item.
  const materials = await loadEditorRunMaterials(editorRunId);
  const materialsByRef = new Map<string, StoryMaterials>(materials.map((m) => [m.ref, m]));

  const sourcesByPiece = pieces.map((p) => resolvePieceSources(p, materialsByRef));
  const piecesUnsourced = sourcesByPiece.filter((s) => s.length === 0).length;
  const sourceTotal = sourcesByPiece.reduce((a, s) => a + s.length, 0);
  const wordTotal = pieces.reduce((a, p) => a + p.wordCount, 0);
  const storyCount = buildIndex(pieces).length;

  const client = await pool.connect();
  let paperId: number;
  let replaced = false;
  try {
    await client.query("BEGIN");

    // Re-publishing a date replaces it. A paper is one artifact per morning, and
    // a re-run should correct it rather than sit beside it.
    const { rowCount } = await client.query("DELETE FROM papers WHERE published_on = $1", [
      publishedOn,
    ]);
    replaced = (rowCount ?? 0) > 0;

    const { rows: paperRows } = await client.query<{ id: number }>(
      `INSERT INTO papers (published_on, writer_run_id, editor_run_id, started_at,
                           story_count, piece_count, source_count, word_count,
                           pieces_skipped, pieces_unsourced)
       VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        publishedOn, writerRunId, editorRunId, storyCount, pieces.length,
        sourceTotal, wordTotal, piecesSkipped, piecesUnsourced,
      ],
    );
    paperId = paperRows[0]!.id;

    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO paper_pieces (paper_id, writer_piece_id, editor_story_id, rank,
                                   section_rank, tier, ref, section_ref, section_title,
                                   section_role, headline, body, word_count, source_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id::text`,
        [
          paperId, p.writerPieceId, p.editorStoryId, p.rank, p.sectionRank, p.tier,
          p.ref, p.sectionRef, p.sectionTitle, p.sectionRole, p.headline, p.body,
          p.wordCount, p.sourceCount,
        ],
      );
      const pieceId = inserted[0]!.id;

      for (const s of sourcesByPiece[i]!) {
        await client.query(
          `INSERT INTO paper_sources (paper_id, paper_piece_id, preprocessed_item_id,
                                      source_name, source_type, title, url,
                                      published_at, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            paperId, pieceId, s.preprocessedItemId, s.sourceName, s.sourceType,
            s.title, s.url, s.publishedAt, s.position,
          ],
        );
      }
    }

    await client.query("UPDATE papers SET completed_at = NOW() WHERE id = $1", [paperId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Continuity, after attribution. Deliberately outside the transaction above:
  // a paper with no "previously" markers is a complete paper, and a failure to
  // find them must not roll back an edition that is otherwise ready to read.
  let lineageLinked = 0;
  try {
    const lineage = await buildPaperLineage(paperId, publishedOn);
    lineageLinked = lineage.linked;
    if (!lineage.skipped) {
      console.log(
        `[publisher] lineage: ${lineage.linked} piece(s) continue a story from a ` +
          `recent paper (${lineage.nearMisses} scored but below threshold)`,
      );
    }
  } catch (err) {
    console.warn(
      `[publisher] lineage pass failed, paper published without continuity markers: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  console.log(
    `[publisher] paper #${paperId} for ${publishedOn}${replaced ? " (replaced)" : ""}: ` +
      `${storyCount} stories, ${pieces.length} pieces, ${sourceTotal} source links, ` +
      `${wordTotal} words`,
  );
  if (piecesSkipped > 0) {
    console.warn(
      `[publisher] ${piecesSkipped} writer piece(s) failed and are not in the paper. ` +
        `Recover them with: npm run write -- --repair ${writerRunId}`,
    );
  }
  if (piecesUnsourced > 0) {
    console.warn(
      `[publisher] ${piecesUnsourced} published piece(s) resolved to zero sources — ` +
        `the reader cannot follow those to anyone's reporting. ` +
        `Diagnose with: npm run inspect -- materials --editor-run ${editorRunId}`,
    );
  }

  return {
    paperId, publishedOn, writerRunId, editorRunId, storyCount,
    pieceCount: pieces.length, sourceCount: sourceTotal, wordCount: wordTotal,
    piecesSkipped, piecesUnsourced, replaced, lineageLinked,
    replacedPieceCount: replaced ? existingPieceCount : null,
  };
}
