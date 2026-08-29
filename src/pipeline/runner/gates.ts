/**
 * The gates: pure functions from a stage's own counters to a verdict.
 *
 * A stage exiting 0 is not evidence that it worked, and every expensive lesson
 * in this project is a variant of that. `runWriters` returns a normal summary
 * after its circuit breaker trips. A failed attach call returns an empty set,
 * which is what the model declining every candidate also returns. The editor's
 * tie-break catch returns an empty rank map, which is what a tie group the
 * model declined to order returns. In each case the run reported success and
 * lost work quietly.
 *
 * Every counter needed to catch those is already persisted -- migrations 030,
 * 037, 038, 039 and 040 exist precisely so a run can be judged after the
 * console log is gone. What was missing was anything that read them back and
 * acted. These functions are that, and they are pure so the policy can be
 * tested without a database, a provider, or a paper.
 *
 * Three verdicts, and the middle one is the common case:
 *
 *   ok     nothing to say.
 *   warn   the paper is degraded and still a paper. The run continues and is
 *          recorded 'degraded', because the paper has a deadline.
 *   abort  the next stage must not start -- there is nothing for it to work on,
 *          or publishing what we have would be worse than publishing nothing.
 */

import type { PipelineGatesConfig } from "../../config/models.js";

export type GateVerdict = "ok" | "warn" | "abort";

export interface GateResult {
  verdict: GateVerdict;
  /** One line per firing check, in the order declared. Prose: a person reads these. */
  reasons: string[];
}

export interface GateCheck {
  /** Whether this check fired. */
  when: boolean;
  /** The verdict it argues for when it fires. */
  verdict: Exclude<GateVerdict, "ok">;
  reason: string;
}

const SEVERITY: Record<GateVerdict, number> = { ok: 0, warn: 1, abort: 2 };

/**
 * Folds checks into one verdict: the most severe that fired, carrying the
 * reasons of every check that fired rather than only the decisive one. A run
 * that aborts on holed writers usually also warned about something upstream,
 * and the upstream warning is often the actual cause.
 */
export function evaluate(checks: GateCheck[]): GateResult {
  const fired = checks.filter((c) => c.when);
  let verdict: GateVerdict = "ok";
  for (const c of fired) {
    if (SEVERITY[c.verdict] > SEVERITY[verdict]) verdict = c.verdict;
  }
  return { verdict, reasons: fired.map((c) => c.reason) };
}

/**
 * Share of `part` in `whole`, with an empty whole reading as 0 rather than NaN.
 *
 * Deliberately not 1: every caller asks "what fraction went wrong", and a stage
 * with nothing in it had nothing go wrong. The stages where an empty input is
 * itself the problem say so with their own count check, which is clearer than
 * a fraction standing in for it.
 */
