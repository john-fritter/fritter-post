// The cross-day continuity judge.
//
// WHY THIS EXISTS, AND WHY IT DID NOT AT FIRST. The lineage pass shipped as
// retrieval alone: best embedding match above a threshold, no LLM. The argument
// was that a *continuity marker* does not need to tell a resurfaced copy from a
// genuine follow-up, because "previously, Sept 2" is correct about both, and
// the distinction would only matter if something were being deleted.
//
// That argument was right about the axis it considered and blind to the one
// that mattered. The 2026-09-04 measurement over seven republished papers —
// 900 pieces, 114 links, every link read by hand — found the failures are not
// stale-versus-advancing at all. They are **same kind of event, different
// instance**:
//
//   - "Israeli strikes kill five Palestinians in Gaza City" linked to
//     "Israeli airstrike kills three Palestinians in Jenin, a rare West Bank
//     strike" at 0.8219. Different territory, different incident.
//   - "Australian police arrest two alleged TeamPCP members" linked to
//     "Hackers tricked SpaceX's AI coding assistant into helping breach seven
//     companies" at 0.8080. Different actors, different breach, shared only the
//     vocabulary of AI and cybersecurity.
//
// This project has met that failure before and already knows embeddings cannot
// see it. It is why grouping has a **re-split** pass: "two gold mine collapses
// on different continents are the opposite shape — tightly connected, because
// they are the same kind of event in the same words." Cosine similarity
// measures how alike two stories *read*, and two instances of one recurring
// kind of event read almost identically.
//
// No threshold fixes that. The measured distribution has no valley: the largest
// best-match below 0.80 was 0.7973 and the smallest above it 0.8020, a gap of
// 0.0047 in a smooth tail. Both false links sat *above* the line, at 0.8080 and
// 0.8219, while real continuations sat below it — the renewed Iran escalation
// at 0.7944, an OpenAI follow-up at 0.7443. Moving the number trades one error
// for the other and fixes neither.
//
// So retrieval now does what retrieval is good at — finding the handful of
// prior pieces worth considering — and the judgment goes to the model, which is
// how every other "is this the same story" question in this pipeline is
// answered. Grouping asks "same event?". Threading asks "same continuing
// situation, today?". This asks the same question threading asks, across days.
//
// THE SECOND MEASUREMENT (2026-09-04, seven papers, 158 links, all read by
// hand) cleared the first bar and found a new one. Both original false links
// were rejected, all three continuations the 0.80 threshold had missed came
// back, and the three old borderline pairs went. Two NEW wrong links appeared:
//
//   - "Ozon will turn its pickup points into storage and sales hubs" accepted
//     against "Ukrainian drones struck Ozon warehouses across Russia over six
//     days". One company, a business story and a military one.
//   - "Ex-police officer charged with using Flock cameras to stalk girlfriend"
//     accepted against "Georgia officer used Flock surveillance cameras to
//     track his ex and another cop". Different state, officer, victim, case.
//
// **The prompt already forbids both.** It says a shared institution is not a
// situation, and that another instance of the same kind of event is NO. Adding
// a third warning to a prompt that is already correct is the move this project
// has watched fail: the thread pass names "immigration crackdown" as a worked
// negative example and produced one anyway.
//
// The real defect is that the judge could not *apply* the rule it was given,
// because it was shown two headlines and nothing else. "Ex-police officer
// charged with using Flock cameras to stalk girlfriend" does not say Oregon.
// The fact that separates it from the Georgia case was never in the prompt —
// Gizmo had to open the source URLs to establish it. On those two lines alone
// a careful human would also have said yes.
//
// So the judge now reads body text, which is this repository's oldest lever and
// its most reliably underestimated one: grouping-pass-1 spent months scoring
// singletons on bare headlines, and `body_cap` exists because "it is the knob
// that decides how much a per-item judgment stage actually knows".
//
// It also fixes a failure nobody attributed correctly. Seven of the eleven
// previously-good links the judge dropped had a **section line** on one side or
// the other, and a line has no headline by design — so the prompt showed it the
// literal string "(section line, no headline)" and asked it to judge that. It
// had nothing to work with and correctly said no. A line has a body; now it
// sends one.
//
// And the verdict carries a reason. The first measurement could say a pair was
// accepted and never why, which Gizmo flagged as a limitation of the run. That
// is migration 037's argument for the thread anchor, one stage later: naming
// the criterion makes a bad call legible afterwards, and made the thread pass
// apply its rule rather than recognise it.
//
// THE THIRD MEASUREMENT (2026-09-05, body text in place) fixed the Ozon pair,
// kept the two original rejections and all three recovered continuations, and
// took the false-link rate from 1.75% to 1.27% to **0.60%** — one wrong link in
// 167. The survivor is the Flock pair, and its reason is what makes it useful:
//
//     "same officer and stalking case, investigation then arrest"
//
// **The judge asserted a shared identity that neither text names.** Today's
// piece is a 141-character brief reading "A former police officer was arrested
// for using Flock surveillance cameras to stalk an ex-partner"; it never says
// Oregon, and it never names him. The earlier one says "a Georgia police
// officer". Neither names the man. Investigation-then-arrest is a natural
// reading of those two sentences, and a careful human would make the same
// mistake — **more body text cannot fix a fact the paper never printed.**
//
// So the constraint is on the reason rather than on the input: the shared thing
// has to be *named in both texts*. That is the thread pass's anchor rule in its
// strictest form — not "state your criterion" but "state it and point at where
// it appears" — and it turns "same officer" from an assumption into a claim the
// model has to check before it writes. Nothing new is sent; the reason field
// was already there, doing less work than it could.

