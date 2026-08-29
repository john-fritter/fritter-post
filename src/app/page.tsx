/**
 * The index — the paper itself.
 *
 * 120-odd rows in the editor's rank order. A thread expands in place to show
 * what is inside it; every other row opens that piece's page. Tier is carried
 * by type scale, so a feature reads as a feature without a badge saying so.
 */

import Link from "next/link";
import {
  buildIndex,
  displayHeadline,
  sourceLabel,
  formatEditionDate,
  WORDS_PER_MINUTE,
} from "@/pipeline/publisher/assemble";
import { loadLatestPaper, loadPaperPieces, type PaperPieceRow } from "@/pipeline/publisher/read";

// The paper changes once a day, but it is the database that says when — so the
// page is rendered per request rather than cached against a build.
export const dynamic = "force-dynamic";

function Row({ piece, member = false }: { piece: PaperPieceRow; member?: boolean }) {
  const label = sourceLabel(piece);
  return (
    <Link className={`row k-${piece.tier}`} href={`/story/${encodeURIComponent(piece.ref)}`}>
      {member ? null : <span className="rank">{piece.rank}</span>}
      <span className="row-main">
        {label ? <span className="eyebrow">{label}</span> : null}
        <span className="hl">{displayHeadline(piece)}</span>
      </span>
      <span className="go" aria-hidden="true">
        →
      </span>
    </Link>
  );
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string }>;
}) {
  const { thread: openThread } = await searchParams;
  const paper = await loadLatestPaper();

  if (!paper) {
    return (
      <main className="app">
        <header className="masthead">
          <h1 className="flag">The Fritter Post</h1>
        </header>
        <div className="empty">
          <h2>No edition yet</h2>
          <p>Run the pipeline, then publish a writer run.</p>
        </div>
      </main>
    );
  }

  const pieces = await loadPaperPieces(paper.id);
  const rows = buildIndex(pieces);
  const minutes = Math.round(paper.wordCount / WORDS_PER_MINUTE);
  const threadCount = rows.filter((r) => r.kind === "thread").length;

  return (
    <main className="app">
      <header className="masthead">
        <p className="kicker">{formatEditionDate(paper.publishedOn)}</p>
        <h1 className="flag">The Fritter Post</h1>
        <p className="folio">
          {rows.length} stories
          {threadCount > 0 ? (
            <>
              <span className="sep">·</span>
              {threadCount} ongoing
            </>
          ) : null}
          <span className="sep">·</span>
          {minutes} min if you read all of it
        </p>
      </header>

      <nav className="list">
        {rows.map((row) =>
          row.kind === "piece" ? (
            <Row key={row.piece.ref} piece={row.piece} />
          ) : (
            <details
              className="thread"
              key={row.ref}
              id={`t-${row.ref}`}
              open={openThread === row.ref}
            >
              <summary className="row k-thread">
                <span className="rank">{row.rank}</span>
                <span className="row-main">
                  <span className="eyebrow">
                    Ongoing<span className="sep">·</span>
                    {row.members.length} stories
                  </span>
                  <span className="hl">{row.title}</span>
                </span>
                <span className="go chev" aria-hidden="true">
                  ▸
                </span>
              </summary>
              <div className="members">
                {row.members.map((m) => (
                  <Row key={m.ref} piece={m} member />
                ))}
              </div>
            </details>
          ),
        )}
      </nav>

      <footer className="endmark">
        <p className="thirty">— 30 —</p>
        <p className="end-note">That is the whole paper. There is no more.</p>
      </footer>
    </main>
  );
}
