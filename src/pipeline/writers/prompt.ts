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
import { normalizeRef } from "../../lib/refs.js";

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
- You are not required to use every source. Sources that do not bear on the piece's central development are corroboration you may leave out; more sources mean more confidence, not more words.

OUTPUT FORMAT

Exactly this shape, and nothing else — no preamble, no notes, no markdown headings:

HEADLINE: <one line, plain and direct, saying what happened>

<the body, plain prose, paragraphs separated by a blank line>

The headline states what happened, in one clause. If it needs an "as" clause or a list of three nouns to cover the piece, the piece has no focus — find the focus first, then write the headline for that. No questions, no teasing, no "what you need to know", no colon-and-label constructions.`;
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

/**
 * What to do with a packet holding more than one event.
 *
 * A thread is several events in one continuing situation, and the honest way to
 * write 500 words about it is to lead with the development that matters now
 * rather than to tour all twelve. A cluster is one event seen by several
 * outlets, which is a different instruction: use the range to establish what
 * happened and say where accounts differ. A singleton needs neither.
 */
function focusInstruction(packet: WriterPacket): string | null {
  if (packet.itemType === "thread") {
    return (
      "This story is a thread: several related events that belong to one continuing " +
      "situation. Pick the development that matters most to this reader now, lead with it, " +
      "and build the piece around it. The other sources are context and corroboration — use " +
      "what bears on that spine and leave out what does not. A piece that touches every " +
      "source in turn is a list of things that happened, not an article."
    );
  }
  if (packet.articles.length > 1) {
    return (
      "These sources cover one event. Use the range of them to establish what happened and " +
      "to say plainly where accounts differ — that is what several sources buy you. It does " +
      "not mean the piece should be longer than one event's worth."
    );
  }
  return null;
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

  // Run #1's first three features came back at 716, 534 and 661 words against a
  // 400-600 target, and the two long ones read as roundups. The shortest and
  // best had four members; the two that sprawled had twelve. Sprawl tracks the
  // number of distinct events in the packet, so the instruction to find a spine
  // belongs where that number is known.
  const focus = focusInstruction(packet);
  if (focus !== null) {
    parts.push("", "FOCUS", focus);
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

  parts.push(
    "---",
    "",
    `Write the piece. ${minWords}–${maxWords} words — ${maxWords} is a ceiling, not a ` +
      "target. If the material will not fit, cut what the headline does not promise rather " +
      "than writing longer.",
  );

  return parts.join("\n");
}

// --- briefs, written in batches ---

/**
 * Briefs are 25–45 words each and the paper carries 75 of them. One call per
 * brief would be 75 calls that each re-send the bio and the standing memo — the
 * scaffolding would outweigh the writing several times over. A batch sends the
 * documents once and the material for `n` briefs after them.
 *
 * The output is the pipeline's usual flat line format, `ref;;headline;;body`,
 * with the body last so a `;;` inside it cannot shift a column.
 */
export function buildBriefBatchUserPrompt(bio: string, packets: WriterPacket[]): string {
  const parts: string[] = ["THE READER", "", bio, "", "---", ""];

  parts.push(
    `BRIEFS TO WRITE (${packets.length})`,
    "",
    "Each item below is one brief. They are unrelated to each other — do not " +
      "connect them, and do not let one brief's subject colour another's.",
    "",
  );

  for (const packet of packets) {
    const [minWords, maxWords] = packet.targetWords;
    parts.push(`=== ${packet.ref} — rank ${packet.rank}, ${minWords}–${maxWords} words`);
    if (packet.notes.length > 0) {
      for (const note of packet.notes) parts.push(`Note: ${note}`);
    }
    packet.articles.forEach((article, i) => {
      parts.push(formatArticle(article, i));
    });
    parts.push("");
  }

  parts.push(
    "---",
    "",
    "Output one line per brief, in this exact format, and nothing else:",
    "",
    "ref;;headline;;body",
    "",
    "The ref is the identifier above (for example " + (packets[0]?.ref ?? "S12345") + "). " +
      "Two semicolons separate the fields. The body is plain prose on one line, " +
      "no line breaks. Write every brief listed, once each, in the order given.",
  );

  return parts.join("\n");
}

export interface ParsedBrief {
  ref: string;
  headline: string;
  body: string;
}

/**
 * Parses a brief batch: one `ref;;headline;;body` line each. Unknown refs are
 * dropped (a model occasionally invents one) and the first line for a ref wins.
 * Missing refs are the caller's problem to record — a brief that did not come
 * back is a failed piece, not a silent gap.
 */
export function parseBriefBatchOutput(text: string, validRefs: string[]): Map<string, ParsedBrief> {
  const valid = new Set(validRefs.map((r) => r.toUpperCase()));
  const out = new Map<string, ParsedBrief>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const first = line.indexOf(";;");
    if (first === -1) continue;
    const second = line.indexOf(";;", first + 2);
    if (second === -1) continue;

    const ref = normalizeRef(line.slice(0, first));
    if (ref === null || !valid.has(ref) || out.has(ref)) continue;

    const headline = line.slice(first + 2, second).trim();
    const body = line.slice(second + 2).trim();
    if (headline.length === 0 || body.length === 0) continue;

    out.set(ref, { ref, headline, body });
  }

  return out;
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