const LINEAGE_SYSTEM_PROMPT = `You are a newspaper editor deciding whether today's story is a continuation of one the paper already ran.

You will be given numbered pairs. Each pair is one story from today's paper and one story this paper published on an earlier date. For each pair, answer whether today's story is the NEXT DEVELOPMENT IN THE SAME SITUATION as the earlier one.

THE TEST: would a reader who read the earlier story recognise today's as the same story continuing — the next thing that happened in it?

SAME SITUATION — answer YES:
- The same event advancing: a death toll rising, a rescue continuing, an investigation reporting, a deal moving from reported to confirmed.
- The same dispute, case, or negotiation at a later stage: a ruling appealed, a bill amended, a lawsuit expanded to more plaintiffs.
- The same continuing conflict or emergency in the same place: two consecutive days of one war's strikes on one front, one country's fire season, one city's fight over one project.
- A consequence or aftermath of the earlier event: the science explaining the disaster, the funerals after it, the regulation that followed it.

The stories do NOT have to describe the same incident, and today's story does NOT have to add news — a second report on one event still continues it. What matters is that it is the same situation moving.

NOT THE SAME SITUATION — answer NO:
- **Another instance of the same kind of event.** This is the failure that matters most and the one that looks most like a match. Two strikes in a conflict but in different territories, two arrests of different hacking groups, two mine collapses on different continents, two elections in different countries. They share vocabulary and share nothing else. If the actors, the place, or the specific incident differ and neither story is a consequence of the other, the answer is NO.
- The same broad subject with no shared situation: two unrelated stories about immigration policy, about AI safety, about a country's politics. A subject is not a situation.
- The same institution or person doing two unrelated things.

Two real pairs this pass got WRONG before you were asked, both of which you should answer NO:
- "Israeli strikes kill five Palestinians in Gaza City despite October ceasefire" and "Israeli airstrike kills three Palestinians in Jenin, a rare West Bank strike". One conflict, two territories, two separate incidents, neither a consequence of the other.
- "Australian police arrest two alleged TeamPCP members behind supply-chain attacks" and "Hackers tricked SpaceX's AI coding assistant into helping breach seven companies". Different actors, different breach, no connection but the topic.

And two you should answer YES:
- "Nvidia buys Hugging Face for $12.93 billion" and "Nvidia moves to acquire Hugging Face for roughly $13 billion". One transaction, reported then confirmed.
- "More than 1,270 dead in Nepal-Tibet floods as families perform funerals without bodies" and "Experts say survival window is closing for hundreds trapped in Nepal's hydropower tunnels". One disaster, later stage.

When you genuinely cannot tell, answer NO. A wrong "previously" line is printed where the reader sees it; a missing one leaves the page as it already is.

OUTPUT
One line per pair, in the order given, and nothing else — no JSON, no markdown, no prose before or after.

Each line:
  number;;YES or NO;;reason

The reason is one short phrase, under fifteen words, naming what decides it — the shared situation for a YES, or what differs for a NO. "same acquisition, now confirmed". "different state and officer, same tool". Write it before you commit to the verdict, not after.

**For a YES, the thing you name must appear in BOTH texts.** Name the transaction, the place, the case, the disaster, the person — and check that both texts actually say it. If your reason would be "same officer" and neither text names the officer, or "same case" and neither text names the case, then you are assuming they are the same rather than reading that they are. **Say NO.** Two stories about an unnamed police officer, an unnamed company, or an unnamed lawsuit are not the same story just because the same kind of thing happened.

Use every number exactly once.`;

export function buildLineageSystemPrompt(): string {
  return LINEAGE_SYSTEM_PROMPT;
}

export interface LineagePairBlock {
  todayHeadline: string;
  todayDate: string;
  todayBody: string;
  priorHeadline: string;
  priorDate: string;
  priorBody: string;
}

export function buildLineageUserPrompt(pairs: LineagePairBlock[]): string {
  const blocks = pairs.map((p, i) => {
    const lines = [`${i + 1}.`, `  TODAY (${p.todayDate}): ${p.todayHeadline}`];
    if (p.todayBody) lines.push(`    ${p.todayBody}`);
    lines.push(`  EARLIER (${p.priorDate}): ${p.priorHeadline}`);
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
    "For each pair: is today's story the next development in the same situation?",
  ].join("\n");
}

/**
 * Reads `n;;YES|NO;;reason` lines back into the confirmed pairs and their reasons.
 *
 * Forgiving in the direction the writers' parser learned to be: a line carrying
 * a recognisable number and verdict is read whatever surrounds it, and a
 * **missing reason costs the reason, not the verdict** — that is run #36's
 * lesson, where a parser demanding three fields threw away forty complete
 * answers across thirteen runs.
 *
 * But **an unparseable or missing line is a NO**, not a default-yes. That is the
 * pass's fail-closed posture and the opposite of the writers' rule, for the
 * reason the threshold was set toward precision: an unjudged link would print in
 * the paper, where an unjudged brief merely goes missing and gets re-asked.
 */
export function parseLineageVerdicts(
  text: string,
  pairCount: number,
): Map<number, string | null> {
  const confirmed = new Map<number, string | null>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(/^\s*\**\s*(\d+)\s*\**\s*;;\s*\**\s*(YES|NO)\b\s*\**\s*(?:;;\s*(.*))?$/i);
    if (!m) continue;
    const n = parseInt(m[1]!, 10);
    if (!Number.isFinite(n) || n < 1 || n > pairCount) continue;
    if (m[2]!.toUpperCase() !== "YES") continue;
    const reason = (m[3] ?? "").replace(/\*+/g, "").trim();
    confirmed.set(n - 1, reason.length > 0 ? reason : null);
  }
  return confirmed;
}
