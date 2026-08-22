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

Begin with the literal word HEADLINE and a colon. Do not omit that line, whatever the length of the piece — a brief has a headline exactly as a feature does.

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

/**
 * The word target as the writer is told it.
 *
 * A range has a floor, and a floor is an instruction to keep writing. Run #24
 * produced five pieces ending "No further details were available from the
 * source" — every one of them headline-only, where the material supported about
 * fifteen words and `headline_only_words` asked for twenty-five. The writer met
 * the number the only way left to it.
 *
 * The standing memo, the packet note and the source labels had all already been
 * cleaned of this; the floor was the last thing still asking for it. So a
 * headline-only piece gets a ceiling and no floor, and is told plainly that
 * short is the right answer.
 */
/**
 * Thin material gets a ceiling; only a full packet gets a band.
 *
 * A floor is a number, and a number beats an instruction — the lesson this stage
 * has learned at every layer. Run #24's five "No further details were available"
 * pieces were headline-only against a 25-word minimum, and rendering that level
 * as a ceiling with no floor fixed them. `partial` kept its tier's full band, so
 * run #32's S60167 was asked for 120–200 words from one thin source and filled
 * the gap the only way the material allowed: "The source material does not
 * specify the legal mechanism of the guidance, which states might act on it
 * first…". The note beside it said to stay inside the sources. The number won.
 *
 * The ceiling is unchanged, so a partial packet with 2,900 characters under it
 * still writes to length; the floor only ever bound the pieces that had nothing
 * to reach it with.
 */
function targetPhrase(packet: WriterPacket): string {
  const [minWords, maxWords] = packet.targetWords;
  if (packet.materialLevel === "full") return `${minWords}–${maxWords} words`;
  return `up to ${maxWords} words, and fewer is correct — stop when the sources do`;
}

