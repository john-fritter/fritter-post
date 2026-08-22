/**
 * Article extraction: publisher HTML → the prose a writer can read.
 *
 * Readability (the algorithm Firefox's reader mode uses) scores a document's
 * blocks and returns the one that looks like the article, then html-to-text
 * turns that fragment into paragraphs. `html-to-text` alone is not enough: run
 * against a whole news page it returns the nav, the cookie banner, the "related
 * stories" rail and the footer, and a writer prompt built from that is worse
 * than the RSS teaser it was meant to replace.
 *
 * **There is deliberately no whole-document fallback.** When Readability finds
 * no article, the honest answer is that we did not get one — the fetch is marked
 * thin and the assembler falls back to the feed text. Shipping nav soup into a
 * writer prompt would be indistinguishable, to the model, from reporting.
 *
 * The extracted text is used to write the paper and is never published: the
 * paper's framing and summaries are its own, and full text stays at the source.
 */

import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { stripHtml } from "../../lib/html.js";

export interface ExtractedArticle {
  /** Article prose as paragraphs, or "" when nothing article-shaped was found. */
  text: string;
  /** Readability's own title guess, useful for spotting a device-check page. */
  title: string | null;
  chars: number;
}

const EMPTY: ExtractedArticle = { text: "", title: null, chars: 0 };

/**
 * Extracts article text from an HTML document. Never throws: a malformed page,
 * a JavaScript shell with no content, or a Readability failure all return an
 * empty result, because one publisher's broken markup must not take down a
 * batch of 139 fetches.
 */
export function extractArticle(html: string): ExtractedArticle {
  if (!html || html.trim().length === 0) return EMPTY;

  try {
    const { document } = parseHTML(html);
    // Readability's DOM surface is narrower than linkedom's typing; the cast is
    // confined to this one call rather than leaking into the module's types.
    const parsed = new Readability(document as never).parse();
    if (!parsed) return EMPTY;

    const text = stripHtml(parsed.content ?? null) ?? "";
    return { text, title: parsed.title ?? null, chars: text.length };
  } catch {
    return EMPTY;
  }
}
