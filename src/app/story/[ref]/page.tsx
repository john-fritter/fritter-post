/**
 * One piece of today's paper, addressed by its ref.
 *
 * Refs are run-local — C27 today is not C27 tomorrow — so this address only
 * ever means the latest paper. The permanent address is `/article/<id>`.
 */

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { displayHeadline } from "@/pipeline/publisher/assemble";
import { loadLatestPaper, loadPaperPiece } from "@/pipeline/publisher/read";
import { ArticleView } from "../../_components/article";

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
  return <ArticleView piece={piece} earlierEdition={null} />;
}
