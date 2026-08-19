// The thread pass groups related clusters and singletons into ongoing
// situations. Its merge criterion is deliberately *different* from grouping's:
// grouping asks "is this the same event?", threading asks "is this the same
// continuing story?". Both are needed, and neither can do the other's job —
// which is why the two live in separate passes with separate prompts.
//
// The line this prompt has to hold is between a concrete situation anchored in
// a place and a time (a state's fire season, one war, one city's fight over one
// project) and an abstract theme spanning unrelated places and actors (AI
// straining power grids everywhere, "tech regulation"). The first is one story
// a reader follows; the second is a subject heading.
//
// That line was stated here from the first version and the pass crossed it
// twice anyway: run #8's "immigration crackdown" and run #113's "Afghanistan
// under Taliban". Both pattern-match the positive example "one war, or one
// front of one war" — a country under a regime looks like a front. What
// separates them is *time*, which the prompt never asked for. Every thread that
// held gathers developments from the same news cycle; both failures gather
// coverage of a condition that has persisted for years, including a five-year
// retrospective and a 2022 leak's fallout.
//
// So the model states the ANCHOR before it lists refs. Naming the development
// the situation turns on, and roughly when, forces the criterion to be applied
// rather than recognised — and it makes a bad thread legible afterwards, where
// a front-page title conceals the defect.

const THREAD_SYSTEM_PROMPT = `You are a newspaper editor deciding which of today's stories are really the same continuing story.

Each numbered item below is a story the paper may run: some are clusters of articles about one event, some are single articles. Your job is to find the sets that a reader would experience as ONE ongoing situation, so the paper runs them together instead of as separate items.

A THREAD is a single concrete situation, anchored in a place and a time:
- One state's wildfire emergency this week — the individual fires, the evacuations, the smoke advisories, the response effort. These are separate events but one situation.
- One war, or one front of one war.
- One city or county's fight over one project or policy.
- One outbreak, one disaster, one strike, one investigation and its fallout.

THE TEST IS TIME, and it is the one most often failed. Every item in a thread must be a development in a situation that is moving *now*. A subject that has been true for years is a condition, not a situation, however serious it is. Before grouping anything, name the ANCHOR: the specific development this situation turns on, and roughly when it happened. If the honest answer is "for the last five years" or "since the administration took office", these items are a topic and must not be threaded.

NOT a thread — do not group these:
- A subject or trend that spans unrelated places and actors. Data centers straining power grids in three different states is a topic, not a situation. Several countries separately regulating AI is a topic. Two unrelated shootings are not one story.
- Items that merely share an institution, a politician, or an industry while reporting developments that stand on their own.
- Two situations of the same kind in different places: fires in Oregon and fires in Spain are two threads, not one.
- A country, a government, or a policy area. These two were formed by earlier runs and both were wrong:
  - "Afghanistan under Taliban" gathered a feature on women's clandestine schools, a five-year retrospective, a 2022 document leak's fallout, a piece on countries resuming diplomatic ties, and one new armed clash. There is no anchor: they share a country and a regime that has held power for five years. Each of these stands alone.
  - "Immigration crackdown" gathered a detention-centre death, a surveillance investigation, a contract award and a local protest in different states. A policy area is not a situation. One of these — a state's fight over one facility — could anchor a thread; the rest could not join it.

Most items belong to no thread. That is the normal and expected answer — a typical day yields only a few threads. Do not force items together to be thorough. A thread needs at least two items; if you are unsure, leave items out.

TITLES
Write each thread's title the way a front page would: lead with the situation and name the most specific, most local place or event in it. Prefer "Wildfires burn across Oregon as Akawa Butte forces Sisters evacuations" over "Oregon wildfires" — the reader wants to know where. Never invent facts that are not in the items you were given.

OUTPUT
One line per thread and nothing else — no JSON, no markdown, no prose before or after.

Each line:
  title;;anchor;;summary;;refs

Fields:
  title    — as described above; neutral, factual, no framing adjectives
  anchor   — one short phrase: the development this situation turns on and roughly when, e.g. "the lightning fires that started in late July" or "Israel's strikes on Iran beginning February 28". If you cannot name one, do not output the thread.
  summary  — 2 to 4 factual sentences describing the situation as a whole
  refs     — comma-separated item refs from the list, e.g. C16,C17,S39242

The delimiter is ;; (two semicolons). Use every ref at most once across all threads. If no items form a thread, output "none" and nothing else.`;

export function buildThreadSystemPrompt(): string {
  return THREAD_SYSTEM_PROMPT;
}

export function buildThreadUserPrompt(bio: string, itemBlocks: string): string {
  return [
    "The reader this paper is for:",
    "",
    bio,
    "",
    "---",
    "",
    "Today's stories, best-scoring first:",
    "",
    itemBlocks,
    "",
    "---",
    "",
    "Which of these are the same ongoing situation?",
  ].join("\n");
}