export function buildWriterUserPrompt(bio: string, packet: WriterPacket): string {
  const [minWords, maxWords] = packet.targetWords;
  const parts: string[] = [];

  parts.push("THE READER", "", bio, "", "---", "");

  parts.push("THIS PIECE");
  parts.push(`Position in today's paper: rank ${packet.rank} of the ranked list, ${packet.tier} tier.`);
  parts.push(`Target length: ${targetPhrase(packet)}.`);
  // **The writer is told nothing about sources it cannot see.** This line used to
  // read "Sources behind this story: 2 (1 included below)" — the editor's count,
  // plus a parenthetical naming the gap between that count and the packet. C187
  // read exactly that and wrote "No further details were available from the
  // source" in run #28 and again in run #30, after the packet's omission note had
  // already been fixed. It is the same failure as the packet note, the source
  // labels and the word-target floor, in its fifth form: a model relays what the
  // prompt tells it about itself, and the fix is not to tell it.
  //
  // Nothing is lost. The SOURCE MATERIAL header counts what is actually below,
  // `focusInstruction` says what to do with several outlets on one event, and the
  // editor's own count is on the packet for `inspect packet` to report.
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

  // Only sources the budget could not fit are worth naming. A source omitted
  // because it had no body text is not information being withheld — there was
  // nothing there — and telling the writer it was "left out for length" is the
  // prompt describing its own plumbing, wrongly. Run #28's C187 had a packet of
  // zero characters and this note claiming a further source existed; it wrote
  // "No further details were available from the report." With `max_articles` and
  // `total_chars` null on every tier there are no length omissions left, so this
  // note now renders only if a cap is ever restored.
  const omittedForLength = packet.omitted.filter((o) => o.kind === "length").length;
  if (omittedForLength > 0) {
    parts.push(
      "",
      `${omittedForLength} further source(s) covering this story were left out for length. ` +
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
    `Write the piece. ${targetPhrase(packet)} — ${maxWords} is a ceiling, not a ` +
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
      "Each item below is one brief: the fact, said plainly, and then a stop. " +
        "A brief that tries to be clever is worse than one that is merely accurate.",
      "",
      // **The brief branch had no material paragraph and the line branch did.**
      // Run #34 is the natural experiment: 7 lines, zero length outliers; 52
      // standalone briefs, 22 of them over their band or ceiling, several at
      // two and four times it. A brief with five sources and 20,000 characters
      // under it writes 55 words instead of 35, and the only place its target
      // appeared was one header line thousands of tokens up the prompt.
      "You will usually have far more material than a brief can hold — sometimes " +
        "many times more. That is deliberate and it is not an invitation to write " +
        "longer. A brief with eight sources under it is a better-corroborated " +
        "brief, not a longer one: read all of it, work out the one thing that " +
        "happened, write that, and leave the rest unused.",
      "",
      "They are unrelated to each other — do not connect them, and do not let " +
        "one brief's subject colour another's.",
      "",
    );
  }

  for (const packet of packets) {
    parts.push(`=== ${packet.ref} — rank ${packet.rank}, ${targetPhrase(packet)}`);
    if (packet.notes.length > 0) {
      for (const note of packet.notes) parts.push(`Note: ${note}`);
    }
    packet.articles.forEach((article, i) => {
      parts.push(formatArticle(article, i));
    });
    parts.push("");
  }

  const noun = kind === "line" ? "line" : "brief";
  // **The target is restated at the end, where the writing happens.** The
  // individual prompt closes with "200 is a ceiling, not a target"; the batch
  // stated each target once, inline in a header that a 20,000-character packet
  // then buried. Run #34's briefs came back 46–116 words against 25–45 while its
  // lines, which had their own closing guidance, all landed inside 15–30.
  parts.push(
    "---",
    "",
    `Every ${noun} has its own target above, and every one of those targets is a ` +
      `ceiling rather than something to reach. If the material will not fit, cut ` +
      `what the headline does not promise rather than writing longer.`,
    "",
    `Output one output line per ${noun}, in this exact format, and nothing else:`,
    "",
    kind === "line" ? "ref;;the sentence" : "ref;;headline;;body",
    "",
    // **Name the fields.** The shape alone was not enough: whole batches answered
    // `ref;;body`, dropping the headline field, and run #39 published ten briefs
    // with no headline because of it. The parser keeps them now rather than
    // losing the pieces, but a brief in the paper should have a headline.
    kind === "line"
      ? "The ref is the identifier above (for example " + (packets[0]?.ref ?? "S12345") + "). " +
        "Two semicolons separate it from the sentence. A line has no headline — it is " +
        "one sentence and that sentence is the whole piece. Plain prose on one line, " +
        "no line breaks. Write every line listed, once each, in the order given."
      : "Three fields, in this order: the ref, then a headline for the brief, then the " +
        "brief itself. The ref is the identifier above (for example " +
        (packets[0]?.ref ?? "S12345") + "), and two semicolons separate each field from " +
        "the next, so every output line contains exactly two `;;`. Do not omit the " +
        "headline field. Each field is plain prose on one line, no line breaks. Write " +
        "every brief listed, once each, in the order given.",
  );

  return parts.join("\n");
}

export interface ParsedBrief {
  ref: string;
  /** Null for a section line: one sentence is its own pointer, not a headline. */
  headline: string | null;
  body: string;
}

