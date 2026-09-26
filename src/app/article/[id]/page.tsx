/**
 * One piece, at its permanent address.
 *
 * `/story/<ref>` only ever means today's paper, because refs are run-local.
 * This address uses the article id (writer_pieces.id), which survives a
 * re-publish of the same writer run, so it still works next week — and it is
 * what Fritter Board links to from a discussion thread. See
 * migrations/046_published_articles.sql for why it is that id and not another.
 */

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { displayHeadline } from "@/pipeline/publisher/assemble";
import { loadArticle, loadLatestPaper } from "@/pipeline/publisher/read";
import { ArticleView } from "../../_components/article";

export const dynamic = "force-dynamic";

async function findArticle(idParam: string) {
  if (!/^\d{1,15}$/.test(idParam)) return null;
  return loadArticle(Number(idParam));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const found = await findArticle(id);
  if (!found) return { title: "Not in the paper — The Fritter Post" };
  return { title: `${displayHeadline(found.piece)} — The Fritter Post` };
}

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [found, latest] = await Promise.all([findArticle(id), loadLatestPaper()]);
  if (!found) notFound();
  const earlierEdition = latest && latest.id === found.paperId ? null : found.publishedOn;
  return <ArticleView piece={found.piece} earlierEdition={earlierEdition} />;
}