export function fraction(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return part / whole;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export interface CollectorMetrics {
  sourcesAttempted: number;
  sourcesSucceeded: number;
  itemsFetched: number;
  itemsInserted: number;
}

export function gateCollector(
  m: CollectorMetrics,
  cfg: PipelineGatesConfig["collector"],
): GateResult {
  const succeeded = fraction(m.sourcesSucceeded, m.sourcesAttempted);
  return evaluate([
    {
      // A dead feed is logged and skipped by design. Half of them dead is not a
      // feed problem: it is DNS, egress, or the proxy, and the paper below it
      // would be built from whatever happened to answer.
      when: m.sourcesAttempted > 0 && succeeded < cfg.min_sources_succeeded_fraction,
      verdict: "abort",
      reason:
        `only ${m.sourcesSucceeded}/${m.sourcesAttempted} sources succeeded (${pct(succeeded)}, ` +
        `floor ${pct(cfg.min_sources_succeeded_fraction)}) — this is the network, not the feeds`,
    },
    {
      when: m.itemsInserted < cfg.min_items_inserted,
      verdict: "abort",
      reason:
        `${m.itemsInserted} new item(s) collected (floor ${cfg.min_items_inserted}) — ` +
        `every stage below this would run on yesterday`,
    },
    {
      // Not fatal on its own, and the shape of a partial outage worth naming.
      when:
        m.sourcesAttempted > 0 &&
        succeeded >= cfg.min_sources_succeeded_fraction &&
        m.sourcesSucceeded < m.sourcesAttempted,
      verdict: "warn",
      reason: `${m.sourcesAttempted - m.sourcesSucceeded} source(s) failed`,
    },
  ]);
}

export interface PreprocessorMetrics {
  rawItemsConsidered: number;
  itemsKept: number;
}

export function gatePreprocessor(
  m: PreprocessorMetrics,
  cfg: PipelineGatesConfig["preprocessor"],
): GateResult {
  return evaluate([
    {
      when: m.rawItemsConsidered === 0,
      verdict: "abort",
      reason: "0 raw items in the preprocessor's window — nothing was collected in range",
    },
    {
      // Cross-run dedup suppresses what recent runs already processed, so this
      // is the expected result of running the pipeline twice in one day. It is
      // still an abort: there is no paper in an empty kept set.
      when: m.itemsKept < cfg.min_items_kept,
      verdict: "abort",
      reason:
        `${m.itemsKept} item(s) kept from ${m.rawItemsConsidered} considered — ` +
        `if this is a same-day re-run, cross-run dedup has already taken them`,
    },
  ]);
}

export interface PrefilterMetrics {
  itemsIn: number;
  itemsKept: number;
  itemsCut: number;
}

export function gatePrefilter(
  m: PrefilterMetrics,
  cfg: PipelineGatesConfig["prefilter"],
): GateResult {
  const cut = fraction(m.itemsCut, m.itemsIn);
  return evaluate([
    {
      when: m.itemsKept < cfg.min_items_kept,
      verdict: "abort",
      reason: `prefilter kept ${m.itemsKept} of ${m.itemsIn} items — nothing to cluster`,
    },
    {
      // The prefilter is a relevance floor, not a shredder. A cut rate this
      // high means the bio or the prompt did not load, and the paper below it
      // would be assembled from the remainder as if that were the news.
      when: m.itemsIn > 0 && cut > cfg.max_cut_fraction,
      verdict: "abort",
      reason:
        `prefilter cut ${pct(cut)} of ${m.itemsIn} items (ceiling ${pct(cfg.max_cut_fraction)}) — ` +
        `a floor does not cut this much; suspect the bio or the prompt`,
    },
  ]);
}

export interface GroupingMetrics {
  clusterCount: number | null;
  singletonCount: number | null;
  attachUnrecovered: number | null;
  attachFailedCalls: number | null;
  splitFailedCalls: number | null;
  resplitFailedCalls: number | null;
}

export function gateGrouping(
  m: GroupingMetrics,
  cfg: PipelineGatesConfig["grouping"],
): GateResult {
  const rows = (m.clusterCount ?? 0) + (m.singletonCount ?? 0);
  return evaluate([
    {
      when: rows < cfg.min_rows,
      verdict: "abort",
      reason: `grouping produced ${rows} row(s) — nothing for the scorer to rank`,
    },
    {
      // The distinction migration 039 exists to draw: failed calls cost time and
      // tokens, unrecovered judgments cost grouping. Only the second is a defect.
      when: m.attachUnrecovered !== null && m.attachUnrecovered >= cfg.warn_attach_unrecovered,
      verdict: "warn",
      reason:
        `${m.attachUnrecovered} attach judgment(s) unrecovered after the straggler re-ask — ` +
        `the cluster/singleton split understates real grouping, and this run must not be ` +
        `used to tune similarity_threshold`,
    },
    {
      when: m.splitFailedCalls !== null && m.splitFailedCalls >= cfg.warn_split_failed_calls,
      verdict: "warn",
      reason: `${m.splitFailedCalls} split call(s) failed — those components were left intact and may be over-merged`,
    },
    {
      when: m.resplitFailedCalls !== null && m.resplitFailedCalls >= cfg.warn_split_failed_calls,
      verdict: "warn",
      reason: `${m.resplitFailedCalls} re-split call(s) failed — clusters describe flagged MULTI were left intact`,
    },
    {
      // Costs money and time without costing grouping, since the re-ask
      // recovered them. Worth a line, not a verdict of its own.
      when:
        m.attachFailedCalls !== null &&
        m.attachFailedCalls > 0 &&
        (m.attachUnrecovered ?? 0) === 0,
      verdict: "warn",
      reason: `${m.attachFailedCalls} attach call(s) failed but every judgment was recovered — provider congestion, not lost work`,
    },
  ]);
}

export interface GroupingPass1Metrics {
  itemsIn: number;
  unscored: number;
  pileItems: number;
}

export function gateGroupingPass1(
  m: GroupingPass1Metrics,
  cfg: PipelineGatesConfig["grouping_pass1"],
): GateResult {
  const unscored = fraction(m.unscored, m.itemsIn);
  return evaluate([
    {
      when: m.itemsIn > 0 && unscored >= cfg.abort_unscored_fraction,
      verdict: "abort",
      reason:
        `${m.unscored} of ${m.itemsIn} rows unscored (${pct(unscored)}) — ` +
        `the provider was not answering; the ranking below this would be noise`,
    },
    {
      // An unscored row scores 0 rather than 50, so a handful is survivable:
      // the pile takes one only if it is short of judged candidates.
      when: m.itemsIn > 0 && unscored > cfg.max_unscored_fraction && unscored < cfg.abort_unscored_fraction,
      verdict: "warn",
      reason:
        `${m.unscored} of ${m.itemsIn} rows unscored (${pct(unscored)}, ceiling ` +
        `${pct(cfg.max_unscored_fraction)}) — they score 0 and will not compete`,
    },
    {
      when: m.itemsIn > 0 && m.unscored > 0 && unscored <= cfg.max_unscored_fraction,
      verdict: "warn",
      reason: `${m.unscored} row(s) unscored after the straggler re-ask — each scores 0`,
    },
    {
      when: m.pileItems < cfg.min_pile_items,
      verdict: "abort",
      reason: `the pile holds ${m.pileItems} item(s) — there is no paper in it`,
    },
  ]);
}

export interface ThreadMetrics {
  candidatesIn: number;
  threadsFormed: number;
  failedCalls: number;
}

export function gateThread(m: ThreadMetrics, cfg: PipelineGatesConfig["thread"]): GateResult {
  return evaluate([
    {
      // One call covers the whole candidate set, so losing it loses the pass
      // entirely -- run #50 lost its single call to a broken stream and put
      // three separate wildfire rows in the top ten.
      when: m.failedCalls >= cfg.warn_failed_calls,
      verdict: "warn",
      reason:
        `${m.failedCalls} thread call(s) failed — related rows will compete as separate ` +
        `stories, which is how one situation takes several slots at the top of the paper`,
    },
  ]);
}

export interface EditorMetrics {
  itemsIn: number;
  itemsFeature: number;
  itemsStandard: number;
  itemsBrief: number;
  tieBreakCalls: number | null;
  tieBreakFailedCalls: number | null;
}

export function gateEditor(m: EditorMetrics, cfg: PipelineGatesConfig["editor"]): GateResult {
  const ranked = m.itemsFeature + m.itemsStandard + m.itemsBrief;
  return evaluate([
    {
      when: ranked < cfg.min_items_ranked,
      verdict: "abort",
      reason: `the editor ranked ${ranked} item(s) into tiers — there is nothing to write`,
    },
    {
      // Run #125 lost 12 of 25 groups to one 429 each and ranked 60-odd items
      // by ref order: alphabetical, at the boundary deciding feature vs standard.
      when:
        m.tieBreakFailedCalls !== null &&
        m.tieBreakFailedCalls >= cfg.warn_tie_break_failed_calls,
      verdict: "warn",
      reason:
        `${m.tieBreakFailedCalls} of ${m.tieBreakCalls ?? "?"} tie-break call(s) failed — ` +
        `those groups fell back to ref order, which is alphabetical`,
    },
  ]);
}

export interface WritersMetrics {
  piecesIn: number;
  piecesWritten: number;
  piecesFailed: number;
  failedCalls: number;
  repairAttempts: number;
}

export function gateWriters(m: WritersMetrics, cfg: PipelineGatesConfig["writers"]): GateResult {
  const written = fraction(m.piecesWritten, m.piecesIn);
  return evaluate([
    {
      when: m.piecesIn > 0 && written < cfg.min_written_fraction,
      verdict: "abort",
      reason:
        `${m.piecesWritten}/${m.piecesIn} pieces written (${pct(written)}, floor ` +
        `${pct(cfg.min_written_fraction)})${m.repairAttempts > 0 ? ` after ${m.repairAttempts} repair pass(es)` : ""} — ` +
        `not publishing; yesterday's paper stays up and \`npm run write -- --repair\` is safe to re-run`,
    },
    {
      // Any hole at all, once the run is above the publishing floor. There is
      // no fraction below which a missing piece stops being worth naming, and a
      // second threshold here would only decide how many holes go unmentioned.
      when: m.piecesIn > 0 && written >= cfg.min_written_fraction && m.piecesFailed > 0,
      verdict: "warn",
      reason:
        `${m.piecesFailed} piece(s) have no text (${m.piecesWritten}/${m.piecesIn} written)` +
        `${m.repairAttempts > 0 ? ` after ${m.repairAttempts} repair pass(es)` : ""} — ` +
        `the paper is short by that many`,
    },
    {
      when: m.piecesIn === 0,
      verdict: "abort",
      reason: "the writers were given no packets — the editor run resolved to nothing writable",
    },
  ]);
}

export interface PublisherMetrics {
  pieceCount: number;
  piecesSkipped: number;
  piecesUnsourced: number;
}

export function gatePublisher(
  m: PublisherMetrics,
  cfg: PipelineGatesConfig["publisher"],
): GateResult {
  const unsourced = fraction(m.piecesUnsourced, m.pieceCount);
  return evaluate([
    {
      when: m.pieceCount === 0,
      verdict: "abort",
      reason: "the paper published 0 pieces",
    },
    {
      // Not an abort: the paper is already written by the time this is known,
      // and a piece the reader cannot follow still reads. It is the one thing
      // the paper promises, so it is never silent.
      when: m.pieceCount > 0 && unsourced > cfg.max_unsourced_fraction,
      verdict: "warn",
      reason:
        `${m.piecesUnsourced} of ${m.pieceCount} published pieces resolved no sources ` +
        `(${pct(unsourced)}, ceiling ${pct(cfg.max_unsourced_fraction)}) — the reader cannot ` +
        `follow those to anyone's reporting`,
    },
    {
      when: m.piecesSkipped > 0,
      verdict: "warn",
      reason: `${m.piecesSkipped} writer piece(s) failed and are not in the paper`,
    },
  ]);
}
