// The novelty judge.
//
// WHY THIS EXISTS. The lineage pass asks whether today's piece continues a
// situation the paper already covered, and it was told, on purpose, that "a
// second report on one event still continues it". That is the right answer for
// a continuity marker and the wrong one for a newspaper. The Sep 5-22 audit
// read all 257 "previously" links across nine editions and roughly one in four
// (counted by headline) was the same news printed again, because another outlet
// reported it a day later: AfD's 43.8% result on Sep 7, 8 and 10; LG TVs
// recording audio on Sep 7, 8 and 9. None shared a URL, an item or a normalized
// title with its predecessor, so the preprocessor -- which knows duplicate
// *articles*, not duplicate *news* -- could never have seen them.
//
// WHY IT GRADES INSTEAD OF DECIDING. It began as a two-way judge, RERUN or
// DEVELOPMENT, and DEVELOPMENT meant "the candidate reports something the
// earlier story did not have". A day-later article always does: a quote, a
// condition update, an analyst's reading. So the 2026-10-02 audit, reading
// papers #43-52 by headline, found about two repeats a day still printing, six
// of them in the top five -- the US-China trade truce at rank 1 on 9/27 after
// 9/24 and 9/26, OpenAI's training pause at rank 1 on 9/28 after rank 2 on
// 9/27, Christa Pike's failed execution at rank 2 on 10/1 and again on 10/2 --
// every one under a "previously" line. The judge had answered its question
// correctly; it was the wrong question. The reader's is whether the HEADLINE
// tells them something new.
//
// And the same audit found the opposite error: 34 of 106 drops were called
// wrong, mostly a real development matched on a printed background fact
// (Iran's president answering Trump at the UN, withheld against Trump's
// speech). A binary judge has to choose which error to make. A graded one does
// not: a small update is kept and made small, a real development is kept at
// full size, and only nothing-new is withheld.
//
// ROUTINE needs the history, which is why each candidate is judged against every
// printed piece it resembles at once rather than pair by pair. Whether tonight's
// strikes on Kyiv are news depends on whether the paper printed strikes on Kyiv
// on each of the last five days -- and that is a fact about the paper, which is
// exactly what the PRINTED list shows. The judge does not need to know the war;
// it needs to know what the reader has already been told.
//
// WHICH WAY IT FAILS. Open. A failed call, a missing line and an unreadable one
// all leave the row ungraded, and an ungraded row is neither reduced nor
// withheld: the paper is what it would have been before this check existed.
// RERUN, the one grade that removes a story, must be stated, never inferred.

const NOVELTY_SYSTEM_PROMPT = `You are the editor of a daily newspaper with one reader. Before today's paper is made, you check each candidate story against what this paper has already printed, and grade how new it is to a reader who read those earlier stories.

You will be given numbered candidates. Each has TODAY's text and, under PRINTED, the stories this paper ran on the same subject in its last few editions, newest first. The closest are shown with their text; the rest are dated headlines.

Ask one question: if today's news were written as a headline, would it tell this reader something the PRINTED stories did not? Then grade it:

RERUN — no. Everything of substance in the candidate was already printed: the same event, outcome, figures or announcement. A different outlet, a later write-up, more background, more quotes or more colour does not change that.

MINOR — the same news with a small new detail that does not change the story: an added quote or reaction, a status update ("remains in critical condition"), a slightly revised figure, an analyst's reading, a further detail of an event already reported. The detail is real, but the reader would not want the story again at full length.

ROUTINE — a genuinely new event, but of the kind the PRINTED list itself shows this situation producing again and again: another night of strikes on the same cities, another day's price move, another arrest in a running crackdown, another hearing in a long trial. Nothing marks it out: it is not a first, not markedly larger or deadlier than what was printed, not a new kind of target, not a new actor, place or decision. Use ROUTINE only when the PRINTED list shows the pattern.

DEVELOPMENT — something has changed since the printed stories: a decision, ruling, vote, deal, resignation, arrest or charge; a plan or threat that has now been carried out; a new party taking action (a government responding, a lawsuit filed, an order issued); a first of its kind; a clear escalation or de-escalation; a toll or figure that changes what the story means. The reader needs this.

NEW — not the same situation as any printed story. Another instance of the same kind of event with different actors or in a different place (a different strike, a different lawsuit) is NEW, unless it belongs to one continuing situation the printed stories cover, in which case grade it ROUTINE or DEVELOPMENT.

How to decide:
- Grade the candidate's most significant NEW fact, not its first or its main one. A candidate that repeats a printed fact and also reports a significant new one is a DEVELOPMENT. One that adds only small details is MINOR.
- Commentary, analysis, explainers and reaction quotes about printed news are MINOR at most. A party acting is not commentary: a head of state answering in a speech, a legislature voting and a lawyer filing are events.
- A figure that moved trivially (129 missing instead of 130) is MINOR or RERUN. One that changes the meaning (a toll that has doubled, a count now final) is a DEVELOPMENT.
- What matters is what the PRINTED stories already told this reader, not whether the news is new to the world.
- When unsure whether anything is new at all, answer MINOR rather than RERUN: RERUN removes the story from the paper entirely, and the reader never learns it existed.

OUTPUT
One line per candidate, in the order given, and nothing else: no JSON, no markdown, no prose before or after.

Each line:
  number;;today's news;;GRADE

"today's news" is one plain sentence stating the most significant thing the candidate reports that the printed stories did not, written as the opening of a news story would state it. For RERUN, state the news both report. For NEW, state the candidate's main news. Write it about the world, not about the coverage: never mention the printed stories, this newspaper, or what was "already reported" or "previously reported" — the PRINTED list is for your judgment only. Write the sentence first, then decide the grade.

Use every number exactly once.`;

