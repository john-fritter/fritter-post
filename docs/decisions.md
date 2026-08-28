# Decisions

Append-only log of significant choices, with context and rationale.
Newest entries at the top.

When making a decision worth recording, add an entry. Don't edit old
entries — if a decision is reversed, add a new entry that supersedes it
and reference the old one. The point of this document is that future
agents and future-you can understand why things are the way they are.

Entry format:

```
## YYYY-MM-DD — Short title
**Decision:** What we decided.
**Context:** What we knew at the time.
**Rationale:** Why this over alternatives.
**Supersedes:** (optional) Reference to an earlier entry, if reversing one.
```

---

## 2026-08-22 — The writers stage is done; the parsers were the real defect

**Decision:** Stop rewriting the paper to tune the writers stage. Remaining
defects are within the measured noise band. The next work is the publisher and
the cron entrypoint.

**Context:** Runs #38, #39 and #40 each persisted 150/150 on the first pass with
no repair, zero generation-log error rows and zero output-token ceilings. Before
that, every run needed a repair pass and several lost whole batches.

What actually fixed it was not prompt tuning. It was four parser defects, every
one of which had been discarding work the model had already done correctly:

| defect | cost |
|---|---|
| first headline wins, rest of output published | 233-word piece of drafts (run #28) |
| batch demanded `ref;;headline;;body` exactly | 40 non-empty responses across 13 runs yielded nothing |
| individual refused prose with no label | every "unparseable output" failure in runs #36–#37 |
| batch answered on one line, first ref swallowed the rest | 9 briefs buried inside a 10th (run #38) |

Each was found by reading the raw output or the paper itself. None was visible in
any summary count: the repair pass covered for all of them, and telemetry read
"0 errors" because `callLLM` set `generation_logs.error` *after* writing the row.

**Rationale:** Run #3's lesson — refusing output the model already paid for is
the parser's failure, not the writer's — was applied once, to
`parseWriterOutput`, and never carried to the batch parser or to the
prose-without-label case. Two of these four defects are that same lesson
unlearned in another place. The rule now holds everywhere: a missing field costs
the field, never the piece; only genuinely empty output fails.

Where run #40 leaves the paper, per 150 pieces: 16 length outliers of which
fifteen are within 21 words of their band, 3 outlet-class source-meta sentences,
4 pieces with no headline, 0 lost pieces. The length audit only became readable
once Gizmo added a signed margin column — a 2-word miss and a 53-word miss had
been counting the same.

**Supersedes:** nothing. It closes the arc that "Source-meta has reached its
noise floor" (2026-08-21) opened.

---

## 2026-08-21 — Source-meta has reached its noise floor; stop pulling layers

**Decision:** Stop treating "the paper writing about its own sourcing" as a
mechanism with a remaining fix. Keep the two interventions that measured, record
what did not, and do not remove or add another prompt layer on this theory
without a controlled A/B that shows more than two pieces moving.

**Context:** Three controlled runs against the same editor run (#119) and the
same 73 standard-tier packets, one variable each:

| run | change | outlet defects |
|---|---|---|
| #31 | baseline: three layers removed | 4 |
| #32 | the gap clause restored, as the actionable rule | 2 |
| #33 | `partial` material gets a ceiling, not a band | 2 |

The count is flat between #32 and #33 but the *identity* changed. S60167 — the
piece the ceiling was built for — dropped its gap sentence and went from 156
words to 77, exactly the intended behaviour on one thin source. A different
piece, S60563, drifted in with "The report did not name specific ASEAN member
states approached by either side". S59935 has now survived all three.

Two pieces in seventy-three, with different pieces each run, is not a defect
with a cause. It is variance.

**Rationale:** The four earlier removals were made on the theory that a prompt
layer naming the sourcing plants the sourcing, and each one was followed by an
*increase*: 1 → 2 → 4 as the packet note, the source count and the "make no
remark" clauses came off. The controlled A/B then reversed it, 4 → 2, by putting
one clause back in its actionable form. So the theory was wrong in the direction
it predicted and right about where the instruction has to sit — near the piece,
saying what to do rather than what not to write.

The second intervention is kept on its own evidence rather than on the flat
count. A floor is a number and a number beats an instruction; that was already
established at `headline-only` in run #24, and S60167 is the same mechanism one
level up. The length guard says it cost nothing: **zero** `full` pieces fell
below their 120-word floor in #33 having been above it in #32, and the `full`
mean moved 179.4 → 178.3. Only the pieces with nothing to reach the floor with
got shorter, which is the point.

Anything further would be a fifth guess tested at n=2, and the last four rounds
of that produced a different pair of pieces each time.

**Supersedes:** the source-meta half of "Source-meta down from five to two"
(2026-08-20), which read the count as a trend when the population was changing
under it.

---

## 2026-08-21 — Every repaired piece is an individual call

**Decision:** `--repair` always writes through the individual-piece path, whatever
the tier. The brief batch is for full runs only.

**Context:** Run #31's S60468 failed the full run and then failed two successive
repair passes, all three recording "not present in the batch output". The repair
path's own comment said briefs were re-asked individually "to remove the batch's
own failure mode"; it did not. It built a batch of one and sent it through
`writeBriefBatch`, keeping the ref-keyed parser, so a model that did not echo
`S60468;;` exactly produced no row and failed again for the same reason it failed
the first time. On the individual path it recovered on the first attempt.

**Rationale:** Every packet already carries a full individual prompt from
`buildWriterUserPrompt` — its target length, its section instruction, its focus —
and `parseWriterOutput` reads that back forgivingly with no ref to echo. The
batch exists to amortise the bio and the standing memo across 75 briefs. At one
piece there is nothing to amortise and only the failure mode left.

---

## 2026-08-21 — A non-empty extraction is not article-shaped prose

**Decision:** `loadFetchedTexts` returns `thin` rows as well as `ok` ones, and the
guard against template junk is the rules that read the text — `stripBoilerplate`
plus the packet's longer-of-the-two comparison — not `min_extracted_chars`.

**Context:** Demanding `status = 'ok'` threw away reporting the fetch had already
paid for: run #28's C20 was a feature lead written on 49 words while 1,035
characters of one source's extracted text sat unused, and letting it through took
that piece to 388. But the argument for relaxing the floor was wrong. It ran:
`extractArticle` returns `""` when Readability finds no article and has no
whole-document fallback, therefore any non-empty extraction is article-shaped.
Readability returns the best article-shaped *block*, and on a page whose article
it cannot see that block is a template module. Cascade PBS supplied its house
promo for a different programme — "In this episode of 'Beyond the CANVAS,' we sit
down with novelist Margaret Atwood…" — as the article body for an ABC-versus-FCC
lawsuit and, identically, for a South Korea military-drills feature. The
1,200-character floor had been rejecting that by accident.

**Rationale:** A length threshold cannot tell a short article from a short
template, and both exist. Two rules that read the text can: paragraphs repeated
inside one document are furniture by construction (no article says the same
paragraph twice; a page template does, once per slot), and a named rule for the
promo itself. They accrete from audit evidence the way the junk filter does. The
same repeated-paragraph rule immediately removed six subscribe blocks from a
Public Notice source nobody had complained about.

---

## 2026-08-21 — A wrapper is not a host

**Decision:** `canonicalizeUrl` unwraps an absolute URL embedded in a redirector's
**path**. Query strings are excluded, and Google News is left alone.

**Context:** Folha publishes every feed item as
`redir.folha.com.br/redir/…/rss091/*https://www1.folha.uol.com.br/…`. Storing the
wrapper sent the fetch to the redirector and taught the per-host cooldown against
a host that is not a publisher — 42 of run #118's article rows. After the fix,
`redir.folha.com.br` holds 0 preprocessed items, `www1.folha.uol.com.br` holds
96, and all 8 Folha fetches succeeded on a host that had never been fetchable.

**Rationale:** The rule is the shape, not the outlet. Query strings are excluded
because `…/article?ref=https://other.example` is one outlet's article carrying a
referrer, not a redirect to another, and unwrapping it would replace the story.
Google News's `/rss/articles/CBMi…` token is an opaque identifier with no URL
inside it, so there is nothing to unwrap and those items stay headline-only by
construction.

---

## 2026-08-21 — The parser publishes the last draft, not the workings

**Decision:** `parseWriterOutput` rescans the body it produced and returns the
last re-labelled draft. Draft bodies are bounded at the next label.

**Context:** Run #28's C187 published 233 words against a 60-word ceiling: a first
draft asserting a subsidy figure, the model catching that the figure came from the
cluster label rather than a source, a second draft, the model catching itself
writing about the sourcing, and a third draft that was correct — fifteen words,
attributed, nothing the headline did not support.

**Rationale:** Every guardrail worked. The memo stopped the source-meta, the
cluster-label-is-not-evidence rule stopped the subsidy claim, and the ceiling was
never the problem. The parser took the first headline it recognised and everything
after it, so what reached the paper was all three drafts plus the reasoning
between them. A writer that restates the contract mid-output has said which draft
it stands behind. The opening label stays case-insensitive and a restart matches
only the literal `HEADLINE:`, because missing the opening label costs a whole
piece while mistaking prose for a restart truncates one that parsed correctly.

---

## 2026-08-21 — A killed run costs the calls in flight, not the calls answered

**Decision:** Each piece is written to `writer_pieces` as its call returns.

**Context:** Writer run #29 made 94 attempts, 90 of them successful, and persisted
**zero** rows when it was stopped. The stage held every piece in memory and
inserted them after the last call finished. The tokens were spent, the writing
existed, and none of it was recoverable — not even by `--repair`, because there
were no failed rows to repair.

**Rationale:** The stage already treats a failed call as a row rather than an
exception, for exactly this reason: one call that times out must cost one piece,
not the edition. The same logic applies to the process. Insert order is free —
every reader of `writer_pieces` sorts by rank and section_rank explicitly.

---

## 2026-08-15 — A run stops asking when the provider stops answering

**Decision:** the writers stage aborts after `abort_after_consecutive_failures`
(10) consecutive call failures, records the remaining pieces as failed, and
points at the repair pass. `callWithBackoff` keeps its per-call retries; this is
a second, run-level bound on top of them.

**Context:** run #4 met a provider outage. `zai-org/glm-5.2` broke streams call
after call, and because `callWithBackoff` correctly retries broken streams, **103
logical calls became 807 provider attempts, 775 of them errors**. The run spent
31 minutes to write 17 pieces; the repair pass spent 34 more to add 22. The
sections design itself passed every structural gate in the same run — 191 pieces,
52 in 11 sections, 41 standalone displaced, zero cross-section article overlaps —
so the only thing missing was prose the provider would not produce.

**Rationale:** per-call backoff answers "did this request fail for a reason worth
re-asking?" and it answers it correctly. It cannot answer "is the provider up?",
because each call only sees itself. Nothing about the hundredth request was going
to succeed where the first ninety-nine failed, and continuing to ask was both
expensive and impolite.

Consecutive failures rather than a failure rate: one hard piece failing among
successes is a piece problem, a hundred failing in a row is an outage, and only
the second is worth abandoning a run over. A single success resets the count.

**Why this needs no new recovery path:** `--repair` already exists and re-writes
exactly the missing pieces, so an aborted run is a resumable one. The operator
gets a message naming the command instead of an hour of hammering.

**Watch:** if a run aborts on a healthy provider, the threshold is too low for
the concurrency — ten is about two rounds at concurrency 4.

---

## 2026-08-15 — Comparatives are measurements

**Decision:** superlatives and comparatives join characterization on the list of
things that need a source. Added to `voice.md` and the writer prompt.

**Context:** the sentence behind the run #3 overstatement, finally quoted: *"But
the increases in APIDA arrests outpaced every other group."* The sources
supported a sixfold rise and, separately, that this was among the largest
increases on record. They did not support the comparison.

**Rationale:** this is a distinct failure from the characterization rule written
against it — that rule covers causes, motives and histories, and this is a
measurement. "Largest", "first", "worst", "most", "outpaced" each assert a
ranking, and a piece can slip into one while every individual fact in it is
sourced. The remedy is the same and simpler: give the number the source gave,
which usually hits harder anyway.

---

## 2026-08-15 — A thread is a section, not a story

**Decision:** a thread expands into several pieces under one heading — a lead at
the story's tier, up to `max_sidebars` members at one tier below, and a
one-sentence line for every remaining member. Section pieces displace standalone
pieces from the bottom of the ranked list, so the paper stays the size the editor
said it was.

**Context:** threading absorbs a situation's rows into one ranked story, which is
right for ranking and wrong for writing. The two writer behaviours we have seen
are both wrong, and for the same reason:

- Before the spine instruction: twelve events in 500 words, which is a list.
- After it: one event in 500 words, and eleven stories silently discarded.

Run #3's T1 dropped a story scoring **81** (federal investigation of
left-leaning groups during the Minnesota crackdown) while the paper ran a 35-word
brief on a story scoring **56**. T3 dropped the Orsk refinery halt, the Sevastopol
assassination, the Warsaw assassination plot, the FSB erasing the border with
annexed territory. Nobody made those judgments; they fell out of a structure
where one slot has to hold a situation.

**Rationale:** the sub-stories already exist. A thread's members are distinct
events *by construction* — grouping separated them, threading gathered them — so
the assembler does not need to invent a structure or ask a model to plan one. It
builds one packet per member instead of flattening twelve members into one.

That has a property worth stating plainly: **material partitions by member, so
two pieces of a section cannot overlap.** No coordination between writer calls is
needed, and "writers don't see each other's work" survives intact. The only
cross-piece information is static text — the lead is told what runs below it, a
sidebar is told what the lead covers — and its entire job is to stop a piece
retelling what the reader will find two inches away.

**Alternatives rejected:**

- *Longer thread features* (scale words with member count). A 1,000-word piece
  covering twelve events is still a list, and it breaks the finite-paper
  principle.
- *Weaken threading* so only the top members are absorbed. Fixes coverage and
  prose, but scatters the related items across the paper as unrelated briefs —
  the repetition problem threading was built to solve (run #43's five wildfire
  clusters, four in the top fifteen).

**On paper size:** sections produce more pieces than the slots they replace, so
the tail of the ranked list gives up its places. Deeper coverage of eleven real
situations costs the lowest-scoring unrelated items. Given that run #112's bottom
briefs scored 56 against a dropped thread member at 81, that trade is the right
way round. Section pieces are never displaced, and one standalone story always
survives so a pathological day cannot produce a paper of nothing but threads.

**Timing:** the publisher is the one unbuilt stage, so this was the cheapest
moment this change will ever be — it lands as a migration on a table nothing
renders yet, rather than a schema change plus a rendering rewrite.

**Open:** whether T1's "immigration crackdown" is a *situation* or a *topic* is
still a threading question, and sections make it visible rather than answering
it. Judge it on the next run: a section whose lead and sidebars have nothing to
do with each other is a thread that should not have formed.

---

## 2026-08-14 — The paper writes: 147 of 150, and three defects worth the run

**Decision:** the spine instruction stays; the parser gets more forgiving; a
dropped brief is re-asked once; a failed piece can be repaired without
re-writing the paper; and characterization joins the list of things that need a
source.

**Context:** the focus change worked. The same three features went 716 → 534,
661 → 572, 534 → 503, every headline single-clause, and the reviewer's read was
that T3 "correctly dropped the Crimea assassination, Warsaw plot, body exchange
and other peripheral developments" — the largest editorial improvement of the
run. The full paper then wrote in 264 seconds: 147 pieces, 83 calls, **zero
failed provider calls**, features averaging 512 words, standards 157, briefs 35.

Three defects, and two of them are mine rather than the model's.

### An unforgiving parser cost two whole pieces

`parseWriterOutput` required a labelled headline on the *first* non-empty line.
Two pieces came back "unparseable": the call succeeded, the tokens were spent,
and prose that was probably fine never reached the paper because of a preamble
line or a missing label. The parser now looks for a label in the opening few
lines, ignores code fences, and falls back to treating a short first line as the
headline — while still refusing a first line that is plainly a paragraph, since
publishing prose as a headline is worse than recording a failure.

The pipeline's own precedent was already there: the editor's output parser was
made recognition-based in June for exactly this reason.

### A dropped brief is now re-asked once

One brief of ten went missing from a batch — the call succeeded and returned
nine. The batch now makes one bounded follow-up call for the stragglers. Only
one: if the model will not write it twice, that is an answer.

### A paper is one run, so repair belongs inside it

Filling three holes should not cost 150 calls, and publishing the holes is not
an option either. `npm run write -- --repair <run>` re-writes only the failed
pieces of an existing run and updates them in place, so the run stays one paper
and the cost is proportional to the damage. Repaired briefs are written
individually rather than batched, which removes the batch's failure mode from
the repair path.

### Characterization is a claim

The reviewer flagged a factual overstatement in the lead feature. The class it
belongs to is not invented facts — the run had none — but invented *frames*: a
source says refugees were resettled after a war, and the piece says they came
from "countries the U.S. had destabilized". Both may be true; only one is
sourced. `voice.md` and the writer prompt now say that causes, motives and
histories need a source standing behind them, or the supporting fact stated
plainly instead.

**What this run establishes:** the stage is sound. Zero provider failures, one
paper in four and a half minutes, ~320k input tokens, and the failures that did
occur were all in reading the output rather than producing it.

---

## 2026-08-14 — First writer run: the prose is sound, the editing is not

**Decision:** the fix for sprawling features is a focus instruction, not a
shorter word target or fewer sources. `docs/voice.md` grows a "One piece, one
spine" section, and the prompt tells a thread to lead with one development.

**Context:** writer run #1 wrote the top three features. All three came back
accurate — correct attribution throughout ("Zelensky said", "Russia has not
confirmed", "the Prospect reported"), no invented number, name, date or quote,
no cross-story contamination. The reviewer checked specifically for the failure
that matters and found none.

What it did find was length and shape: 716, 534 and 661 words against a 400–600
target, with the two long ones reading as roundups rather than articles.

**The diagnosis is in the numbers.** The piece that held together — T6, 534
words, the only one inside its band — had **four** members. The two that sprawled
had **twelve** each. T1's twelve covered deportation statistics, a medical
neglect case, a warrantless raid, surveillance of nonprofits, a death in
detention, shock gloves, a no-bid legal-services contract and an Oregon facility
protest. A writer given twelve distinct events and 500 words will tour them,
because nothing told it not to.

**Rationale:** the alternatives are worse. Cutting `max_articles` would starve
the corroboration the packet exists to provide — the sources are not the problem,
the absence of an editorial instruction is. Lowering the word target treats the
symptom and would make a *focused* feature too short. And the deeper cause —
that "immigration crackdown" is closer to a topic than a situation — is a
threading question, not one the writers stage should paper over.

So the writer is told what a human editor would tell it: pick the development
that matters now, lead with it, use the rest as corroboration, and leave out
what the headline does not promise. The headline is the test — an "as" clause or
a list of three nouns means the piece has no spine, which is exactly the shape
both long headlines took.

**Not done, deliberately:** no automatic re-call on an over-length piece. That
doubles the cost of every overrun to fix something a prompt may fix for free.
Revisit if the instruction does not move the numbers.

---

## 2026-08-14 — AP has no reachable feed; the Google News proxy stays, with its costs named

**Decision:** keep the Google News search proxies for AP Top News and AP
Politics. Do not replace them. Record what that costs in `sources.yaml` rather
than leaving it to be rediscovered.

**Context:** the AP entries are Google News RSS searches, so every item's link is
an interstitial rather than an article — 20 stories in run #112 with no fetchable
text, and `news.google.com` as the busiest host in the fetch scope. Seven
candidate direct AP endpoints were probed from the production host on
2026-08-14: `apnews.com/index.rss` returned 401, four `/hub/*.rss` paths returned
404 HTML, and `feeds.apnews.com` does not resolve at all.

**Rationale:** losing AP's article bodies is bad; losing AP entirely to a 404
would be worse. AP items still earn their place through the editor's prominence
formula — cross-source pickup is signal whether or not we can read the body.

**What makes this tolerable now, and it is worth being precise about:** the two
defects the proxy caused are handled at the points where they actually hurt. The
`- apnews.com` suffix is stripped from headlines by the preprocessor, so it no
longer reaches embeddings, prompts, or the reader. And the assembler's
headline-echo rule keeps a body that is only its own headline out of writer
packets, so an AP item contributes prominence without occupying a source slot
with nothing in it.

**Revisit if:** AP publishes a public feed again, or the paper starts wanting AP
as a *writing* source rather than a corroboration signal.

---

## 2026-08-14 — Furniture rules match lines, not paragraphs; live blogs rank last

**Decision:** `stripBoilerplate` matches per line within a paragraph. Live blogs
are pushed behind real articles in packet selection, never deleted.

**Context:** the second packet read found `The-CNN-Wire` and the CNN copyright
line still in rank 3 after the furniture rules shipped. The cause is visible in
the raw packet: KTVZ emits them as two lines of one paragraph, separated by a
single newline, and the rules split on blank lines and anchored end-to-end — so
neither could ever match. The rule set was right and the granularity was wrong.

The same read flagged Le Monde's Ukraine live blog for the second time. A live
blog is not an article: it is one page carrying a day of entries about many
stories, wrapped in comment boxes and pointers to other coverage, and it took
5,954 characters of rank 3's feature budget.

**Rationale:** matching per line keeps the precision that matters — a line is
still matched end-to-end, so a sentence of reporting that mentions CNN is
untouched — while catching furniture that shares a block with other furniture.

For live blogs, ordering rather than deletion is the honest fix. On a
27-candidate thread the live blog falls out of the packet on its own; on a story
where it is the only source, it is still the source. Detection is from the title,
which live blogs announce plainly, and the near-miss tests pin headlines like
"Live music returns to the Old Mill District".

**Alternative rejected:** cutting live blogs upstream in the junk filter. They
are digest-shaped, which is the junk filter's remit, but they also carry real
reporting that legitimately clusters — the train strike, the Warsaw arrest, the
body exchange all came from that page. Losing the item entirely would cost the
cluster a source; losing it from the packet costs nothing.

---

## 2026-08-13 — First assembled packets: furniture, stubs, per-tier material, and the label that is not evidence

**Decision:** four changes to the assembler, all from reading the first real
packets for editor run #112 rather than from reasoning about them.

**Context:** the packets were assembled and read end-to-end. They were
structurally sound — selection visible, fetched vs feed distinguished, counts
explicit, budgets bounded — and carried four concrete defects.

1. **Publisher furniture survived extraction.** Rank 3 contained
   `The-CNN-Wire`, a Cable News Network copyright line, `The post … appeared
   first on KTVZ.`, `READ ALSO` followed by a list of other stories, NPR's
   `(Image credit: …)`, Guardian's `Continue reading...`, and Le Monde's
   live-blog chrome (`Posez votre question à la rédaction`, `Réagissez`,
   `Votre pseudo...`, the most-read list). Readability keeps the article and
   drops the page; it cannot know these are not sentences.
   `boilerplate.ts` removes them with whole-paragraph, high-precision rules,
   each naming the run and source that produced it — the junk filter's contract,
   including a test for the near-miss prose that must survive.

2. **A stub took a source slot.** Rank 3 spent one of twelve on a Google News
   item whose entire body was `Poland says it thwarted a Russian plot … 
   apnews.com` — the headline and the domain. **Length cannot make this call**:
   an 89-character Al Jazeera summary in the same packet carried a real fact.
   The test is whether the body echoes the headline (`isHeadlineEcho`), with a
   60-character floor for the empties. A packet is never emptied by this rule.

3. **Material thresholds are per tier.** One global pair labelled a Guardian
   standard story `headline-only` while it carried four usable facts, because
   1,000 characters is thin for a 600-word feature and adequate for a 150-word
   standard piece. Thresholds moved into each tier's config block.

4. **The cluster label is not evidence, and now says so.** The sharpest finding:
   T3's describe-pass summary named a refinery strike, a Sevastopol
   assassination, a body exchange, a border-control change and an armoured-
   brigade exercise, and the twelve included sources supported some of that and
   not the rest. The summary is generated from every article in the cluster,
   including the ones the budget omitted. The prompt had said "write your own
   headline", which addresses the headline and not the facts; it now says
   plainly that the label is not source material and not evidence. A writer
   treating it as reporting produces unsupported claims in the paper's own
   voice, which is the one failure mode nothing downstream can catch.

**Rationale:** all four are cases of the assembler passing along something it
had no business treating as reporting. The stage's whole job is to hand a writer
material it can trust; anything in the packet that is not reporting is a
liability, because to the model it is indistinguishable from reporting.

**Still open after this pass:** 64 of 150 packets are `headline-only` and 113
carry no fetched article at all — most of them briefs, which are never fetched
by design, but the feature/standard share of that is the real limit on how much
of the paper can be written from substance. The AP feed pointing at
`news.google.com` is a meaningful part of it and is a `sources.yaml` fix.

---

## 2026-08-13 — Packet dedup is verbatim paragraphs, not embedding similarity

**Decision:** the assembler removes paragraphs one article repeats from another,
verbatim. It does **not** suppress near-duplicate articles by embedding cosine.

**Supersedes:** the dedup design sketched when this stage was proposed, which had
three levels: selection cap, embedding-cosine near-duplicate suppression using
the vectors `item_embeddings` already stores, and paragraph dedup. The middle
level is wrong and is dropped.

**Rationale:** every member of a cluster is the same event *by construction* —
high cosine is precisely why grouping put them together — so a cosine threshold
inside a packet would delete the corroboration the packet exists to provide. The
27 articles under T3 are not 27 copies of one story; they are 27 vantage points
on one situation, which is what lets a writer say where sources agree and where
they diverge. What a writer genuinely does not need is the same AP paragraph
three times under three ledes, and that is verbatim repetition, which a hash
catches exactly and cheaply.

Short paragraphs are exempt (`min_dedup_paragraph_chars`): a dateline or a
one-line attribution repeating across outlets is not redundancy, and cutting it
would reshape a lede.

---

## 2026-08-13 — Writers stage: the packet is assembled, not authored; article text is fetched for what the feed left short

Three decisions, taken together because the audit that settled the third also
justified the first two.

### The writer package is deterministic software, not another LLM stage

**Decision:** the writers work from a packet built by a prompt assembler:
tier → length target and register, `docs/bio.md` → who it is for, a standing
memo → voice, and the story's own source material, selected and budgeted by
software. No LLM writes an "angle", a "voice brief", or "editorial notes".

**Context:** `concept.md` carried this as an open question since 2026-06-16 —
the writer package was going to be produced by the editor's phase 4 from the
researcher's article ideas, and neither of those exists now. The question was
whether the editor grows a package step or the writers work from the digest plus
tier.

**Rationale:** a package step would be a judgment stage with nothing new to
judge on. The bio-aware judgment already happened twice, in the prefilter and in
grouping-pass-1, and the editor stopped being a judgment stage for exactly this
reason (2026-06-16). What is actually missing before a writer can work is not
judgment but *material*: the article text, deduplicated and fitted to a budget.
That is software.

### The materials resolver is its own module, and returns text uncapped

**Decision:** `src/pipeline/writers/materials.ts` walks a ranked story to the
articles underneath it — thread → `thread_members` → cluster →
`grouping_runs.digest` → `preprocessed_items` — and does nothing else. No
fetching, no capping, no dedup, no formatting. Text comes back at full length.

**Rationale:** every other stage excerpts at a configured `body_cap` because it
is about to hand text to a model. This one hands text to the assembler, which
owns the budget. A cap here would silently halve the assembler's material and
leave two places to look for why. Keeping the walk pure also makes the
three-deep thread case testable from fixtures, which it now is.

Degradation is recorded rather than swallowed: a cluster missing from the digest
leaves the story in place carrying the source count the editor ranked it on,
plus a note. On editor run #112 the resolver reported no unresolved rows at all,
and its thread member/source counts reconciled exactly with SQL.

### Fetch only what the feed left short, and leave refusing hosts alone

**Decision:** an article-text fetcher (`article_texts`, migration 034) runs over
feature and standard stories, requests only articles whose feed body is under
800 characters, extracts with Readability, and skips hosts that have failed
repeatedly with no success inside a 7-day window.

**Context:** the audit of editor run #112 measured the paper's 305 underlying
articles. 185 (61%) carried under 800 characters of body text and 132 under 300
— a headline and a lede. That is enough for the judgment stages, which read 500
by design, and not enough to write 400 words from.

The decisive finding is that **thinness is a property of the outlet, not the
story**: AP, Al Jazeera, SCMP, BBC World, NYT Politics, the Oregonian, Wired,
Folha and TechCrunch ran 100% thin; Meduza, KTVZ, the Bend Bulletin, La Nación,
OPB, ProPublica and Street Roots ran 0%. So the policy is per item. On that
run's numbers it is 139 requests rather than 228, and the busiest host drops
from 20 articles to 15.

A 15-URL live probe of the thinnest sources found: most publishers serve their
article HTML to an honest agent; SCMP, Wired, Folha, LA Times and The Diplomat
show consent or paywall furniture (whether the prose survives extraction is a
question only the extractor can answer, and `status='thin'` is how it will
answer it); and **nytimes.com and oregonlive.com refuse with a DataDome device
check that the browser-agent retry does not get past**. Hence the cooldown —
learned from `article_texts` rather than configured as a blocklist, so a host
that lifts a block recovers by itself once its failures age out of the window.

**No whole-document fallback.** When Readability finds no article the row is
marked `thin` and the assembler falls back to the feed text. Running
`html-to-text` over a whole news page returns nav, cookie banner and related-
stories rail, and to a model that is indistinguishable from reporting.

**Retention.** `article_texts` is the only place this project stores other
people's full text. It exists to write the paper, is never published, and is
swept on a rolling window by the fetch script.

**Open, and surfaced to the reader:** the AP Top News feed resolves to
`news.google.com` redirect pages — 20 articles in run #112, the single biggest
source in the paper, and the busiest host in the fetch scope. Those URLs are
Google interstitials, not articles, so nothing can be extracted from them. The
fix is the feed URL in `sources.yaml`, not the fetcher; the cooldown will stop
requesting them after one run either way.

---

## 2026-08-12 — Run #51 confirms the scoring work; editor considered done

**Decision:** stop tuning the editor path. The next work is the writers stage.

**Context:** run #51/#111 is the first run where every open item from the
previous three entries came back green, on a full corpus with cross-run dedup
off.

| | #107 | #109 | #110 | **#111** |
|---|---|---|---|---|
| distinct combined scores | 38 | 48 | 41 | **59** |
| rows in a tie | 127 | 119 | 121 | **115** |
| largest tie group | 22 | 19 | 31 | **13** |
| feature/standard boundary | 5-row tie | 4-row tie | 2-row tie | **no tie** |
| standard/brief boundary | 8-row tie | 12-row tie | 2-row tie | 5-row tie |

- **Off-grid bands worked.** Multiple-of-five occupancy fell from ~88% on both
  axes to 4.0% (interest) and 8.4% (consequence). The lattice was the whole
  problem and moving the band edges dissolved it.
- **The transport retry worked.** Thread #8 formed 8 threads absorbing 35 rows,
  `failed_calls=0`, in 98s against run #7's 311s failure.
- **Zero digests in the paper.** The one surviving STAT+ row is a single
  reported story on nurses and clinical AI, not a newsletter edition — the
  distinction the rules were written to make.
- **Every large tie group is tier-local.** Only the 5-row group at 70.00
  straddles a boundary, split 3 standard / 2 brief by the tie-break.
- **The feature tier is all multi-source**: 6 threads + 9 clusters, zero
  singletons. Every piece that will get long-form treatment is corroborated and
  carries several member articles' worth of source text.

**Rationale:** the remaining defects are variance, not design. Wildfire coverage
still fragmented across ranks 2, 6 and 18 — run #49's thread call folded the
same material into one row, so this is the thread pass being less aggressive on
one draw, not a rule that is wrong. Three pass-1 fail-safes out of 576 rows land
below the pile cutoff and vanish quietly. Grouping's recovered 429s are trending
up (30 → 33 → 41) and are worth watching, but terminal failure counters stayed
at zero across all three runs.

Each of the last three runs spent most of its value correcting a fault in the
previous change. The metrics are now the best they have been on every axis, and
further tuning would be chasing variance.

**Open, deferred deliberately:** the wildfire fragmentation, the 429 trend, and
whether the standard/brief boundary tie is worth eliminating. Revisit if a later
run shows them getting worse.

---

## 2026-08-12 — Band edges moved off multiples of five; transport failures retried

Run #50/#110 corrections. Two of the three findings are fixes to the previous
entry's own changes.

### The two-axis change made the score grid coarser, not finer

**Decision:** the axis bands in `editor-pass-1/prompt.ts` move off multiples of
five (44-50, 34-43, 23-33, 13-22, 6-12, 0-5) and the prompt now says outright
that round numbers and band edges are a failure to discriminate.

**Context:** run #110 came back with 41 distinct combined scores and 121 of 150
rows tied — worse than run #109's 48 and 119, and the largest tie group grew
from 19 rows to 31. The axis histograms explain it: **~88% of both axes landed
on a multiple of five.** Interest concentrated on 5/10/15/…/45, consequence on
10/15/…/40. Two multiples of five sum to a multiple of five, so the paper's
combined scores collapsed onto 65/70/75/80/85.

The cause was my own band definitions. The single-score prompt had bands ending
at 89, 74, 59, 44, 24, 9 — all off-grid — which pushed the model toward values
like 57, 62, 72, 79. Rewriting them as 45-50, 35-44, 25-34 handed it a
five-point lattice to anchor on. The axes were a good idea implemented with
edges that undid the benefit.

**What this does not change:** the tie *distribution* got worse while the ties
that matter got better. Every large group in run #110 sat entirely inside one
tier — 65.00×31 and 70.00×27 are all brief, 80.00×17 and 75.00×17 are all
standard — and both tier boundaries were 2-row ties, down from 4-row and 12-row
in run #109. Briefs are one-liners and standards share one treatment, so
intra-tier order is nearly free; boundary ties are the expensive ones. Judge the
next run on boundary tie size, not on the headline count.

**Caveat on the comparison:** run #110's thread pass failed (below), so its pile
carried ~36 extra low-scoring singletons that threading would have absorbed,
concentrated in exactly the bunched 65–70 range. Neither the headline tie count
nor the largest-group figure is cleanly comparable to run #109.

### A broken stream killed the thread pass

**Decision:** `callWithBackoff` now retries transport failures — `Stream broke`,
`ECONNRESET`, `socket hang up`, `premature close`, `fetch failed` — alongside
429/503. Timeouts remain deliberately un-retried.

**Context:** thread run #7 made one call, lost it to `Stream broke at 311715ms
after 0 bytes … terminated`, and formed zero threads. `isRateLimitError` did not
match, so the single call that the whole pass depends on was never retried. The
resulting paper carried three separate wildfire rows in the top ten (ranks 1, 3,
10) plus two more at 85 and 89 — exactly the repetition threading exists to
remove, and the same failure run #43 produced before threading existed.

**Rationale:** a dropped socket says nothing about the request, so re-sending it
is correct. A timeout is different: the call ran to its configured ceiling and
will probably do so again, and run #40's lesson was to bound those rather than
repeat them. The thread pass is the most exposed stage in the pipeline — one
call, no chunking, whole-pass failure — so it is the one that most needed this.

### The digest defence worked; the report's FAIL was a false alarm

**Decision:** no change to the mechanism. One rule widened: the "curated guide"
pattern now tolerates a qualifier, and a new pattern catches a newsletter
announcing itself as an edition.

**Context:** run #50's report recorded `FAIL — digest filter upstream` on two
observations: five digest items were still present in `preprocessed_items`, and
no `[junk-filter] DROP … link-dump-digest` line appeared in any stdout. Both are
consistent with the filter working.

The junk filter runs at *read* time inside `getClusteringItems`, not at write
time, so `preprocessed_items` always contains everything the preprocessor kept —
its presence there proves nothing. And `getClusteringItems` applies the
prefilter first and the junk filter only to survivors, so if the prefilter cut
an item the junk filter never sees it and logs nothing. Prefilter #30 cut 440
items against #29's 422. The prompt layer caught them; the deterministic layer
stood ready and idle.

Replaying all five observed titles through `classifyItem` confirms every one is
matched by the deterministic rules, so the guarantee holds if the prompt ever
regresses.

**Two real gaps the run did expose:** the two Just Security editions differed by
a single word — "a curated guide to" versus "a curated **weekday** guide to" —
and the original pattern would have caught one and missed the other. And STAT's
"This is the online version of STAT's weekly email newsletter Health Care Inc."
is a genuine newsletter edition that survived every rule. Both are now covered,
with the near-misses pinned in tests.

**Not changed:** "5 things to know before Wednesday's vote on Moda Center
negotiations", flagged as a manual watch item, is listicle-shaped but is one
story about one vote. Cutting it would be the over-cutting failure the rules are
written to avoid, and there is now a test asserting it survives.

---

## 2026-08-11 — Pass-1 scores two axes; digests cut deterministically

Both changes come from run #49/#109 — the first full-corpus run after the
excerpt fix, and the first one whose numbers were trustworthy.

### The tie storm was arithmetic, not information

**Decision:** grouping-pass-1 emits `id;;interest;;consequence;;reason`, two
independent 0–50 axes that software sums into the same 0–100 `score`. Both are
persisted (migration 033). Nothing downstream changes: the pile cutoff, the
editor formula, and a thread's `max(member score)` all read `score` as before.

**Context:** The excerpt fix worked on its own terms — pass-1 singletons went
from a 50-character body to 1000 and started using 43 distinct scores including
off-round values (57, 61, 63, 64, 66, 67, 76, 79) that had never appeared. But
the editor barely moved: 38 → 48 distinct combined scores, 127 → 119 tied rows.

Splitting the tie groups by whether the combined value was an integer explained
why. **115 of the 119 tied rows were singletons tied at an integer.** A
singleton has one source, so the editor adds `source_weight * ln(1) = 0` and
`combined == score` exactly; two singletons with the same integer score are
precisely tied, forever. The other 4 rows were two accidental cluster
collisions: `58 + 9·ln(5)` and `60 + 9·ln(4)` both equal 72.48, and a thread and
a cluster both scoring 65 across 6 sources both equal 81.13.

With ~119 singletons landing in an effective band of 57–88 — 32 integers —
pigeonhole puts at least 87 of them in a tie however good the scorer is. We
observed 115, so there was scorer headroom, but the ceiling was ~73% ties.

**Rationale:** Make the score finer rather than patch the formula. The prompt
already said the score "blends two things: how much this reader cares about the
subject AND how much actually happened" — the two axes were there conceptually
and were being collapsed inside the model, where they bunched onto round
attractors. Asking for both and summing in software spreads the distribution at
no extra call or token cost, and keeps the 0–100 scale every consumer expects.

**Alternatives considered:** A fractional tiebreak term in the editor formula
(recency, body length) — rejected as arbitrary, and it would launder a scoring
problem into the ranking arithmetic. A 0–1000 scale — rejected because models
bunch on round numbers at any scale; 550 and 580 would replace 55 and 58.
Accepting the ties and leaning on the LLM tie-break — it does work (two runs,
zero omitted refs) but costs 538s at `xhigh` and leaves tier boundaries decided
by a call rather than by the score.

**What to check next run:** distinct combined scores, largest tie group, and
whether ranks 15/16 and 75/76 still share a value. Also worth querying
`interest`/`consequence` separately now that they are stored — if one axis is
bunchy and the other is not, the prompt's bands for that axis are the next
lever.

### Link dumps are cut by pattern, not by prompt

**Decision:** `junk-filter.ts` gains three high-precision link-dump rules
(date-only titles, digest mastheads anchored to a separator, digest boilerplate
in the first 600 characters of the body). The prefilter prompt gains a
shape-based digest section, and the pass-1 consequence axis scores digests 0–4.

**Context:** Run #109 published Just Security's "Early Edition: August 10, 2026"
at **rank 9, in the feature tier**, with the joint-highest singleton score in
the paper (88). "Early Edition: August 11" was at rank 17 and a bare
"August 10, 2026" at rank 93.

This was a regression introduced by raising `prefilter.body_cap` from 50 to 500.
A roundup's body is a dense list of exactly the topics this reader cares about —
the captured prompt shows `"IRAN WAR / The secretary of Iran's Supreme National
Security Council..."` — so feeding the scorer more of it made the item look
*more* relevant, not less. The fix that improved every other item made this
class worse.

**Rationale:** The prefilter prompt has said "cut link-dump roundups" since it
was written and did not catch these, so a stronger sentence is not a guarantee.
`getClusteringItems` is the sole path into both grouping and pass-1, so a rule
there cannot be routed around: a matched item reaches the pile as neither a
cluster member nor a singleton. The prompt changes remain as a second line for
digests whose wording we have not seen.

The consequence axis is the principled version of the same judgment. High
interest is the *correct* reading of a roundup; what makes it worthless is that
nothing happened in the item itself. One number could not say that, which is
part of why the single-score prompt kept scoring them high.

**Risk accepted:** deterministic title rules can over-cut. Each pattern is drawn
from an observed run #109 row rather than written speculatively, mastheads must
be followed by a separator so "The download problem" survives, and
`tests/junk-filter.test.ts` pins both the cuts and the near-misses that must
survive — headlines containing dates, articles mentioning newsletters, and
title-only wire rows.

---

## 2026-08-11 — Judgment stages read English; every text cap moved to config

Three changes from run #47/#107, all of them things the run made visible for
the first time now that the pipeline is stable enough to read its own output.

### Singleton scoring ran on 50 characters

**Decision:** `prefilter.body_cap` (500) and `editor_pass_1.body_cap` (1000)
replace a hardcoded `slice(0, 50)` in both stages. `editor_pass_1.summary_cap`,
`thread.summary_cap`, and `editor.tie_break.body_cap` replace hardcoded 300s in
the same family. All five are required fields in the Zod schema — a stage that
shows an LLM text now has to say how much.

**Context:** `prefilter/index.ts` and `editor-pass-1/index.ts` both built their
batch payload with `body_excerpt: (item.body_text ?? "").slice(0, 50)`. Fifty
characters is about eight words. So the bio-aware relevance floor sorted run
#47's 1,206 items into cut/news/opinion on a headline plus half a lede, and
grouping-pass-1 scored all 423 singletons the same way — while scoring
*clusters* on a full describe-pass summary.

That asymmetry showed up in the editor output as a tie storm. Run #107's 150
published rows carried only 38 distinct combined scores. **127 of the 150 sat
in a tie group**, the largest holding 22 items. Both tier boundaries fell
inside a tie: ranks 15 and 16 were both `combined=78.00`, ranks 75 and 76 both
`combined=65.00`. So whether a story ran as a feature was decided by the
tie-break LLM — and for the group where that call dropped 14 refs, by
`ref.localeCompare`, i.e. alphabetical order of `S46263`-style ids.

**Rationale:** The editor is advertised as a deterministic formula with an LLM
tie-break at the margins. At 85% ties it was an LLM ranker with a deterministic
prelude, which is the thing the 2026-06-16 entry deliberately replaced. The
formula can only separate rows if its relevance input can, and a scorer with
eight words of body has nothing to separate them *with*, so it falls back to
coarse title-shaped buckets. Feeding the scorer an opening paragraph is the
cheap fix to try before touching the formula, the weights, or the tie-break.

Pass-1 gets twice prefilter's budget on purpose: it makes the finer judgment
(0–100 vs keep/cut) over a third as many items, so the better-fed stage is also
the cheaper one. Expect prefilter input tokens ~99k → ~250k.

**What to check next run:** the distinct-combined-score count and the size of
the largest tie group. If ties stay this dense with a full paragraph in hand,
the input was not the constraint and the next lever is the scoring bands in
`editor-pass-1/prompt.ts`.

### Only grouping was reading the translations

**Decision:** prefilter, grouping-pass-1, thread, and the editor tie-break now
select text through `src/lib/text.ts` — `englishTitle` / `englishBodyExcerpt`,
preferring `english_*` and falling back to the original columns. `inspect --
editor` displays English titles too.

**Context:** The 2026-06-17 entry introduced per-item translation and said
"all other stages (display, scoring, the editor, the paper) continue to read
the original title and body." That was written when the translation existed
only to put clustering in one embedding space. Since then three more bio-aware
LLM stages were built, and every one of them inherited the original-language
default without anyone deciding it. Run #47 published 33+ non-Latin-script rows
— Russian, Chinese, Korean — each of which had been through the prefilter, the
scorer, the thread pass, and a tie-break call in its original script, with a
translation sitting unread in the next column.

**Rationale:** The translation is already bought and paid for: 341 calls and a
good share of the preprocessor's 279s on this run. Reading it costs nothing.
The cost of *not* reading it is invisible by construction — a model that
half-understands a Russian headline still returns a confident integer, so the
damage looks exactly like a low-relevance story.

The display change is narrower: `inspect -- editor` is the artifact a person
reads to judge a run, and a third of it was unreadable. This does not decide
what headline the *paper* shows — the writers stage produces that.

**Supersedes:** the "all other stages read the original" clause of 2026-06-17,
for judgment stages and for the editor inspection view. The original columns
remain the source of truth for lineage and for anything reader-facing that the
writers stage does not itself rewrite.

### 403 is a bot rule, not a refusal

**Decision:** `fetch-feed.ts` retries a 403 once with a browser UA and logs the
source when that succeeds. Only 403 — 404/410/5xx are not retried.

**Context:** Run #47 lost five of 111 sources: The Baffler, TechCrunch, and
Inside Climate News to 403, Mail & Guardian to 404, Labor Notes to an XML parse
error. Seven more succeeded with zero items, including all three Reuters feeds.
The three 403s are publishers who serve the same feed to any browser.

**Rationale:** The honest UA is the right default and works for 106 sources;
escalating only after a refusal keeps it that way while costing one extra
request on the few sources that need it. The log line names them so
`sources.yaml` can record which sources are in that set.

Not fixed here, and still open: Mail & Guardian's 404 needs a new feed URL, and
the three Reuters feeds are Google News proxies returning nothing — which
matters more than it looks, because `sources` is half the editor formula and a
silently-empty wire suppresses cross-source pickup for real stories. Labor
Notes now logs the markup around the parse error so the next run says what is
actually malformed.

**Verification gap:** these were written against the reported status codes, not
against a reproduction — the development environment's network policy blocks
those hosts outright, so the UA retry is untested against the real publishers
and needs confirming on the next production collect.

---

## 2026-08-09 — Thread budget exhaustion; split floor raised to catch 4-item chains

Two changes from run #40/#105, the first run with per-component cohesion logged.

### The thread pass burned its whole budget and returned nothing

**Decision:** `thread.max_tokens` 24000 → 48000 and `thread.reasoning_effort` `"medium"` → `"low"`. `callLLM` now names the cause when an empty response coincides with an exhausted budget.

**Context:** Thread run #2 produced zero threads. Telemetry: `calls=1, errors=0, input_tokens=16776, output_tokens=24000, duration_ms=658039`. Output tokens landed **exactly** on `max_tokens` — the model spent its entire budget reasoning and emitted no content, so `callLLM` threw "LLM returned empty response" and the pass recorded `failed_calls=1`.

Run #44 had done the same job on the same 220 candidates in 4,651 output tokens and 63 seconds. Same input scale, 5× less output, 10× faster. So this is variance in how far the model spirals, not a task that needs 24k tokens.

**Rationale:** Both levers move because they address different halves of the failure. Headroom means a long reasoning pass still leaves room to answer; lower effort makes the long pass less likely at all. Finding a handful of ongoing situations among 220 headlines is pattern-matching rather than deep inference — grouping's attach and describe passes run at `"none"`. If thread quality drops, revert `reasoning_effort` to `"medium"` first and keep the larger budget, which isolates the lever.

**Not retried:** an empty response is not in `callWithBackoff`'s 429/503 contract, and adding it would mean re-issuing an 11-minute call that failed for a reason a retry does not address. Same reasoning as the translation timeout fix — treat the cause, not the symptom.

**Timeout note:** the call ran 658s against `timeout_ms: 600000`. With `stream: true` that setting is effectively a headers timeout: once headers arrive the stream stays alive. The token budget, not the timeout, is the real bound on a streaming call.

**Diagnostic:** `callLLM` previously threw a bare "LLM returned empty response", leaving an 11-minute failure with no explanation outside the telemetry table. It now reports the exhausted budget and names the two settings that cause it.

### density_floor 0.5 → 0.55

**Decision:** `grouping.split.density_floor` raised to 0.55.

**Context:** A pure chain — the exact shape the split pass exists to catch — has *n−1* edges among *n(n−1)/2* pairs, so raw density is `2/n`. At n=4 that is **exactly 0.500**. The production check is `cohesion < density_floor`, so at 0.5 the canonical four-item chain passed on a boundary equality. Run #40's cohesion line showed four components sitting precisely at 0.50, three of them size 4.

**Rationale:** 0.55 catches them; the next component up in that run scored 0.57, so nothing legitimate is swept in. Cost is roughly four extra LLM calls per run, and the model remains the precision gate — a component that is genuinely one story comes back as one group.

Chains of size 3 score 0.667 and stay out of reach. Catching those would need a floor above 0.67, which is where many legitimate components sit. That limit is inherent to a connectedness measure and is recorded rather than worked around.

**What this run could NOT settle:** the C45-class defect — run #44's 44-source `Trump meets Zelenskyy and Netanyahu amid Graham funeral`, a dense topical clique rather than a chain — **did not recur**. Run #40's largest component was size 21 (split at cohesion 0.15) and its largest unsplit was size 18 at cohesion 0.83. With no instance present, `density_floor` could not be calibrated against it, and the 0.55 change is justified by the chain-boundary argument alone. Dense cliques remain unaddressed by a connectedness measure; that needs a different signal if it recurs.

### Evidence for the thread layer, by its absence

With threading failed, run #105's paper carried **13 wildfire items across 150**, three of them in the top twenty: `Pacific Northwest wildfire season intensifies` (rank 1), `Wildfires impact Warm Springs and Klamath County` (rank 10), `Spokane wildfires burn into suburban areas` (rank 19), plus smoke-health, insurance, SNAP-relief, firefighter, and federal-tactics singletons scattered down the tiers. This is precisely the flooding the thread pass was built to remove, observed in a run where the pass did not execute.

---

## 2026-07-29 — Translation: split on call failure instead of dumping the batch

**Decision:** When a translation LLM call fails after backoff, the batch is halved and each half retried — the same recovery the missing-id path already used — rather than falling back every item in it. Only an item that fails alone, with nothing left to split, falls back to original-language text. Migration 032 adds `preprocessed_items.translation_failed` so the loss is queryable. `translation.concurrency` goes 4 → 8.

**Context:** Run #44 translated 601 non-English items and lost 23. Two LLM calls failed, both timeouts at the full 180s ceiling. With `translation_batch_size: 10`, those two failures accounted for **20 of the 23 losses** — the old code caught the error and fell back the entire batch:

```ts
} catch {
  for (const item of batch) {
    results.set(item.id, { english_title: item.title, ... , failed: true });
    stats.fallbacks++;
  }
  return results;
}
```

The remaining 3 came from the missing-id path, which already split correctly. So one error class at the worst possible granularity produced 87% of the loss.

**Rationale:** A timeout means *this payload was too slow*. Re-sending it unchanged is the one response least likely to work; halving it directly addresses the cause, and the machinery to do so already existed a few lines below. Splitting also degrades gracefully — a batch of 10 becomes 5+5, then 2+3, down to singles — so a genuinely bad item costs one fallback instead of nine bystanders.

Retrying timeouts through `callWithBackoff` was the alternative and is worse here: at 180s a retry ladder costs minutes per batch and re-sends the payload that just failed. `callWithBackoff` keeps its 429/503-only contract, which matters because it is shared with grouping, whose calls run to 600s.

**Why the flag:** the fallback writes the *original* text into `english_title`, so nothing in the database distinguished "this item is English" from "this item is Russian and we failed". The item embeds in its own language space, cannot cluster cross-language, and no query could find it. Recording the failure makes the loss measurable and lets a future pass retry exactly the affected rows.

**Concurrency:** the 10 → 4 drop (2026-07-28) assumed contention was causing the timeouts. Run #44 disproved that — translation logged 2 timeouts and **zero** rate-limit errors, so the provider was never the constraint. At 4, 61 batches take ~16 sequential rounds, which is most of the stage's 13.5 minutes. Slow calls are now handled by splitting rather than by starving the pipeline. 8 is a return toward the original setting with the failure path fixed underneath it; any 429s that appear go through `callWithBackoff`.

**Not changed:** `timeout_ms` stays 180000. Lowering it would fail slow calls faster and split sooner, which may well be better, but changing it in the same run as the split fix would make the measurement uninterpretable.

`tests/preprocessor-translation.test.ts` pins the three behaviours: a batch that times out but whose halves succeed loses nothing, splitting recurses to single items when only single-item calls succeed, and an item that fails alone still falls back *and is flagged*.

---

## 2026-07-28 — Thread layer: threads are first-class rows the editor ranks

**Decision:** A new stage between grouping-pass-1 scoring and pile assembly groups related clusters and singletons into ongoing situations. A thread is a **first-class row the editor ranks**, not presentation metadata the publisher nests. Its numbers are derived in software, never asked of the model:

```
relevance = max(member score)      sources = sum(member source counts)
```

The editor's formula is unchanged. Migration 031 adds `thread_runs` / `threads` / `thread_members`, plus `thread_id` on `editor_pile_items` and `editor_stories`. Rows absorbed into a thread are withheld from the pile — a threaded row must not also appear on its own.

**Context:** Run #43 published **five separate Oregon wildfire clusters, four of them in the top fifteen**: "Wildfires surge across Central Oregon" (12 sources), "Bench and Beachcomb fires merge, destroying homes on Warm Springs Reservation" (5), "Oregon wildfires prompt evacuations across over 1.1 million acres" (2), "Oregon National Guard activates aircraft for wildfire response" (2), and "Aid groups support Eastern Oregon farmworkers amid wildfire smoke" (2). Run #42 had carried the same story as one cluster of 11.

Grouping was not wrong by its own criterion — those are genuinely distinct events, and the attach prompt explicitly excludes items sharing only "a region, a topic, an ongoing situation." The reader's framing is the opposite: all the fires in the state right now are one ongoing thing.

**Rationale:** These are two different questions and one layer cannot answer both. Grouping asks *is this the same event?*; threading asks *is this the same continuing story?*. Trying to encode both in `similarity_threshold` fails in both directions at once, which is exactly what runs #35 and #43 showed: over-merges (a Virginia power line chained to a New York moratorium) coexisting with under-merges (the fires) in the same run.

Separating them is also what makes the split pass (2026-07-25) safe. Event clustering can be strict — can split an over-merge — without the paper losing the connection, because threading restores it at the level the reader experiences.

**Why threads rank rather than decorate:** the two options were a first-class row or publisher-only nesting. Nesting would leave the pile still holding five fire rows, so the flooding — four of fifteen feature slots on one situation — would persist and only be hidden at render time. Ranking removes the repetition at the point where it is created. Summing sources is what makes the thread outrank every member it absorbed: on run #43's data the fires thread to `score=85, sources=23` → `combined=113.22`, ahead of that day's actual lead (Trump/Zelenskyy/Graham at 111.64), and free four pile slots for other stories. Both properties are unit-tested.

**One LLM call covers the whole candidate set.** A thread's members are spread across the score range — the fires scored 85, 80, 80, 78 and 60 — so chunking by score would hide members of one situation from each other and defeat the pass. `thread.candidate_target` (220) is therefore bounded by what a single call can hold, not by cost. It is deliberately well past `pile_target` so a situation's weaker members are still visible for absorption.

**The line the prompt has to hold** is between a concrete situation anchored in a place and a time (one state's fire emergency, one war, one city's fight over one project) and an abstract theme spanning unrelated places and actors (data centers straining grids in three states; several countries separately regulating AI). Fires in Oregon and fires in Spain are two threads. The prompt states that most items belong to no thread, because the failure mode to guard against is a model grouping for the sake of thoroughness.

**Failure handling:** a failed call yields zero threads — the pass not running, rather than a wrong answer. The pile keeps its un-threaded rows and `thread_runs.failed_calls` records it. Consistent with the attach and split passes.

**Ref namespace:** threads are `T<index>`, so `src/lib/refs.ts` now recognizes `[cst]\d+`. The editor tie-break and any future stage that parses refs get thread support for free.

`inspect editor` renders a thread's absorbed members as an indented tree under the thread row, so the ranked list stays traceable without a second query.

**Deferred:** run #43's `Trump meets Zelenskyy and Netanyahu; Lindsey Graham funeral held in Washington` (42 sources, at #1) is a genuine over-merge that the split pass let through because it is a dense component rather than a chained one — cohesion protects it. Density catches chaining, not dense topical cliques. Raising `split.density_floor` from 0.5 may catch it; that is a separate change and should be tuned against a run where the thread layer is already in place, since threading changes what the pile looks like.

---

## 2026-07-28 — Run #43 follow-ups: charset retry over-corrected, Accept header restored, translation timeout raised

Three fixes from run #43, the first verification run of the charset change. The headline result was good — 1,857 pre-existing corrupted rows from Folha de São Paulo, zero new ones, and the exact title that was mojibake in run #42 arrived clean. But the run exposed one bug introduced by that change and two regressions it caused.

### The windows-1252 fallback was too eager

**Decision:** `decodeFeedBytes` now retries only when the first decode looks *systematically* wrong: at least 5 replacement characters **and** a rate of at least 1 per 2000 characters. A retry whose output carries the UTF-8-read-as-single-byte signature (`Ã`, `Ð`, `Ñ`, `Â`, `â€` above 1 per 200 characters) is rejected outright.

**Context:** Run #43's collector logged `[collector] https://meduza.io/rss/all: declared charset did not decode cleanly; recovered as windows-1252`. Meduza is UTF-8 Cyrillic — that recovery was wrong. Reproduced locally: a UTF-8 document with a single malformed byte was re-decoded whole as windows-1252, turning "Кризисную группу" into "ÐšÑ€Ð¸Ð·Ð¸ÑÐ½ÑƒÑŽ Ð³Ñ€ÑƒÐ¿Ð¿Ñƒ".

**Why this was the dangerous kind of bug:** windows-1252 maps every byte to some character, so it can never emit U+FFFD. The old logic accepted any retry that removed the replacement characters — which windows-1252 always does, unconditionally. Worse, the resulting mojibake contains no U+FFFD either, so the verification query (`title LIKE '%' || chr(65533) || '%'`) reported zero corrupted rows while the damage was present. A check that cannot see its own failure mode is worse than no check.

**Rationale:** The two cases are three orders of magnitude apart and the rate separates them cleanly. A Latin-1 document read as UTF-8 emits a replacement character for roughly every accented letter (~5 per 1000); a UTF-8 document with one bad byte emits one in the entire file. Gating on rate keeps the Folha recovery working while leaving Meduza alone. The mojibake-signature check is a second, independent guard for cases the rate gate might admit.

Two existing tests had to be rewritten around realistic multi-item documents: a single short title carries too few accented characters to look systematic, which is correct behaviour and not worth weakening the gate for. Real feeds are never one title.

**Action outstanding:** Meduza inserted one item during run #43 while the bug was live. That row is very likely mojibake and is invisible to the replacement-character query — it needs finding by inspecting Meduza rows for the `Ð`/`Ñ` signature, and deleting.

### Accept header restored

**Decision:** `fetchFeedText` sends `Accept: application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8`.

**Context:** The Baffler returned 403 in run #43 after succeeding in #42. Taking over the transport from rss-parser dropped its `DEFAULT_HEADERS`, which included `Accept: application/rss+xml`; some CDNs reject feed requests advertising no acceptable type. This was flagged as a risk when the transport changed and it materialised.

### Translation timeout and concurrency

**Decision:** `preprocessor.translation.timeout_ms` 60000 → 180000, `concurrency` 10 → 4.

**Context:** Run #43 logged 17 translation timeouts, every one at almost exactly 60s. `[preprocessor] WARNING: 171 item(s) fell back to original-language text for embedding` — 171 of 462 non-English items, 37%, were never translated. Call duration totalled 2,202,355 ms across 55 calls, averaging ~40s against a 60s ceiling, so a large share of calls sat near the limit.

**Rationale:** This silently defeats the cross-language English-space embedding the stage exists for (2026-06-17): an untranslated item cannot cluster with its English counterparts, and nothing downstream can tell. `callWithBackoff` retries 429/503 only, so a timeout is a permanent failure, not a retry — the fallback is the first and last outcome. Raising the ceiling addresses the symptom; lowering concurrency addresses the cause, since contention is what pushed per-call latency to 40s. Both, for the same reason the other stages got the same treatment.

**Not changed:** timeouts remain non-retryable. Making them retryable risks five 60s attempts per call, and the translation module already has a split-on-failure retry path (8 fired this run). The proportionate fix is to stop generating timeouts, not to retry them.

---

## 2026-07-28 — Feed charset decoded by us, not rss-parser; grouping stats persisted; prefilter concurrency lowered

Three fixes from run #42's report.

### Feed charset

**Decision:** `fetch-feed.ts` now fetches the feed body itself and passes a decoded string to `parser.parseString`. It never calls `parser.parseURL`. Charset resolution lives in the new `src/pipeline/collector/charset.ts`: Content-Type header, then XML declaration, then UTF-8, with a retry when the first decode yields U+FFFD.

**Context:** Run #42 published four titles containing replacement characters, all from Brazilian feeds — "oposição" appeared as "oposi&#65533;&#65533;o" at rank #94, and similar corruption at #100, #122, and #123. Rank #103, also Portuguese, rendered correctly, so it was not every feed.

The cause is in rss-parser 3.13.0. `utils.getEncodingFromContentType` reads the charset from the **HTTP Content-Type header only**, and its supported list is `['ascii','utf8','utf16le','ucs2','base64','latin1','binary','hex']` with aliases for `utf-8` and `iso-8859-1`. Two consequences: a feed that declares its encoding only in the XML declaration (`<?xml version="1.0" encoding="ISO-8859-1"?>`) while serving a bare `Content-Type: text/xml` is decoded as UTF-8; and `windows-1252` — an extremely common label — is not in the list, so it is discarded and UTF-8 used. Latin-1 bytes read as UTF-8 produce U+FFFD, reproduced exactly in Node: `Buffer.from('oposição','latin1')` decoded as UTF-8 gives `oposi��o`.

**Rationale:** This is a data-integrity bug, not a display bug. The corruption happens at fetch time, so mangled titles were written to `raw_items`, embedded by the grouping stage, and scored by grouping-pass-1. Every downstream stage saw the damage. Fixing at render time would have left the embeddings wrong.

ISO-8859-1 is decoded as windows-1252, matching the WHATWG encoding standard and browser behaviour: bytes 0x80–0x9F are undefined in true Latin-1 but carry printable characters (curly quotes, em dashes) in what publishers actually emit under that label. The header wins over the declaration because it describes what was transmitted; a stale declaration in a re-encoded document is the more common disagreement. The U+FFFD retry exists because some feeds send a header that contradicts their own bytes, which is the specific shape that produced this bug.

`tests/collector-charset.test.ts` uses the four real corrupted titles from run #42, and pins that genuine UTF-8 (including Russian, Korean, and Chinese titles) is untouched.

### Grouping run stats

**Decision:** Migration 030 adds `cluster_count`, `singleton_count`, `attach_calls`, `attach_failed_calls`, and six `split_*` counters to `grouping_runs`. All nullable — NULL means the pass did not run, which is distinct from zero.

**Context:** `failed_calls` and the split pass counters were printed to stdout only. Reports regenerated from persisted records therefore could not show whether a run's grouping was trustworthy, and assessing runs #37 and #42 required inferring the split pass had worked from the shape of the cluster/singleton ratio rather than reading it. Two of these counters are exactly the "is this run usable" signal: a non-zero `attach_failed_calls` means clusters were never offered their candidates, and a non-zero `split_failed_calls` means over-merges were retained.

### Prefilter concurrency

**Decision:** `prefilter.concurrency` 10 → 4, with `retry_max_attempts` / `retry_base_ms` added. `BatchStageConfigSchema` gains the optional retry fields, and `processBatch` now receives them — it was calling `callWithBackoff(fn, {}, "prefilter")`, so any per-stage retry configuration would have been silently ignored.

**Context:** Run #42 logged 7 rate-limit errors across 41 prefilter calls, the same saturation grouping hit at concurrency 10 (fixed 2026-07-25). Prefilter recovers via backoff and fails safe by keeping items as `news`, so this is throughput tuning rather than a correctness fix — but the empty-config bug was real and would have defeated any attempt to tune the retry behaviour.

---

## 2026-07-25 — Split pass (step 2b): union-find over-merges are re-partitioned by the LLM

**Decision:** A new step between candidate groups and attach. Step-2 connected components that are large enough to chain (`min_size`, default 3) and loosely connected (cohesion below `density_floor`, default 0.5) get one LLM call that re-partitions them into same-event groups. Dense components pass through with no call. Members the model places in no group rejoin the singleton pool, where attach can pick them up. Controlled by `grouping.split.*`.

**Context:** Run #35 was the first clean run (`failed_calls: 0`), so its grouping output was finally trustworthy — and it showed both over-merge and under-merge at once. The over-merge case: feature #15, "Power grid strains and data center moratoriums amid AI growth," joined a fallen Northern Virginia power line, Hochul's New York data center moratorium, and a delayed New York transmission line. Three unrelated events.

The cause is that `src/pipeline/grouping/index.ts` turned every union-find component of size ≥ 2 straight into a cluster via `buildAutoCluster`, with **no LLM validation at any point**. Attach only ever adds to those clusters; nothing splits them. So the attach prompt's carefully written rule —

> *A candidate that shares only a region, a topic, an ongoing situation, or a cast of actors — while reporting a development that stands on its own — is NOT the same event*

— never applied to the clusters that needed it most, because they were formed before any model looked at them. Union-find requires only a *path*: A~B and B~C puts A, B, C together even when A and C are unrelated.

**Rationale:** Density separates the two shapes cleanly. A genuine same-event cluster is near-fully connected — every article about one fire resembles every other — while a chained component is a path. Thresholding on it means the dense majority never costs a call, so the pass is a small bounded addition rather than another per-cluster LLM stage.

**The correction that makes it work:** raw density is size-dependent under the `top_k` cap. Each item can hold at most `top_k` neighbours, so a component of size *n* cannot exceed `top_k/(n-1)` density — at `top_k: 15` a 37-item component tops out at 0.42, *below* the 0.5 floor. Thresholding raw density would therefore flag run #35's 37-source US-Iran cluster (the paper's lead) as maximally chained, every single run, and risk shattering it. `computeCohesion` divides by `maxAchievableDensity` so 1.0 means "as connected as it could possibly be" at any size, while a chain stays near zero regardless of size. This was caught before the first run, not after.

**Failure handling:** a split call that fails after retries leaves its component intact. That is the conservative direction — the outcome is the over-merge we already had, not a shattered cluster. It is deliberately distinguished from the model legitimately answering "none" (which does dissolve a component into singletons), so `failed_calls` counts only real failures. Same reasoning as the attach-pass backoff entry above.

**Not addressed here:** the *under*-merge half of run #35 — the Oregon wildfire coverage fragmenting into four separate rows (Akawa Butte/Sisters, statewide intensification, OSHA smoke guidance, ranchers assisting), plus eight wildfire items across the 150-item paper. That is the opposite error and needs the opposite fix: a thread layer above clusters that groups related clusters into one ongoing situation, scored as `max(member scores)` with `sum(member sources)`. The reader's framing is that all the fires in the state right now are one ongoing thing. Splitting event-level clustering from situation-level threading is what lets event clustering get *stricter* (this entry) without losing relatedness. Deliberately deferred to its own change.

`tests/grouping-split.test.ts` covers `computeComponentDensity`, `maxAchievableDensity`, `computeCohesion`, and `parseSplitOutput`, including the large-coherent-cluster and large-chain cases that the cohesion correction exists for, and a regression for the power-grid component shape.

---

## 2026-07-25 — Grouping attach/describe wrapped in 429 backoff; concurrency lowered from 10 to 4

**Decision:** `grouping`'s attach and describe passes now call the LLM through `callWithBackoff` (`src/llm/backoff.ts`), configured by new optional `retry_max_attempts` / `retry_base_ms` fields on `grouping.attach` and `grouping.describe`. Both passes drop from `concurrency: 10` to `concurrency: 4`. The attach pass counts calls that fail after retries into a new `failedCalls` field, logs `failed_calls=<n>` in its summary, and emits an explicit warning that the run's cluster/singleton split understates real grouping when that count is non-zero.

**Context:** Run #34 (2026-06-19) logged **81 rate-limit errors across 163 grouping LLM calls** — roughly half the pass. Grouping was the only batched, concurrent stage that never adopted `callWithBackoff`; preprocessor translation and prefilter had it, grouping did not. Worse, the attach pass caught every error and returned an empty set:

```ts
} catch (err) {
  console.warn(`[grouping] attach phase ${phase} ${label}: LLM call failed: ${msg}`);
  return new Set();
}
```

An empty set is exactly what the model returns when it declines every candidate. So a 429 was indistinguishable from a legitimate "none of these belong" verdict: the cluster silently didn't grow, the run reported success, and the recorded result (114 clusters, 588 singletons) was presented as a real grouping outcome. The describe pass had the same shape, degrading to fallback labels.

The damage is visible in editor run #99's output. S32649 ("How many Americans can afford high-quality health care? A new poll finds the number has fallen", score 70, rank 80) and S32362 (the same AP story with a `- AP News` suffix, score 65, rank 117) survived as two separate singletons ranked 37 positions apart. Title-only embedding at `candidate_floor: 0.55` should catch a near-identical headline pair trivially.

**Rationale:** Retrying is the obvious half. The more important half is that a degraded result must not be able to impersonate a real one. Phase A and Phase B both run under the same `pLimit`, so `concurrency: 10` meant up to ten in-flight calls against nanogpt for the whole pass; 4 trades wall time for not triggering the limiter, which is the right trade when the failure is invisible rather than loud. Backoff remains the safety net for what still slips through, and `failed_calls` makes any residual loss legible in the run summary rather than buried in a warning line.

This also means **run #34's grouping output should not be used to evaluate cluster quality or to tune `similarity_threshold`** — including the two conjoined feature clusters in editor #99 (C1 "Ukraine drone attacks on Moscow and Hegseth NATO review", C15 "Apple price increases and Intel chip deal"). Whether those are genuine over-merges at 0.66 or artifacts of the degraded run is not answerable from that data. Re-run first.

`tests/llm-backoff.test.ts` added: pins retry-then-succeed, exhaust-then-throw, fail-fast on non-rate-limit errors, message-variant recognition, and `Retry-After` honoring. `callWithBackoff` had no direct test despite now being load-bearing for three stages.

**Supersedes:** Nothing — this is the retry policy the 2026-05-30 "No retry logic in V1" entry deliberately deferred, and the no-SDK-retries rule still holds. Retries live in application code; this just extends the existing `callWithBackoff` to the stage that was missing it.

---

## 2026-07-25 — Researcher stage dropped; docs reconciled with what was actually built

**Decision:** The researcher stage is removed from the pipeline. The editor's ranked, tiered output feeds the writers directly. `src/pipeline/researcher/` is deleted, the `researcher:` block is removed from `config/models.yaml`, and `researcher` is removed from `ModelsConfigSchema`. The pipeline is now eight stages: collector → preprocessor → prefilter → grouping → grouping-pass-1 → editor → writers → publisher, of which the first six are built.

Alongside this, the docs were reconciled with the code after a month of structural drift:

- **CLAUDE.md's editor section was wrong.** It described a whole-pile single LLM call emitting `tier;;ref;;reason`, recognition-based parsing, and retry-once-then-fallback via `editor.fallback`. The editor has been a deterministic combined-score formula with an LLM tie-break since 2026-06-16, and `editor.fallback` no longer exists in `models.yaml`. Rewritten to match.
- **Dead `filter:` block removed from `models.yaml`.** The filter stage was folded into the prefilter (2026-06-13) and its table dropped by migration 026. The block was not in `ModelsConfigSchema`, so Zod had been silently discarding it.
- **`docs/concept.md` stage architecture rewritten** to match reality: prefilter and grouping-pass-1 added as named stages, the researcher section replaced by grouping-pass-1 and the real editor, storage table list and model assignments corrected, and the standing memo reframed as a writers-stage voice document rather than an editor one.
- **README** referenced `docs/standing-memo.md`, which does not exist; corrected, along with the stage count and script list.
- **Migration numbering:** `025` was used twice. The runner sorts and tracks by filename, so both apply correctly and deterministically — no action needed beyond documenting that the next number is 030.
- **`npm test` added** (`scripts/test.ts`): discovers every `tests/*.test.ts` and runs each in its own tsx process. The ten test files already existed and passed, but there was no way to run them as a suite.

**Context:** Development from mid-June onward pushed editorial judgment upstream — into the bio-aware prefilter and the grouping-pass-1 scorer — and progressively simplified the editor until it became arithmetic. The researcher was conceived when the editor was imagined as an orchestrated multi-call stage consuming "article ideas": self-contained units the researcher would build by fetching full text and following threads. That consumer no longer exists in that form. Grouping already does the clustering the researcher was going to do during research, and it does it on embeddings rather than an agentic loop.

**Rationale:** The researcher's remaining unique job would have been fetching full article text beyond the RSS excerpt. That is a real need for the writers, but it is a bounded fetch-and-extract problem, not an agentic loop with step budgets — and it belongs to whatever feeds the writers, not to a separate stage between grouping and the editor. Keeping an unbuilt agentic stage in the architecture diagram was actively misleading about what the pipeline is: seven of its eight stages are software or bounded LLM calls, and the one genuinely agentic component was the one nobody built. Dropping it also removes the "independent reporting" pressure that CLAUDE.md already lists as out of scope for V1.

**Open question this creates:** the writer package — angle, voice brief, editorial notes, target length — was going to be produced by the editor's phase 4 from the researcher's article ideas. Neither exists now. Before the writers stage can be built, decide whether the editor grows a package step or the writers work directly from the grouping digest plus tier. Recorded in `concept.md` under Stage 6.

**Supersedes:** The seven-stage architecture in `concept.md`, and every description of the researcher as a planned stage.

---

## 2026-06-19 — Attach pass rebuilt as cluster-centric (Phase A + Phase B), replacing anchor-centric round loop

**Decision:** Replaced the anchor-centric attach loop (one LLM call per singleton, ~1,200+ calls/run) with a cluster-centric two-phase design where calls scale with clusters and proto-groups, not singletons.

**Phase A — grow existing clusters:** For each step-2 cluster, gather candidate singletons whose title-embedding cosine to any cluster member >= `candidate_floor`. If a cluster has ≥1 candidate, make ONE LLM call: present the cluster's member titles and a numbered list of candidate titles; the model returns which candidates (if any) cover the same event. Clusters with no candidates make no call. Candidate lists exceeding 40 items are chunked (40 per call, results unioned) as a token guard.

**Phase B — cluster leftover singletons:** Take singletons not consumed in Phase A. Form proto-groups via union-find connected components on title-embedding cosine at `candidate_floor`. For each proto-group of size ≥2, ONE LLM call: present the group's titles; the model returns which subset covers the same event. Confirmed subsets become new clusters; unconfirmed items stay singletons.

**Cascade:** One bounded re-pass of Phase A restricted to clusters that changed (grew in Phase A or formed in Phase B), then stop. This recovers the cascade correctness of the old round loop without running a full Phase A again.

**Contention:** If two clusters confirm the same singleton in Phase A, results are applied in ascending cluster-index order (lower index wins). The cascade re-pass naturally resolves any remaining ambiguity.

**Logging:** `phase_a_calls`, `phase_b_calls`, `total_calls`, `attached`, `new_clusters`, `singletons before→after`.

**Context:** Run #31 produced ~1,268 attach-pass LLM calls across rounds (anchor-centric). The root cause was call shape: the old design made one call per anchor (singleton), and with ~520 eligible anchors across 2–3 dirty rounds, calls scaled with singletons × rounds. The dirty-tracking optimization (2026-06-18) reduced redundant re-judgments within the round loop but did not change the O(singletons) scaling of Phase A itself.

**Rationale:** The correct unit of grouping is the cluster, not the singleton. A cluster with 8 candidates needs one call to evaluate all 8, not 8 calls from each singleton's perspective. The new design produces call counts in the low dozens (clusters with candidates + proto-groups), regardless of how many singletons exist. Phase A and Phase B run concurrently under `pLimit(config.concurrency)`.

**Supersedes:** The anchor-centric concurrent-rounds design (2026-06-18) and the dirty-tracking amendment (2026-06-18). `AttachCandidate`, `AttachProposal`, `applyAttachRound`, `computeNextDirty`, the round loop, and dirty-anchor tracking are all removed. `buildClusterCandidateSingletons`, `buildProtoGroups`, `chunkArray`, and `parseAttachOutput` replace them.

---

## 2026-06-18 — Attach rounds: dirty-anchor tracking eliminates redundant re-judgments

**Decision:** After each attach round, only re-judge singletons whose candidate set could have grown. `computeNextDirty` computes this set: for each remaining singleton, check its title-only cosine similarity against every item in `changedMemberIds` (the item_ids of every cluster that grew or was newly formed this round); if any cosine >= `candidate_floor`, the singleton is dirty. `dirtyAnchors` drives the outer loop — `while (dirtyAnchors.size > 0)` replaces `while (true)`. Round 1 is a full pass (all singletons dirty), matching the previous behavior exactly. Subsequent rounds judge only the dirty subset. `applyAttachRound` now returns `changedMemberIds` alongside `attachedToCluster` and `newPairsFormed`. `computeNextDirty` is exported as a pure function for unit testing. Per-round logging adds `dirty_anchors=<n>` so the shrinking pattern is visible.

**Context:** The concurrent-rounds rewrite (see previous entry) recovered throughput but re-judged all ~520 eligible anchors every round — anchors that had returned "none" against an unchanged candidate set returned "none" again. On a full day with ~5 rounds, this produced ~2,500 total LLM calls instead of ~520, adding ~44 min of wall time and erasing most of the concurrency win.

**Rationale:** An anchor's LLM verdict can only change if its candidate list changes. A candidate list changes only when a new cluster (or a cluster growth) brings a member within `candidate_floor` of the anchor. `computeNextDirty` checks only the newly changed members — O(remaining_singletons × changed_members) per round — not the full cross-product. Completeness is preserved: cascade anchors (singletons near newly formed clusters) are correctly included. Singletons that returned "none" in round 1 and are not near any changed member are never re-judged, converging the dirty set to empty in a couple of rounds. Total LLM calls ~ eligible count + small cascade tail (~520 + O(10)), not eligible × rounds.

**Supersedes:** The "round loop repeating until a round produces zero new merges" termination condition described in the parallelization entry (2026-06-18 above), which re-judged all eligible anchors every round. The loop now terminates when `dirtyAnchors` is empty (which happens automatically when `changedMemberIds` is empty, i.e., no merges occurred).

---

## 2026-06-18 — Attach pass parallelized via concurrent rounds with deterministic post-round apply

**Decision:** Replace the sequential per-anchor loop in `attachSingletons` with concurrent rounds. Each round: (1) snapshot current state (`remainingSingletonIds`, `currentClusters`); (2) compute `anchorBestSim` for all remaining singletons against the snapshot; (3) build candidate lists for all eligible anchors from the snapshot (existing `buildAttachCandidates` logic, `candidate_floor`, no top-k cap — unchanged); (4) run all LLM calls concurrently under `pLimit(config.concurrency)` + `Promise.all` — no state mutation during the round; (5) apply proposed merges deterministically: sort by `anchorBestSim` desc, apply via union-find, skip any anchor or target singleton already consumed by an earlier-applied (higher-sim) merge this round. Newly-formed clusters become valid targets in the **next** round — cascade attach is preserved. Rounds repeat until a round yields zero new attaches and zero new pairs. `applyAttachRound` is exported as a pure function (modulo in-place mutation of the passed arrays) for unit testing.

`grouping.attach.concurrency` (already 10 in `models.yaml`) now governs actual in-flight LLM calls; the old sequential loop held parallelism at 1 regardless of this setting. The comment on the `concurrency` key in `models.yaml` is updated accordingly.

**Context:** With ~520 eligible anchors on a full day and ~12s per LLM call (glm-5.1:thinking at xhigh reasoning effort), the sequential loop produced ~99 minutes of wall time. The serialization was required for correctness in the original design (each anchor's candidates depended on which singletons were already consumed), but the dependency only matters at round granularity, not call granularity: within a round, all anchors build candidates from the same snapshot, making their calls fully independent.

**Rationale:** Concurrent calls within a round recover the throughput lost to sequentialization without breaking correctness. The deterministic post-round apply (highest `anchorBestSim` wins a contested singleton) is equivalent to the sequential approach for the common no-contention case, and produces a principled, reproducible result in the contention case. The sequential loop was the sole cause of the ~99-min runtime — embedding and graph density were not factors.

**Supersedes:** The "sequential union-find" description in "Grouping attach pass reworked: title-only embeddings + singleton↔singleton pairing" (2026-06-16), which described processing anchors serially in descending best-sim order. The round-based approach replaces the serial loop; cascade and correctness guarantees are preserved.

---

## 2026-06-18 — Preprocessor: opt-in flag to skip cross-run dedup for repeatable testing

**Decision:** Added `--skip-cross-run-dedup` (default `false`) to `scripts/preprocess.ts` and `runPreprocessor()`. When `true`, the cross-run dedup block is bypassed entirely — `freshCandidates` is set directly to `candidates` without querying `preprocessed_items` history. Within-batch dedup (same source+URL collapse) always runs regardless of the flag. The flag triggers a loud console warning banner at run start, is recorded as `cross_run_dedup_skipped BOOLEAN` on the `preprocessor_runs` row (migration 029), and is shown in the end-of-run summary. Pure helpers (`normalizeTitle`, `buildCrossRunKeys`, `isCrossRunDuplicate`) extracted to `src/pipeline/preprocessor/dedup.ts` for testability without a DB connection.

**Context:** Cross-run dedup is correct production behaviour — the same article must not appear in two consecutive papers. But it makes the preprocessor non-idempotent: running it twice on the same day's data produces near-empty output on the second run, which makes testing the downstream stages (prefilter, grouping, editor) against today's articles impossible without collecting a fresh batch first.

**Rationale:** A boolean flag with a safe default keeps the production path unchanged. Recording it on the DB row provides an audit trail so it's clear which preprocessor runs seeded the downstream stages with duplicate-suppression off. Extracting the three pure dedup helpers lets the test file import them directly without a DB dependency, keeping the test lightweight and fast.

---

## 2026-06-18 — Preprocessor input window: fixed 24h on fetched_at, retire previous-run anchor

**Decision:** Replace the preprocessor's previous-run anchor with a fixed `window_hours` window (default 24) on `raw_items.fetched_at`. Every run now selects items fetched in the last 24 hours regardless of how recently the prior run completed. The cross-run dedup block (lookback_days) is retained unchanged: same-day re-runs return near-empty by design because already-processed stories are suppressed, not because the input window shrank. At run start, log `[preprocessor] window: <start> → <end> (<n> raw items selected)`; warn loudly if n=0. The `max_age_days` published_at backstop is unchanged. The config field is renamed from `fallback_hours` (a fallback for the first run) to `window_hours` (the actual window size, always applied).

**Context:** The previous anchor design used the prior successful preprocessor run's `started_at` as the window start. On a pipeline that runs every few hours, the effective window would shrink to 2–4 hours, so only a few hundred items went forward instead of the full day's collection. On the first run or after a gap, `fallback_hours` (48h) applied. The shrinking window was the root cause of items from the early part of the day never reaching clustering.

**Rationale:**
- **Fixed window solves the shrinking problem.** A 24h window on `fetched_at` is independent of run cadence; every run sees the same day's items. Cross-run dedup still prevents double-processing.
- **Replay-by-pinning considered and rejected.** An alternative was to accept an explicit `--window-start` flag for replays. Rejected as unnecessary: the cross-run dedup lookback handles re-runs naturally (already-processed items are suppressed), and the fixed window is simple enough that manual inspection or debugging doesn't need a separate replay mode.
- **`fallback_hours` retired.** With a fixed window, the concept of a fallback for the first run is gone — the window is always `now() - window_hours`. The first run behaves the same as any other run.

---

## 2026-06-17 — Preprocessor translation: batched JSONL calls with split-on-failure retry

**Decision:** Replace the per-item translation design (2 LLM calls per non-English item — title then body) with a batched design: one LLM call covers both title and body for N items (default `translation_batch_size: 10`). Output is JSONL keyed by stable id. Alignment safety: any id missing from the output triggers a recursive split-on-failure — the missing subset is halved and each half is retried, down to a 1-item floor. A 1-item batch that still produces no output falls back to original text. 429/503 errors on any call are retried with exponential backoff + jitter (`callWithBackoff`, shared utility in `src/llm/backoff.ts`) before splitting. The same `callWithBackoff` wrapper is applied to prefilter batch calls.

**Context:** The per-item design produced ~2 LLM calls × ~180 items = ~360 calls/run. At NanoGPT's rate limits this saturated the endpoint and produced cascading 429 errors. The design also had no 429 backoff at the HTTP layer (callLLM sets `maxRetries: 0` by design) and no retry logic in the preprocessor, so 429s immediately fell back to original text.

**Rationale:**
- **Call reduction.** 180 non-English items at batch size 10 = 18 calls, not 360. Even at full non-English feeds the call count stays manageable.
- **JSONL keyed by id, not position.** Models may reorder items in the output or omit some. Position-keyed parsing would silently misattribute translations. Id-keyed parsing is robust to ordering and detects missing items cleanly.
- **Split-on-failure over whole-batch fallback.** When a batch produces partial output, re-sending the full batch wastes tokens and often produces the same partial response. Halving isolates the problematic item and recovers the rest. The recursive split converges to individual items in O(log N) rounds.
- **Backoff before splitting.** 429/503 is a rate-limit signal, not a model failure. The right response is to wait and retry the same call, not to split. Splitting is reserved for alignment failures (model omits ids). The two recovery mechanisms are orthogonal.
- **Shared `callWithBackoff` utility.** Prefilter had the same latent 429 vulnerability (10 concurrent calls, no backoff). Wrapping its per-batch `callLLM` with the same utility costs one import and one wrapper; the outer fail-safe catch still handles non-429 errors as before.
- **Concurrency reduced.** `translation.concurrency` dropped from 5 to 2; with batch size 10, peak in-flight tokens are 10× higher per call than the old per-item calls, so lower concurrency avoids the same burst.

---

## 2026-06-17 — Cross-language clustering: translate non-English items to English at preprocess time

**Decision:** Translate non-English item titles and bodies to English in the preprocessor, store results in `english_title` / `english_body` columns (migration 028), and embed those columns in the grouping stage. All clustering happens in one English vector space. Originals are retained for display, scoring, and editor passes — nothing that the human reader sees is affected by translation. Language detection uses franc-min@6 per item, not per source, with a heuristic that treats `und` (undetermined) + non-Latin script as non-English. Translation failures fall back to original text (item is never dropped). Design is idempotent: items with `english_title` already set are copied through without calling the model.

**Context:** Same-event articles in different languages (e.g., an AP English and an AFP French report on the same story) produce embedding vectors in separate language sub-spaces and score low cosine similarity even for nearly identical content. The grouping stage's similarity threshold and union-find graph then fail to connect them, leaving them as separate singletons or — worse — placing them in separate clusters that the editor sees as two different "stories." Cross-language same-event deduplication was structurally impossible with the old per-language embedding approach.

**Rationale:**
- **Embedding in one language space.** Multilingual embedding models (like the Qwen3-Embedding-8B in use) have sub-spaces per language that don't fully collapse — same-event pairs in different languages can score 0.4–0.5 even when the threshold for intra-language same-event pairs is 0.66. Translating to English first forces all items into the English sub-space where same-event similarity reliably clears the threshold.
- **Per-item detection, not per-source.** Some sources publish in multiple languages or mix languages. Per-source classification would require hand-labeling every source and break on mixed feeds. franc-min adds ~0ms per item and is accurate enough for the triage decision.
- **Originals retained.** Translations are stored alongside originals, not replacing them. The editor, reader, and all display paths use the original title and body. Only the embedding input changes.
- **Translation model choice.** Qwen3.6-35B-A3B via NanoGPT: fast, cheap, high quality on mechanical translation. Reasoning off (`reasoning_effort: "none"`): this is a copy-and-translate task with no editorial judgment needed.

---

## 2026-06-16 — Grouping attach pass reworked: title-only embeddings + singleton↔singleton pairing

**Decision:** Rework the grouping attach pass (step 3) along two axes:

1. **Title-only embeddings for candidate scoring.** Step 1 now embeds each item twice — a body embedding (`title + body[:2000]`, unchanged, used for step-2 connected-components) and a new title-only embedding (`title` alone), stored in a new `title_embedding vector(4096)` column (migration 027). The attach pass generates and scores candidates on `title_embedding` cosine similarity rather than body cosine. Config: `grouping.attach.candidate_floor` (default 0.55) replaces the old `attach_floor` (0.50); `candidate_top_k` (default 8) caps the candidate list per anchor. The old `[attach_floor, similarity_threshold)` near-miss band is retired — there is no upper cutoff and no auto-accept tier; the LLM decides all candidates.

2. **Singleton↔singleton pairing.** The old attach pass grew existing clusters only; two same-event singletons could never merge. The new pass is anchor-centric: for each singleton anchor (processed in descending best-title-sim order), candidates include both existing clusters and other remaining singletons above `candidate_floor`. A confirmed singleton↔singleton match forms a new 2-item cluster visible to subsequent anchors (enabling cascade attachment in the same run). Sequential union-find ensures each consumed singleton is not reprocessed.

**Context:** Measured on a scratch run: the EN/EN Ebola article pair scored 0.587 on `title+body[:2000]` (body text buries the headline signal, leaving the pair below the 0.66 step-2 threshold and both stuck as singletons) but 0.908 on title-only. The pair was correctly identified as the same event and would have been confirmed by the LLM — but the old attach pass was cluster-anchored, so two singletons never saw each other. Cross-language same-event matching (EN/PT Ebola pair: 0.508 even on title-only) remains below any reasonable floor and is out of scope.

**Rationale:**
- **Title dominates same-event signal; body adds noise.** An article's body elaborates on context, quotes, and background — material that two reports on the same event write differently. The headline is the purest same-event signal. Separating them lets step 2 use the richer body embedding (better for topic-level connected-components) and step 3 use the title embedding (better for same-event precision at the attach stage).
- **No auto-accept tier.** Measured pairs: same-event title-only sims run 0.78–0.91; the Wear OS 7 / Android 17 false pair scores 0.785. There is no threshold that separates confirmed pairs from junk — only the LLM can distinguish them. The floor exists solely to skip true orphans and limit prompt length.
- **Singleton↔singleton closes a structural gap.** The prior design was incapable of merging two same-event singletons regardless of similarity, because the pass was anchored to existing clusters. The new design treats every singleton as a potential anchor, so two orphan articles on the same event can be caught without requiring either to have clustered in step 2.
- **Sequential union-find preserves cascade.** Processing anchors in best-sim order and updating state between rounds ensures that a pair formed in round N is visible as a cluster candidate in round N+1. This is intentionally sequential — the state update is the point.

**Supersedes:** The `attach_floor / [floor, threshold)` near-miss band design in "Grouping clusterer: validated threshold 0.72, attach pass design, operational lessons" (2026-06-12). The band logic, threshold-as-upper-bound, and per-cluster-anchor structure are all replaced by the anchor-centric title-embedding design above.

**Correction (2026-06-16):** `candidate_top_k` (initially added as part of this design) was removed immediately after: a per-anchor cap can silently drop genuine same-event candidates that clear `candidate_floor`, violating dedup-completeness. `candidate_floor` is the sole candidate filter.

---

## 2026-06-16 — Editor tie-break: bio-aware LLM ranking for identical combined scores

**Decision:** After computing the combined formula score (`relevance + W×ln(sources)`), any group of 2+ items that land on the same combined score is passed to a small, cheap LLM call (glm-5.1, nanogpt, `max_tokens: 512`) that reads `docs/bio.md` and ranks them against each other best-first. The model's within-group order becomes the tiebreaker in the final sort: `combined desc → llm_tie_rank asc → ref asc`. `ref` stays as the last-resort fallback if a call fails or returns an incomplete list — any item the LLM omits gets effective rank Infinity (sorted to the end of its group, then by ref), logged by name. A failed call (exception) produces an empty rank map for that group, which degrades cleanly to ref order for all members without dropping any item. Tied groups are independent and run concurrently (p-limit at `editor.tie_break.concurrency`). `editor_runs.model_used` is updated to `formula:combined-score+tie-rank:{model}` if any tie-break calls were made; it stays `formula:combined-score` if there were no ties. Items that went through a tie-break call include `tie-rank:N` in their `editor_stories.reason` field for inspection.

**Context:** The previous formula's tiebreaker for equal combined scores was ref order — `C3` before `S17566` — which is alphabetically arbitrary and produces a different ordering each time the grouping run produces different cluster indices. Where two singletons have the same relevance score and both have `sourceCount=1` (which makes their combined scores identical), or where two clusters with the same score happen to have the same size, the paper's ordering at those positions is effectively random.

**Rationale:**
- **The formula handles the easy cases; the LLM handles only the hard ones.** The vast majority of items are resolved by the combined score alone. Tie-break calls happen only where the formula genuinely cannot distinguish. On a typical 150-item pile the number of tied groups is small (often zero or low single digits); the cost is proportional to how often the formula produces exact ties.
- **Bio-aware ranking is the right judgment for ties.** At a tie, the formula has no information; the only signal left is what this reader cares about. That's exactly what `docs/bio.md` encodes. Sending the reader's profile and a handful of similarly-scored items to a cheap model is the minimal LLM call that adds real value.
- **Graceful degradation.** A failed call or incomplete output falls back to ref order for that group — deterministic, logged, and no items are dropped. The paper is always complete; the tie-break only improves ordering, it doesn't gatekeep.
- **Small-call shape, not whole-pile reasoning.** Each call sees only 2–N items from a single tied group, not the full pile. This keeps individual calls cheap and fast, and bounds the cost by the number of actual ties rather than pile size.
- **Same call pattern as the scorer.** `callLLM`, `p-limit`, `generation_logs`, flat ref output parseable by `normalizeRef` — same conventions as `editor-pass-1` and `grouping`.

**Supersedes:** The ref-order-as-tiebreak portion of "Editor replaced with deterministic formula" (2026-06-16), which fell back to `localeCompare` on refs after exhausting combined and relevance as tiebreakers.

---

## 2026-06-16 — Editor replaced with deterministic formula; LLM tierer dropped

**Decision:** Remove the whole-pile LLM call from the editor stage and replace it with a deterministic combined-score formula. For each pile item:

```
combined = relevance + W × ln(sources)
```

where `relevance` is the grouping-pass-1 score already on the pile item, `sources` is the source count (cluster member-id-list length for clusters, 1 for singletons), and `W` is a tunable weight constant (configured at `editor.source_weight`, starting at 9). `ln(1) = 0` so a single-source item gets no source lift; a 53-source cluster gets roughly +35 points at W=9. Items are sorted by combined score descending, with tiebreak by relevance descending then ref ascending for determinism. Tiers are assigned by position: the top `editor.tiers.feature` (15) items are `feature`, the next `editor.tiers.standard` (60) are `standard`, and the rest are `brief`. If the pile has fewer items than the tier total, features fill first, then standard, then brief — the last tier absorbs the shortfall. `cut` is not produced by the formula but is retained in the `EditorTier` type for schema compatibility. Output and storage are unchanged: `editor_runs` and `editor_stories` are written with the same columns; `model_used` is set to the sentinel `"formula:combined-score"`.

The deleted code: `callLLM` and `LLMCallOptions` imports; `buildSystemPrompt` and `buildUserPrompt` from `prompt.ts`; `normalizeRef` import; the `SINGLETON_FAILSAFE_STANDARD_SCORE_THRESHOLD` constant; `failSafeTierForMissingItem()`; `attemptEditorCall()`; `parseEditorOutput()`; `EditorStoryResult` and `EditorParseResult` interfaces; the entire primary-retry-fallback call block; and `src/pipeline/editor/prompt.ts` in full (nothing outside the editor imported it). `EditorStageConfigSchema` in `src/config/models.ts` is replaced with a simple two-field schema (`source_weight`, `tiers`); `EditorFallbackConfigSchema` and `EditorFallbackConfig` are deleted.

**Context:** A bake-off on pile #43 showed the LLM tier-assignment call is unstable across identical runs: the standard/brief split varied 29/112, 55/84, 129/8, and 136/6 on the same pile with the same model. The assignment the model makes in one run has no relationship to what it makes in the next. This makes the paper's structure non-reproducible and makes A/B comparison of pipeline changes impossible, because the tier distribution shifts between runs for reasons unrelated to any pipeline change being tested. The instability also defeats the goal of a fixed-size paper: the writers stage needs a stable amount of content each day, but a tier split that swings by 130 items run-to-run cannot deliver that.

**Rationale:**
- **The tier split is a fixed-paper-size policy, not an editorial judgment.** The point is a predictable daily artifact with a stable amount of content for the writers stage. A formula that produces the same tier split on the same pile every time is strictly better than an LLM that swings 130 positions between runs for the same input.
- **Relevance is already scored.** Grouping-pass-1 produces a calibrated 0–100 bio-relevance score for every item. The LLM was re-deriving an ordering signal already present in the pile; the formula uses it directly.
- **Source count as a magnitude proxy.** A cluster covered by 53 sources is almost certainly a bigger story than one covered by 2. The `W × ln(sources)` term gives multi-source clusters a lift that reflects genuine world coverage without requiring a model to make that judgment.
- **Free and instant.** No tokens, no latency, no provider dependency for this stage.
- **Unit-testable.** The formula is deterministic: a fixed pile with known scores and source counts produces known combined scores, known sort order, and known tier cuts. The test lives in `tests/editor-formula.test.ts`.

**Supersedes:** "Editor repurposed: tier-only, pile arrives pre-ranked, lightweight pile presentation" (2026-06-16) — the LLM is now entirely removed; tier assignment is deterministic. Also supersedes "Editor model: kimi-k2.6:thinking primary, glm-5.1:thinking fallback, retry-once-then-fallback resilience" (2026-06-09) — the model, retry, and fallback logic are all deleted.

---

## 2026-06-16 — Editor repurposed: tier-only, pile arrives pre-ranked, lightweight pile presentation

**Decision:** The editor no longer ranks the pile. The pile now arrives
pre-ranked by grouping-pass-1 score (descending), and the editor's sole job is
to assign each item a tier (`feature`/`standard`/`brief`/`cut`) in the order
given, without reordering. Three concrete changes:
1. **No bio in the editor prompt.** The system prompt (rewritten in commit
   `b27229c`) is fully static and tier-only; the bio is removed from the user
   message entirely. `docs/bio.md` is no longer read by the editor — tiering
   reads off score + sources, not reader context.
2. **Lightweight, unified pile presentation.** Clusters and singletons are
   merged into one list, sorted by score descending (tiebreak by ref for
   determinism), and presented as one line each: `[ref] title — score N, M
   source(s)`. Summaries, body excerpts, and notes are dropped — tiering needs
   only headline + score + source count. Source count is the cluster's
   member-id-list length (from the grouping digest) for clusters, and 1 for
   singletons.
3. **Score + source count wired through to the formatter.** No schema change:
   `editor_pile_items.score` already holds the grouping-pass-1 score for both
   item types (assembly inserts it for clusters and singletons alike); the
   editor's cluster query simply hadn't been selecting it. The cluster query now
   selects `score`; source count was already reachable (digest id-list for
   clusters, constant 1 for singletons).

**Context:** Ranking had been the editor's headline job since the stage was
built (2026-06-07), and the prompt grew around it — bio in the user message
(2026-06-13), separate cluster/singleton sections each in their own order, and
the heavier scorer-grade context (summaries, body excerpts) the editor used to
make relational ranking calls. With grouping-pass-1 producing a reliable 0–100
relevance score and the pile already assembled in score order, that relational
judgment is redundant: the editor was re-deriving an order the pile already
encodes. Stripping it to tier-only makes the call shorter, cheaper, and easier
to reason about.

**Rationale:** Tiering off an existing score is a smaller, better-specified task
than whole-pile ranking, and it removes a place where the editor could silently
disagree with the scorer and scramble the order. The bio belongs at the
relevance-scoring choke points (prefilter, grouping-pass-1) that already read it;
the editor only needs the two signals the prompt names (score, sources). The
recognition-based output parser is unchanged — output is still `tier;;ref;;reason`
parsed by recognizing the tier word and the C/S ref by pattern, not by column
position. `cut` remains a valid tier (it was retained in `VALID_TIERS` and
`editor_runs.items_cut` even after being dropped from the prompt vocabulary on
2026-06-13, and is back in the prompt now): a cut item is recorded in
`editor_stories` but excluded from the published paper. Resilience
(retry-once-then-fallback), streaming, `timeout_ms`, and `max_tokens` are left
as-is — the shorter output sits well within the existing ceilings, and the
ceilings are not lowered.

**Supersedes:** The line-order ranking design in "Editor stage: whole-pile single
call, three tiers + cut, line-order ranking" (2026-06-07) — the editor no longer
derives rank from line position; it tiers a pile that is already ranked. Also
supersedes "Editor tier vocabulary simplified to three tiers (cut removed from
prompt)" (2026-06-13) — `cut` is restored to the editor's prompt vocabulary.

---

## 2026-06-14 — Recency window keyed off previous run; cross-run dedup added

**Decision:** Two preprocessor changes. (1) Replace the fixed
`NOW() - 48 hours` recency window with one keyed off the previous successful
preprocessor run: an item is in-window when its `fetched_at` is at or after
that run's `started_at`. First run / empty history falls back to a fixed
`fallback_hours` window. An optional `max_age_days` backstop on `published_at`
guards against a feed dumping its archive. (2) Add a persistent cross-run dedup
pass: before the in-run dedup, candidates matching a recently-processed
`preprocessed_items` row (same canonical URL, or same normalized title ≥30
chars, within source/parent, over a `lookback_days` window) are dropped. All
three knobs live in the new `preprocessor` block in `config/models.yaml`.

**Context:** On a once-a-day cadence the 48h window made every item eligible on
two consecutive runs, so yesterday's stories bled into today's pile. Separately,
when a source republishes a story under a changed URL/guid, the collector's
`(source_name, item_guid)` constraint and the preprocessor's *in-run-only*
dedup maps both miss it, so it reappears as a "new" row in a later run.

**Rationale:** Keying eligibility off the previous run gives each newly-seen
item exactly one window — no overlap, no boundary jitter — while still letting a
lagging feed's late-surfaced (old-dated) story through once, because we key on
`fetched_at` ("first time we saw it") rather than `published_at`. A fixed 24h
window was rejected: it still bleeds/gaps under run-time drift and a
publish-date variant would drop lagging stories. Cross-run dedup is deterministic
and reuses the existing canonical-URL / normalized-title keys; genuinely
reworded-headline duplicates are deliberately left to the downstream grouping +
pile-merge semantic layer rather than guessed at here.
## 2026-06-14 — Pile-merge and grouping refine removed; stale filter remnants cleaned

**Decision:** Remove three things from the codebase entirely:
1. The **pile-merge** stage (`src/pipeline/pile-merge/`, `scripts/pile-merge.ts`,
   the `pile_merge` config block + schema, the `npm run pile-merge` script, and
   the editor's merged-pile path). Dropped the `pile_merge_runs` table and the
   `editor_piles.pile_merge_run_id` column via migration `025_drop_pile_merge.sql`.
2. The grouping **boundary-refine** pass (the gated step 4 in
   `src/pipeline/grouping/index.ts`, the `REFINE_*` prompts, and the
   `grouping.refine` config block + Zod schema). The editor now has a single
   pile path (resolve `grouping_runs.digest`), and grouping is four steps:
   embed → candidate groups → attach → describe.
3. Leftover **filter** stage remnants: the orphaned `filter` config block, the
   dead `FilterStageConfig` export (the shared schema was renamed
   `FilterStageConfigSchema` → `BatchStageConfigSchema`, since it's the base for
   prefilter and editor-pass-1), and the never-read `filter_runs` / `filter_results`
   tables via migration `026_drop_filter.sql`.

**Context:** Pile-merge had been built and wired (see 2026-06-13 entry) but never
earned its place — same-story dedup is better handled upstream in grouping, and
the extra reasoning-model call before the editor was cost and latency we no longer
want. The refine pass had been kept dormant behind `refine.enabled: false` (see
2026-06-12 entry) as a "keep the code, toggle to re-enable" hedge; carrying dead
gated code and stale config comments wasn't worth it. The filter stage was
replaced by prefilter long ago but its config and tables were never cleaned up.

**Rationale:** Less is more. Dormant feature flags and orphaned schema rot — they
drift out of sync with reality and mislead the next reader. Removing pile-merge
collapses the editor back to a single, easier-to-reason-about path. The DB cleanup
uses new `DROP ... IF EXISTS` migrations rather than editing history, consistent
with `024_drop_triage.sql`; the original `007`/`023` migrations stay in place.

**Supersedes:** 2026-06-13 "New stage: pile-merge" (pile-merge is removed) and the
refine-pass portion of 2026-06-12 "Grouping clusterer: validated threshold 0.72…"
(the refine code is now deleted, not just disabled).

---

## 2026-06-14 — Triage clusterer removed; grouping is the sole clustering path

**Decision:** Remove the LLM-based `triage` clusterer (wire seed + parallel
spines + deterministic id-union merge + semantic merge/attach) entirely and make
the embedding-based `grouping` stage the only clustering path. Deleted
`src/pipeline/triage/`, the triage-path scorer/pile functions in
`editor-pass-1/` (`runEditorPass1`, `assemblePile`), the `triage`/`assemble`/
`editor-pass-1` scripts and npm entries, the `triage` config block, the
`inspect -- triage` and `inspect -- editor-pass-1` subcommands, and the triage
branches in `editor` and `pile-merge`. Shared code that grouping reused moved to
neutral homes: `parseFlatClusterOutput` + the `Cluster` type to
`src/lib/cluster.ts`; `getTriageItems`/`formatTriageItemBlocks` renamed to
`getClusteringItems`/`formatItemBlocks` in the preprocessor assembler. Migration
`024_drop_triage.sql` drops `triage_runs`, `editor_pass_1_runs`,
`editor_pass_1_results`, and the now-unused `editor_piles.triage_run_id` /
`editor_piles.editor_pass_1_run_id` / `editor_runs.triage_run_id` columns.

**Context:** The two clustering paths had run in parallel for comparison (see the
2026-06-07/08 triage entries and the grouping entries below). Grouping —
embeddings + connected components + an LLM attach pass + a describe pass — proved
out as the production choice: simpler, cheaper, no whole-pile-timeout failure
mode, and no spine-tuning upkeep. Keeping triage alive meant maintaining two
clusterers, a dead config block, and dual-path branches in every downstream
stage.

**Rationale:** One clustering path is less to maintain and reason about. The
downstream stages (`editor`, `pile-merge`) were already path-agnostic, so
collapsing to grouping-only removed dead branches rather than adding complexity.
The triage history in this log is preserved for context; the drop migration
accepts loss of stored triage run rows, which were experimental and not part of
any published paper.

**Supersedes:** The triage-clusterer architecture entries (2026-06-07
"ordered group-rounds → wire seed + parallel spines + id-union merge",
2026-06-08 "semantic merge/attach pass added", 2026-06-10 "split international
spine into three region spines"). Those remain for historical context but no
longer describe live code.

---

## 2026-06-14 — Prefilter prompt tightened; explicit foreign-coverage floor

**Decision:** Refactor the prefilter system prompt (`buildSystemPrompt` in
`src/pipeline/prefilter/prompt.ts`) for concision — same three-way
cut/news/opinion contract, same non-article-junk cut, same output format, just
shorter and clearer prose. One substantive rule is added: substantive foreign
coverage is a KEEP regardless of geography or an obvious reader tie —
governance and politics, economic disruption, and science or health with real
substance all clear the floor.

**Context:** The folded-in prompt (see entry below) had grown long and
repetitive after absorbing the filter's junk list. Separately, the floor was
cutting foreign stories that lacked an obvious tie to this reader even when the
underlying news was substantial, because the keep bias leaned on
reader-proximity. The prefilter is a floor, not a ranking, so substance should
clear it even without a local hook; relative importance is the editor's job
downstream.

**Rationale:** Tightening the prompt lowers token cost per batch and reduces
the chance the model fixates on one over-explained clause. Making the
foreign-coverage rule explicit fixes a real false-cut pattern at the single
choke point that has the bio, rather than trying to recover wrongly-cut foreign
news later (there is no recovery path). Keeps the prefilter's existing
keep-when-unsure bias intact.

---

## 2026-06-13 — Filter stage folded into the prefilter; standalone filter removed

**Decision:** Remove the standalone LLM `filter` stage and have the
`prefilter` absorb its job. The prefilter's Step 1 ("KEEP OR CUT") prompt
gains a directive to also cut non-article material — event listings and
calendars, horoscopes, weather forecasts, photo galleries and video-only
posts, house ads and self-promotion, and link-dump roundups.
Everything else about the prefilter is unchanged. Deleted: `src/pipeline/filter/`,
`scripts/filter.ts`, the `filter` npm script, the `inspect -- filter`
subcommand, and the assembler's `getFilterKeptIds` gate. The `filter_runs` /
`filter_results` tables and migration `007` are retained as history — old runs
stay inspectable in the DB; no migration drops them.

**Context:** The mechanical filter ("is this a real news article?") ran before
the prefilter and dropped very little — its DROP list (calendars, horoscopes,
galleries, house ads, link dumps) is squarely a subset of "noise this reader
has no interest in," which the prefilter's broader LLM call already judges per
item. Two LLM passes over the full item set where one suffices. Both stages had
been working well, so the prefilter's behavior was changed as little as
possible. The deterministic `junk-filter.ts` in the preprocessor/assembler is
unrelated and stays.

**Rationale:** One bio-aware LLM gate is cheaper and simpler than a mechanical
gate plus a bio-aware gate doing overlapping work. The assembler already
composed both kept-sets by set intersection with graceful fallback when a run
is absent, so dropping the filter gate is a clean deletion — the prefilter gate
and junk filter still apply. Keeping the filter tables/migration honors the
append-only schema convention and preserves lineage for past paper runs.

**Supersedes:** the filter-stage portion of the 2026-06-07 prefilter entry,
which noted filter and prefilter "compose by intersection — exactly like the
LLM `filter` stage and the junk filter already do today." The LLM filter stage
no longer exists; only the prefilter and the deterministic junk filter remain.

---

## 2026-06-13 — Editor prompt redesign: static system prompt, bio in user message, standing memo dissolved

**Decision:** Rewrite the editor's prompt structure so that (1) the system
prompt is fully static — no runtime file reads, no bio — and carries only the
task spec and output contract; (2) the bio travels in the user message alongside
the pile; (3) `docs/standing-memo.md` is dissolved — its editorial judgment
principles move into a new `## How to weigh stories` section in `docs/bio.md`
and its task content is absorbed into the system prompt.

`buildSystemPrompt()` now takes no arguments. `buildUserPrompt()` and
`buildMergedUserPrompt()` prepend `"The reader:\n\n${bio}\n\n---\n\n"` before
the pile section. `docs/standing-memo.md` is deleted.

The five principles that moved into `docs/bio.md → ## How to weigh stories`:
- Power skepticism applied evenly, not just at one political pole.
- Attribution is a claim ("police say X"), not a fact.
- The people a decision lands on matter more than the people making it.
- Weight non-Western stories by consequence, not by American attention.
- Significance earns prominence, not drama; resist outrage-bait and horse-race framing.

**Context:** Earlier prompt structure put the bio and standing memo in the
system message and pile in the user message. Reasoning models treated the
system message as a persistent identity and narrated editorial theory before
producing output ("I will prioritize…", "Let me consider the reader's
interests…"), ignoring the `Begin immediately` instruction. Moving the bio to
the user message alongside the pile — the material being acted on — produced
clean, immediate `tier;;ref;;reason` output on the next run.

**Rationale:**
- **Static system prompt = stable model identity.** A prompt whose content
  changes daily (bio gets updated, standing memo gets revised) creates
  inconsistent model behavior. A prompt that says only "here is your task and
  output format" is stable by construction.
- **Bio belongs with the pile it governs.** The user message is "the reader +
  today's pile" — the full context for a single editorial decision. Keeping
  them together reflects what the call is actually doing.
- **Dissolving the standing memo eliminates a two-document maintenance surface.**
  The editorial voice principles don't need a separate file: they're reader
  preferences and belong with the reader. The task framing (tiers, ranking,
  output contract) belongs in the system prompt. There was no third category
  that needed its own document.
- **Additive for the scorer.** `editor-pass-1` and `grouping-pass-1` also read
  `docs/bio.md` for interest signals (high/low interest, geography, work). The
  new `## How to weigh stories` section is purely additive — the scorer uses
  bio for relevance scoring, not editorial craft, so extra principles cause no
  harm and may improve marginal scoring decisions.

---

## 2026-06-13 — Editor tier vocabulary simplified to three tiers (cut removed from prompt)

**Decision:** Remove `cut` from the editor's system prompt tier vocabulary.
The active tiers are now `feature`, `standard`, and `brief`. The parser
(`VALID_TIERS`) and DB schema (`items_cut`) retain `cut` as a recognized tier
for backwards compatibility, but the model is no longer instructed to use it.

**Context:** After the prompt redesign, the `brief` tier already serves as the
low end of the paper and the explicit `cut` tier introduced marginal ambiguity
("doesn't earn a place" vs. "worth noting, ~30-60 words") at the boundary
between brief and cut. The system prompt was rewritten with only three tiers
and the `cut` instruction removed.

**Rationale:** Fewer tiers = simpler decision surface at the margins. Every
item assigned `brief` appears somewhere in the paper (briefly), which is
arguably a better policy than silent omission. The `cut` value remains
parseable in case a future model emits it despite not being instructed to.

**Supersedes:** The `cut` tier description in "Editor stage: whole-pile single
call, three tiers + cut, line-order ranking" (2026-06-07).

---

## 2026-06-13 — Editor output parser made recognition-based to handle model format variation

**Decision:** Replace the positional `;;`-column parser in `parseEditorOutput`
with a recognition-based scanner that finds tier and ref by pattern, not by
column index. For each non-empty `;;`-containing line, the parser scans all
`;;`-delimited segments: the first segment whose lowercase content is one of
`{feature, standard, brief, cut}` is the tier; the first non-tier segment
containing a `[CS]\d+` ref pattern (after `normalizeRef`) is the ref; all
remaining segments join as the reason.

**Context:** Run #78 — kimi-k2.6:thinking returned lines in two variant
formats on the same output: `1. C3;;feature;;US-Iran war escalation` (numbered
prefix + swapped to `ref;;tier;;reason`) and `C3;;feature;;reason` (no tier
field at the correct position for positional parsing). The prior parser read
column 0 as tier, column 1 as ref — which meant `"1. C3"` was the tier
(invalid, fail-safed), `"feature"` was the ref (no C/S pattern, dropped), and
every item in the run was lost. This produced 0/145 valid lines — a complete
parse collapse, worse than the all-standard collapse from run #74.

**Rationale:**
- **The model's tier keywords and ref patterns are unambiguous.** `feature`,
  `standard`, `brief`, `cut` don't appear in titles or reasons as standalone
  `;;`-delimited segments. `C\d+`/`S\d+` patterns are structurally distinct
  from both tier words and reason text. Recognition over these two signals is
  robust to any column permutation.
- **Backwards-compatible with clean output.** On well-formed `tier;;ref;;reason`
  lines, the recognition scan finds tier in segment 0 and ref in segment 1 —
  identical outcome to the positional parser. No behavioral change for
  well-behaved model output.
- **`badTierCount` retired.** The positional parser incremented this counter
  when column 0 wasn't a tier keyword; since the recognition parser searches
  all segments for the tier, a line with no valid tier keyword simply produces
  no match and is skipped silently. The counter no longer has meaning and was
  zeroed.

---

## 2026-06-13 — Editor timeout raised to 900s; reasoning_effort kept at medium

**Decision:** Raise `editor.timeout_ms` from 600000 to 900000. Keep
`editor.reasoning_effort` at `"medium"`.

**Context:** Run #76 was killed at exactly 603s — 3s past the 600s limit —
having produced no output. First attempted fix: change `reasoning_effort` from
`"medium"` to `"low"` to reduce thinking time. Result (run #77): kimi at
`"low"` effort stopped emitting `tier;;ref;;reason` lines entirely and instead
dumped raw reasoning text ("Top tier candidates:", "Let's verify total…"),
producing 0/145 valid parsed lines — a worse outcome than the timeout. Reverted
`reasoning_effort` to `"medium"`; raised `timeout_ms` to 900000.

**Rationale:** At `"medium"` effort, kimi-k2.6:thinking produces well-formed
output and correctly ranks 145-item piles. At `"low"` effort, it appears to
skip the formatting step and emit thinking scratchpad text directly — the model
doesn't apply the output contract at low effort. Extending the timeout to 900s
is the correct fix: the 603s run was close to finishing, and 15 more minutes of
headroom covers the realistic tail without changing model behavior.

---

## 2026-06-13 — New stage: pile-merge (same-story dedup before the editor)

**Decision:** Add an optional `pile-merge` stage between pile assembly
(editor-pass-1 / grouping-pass-1) and the editor. The stage presents the
assembled pile to a reasoning model and asks it to identify item groups that
cover the same specific event, then merges each flagged group into one entry:
the primary item is kept (cluster over singleton, then highest source count,
then lex ref for determinism), secondary source IDs are absorbed, and a merged
singleton's excerpt is promoted to the summary field.

Schema: `pile_merge_runs` table (migration 023) with `editor_pile_id`,
`model_used`, `items_in`, `items_out`, `groups_merged`, `merged_pile JSONB`,
and `generation_log_id`. `editor_piles` gains a nullable `pile_merge_run_id`
FK. The editor checks this column first: when set, it reads `merged_pile` JSONB
directly from `pile_merge_runs` and skips digest resolution.

Model: `moonshotai/kimi-k2.6:thinking`, nanogpt, `reasoning_effort: "medium"`,
`stream: true`, `timeout_ms: 600000`. Output format: `MERGE: C0, S12345` lines
(or `NONE` if no merges needed). Parser uses `extractRefs()` from
`src/lib/refs.ts` to tolerate trailing punctuation and brackets.

**Context:** After editor-pass-1 / grouping-pass-1 assemble the pile, it
occasionally contains multiple entries covering the same specific event — e.g.
two clusters formed from disjoint source sets, or a cluster and a singleton
that both cover the same ruling or announcement. These show up in the editor
pile as separate items and, if both are tiered `feature`, produce redundant
entries in the day's paper. Triage's semantic-merge pass already catches most of
these during clustering, but some slip through — especially cross-path
divergence (triage and grouping can form different cluster boundaries) and items
that scored highly as singletons.

**Rationale:**
- **Same-specific-event threshold, not topic similarity.** The prompt's
  definition is identical to triage's clustering standard: merge only when two
  items describe the same event (same vote, same ruling, same strike), not
  merely the same running story or the same cast of actors. Conservative bias:
  when in doubt, keep separate. A missed merge is a minor duplication; a
  wrongful merge collapses distinct stories into one and loses information.
- **Optional, not required.** The stage is a clean step on the pile's FK:
  `pile_merge_run_id IS NULL` means the editor uses the standard digest path,
  `IS NOT NULL` means it uses the merged pile. No flag in the editor; no
  required ordering. It can be run or skipped on any given day.
- **JSONB for the merged pile.** The merged pile is a structured list written
  with `JSON.stringify(mergedPile)` and an explicit `::jsonb` cast (per the
  existing pg-library JSONB quirk in CLAUDE.md). The editor reads it with a
  typed cast back to `MergedPileEntry[]`.
- **Merged singletons promoted to cluster type.** When a singleton is absorbed
  into a cluster (or two singletons are merged together), the surviving entry
  becomes `itemType: "cluster"` with the singleton's excerpt promoted to the
  summary field, so the editor's merged-pile formatter presents it the same way
  as a cluster (title + summary, source count), not as a bare excerpt.

---

## 2026-06-13 — Shared ref normalizer: src/lib/refs.ts

**Decision:** Add `src/lib/refs.ts` with two exported functions:

- `normalizeRef(token: string): string | null` — extracts the first `[CS]\d+`
  pattern from a token and returns it upper-cased (`"[C3]"` → `"C3"`,
  `"S17566."` → `"S17566"`, `"cut"` → `null`).
- `extractRefs(text: string): string[]` — returns all `[CS]\d+` matches in a
  string, upper-cased (`"S17544, S17566."` → `["S17544", "S17566"]`).

Both functions are used to route LLM-returned ref tokens to pile Map lookups
without trusting the raw string. `parseEditorOutput` uses `normalizeRef` on
each ref segment; `parseMergeOutput` uses `extractRefs` on each `MERGE:` line.

**Context:** Two separate ref-brittleness bugs surfaced in the same session:

1. **Editor run #74 — all 150 items fail-safed to standard** (unknown-refs=78,
   missing=150). Cause: the prompt labels items as `[C3]` (bracketed) but the
   parser did `byRef.get(rawRef)` with the bracket-containing string, which
   matched nothing in the bare-key Map. Result: every `byRef.get` call missed →
   every item was "unknown ref" → every item was fail-safed.

2. **Pile-merge parser dropped valid group** because the model wrote
   `MERGE: S17544, S17566.` (trailing period). The parser split on `,` and
   trimmed, leaving `"S17566."` which had no exact match in `validRefs`.

**Rationale:** Both bugs are the same brittleness: trusting the raw LLM token
as the Map key. The fix extracts the canonical `[CS]\d+` pattern rather than
cleaning ad-hoc, so any future variation (spacing, case, punctuation) is
normalized at the lookup site. `src/lib/` is the established home for shared
utilities per CLAUDE.md; the two functions are general enough that either could
be re-used by a future parser that handles C/S refs.

---

## 2026-06-12 — Grouping clusterer: validated threshold 0.72, attach pass design, operational lessons

**Decision:** Commit the grouping clusterer's production configuration as validated on
preprocessor run #15 / grouping run #7:

- `embedding.similarity_threshold: 0.72` (was 0.82 on the branch; see lessons below)
- `attach.attach_floor: 0.60` (unchanged; intentionally low — see Bias section)
- `refine.enabled: false` (unchanged)

**Architecture (final):** embed (Qwen3-Embedding-8B, 4096d, OpenRouter, pgvector)
→ connected-components grouping at cosine ≥ 0.72
→ attach pass: per-cluster glm-5.1 LLM call over singletons in the [0.60, 0.72) near-miss
  band, attach-only
→ describe pass: glm-5.1 neutral title + summary for every multi-item cluster.

No refine pass (code kept, flag stays false). Runs in parallel with the existing triage
(seed + spines + semantic-merge) path for comparison; both terminate at the same editor.

**Context: why 0.72**

0.72 forms confident same-event clusters with no observed false merges. Below ~0.69,
distinct-story chains begin to form (items that share a topic and a cast of actors but
cover different events get connected transitively through a sequence of above-threshold
pairs). 0.72 sits cleanly above that chain-formation floor.

The embedding layer cannot separate same-event-different-framing pairs from
distinct-event-same-topic pairs by threshold alone. Measured on run #7: same-event pairs
ranged 0.59–0.89 (wide spread, reflecting how differently outlets frame identical facts);
distinct-event pairs reached 0.71 (a UN statement on the Iran war scored 0.71 against the
missile-exchange cluster — same cast, same week, different event). A threshold high enough
to exclude all 0.71 distinct-event pairs would also exclude many genuine same-event pairs
in the 0.59–0.71 range.

The attach pass is what recovers those stranded same-event items. On run #7 the Iran war
cluster formed from 8 sources at the 0.72 threshold; the attach pass brought it to 22
by absorbing near-misses the threshold correctly excluded from the connected-components
graph (UN condemnation, fuel-price dispatch, War Powers congressional response — all the
same specific event, all scoring in the [0.60, 0.72) band against the core cluster).

**Bias: prefer over-attaching over under-attaching**

`attach_floor: 0.60` is intentionally low. The failure asymmetry for the attach pass:

- An incorrectly-attached source (present in the cluster but covering a related-but-not-
  identical event) is harmless: the editor and reader can ignore a slightly-wrong source
  in a 22-item cluster.
- A missed same-event source (left as a singleton because the floor was too high) is lost:
  it scores against the backdrop of today's full pile, may never reach the editor pile
  at all, and never joins the cluster it belongs in.

Do not raise the floor to reduce false attachments. The cost of false attachments is low;
the cost of misses is high. If over-attaching becomes a real problem, the correct fix is
tightening the LLM prompt's "same specific event" definition, not raising the floor.

**Operational lessons**

**(A) Cluster SIZE is not an over-merge signal.** A 66-item cluster is not evidence of a
wrongful merge — a global war with 66 sources covering it is the correct output. Judge
merge quality by reading the cluster CONTENTS (are these all the same specific event?),
never by item count. Applying a size-based heuristic will produce false positives on every
genuinely large story and cause the operator to re-tune away from correct behavior.

**(B) `similarity_threshold` is the highest-leverage knob in the pipeline.** An unintended
value of 0.82 (left over from an earlier tuning run) caused every same-event pair with
cosine similarity 0.72–0.81 to be split into separate singletons. The full run produced
~1226 singletons and ~16 clusters — a result that looked exactly like a broken clusterer
but was a single misconfigured YAML value. When the grouping output looks wrong (pile
dominated by singletons, few multi-item clusters), check this value first.

---

## 2026-06-10 — Model bake-off picks: triage clusterer and editor_pass_1 scorer

**Decision:** Two model selections from bake-offs run on identical pipeline input:

- **Triage clusterer:** `alibaba/qwen3.6-27b:thinking` (`provider: nanogpt`, replacing
  `qwen3.5:397b`). Used for both the seed/spine calls and the semantic_merge pass
  (pinned together in the `--model` override path; they must match).

- **editor_pass_1 scorer:** `zai-org/glm-5.1:thinking` (`provider: nanogpt`, replacing
  plain `zai-org/glm-5.1`).

**Context:**

*Clusterer bake-off:* qwen3.6-27b:thinking was stable across runs, consolidated the
regression item pairs reliably, and handled the region-split international spines
cleanly. (The spine split itself is logged in the entry immediately below; this entry
records only the model selection.)

*Scorer bake-off:* Three candidates — `moonshotai/kimi-k2.6:thinking` (the editor's
whole-pile winner), plain `zai-org/glm-5.1`, and `zai-org/glm-5.1:thinking`. kimi is
a poor scorer for pass-1 despite being the best editor: pass-1 is high-volume per-item
batch work, and kimi silently defaults un-engaged items to a flat score of 50 in that
regime — confirmed in the bake-off on bio-relevant items that should have scored 80+.
Plain glm-5.1 showed a milder version of the same flat-score behavior. glm-5.1:thinking
engages per-item and avoids it.

**Rationale:** The flat-50 failure mode is specifically a batch-scoring regime problem:
a model that reasons well over a single whole pile (the editor's task) can still
disengage when asked to score hundreds of individual items in parallel batches (pass-1's
task). The `:thinking` variant of glm-5.1 applies per-item reasoning that prevents the
disengagement without the latency hit of a model sized for whole-pile relational work.

**Operational note:** A high count of exactly-50 scores in an editor_pass_1 run is a
smell — model not engaging items, possibly batch_size too large — not a neutral middle.
Worth checking when it appears; the fix is smaller batches, never a second pass.

---

## 2026-06-10 — Triage: split international spine into three region spines

**Decision:** Replace the single `international` triage spine (groups `[intl_broad,
intl_regional]`, ~528 items) with three narrower region spines: `intl_broad`
(`[intl_broad]`), `intl_asia` (`[intl_asia]`), and `intl_americas`
(`[intl_americas]`). Sources previously carrying `group: intl_regional` are
retagged to the appropriate region group in `config/sources.yaml`; the spine
map in `config/models.yaml` is updated to match; `max_concurrent_spines` raised
from 3 to 10. `intl_regional` is retired and removed from the group schema
comment.

**Context:** The international spine was producing two symptoms from one cause:

- **Transcribing instead of clustering.** ~480 of ~528 items fell as singletons
  — the model was re-emitting items individually rather than grouping them.
  Output ballooned to ~16k tokens; healthy clustering calls are far smaller than
  their input.
- **Timeout risk.** 400–600s per spine run, the same wall that prompted the
  ordered-rounds → seed + parallel spines redesign (see 2026-06-07 entry).

Both symptoms have one cause: the bucket was past the output-token runaway
threshold. A model clustering N items produces O(clusters) output tokens if it
is actually clustering. Past some bucket-size ceiling it flips to transcribing
— producing O(N) output tokens, one trivial single-item "cluster" per item. The
~528-item international bucket had crossed that threshold; the spike in
singletons and the spike in output tokens appeared together, confirming the
diagnosis.

**Rationale:**

- **Spine size is bounded by output-token behavior, not input item count.**
  The transcription flip is the operative signal: output proportional to input
  means the model isn't clustering. Input item count matters only insofar as it
  drives the model past the flip point. Splitting the bucket into three
  thematically narrower region spines brings each one back into the clustering
  regime. Result on preprocessor run #12: singletons 1 / 40 / 0 across the three
  spines, output tokens in the hundreds-to-low-thousands per spine, slowest spine
  ~110–130s.

- **Regional coherence is a secondary benefit.** Keeping all international items
  in one bucket asks the model to hold Middle East, Africa, Europe, Asia, and
  Latin America simultaneously — a pile where intra-region same-event pairs are
  diluted by unrelated cross-region noise. Narrower buckets give the model a
  smaller, more coherent slice to reason over, making the genuine same-event
  pairs easier to find.

- **max_concurrent_spines raised to 10.** Six spines vs. four; a cap of 3 would
  serialise the run. Raising to 10 effectively uncaps concurrency at the current
  spine count and keeps the parallel structure intact.

**Supersedes:** The `international` spine entry in "Triage clusterer: ordered
group-rounds → wire seed + parallel spines + id-union merge" (2026-06-07).

---

## 2026-06-09 — Editor model: kimi-k2.6:thinking primary, glm-5.1:thinking fallback, retry-once-then-fallback resilience

**Decision:** The editor stage's production model is `moonshotai/kimi-k2.6:thinking`
on NanoGPT (`provider: nanogpt`, `reasoning_effort: "medium"`). A fallback model
`zai-org/glm-5.1:thinking` (also NanoGPT, `reasoning_effort: "medium"`) is
configured in a new optional `editor.fallback` block in `config/models.yaml`.
`StageConfigSchema` is not touched; a new `EditorStageConfigSchema` extends it
with the optional fallback sub-config — editor-specific only, not generalized to
all stages.

Resilience logic lives in `src/pipeline/editor/index.ts` (not in `callLLM`):
attempt the primary model → retry the primary once on failure → invoke the fallback
once. A failure is: `callLLM` throws (timeout, stream break, empty response) OR the
parse collapses (fewer than 50% of pile items produce valid output lines). A paper
that parses with fail-safed missing items but ≥ 50% lines is a success — do not
fall back on a merely-imperfect-but-parsed paper. If the fallback also fails, the
run throws loudly; no silent all-fail-safe paper is produced and presented as a
success. Each transition is logged explicitly (primary attempt 1, retry, fallback
invocation). The `model_used` column of `editor_runs` is updated to the fallback
model's ID if the fallback produced the accepted output, so inspection logs show
whether any given day's paper came from kimi or glm.

**Context:** A bake-off over multiple runs on identical input evaluated several
NanoGPT reasoning models. `kimi-k2.6:thinking` ranked best overall and was the
most stable across runs (consistent tier assignments, minimal collapse, clean line
format). `glm-5.1:thinking` produced clean papers and failed predictably on
difficult inputs — no silent garbage, just clean errors — making it the safest
fallback choice. Primary model failures have been intermittent, not deterministic,
so a single clean retry is cheap and often sufficient before reaching for the
fallback.

**Rationale:**
- **Retry-once-then-fallback, not retry-forever.** The bake-off showed that primary
  failures are transient (network hiccup, stream break), not systematic. One retry
  is cheap; more would mask real problems. Reaching the fallback is a signal the
  operator should notice (via `model_used` in `editor_runs`), not suppress.
- **Collapse threshold at 50% of pile items.** A collapse is operationally
  distinguishable from a merely-imperfect paper: a reasoning model that is working
  produces output for most items even if the tier assignments are imperfect; a
  collapsed call produces almost nothing. 50% is a clear, generous threshold — far
  below any normal run's output — that avoids false positives on legitimate papers
  while reliably catching empty-or-near-empty responses.
- **model_used reflects the real producer.** The `editor_runs` row is created with
  the primary model as `model_used` and updated on fallback use. This makes fallback
  frequency observable over time in the DB without any separate tracking column.
- **Fallback is editor-specific, not generalized.** Other stages have different
  failure modes and different costs; adding fallback to all stages without failure
  data to design from would be speculative. The `EditorStageConfigSchema` extension
  keeps the change local to the editor.

---

## 2026-06-09 — Editor LLM call switched to streaming to bypass undici headers timeout

**Decision:** The editor stage's `callLLM` call now uses `stream: true`. The
OpenAI SDK's streaming path accumulates all `delta.content` chunks into one
string and passes that to the existing `parseEditorOutput` parser, which is
completely unchanged. `stream` is a per-stage boolean in `models.yaml`
(`StageConfigSchema`); other stages continue to use non-streaming. The editor
config is also set to `timeout_ms: 600000` as a generous body/stream timeout.

**Context:** Non-streaming reasoning calls against NanoGPT (and any other
provider) were dying at exactly ~300 seconds — regardless of model, regardless
of the provider's own timeout — with `UND_ERR_HEADERS_TIMEOUT`. The root cause
was diagnosed by sending a raw fetch to a deliberately-slow LOCAL server inside
the app container: the connection died at 300.893s with the same
`UND_ERR_HEADERS_TIMEOUT`. This is Node's undici HTTP client enforcing its
default `headersTimeout` of ~300s. A non-streaming LLM call does not send HTTP
response headers until the model finishes generating — so any model that thinks
for more than ~300s before producing output is killed by our own HTTP client,
not by the provider. A streaming version of the identical deepseek call received
headers at 2.8s and completed successfully at 248s.

**Rationale:** Streaming sidesteps the headers-timeout problem at its root: the
provider sends HTTP response headers (and the first SSE chunk) within seconds of
receiving the request, keeping the connection alive while the model reasons. The
assembled string from accumulated chunks is byte-identical in structure to what
the non-streaming path produces (same lines, same format), so the parser and all
downstream logic are unaffected. Error handling mid-stream is explicit: if the
stream breaks partway, the call fails cleanly with a logged message that includes
stage, model, bytes received, and elapsed time — a broken stream is treated as a
failure, not a partial parse. `stream: true` is a flag in `LLMCallOptions` and
`StageConfigSchema` rather than hardcoded to the editor, so other stages can opt
in when they face the same constraint.

---

## 2026-06-08 — NanoGPT added as alternate LLM provider

**Decision:** Added `nanogpt` as a second selectable provider alongside the
existing `ollama-cloud` default. Provider is now a per-stage config field
(`provider: ollama-cloud | nanogpt`) in `config/models.yaml`. When set to
`nanogpt`, `callLLM` uses `NANOGPT_BASE_URL` + `NANOGPT_API_KEY` instead of
`LLM_BASE_URL` + `LLM_API_KEY`. The editor stage is the first to expose this
— override with `provider: nanogpt`, `model: deepseek/deepseek-v4-pro:thinking`,
`reasoning_effort: "high"` to run it through NanoGPT. All other stages continue
to use ollama-cloud by default (no change to any other stage's config or code).

A `timeout_ms` per-stage config field was added at the same time, so stages
that need a longer or shorter deadline can set it explicitly. The default
remains 360s for all providers.

**Context:** Ollama Cloud imposes a 182s hard gateway timeout per request.
Reasoning models — particularly `deepseek/deepseek-v4-pro:thinking` on a
whole-pile editor call — routinely exceed this ceiling. The editor's
whole-pile call is intentionally a single large call (see "Editor stage:
whole-pile single call" entry); it cannot be batched or shortened without
losing the relational ranking judgment that is the editor's entire purpose.
NanoGPT is OpenAI-compatible and has no equivalent per-request cap, making
it a viable host for long-running reasoning calls.

**Rationale:**
- **Provider as config, not code.** Any stage can target either provider with
  a one-line yaml change and the right env vars present — no stage-specific
  code branches, no hardcoded URLs. The LLM client selects credentials and
  constructs the OpenAI client based on the `provider` field, the same way
  it already selects model, temperature, and token budget from config.
- **NanoGPT's reasoning parameter matches the existing code path.** NanoGPT
  uses `reasoning_effort` (values: `none`/`minimal`/`low`/`medium`/`high`/
  `xhigh`) passed directly in the request body — exactly the same double-cast
  approach the client already uses for Ollama Cloud. No new parameter wiring
  was needed.
- **Committed default unchanged.** The editor's committed config stays
  `provider: ollama-cloud` (implicit default), `model: qwen3.5:397b`,
  `reasoning_effort: "none"`. The NanoGPT setting is applied as a runtime
  override; no production run is affected until the operator explicitly changes
  the config or passes an override.

---

## 2026-06-08 — Triage clusterer: semantic merge/attach pass added as final clustering step

**Decision:** Add one more LLM call to the end of the clustering pipeline,
after the deterministic id-union merge produces its cluster list and before
the digest is finalized: a semantic merge/attach pass that (1) merges cluster
pairs that are the same specific EVENT but share no item ids, and (2) attaches
high-relevance orphaned singletons — especially cross-language items and
tangential angles of the same specific event — to a cluster they clearly
belong in. The threshold is strictly same-specific-event — identical to the
base clustering prompt's — with no broader "umbrella" or "running story"
grouping exception (see the **Update** below for why that exception was
removed before this pass shipped). Configured at
`triage.clustering.semantic_merge` (model, `max_tokens`, `reasoning_effort`,
`max_singletons`, `max_cluster_share`, and an `enabled` toggle); uses the same
`qwen3.5:397b` model as the rest of triage, `reasoning_effort: "none"`,
default `max_singletons: 60`, default `max_cluster_share: 0.30`.

The pass operates on a deliberately SMALL input — the merged cluster list
(already-formed `label;;summary;;ids` lines) plus a bounded slice of the
highest-relevance unclustered singletons (the top `max_singletons` residuals
by recency, since pass-1 scoring hasn't run yet at triage time and there's no
score to rank by) — never the whole pile. It re-emits the COMPLETE updated
cluster list in the same flat format, which is then run through the existing
`parseFlatClusterOutput` (same fabricated/duplicate/sub-2-id validation as
every other clustering call) and becomes the final `digest`. Editor,
assemble-pile, and pass-1 are completely unaffected — the contract
(`parseFlatClusterOutput`, `cluster_index` semantics, the flat line format)
is unchanged. The raw output is stored in `round_digests` under the key
`semantic_merge`, alongside `seed`, `spine:*`, and `merged`, so a run remains
inspectable stage by stage. An integrity check logs clusters before vs. after,
how many pre-pass clusters fused into each post-pass cluster ("merged"), how
many offered singletons made it into the final list ("attached"), and any
previously-clustered id that vanished from the output entirely (logged loudly
as LOST — it falls back to residual, exactly like the existing seed/spine LOST
handling, because this is now the final clustering step with no further chance
to recover it). A runaway guard rejects the pass's entire output — falling
back to the pre-pass id-union merge result — if any single cluster ends up
holding more than `max_cluster_share` (default 30%) of all clustered ids; see
the **Update** below for why this exists.

**Context:** Two recall failures at the edges of clustering kept showing up in
production, both invisible to the deterministic id-union merge because it can
only fuse clusters that share at least one seed item id:

- Same-story clusters covered by disjoint source sets, sharing no ids — e.g.
  two separate "Intel on the brink, AI revival" clusters surfaced as two
  separate features instead of one.
- High-relevance singletons that belonged in an existing cluster but stayed
  orphaned — especially cross-language items (a Portuguese "Iran attacks
  Israel" report) and tangential angles (a "War Powers Resolution on Iran"
  explainer) — both floated up as standalone features instead of joining the
  Iran-war cluster.

The id-union merge's `possibleDuplicates` heuristic (Jaccard title similarity)
already *flagged* the first case for inspection but explicitly couldn't
resolve it — that requires editorial judgment a string-similarity check can't
make. This pass is the resolution that heuristic was always meant to lead to;
see the "Deferred: A semantic merge pass…" note in the entry below, which this
entry fulfills.

**Rationale:**

- **One call, at the end, on a small input — not a redesign of clustering.**
  Earlier whole-pile clustering attempts timed out because every round's
  prompt carried the full item texts for hundreds of items plus an
  ever-reinflating carry-forward pool (see the entry below: "495 → 714 items
  by round 10"). This pass sidesteps that failure mode entirely by construction:
  its input is the already-formed cluster list (a few dozen short lines) plus
  at most `max_singletons` (default 60) item blocks — capped, not the ~500
  residual singletons a typical run produces. It is structurally incapable of
  re-creating the timeout problem, regardless of pile size, because its input
  size is bounded by config, not by the day's news volume.

- **Re-emit-the-complete-list, not a diff format.** The pass reuses the exact
  mechanic `buildIncrementalUserPrompt` already proved out for the spine
  rounds: show the model the current list verbatim in the format it must
  also output, plus new material, and ask for a complete re-emission. This
  means zero new output-format surface, zero new parsing code (the existing
  `parseFlatClusterOutput` — with its fabricated-id, duplicate-id, and
  sub-2-id validation — handles it unchanged), and the same robust
  loud-logging-on-loss behavior the seed/spine merge already has. A bespoke
  "merge cluster #3 into #7, attach singleton #4821 to #12" diff format would
  have required new parsing, new validation, and a new failure surface for no
  benefit — the re-emission mechanic was already battle-tested.

- **Recency as the singleton ranking signal, not a score.** Pass-1 — the
  stage that actually scores bio-relevance — runs *after* triage, so no score
  exists yet to rank residual singletons by at this point in the pipeline.
  Recency is the most meaningful signal directly available: a recently
  published orphan is the likeliest candidate to be a same-day angle on, or a
  cross-language report of, a running story — precisely the case this pass
  exists to catch. "Source-count" was considered and rejected as a ranking
  signal for *true singletons* — by definition, an item that didn't cluster
  has no sibling items to count sources across, so the signal would be
  degenerate (always 1) for exactly the population this pass is selecting from.

- **Strictly same-specific-event threshold — identical to the base
  clustering prompt's, no broader exception.** The prompt keeps the existing
  clustering rules' bias in full: merge or attach only on confidence that two
  things are the SAME SPECIFIC EVENT, and when unsure, don't — under-merging
  is recoverable, a wrongful merge destroys structure permanently. Breadth
  across a running story (gathering a conflict's strikes, legislative
  responses, and economic fallout into one place) is the writer's job, done
  later by searching the full pool — not the clusterer's, at any stage. See
  the **Update** below for why an "umbrella" exception was tried and removed
  before this pass ever shipped.

- **`max_cluster_share` runaway guard — defense in depth against an unstable
  prompt resolution.** Even with a strictly same-event threshold, an LLM pass
  making merge/attach judgments can occasionally over-merge in a way that
  produces a single oversized cluster — the unmistakable shape of an
  "umbrella"/"conflict blob" mistake (a tight same-event cluster should never
  hold a large share of a day's clustered ids). Rather than rely on the
  prompt alone to prevent this, the pass validates its own output's shape: if
  the largest cluster exceeds `max_cluster_share` (default 30%) of all
  clustered ids, the entire output is discarded — not trimmed or
  partially salvaged, since a blob's membership can't be un-mixed after the
  fact — and the pre-pass id-union merge result is used as the final digest
  instead. This is the same "validate the shape, fall back cleanly on failure"
  posture the pass already takes for unparseable output; a magnitude check is
  just as mechanical and just as safe to automate as a syntax check.

- **Cross-language matching named explicitly.** The base clustering system
  prompt already says items may be in any language, but the production miss
  (the Portuguese Iran item) showed that guidance alone wasn't enough to make
  the model attach across a language boundary at the edges. This pass's prompt
  calls it out directly: match on the underlying event, not the language or
  the wording.

- **Toggleable and isolated.** `semantic_merge.enabled: false` falls back
  cleanly to the id-union merge result with no other code path changes — the
  pass is purely additive at the end of the pipeline, so it can be disabled
  for cost/latency reasons, or if it proves to be a net-negative (over-merging),
  without touching the spine/seed clustering or the deterministic merge at all.

**Update (2026-06-08, before deploy):** The first version of this prompt
included an explicit "umbrella" exception — fold a major running story's later
developments, regional angles, and explainers into one cluster, framed as
"still the same story, just a big one." Across three test runs on identical
input, that exception produced two distinct modes: restrained/correct (4–7
singletons attached, the genuine Intel duplicate fused, the cross-language
Iran item attached — exactly the recall fixes this pass exists for) and
runaway (one run attached 45 singletons, producing a 183-item "South Korea
Ballot Shortage" mega-bucket and an Iran "conflict blob" that swallowed
missile-exchange coverage, fuel-shock reporting, inflation stories, and Trump's
messaging about the war as if they were one event).

The cause: the prompt simultaneously told the model "merge only the same
specific event" AND "but also gather a running story's breadth into one
bucket" — two instructions in tension, which the model resolved
unpredictably from run to run on identical input. The fix removes the
contradiction rather than tuning around it: the umbrella exception is gone
entirely, the threshold is now identical to the base clustering prompt's
(same specific event, full stop), and the rationale for *why* breadth doesn't
belong here is now explicit in the prompt itself — it's the writer's job,
done later via the full-pool search, not the clusterer's at any stage. A
`max_cluster_share` fallback guard (see Rationale above) was added as a second
line of defense — not a substitute for the prompt fix, but a backstop in case
a future prompt change (or this model's quirks) reintroduces a similar
instability, so a runaway result can never reach the digest even if the prompt
momentarily produces one.

---

## 2026-06-07 — New stage: bio-aware pre-cluster relevance filter (prefilter)

**Decision:** Add a `prefilter` stage between the preprocessor and the
clusterer (triage). It is batched, concurrency-capped at 3, bio-aware, and
mirrors editor-pass-1's structure closely (per-item batches, `p-limit`,
flat-line parsing, run+results tables, `glm-5.1`). For each `track = 'news'`
preprocessed item it makes a binary **keep/cut** verdict — not a score — and
the prompt is deliberately conservative: cut only what the bio makes clear
this reader has affirmatively no interest in (routine sports/box scores,
celebrity gossip, market-movement noise); when unsure, KEEP. A sports or
entertainment item with a substantive labor/political/legal/cultural angle is
explicitly a KEEP. Schema: `prefilter_runs` (per-execution counts) and
`prefilter_results` (`run_id`, `preprocessed_item_id`, `keep BOOLEAN`,
`reason TEXT`) — migration 016. The assembler (`getTriageItems`) applies a
completed prefilter run's kept-set exactly the way it already applies the LLM
filter run's kept-set (`getPrefilterKeptIds` mirrors `getFilterKeptIds`,
including the graceful "no run → include everything" fallback); the two
compose by simple set intersection, so order between them doesn't matter.
Nothing is deleted from `preprocessed_items` — cut items remain in the full
pool for a future writer stage that searches across all items; this stage
only records a verdict.

**Context:** The clusterer and editor were spending context budget on items
the reader has no interest in at all — routine box scores, tabloid items,
wire filler that isn't garbage (so the deterministic junk filter correctly
keeps it) but also isn't anything this specific reader would ever want. That
is a *relevance* judgment, not a *garbage* judgment, and it requires the bio.

**Rationale:**

- **Why a separate stage from the junk filter, not folded into it.**
  Garbage-vs-not (calendars, photo galleries, house ads — see
  `src/pipeline/preprocessor/junk-filter.ts`) and relevant-to-this-reader-vs-not
  are different judgments with different evidence. The junk filter is
  high-precision pattern matching that needs no bio and stays deterministic
  and fast; the prefilter needs the bio and an LLM call per item. Conflating
  them would force the deterministic filter's rules to start encoding
  reader-specific taste (fragile, unreviewable) or force every garbage call
  through an LLM (slow, costly, and a worse fit for "this regex always means
  press-release boilerplate"). They stay separate, parallel passes that
  compose by intersection — exactly like the LLM `filter` stage and the junk
  filter already do today.

- **Conservative keep-bias, not a percentile quota.** This is a *floor* that
  strips obvious noise, not a relevance ranking with a target size (that's
  editor-pass-1 and the editor's job, downstream, with full cluster context).
  A quota-based cut here would force borderline calls before the pile is even
  assembled, when the reader-relevance evidence is thinnest. Fail-safe
  direction is KEEP for the same reason editor-pass-1 fail-safes toward the
  middle of its range rather than toward zero: an over-inclusive floor costs
  the clusterer and editor a little context; a wrongly-cut story is gone and
  cannot be recovered by any later stage.

- **Retained-pool design.** Cut verdicts are recorded, never enacted as
  deletes. `preprocessed_items` keeps the full day's pool so a future writer
  stage — one that can search across everything collected, not just what made
  the paper — has the complete record to work from. This is purely a
  "don't pass this forward to clustering" signal, not a "this didn't happen"
  signal.

- **Built to become a scorer.** The output format —
  `id;;verdict;;reason` with `verdict` in the same column position as
  editor-pass-1's `score` — and the `prefilter_results` schema (an additive
  `score INT` column would let `keep` become a derived threshold) are chosen
  so that, once the keep/cut version is validated against real daily output,
  promoting it to an absolute-floor *scorer* is a prompt change plus one
  additive migration — not a rebuild. If that promotion happens, it can
  absorb editor-pass-1's bio-aware scoring entirely (collapsing the two
  passes into one earlier, cheaper one) — deferred until the binary version
  has run long enough to show whether a finer-grained floor is worth it.

---

## 2026-06-08 — Prefilter now classifies kept items as news vs opinion, routing opinion to Longer Reads

**Decision:** Extend the prefilter's per-item judgment from a binary
keep/cut verdict to a three-way verdict: `cut`, `news`, or `opinion`. The
output line shape is unchanged (`id;;verdict;;reason`, same delimiter, same
column position) — only the vocabulary in the middle column widens. `cut`
keeps its meaning; `news` and `opinion` both map to `keep = true` but split
on a new `kind` column. Items the prefilter keeps as `news` flow into
clustering exactly as `keep` did before; items it keeps as `opinion` are
excluded from clustering and pool for the Longer Reads section — the same
destination `track = 'analysis'` items already accumulate in. Schema:
additive migration 017 adds `kind TEXT NOT NULL DEFAULT 'news' CHECK (kind
IN ('news', 'opinion'))` to `prefilter_results`. Both consumers of the
prefilter's kept-set — the triage assembler's `getPrefilterKeptIds` (backing
`getTriageItems`) and editor-pass-1's `getPrefilterKeptIds` (backing its
residual-singleton query) — now additionally filter `AND kind = 'news'`, so
an item reaches the clusterer or gets scored only if it is `track = 'news'`
AND prefilter-kept AND `kind = 'news'`. No Longer Reads consumer is built
yet; opinion-kept items simply accumulate, unconsumed, alongside analysis
items until that stage exists.

**Context:** Opinion and commentary pieces — a blog post arguing "LLMs are
eroding my career," a column making the case for or against the Iran
war — were flowing into clustering alongside reporting. They don't cluster
(each is a one-off argument, not a recurring story other sources also
cover), they score high on bio-relevance (the topics are exactly what this
reader cares about), and so they surfaced as residual singletons that
floated up through editor-pass-1 and the editor as bogus "features" — a
single columnist's opinion presented with the weight of a major story. That
is a routing problem, not a quality problem: these pieces have real value,
just not as news-pile candidates.

**Rationale:**

- **Fix it upstream, at the prefilter, not in the clusterer or editor.**
  The clusterer and editor only ever see what the assembler hands them; by
  the time an opinion piece reaches either, the damage (a bogus feature
  slot, wasted context) is already done. The prefilter is the single choke
  point between the preprocessor and clustering where every `track = 'news'`
  item already gets one bio-aware LLM judgment — adding a second axis to
  that same judgment (rather than a new pass) is the cheapest place to catch
  this, and it composes naturally with the existing keep/cut floor: an item
  must first clear the relevance bar before its news-vs-opinion character
  even matters.

- **Same routing primitive as `track = 'analysis'`.** The pipeline already
  has a clean mechanism for "this is valuable to the reader but is not a
  news-pile candidate" — the `track` field set at preprocess time routes
  analysis pieces out of clustering into the (future) Longer Reads pool.
  Opinion pieces need exactly the same treatment, just decided later (the
  prefilter has the bio; the preprocessor's `track` assignment does not).
  Reusing the destination — rather than inventing a new pool or a new
  status — keeps "things that aren't news-pile candidates" a single concept
  with two on-ramps (structural at preprocess time, judgment-based at
  prefilter time).

- **Conservative news-default, mirroring the keep-bias.** When genuinely
  unsure between news and opinion, the prompt instructs NEWS. This mirrors
  the prefilter's existing keep-over-cut bias for the same reason: a
  wrongly-opinion-routed story never reaches the daily paper (it's gone, the
  same as a wrongly-cut one), while a wrongly-news-routed opinion piece is
  merely a minor miscategorization the clusterer and editor can absorb —
  recoverable, not fatal. The fail-safe direction for unparseable lines and
  unknown verdict tokens is therefore `keep = true, kind = 'news'`, the
  single safest combination of the three-way space.

- **One token, same line shape — no format churn.** Widening the verdict
  vocabulary from two values to three, in the same delimited column, keeps
  `parseBatchOutput`'s structure (split on first two `;;`, defensive
  reconciliation, fail-safe-by-id) untouched apart from the mapping itself.
  This preserves the parser's kinship with editor-pass-1's, and keeps intact
  the design noted in the prefilter's original entry above — that promoting
  this stage to a numeric scorer later remains a prompt-plus-migration
  change, not a rebuild.

---

## 2026-06-07 — Triage clusterer: ordered group-rounds → wire seed + parallel spines + id-union merge

**Decision:** Replace the single-chain ordered-rounds clusterer with three
phases: a **seed** call that clusters only `group: wire` items, a set of
**spines** — thematic group-sets defined in config — that each accrete onto
the seed's cluster list independently and run *concurrently*, and a
**deterministic software merge** that unions the spines' outputs into the
final digest by shared item ids. No semantic-matching LLM call is needed for
the merge.

**Context:** The group-based round chain (entry directly below) also failed,
just later: it got through `wire` → `national` → ... → `local` (round 9), but
the carry-forward "loose pool" of unclustered items kept re-inflating round
over round — 495 → 637 → 647 → 714 items by `tech` (round 10) — until that
round's prompt hit the same `qwen3.5:397b` 903s wall and produced no digest.

Root cause was structural, not a tuning problem: a **single accretion chain**
is sequential (call N+1 can't start until call N returns) **and** every round
inherits every prior round's unclustered items, so the loose pool only ever
grows. Splitting groups into more, smaller, better-ordered rounds delays the
blowup; it can't prevent it, because the chain's defining property — one
shared, ever-growing carry-forward pool — is what causes it.

**Rationale:** Removing the chain removes both failure modes at once:

- **No sequencing.** Each spine is an independent call from the same
  starting point (the seed's cluster list) — there is no "prior round" to
  wait on, so spines run concurrently (capped at `max_concurrent_spines`,
  reusing editor-pass-1's `p-limit` concurrency-limiter pattern: provider
  caps us at 3 simultaneous connections).
- **No shared, growing carry-forward pool.** A spine sees only its own
  group-set's items as "new items," never another spine's leftovers. Its
  prompt size is bounded by its own slice of the pile — config-controlled,
  not emergent — so it stays in the model's proven working range (~130 items,
  per the original `wire` round's clean 40s run) regardless of total pile
  size or how clustering is going elsewhere.

The seed-shared-id insight is what makes the merge deterministic and
semantic-matching-free: every spine accretes onto the *same* seed cluster
list and re-emits it as part of its output, so the same major story appears
in multiple spines' outputs sharing the seed's item ids — an exact merge key.
Any two clusters (across any spines, including re-emitted copies of the same
seed cluster) sharing >= 1 id are unioned transitively, ids deduped
keep-first, canonical label/summary taken from the largest contributing
cluster. Clusters that cover the same story but share zero ids (e.g. a story
covered only by sources split across two different spines) can't be caught
this way — those are flagged as `possible unmerged duplicates` via a
title-similarity heuristic (Jaccard over normalized word sets) and logged for
inspection, not auto-merged.

`config/models.yaml`'s `triage.clustering` changed from `{rounds}` to `{seed,
spines, max_concurrent_spines}`. `seed` and each spine's `groups` are matched
against `preprocessed_items.group` (unchanged structural axis — see the
entries below). Any group claimed by neither `seed` nor a configured spine is
swept into an implicit fallback `rest` spine at runtime, so nothing is
silently excluded.

The contract with everything downstream is unchanged: `triage_runs.digest`
holds the merged list in the same flat `label;;summary;;ids` format,
`cluster_index` is the position in that list (item-count descending, "biggest
story first" — the same convention the system prompt already asks the model
to follow), and `parseFlatClusterOutput`/the editor/assemble-pile required no
changes. `round_digests` (migration 014) now stores the seed's raw output,
each spine's raw output (`spine:<name>`), and the final merged list
(`merged`), so a run remains inspectable stage by stage.

Validation is unchanged in kind: ids are checked against the full news-item
id set for the run, with fabricated/duplicate/sub-2-id handling exactly as
before — applied per spine output before the merge, so the merge only ever
combines already-validated clusters and is guaranteed to produce disjoint,
>= 2-id, fabrication-free results. The lost-id check is adapted to the new
shape: any id clustered by the seed but absent from *every* spine's output is
gone from the final digest (no further round exists to give it another
chance, unlike the old chain) — logged loudly as `LOST ... absent from every
spine's output`.

**Deferred:** A semantic merge pass over the `possible unmerged duplicates`
list — clusters with no shared ids but highly similar titles — to fold them
together with editorial judgment the deterministic merge can't apply. Not
built; the title-similarity heuristic only logs candidates for inspection.
Add this only if the flagged list shows real, recurring same-story splits
across spines.

**Supersedes:** The "ordered group-based rounds" portion of the entry
immediately below (which itself superseded the original two-round
`wire`/`rest` chain).

---

## 2026-06-07 — Triage clusterer: two-round split → group-based rounds

**Decision:** Replace the two-round `wire` / `rest` split with an ordered
sequence of thirteen rounds keyed on a new `preprocessed_items.group` field,
in spine-first order: `wire`, `national`, `intl_broad`, `accountability`,
`legal`, `intl_regional`, `local`, `labor`, `climate`, `tech`, `ai`,
`science`, then a final catch-all (`*`) `rest` round.

**Context:** The two-round split (below) failed in practice. Round 1 (133
wire items) completed in ~40s; round 2 (~1,234 remaining items, the entire
non-wire pile) timed out `qwen3.5:397b` at 903s and produced no digest —
confirmed twice. Diagnosis: `rest` wasn't a round, it was the whole pile
again. `source_type` couldn't provide finer-grained rounds either — 1,168 of
~1,174 non-wire items share `source_type: journalism`.

**Rationale:** Round 1 proved the model handles ~130 items cleanly, so the
fix is to keep every round's prompt in that working range. That requires an
axis finer than `source_type`. We added `group` — a new, optional field on
each source in `config/sources.yaml` (and `preprocessed_items.group`,
migration 015, set at preprocess time exactly like `track`: looked up by
`source_name`, inherited, nullable, no default). `group` is a **structural
clustering axis only** — it controls which round an item enters and nothing
else. It is NOT an editorial or topic tag: it never reaches the paper, the
editor, or the reader, and is orthogonal to both `type` (wire / journalism /
advocacy / newsletter) and `track` (news / analysis). The thirteen group
values map directly onto the organizational sections `config/sources.yaml`
already had in comments (wire, national news, accountability/investigative,
PNW/Oregon local, international broad vs. regional, technology, AI, climate,
labor, legal, science, plus a `national` default for genuinely ambiguous
sources).

Round order is spine-first by design: wire and national-prominence groups go
first so the major stories of the day already exist as clusters before the
regional/topical tail (local, labor, climate, tech, ai, science, ...)
accretes onto them or forms its own smaller clusters — rather than the tail
forming its own competing clusters that later have to be merged with the
spine's. `config/models.yaml`'s `triage.clustering.rounds` schema changed
from `{name, types}` (matched against `source_type`) to `{name, groups}`
(matched against `preprocessed_items.group`); the catch-all `"*"` semantics
are unchanged. The re-emit-full-list mechanism, loose-item carry-forward, and
lost-id detection from the prior decision are unchanged — this is purely
"more, smaller, better-ordered rounds," not a new clustering strategy.

New per-round logging makes the loose pool observable: `new=` (this round's
group items), `loose=` (carried-forward unclustered items), and
`total_prompt_items=` (the number to watch — if it climbs back toward
full-pile size in late rounds, the split isn't holding and items are piling
up as loose carry-forward instead of landing in clusters).

**Deferred:** A final cluster-only merge pass over just the emitted cluster
lines (no items) to catch residual same-story duplicates across rounds —
cheap and timeout-safe because it sees only ~60 lines of cluster summaries,
not items. Not built; add only if duplicates persist after this multi-round
split proves insufficient on its own.

**Supersedes:** The "start with exactly two rounds: `wire` and `rest`"
portion of the entry immediately below.

---

## 2026-06-07 — Triage clusterer: single-pass → multi-round incremental clustering

**Decision:** Replace the triage clusterer's single whole-pile LLM call with
an ordered sequence of rounds, each admitting a config-defined subset of
items by `preprocessed_items.source_type`. Each round shows the model the
complete cluster list built so far (the prior round's raw emitted text,
verbatim) plus a "new items" batch — this round's items, plus any item from
earlier rounds that hasn't landed in a cluster yet — and asks it to fold the
new batch in and **re-emit the complete updated cluster list** in the
existing flat `label;;summary;;ids` format. Adding a member, creating a
cluster, and merging two clusters all become the same operation: edit the
re-emitted list. No new instruction language or output schema was needed.

`config/models.yaml` gains `triage.clustering.rounds`: an ordered list of
`{name, types}`. `types` may name explicit `source_type` values or include
the catch-all `"*"`, which admits everything not yet claimed by an earlier
round. Round membership is purely config-driven — adding, removing, or
reordering rounds is a config edit, not a code change. We start with exactly
two rounds: `wire` (types: `[wire]`) and `rest` (types: `[*]`).

The contract with everything downstream is unchanged: `triage_runs.digest`
still holds the **final** round's raw text, in the same flat format.
`parseFlatClusterOutput`, `cluster_index` semantics, the editor, and
assemble-pile required no changes. A new nullable `round_digests JSONB`
column (migration 014) additionally stores every round's raw text — `[{name,
text}, ...]` — purely for round-by-round inspection (`npm run inspect --
triage --id <n> --rounds`); it plays no role in the pipeline.

Validation is extended, not replaced: ids are still checked against the full
news-item id set for the run (the union across all rounds — broader than any
single round's pile, exactly as the old whole-pile validation was), with
fabricated/duplicate/sub-2-id handling unchanged. The new failure mode this
staging introduces — a re-emission round silently dropping a previously-
clustered id or whole cluster — is caught explicitly: after each round we diff
its clustered-id set against the prior round's, log anything that disappeared
as **lost**, loudly, and feed those ids back into the next round's loose-item
pool so they get another chance rather than vanishing.

**Context:** Consistency checks on the old whole-pile call showed the model
losing track at full pile size — 86 to 223 duplicate cluster ids per run
(the same story split into multiple clusters) and missed merges of obvious
near-duplicates. The pile is too large for the model to hold in working
memory as a single reasoning pass.

**Rationale:** Staging never asks the model to reason over the whole pile at
once — each call sees a manageable slice plus a running summary it already
produced (and can therefore trust and edit, rather than re-derive from raw
items). Re-emit-the-complete-list is the simplest mechanism that unifies
"add," "create," and "merge" into one operation the model already knows how
to do (it's the same output shape as round one), so no prompt-engineering for
new operations was needed — only an instruction to treat the prior list as
editable rather than fixed. Keeping the digest format, validation contract,
and downstream consumers untouched means this is purely an internal staging
change to triage; nothing else in the pipeline needs to know clustering now
happens in rounds. We deliberately did not loosen the conservative merge
threshold in this pass — we're isolating whether staging alone fixes the
duplicate-cluster problem before changing what "same story" means.

**Known limitation:** With only two rounds and this source list, the second
round (`rest` — everything that isn't wire) is still large; staging reduces
the pile the model reasons over per call but doesn't eliminate big single
calls. Finer-grained round membership (e.g. splitting `journalism` further,
or admitting by volume rather than type) is deferred until the inspection
harness shows the two-round split isn't enough — we'd rather learn that from
real `lost-from-prior` and duplicate-id data than guess at a finer split now.

---

## 2026-06-07 — Editor stage: whole-pile single call, three tiers + cut, line-order ranking

**Decision:** The editor stage reads the assembled `editor_pile` (clusters +
in-pile singletons) and makes ONE whole-pile LLM call that produces a single
ranked, tiered list — not batched. Each pile item gets one of four
dispositions: `feature`, `standard`, `brief`, or `cut`. The model emits items
in ranked order, best first, as flat lines `tier;;ref;;reason` (`ref` is
`C{cluster_index}` or `S{preprocessed_item_id}`); software derives `rank` from
line position — the model never emits a rank number. Reconciliation is
defensive in the same spirit as pass-1: every pile item must appear exactly
once, with unknown refs dropped+logged, duplicate refs keeping the first
occurrence, invalid tiers fail-safed to `brief`, and — critically — pile items
missing from the model's output fail-safed to `brief` (appended at the bottom
of the rank order) rather than silently dropped, because an editor that drops
items truncates the paper. New tables `editor_runs` (one row per execution,
with per-tier counts) and `editor_stories` (one row per pile item, `rank`
NOT NULL, full lineage to cluster or singleton) record the result.

**Context:** Pass-1 batches hundreds of items through independent per-item
scoring calls — order and relative comparison don't matter there, so batching
and concurrency are free wins. The editor's job is the opposite: it has to
decide which story leads, which runs second, and how the rest fall away
relative to each other. That's an inherently relational judgment that requires
the whole pile in view at once. The pile is sized precisely so this fits in one
call (clusters pass through unconditionally; `singleton_pile_target` bounds the
rest), so there's no batching problem to solve, and splitting the call would
mean re-introducing the cross-batch consistency problems pass-1 exists to
avoid downstream of it.

**Rationale for four flat tiers over JSON:** Same reasoning as pass-1's flat
line format — flat text is cheaper to emit, harder for the model to malform
into invalid JSON under load, and trivially diffable in logs. Four
dispositions (three sizes the publisher already has cards for, plus an
explicit `cut`) map directly onto the paper's "variable register" principle
without inventing new vocabulary; `cut` makes "this doesn't make today's paper"
a first-class, auditable decision rather than an absence.

**Rationale for deriving rank in software:** Asking the model to emit both an
explicit rank number and a line order invites contradictions (what does rank 3
on the 7th line mean?) that would need their own reconciliation logic. Line
order *is* the ranking signal the model is naturally producing by writing the
list best-first — encoding it twice would be redundant and error-prone. This
mirrors how pass-1 lets the model emit only a score and lets software do the
sorting and slicing.

**Rationale for cluster/singleton presentation order:** Clusters (cross-source
coverage, the strongest prominence signal available) are presented first,
ordered by item count descending — cluster_index is parsed from the digest the
same line-counting way `assemble-pile.ts` and pass-1's `extractClusteredIds`
do, so it lines up with `editor_pile_items.cluster_index`. Singletons follow,
ordered by their pass-1 score descending. This gives the model a stable,
inspectable starting arrangement to re-rank from, the same spirit as triage's
source-count ordering — a mechanical proxy, not a judgment call left to chance.

---

## 2026-06-06 — News/analysis track split

**Decision:** Added a `track` field (`news` | `analysis`, default `news`) to
sources.yaml and a corresponding `track` column to `preprocessed_items`.
Longform analysis sources (The Atlantic, The New Yorker, Harper's Magazine,
The New York Review of Books, London Review of Books, Reason, Foreign Affairs,
The Marshall Project, Aeon, Noema, The Baffler, n+1, Jacobin, The Nation,
Naked Capitalism, Le Monde Diplomatique (English)) are marked `track:
analysis`. Everything else defaults to `news`.

The two "piles" are just two WHERE clauses against one table — no new tables,
stages, or plumbing. Analysis items are never consumed by any current stage:
the assembler, triage, and editor-pass-1 all filter to `track = 'news'`.
Analysis items pool in `preprocessed_items` unconsumed until a Longer Reads
selector is built.

**Why it's a source property, not a per-story judgment:** `track` is stable
for a given outlet — The Atlantic reliably publishes longform analysis, AP
reliably publishes news wire. This is fundamentally different from
story-level topic (whether a given piece is about climate, labor, etc.),
which varies within a source and is correctly assigned by the editor stage.
We explicitly rejected a per-story news/analysis classification in earlier
design: we have no budget for an extra LLM pass over every item, and the
source-level signal is sufficient to separate the two populations.

**Why derived at preprocess time:** `track` is looked up from the source
config at preprocess time and written onto the row, so it is immediately
queryable by all downstream stages without re-joining to the config file.
It is trivially re-derivable on re-run — no new information is consumed.

**Why not a new table or stage:** Adding a separate analysis table would
duplicate schema and require all downstream queries to union two tables.
A separate pipeline stage would be waste until there is a consumer. One
discriminator column on an existing table, filtered by WHERE clause, is
the right shape for a feature that is currently only one side of the query
useful.

---

## 2026-05-30 — Triage is neutral by design

**Decision:** The triage stage applies no editorial judgment, reader context, or research recommendations. It groups items into clusters and describes them neutrally. All judgment happens downstream.

**Context:** Triage is the first LLM stage and the only one that reads every item. The temptation is to have it rank, score, or flag items for investigation.

**Rationale:** Judgment requires context triage doesn't have: the reader's bio, the standing memo, yesterday's paper, the source policy. Asking triage to make editorial calls would produce premature filtering based on incomplete context. The editor stage, which has all of that context, is where those calls belong. Triage's only job is to make the pile navigable — a filing clerk, not an editor.

---

## 2026-05-30 — Clusters ordered by source count descending

**Decision:** The triage prompt instructs the LLM to order clusters by source count, descending. Most-covered story first.

**Context:** An alternative was to let the LLM use its own judgment about ordering, or to order chronologically.

**Rationale:** Source count is a mechanical, observable proxy for coverage volume. Ordering by it gives a consistent, inspectable signal without asking the LLM to exercise judgment about importance. The most-covered story reliably leads. If source-count ordering turns out to be a bad signal in practice, the prompt can be revised.

---

## 2026-05-30 — Continuity system deferred

**Decision:** Triage does not compare today's clusters to yesterday's. No continuity matching at this stage.

**Context:** The concept doc mentions continuity as a first-class feature: today's paper is aware of yesterday's.

**Rationale:** Continuity matching requires published papers to compare against, and the publisher doesn't exist yet. Implementing a continuity check now would mean writing against a hypothetical schema. The decision is documented so it gets added once the publisher exists and there's real data to match against.

---

## 2026-05-30 — LLM wrapper thin by design

**Decision:** `src/llm/index.ts` wraps the OpenAI SDK with only two additions: generation_logs insertion and a typed interface. No retry logic, no streaming, no middleware chain.

**Context:** Alternatives considered: LangChain-style middleware, a heavier abstraction with pluggable providers, retry with exponential backoff.

**Rationale:** The OpenAI SDK handles HTTP/SSE transport. The only project-specific requirements are logging every call to Postgres and providing a typed interface for stage code. Adding retry logic before there's real failure data would be speculative. The wrapper is intentionally thin so it's easy to read and easy to extend when specific needs emerge.

---

## 2026-05-30 — No retry logic in V1

**Decision:** callLLM() does not retry on failure. If the LLM call throws, the error is logged to generation_logs and rethrown immediately.

**Context:** Retry logic with exponential backoff is standard practice for API calls.

**Rationale:** The right retry policy depends on failure patterns we don't have yet. Transient rate limits need different treatment than timeout failures, which need different treatment than model errors. Adding generic retry now risks masking real failures or running up token costs during debugging. Add retry logic once there's real failure data to design from.

---

## 2026-05-30 — Triage document is flat chronological, not pre-grouped

**Decision:** The assembler produces a flat list of items sorted by
published_at ascending (nulls last). No section headers, no grouping by
source or topic.

**Context:** An earlier instinct was to group items by source or cluster
them by title similarity before feeding them to the triage LLM.

**Rationale:** LLM clustering is smarter than mechanical clustering. The
triage model has a large context window and can recognize cross-source
coverage, semantic clusters, and story threads on its own — with better
precision than Jaccard similarity on titles. Pre-grouping would bias the
LLM toward the preprocessor's grouping decisions and obscure the raw
signal. Flat chronological order preserves all signal and puts the
analytical work where it belongs: in the LLM call that was designed for it.

---

## 2026-05-30 — Deduplication is canonical-URL-within-source, not cross-source

**Decision:** The preprocessor deduplicates on `(canonical_url, source_name)`.
Two items with the same canonical URL from different sources are both kept.

**Context:** A simpler approach would deduplicate globally on canonical URL,
keeping only one item per URL regardless of source.

**Rationale:** Cross-source coverage of the same URL is signal, not noise.
If AP, Reuters, and NPR all link to the same Washington Post story, that
pickup count is meaningful prominence signal for the triage stage. Dropping
the duplicates would discard that information. Deduplication within a single
source is still correct: one source shouldn't contribute two rows for the
same story just because it appeared twice in the feed.

---

## 2026-05-30 — Recency window is 48 hours, not 24

**Decision:** The preprocessor includes raw_items where published_at or
fetched_at is within the past 48 hours.

**Context:** A 24-hour window matches the paper's daily cadence but risks
dropping items that should appear in today's paper.

**Rationale:** Some feeds lag — an item published at 11pm may not be fetched
until the next day's run. A newsletter might summarize a story from yesterday
that's still worth including. 48 hours provides a buffer without meaningfully
increasing noise, because the recency filter is followed by triage, which
filters by relevance, not just recency. True duplicates from across the window
are handled by URL deduplication.

---

## 2026-05-30 — html-to-text for HTML stripping

**Decision:** Use the `html-to-text` npm package to convert feed body content
from HTML to clean plain text.

**Context:** Alternatives considered: `cheerio` (full DOM parser, then
text extraction); stripping tags with a regex; rolling a simple tag-stripper.

**Rationale:** `html-to-text` handles document structure correctly — it
turns `<p>` and `<br>` into newlines, `<li>` into list items, converts
`<a>` to link text (href discarded), and ignores `<img>`, `<figure>`,
`<script>`, and `<style>`. A regex strip would produce collapsed text with
no whitespace between paragraphs, making it harder to read and harder to
truncate meaningfully. Cheerio would work but requires two steps (parse +
extract) for the same result. `html-to-text` is the right tool for the job.

---

## 2026-05-27 — Self-contained Postgres inside the compose stack

**Decision:** Postgres runs as a service inside the project's own
docker-compose stack on a private internal network. The app service joins
both the internal network (to reach Postgres by service name) and the
external `seedbox_default` network (so Caddy can reach the app by container
name). No Postgres port is published to the host.

**Context:** The original stack design assumed a shared host-level Postgres
instance that both Fritterflix and Fritter Post would use (see 2026-05-26
stack entry). A subsequent implementation attempt (see 2026-05-27
host.docker.internal entry) tried to reach that host Postgres via
`host.docker.internal`. Both were wrong: there is no shared host Postgres on
fritter.lol. Fritterflix runs its own Postgres inside its own compose stack
on a private internal network, and Caddy on the host proxies to the app
container via the `seedbox_default` Docker network.

**Rationale:** Mirroring the Fritterflix pattern is the right call for several
reasons:
- Each project owns its database: no cross-project coupling, no shared failure
  modes, independent backup and upgrade paths.
- The `seedbox_default` network is already established on the host for Caddy
  routing. Joining it is the correct mechanism for host-side Caddy to reach
  app containers without publishing ports.
- `host.docker.internal` on Linux requires `extra_hosts: host-gateway`, works
  differently across Docker versions, and becomes moot if there is no host
  Postgres to reach.

**Supersedes:** 2026-05-26 "Stack: TypeScript + Next.js, reuse Postgres" (the
database portion only); 2026-05-27 "Docker → host Postgres via
host.docker.internal".

---

## 2026-05-27 — Lazy database pool initialization

**Decision:** `src/db/index.ts` exports `getPool()` (lazy, cached) instead of
a module-level singleton that throws at import time.

**Context:** The previous implementation threw immediately if DATABASE_URL was
unset, which meant Next.js build would fail unless a dummy value was provided.
The Dockerfile had a dummy value hard-coded for exactly this reason.

**Rationale:** The pool is only needed when a database call is actually made.
Deferring initialization to first use means importing `src/db/index.ts` is
always safe, and the build no longer requires a dummy DATABASE_URL. The
dummy was a maintenance hazard — if it were a valid connection string in a
CI environment, it could cause unexpected database connections.

---

## 2026-05-27 — Collector RSS library: rss-parser

**Decision:** Use `rss-parser` for RSS and Atom feed parsing.

**Context:** Alternatives considered: `feedparser` (Node.js streams, less
TypeScript-friendly), `@extractus/feed-extractor` (newer but smaller ecosystem),
rolling our own XML parser with `xml2js` (unnecessary complexity).

**Rationale:** `rss-parser` handles RSS 1.0, 2.0, and Atom in one package,
has first-party TypeScript types with useful generic type parameters for custom
fields, supports `timeout` and custom `headers` directly in the constructor,
and is the most widely used feed-parsing library for Node.js. The custom field
generics let us type `content:encoded` and `dc:creator` without resorting to
`any`.

---

## 2026-05-27 — Synthesized guid: SHA-256 of source + url + title

**Decision:** When a feed item lacks a guid, synthesize one as
`"synth:" + SHA-256(source_name + "\0" + original_url + "\0" + title).slice(0, 40)`.

**Context:** The `(source_name, item_guid)` unique constraint enforces
idempotency. If two runs disagree on the synthesized guid for the same logical
item, the constraint fails to deduplicate and you get duplicate rows.

**Rationale:** The three fields (source, URL, title) together identify a news
item with high confidence. NUL-byte separators prevent ambiguous concatenation.
The `"synth:"` prefix visually distinguishes synthetic guids from feed-supplied
ones in debugging contexts. SHA-256 is deterministic across platforms and
truncated to 40 hex chars (160 bits) is more than sufficient for uniqueness at
any realistic feed volume.

---

## 2026-05-27 — Docker → host Postgres via host.docker.internal

**Decision:** The container reaches the host's Postgres instance via the
hostname `host.docker.internal`, backed by `extra_hosts: host-gateway` in
docker-compose.yml.

**Context:** Postgres runs on the host alongside Fritterflix and is not part
of the compose stack. The container needs a stable way to address the host.

**Rationale:** Three options considered:
1. `network_mode: host` — the container shares the host's network namespace.
   Simple, but eliminates container network isolation and port-mapping control.
2. Hardcoded host IP — fragile; breaks if the host's IP changes.
3. `host.docker.internal` + `extra_hosts: host-gateway` — explicit, portable
   across Docker versions on Linux, matches the Docker Desktop behavior on
   Mac/Windows, and keeps the compose file self-documenting. Preferred.

---

## 2026-05-27 — Migration runner: custom tsx script, not a library

**Decision:** Migrations are plain numbered .sql files in `migrations/`.
A small `scripts/migrate.ts` runner discovers, applies, and records them.
No third-party migration library (Flyway, node-pg-migrate, Umzug, etc.).

**Context:** The project uses `pg` directly (no ORM), and the migration
surface is expected to be small and infrequent.

**Rationale:** A custom runner is ~70 lines and has zero hidden behaviour. It
applies files in filename order (alphabetical = numeric order for the `NNN_`
prefix scheme), wraps each in a transaction, and records completions in a
`_migrations` table. That's the whole contract. A library would add a
dependency for essentially the same logic.

---

## 2026-05-27 — raw_items table shape

**Decision:** `raw_items` columns: `id`, `source_name`, `source_type`,
`feed_url`, `item_guid`, `original_url`, `url` (nullable, set by
preprocessor), `title`, `body` (nullable), `author` (nullable),
`published_at` (nullable), `fetched_at`, `raw_entry` (JSONB).
Unique constraint on `(source_name, item_guid)`.

**Context:** The collector writes one row per item per feed fetch. The
preprocessor reads these rows and adds canonical URLs. Later stages only
read from preprocessed clusters, not directly from raw_items.

**Rationale:**
- `item_guid` is the feed's own identifier (RSS `<guid>`, Atom `<id>`).
  When absent, the collector synthesizes one (e.g. hash of source + URL).
  This is the idempotency key — re-running the collector ON CONFLICT DO NOTHING.
- `original_url` is what came out of the feed; `url` is populated later by
  the preprocessor after canonicalization (tracking params stripped, AMP
  normalized). Keeping both preserves debugging lineage.
- `body` and `author` are nullable because many feeds don't provide them.
- `published_at` is nullable for the same reason (feed omissions are common).
- `raw_entry` JSONB preserves the full feed entry so no information is lost;
  extraction can be improved later without re-fetching.
- Indexes on `source_name`, `fetched_at`, and `url` cover the expected query
  patterns: source filtering, retention window management, and preprocessor
  deduplication.

---

## 2026-05-26 — Build pipeline before publisher

**Decision:** Build the upstream stages (collector → preprocessor →
triage → researcher) first, before designing the publisher and the
visual layout.

**Context:** The original instinct was to mock up a target paper first
and reverse-engineer the publisher schema from it. After working through
sizing, it became clear that the unknown isn't "what does a newspaper
look like" — newspapers are a largely-solved layout problem — but "what
does a real day's worth of relevant-to-John content actually look like
after triage." That's information you can't get without running the
pipeline.

**Rationale:** The output of the researcher stage is the answer to "how
much content is there per day, of what kinds." Once that's running for a
couple of weeks, the layout decisions become tractable because there's
real data to design for. Starting with the publisher would mean
designing around guesses.

**Tradeoff:** Several weeks of work where the only artifact is JSON in a
database, before there's anything visual to look at.

---

## 2026-05-26 — Drop primary sources for V1

**Decision:** Federal Register, SEC EDGAR, CourtListener, OLIS, Bend
city council agendas, and similar primary-source feeds are out of scope.

**Context:** The earlier source draft included a "Primary Sources"
section in the spirit of I.F. Stone reading the documents others ignore.

**Rationale:** The Fritter Post is a news aggregator and synthesizer,
not an independent reporting tool. Primary sources are a different kind
of project. They'd also blow up the collector's volume — the Federal
Register publishes hundreds of items a day. Worth keeping in mind for a
future project; not appropriate for this one's V1.

---

## 2026-05-26 — Drop the "state-media" source type

**Decision:** Removed `state-media` as a value of the source `type`
field. All journalistic sources are `journalism`; institutional alignment
goes in the notes.

**Context:** Earlier draft labeled Xinhua as `state-media`. BBC, Al
Jazeera, and NPR all have institutional alignment with their funders but
weren't labeled the same way.

**Rationale:** Every outlet has institutional alignment that affects
coverage of certain topics. Singling out outlets aligned with adversarial
governments while treating Western state-funded outlets as neutral is
itself a politically loaded frame. The honest move is to drop the
category and put context in notes for the sources where alignment
matters — BBC, Al Jazeera, NPR, Xinhua, SCMP all get brief factual notes
about their institutional position.

There's still a meaningful operational distinction (operationally
independent outlets vs. outlets whose editorial line is directly set by
government) but it's a spectrum, not a binary, and the source policy
document can handle the operational nuance.

---

## 2026-05-26 — Source schema: no tiers, no categories

**Decision:** Sources have `name`, `url`, `type`, and `notes`. No
prominence tiers. No pre-assigned topic categories.

**Context:** Earlier draft assigned each source a tier (1/2/3) and a
category (us-national, world, tech, etc.).

**Rationale:**

Tiers ask for a confidence judgment on every source before there's any
data to ground that judgment in. The functional purpose of tiers
(prominence weighting in the preprocessor) is something the triage LLM
can do fine on its own based on source identity and cross-source pickup.
If triage gets prominence wrong in practice, tiers can be added back.

Categories belong on stories, not sources. The Markup writes both tech
and accountability pieces; The Guardian covers everything. A source-level
category is either ambiguous (which is wrong) or duplicated (which is
overhead). Story-level tagging by the editor stage is the right model.

`type` stays because the source policy genuinely treats wires,
journalism, advocacy, and newsletters differently in operational ways
(volume, voice, trust handling).

---

## 2026-05-26 — Longer Reads as both source category and section

**Decision:** The paper includes a Longer Reads section curating 1-3
long-form pieces per week. Several sources are added primarily as feeders
for this section (The Atlantic, New Yorker, NYRB, LRB, Reason, Foreign
Affairs, Harper's, Aeon, Noema, etc.). Long pieces from other sources
(Jacobin features, ProPublica investigations, Le Monde Diplomatique)
also feed it.

**Context:** The concept doc already specified "Outside long-reads are
surfaced with substantial context paragraphs and prominent links. No
reproduction of others' text," but it wasn't architecturally surfaced.

**Rationale:** Longer Reads is curatorially distinct from daily news.
The decision is "which 1-3 long pieces from the past 1-7 days should
this reader make time for," not "which stories from today belong in the
paper." Different cadence, different judgment. The editor stage will
need a separate sub-process for it.

---

## 2026-05-26 — Stack: TypeScript + Next.js, reuse Postgres

**Decision:**
- Language: TypeScript
- Framework: Next.js (App Router)
- Database: existing PostgreSQL on fritter.lol, separate database
- Deployment: Docker behind Caddy at post.fritter.lol

**Context:** Fritterflix on the same box is already TypeScript/Next.js.
Postgres is already running. Reader develops conversationally with
coding agents, doesn't write code directly.

**Rationale:** Match the existing stack for operational simplicity (one
language, one database, one Docker pattern) and because coding agents
handle Next.js + TypeScript exceptionally well. Astro would be slightly
more on-aesthetic for a content site but doesn't earn the cost of
introducing a second framework.

**Alternatives considered:** Astro (content-first, ships less JS), plain
Node with templating (minimal). Rejected on framework-cost grounds.

---

## 2026-05-26 — LLM client: OpenAI SDK + thin internal wrapper

**Decision:** Use the OpenAI SDK as the HTTP/SSE client, pointed at
OpenAI-compatible endpoints (Ollama Cloud, OpenRouter). Wrap it in
`src/llm/` for project-specific concerns: logging every call to Postgres,
typed stage configs, retry policy, step-and-token budgets for agentic
loops.

**Context:** Considered rolling our own client. Considered LangChain-
style heavyweight frameworks.

**Rationale:** The HTTP/SSE layer is solved — rolling our own gets
nothing. Heavyweight frameworks introduce abstractions we'd need to
fight to get the lineage and logging this project specifically requires.
The thin wrapper is 100-200 lines and contains the parts that matter for
this project (full call lineage in Postgres, budget enforcement, typed
per-stage config). "Use the library for the boring part, write our own
for the project-specific part."

---

## 2026-06-17 — Cross-language clustering via English-space embedding

**Decision:** Non-English items are translated to English at the preprocessor
and the translation is stored alongside the original. The grouping stage
embeds the English text rather than the original. All other stages (display,
scoring, the editor, the paper) continue to read the original title and body.

**Problem:** Two sources covering the same event in different languages
(e.g. Le Monde in French, AP in English) produced embeddings far apart in
the vector space and therefore never clustered together, even when the
stories were identical in substance.

**Approach:**

- **Per-item language detection** using `franc-min` (trigram-based,
  covers CJK and distinguishes English from Latin-script European languages).
  Non-Latin scripts are detected by Unicode range as a fast path; for
  Latin-script text, franc's ISO 639-3 code is used (`eng` = English,
  `und` with only ASCII = treated conservatively as English, anything else
  = non-English).

- **Per-item translation** of title + body[:2000] with
  `Qwen/Qwen3.6-35B-A3B` via nanogpt, thinking/reasoning off (mechanical
  translation, not editorial judgment). Two separate LLM calls per
  non-English item (title and body) for clean, parseable output. Stored
  in `preprocessed_items.english_title` and `.english_body` (migration 028).

- **Copy-through for English items:** `english_title = title`,
  `english_body = body_text` — downstream code reads `english_*` uniformly,
  no branching.

- **Idempotency:** `english_title IS NOT NULL` check in `buildEnglishFields`
  skips translation if the fields are already populated. Grouping re-runs are
  free because the translated text is already stored in the DB.

- **Translation failure fallback:** on any LLM error, the original text is
  copied into `english_*` (item never lost — it just clusters within its own
  language as before). A per-run failure count is logged; crashes are never
  propagated over a single item.

- **Grouping step 1** builds body embed text from
  `english_title + english_body[:2000]` and title embed from `english_title`,
  with null-safe fallback to `title`/`body_text` for rows predating migration
  028.

- **similarity_threshold retained at 0.66.** Translating to one English space
  shifts the similarity distribution in an unknown direction for this feed
  mix. The step-2 log now reports `pairs_above_threshold` so the first real
  run will show whether 0.66 needs adjustment.

**Alternatives considered:**

- Source-level language tagging: rejected because some sources publish in
  multiple languages (mixed feeds), and per-item detection is more accurate.
- Multilingual embedding model (e.g. LaBSE): would require replacing the
  existing 4096-dim Qwen3-Embedding-8B infrastructure and retuning the
  similarity threshold. The translation approach reuses all existing
  infrastructure and keeps the embedding space purely English.
- Translating at grouping time: would re-translate on every grouping re-run.
  Storing translations in the preprocessor makes re-runs cheap.

---

## 2026-08-18 — Section lines get their own budget, and thin material caps the target

Run #8 was the first paper written with sections, and structurally it worked:
191 pieces across 11 sections, zero cross-section article overlap, nothing a
thread absorbed disappeared. Two of its defects were the same mistake in two
places — a piece was asked for a length its material could not honestly fill,
and it filled it anyway.

**Section lines were budgeted as briefs.** T3's lines came back at 40, 43, 45,
46 and 47 words against a 15–30 target: compressed briefs, not the one-sentence
pointers the design calls for. The word target alone was doing all the work
against a brief's allocation of three sources and 2,500 characters, which is
enough raw material for a second and third sentence and reads as an invitation
to write them.

The fix is a `line` tier in `writers.packet.tiers` — one source, 900 characters,
`target_words: [15, 30]` — selected by `assembleWriterPacket`'s new `budgetTier`
override rather than by the piece's published tier, which stays `brief`. Cutting
the target on the same material was tried first in the design and rejected: a
shorter number arguing with a fatter packet is the situation that produced run
#8. Removing the material removes the argument.

**A headline-only packet now caps the word target, whatever its tier.** T1's
sidebar S53521 had a headline and a lede and was asked for 120–200 words; it
produced detail about the 1924 Johnson–Reed Act that no source carried. The
packet already carried a note saying "write short and invent nothing", but a
note competes with a number and the number wins. `writers.packet.
headline_only_words` (25–60) is an element-wise minimum against the tier's own
target, so a brief keeps its 25–45 and a standard drops from 120–200.

The general rule this establishes: **when a prompt instruction contradicts a
prompt parameter, fix the parameter.** Instructions written against a standing
target lose.

**Lines and briefs never share a call.** They batched together because both are
short, but a brief is a short paragraph and a line is one sentence, and one call
has one register — the batch prompt frames the whole set. `partitionByCallShape`
now returns three pools and `buildBriefBatchUserPrompt` takes a `kind`.

Also in the voice memo: **an absence in the source is not a finding.** Run #8's
S53537 sidebar wrote that "surveillance powers have reached beyond people
suspected of immigration violations to political groups exercising protected
speech" where the source said only that the groups were never accused of a
crime. That is the third variant of the same failure the memo already covers for
characterizations and comparatives — an inference the reader can make, stated as
something the paper found out.

**Still open:** Gizmo has now reported twice that T1 ("immigration crackdown")
reads as a topic rather than a situation. If that holds, it is a threading
problem upstream, not a writing one, and the sections machinery is correctly
reporting it rather than causing it.

## 2026-08-18 — The materials audit reports feed text and fetched text separately

Run #113 was the first full-pipeline run: collect #50 through writer #10, 150
pieces on the day's news. The materials audit for it read:

    Median body: 560 chars       Thin (<800): 176 (58%)
    feature: 15 stories, 112 articles, median 441 chars, 75 thin

and the fetch for the same editor run reported `body text 33903 → 405351 chars`.
Both were correct. Read together they say the paper's features were written from
441-character teasers, which is false — the audit predates the fetch stage and
only ever measured `preprocessed_items`, never `article_texts`.

That mattered immediately: T2 (Gaza, rank 7, feature) shows 5 articles and 1,186
characters in the audit, and on those numbers its packet would be headline-only
and capped at 25–60 words. It was written at feature length because the fetch had
already given it real text the audit could not see.

`summarizeMaterials` now takes a `fetchedChars` map and reports both views —
`effective = max(feed, fetched)`, the same choice `assembleWriterPacket` makes,
so the audit agrees with the packet rather than describing one nobody is given.
Run it before the fetch and the columns match; run it after and the gap is the
fetcher's yield. With no map supplied the report says "feed bodies only" instead
of leaving the reader to assume.

The general shape: **a report written for one stage of a pipeline keeps
answering that stage's question after a later stage changes the answer.** The
audit was built to size the fetch and was still sizing the fetch after the fetch
existed.

**Also recorded from run #113, not yet acted on:**

- **Threading produced a second topic-bundle.** T4 "Afghanistan under Taliban"
  gathers five members spanning a country and a five-year period — one of them
  is literally titled "Afghanistan: 5 Years in the Dark". T1 (Iran/Hormuz) and
  T0 (Oregon wildfire) both hold as situations. That is two confirmed misses of
  the same shape — a country or a policy area rather than a concrete situation
  anchored in a place and a time.
- **`raw_items` inserts hit a Postgres index-corruption error.** Collect #50 lost
  two items to `posting list tuple with 21 items cannot be split at offset 129`
  and `... 10 items ... offset 151`. That is a GIN index signature and the
  migrations define no GIN index, so something created one outside them. It is
  silent, per-item, and will recur.
- **Individually-called brief-tier pieces overshoot.** Section sidebars demoted
  to brief tier came in at 48–53 words against a 25–45 target, while batched
  briefs ran 19–51. Same shape as the line problem — a brief's material budget
  supports more sentences than a brief's word target asks for — and worth
  checking against the paper before changing anything.

## 2026-08-19 — A sidebar is never batched; threading states its anchor

Two fixes from reading run #10's paper end to end. One of them was misdiagnosed
in the previous entry.

### The section machinery was silently dropping out for standard-tier threads

`partitionByCallShape` routed `tier === "brief"` into the batched-briefs pool,
and only `buildWriterUserPrompt` renders `sectionInstruction`. A sidebar under a
*standard* lead lands on `brief` by the tier ladder — so it was written as a
standalone brief, with no idea it belonged to a section, no idea what the lead
covered, and a batch prompt telling it the opposite of the truth: "Each item
below is one brief. They are unrelated to each other."

Run #10's T4 sent three sidebars through that path and got three unrelated
briefs filed under a heading, which is precisely the failure sections were built
to prevent. The previous entry attributed all of T4's incoherence to threading.
Part of it was this.

Every sidebar now gets its own call whatever tier it lands on. A standard-tier
thread yields at most `max_sidebars` of them, so the cost is a few calls a paper.

Separately, those four sidebars all wrote 48–53 words against a brief's 25–45,
and read well — a wrong parameter, not a writing failure, because a sidebar
carries one development of a situation the lead has already established and that
is not a brief's job. `packet.tiers.sidebar` gives 45–70 words and the material
for it, selected through the same `budgetTier` override the `line` tier uses.

### Threading now names the anchor

The merge criterion has been "a concrete situation anchored in a place and a
time" since the pass was written, and the prompt has listed topic-bundles as
forbidden the whole time. It produced two anyway: run #8's "immigration
crackdown" at rank 1, and run #113's "Afghanistan under Taliban" — five members
spanning 2021 to 2026, including a five-year retrospective, a 2022 document
leak's fallout, and an ongoing feature series.

Both slipped past the negative examples because they pattern-match a *positive*
one: "one war, or one front of one war". A country under a regime looks like a
front.

What separates them is **time**, and the prompt never asked for it. Every thread
that held — Iran/Hormuz, Oregon's fire season, Ukraine, Gaza — gathers
developments from the same news cycle. Both failures gather coverage of a
condition that has persisted for years.

So the output is now `title;;anchor;;summary;;refs`, where the anchor is the
development the situation turns on and roughly when. Writing it before listing
refs forces the criterion to be applied rather than recognised, and storing it
(migration 037) makes a bad thread legible afterwards: "the Taliban's rule since
2021" is visibly not an anchor, where a front-page title conceals the same
defect. Both real failures are in the prompt now as worked negative examples with
their reasons — the junk-filter convention, rules from audit logs rather than
speculation.

**Deliberately not validated in software.** There is no reliable signal — Ukraine
and Gaza are countries too — and a heuristic here would cost real threads. The
anchor exists to force the judgment and expose it, not to be parsed. The parser
takes its columns from the first, second and last delimiter, so a stray `;;` in
the summary shifts nothing and a pre-anchor three-field line still forms a
thread, losing the summary rather than the thread.

### Also from the same read

The headline-only word cap worked: 29 of 150 pieces had headline-only material,
they came in at 19–49 words instead of 120–200, and **nothing was invented**. But
three of them replaced invention with commentary on the material — "No further
details were available from the publication's feed" — which is the pipeline's
plumbing showing through into the paper. That is a voice rule now.

The root cause underneath those 29 is upstream of the writers: five of them
attribute to Willamette Week, which like AP and Reuters reaches us through a
Google News RSS proxy whose article URLs are interstitials. Twenty-one were
fetched in run #113 and all twenty-one extracted zero characters.
`raw_items.raw_entry` stores the full feed entry "for future extraction"; whether
it carries the publisher URL is the next thing to probe.

## 2026-08-19 — Slots are assigned by material, and notes direct rather than describe

Run #13 re-threaded and re-wrote editor #113's material on the new code. Both
changes from the previous entry worked:

- **Threading.** Seven threads, `failed_calls=0`, and every anchor names an
  actual development with a time — "record-breaking Oregon wildfire season,
  summer 2026", "Trump's suspension of Iran negotiations and territorial claim
  over Strait of Hormuz, this week". **The Afghanistan bundle did not re-form**
  and nothing Afghanistan-shaped replaced it. Six of run #10's eight threads
  survived; the elections thread dissolved and a two-member Providence
  Medicare-Advantage thread formed, which is a concrete same-week situation.
- **Sidebars.** No sidebar was batched. Lines came in at 18–20 words, all one
  sentence.

Two things the run exposed instead.

### A slot the material cannot fill is worse than no slot

The Gaza section led with C80 — 47 words, headline-only — while C19, 180 words
and fully sourced, ran underneath it as a sidebar. Both pieces are well written;
the 47-word one is a perfectly good short piece. The section is still wrong,
because the lead establishes the situation the rest hangs off and a headline
cannot do that.

Slot assignment was pure score order, and score is deliberately blind to
material — pass-1 scores relevance before the fetch has even run. So the two now
compose: score still decides the thread's rank and the reading order, and
material decides which member can hold which slot.

- **A headline-only member cannot lead.** The highest scorer with real material
  leads instead. When no member has any, score order stands and the section is
  thin in the way its material is thin — nothing here invents a lead.
- **A headline-only member gets a line, not a sidebar.** A line is a pointer and
  a headline is enough for one. A sidebar is a paragraph, and an empty
  paragraph-shaped slot is an invitation to fill it: run #13 filled two with
  prose about the sources and one — T4's `S53744` — with an asserted development
  the packet did not contain ("Willamette Week reports additional bad news …
  The outlet did not specify the new development in its public feed").

Measuring material means building a member's packet before its role is known, so
the pass builds provisionally, assigns roles, then builds finals. All pure, no
I/O, three cheap builds per member.

### The note was the leak

The voice rule from the previous entry cut source-meta prose sharply but six
pieces still carried it. The cause was not the memo failing to land — it was the
packet note contradicting it.

The notes opened `Material is headline-level only` and `some sources gave only a
summary`. The memo says never write about the sourcing and lives in the **system**
prompt; the note lives in the **user** prompt, attached to this specific piece,
and hands over the exact vocabulary. The nearer, more specific instruction won.

Notes are now directions and never a description of the packet: "Write only what
the sources below actually state … make no remark about how much they say." The
unresolved-sources note lost its internal vocabulary the same way — it used to
explain what the editor had counted and the resolver had missed.

This is the third instance of one pattern, and it is worth naming plainly:
**a general rule in the system prompt loses to a specific statement in the user
prompt.** Same lesson as `headline_only_words` (a note saying "write short" lost
to a 120–200 word target) and the `line` tier (a 15–30 target lost to a brief's
material). Fix the nearer thing.

### Still open

- **36 of 150 pieces are headline-only**, up from 29. The root cause is
  unchanged and upstream: AP Top News (25 articles, median 103 chars), Willamette
  Week (7, median 94) and others reach us as Google News interstitials, and all
  22 news.google.com URLs in fetch scope extract zero characters.
- **`C86` ran as a 45-word feature at rank 15.** The editor assigns tiers before
  the fetch exists, so it cannot know a story has no material. Not obviously
  worth fixing — the piece is accurate and short — but it is where thin material
  is most visible.
- **The `posting list tuple` errors are still unexplained.** Gizmo reports only
  btree indexes on `raw_items` and `preprocessed_items`; that error is a GIN
  signature, so the index involved has not been found yet. No REINDEX was run.

## 2026-08-19 — The prompt never describes its own plumbing

Run #15 was a controlled A/B against run #13: same editor run #114, same pile,
same threads, same `article_texts` (450 rows before and after), writers stage
only. Both changes did what they were built to do.

**Slot assignment by material worked.** Section pieces stayed at 26 while
sidebars went 14 → 9 and lines 5 → 10 — five slots moved, no member dropped.
Gaza's C19 leads now; Providence's `S53744` and Oregon's `S53742` / `S54035` are
lines. Feature leads went from 47–556 words to 485–538: the 47-word lead was the
headline-only member that can no longer take the slot.

One deviation from my prediction, and the implementation was right and the
prediction wrong. I expected Gaza's C80 to become a line too. It stayed a sidebar
because its packet is *partial*, not headline-only — it has real material, and
150 words is what that material supports. The rule is about material, not about
having been outranked.

**The six source-meta phrases are gone.** Three new ones took their place.

### The third layer was the one that mattered

`formatArticle` labelled every source in every packet:

    --- SOURCE 2: The American Prospect | 2026-08-18T14:22Z [feed summary only; truncated at 1200 of 4800 chars]

Run #15's `S54321` wrote "though the source material was truncated before
detailing the specific benefits added". Gizmo checked the persisted body, found
the details present, and called the sentence false. It is false about the
article and *true about the packet*: the budget trimmed the text, and this label
said so with numbers, inches from the text itself. The writer was not
hallucinating. It was reporting what we told it.

So three layers said the same thing at three distances — the standing memo in the
system prompt, the packet note in the user prompt, the per-source label inline
with the material — and each time I fixed the outer one, the inner one won. That
is now four instances of one pattern (`headline_only_words`, the `line` tier, the
packet note, this), and the general form is worth stating plainly:

**A model relays what the prompt tells it about itself. The fix is never a rule
telling it not to; the fix is not telling it.**

Neither dropped flag was actionable. A writer cannot do anything differently
knowing text was trimmed — trimming lands on a paragraph boundary and reads
complete — and "this came from a feed rather than a fetch" has no bearing on how
to write a sentence. The untranslated flag stays, because whether the writer can
read the text at all is a real decision. `(no body text available for this
source)` went too: it is the same leak in miniature, and a headline with nothing
under it says the same thing without handing over the words.

Origin, truncation, dedup and furniture counts now print in
`inspect packet --rank`, following the precedent already set there for omitted
sources — the prompt withholds what the writer must not use, the audit shows
everything.

### Judged and left alone

`"La Nación did not specify its location beyond naming Deir Ezzor as one of the
two sites inspected"` was flagged as a possible fourth leak. It is not the same
thing: it reports the limit of what is publicly known about a fact, which is
ordinary journalism, and papers write that sentence every day. The rule is about
the paper's own machinery — feeds, fetches, budgets, extraction — not about
attributing a gap in the public record. Tightening it to catch this would cost
real reporting.

`C86` still runs as a 45-word feature at rank 15. The editor assigns tiers before
the fetch exists, so it cannot know a story has no material; fixing it means
moving the fetch above the editor, which is a larger change than the defect.

### Not yet explained

The widened index query returned **zero GIN and zero GiST indexes** in the
database; extensions are `amcheck`, `plpgsql`, `vector 0.8.2`. So the
`posting list tuple with N items cannot be split at offset M` errors from collect
#50 do not come from where that message normally comes from, and my GIN
hypothesis was wrong. Two items are still being lost per run without explanation.

## 2026-08-19 — The per-article cap was a ceiling, and it was cutting the answer

Run #17 was the third writer-only A/B on editor #114. The plumbing leak is
gone: `inspect packet --rank 32` shows source blocks with no `[feed summary
only]` or `[truncated at …]`, the `MATERIAL` audit block carries them instead,
and all three surviving sentences from run #15 are absent. Slots came back
identical to run #15 — 7 leads, 9 sidebars, 10 lines — so nothing regressed.
Lines 16–28 words, brief sidebar 48, no feature over 600.

One sentence survived in spirit:

> "The American Prospect reports the expansion is broad but does not specify
> which benefits beyond the 1999 categories are now included."

Gizmo called it an inference from omitted packet material, which is right, and
the packet dump shows why it happened. That story is **one source, 9,892
characters, standard tier**. Its packet held 2,573 — cut by
`per_article_chars: 3000` on a `total_chars: 12000` budget, using a fifth of
what was authorised with nothing else competing for it. The visible text runs
1882 → 1999 → 2019 → Biden and stops at a paragraph boundary before the section
describing the new rule. The writer read that and said so. It was **true of the
material it was handed and false of the article**, and this time nothing in the
prompt told it — it simply noticed.

So the fix is not a fifth prompt rule. `allocateBudget` gains a third pass:
floor everyone, distribute the remainder capped per article, then hand what is
still unspent to the articles still truncated. The cap keeps doing its real job
— stopping one long source eating a packet several outlets should share — and
stops acting as an absolute ceiling on packets that have nobody to be fair to.

Roughly 17% of articles reach the 5,000+ bucket, so this changes the packets
built from the best-sourced material and leaves the thin ones alone.

**The pattern across the last four entries, now complete.** Each fix removed a
place where the prompt described its own state, and each time the model's
remaining commentary moved one layer inward: system memo → user-prompt note →
per-source label → *the shape of the text itself*. The last one cannot be fixed
by withholding information, because the model is reading the material directly.
It can only be fixed by not truncating in the middle of the answer.

### The index is genuinely corrupt

`bt_index_check` results:

- `preprocessed_items_source_name_idx` — clean.
- `raw_items_source_name_idx` — **FAILED**: `item order invariant violated …
  page lsn=0/BA428F00`.

So the `posting list tuple with N items cannot be split at offset M` errors from
collect #50 are real btree corruption, on the index Gizmo named in the first
place. My GIN hypothesis was wrong and my correction sent him to a dead end;
PostgreSQL 13's btree deduplication stores repeated keys as posting list tuples,
and `source_name` — 111 distinct values across hundreds of thousands of rows —
is where deduplication does the most work.

Not yet repaired: the pre-authorisation named `preprocessed_items_source_name_idx`,
which is the clean one, and Gizmo correctly declined to touch an index the
instruction had not named. `REINDEX INDEX CONCURRENTLY raw_items_source_name_idx`
is the repair.

`amcheck` predates this project on that database.

### Watch

First-pass writer failures are trending up across identical runs: 1 (#13), 3
(#15), 10 (#17). Run #17's ten were all briefs missing from batch output,
recovered by one repair pass. Same editor run and same packets each time, so this
is provider-side variance rather than anything in the paper — but the batch path
is where it lands, and `brief_batch_size: 10` means one bad batch costs ten
pieces.

## 2026-08-19 — Source material is not rationed

Reverses part of the original writers design. `max_articles` and `total_chars`
are now `null` on every tier: if an item survived collection, prefiltering,
grouping and the editor, and it is not a verbatim duplicate, the writer sees it.

**The principle, in John's words:** if it is news and not a duplicate then it
should inform the story, and the writer is the one to judge whether a detail
belongs. It reads multiple sources and decides what the story is — that is the
job. When a piece comes out too long the fix is guidance on how to editorialize,
never less to read.

### Why the caps were wrong

They were justified as redundancy control, and redundancy already had two
mechanisms: `selectArticles` reads one article per parent outlet before a second
from the same one, and `dedupeParagraphs` drops what another source in the packet
already said verbatim. `max_articles` was a third mechanism for a solved problem
— and unlike the other two it discarded **whole sources** rather than repeated
text. Run #114's Iran thread carried 17 articles and the writer saw 12.

The cost argument was also weaker than it was presented. Run #17 spent 376,425
input tokens across 84 longform calls, ~4,480 each, of which roughly 3,300 is
fixed scaffolding — the standing memo alone is 10,258 characters. **The memo
costs about three times what the source material does.** The whole post-fetch
corpus is ~1,002,000 characters. Economising on sources was economising on the
cheap half.

And the caps were actively producing errors. Run #17's rank 32 was one source of
9,892 characters cut to 2,573, and the piece told the reader the article "does
not specify which benefits … are now included" — true of the text it held, false
of the article, because the part naming them was in the 74% the cap removed.

### What stays

`per_article_chars` and `floor_chars` remain in config and are inert while
`total_chars` is null. They exist for the day a page would blow a context window:
if a cap must be set, the squeeze should spread across outlets rather than let
two long sources take everything. Setting either is an editorial decision that
discards reporting, not a tuning knob.

Word targets stay. A brief is short because the *piece* is short, and
`headline_only_words` still caps the target when the material genuinely is a
headline. The short tiers (`line`, `sidebar`) now exist only to set targets.

### A conclusion that was never really established

Run #8's lines came back at 40–47 words against a 15–30 target, and the fix
recorded here was cutting a line's material to one source and 900 characters.
That same run also split section lines out of the brief batch into a call framed
for the line register. Two changes, one measurement — and the material cut got
the credit. Removing it is now also the experiment: if lines stay at 15–30 words
without it, the register instruction was doing the work all along.

The standing memo gains a section for this, because writers will now routinely be
handed several times more text than the target can hold: *more material than the
piece needs* is deliberate, is not a signal to write longer, and material you did
not need is not material wasted.

## 2026-08-19 — Unrationed: what it cost, and what it settled

Run #19 wrote editor #114 with `max_articles` and `total_chars` null. The
measurements, all against run #17 on identical material:

- **Packets: 3,182,655 characters** across 150 stories — feature 555,679,
  standard 1,451,416, brief 1,175,560. Largest single packet 65,105 (C15).
  Nothing pathological. The briefs collectively carry twice what the features do,
  because there are 75 of them.
- **Cost: +22.4% input tokens** (421,365 → 515,829), +30.9% output. That is the
  whole price of handing writers everything. It confirms the earlier arithmetic:
  the standing memo and bio dominate a writer call, so rationing sources was
  economising on the cheap half.
- **Transport clean.** 0 failed calls, no abort, one unparseable piece recovered
  by one repair. Bigger prompts did not move the failure rate — first-pass losses
  went 1 → 3 → 10 → 1 across four identical runs, which settles that as noise.
- **T2 (Iran) now carries all 17 of its articles**, 16 in the packet and one
  dropped as a duplicate. Run #17 showed the writer 12.
- **Rank 32 got its full 9,892 characters** and came back a 190-word piece
  carrying the projected disenrollment, the KFF estimates and the affected
  countries. The "does not specify which benefits" sentence is gone, because the
  part specifying them is now in the packet.

### The line question is settled, and my earlier conclusion was wrong

Lines came in at **16–29 words** with their members' full material — against
16–28 in run #17, when they were capped at one source and 900 characters. Run #8
changed the material budget *and* split lines into a call framed for the line
register, in the same run, and the previous entry credited the material cut. It
was the register instruction. The cap was doing nothing and cost the writer its
judgment for four runs.

### One regression, and it is a spine problem wearing a length problem's clothes

C15 (Meta) came in at **668 words against a 600 ceiling** — the only feature over,
with leads at 463–511. Gizmo found no unsupported claim in it; the material
genuinely supports every sentence.

But look at what it covers: the four states, the platform-design allegations, the
age and data claims, internal documents, Meta's denial, prior state cases, the
Section 230 posture, the damages framing, and the expected appeals. **Nine
subjects in 668 words** — 74 words each, none developed. That is the roundup
shape the memo has always forbidden, and the length is the symptom.

So the fix is guidance, as promised, and specifically guidance that is *operable*.
"Cut what the headline does not promise" is easy to agree with and hard to apply
against twelve sources each carrying something real. The memo now gives two
concrete tests: finish "this piece is about ___ and it lands on ___" before
writing, and after writing, remove any paragraph and check whether the piece
still answers its own headline. And it names the count of subjects, not the word
count, as the thing to watch.

### The absence rule needed a sharper line

Two source-meta sentences survived, both of the same shape:

- "though Le Monde does not explain the terms under which it is allowed to
  function"
- "The Willamette Week report does not provide further details of the union's
  account"

These are not the earlier plumbing leak — nothing about feeds or truncation — so
the previous rule did not catch them. The distinction that does:

**Who withheld it decides whether it is news.** "The interior ministry did not
say how many people were detained" is an actor withholding, and is often the most
telling line in a piece. "Willamette Week does not provide further details" is an
outlet's article being short, which is the paper explaining why its own piece is
short. Name the actor; never the outlet.

This also corrects a call I made last round: I told Gizmo that "La Nación did not
specify its location" was acceptable. Under this rule it is not, and it should
not have been waved through.

### Index

`REINDEX INDEX CONCURRENTLY raw_items_source_name_idx` completed and
`bt_index_check` now passes on both indexes. The `posting list tuple` errors that
cost collect #50 two items should not recur.

## 2026-08-19 — Run #20: a good piece, a wrong gate, and a real defect underneath

The fresh pipeline (collect #51 → editor #115) ran clean: no index errors after
the reindex, `attach_failed_calls=0`, `split_failed_calls=0`, thread #12 formed
11 threads with `failed_calls=0`, 3,315,290 characters of packets with a 56,182
largest. Gizmo then stopped after the one-piece writer smoke test, judging the
feature a roundup covering five developments, and withheld the 150-piece run.

**The piece is good, and the gate was wrong.** Its five "developments" are not
five subjects — they are a spine with evidence hung off it. A new defence
minister promises to escalate deep strikes; the piece explains the upheaval that
produced him, then turns to whether the strategy is working, on an explicit hinge
— *"The strikes Khmara promises to intensify are already measurable inside
Russia"* — and gives 15% lower oil exports, Moscow fuel rationing, 194 refinery
strikes against 18 a year earlier, and Putin's response. That is an article.

The gate misfired because of how I wrote the prompt. Run #19's Meta feature
covered nine subjects at 74 words each with nothing connecting them, and I asked
Gizmo to "list the distinct subjects" as the diagnosis. He applied the count as a
threshold. **The Meta piece's defect was never the number — it was nine subjects
with no relation between them.** Five subjects joined by an argument is what a
feature is supposed to look like.

### But there is a real defect, and neither of us named it first

Two of the lead's paragraphs — Fedorov's dismissal and wartime-election demand,
and Mudra's corruption resignation — belong to `C22` and `C21`, which are **their
own members of T1, running as lines below the lead.** The reader would get the
lead covering both at length, then two one-sentence lines repeating them.

Two causes, both fixed:

**The lead was only ever told about the sidebars.** `siblingTitles` for a lead
was `sidebarTitles`, which did not matter when a thread had three or four members
and matters enormously at eleven: T1 has one sidebar-eligible trio and six lines,
so six members were invisible to the piece most likely to write them up. Every
piece now gets the full list — the lead sees everything below it, and a sidebar
or line sees the lead plus the others, minus itself.

**`isLiveBlog` missed its own canonical case.** The lead's single source was Le
Monde's *"EN DIRECT, guerre en Ukraine : …"* — a comma after "EN DIRECT", where
the pattern required a colon or dash. So 45,000 characters of live blog covering
the entire war became a section lead's whole material. The detector now accepts
any separator.

That second one also punctures a claim in the section design: "material
partitions by member, so two pieces cannot overlap." That holds for *sources*,
not for *content* — a live blog assigned to one member contains every other
member's events. Detection is the mitigation; the sibling list is the guarantee.

### On stopping

Withholding the run was the right instinct on a wrong judgment, and it cost one
provider call to find a real bug. Worth keeping the smoke gate; worth being
clearer that the smoke test's job is to catch structural failures, and that a
disagreement about editorial quality should be reported and escalated rather than
used to halt.

## 2026-08-20 — Sections work on dimensions, not items

Run #22 rewrote editor #115 with every section piece told what the others cover.
The paper came out 150/150 after one repair, lines all 15–28 words and one
sentence each, no absence-based source claims. Then Gizmo read all eleven
sections against a hypothesis I had formed from three of them, and broke it.

**My hypothesis:** a section works when its lead sits one level above its
members, and fails when the lead is itself one of the members. It explained T1
(low-altitude lead reaching sideways into two siblings), T0 and T3.

**It has four counter-examples.** T2's lead is a statewide cost figure and the
section works on a specific flare-up. T5's is a single rainfall warning and works.
T9's is a Canadian aid announcement and works. T7's is one candidate's removal and
works. Altitude describes the good cases without predicting them.

**The better predictor, and it is Gizmo's:** a member belongs when it answers
*"what does this change about the situation the lead established?"* — as a
consequence, a mechanism, a scale, a human cost, or another instance of the same
emergency. That is a **dimension**. A member that says "another thing happened in
the same war" is an **item**, and a section built from items is a list.

- T0: blockade → the diesel margin it drove to a record, the carriers straining
  to hold it open. Dimensions.
- T3: Pacific drawdown → the exercise it cancelled, the summit it enabled.
- T10: outbreak's case count → its strain has no approved treatment. The second
  answers the question the first raises.
- T1: a defence minister's appointment, a prisoner exchange, a drone strike on a
  police station, a family's story from the occupied east. Items.

**Member count predicts nothing.** T0 works with nine, T1 fails with eleven; T3
works with four, T8 fails with three.

So the answer to "one article or a section?" is neither — **it is a threading
question, and the section design stays as it is.** The thread prompt now carries
both tests explicitly, with T1 named as the real thread that passed the first and
failed the second.

### What this reframes

Three of the four failures are not the writers' fault and two are not threading's:

- **T6** ran two sidebars that near-duplicate each other — "Treasury doubles debt
  buyback" and "Bond market pressure prompts policy action" are one story that
  grouping did not cluster.
- **C32** ran 250 words as a sidebar because its *cluster* holds four separate
  accountability cases — Hind Rajab, the paramedics, World Central Kitchen, two
  MSF cases. Selection, not sourcing; and the selection was made by grouping.
- **T4**'s second member is a procedural footnote about a comment deadline
  already in the lead.

That is three defects tracing to grouping being loose, surfacing at the writers
because that is where they become visible. Worth a look at
`grouping.embedding.similarity_threshold` on the next full run, but not worth
tuning blind from one day's output.

### Also

`S55939`'s "The article reports that hairdressers, mechanics…" is a phrasing
defect only — Gizmo confirmed the Le Monde source states it directly. It is the
article-as-subject shape the memo already forbids, so it joins the named
examples with its corrected form.

## 2026-08-20 — The floor was the last thing asking for it

Run #24 (fresh pipeline, collect #52 → editor #116 → writer #24) produced five
pieces ending in some form of "No further details were available from the
source". Every one is headline-only.

This is the fifth appearance of one defect and the fourth attempted fix. The
standing memo forbids writing about the sourcing; the packet note was rewritten
to direct rather than describe; `formatArticle` stopped labelling every source
with its origin and truncation. All three held — the sweep found no "the feed",
no "truncated", no "paywall". What was left was a **number**.

`headline_only_words` is `[25, 60]`, rendered as a range. A range has a floor,
and a floor is an instruction to keep writing. A piece whose material supports
fifteen words was being asked for twenty-five, and it met the number the only way
available to it: by describing the gap.

A headline-only packet is now told "up to 60 words, and fewer is correct — stop
when the sources do". No minimum. Pieces with real material keep their range,
where the floor does useful work and a 40-word feature is a different failure.

Same lesson as `headline_only_words` itself, the `line` tier, the packet note and
the source labels: **when an instruction contradicts a parameter, the parameter
wins.** Four of the five instances of this defect were caused by a number.

### Threading: the relation test worked

Seven threads, down from run #12's eleven, and 19 section pieces down from 42 —
the expected direction, and not an over-correction. Gizmo flagged one survivor:
T5 pairs a Russian strike on Kyiv with Ukrainian drones hitting Tatarstan. That
is the weakest of the seven, though "exchange strikes" is arguably a real
relation — one is an answer to the other.

### Grouping: over-merging is the more common failure, and the split pass cannot see it

Gizmo's count, which is what the audit was for:

**Clear over-merges (4):** `C5` Florida *and* Alaska primary results; `C9` gold
mine collapses in the Central African Republic *and* Colombia; `C19` a graft
probe plus a separate election demand; `C30` a membership surge plus separate
Irkutsk and Tyumen disputes.

**Plausible under-merges (2):** `C0`/`C48` (debt milestone, Treasury
intervention); `C31`/`C55` (one Walmart earnings cycle split in two).

**The split pass is structurally blind to this class.** It exists to repair
*chaining* — union-find joining A~B~C where A and C are unrelated — so it
suspects components that are large (`min_size: 3`) and **loosely** connected
(`cohesion < 0.55`). Two gold-mine collapses on different continents are
*tightly* connected in embedding space, because they are the same kind of event
described in the same words. High cohesion, never suspected, never examined.

Raising `similarity_threshold` would attack the over-merges and worsen the
under-merges. It is not the lever.

**But the describe pass already produces the evidence.** Its own title for `C9`
is "Gold mine collapses kill dozens in Central African Republic **and** Colombia"
— the model wrote the defect into its label, exactly as a bad thread anchor does,
and nothing reads it. Describe runs on every multi-item cluster in one batched
call and is the only pass that reads a whole cluster's material with a question
in mind. Not yet acted on; proposed rather than shipped, because clustering is
the pipeline's primary lever and the dissolve-versus-re-split choice is a real
design decision.

## 2026-08-20 — Describe asks whether the cluster is one story

Run #50's grouping produced four clear over-merges, and they share a shape the
split pass cannot see:

- `C9` — gold mine collapses in the Central African Republic **and** Colombia
- `C5` — Florida **and** Alaska primary results
- `C19` — a graft probe plus a separate election demand
- `C30` — a membership surge plus separate Irkutsk and Tyumen disputes

Step 2b's split exists to repair **chaining**: union-find joins A~B~C when A and
C are unrelated, so it suspects components that are large (`min_size: 3`) and
**loosely** connected (`cohesion < 0.55`). Two mine collapses on different
continents are the opposite — *tightly* connected, because they are the same kind
of event described in the same words. High cohesion, never suspected, never
examined. No value of `density_floor` reaches them.

`similarity_threshold` is not the lever either. Gizmo's audit found two
under-merges alongside the four over-merges (`C0`/`C48`, `C31`/`C55`), so raising
it fixes one class and worsens the other.

**But the describe pass already produced the evidence.** Its own title for `C9`
named both countries. Describe reads every multi-item cluster's full material in
one batched call, and it is the only pass positioned to answer the question — it
just was not being asked. Same shape as the thread anchor: the model writes the
defect into its own output and nothing reads it.

So describe now emits `index;;verdict;;title;;summary`, and clusters it calls
`MULTI` go through the split prompt again at a new step 4b. The freed members
rejoin the singleton pool and the re-partitioned pieces are described a second
time, since a label is stale the moment the cluster under it changes.

**Re-partition, not dissolve.** John's call, and the right one: a flagged cluster
of ten may hold two real groups of five, and breaking it into ten singletons
would throw away the corroboration grouping exists to find. The split prompt is
already built for exactly this partition, and it needs only member titles — the
cohesion machinery it normally sits behind is *suspect selection*, which describe
now does instead.

Contracts kept from the rest of the stage: a failed re-split call leaves the
cluster intact and increments `resplit_failed_calls`; every call goes through
`callWithBackoff`; counters persist to `grouping_runs` (migration 038) so a run
can be judged from the database. An unrecognisable verdict is read as `ONE`,
because a wrongly split cluster loses corroboration while a wrongly merged one
publishes two stories under one headline — only the first failure is caused by
guessing here.

### The relation test held on fresh material

Run #52's seven threads, read against the criterion:

- **T1** (child immigration detention) is the best thread the pass has produced:
  a judge's order, the collapse of the protection system that prompted it, and
  the scrapped effort to recruit lawyers for migrant children. Three members,
  each a mechanism of the others.
- **T0, T2, T3, T6** hold. T3's members are diplomatic, military and human-cost
  dimensions of one week's Gaza strikes.
- **T4** is marginal: its anchor is "Record-setting 2026 wildfire season", which
  is a season rather than a dated development — the weak anchor shape.
- **T5** is the one failure, and it is legible in its own anchor: "Russian
  missile barrage on Kyiv **and** Ukrainian drone strike on Tatarstan". An anchor
  needing "and" to join two events is a self-declared two-situation thread. That
  is the third appearance of this shape, after run #113's T4 and run #22's T1.

**T5 is not a failure — John's call, and it corrects both of us.** Gizmo flagged
it and I agreed; the reader who wants this paper does not. It is the
Russia–Ukraine war, two members, a barrage and the drone strike answering it, and
he wants that as its own section. The lesson is not "same war is fine" either:
run #22's T1 was also one war and he preferred it as a single article. The
difference is size and shape — two reciprocal strikes cohere, eleven assorted war
items do not.

So the anchor rule I was about to add — an anchor needing "and" means two threads
— **does not get written.** It would have cut this thread. Three appearances of
the shape turned out to be two failures and one thread the reader wants. The
anchor stays what it was built to be: a column that makes a thread legible to a
human, not a test a machine applies.

### Fixed on the way out

`resplitFlaggedClusters` returned no way to tell a freshly re-partitioned cluster
from an already-described one, and the first attempt filtered on `notes === null`
— which is true of *every* cluster in this stage, since `buildAutoCluster` sets
it null and describe never touches it. That would have re-described the entire
run after any re-split instead of the handful of new pieces. The pass now returns
the member-id keys of the clusters it created and only those are relabelled.

## 2026-08-20 — Run #51: the re-split ran, and mostly did nothing

The pass executed cleanly — `describe_flagged=34`, `resplit_calls=34`,
`resplit_failed_calls=0`, digest accounting balanced at 671 clustered + 740
singleton = 1,411 items with no duplicate member ids. And it changed **six**
clusters out of thirty-four.

The six it did change were right: the FDA-nomination / $40-trillion-debt cluster
of 34 articles split cleanly in two; the Central African Republic and Colombian
mine collapses separated; a 39-article Korea cluster became eight coherent
groups. That is the class the pass was built for, and on those it works.

**The other 28 were my bug.** `applyResplitPartitions` bailed out on
`partition.length <= 1`, treating a single-group response as "leave it alone".
But a single group is not a no-op — it says *those* members are the event and the
rest are not. Case 2 of the audit is the clearest: eight members covering the USS
Lincoln's deployment plus a South China Sea breakdown plus energy markets plus
farm tariffs, and the model answered `1,2,3`. The correct action is to keep three
and free five. Mine kept all eight and freed nobody.

`splitLowDensityComponents` has always applied a partition whenever the call
succeeded, freeing every unplaced member — I wrote the new pass without matching
the tested one. The application logic is now extracted as
`applyResplitPartitions`, pure and exported, with six tests including the
single-group case, `none` (which dissolves), and a failed call (which does not).

### The run's numbers are not comparable, and that is separate

`cross_run_dedup_skipped=true` on preprocessor #45, with 0 cross-run drops and
2,444 items kept from 2,496 considered. Previous runs dropped 1,100–1,600
cross-run. Collector #53 inserted 301 new items, so the other ~2,100 were
already-processed items from earlier days re-entering the pipeline.

That is why grouping #51 shows 197 clusters and 1,411 kept-news against run #50's
68 and 560, and why the digest carries Peru earthquake coverage and Florida
primary roundups. **Run #51 is a valid test of whether the code executes and a
poor test of whether grouping improved**, because the input is two-and-a-half
days of news at once. The over-merges Gizmo found (`C5` Alaska runoff candidates,
`C9` mine collapses) are real, but their frequency cannot be compared to run #50.

### Two audit findings that are not defects

**Sixteen "sidebar length outliers" are an artifact of the audit, not the paper.**
Gizmo checked every section sidebar against 45–70 words. That band belongs to the
`sidebar` *budget tier*, which applies only when a sidebar lands on `brief` — a
sidebar under a feature-tier lead is standard-tier and gets 120–200. All sixteen
are standard-tier, and fifteen of them are inside 120–200. Only `S59541` at 107
is genuinely short.

**Thirteen standalone briefs at 47–72 words against 25–45 are real**, and are the
predicted cost of unrationing: a brief with five sources and 20,000 characters
writes 52 words instead of 35. Roughly 30% of briefs, overshooting by ~15%. The
memo's "more material than the piece needs" section exists for exactly this and
is not landing on the batched path. Not yet acted on — the fix is guidance, per
the standing principle, and one polluted run is thin evidence for rewording it.

### Source-meta down from five to two

The floor fix worked. `S57832` still says "No further details were available from
the source" at 27 words, and `S57492` says "a separate question the sources do
not address" — a 143-word piece flagging the limit of its own analysis, which is
a different shape from the headline-only padding and may want its own rule.

---

## 2026-08-24 — A slot the material cannot fill is worse than no slot

Run #42 (editor #120) is the first paper audited end to end before building the
publisher. It passed every integrity check — 150/150 pieces persisted, ranks
contiguous, zero failed calls — and the review that came back listed length
outliers, a smoke-gate miss and a recovered token-budget error. None of those is
the thing wrong with the paper.

**37 of the 150 published pieces were written on headline-only material.** A
quarter of the paper, and not distributed like noise:

| tier | headline-only | of |
|---|---|---|
| feature | 3 | 15 |
| standard | 11 | 60 |
| brief | 23 | 75 |

Ranks 7, 9 and 14 — three of the fifteen front-page slots — were 46-, 50- and
56-word stubs. Rank 18 was twenty-four words: "The Cicero Institute, founded by
venture capitalist Joe Lonsdale, led Republican efforts to clear homeless people
from the streets, the New York Times reports." Rank 7 (S61342) wrote one
sentence and then, below a horizontal rule, a note to whoever was reading it:
"That's all the source carries. The headline promises dismantling a third of the
system, but the article body does not state that."

### These are not writing failures

Every one of them is a writer doing what a headline-only packet tells it to —
write what you have, go no further, and a ceiling with no floor so nothing pushes
it to pad. That machinery works. What it cannot do is decline the slot. A
four-hundred-word feature position handed 400 characters of teaser produces
either invention or an apology, and the accumulated fixes in this stage have
successfully steered it away from invention.

The audit's own source-boundary list makes the point: four candidate sentences,
and the two that are genuine defects (S61342, S61332) are both headline-only
pieces in slots too large for them. The other two are actors declining to
comment, which is reporting. Fix the slot and the language problem goes with it.

### The pipeline already knew

Nothing about this was discovered at write time. The fetch cooldown had given up
on `oregonlive.com` and `nytimes.com` before the run started — S61342 and S61618
are those two hosts. S61332 is a Google News item, and `sources.yaml` has said in
its own notes since the AP feed was added that those links are interstitials with
no article behind them.

Note which hosts those are. `opb.org` and `oregonlive.com` are both in the
cooldown list, and they are the Oregon local beat — the beat the bio weights
hardest and which therefore scores highest in grouping-pass-1. **The front page
is systematically starved on precisely its highest-relevance subject**, and will
be every day until those hosts stop serving a device check.

### The editor cannot see this and should not have to

`combined = relevance + source_weight·ln(sources)`, then tiers by rank position
from fixed counts. Both inputs are upstream judgments about what the reader
should care about; neither is about whether text exists. Teaching the editor
about fetchability would be teaching a ranking formula about HTTP.

`applyPaperBudget` could not catch it either — it drops from the bottom of the
rank order and never looks at a packet's contents.

### The fix is the section rule, one level up

`assembleSectionPackets` has assigned a thread's lead by material rather than by
score since run #13, when the Gaza section led with a 47-word stub while a
180-word fully-sourced piece ran beneath it as a sidebar. The reasoning
generalizes exactly: the unit is the paper's tiers instead of a section's roles.

`resolveTiersByMaterial` runs between assembly and rendering. A story whose
packet comes out headline-only *at the tier it holds* trades tiers with the
nearest-ranked story below it that can fill the slot. Config is
`writers.packet.tiers_requiring_material: [feature, standard]`; `brief` is
deliberately absent, because a brief is a pointer and a headline is enough for
one. An empty list disables the rule.

Three properties, each deliberate:

**Material level is read at the tier being asked about, not the tier assigned.**
`materialLevelOf` already reads each tier's own thresholds, so 1,500 characters
is headline-only for a feature and partial for a standard. That is what makes a
demotion mean something rather than relabel a stub: the demoted piece gets a real
word band it can actually fill.

**It swaps rather than demotes.** The paper keeps fifteen features on a day the
local outlets block us, instead of shrinking to twelve. This also fixes the
other half of the problem — run #42's ranks 16 and 17 were fully-sourced 208- and
213-word standards that would have made real features, sitting one place below
the line while three stubs held feature slots.

**Ranks and scores are never touched**, matching the section rule's promise. Only
the treatment moves. A story can therefore sit high in the ranking and run short,
which is the honest outcome when a story matters and the text is not there.

The pass is top-down, so a story demoted out of feature is reconsidered for the
standard slot it lands in and demoted again if it cannot fill that either.
Each swap moves the failing story strictly downwards, so it terminates. When
nothing below has material either — a day the whole corpus is teasers — the slot
is left alone and the packet's own ceiling still keeps the piece short.

Threads participate, judged on their section lead, since the lead is what
occupies the slot.

### What is not being changed, and why

**The length outliers.** Fourteen pieces outside their band, the worst a
651-word feature against a 600 ceiling and three 46–48-word briefs against 45.
Soft targets missed by under 10%.

**A deterministic minimum word count**, which the review recommended. This is the
one recommendation that would actively regress the stage. A floor is a number, a
number beats an instruction, and floors are what produced run #24's five "No
further details were available from the source" pieces — the lesson recorded
under "The floor was the last thing asking for it" four days ago. `targetPhrase`
renders a ceiling with no floor for anything short of a full packet, on purpose.

**The recovered brief-batch token exhaustion.** One call in eight spent its 8,000
output tokens with an empty body and the retry recovered it. That is
`callWithBackoff` doing the job it was given after run #35, when budget
exhaustion was deliberately placed on the retryable side of the timeout line.
The mechanism worked; there is nothing to fix.

### Instrumentation

`inspect packet --editor-run` now prints headline-only counts per tier. Run
#42's audit could not state the finding above because the materials audit counts
thin *articles*, which is a different quantity from a thin *piece* — 254 unique
URLs and 104 thin ones says nothing about how many of the 150 slots that left
empty. A non-zero count in a prominent tier now means the day ran out of material
to trade with, not that a slot was mis-assigned.

---

## 2026-08-25 — A long feed body is not a complete one

Run #43's rank 15, S62865, is 180 words of good reporting that ends:

> "We are not only receiving deportees from outside Haiti due to the political
> crisis; we also have people from" — the source cuts off there.

The writer quoted a half-sentence and then told the reader it was a half-
sentence. That is the failure this stage has been closing off for a dozen runs,
and every guard against it was in place and irrelevant, because the guards are
about what the *prompt* says and this was about what the *material* was.

### The chain, and every link is confirmed

`writers.fetch.feed_chars_floor` is 800: only fetch what the feed left short.
La Nación's feed bodies run about 1,800 characters (materials audit for editor
#121: 8 articles, median 1,813, **0 thin**) and they stop mid-clause. So:

- The body cleared the floor, and `planFetch` skipped it as "already 1,813 chars".
- The packet used the feed text — `fetched/feed = 0/1` on its inspect line.
- The writer got a fragment ending inside an open quotation.

Every stage between the feed and the writer measured that body by its length and
found it generous. Prefilter, grouping, scoring and the editor all saw a
well-sourced item; the tier resolver, one day old, correctly called it partial at
standard rather than headline-only at feature, and it was right to — there is
1,800 characters of material there. The material is just not *finished*.

### The rule already existed and was pointed at the wrong truncation

`trimToBoundary` carries this comment: "A writer quoting a half-sentence is a
defect the assembler can prevent for free." It runs only when the tier budget
cut a body, and `total_chars` is null on every tier, so it has been inert since
sources stopped being rationed. The truncation that reached the paper was done by
the publisher, upstream of anything that checked.

So the fix is that rule, applied where the truncation actually happens:

- **`endsMidSentence` overrides the length skip in `planFetch`.** A body that
  stops mid-sentence is not the whole article however long it is, so length no
  longer excuses it from the fetch. This is the cause fix: the point is to get
  the real article, not to tidy the fragment.
- **`stripBoilerplate` trims a dangling tail** back to the last finished
  sentence. This is the net, for when the fetch fails anyway, and it runs on both
  the fetched and feed candidates before the packet compares their lengths — the
  same reason furniture is stripped before either is measured.

Three details, each deliberate:

**An ellipsis is a truncation marker, not an ending.** In a feed body "…" is the
publisher cutting the article. Treating it as terminal is how a teaser passes for
a finished piece, and it is far more common than La Nación's bare break.

**The trim is skipped when it would cost most of the body.** A body whose last
finished sentence sits in its first half is not prose with a broken tail — it is
a caption run, a list, or an extraction with no sentence structure — and cutting
back to that first full stop would throw away nearly everything to fix nothing.
`trimToBoundary` has the identical guard for the identical reason.

**It never empties a body.** When no sentence ever finished there is nothing to
trim back to, and `materialLevelOf` and `isHeadlineEcho` judge the fragment on
its length as before.

### Cost

Roughly 71 of editor #121's 218 in-scope articles were skipped as "already long
enough". However many of those are truncated teasers now become fetch requests.
That is the right place for the pipeline to spend: they are long-teaser stories
that ranked into features and standards, which is exactly the material the paper
is short of.

`truncatedTail` is recorded per article and printed by `inspect packet --rank`,
so the next run can say how often this fires and on which outlets.

### Correction, same day: the check has to run downstream of the strip

The source audit measured what the rule above would actually do, and the first
version of it was wrong in a way one example could not show. `planFetch` tested
the **raw** feed body. A feed whose last line is furniture has no terminal
punctuation at the end of the raw text and is a complete article all the same:

- Ars Technica closes every feed body with "Read full article" / "Comments" —
  **92 of its 92** long bodies in the 14-day window, and the source is already
  100% usable.
- The Guardian's three feeds end on "Continue reading…" — 116 bodies — which
  `boilerplate.ts` has had a rule for since run #17.
- Meduza 172, KTVZ 153, STAT News 47, Agência Pública 40, The Lever 23.

Across twelve outlets that need no fetch at all, that was **611 requests we
would have paid for and thrown away**, against a real population of about 97 per
run. The rule is right and the placement was wrong: completeness is a property
of the article, and the furniture is not part of the article.

So `stripBoilerplate` now reports `endedMidSentence`, computed on the stripped
body before the trim, and `planFetch` reads that. Ars Technica's two footers
became boilerplate rules, cited to this audit.

`endedMidSentence` is deliberately **not** the same flag as `truncatedTail`.
`trimTruncatedTail` declines to cut when the last finished sentence sits in the
first half of the body, but such a body is still incomplete — and that is the
strongest case for going and fetching the real article, not the weakest. One
flag says "this needs fetching", the other says "we cut something".

The general lesson is one this stage keeps relearning at a different layer: a
rule derived from one example is a hypothesis, and the population is what tests
it. La Nación was real — 735 of its 798 long bodies stop without terminal
punctuation — but it was 735 of 1,373, and the other 638 were furniture.

---

## 2026-08-25 — The headline-echo check was defeated by its own upstream rule

`isHeadlineEcho` exists so a source whose body says nothing its headline did not
loses its packet slot. Run #112's rank 3 spent one of its twelve sources on a
Google News stub reading `Poland says it thwarted a Russian plot … apnews.com`,
and the rule was written for exactly that.

The 14-day source audit measured how often it fires, and the answer was: not on
the case it was written for. Of **106 Google News members across editor runs
#118–#121, 99 contributed 64–140 characters** to writer packets — a headline
each, admitted as a source.

### Two rules that were each right, disagreeing

`title.ts` strips a trailing separator plus a **bare domain** and deliberately
nothing more. That restraint is itself evidence-driven: run #112 needed
"… Goes Rogue? - **Willamette Week**" to keep its suffix, because an outlet name
is not a domain and stripping it would mangle real headlines.

`normalizeForCompare` stripped the **domain** form from both strings.

So the title arrived as "… crackdown - AP News" and the body as
"… crackdown - apnews.com". One end had an outlet name the strip did not touch;
the other had a domain it did. They normalized to different strings,
`body.startsWith(headline)` failed, and the stub was admitted. Neither rule was
wrong on its own; they simply never agreed on what an aggregator suffix is.

`normalizeForCompare` now runs two passes — the original whitespace-tolerant
domain rule, which is still needed because the body form often carries no
separator at all ("… in Warsaw  apnews.com", two spaces), then a
separator-plus-short-tail rule that catches the outlet-name form. It is a
comparison normalization and never reaches the reader, so trimming a real
headline's trailing clause costs nothing: both sides get the same treatment, and
a body with reporting in it still fails the `ECHO_SLACK_CHARS` length test.

### What this does not fix

The stub loses its packet slot; it keeps its place in the editor's source count,
because `combined = relevance + source_weight·ln(sources)` measures cross-source
pickup and AP covering a story is a real signal of prominence whether or not we
can read the article. That is the intended behaviour and this changes nothing
about it. What changes is that the writer stops being handed a headline and told
it is a source.

---

## 2026-08-26 — AP is reachable, and the note that said otherwise was the bug

AP Top News and AP Politics were between them the single largest contributor of
material to the paper — 250 items reached editor runs in the 14 days to
2026-08-25, ahead of OPB and SCMP — and their usable rate was **0%**. Every item
was a headline.

### Two assumptions, both wrong, both sitting in comments where they read as facts

**"AP has no working public feed we can find."** That note in `sources.yaml`
rested on five URLs tried once on 2026-08-14. All five were RSS paths, and AP's
robots.txt contains `Disallow: /*.rss`. **That probe could only ever have
failed.** Reading robots.txt instead — which *declares* six sitemaps — finds
`news-sitemap-content.xml`: 200 text/xml, 529 entries with titles and
publication timestamps, spanning about 28 hours.

Note the declared name. The guessable `/news-sitemap.xml` is a near-empty
2-entry file, so a path battery would have found that one and concluded failure a
second time. Guessing paths is not a search; robots.txt is the search.

**"The Google News token is an opaque identifier with no URL in it."** That one
in `canonicalizeUrl` turned out to be *right*, and is now settled rather than
assumed: 52 real links through token decoding, redirect following and
interstitial parsing resolved zero. The interstitial is a 580KB JavaScript shell
with no `apnews.com` in it. Google News resolution is a dead end and the module
docs say so, so nobody re-runs it.

### What the sitemap actually gives, measured through the real path

518 of 529 entries are `/article/`; 6 `/photo-gallery/`, 3 `/live/`, 2
`/newsletter/`. Fifteen sampled pages, fetched and run through `extractArticle`
then `stripBoilerplate` — not a generic curl, because anything less measures a
different pipeline than the one that writes the paper — **all fifteen cleared
800 characters.**

The three `/live/` pages extracted 20,000–39,000 characters. Those are live blogs
and they are a known shape: `isLiveBlog` and the junk filter stand between them
and a writer packet. Three of 529 is a rounding error, but it is the number to
watch if the front page ever leads on one.

### The design

`format: news-sitemap` on a source. Same transport as the feed path, same
identity rule, different parse.

**A sitemap carries no body, and that is the cost.** Items arrive with a null
body, so they reach the prefilter, grouping and scoring on their titles alone,
and only the ~150 reaching the editor get their text fetched. This is not a
regression — the Google News items they replace carried a ~100-character headline
echo that `isHeadlineEcho` stripped anyway — and the proxy's title-only items
demonstrably survived those stages in numbers. But it is a real property, and the
first run is where it gets tested.

**`max_age_hours`, because a sitemap does not window itself.** AP's spans ~28
hours against a daily collector, 281 of 529 inside 24. Without a window the tail
is re-collected daily for the cross-run dedup to discard again. Default 24, which
matches both the collector's cadence and the `when:24h` the proxies used, so the
corpus stays comparable across the change. An entry with no date is **kept**: a
missing timestamp is not evidence of age.

**`exclude_paths`, because the case for collecting AP rests on reading its
robots.txt.** That file permits `/article/` and `/live/`, sets no `Crawl-delay`,
and disallows exactly one specific article. That one is in the source entry and
dropped by the collector. Exact paths, never prefixes — a prefix rule would
quietly grow to cover articles the publisher never excluded, and the value of the
list is that it diffs against the robots.txt it came from. **A rule you read but
do not follow is worse than one you never read.**

### Cost

Roughly 25 AP items a run becomes roughly 281, a ~21% larger corpus and
proportionally more prefilter calls. That is the price of the largest source in
the paper going from headlines to articles.

### The same probe, three more findings

**Willamette Week** was a Google News proxy for the same reason and with the same
0% result. Its feed is on the Arc outbound path — the shape OPB and the Oregonian
already use in this very file — which the probe that declared it dead never
tried. 8 of 8 sampled articles extract.

**Mail & Guardian** was pointed at a 404; `/rss` serves 50 items. **Labor Notes**
was pointed at a body that returns 200 and is malformed, which killed two
consecutive collections; `/rss.xml` serves 25 items against `/feed`'s 10.

Three sources, three dead endpoints, all three fixed by looking rather than by
inference. The pattern across all four is one thing: **a note recording a
conclusion outlives the evidence that produced it, and nothing re-tests it.**

---

## 2026-08-26 — A lost attach judgment is recoverable; a slow call still is not

Run #56 came back degraded: `attach_failed_calls=1`, from 158 provider attempts
for 133 successes — **24 recoverable 429s and one 300,006 ms timeout**. The
counter did its job. It has existed since run #34 precisely so a run cannot hide
this, and the reviewer correctly refused to call the run clean.

But a counter cannot be acted on, and the interesting part is *why* it happened
now. The same run switched AP from a Google News proxy to its own sitemap, and
the news lane grew from 483 kept-news items to **686 — 42%** in one step.
Grouping's attach concurrency was tuned for the smaller corpus. The corpus
outgrew the budget and one judgment went with it.

### The rule that lost it was right, and applied to the wrong case

`callWithBackoff` does not retry timeouts, deliberately: "a call that ran to its
configured ceiling will likely do it again, and the run #40 lesson was to bound
those." That is correct for a call that is genuinely slow.

It is wrong for a call that spent its budget **queued behind a rate-limit
storm**, which is a property of what else was in flight rather than of the call.
From inside `callWithBackoff` the two are indistinguishable — it sees one call —
so the fix does not belong there.

### The straggler re-ask

The attach pass now records *which* judgments were lost, not just how many, and
after the concurrent phases makes **one sequential re-ask** for those clusters
and proto-groups. Sequential is the whole point: nothing else is in flight, so
the pressure that caused the loss is gone, and "it will just do it again" does
not apply the way it does to an inline retry during the storm.

This is the writers' straggler pattern — a brief missing from a batch gets one
follow-up call — applied to the stage where a lost call is *silent* rather than
visible. Bounded at one pass: if the re-ask fails too, the judgment is still lost
and the warning still fires. This makes recovery possible, it does not promise it.

`evalCluster` and the newly extracted `evalProtoGroup` both read live state and
return a verdict without mutating anything, so running them twice is safe — the
same property that already lets the cascade re-run Phase A.

### The bug in the first version of the bookkeeping

The loss register initially cleared a unit's flag on each chunk *success*. Chunks
partition a unit's candidates, so a two-chunk cluster that lost its first call
and answered its second looked clean **with half its candidates never judged**.
`trackAttachLoss` clears once per pass and then marks on any chunk failure, and
seven tests pin it, including that exact case. Clearing per pass rather than
never is what lets a clean re-ask legitimately un-mark a unit.

### Two counts, one defect

Migration 039 splits them, because they no longer mean the same thing:

- `attach_failed_calls` — provider calls that failed, in the storm or the
  re-ask. A cost in time and tokens. **Not itself a defect**, and warning about a
  failure that was then recovered would train the reader to ignore the line that
  matters.
- `attach_unrecovered` — judgments still missing afterwards. This is what the
  "do not judge cluster quality on this run" rule attaches to now.

NULL means a run before 039, where `attach_failed_calls` carried both meanings —
which it could, because until now they were the same thing.

### What is not being changed

**Attach concurrency.** The 429s were all recovered and the underlying cause is a
corpus that grew 42% overnight; one run is thin evidence for retuning a
concurrency that was itself lowered for rate limits once before. If the next run
shows the same storm on a stable corpus, that is the evidence, and lowering
`grouping.attach.concurrency` is the lever.

---

## 2026-08-26 — The live-blog defence had been inert for two months

Run #44's rank 2 carried AP's rolling tariffs coverage: **24,455 characters, 46%
of a 53,088-character feature packet**, inside thread T0 whose other members are
supposed to cover exactly those developments. `isLiveBlog` exists to prevent
this, has existed since run #112, and did nothing. It failed twice over.

### It could not see AP's live blog

Detection read the title, on the reasoning that live blogs announce themselves.
True of Le Monde's `EN DIRECT, guerre en Ukraine`. **False of AP**, which titles
its live coverage exactly like an article — "Canada launches retaliatory tariffs
on US goods" — and declares it in the URL instead, `/live/`.

A path segment the publisher chose is a stronger signal than a headline
convention, so both are checked now. Segment-exact, never a substring: `/olive/`
and `/living/` are not live blogs.

### And it would have done nothing if it had

This is the worse half. The rule was "the live blog falls out of the packet",
implemented by ranking live blogs last in `selectArticles` and letting
`max_articles` cut them off. **Unrationing the sources on 2026-08-19 set every
cap to null**, so `full()` never returns true, both selection passes take
everything, and the reordering has had no effect on any packet since.

Two months of runs, a rule that reads as active in the code and in this log, and
no behaviour behind it. Nothing failed; it simply stopped mattering, which is the
kind of regression no counter catches.

### Dropping is not rationing, and this does not reopen that decision

Sources are not rationed and should not be: nothing is dropped for being the 13th
source or the 48,001st character, because deciding what bears on a piece is the
writer's judgment.

A live blog is not dropped for its position or its length. It is dropped for the
same reason a headline echo is — **its body is not reporting on this story**. It
is one page carrying a day of entries about many, which is precisely what breaks
the guarantee a section makes: material partitions by member, so two pieces
cannot draw on the same source. A live blog defeats that by construction.

So it joins `isHeadlineEcho` and `min_article_chars` in the packet's usability
filter, and inherits that filter's guarantee: **a packet is never emptied.** On a
story whose only source is a live blog, it is still the source.

---

## 2026-08-26 — The scoring stage had no retry at all, and its fail-safe competed

Replay #42 lost four clusters — C80 to C83 — to a single HTTP 429. Each was
persisted with `score=50`, `interest=NULL`, `reason=fail-safe: LLM error`. They
fell below that run's pile cutoff of 54 and did not reach the paper. Run #40's
cutoff was 49, and a fail-safed row did.

Two separate defects, and the first one is embarrassing.

### `callWithBackoff` was never imported

CLAUDE.md has said since 2026-07-25: "**Any new batched, concurrent stage needs
it.** The failure mode is quiet: a rate-limited call that returns a
degraded-but-valid-looking result is indistinguishable from a real model verdict,
so the run reports success while losing work."

Grouping-pass-1 is batched, concurrent, and runs at `concurrency: 10` — the
highest in the pipeline, against prefilter's 8 and writers' 4. It is the stage
that rule most obviously describes. `callWithBackoff` was **not imported into the
file**. A 429 failed on the first and only attempt and defaulted forty items.

The Zod schema had carried `retry_max_attempts` and `retry_base_ms` on
`BatchStageConfigSchema` the whole time, and `editor_pass_1` inherits it. The
config never set them and the code never called the wrapper. A rule written down,
a schema that anticipated it, and no behaviour behind either.

Fixed the obvious way: the batch call goes through `callWithBackoff` and the
config carries 5 attempts and a 2,000 ms base.

### But the batch is the wrong unit, and that is the bigger miss

The first version of the straggler re-asked **failed batches**. That covers the
429 and leaves the commonest failure untouched.

There are three ways an item ends up unscored and only two of them fail the
batch:

| reason | batch reports |
|---|---|
| `LLM error` — the call threw after retries | failed |
| `batch parse error` — nothing parsed | failed |
| `missing/invalid line` — the call **succeeded** and the model omitted a line | **success** |

The third is the one that recurs. Run #39's batch 7 of 8 parsed 39 of 40: one
item was silently defaulted inside a run that reported no errors at all, and a
whole-batch straggler would never have looked at it. Any of those 40 could have
been the day's biggest story — that is the whole objection, and it is right.

So the unit is the item. Every fail-safe path leaves `interest` null, which is
exactly what makes `interest IS NULL` a reliable query, so that is what gets
re-asked — sequentially, in chunks of `straggler_batch_size` (10). Small on
purpose: a dropped line is far harder to hide in a short response than in a
response covering forty items, and the usual straggler count is one or two, so
this is normally a single cheap call rather than forty individual ones.

A straggler that fails again does **not** overwrite the original fail-safe with a
second one. Replacing one reason with another would read as progress in the logs
while nothing had been recovered.

### 50 is a fabricated judgment, not an absent one

The subtler defect, and the one that decides whether an unjudged story reaches
the reader.

A fail-safe score of 50 sits in the middle of the 0–100 range, so it **competes**
with real judgments. Whether an unscored row was published turned entirely on
where the day's cutoff happened to land — 54 and it is dropped, 49 and it is
printed. Neither outcome was chosen; both were accidents of the distribution.

`FAIL_SAFE_SCORE` is now **0**, which says what is true: no judgment was made.
The pile ranks by score and takes the top `pile_target`, so an unscored row is
taken only when there are not enough judged rows to fill the paper — at ~480
scored rows for 150 slots, never in normal operation.

**Not excluded outright**, which was the other candidate. Exclusion is right in
normal operation and catastrophic in the outage case: if the provider is down for
the whole stage, every row is unscored, and exclusion yields no paper at all. 0
gets the normal-operation behaviour without buying the outage behaviour, because
when everything is 0 the pile fills exactly as it did before.

An unscored row keeps its null `interest` axis, so `interest IS NULL` finds it,
and the stage now closes with a warning naming the count — nobody queries a
database to discover that a stage went wrong.

### What is not being changed

**`concurrency: 10`.** It is the highest in the pipeline and it is where the
pressure comes from, but the stage had *no retry at all*; that is a sufficient
explanation for what happened and lowering concurrency on the same day would
confound the evidence. If a run with backoff in place still shows a 429 storm,
that is when the number moves.

---

## 2026-08-27 — Two audits that could not conclude, and one that did

### The per-item straggler worked, on exactly the case it was built for

Pass-1 #43 re-scored grouping #57's 480 rows, the same input pass-1 #42 saw. Its
stdout carries the line the whole redesign was about:

```
[grouping-pass-1] batch 4/10: parsed-lines=39/40; fail-safe-defaulted=1
```

The call **succeeded** and parsed 39 of 40. That is `missing/invalid line` — the
path that does not fail the batch, and the one a whole-batch straggler would have
walked straight past. The per-item re-ask caught it: **0 rows with `interest IS
NULL`**, against 4 in run #42. The recovered row was `S63708`, 9 → 21.

That is the objection that prompted the redesign, reproduced and answered in one
run.

### `inspect timing` was sorting run ids as strings

The output named run **#9** for seven of eight stages, and editor **#99**, when
the real latest runs were collector #57 through writers #45.

```sql
SELECT id::text, started_at, ... FROM collector_runs ORDER BY id DESC LIMIT 1
```

A cast expression keeps the underlying column's name, so `id::text` names its
output column `id` — and SQL resolves `ORDER BY id` against **output** columns
before table columns. So the sort ran on text: `"9"` above `"99"` above `"57"`
above `"123"`. Every duration, every `[earlier lineage]` mark and the whole wall
clock were computed over the wrong rows, and the report read as plausible
throughout. Aliasing the cast (`id::text AS run_id`) leaves `id` bound to the
integer.

Two lessons, and the second is the uncomfortable one. A tool added to answer a
question was wrong on its first real use, in a way only the data revealed — the
run ids looked odd, and nothing else would have. And the `[earlier lineage]`
feature added the same day made the wrong output look *more* credible, because it
explained away exactly the anomaly the bug produced.

### `inspect packet` counted omissions and never said why

The whole-run form has printed an `omit` column per story since it was written;
the reasons only ever printed under `--rank`. So the audit could see that AP's
live page left story C4's packet — `arts=3, omit=3` — and could not say whether
the live-blog rule had fired or the empty fetch cache had done it. The right
refusal was made: no claim, and the gap named.

It now prints omission reasons grouped and counted, with the numbers collapsed
out so shapes group rather than splinter per article.

### Measured, not fixed: scoring is not stable across runs

The same 480 rows, the same model, temperature 0.1, scored twice:

| | |
|---|---|
| median absolute difference | 5 points |
| mean | 6.70 |
| maximum | 32 |
| **rows crossing the pile cutoff of 54** | **57 of 480** |

Roughly **12% of pile membership is run-to-run noise**. Nothing here is broken —
this is what an LLM judgment at temperature 0.1 costs — but it bounds what any
single run can be used for. Tuning `similarity_threshold` or judging cluster
quality on one run was already discouraged for other reasons; this says the
scoring layer alone moves an eighth of the paper's composition between identical
runs.

Not acted on. The obvious lever is `temperature: 0` for this stage, and the
config already notes that judgment stages want repeatability while the writers
want prose. That is worth an experiment, not a same-day change.

### Also observed

Pass-1 took **463s** on the input that took **58s** in run #42 — an eightfold
swing with no code path that explains it, and long enough that a 420-second
command wrapper truncated the stdout. Provider variance is the likely answer.
It matters for one reason: it puts a wide band on any answer to "how long does
the paper take".

---

## 2026-08-27 — Reviewing the branch against a real Postgres

No fresh corpus available, so the day went on hardening what is already written.
Four defects, all mine, all from this branch.

### `inspect timing` sorted run ids as text — reproduced, not reasoned about

Postgres 16 is installed in the dev image, so this one was settled by running it
rather than reading it. A scratch cluster, the project's own migrations, three
collector rows with ids 9, 57 and 123:

```
SELECT id::text,           ... ORDER BY id DESC LIMIT 1   ->  9
SELECT id::text AS run_id, ... ORDER BY id DESC LIMIT 1   ->  123
```

A cast keeps the underlying column's name, so `id::text` names its output column
`id`, and SQL resolves `ORDER BY` against output columns first. Aliasing the cast
leaves `id` bound to the integer.

The same cluster then ran `inspect timing`, `inspect fetch`, the 22-parameter
`grouping_runs` update and the `writer_pieces` repair update against the real
schema and its CHECK constraints. **Reasoning about SQL is not testing SQL**, and
this branch had already shipped one query that was wrong in a way no amount of
re-reading had caught.

### The never-empty fallback kept the first article, not the best

`assembleWriterPacket` ends with:

```ts
const resolved = usable.length > 0 ? usable : resolvedAll.slice(0, 1);
```

The comment above it has always said "if every article is a stub the best one
stays". `slice(0, 1)` does not do that — it takes whatever `selectArticles`
ordered first — and the gap was harmless while the filter removed only empties
and headline echoes.

Adding live blogs to that filter made it harmful. `selectArticles` orders live
blogs **last**, on purpose. So a story whose sources are a 40-character stub and
a 24,000-character live blog now filtered both out, fell back to `[0]`, and handed
the writer the stub. Before the live-blog rule it would have kept the live blog.
Longest-first fixes it, and is what the comment promised all along.

A rule that removes more things makes every fallback beneath it more reachable.
That is the shape to look for after widening a filter.

### An attach cluster with no candidates left was counted as lost

`evalCluster` returns early when a cluster has no candidate singletons, and that
early return sat above `trackAttachLoss`. A cluster marked lost in Phase A whose
singletons were then attached elsewhere by the cascade arrived at the straggler
with nothing to offer, returned early, and kept its flag — reporting
`attach_unrecovered` on a run where there was nothing left to ask. Over-reporting
degradation is the safer direction to be wrong in, and it is still wrong.

### A sitemap index would have collected nothing, quietly

`format: news-sitemap` pointed at a sitemap *index* parses cleanly and yields
zero articles: an index lists `<sitemap><loc>`, not `<url><loc>`. The run would
report a successful zero-item source and say nothing about why. OregonLive serves
exactly that shape at its declared news-sitemap URL, so this is a configuration
mistake waiting to be made rather than a hypothetical. It now throws with a
message naming the problem, which the collector records as a source failure.

## 2026-08-27 — A skip never overwrites an attempt

`fetch-text` recorded its skips with a per-reason flag deciding whether the
skip row could replace an existing `article_texts` row. The flag was set for
`host in cooldown` and left off the other two reasons, and the reason it was
left off `already attempted within refetch_after_hours` is the reason it is
fatal there: that skip fires *because* a recent attempt exists, so it clobbered
the very row it had just read. Re-running the fetch against one editor run
deleted that run's own article text — AP read 100% usable at a 4,269-character
median in one report and 14% at 0 in the next, on the same day, with no fetch
in between that could have failed.

The rule is now derived from the row's status rather than passed in by the
caller: a skip means "never asked", so it may only replace another skip, and no
caller can get it wrong. The cooldown case the flag was written for is an
instance of that rule, not an exception to it.

## 2026-08-27 — Timing checks order, not proximity

`inspect timing` takes the latest run of each stage, and marked a stage as
`[earlier lineage]` when it started more than six hours before the newest. That
catches a replay from a days-old preprocessor run and missed the case that
reached a report: editor #123 and writers #45 ran at 21:51 and 21:52, while
grouping-pass-1 #43 and thread #21 ran at 00:43 and 00:51 the next morning.
Every row sat inside six hours of every other, so nothing was marked, and the
command reported a 332m wall clock and a 308m "orchestration gap" that nobody
waited — it was the distance between two sittings, and #123's paper was not
written from #43's scores at all.

Proximity in time was never the question; order is. The stage list is already
in pipeline order, so a stage that started before one above it demonstrably did
not consume it. When that happens the wall clock and the gap are suppressed
rather than printed with a caveat: a fictional number is worse than no number.

## 2026-08-27 — The probe parses with the parser that ships

`probe-source --sitemap` read AP's XML with four regexes of its own. Every fact
in `sources.yaml` about AP came from those regexes, and the collector does not
run them — `parseNewsSitemap` and its linkedom DOMParser had never seen real AP
markup, so a disagreement would have shown up as a source that collected
nothing and reported success. The probe now calls the shipped parser and prints
what the collector's own window would keep. Confirmed against the live file:
599 entries, 310 inside 24 hours, 585 of 599 `/article/`.

## 2026-08-28 — The editor tie-break gets the backoff

`callTieBreakForGroup` ran on a raw `callLLM` from the day it was written, at
`concurrency: 10` — level with grouping-pass-1, the highest in the pipeline.
Run #125 lost 12 of its 25 tie groups to a single 429 each, one attempt, no
retry, and ranked those items by ref order instead. Ref order is alphabetical,
and at a tier boundary it decides whether a story runs as a feature or a
standard.

The run is its own control. Grouping's attach pass met the same 429 storm from
the same provider minutes earlier, retried under `callWithBackoff`, and
finished with `attach_failed_calls=0`. Nothing about the storm was unusual;
only one of the two stages was wrapped.

It is also the quiet failure the rule was written for: the catch returns an
empty rank map, which is indistinguishable from a group the model declined to
order, so the stage logged a warning and reported success. Migration 040 puts
`tie_break_calls` and `tie_break_failed_calls` on `editor_runs` for the same
reason as 030 and 039 — a report regenerated from the database has to be able
to judge a run after the console log is gone.

## 2026-08-28 — The gap rule names the outlet case

Run #47 published one source-meta sentence in 150 pieces: S64820, "The article
does not specify when the House might take up the legislation." The packet
note's gap rule already excluded it — an article is not "someone in the story"
— but only implicitly, and the memo draws the actor-versus-outlet line in the
system prompt, at the far distance. Every previous instance of this failure was
fixed by moving the winning instruction nearer to the material, so the clause
now names the shape that keeps reaching the paper. It is the same rule, not a
new layer and not a new prohibition.

One piece in 150 is not a controlled measurement. The controlled form is a
single-tier re-run against one editor run, and this has not had one.

## 2026-08-28 — The publisher is a stage, not a query

Everything the reading view needs was already in the database, so the pages
could have joined their way to it. Two things made that wrong.

`writer_pieces` cannot produce a source link. It stores `source_count` and no
URLs; the attribution is three joins away through `thread_members`,
`grouping_runs.digest` and `preprocessed_items` — precisely the walk
`writers/materials.ts` was written to do. Rendering a page would have put the
writers' resolver on the reader's critical path.

The real argument is the second one: a paper is a daily artifact. A view is a
window onto whatever the pipeline currently believes, so re-running grouping
tomorrow would silently change what yesterday's paper said. `papers`,
`paper_pieces` and `paper_sources` (migration 041) are what was published,
frozen at publication — which is also why the source rows copy the outlet name,
title and URL rather than only holding a foreign key. `raw_items` has a
retention window, and a published paper has to keep pointing at its sources
after its inputs are swept.

One paper per day, unique on `published_on`, and re-publishing deletes and
re-inserts inside one transaction, so a re-run corrects the morning's paper
rather than sitting beside it. The date is the reader's local day, not UTC: a
run starting at 7pm Pacific must not publish tomorrow's edition.

## 2026-08-28 — The index is the paper

The first reading view was the obvious one: every piece, in rank order, one
column, full text. Run #47 is 150 pieces and 21,857 words — about ninety
minutes, roughly ninety phone screens. That is a reading surface, not a
newspaper, and it is worse than it sounds on a phone, where there is no way to
skip and no way to see what a section contains without scrolling through it.

The index-first layout is the newspaper affordance the scroll had thrown away: a
list of headlines you get through in a few minutes, and a page you turn to when
one of them is worth it. 123 rows, about ten screens.

One navigation rule, because two would need explaining: **containers expand,
pieces open**. A thread is the only container. Every piece has a page.

Briefs were briefly an exception — tapping one went straight to its source,
which reads consistently until you notice two things. The paper's own 30-word
brief bodies would be written every day and never displayed, 61 calls' worth;
and the seven briefs a day with more than one source have no defensible
destination, since "the source" is then arbitrary. Giving briefs pages fixed
both and removed the exception.

A consequence worth recording: with every row opening a page, nothing leaves the
paper from the index, so the index carries no accent colour at all. Blue now
appears only on an article's source list, which is a tidier statement of the
rule than the version that produced it — the only coloured thing on a page is
the way out of it.

## 2026-08-28 — displayHeadline does not trim to a sentence

A section line is written as a bare sentence with no headline, which the line
contract makes explicit. In a continuous-reading layout that was right; in an
index it leaves a row with nothing to show, so the sentence stands in — whole.

Trimming it to its first sentence would keep the row one line tall, and the
first implementation did. It was wrong twice in the first test run: the regex
cut `He called it "beyond critical.` before the closing quote, and fixing that
still left the failure that matters, because a period followed by a space ends
"U.S." and "Adm." as readily as it ends a clause. `U.S. and NATO officials told
AP…` becomes the headline `U.S.`.

A tall row is a blemish. A headline that reads "U.S." is a defect. The heuristic
is gone and the fallback returns the sentence whole; the real fix is upstream,
where a line should carry its own headline.
