/**
 * Writer prompts: a packet plus the paper's two standing documents.
 *
 * The system prompt carries the voice — `docs/voice.md`, the standing memo,
 * which is the most consequential artifact in the project and the one thing here
 * that is not derived from data. The user prompt carries the reader, the story's
 * place in the paper, and the source material the assembler selected.
 *
 * The output contract is deliberately flat, like every other parsed stage in
 * this pipeline: a headline line, a blank line, then the body. The writers stage
 * is where the paper's own headline is written — the titles upstream are
 * grouping's neutral describe-pass labels, meant for machines to rank, not for a
 * reader to read.
 */

import type { WriterPacket } from "./assembler.js";

export const VOICE_FALLBACK =
  "(The standing memo is missing. Write plainly and directly: say what happened, " +
  "name who did it, use active voice, attribute claims to whoever made them, and " +
  "do not manufacture stakes or drama.)";

export function buildWriterSystemPrompt(voice: string): string {
  return `You write for The Fritter Post, a daily newspaper with exactly one reader.

${voice}

---

HOW TO USE THE SOURCES

The source articles below are the only material you have. Everything you write must be supported by them.

- Do not add facts, figures, names, dates, or quotes that are not in the sources.
- Where sources disagree, say so plainly rather than picking one silently.
- Attribute claims to whoever made them. "Police say X" reports what police said, not that X happened.
- Where a claim is unconventional and a mainstream source supports it, cite that source — it pre-empts a framing fight.
- You are not reproducing these articles. Read them, then write the paper's own account.
- If the material is thin, write less. A short accurate piece is the correct outcome of thin material; padding is not.

OUTPUT FORMAT

Exactly this shape, and nothing else — no preamble, no notes, no markdown headings:

HEADLINE: <one line, plain and direct, saying what happened>

<the body, plain prose, paragraphs separated by a blank line>

The headline states what happened. No questions, no teasing, no "what you need to know", no colon-and-label constructions.`;
}

function formatArticle(article: WriterPacket["articles"][number], index: number): string {
  const when = article.publishedAt ? article.publishedAt.toISOString().slice(0, 16) + "Z" : "no timestamp";
  const flags: string[] = [];
  if (article.origin === "feed") flags.push("feed summary only");
  if (article.truncated) flags.push(`truncated at ${article.chars} of ${article.availableChars} chars`);
  if (article.translationFailed) flags.push("NOT TRANSLATED — original language");
  const flagLine = flags.length > 0 ? ` [${flags.join("; ")}]` : "";

  return [
    `--- SOURCE ${index + 1}: ${article.sourceName} | ${when}${flagLine}`,
    `Headline: ${article.title}`,
    `URL: ${article.url}`,
    "",
    article.text.length > 0 ? article.text : "(no body text available for this source)",
  ].join("\n");
}

export function buildWriterUserPrompt(bio: string, packet: WriterPacket): string {
  const [minWords, maxWords] = packet.targetWords;
  const parts: string[] = [];

  parts.push("THE READER", "", bio, "", "---", "");

  parts.push("THIS PIECE");
  parts.push(`Position in today's paper: rank ${packet.rank} of the ranked list, ${packet.tier} tier.`);
  parts.push(`Target length: ${minWords}–${maxWords} words.`);
  parts.push(
    `Sources behind this story: ${packet.sourceCount}` +
      (packet.articles.length !== packet.sourceCount
        ? ` (${packet.articles.length} included below)`
        : ""),
  );
  if (packet.summary.length > 0) {
    parts.push(`What upstream clustering called it: ${packet.title} — ${packet.summary}`);
    // The label is generated from every article in the cluster, including the
    // ones the budget left out, so it routinely names events the sources below
    // do not cover. Run #112's T3 summary listed a refinery strike, an
    // assassination, a body exchange and a border-control change; the twelve
    // included sources supported some of that and not the rest. A writer who
    // treats the label as reporting will write unsupported claims in the
    // paper's own voice, which is the one failure mode nothing downstream can
    // catch.
    parts.push(
      "That title and summary are machine-generated labels used for ranking. They are " +
        "NOT source material and NOT evidence: they may name events no source below " +
        "reports. Write your own headline, and take every fact from the sources.",
    );
  } else {
    parts.push(`Working title from the source: ${packet.title}`);
    parts.push("That title is the source's own. Write your own headline.");
  }

  if (packet.notes.length > 0) {
    parts.push("", "NOTES ON THE MATERIAL");
    for (const note of packet.notes) parts.push(`- ${note}`);
  }

  if (packet.omitted.length > 0) {
    parts.push(
      "",
      `${packet.omitted.length} further source(s) covering this story were left out for length. ` +
        "They are not new information; do not refer to them.",
    );
  }

  parts.push("", "---", "", `SOURCE MATERIAL (${packet.articles.length} article(s))`, "");
  packet.articles.forEach((article, i) => {
    parts.push(formatArticle(article, i), "");
  });

  parts.push("---", "", `Write the piece. ${minWords}–${maxWords} words.`);

  return parts.join("\n");
}

export interface ParsedWriterOutput {
  headline: string;
  body: string;
}

/**
 * Parses the writer's output. Recognition-based rather than strict: models
 * decorate a labelled line with bold markers, quotes, or a stray heading hash,
 * and losing a whole piece to that would be absurd. A response with no
 * recognizable headline line yields null, and the caller decides what a missing
 * piece means for the paper.
 */
export function parseWriterOutput(text: string): ParsedWriterOutput | null {
  const lines = text.split(/\r?\n/);
  let headline: string | null = null;
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    const match = line.match(/^#{0,3}\s*\**\s*headline\s*\**\s*[::]\s*(.+)$/i);
    if (match) {
      headline = match[1]!.trim().replace(/^\**|\**$/g, "").replace(/^["'“]|["'”]$/g, "").trim();
      bodyStart = i + 1;
    }
    break; // the headline is the first non-empty line or it is absent
  }

  if (headline === null || headline.length === 0) return null;

  const body = lines.slice(bodyStart).join("\n").trim();
  if (body.length === 0) return null;

  return { headline, body };
}
