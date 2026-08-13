/**
 * HTML → plain text, with one set of options for the whole project.
 *
 * The preprocessor has stripped feed bodies this way since the beginning; the
 * article fetcher strips extracted article HTML the same way. Both want the
 * same thing — readable paragraphs with no images, no scripts, and no inline
 * link URLs cluttering the prose an LLM has to read — so the options live in one
 * place rather than being retyped per caller.
 */

import { convert, type HtmlToTextOptions } from "html-to-text";

export const HTML_TO_TEXT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "figure", format: "skip" },
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
  ],
};

/** Plain text of an HTML fragment, or null when it holds nothing readable. */
export function stripHtml(raw: string | null): string | null {
  if (!raw) return null;
  const text = convert(raw, HTML_TO_TEXT_OPTIONS).trim();
  return text.length > 0 ? text : null;
}