/**
 * Parses a brief batch: one `ref;;headline;;body` line each. Unknown refs are
 * dropped (a model occasionally invents one) and the first line for a ref wins.
 * Missing refs are the caller's problem to record — a brief that did not come
 * back is a failed piece, not a silent gap.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseBriefBatchOutput(
  text: string,
  validRefs: string[],
  kind: BriefBatchKind = "brief",
): Map<string, ParsedBrief> {
  const valid = new Set(validRefs.map((r) => r.toUpperCase()));
  const out = new Map<string, ParsedBrief>();

  // **A batch that answers on one line is still a batch.** The contract says
  // "one output line per brief" and also "plain prose on one line, no line
  // breaks", and run #38's batch merged the two: every brief on a single line,
  // each separated by `;;`. The parser read the first ref, took the second field
  // as its headline and **everything after it as the body** — so S60434 was
  // published as a 353-word brief whose body was the other nine briefs, refs and
  // all, while those nine went missing and cost a straggler re-ask.
  //
  // The refs are the batch's own structure, so use them: put every known ref
  // back at the start of a line before reading. A ref only ever appears
  // mid-body when the model ran the briefs together, which is exactly the case
  // this repairs.
  const normalized =
    validRefs.length > 0
      ? text.replace(
          // The `;;` that joined this brief to the previous one goes with it,
          // so the previous body does not keep a dangling separator.
          new RegExp(`(?:;;\\s*)?\\b(${validRefs.map(escapeRegExp).join("|")})\\s*;;`, "gi"),
          "\n$1;;",
        )
      : text;

  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const first = line.indexOf(";;");
    if (first === -1) continue;

    const ref = normalizeRef(line.slice(0, first));
    if (ref === null || !valid.has(ref) || out.has(ref)) continue;

    // **A section line has no headline, so the contract does not ask for one.**
    // It is one sentence at the foot of a section whose lead has established the
    // situation — a pointer, not a small brief — and asking for `ref;;headline;;
    // body` made the model write that sentence twice. All 7 of run #34's lines
    // came back with the headline and the body identical, verbatim.
    //
    // Read forgivingly all the same: a line that arrives with two delimiters is
    // still read, and its duplicate headline dropped, because a model that keeps
    // the old shape has still done the job.
    if (kind === "line") {
      const second = line.indexOf(";;", first + 2);
      const rest = line.slice(first + 2).trim();
      const body =
        second === -1
          ? rest
          : (() => {
              const a = line.slice(first + 2, second).trim();
              const b = line.slice(second + 2).trim();
              // Two fields and the second is empty: the line is the first field.
              if (b.length === 0) return a;
              return b;
            })();
      if (body.length === 0) continue;
      out.set(ref, { ref, headline: null, body });
      continue;
    }

    // **A brief that arrives with two fields is still a brief.** The contract
    // asks for `ref;;headline;;body`, and run #36's batch 0 answered every one of
    // its ten briefs as `ref;;body` — no headline field — twice over, in the
    // original call and in the straggler re-ask. Both produced ten complete,
    // correctly-referenced briefs; the parser required a second delimiter and
    // dropped all twenty lines, and the whole batch became ten failed pieces.
    //
    // This is run #3's lesson in the place it was never applied. That parser was
    // made forgiving because refusing output the model had already paid for is
    // the parser's failure, not the writer's — and `parseWriterOutput` has read
    // an unlabelled headline ever since. `parseBriefBatchOutput` kept demanding
    // its exact shape, and a database-wide scan found 40 non-empty batch
    // responses across thirteen runs that produced no pieces at all.
    //
    // A missing headline costs a headline. A dropped line costs the piece.
    const second = line.indexOf(";;", first + 2);
    if (second === -1) {
      const body = line.slice(first + 2).trim();
      if (body.length === 0) continue;
      out.set(ref, { ref, headline: null, body });
      continue;
    }

    const headline = line.slice(first + 2, second).trim();
    const body = line.slice(second + 2).trim();
    // `ref;;text;;` — a trailing empty field means the text was the whole brief.
    if (body.length === 0) {
      if (headline.length === 0) continue;
      out.set(ref, { ref, headline: null, body: headline });
      continue;
    }
    if (headline.length === 0) {
      out.set(ref, { ref, headline: null, body });
      continue;
    }

    out.set(ref, { ref, headline, body });
  }

  return out;
}

export interface ParsedWriterOutput {
  /** Null when the model wrote the piece and no headline. */
  headline: string | null;
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
 *
 * **When the writer revises in the stream, the last draft is the piece.** Run
 * #28's C187 wrote a draft, caught itself asserting a subsidy figure that came
 * from the cluster label rather than a source, wrote a second draft, caught
 * itself writing about the sourcing, and wrote a third that was correct: fifteen
 * words, attributed, nothing the headline did not support. What reached the
 * paper was all three drafts plus the reasoning between them — 233 words on a
 * 60-word ceiling — because this parser takes the first headline it recognises
 * and everything after it. The model did the job and the parser published its
 * workings. A writer that restates the contract mid-output has told us which
 * draft it stands behind, so the *last* labelled headline wins.
 *
 * The re-scan runs only over the body the primary parse produced and matches the
 * contract's literal `HEADLINE:` rather than the forgiving form, so a normal
 * piece is read exactly as before. A revision that never re-labels is
 * undetectable and still publishes whole; the label is the only signal there is.
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
    const match = matchHeadlineLabel(lines[i]!);
    if (match === null) continue;
    const headline = clean(match);
    const body = lines.slice(i + 1);
    if (headline.length === 0) return null;
    return lastDraft(headline, body, clean);
  }

  // No label. A short first line followed by a body is a headline.
  const MAX_UNLABELLED_HEADLINE_CHARS = 160;
  const candidate = clean(lines[firstContentIndex]!.replace(/^#{1,3}\s*/, ""));
  const body = lines.slice(firstContentIndex + 1);
  if (candidate.length > 0 && candidate.length <= MAX_UNLABELLED_HEADLINE_CHARS) {
    const parsed = lastDraft(candidate, body, clean);
    if (parsed !== null) return parsed;
  }

  // **A piece with no headline is still a piece.** This used to return null when
  // the first line was plainly prose, on the reasoning that publishing a
  // paragraph as a headline is worse than recording a failure. That reasoning
  // only holds while the prose is being made *into* a headline. With the headline
  // null it does not apply, and the piece survives.
  //
  // Run #36's S59896 repair answered with one clean line of newspaper prose —
  // "Malheur County schools restored truancy citations through a local ordinance
  // after state lawmakers banned the fines in 2021…" — which is exactly what a
  // 40-word brief is, and the parser threw it away. Run #37 lost four more
  // pieces the same way, every one recorded as "unparseable output". It is the
  // batch parser's lesson on the individual path: a missing headline costs a
  // headline, and refusing the piece costs the piece.
  const whole = lines.slice(firstContentIndex).join("\n").trim();
  if (whole.length > 0) return { headline: null, body: whole };

  return null;
}

/**
 * The opening label is read forgivingly and a restart label strictly, because
 * the two mistakes cost different things. Failing to recognise the opening label
 * loses a whole piece (run #3), so any casing will do. Mistaking a line of prose
 * for a restart truncates a piece that parsed correctly, so a restart must be
 * the contract's own literal `HEADLINE:` — which a body will not contain, since
 * the same prompt forbids colon-and-label constructions in the writing.
 */
function matchHeadlineLabel(line: string, strict = false): string | null {
  const pattern = strict
    ? /^#{0,3}\s*\**\s*HEADLINE\s*\**\s*[::]\s*(.+)$/
    : /^#{0,3}\s*\**\s*headline\s*\**\s*[::]\s*(.+)$/i;
  const match = line.trim().match(pattern);
  return match ? match[1]! : null;
}

/**
 * Given the headline and body the primary parse found, returns the last
 * re-labelled draft inside that body if there is one, and the original
 * otherwise. Yields null when nothing has a body, which is what makes a bare
 * headline with no piece under it a failed piece rather than a published stub.
 */
function lastDraft(
  headline: string,
  bodyLines: string[],
  clean: (value: string) => string,
): ParsedWriterOutput | null {
  const restarts: number[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    if (matchHeadlineLabel(bodyLines[i]!, true) !== null) restarts.push(i);
  }

  // Each draft ends where the next one starts. Without that bound an abandoned
  // final restart would leave its own label sitting in the previous draft's body.
  const drafts: ParsedWriterOutput[] = [
    { headline, body: trimBody(bodyLines.slice(0, restarts[0] ?? bodyLines.length)) },
  ];
  for (let k = 0; k < restarts.length; k++) {
    const start = restarts[k]!;
    drafts.push({
      headline: clean(matchHeadlineLabel(bodyLines[start]!, true)!),
      body: trimBody(bodyLines.slice(start + 1, restarts[k + 1] ?? bodyLines.length)),
    });
  }

  for (let i = drafts.length - 1; i >= 0; i--) {
    const draft = drafts[i]!;
    if ((draft.headline ?? "").length > 0 && draft.body.length > 0) return draft;
  }

  return null;
}

/**
 * Joins body lines, dropping the horizontal rules a revising model puts between
 * its drafts. Only leading and trailing rules go — a thematic break inside a
 * feature is the writer's, not the plumbing's.
 */
function trimBody(lines: string[]): string {
  const isRule = (line: string): boolean => /^\s*([-*_])\1{2,}\s*$/.test(line);
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start]!.trim().length === 0 || isRule(lines[start]!))) start++;
  while (end > start && (lines[end - 1]!.trim().length === 0 || isRule(lines[end - 1]!))) end--;
  return lines.slice(start, end).join("\n").trim();
}
