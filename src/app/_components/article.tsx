/**
 * One piece, as a page.
 *
 * The prose as the writers produced it, and the links out underneath. The
 * source list is the only coloured thing on the page, which is the paper's own
 * rule made visible: the paper's framing is its own, and the reporting stays
 * where it was published.
 *
 * Shared by the two addresses a piece has: `/story/<ref>`, which resolves
 * against today's paper, and `/article/<id>`, which is permanent.
 */

import Link from "next/link";
import {
  boardDiscussUrl,
  displayHeadline,
  formatEditionDate,
  formatMarkerDate,
  paragraphs,
  readingMinutes,
} from "@/pipeline/publisher/assemble";
import { lineageLabel } from "@/pipeline/lineage/select";
import type { PaperPiece } from "@/pipeline/publisher/read";

export function ArticleView({
  piece,
  earlierEdition,
}: {
  piece: PaperPiece;
  /** The edition's date when it is not today's paper; null for today's. */
  earlierEdition: string | null;
}) {
  const minutes = readingMinutes(piece.wordCount);
  const body = paragraphs(piece.body);
  // A section line has no headline; its sentence leads the page instead, and
  // then must not be repeated as the body underneath it.
  const leadsOnSentence = !piece.headline || !piece.headline.trim();
  // Null when nothing was linked, and also when the prior piece was a section
  // line with no headline of its own — a pointer to a pointer is not worth a row.
  const previously = piece.previously
    ? lineageLabel(
        { priorPublishedOn: piece.previously.publishedOn, priorHeadline: piece.previously.headline },
        formatMarkerDate,
      )
    : null;
  // Read per request: the board's address is deployment configuration.
  const discuss = boardDiscussUrl(process.env["BOARD_URL"], piece.articleId);
  // Only today's paper has the index this section link points into.
  const sectionLink = earlierEdition === null && piece.sectionRef && piece.sectionTitle;

  return (
    <main className="app">
      <article className="article">
        <Link className="back" href="/">
          {earlierEdition === null ? "← All stories" : "← Today’s paper"}
        </Link>

        {earlierEdition !== null ? (
          <p className="part-of">From the paper of {formatEditionDate(earlierEdition)}</p>
        ) : null}

        {sectionLink ? (
          <p className="part-of">
            Part of{" "}
            <Link href={`/?thread=${encodeURIComponent(piece.sectionRef!)}#t-${piece.sectionRef}`}>
              {piece.sectionTitle}
            </Link>
          </p>
        ) : earlierEdition !== null && piece.sectionTitle ? (
          <p className="part-of">Part of {piece.sectionTitle}</p>
        ) : null}

        <h1 className={leadsOnSentence ? "art-hl art-hl-line" : "art-hl"}>
          {displayHeadline(piece)}
        </h1>

        {previously ? (
          <p className="art-prev">
            <span className="art-prev-label">Previously</span>
            {previously}
          </p>
        ) : null}

        <p className="art-meta">
          No. {piece.rank}
          <span className="sep">·</span>
          {piece.wordCount} words
          {minutes !== null ? (
            <>
              <span className="sep">·</span>
              {minutes} min
            </>
          ) : null}
        </p>

        {leadsOnSentence ? null : (
          <div className="art-body">
            {body.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        )}

        <footer className="art-srcs">
          <h2>{piece.sources.length === 1 ? "Source" : `${piece.sources.length} sources`}</h2>
          {piece.sources.length === 0 ? (
            <p className="none">No source could be resolved for this piece.</p>
          ) : (
            <p>
              {piece.sources.map((s, i) => (
                <span key={s.url}>
                  {i > 0 ? <span className="sep">·</span> : null}
                  <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>
                    {s.sourceName}
                  </a>
                </span>
              ))}
            </p>
          )}
        </footer>

        {/* Uncoloured on purpose: colour is reserved for other people's
            reporting, and the board is the paper's own neighbour. */}
        {discuss ? (
          <p className="art-discuss">
            <a href={discuss}>Discuss on the board</a>
          </p>
        ) : null}
      </article>
    </main>
  );
}