export function buildNoveltySystemPrompt(): string {
  return NOVELTY_SYSTEM_PROMPT;
}

/** One printed piece, as the judge is shown it. */
export interface PrintedBlock {
  date: string;
  /** Null for a section line, which has no headline; its opening is shown instead. */
  headline: string | null;
  /** Empty for the pieces shown as headlines only. */
  body: string;
}

export interface NoveltyCandidateBlock {
  date: string;
  title: string;
  text: string;
  /** Newest first. */
  printed: PrintedBlock[];
}

/** A section line has no headline; its first sentence stands in for one. */
function printedLabel(p: PrintedBlock): string {
  if (p.headline && p.headline.trim().length > 0) return p.headline.trim();
  const opening = p.body.trim().split(/(?<=[.!?])\s/)[0] ?? "";
  return opening.length > 0 ? `(one-line item) ${opening}` : "(one-line item)";
}

export function buildNoveltyUserPrompt(candidates: NoveltyCandidateBlock[]): string {
  const blocks = candidates.map((c, i) => {
    const lines = [`${i + 1}.`, `  CANDIDATE (today, ${c.date}): ${c.title}`];
    if (c.text) lines.push(indent(c.text, 4));
    lines.push("  PRINTED:");
    for (const p of c.printed) {
      lines.push(`   - ${p.date}: ${printedLabel(p)}`);
      if (p.body && p.headline) lines.push(indent(p.body, 7));
    }
    return lines.join("\n");
  });
  return [
    "Candidates to grade:",
    "",
    blocks.join("\n\n"),
    "",
    "---",
    "",
    "For each candidate: what is today's news, and is it a RERUN, MINOR, ROUTINE, DEVELOPMENT or NEW for a reader who read the printed stories?",
  ].join("\n");
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => pad + l)
    .join("\n");
}

export type NoveltyGrade = "new" | "development" | "minor" | "routine" | "rerun";

const GRADE_TOKEN = /^\**\s*(RERUN|MINOR|ROUTINE|DEVELOPMENT|NEW)\s*\**\.?$/i;

/**
 * Reads `n;;today's news;;GRADE` lines back.
 *
 * Forgiving about shape, as every parser here learned to be: markdown bold,
 * lower case, the fields in the other order, a missing sentence and prose
 * around the lines are all tolerated, and a missing sentence costs only the
 * sentence. Strict about meaning: a line with no recognisable grade yields
 * nothing, and the caller keeps a row with nothing, unreduced. The grade that
 * removes a story must be stated, never inferred.
 */
export function parseNoveltyGrades(
  text: string,
  candidateCount: number,
): Map<number, { grade: NoveltyGrade; news: string | null }> {
  const out = new Map<number, { grade: NoveltyGrade; news: string | null }>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.includes(";;")) continue;
    const fields = line.split(";;").map((f) => f.trim());
    const num = fields[0]!.replace(/\*/g, "").trim();
    if (!/^\d+$/.test(num)) continue;
    const n = parseInt(num, 10);
    if (n < 1 || n > candidateCount || out.has(n - 1)) continue; // first answer stands

    const rest = fields.slice(1);
    const gradeAt = rest.findIndex((f) => GRADE_TOKEN.test(f));
    if (gradeAt === -1) continue;
    const grade = rest[gradeAt]!.match(GRADE_TOKEN)![1]!.toLowerCase() as NoveltyGrade;
    const news = rest
      .filter((_, i) => i !== gradeAt)
      .join(" ")
      .replace(/\*+/g, "")
      .trim();
    out.set(n - 1, { grade, news: news.length > 0 ? news : null });
  }
  return out;
}
