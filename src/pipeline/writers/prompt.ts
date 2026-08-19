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
- A characterization is a claim, not a description. "Resettled after the war" is reporting; "from countries the U.S. destabilized" is an argument. Causes, motives, and histories all need a source standing behind them, or the fact that supports them stated plainly instead.
- Comparatives and superlatives are measurements: "largest", "first", "worst", "most", "outpaced every other". Unless a source states the comparison, do not make it — a source reporting a sixfold rise, and separately that it is among the largest on record, does not support "outpaced every other group". Give the number instead.

OUTPUT FORMAT

Exactly this shape, and nothing else — no preamble, no notes, no markdown headings:

HEADLINE: <one line, plain and direct, saying what happened>

<the body, plain prose, paragraphs separated by a blank line>

The headline states what happened, in one clause. If it needs an "as" clause or a list of three nouns to cover the piece, the piece has no focus — find the focus first, then write the headline for that. No questions, no teasing, no "what you need to know", no colon-and-label constructions.`;
}

/**
 * One source as the writer sees it, and **nothing about where it came from**.
 *
 * This line used to carry `[feed summary only]` and
 * `[truncated at 1200 of 4800 chars]`, and run #15 relayed both to the reader:
 * "Further detail was not available from the published portion of the report",
 * "the source material was truncated before detailing the specific benefits".
 * The second reads as a hallucination — the persisted article body does contain
 * those details — but it was accurate about *the packet*, because the budget cut
 * the text and this line said so, with numbers, inches from the text itself.
 *
 * That was the third and closest of three places the prompt described its own
 * plumbing: the standing memo forbids writing about sourcing (system prompt),
 * the packet note used to describe the material (user prompt), and this labelled
 * every source (inline with the material). Fixing the outer two left this one
 * winning. The general rule, learned three times: **a model relays what the
 * prompt tells it about itself, so the fix is not to tell it.**
 *
 * Neither dropped flag was actionable — a writer cannot do anything differently
 * knowing text was trimmed, since trimming lands on a paragraph boundary and
 * reads complete. Both are still in `inspect packet`, where an audit needs them.
 * The translation flag stays: whether the writer can read the text at all is a
 * real decision it has to make.
 */
function formatArticle(article: WriterPacket["articles"][number], index: number): string {
  const when = article.publishedAt ? article.publishedAt.toISOString().slice(0, 16) + "Z" : "no timestamp";
  const flagLine = article.translationFailed ? " [NOT TRANSLATED — original language]" : "";

  const head = [
    `--- SOURCE ${index + 1}: ${article.sourceName} | ${when}${flagLine}`,
    `Headline: ${article.title}`,
    `URL: ${article.url}`,
  ];
  // No placeholder when there is no body: "(no body text available)" is the same
  // leak in miniature, and a headline with no text under it says it already.
  return article.text.length > 0 ? [...head, "", article.text].join("\n") : head.join("\n");
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
  // A section piece already has exactly one member's material, so its focus is
  // structural rather than instructed: it covers its own development and the
  // section's other pieces cover theirs. See sectionInstruction.
  if (packet.section !== null) return null;
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

/**
 * Where this piece sits in its section, and what the neighbours cover.
 *
 * This is the whole of the coordination between a section's writers, and it is
 * static text rather than a call: material is partitioned by member, so two
 * pieces cannot draw on the same sources. All this has to do is stop a piece
 * *retelling* what the reader will find a few inches away.
 */
function sectionInstruction(packet: WriterPacket): string[] | null {
  const section = packet.section;
  if (section === null) return null;

  const siblings =
    section.siblingTitles.length > 0
      ? section.siblingTitles.map((t) => `  - ${t}`).join("\n")
      : "  (nothing else)";

  if (section.role === "lead") {
    return [
      "IN THIS SECTION",
      `This piece leads a section of the paper: "${section.title}".`,
      "Every one of these runs separately, below yours, and each has its own writer:",
      siblings,
      "Write the lead and leave those to them. Your source material will often cover " +
        "them too — a live blog or a wrap-up carries the whole day — and that is not " +
        "permission to write them up. A development on that list gets a clause from you " +
        "at most, never a paragraph, and only where your own piece genuinely needs it.",
    ];
  }

  if (section.role === "sidebar") {
    return [
      "IN THIS SECTION",
      `This piece runs inside the section "${section.title}". These are the other pieces ` +
        "in it, the first being the lead:",
      siblings,
      "Write only your own development. Do not summarize the section, do not recap the " +
        "lead, do not write up anything on that list, and do not open by placing your " +
        "story in the wider situation — the heading and the lead have already done that.",
    ];
  }

  return [
    "IN THIS SECTION",
    `A single sentence inside the section "${section.title}". The other pieces in it, ` +
      "the first being the lead:",
    siblings,
    "One sentence, on your own development only. The fact, and nothing else. No context, " +
      "no framing.",
  ];
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

  const section = sectionInstruction(packet);
  if (section !== null) {
    parts.push("", ...section);
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
      "than writing longer. Fewer subjects covered properly beats more covered briefly.",
  );

  return parts.join("\n");
}

// --- briefs, written in batches ---

/** Which register a batched call is writing in. See buildBriefBatchUserPrompt. */
export type BriefBatchKind = "brief" | "line";

/**
 * Briefs are 25–45 words each and the paper carries 75 of them. One call per
 * brief would be 75 calls that each re-send the bio and the standing memo — the
 * scaffolding would outweigh the writing several times over. A batch sends the
 * documents once and the material for `n` briefs after them.
 *
 * The output is the pipeline's usual flat line format, `ref;;headline;;body`,
 * with the body last so a `;;` inside it cannot shift a column.
 *
 * Section lines batch the same way but never in the same call. A line is one
 * sentence and a brief is a short paragraph; run #8 batched them together and
 * the lines came back as briefs — 40 to 47 words against a 15–30 target. One
 * call, one register.
 */
export function buildBriefBatchUserPrompt(
  bio: string,
  packets: WriterPacket[],
  kind: BriefBatchKind = "brief",
): string {
  const parts: string[] = ["THE READER", "", bio, "", "---", ""];

  if (kind === "line") {
    parts.push(
      `SECTION LINES TO WRITE (${packets.length})`,
      "",
      "Each item below is one line: a single sentence naming what happened, " +
        "nothing more. It runs at the foot of a section under a lead that has " +
        "already established the situation, so give the development itself and " +
        "no background. One sentence — not two, and not a compressed brief.",
      "",
      "You will usually have far more material than a line can hold. That is " +
        "normal and it is not an invitation to write longer: read it, find the " +
        "single development the line is for, and leave the rest.",
      "",
      "They are unrelated to each other — do not connect them, and do not let " +
        "one line's subject colour another's.",
      "",
    );
  } else {
    parts.push(
      `BRIEFS TO WRITE (${packets.length})`,
      "",
      "Each item below is one brief. They are unrelated to each other — do not " +
        "connect them, and do not let one brief's subject colour another's.",
      "",
    );
  }

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

  const noun = kind === "line" ? "line" : "brief";
  parts.push(
    "---",
    "",
    `Output one output line per ${noun}, in this exact format, and nothing else:`,
    "",
    "ref;;headline;;body",
    "",
    "The ref is the identifier above (for example " + (packets[0]?.ref ?? "S12345") + "). " +
      "Two semicolons separate the fields. The body is plain prose on one line, " +
      `no line breaks. Write every ${noun} listed, once each, in the order given.`,
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
 * Parses the writer's output: a headline line, then the body.
 *
 * Recognition-based, and deliberately forgiving. Run #3 lost two whole pieces to
 * "unparseable output" — calls that succeeded, cost their tokens, and produced
 * prose that never reached the paper because the first line was not exactly what
 * the contract asked for. A model that opens with "Here is the piece:", wraps the
 * answer in a code fence, or writes the headline with no label at all has done
 * the job; refusing to read it is the parser's failure, not the writer's.
 *
 * So: look for a labelled headline in the first few lines, and if there is none,
 * treat a short first line as the headline. A first line that is clearly prose —
 * long, or with no body after it — still yields null, because publishing a
 * paragraph as a headline is worse than recording a failed piece.
 */
export function parseWriterOutput(text: string): ParsedWriterOutput | null {
  const lines = text
    .split(/\r?\n/)
    // Code fences and preamble scaffolding are not content.
    .filter((line) => !/^\s*```/.test(line));

  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex === -1) return null;

  const clean = (value: string): string =>
    value
      .trim()
      .replace(/^\**|\**$/g, "")
      .replace(/^["'“”]|["'“”]$/g, "")
      .trim();

  // A labelled headline anywhere in the opening lines, past any preamble.
  const LOOKAHEAD = 5;
  for (let i = firstContentIndex; i < Math.min(lines.length, firstContentIndex + LOOKAHEAD); i++) {
    const match = lines[i]!.trim().match(/^#{0,3}\s*\**\s*headline\s*\**\s*[::]\s*(.+)$/i);
    if (!match) continue;
    const headline = clean(match[1]!);
    const body = lines.slice(i + 1).join("\n").trim();
    if (headline.length === 0 || body.length === 0) return null;
    return { headline, body };
  }

  // No label. A short first line followed by a body is a headline.
  const MAX_UNLABELLED_HEADLINE_CHARS = 160;
  const candidate = clean(lines[firstContentIndex]!.replace(/^#{1,3}\s*/, ""));
  const body = lines.slice(firstContentIndex + 1).join("\n").trim();
  if (
    candidate.length > 0 &&
    candidate.length <= MAX_UNLABELLED_HEADLINE_CHARS &&
    body.length > 0
  ) {
    return { headline: candidate, body };
  }

  return null;
}
