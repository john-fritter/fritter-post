// The rerun judge.
//
// WHY THIS EXISTS. The lineage pass asks whether today's piece continues a
// situation the paper already covered, and it was told, on purpose, that "a
// second report on one event still continues it". That is the right answer for
// a continuity marker and the wrong one for a newspaper. The Sep 5-22 audit
// read all 257 "previously" links across nine editions and roughly one in four
// was the same news printed again, because another outlet reported it a day
// later:
//
//   - AfD wins Saxony-Anhalt with 43.8%, three seats short -- Sep 7, Sep 8
//     ("same AfD Saxony-Anhalt election result, same vote share and seat
//     count", in the judge's own words) and again Sep 10.
//   - LG smart TVs record audio and scan home networks -- Sep 7, 8 and 9.
//   - Australia to require platforms to let users switch off algorithmic
//     feeds -- Sep 6, 7 and 8.
//   - Jaguar Land Rover will cut 4,000 jobs over two years -- Sep 7 and 8.
//
// None of the 257 shared a URL, a preprocessed item or a normalized title with
// its predecessor, so the preprocessor's cross-run dedup could never have seen
// them: 114 of the pairs did not even share an outlet. The duplicate the
// lineage docs said "already happened in the preprocessor" is a duplicate of
// *news*, and the preprocessor only knows duplicates of *articles*.
//
// So this asks the question the lineage judge deliberately does not: has the
// paper already told the reader this? It runs before the pile is assembled, so
// a dropped row's slot goes to the next story rather than being a hole.
//
// WHICH WAY IT FAILS. Open, the opposite of the lineage judge. A wrongly
// dropped story is invisible -- the reader never learns it existed, and nothing
// on the page says so -- while a missed rerun is the paper as it already was.
// So an unreadable line, a missing line and a failed call all keep the row, and
// the prompt says to keep anything it cannot call.

const RERUN_SYSTEM_PROMPT = `You are the editor of a daily newspaper with one reader. Before today's paper is made, you check each candidate story against what the paper has already printed, so the reader is never handed the same news twice.

You will be given numbered pairs. Each pair is one CANDIDATE for today's paper and one story this paper PRINTED on an earlier date. For each pair, give one verdict:

RERUN — the candidate is the same news the earlier story already reported. Everything the candidate says of substance, the earlier story already told the reader: the same event, the same outcome, the same figures, the same announcement. It may be a different outlet, a different headline, more background, more quotes, more reaction or more colour. None of that is news to a reader who read the earlier story.

DEVELOPMENT — the same situation, and the candidate reports something that has HAPPENED since, or that the earlier story did not have: a vote counted after one was cast, a ruling after a hearing, arrests after an attack, a denial after an accusation, a toll that has materially changed, a new party taking action, a document newly released. The reader needs this.

NEW — not the same situation at all. Another instance of the same kind of event (two strikes in different places, two lawsuits by different plaintiffs), or the same broad subject with different actors.

How to decide between RERUN and DEVELOPMENT:
- Find the single most important fact in the candidate. Is it in the earlier story? If yes, and nothing else of substance is new, it is RERUN.
- A figure that has moved only trivially (129 missing instead of 130) is not a development. A figure that changes what the story means (a toll that has doubled, a vote now final) is.
- "Reported" versus "confirmed" is a development only when the confirmation itself is the news (a company confirming a deal it had declined to discuss). A second outlet repeating a first outlet's report is not a confirmation.
- Analysis, explainers and reaction pieces about an event already reported are RERUN unless they report a new fact.

When you are unsure, answer DEVELOPMENT. A rerun costs the reader a paragraph they have read before. Dropping a real development costs them news they will never see.

OUTPUT
One line per pair, in the order given, and nothing else — no JSON, no markdown, no prose before or after.

Each line:
  number;;RERUN or DEVELOPMENT or NEW;;reason

The reason is one short phrase, under twenty words. For DEVELOPMENT, name the fact the candidate has that the earlier story did not. For RERUN, name the news both report. For NEW, say what differs. Write the reason before you commit to the verdict.

Use every number exactly once.`;

export function buildRerunSystemPrompt(): string {
  return RERUN_SYSTEM_PROMPT;
}

export interface RerunPairBlock {
  candidateTitle: string;
  candidateText: string;
  candidateDate: string;
  priorHeadline: string;
  priorBody: string;
  priorDate: string;
}

export function buildRerunUserPrompt(pairs: RerunPairBlock[]): string {
  const blocks = pairs.map((p, i) => {
    const lines = [`${i + 1}.`, `  CANDIDATE (${p.candidateDate}): ${p.candidateTitle}`];
    if (p.candidateText) lines.push(`    ${p.candidateText}`);
    lines.push(`  PRINTED (${p.priorDate}): ${p.priorHeadline}`);
    if (p.priorBody) lines.push(`    ${p.priorBody}`);
    return lines.join("\n");
  });
  return [
    "Pairs to judge:",
    "",
    blocks.join("\n\n"),
    "",
    "---",
    "",
    "For each pair: has the paper already printed this news (RERUN), has something happened since (DEVELOPMENT), or is it a different story (NEW)?",
  ].join("\n");
}

export type RerunVerdict = "new" | "development" | "rerun";

/**
 * Reads `n;;VERDICT;;reason` lines back.
 *
 * Forgiving about shape, as every parser here learned to be: markdown bold, a
 * missing reason and surrounding prose are all tolerated, and a missing reason
 * costs only the reason. Strict about meaning: a line with no recognisable
 * verdict yields nothing, and the caller keeps any pair with nothing. That is
 * the fail-open posture -- the one verdict that removes a story from the paper
 * must be stated, never inferred.
 */
export function parseRerunVerdicts(
  text: string,
  pairCount: number,
): Map<number, { verdict: RerunVerdict; reason: string | null }> {
  const out = new Map<number, { verdict: RerunVerdict; reason: string | null }>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(
      /^\s*\**\s*(\d+)\s*\**\s*;;\s*\**\s*(RERUN|DEVELOPMENT|NEW)\b\s*\**\s*(?:;;\s*(.*))?$/i,
    );
    if (!m) continue;
    const n = parseInt(m[1]!, 10);
    if (!Number.isFinite(n) || n < 1 || n > pairCount) continue;
    if (out.has(n - 1)) continue; // first answer stands
    const verdict = m[2]!.toLowerCase() as RerunVerdict;
    const reason = (m[3] ?? "").replace(/\*+/g, "").trim();
    out.set(n - 1, { verdict, reason: reason.length > 0 ? reason : null });
  }
  return out;
}
