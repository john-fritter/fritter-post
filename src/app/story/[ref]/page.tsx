/**
 * One piece.
 *
 * The prose as the writers produced it, and the links out underneath. The
 * source list is the only coloured thing on the page, which is the paper's own
 * rule made visible: the paper's framing is its own, and the reporting stays
 * where it was published.
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  displayHeadline,
  paragraphs,
  readingMinutes,
} from "@/pipeline/publisher/assemble";
import { loadLatestPaper, loadPaperPiece } from "@/pipeline/publisher/read";

export const dynamic = "force-dynamic";

async function findPiece(refParam: string) {
  const paper = await loadLatestPaper();
  if (!paper) return null;
  return loadPaperPiece(paper.id, decodeURIComponent(refParam));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ ref: string }>;
}): Promise<Metadata> {
  const { ref } = await params;
  const piece = await findPiece(ref);
  if (!piece) return { title: "Not in this paper — The Fritter Post" };
  return { title: `${displayHeadline(piece)} — The Fritter Post` };
}

export default async function StoryPage({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const piece = await findPiece(ref);
  if (!piece) notFound();

  const minutes = readingMinutes(piece.wordCount);
  const body = paragraphs(piece.body);
  // A section line has no headline; its sentence leads the page instead, and
  // then must not be repeated as the body underneath it.
  const leadsOnSentence = !piece.headline || !piece.headline.trim();

  return (
    <main className="app">
      <article className="article">
        <Link className="back" href="/">
          ← All stories
        </Link>

        {piece.sectionRef && piece.sectionTitle ? (
          <p className="part-of">
            Part of{" "}
            <Link href={`/?thread=${encodeURIComponent(piece.sectionRef)}#t-${piece.sectionRef}`}>
              {piece.sectionTitle}
            </Link>
          </p>
        ) : null}

        <h1 className={leadsOnSentence ? "art-hl art-hl-line" : "art-hl"}>
          {displayHeadline(piece)}
        </h1>

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
      </article>
    </main>
  );
}
