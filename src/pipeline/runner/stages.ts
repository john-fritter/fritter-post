/**
 * The nine stages, as one ordered list the runner can walk.
 *
 * Each entry knows three things: how to run its stage, which ids it contributes
 * to the lineage, and which counters its gate reads. Nothing else -- the gate
 * policy is in gates.ts and stays pure, and the ordering, persistence and
 * resume logic is in index.ts.
 *
 * The stages are called in process rather than shelled out to their scripts.
 * Every `run*()` already returns its run id, so ids thread as values; going
 * through the CLI would mean parsing them back out of stdout, which is how a
 * pipeline acquires a second, worse copy of its own schema.
 */

import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { runCollector } from "../collector/index.js";
import { runPreprocessor } from "../preprocessor/index.js";
import { runPrefilter } from "../prefilter/index.js";
import { runGrouping } from "../grouping/index.js";
import { runGroupingPass1 } from "../editor-pass-1/index.js";
import { assembleGroupingPile } from "../editor-pass-1/assemble-pile.js";
import { runThreading } from "../thread/index.js";
import { runEditor } from "../editor/index.js";
import { runArticleFetch } from "../writers/fetch-text.js";
import { runWriters, repairWriterRun } from "../writers/index.js";
import { runPublisher } from "../publisher/index.js";
import {
  evaluate,
  gateCollector,
  gateFetch,
  gateEditor,
  gateGrouping,
  gateGroupingPass1,
  gatePrefilter,
  gatePreprocessor,
  gatePublisher,
  gateThread,
  gateWriters,
  type GateResult,
} from "./gates.js";

export const STAGE_NAMES = [
  "collect",
  "preprocess",
  "prefilter",
  "grouping",
  "grouping-pass1",
  "editor",
  "fetch-text",
  "write",
  "publish",
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export function isStageName(s: string): s is StageName {
  return (STAGE_NAMES as readonly string[]).includes(s);
}

/**
 * The ids threaded between stages. Every field nullable: a resumed run fills in
 * only what it actually ran and inherits the rest.
 */
export interface Lineage {
  collectorRunId: number | null;
  preprocessorRunId: number | null;
  prefilterRunId: number | null;
  groupingRunId: number | null;
  groupingPass1RunId: number | null;
  threadRunId: number | null;
  pileId: number | null;
  editorRunId: number | null;
  writerRunId: number | null;
  paperId: number | null;
}

export function emptyLineage(): Lineage {
  return {
    collectorRunId: null,
    preprocessorRunId: null,
    prefilterRunId: null,
    groupingRunId: null,
    groupingPass1RunId: null,
    threadRunId: null,
    pileId: null,
    editorRunId: null,
    writerRunId: null,
    paperId: null,
  };
}

export interface StageOutcome {
  /** The id of the row this stage wrote in its own run table. */
  stageRunId: number | null;
  /** The counters the gate read, persisted so a threshold can be re-tuned against history. */
  metrics: Record<string, unknown>;
  gate: GateResult;
  /** Ids this stage contributes. Merged into the run's lineage. */
  lineage: Partial<Lineage>;
}

export interface StageContext {
  lineage: Lineage;
  /** This invocation's pipeline_runs id, so a stage can read what the last one recorded. */
  pipelineRunId: number;
  /** Set by --dry-run: report what would run, touch nothing. */
  dryRun: boolean;
  /**
   * Testing only. Cross-run dedup is what makes a same-day full re-run come back
   * near-empty by design, which is correct for production and makes the pipeline
   * untestable end to end on a day it has already run. Turning it off produces a
   * paper built from items an earlier run already published.
   */
  skipCrossRunDedup: boolean;
}

export interface Stage {
  name: StageName;
  run(ctx: StageContext): Promise<StageOutcome>;
}

/** Combines the verdicts of two gates evaluated over one stage. */
function merge(...results: GateResult[]): GateResult {
  return evaluate(
    results.flatMap((r) =>
      r.reasons.map((reason) => ({
        when: true,
        verdict: r.verdict === "ok" ? ("warn" as const) : r.verdict,
        reason,
      })),
    ),
  );
}

/**
 * The cooldown host set the previous pipeline run recorded, or null if there
 * isn't one.
 *
 * Null and empty mean different things and the caller must not conflate them:
 * an empty set means the last run found nothing in cooldown, so everything now
 * in cooldown is new; null means there is no baseline at all, and with no
 * baseline nothing can honestly be called new. The first run after this change
 * therefore reports no newly-cooled hosts rather than all of them.
 */
async function previousCooldownHosts(pipelineRunId: number): Promise<Set<string> | null> {
  const { rows } = await getPool().query<{ metrics: { cooldownHosts?: unknown } | null }>(
    `SELECT metrics FROM pipeline_stage_runs
      WHERE stage = 'fetch-text'
        AND pipeline_run_id <> $1
        AND metrics IS NOT NULL
      ORDER BY id DESC LIMIT 1`,
    [pipelineRunId],
  );
  const hosts = rows[0]?.metrics?.cooldownHosts;
  if (!Array.isArray(hosts)) return null;
  return new Set(hosts.filter((h): h is string => typeof h === "string"));
}

/** A gate that fired on a precondition rather than on a stage's own counters. */
function abortBecause(reason: string): StageOutcome {
  return {
    stageRunId: null,
    metrics: {},
    gate: { verdict: "abort", reasons: [reason] },
    lineage: {},
  };
}

export const STAGES: Stage[] = [
  {
    name: "collect",
    async run() {
      const cfg = loadModelConfig().pipeline.gates.collector;
      const r = await runCollector();
      const metrics = {
        sourcesAttempted: r.sourcesAttempted,
        sourcesSucceeded: r.sourcesSucceeded,
        itemsFetched: r.itemsFetched,
        itemsInserted: r.itemsInserted,
      };
      return {
        stageRunId: r.runId,
        metrics,
        gate: gateCollector(metrics, cfg),
        lineage: { collectorRunId: r.runId },
      };
    },
  },

  {
    name: "preprocess",
    async run(ctx) {
      const cfg = loadModelConfig().pipeline.gates.preprocessor;
      // The collector run id is recorded on the preprocessor row as provenance
      // and is NOT a filter: the preprocessor selects raw_items by a fixed
      // fetched_at window. Passed anyway so the lineage says which collection
      // this run was meant to follow, which is the only honest thing it can
      // mean here.
      const r = await runPreprocessor({
        ...(ctx.lineage.collectorRunId !== null
          ? { collectorRunId: ctx.lineage.collectorRunId }
          : {}),
        ...(ctx.skipCrossRunDedup ? { skipCrossRunDedup: true } : {}),
      });
      const metrics = {
        rawItemsConsidered: r.rawItemsConsidered,
        itemsKept: r.itemsKept,
        itemsDroppedRecency: r.itemsDroppedRecency,
        itemsDroppedDuplicate: r.itemsDroppedDuplicate,
        itemsDroppedCrossRun: r.itemsDroppedCrossRun,
        crossRunDedupSkipped: r.crossRunDedupSkipped,
      };
      return {
        stageRunId: r.id,
        metrics,
        gate: gatePreprocessor(metrics, cfg),
        lineage: { preprocessorRunId: r.id },
      };
    },
  },

  {
    name: "prefilter",
    async run(ctx) {
      const cfg = loadModelConfig().pipeline.gates.prefilter;
      const r = await runPrefilter(
        ctx.lineage.preprocessorRunId !== null
          ? { preprocessorRunId: ctx.lineage.preprocessorRunId }
          : {},
      );
      const metrics = { itemsIn: r.itemsIn, itemsKept: r.itemsKept, itemsCut: r.itemsCut };
      return {
        stageRunId: r.id,
        metrics,
        gate: gatePrefilter(metrics, cfg),
        lineage: { prefilterRunId: r.id, preprocessorRunId: r.preprocessorRunId },
      };
    },
  },

  {
    name: "grouping",
    async run(ctx) {
      const pool = getPool();
      const cfg = loadModelConfig().pipeline.gates.grouping;

      // Grouping must not start before the prefilter has finished for this
      // preprocessor run. getClusteringItems tolerates a missing prefilter run
      // -- "a null run means nothing is excluded on its account" -- which is
      // right for an experiment run by hand and silent under automation: the
      // stage would cluster the unfiltered set and report success. Only a
      // resume can get here out of order, and this is where it is caught.
      if (ctx.lineage.preprocessorRunId !== null) {
        const { rows } = await pool.query<{ id: number }>(
          `SELECT id FROM prefilter_runs
            WHERE preprocessor_run_id = $1 AND completed_at IS NOT NULL
            ORDER BY completed_at DESC LIMIT 1`,
          [ctx.lineage.preprocessorRunId],
        );
        if (!rows[0]) {
          return abortBecause(
            `no completed prefilter run for preprocessor run #${ctx.lineage.preprocessorRunId} — ` +
              `grouping would silently cluster the unfiltered set. Run the prefilter first.`,
          );
        }
      }

      const r = await runGrouping(
        ctx.lineage.preprocessorRunId !== null
          ? { preprocessorRunId: ctx.lineage.preprocessorRunId }
          : {},
      );

      // The per-pass counters live on the run row (migrations 030, 038, 039)
      // rather than in the return value.
      const { rows } = await pool.query<{
        cluster_count: number | null;
        singleton_count: number | null;
        attach_unrecovered: number | null;
        attach_failed_calls: number | null;
        split_failed_calls: number | null;
        resplit_failed_calls: number | null;
      }>(
        `SELECT cluster_count, singleton_count, attach_unrecovered, attach_failed_calls,
                split_failed_calls, resplit_failed_calls
           FROM grouping_runs WHERE id = $1`,
        [r.id],
      );
      const row = rows[0];
      const metrics = {
        clusterCount: row?.cluster_count ?? null,
        singletonCount: row?.singleton_count ?? null,
        attachUnrecovered: row?.attach_unrecovered ?? null,
        attachFailedCalls: row?.attach_failed_calls ?? null,
        splitFailedCalls: row?.split_failed_calls ?? null,
        resplitFailedCalls: row?.resplit_failed_calls ?? null,
      };
      return {
        stageRunId: r.id,
        metrics,
        gate: gateGrouping(metrics, cfg),
        lineage: { groupingRunId: r.id, preprocessorRunId: r.preprocessorRunId },
      };
    },
  },

  {
    // Scoring, threading and pile assembly are one stage because the script has
    // always run them together and the pile needs the thread results: a threaded
    // row must not also appear on its own.
    name: "grouping-pass1",
    async run(ctx) {
      const pool = getPool();
      const config = loadModelConfig();
      const cfg = config.pipeline.gates;

      const r = await runGroupingPass1(
        ctx.lineage.groupingRunId !== null ? { groupingRunId: ctx.lineage.groupingRunId } : {},
      );

      // Every fail-safe path leaves `interest` null, which is what makes it the
      // reliable marker: a batch that failed and a call that succeeded while
      // omitting one line both land here.
      const { rows: unscoredRows } = await pool.query<{ n: string }>(
        "SELECT COUNT(*) AS n FROM grouping_pass1_results WHERE run_id = $1 AND interest IS NULL",
        [r.id],
      );
      const unscored = parseInt(unscoredRows[0]?.n ?? "0", 10);

      let threadRunId: number | null = null;
      let threadGate: GateResult = { verdict: "ok", reasons: [] };
      let threadMetrics: Record<string, unknown> = { threadEnabled: false };
      if (config.thread.enabled) {
        const t = await runThreading({ groupingPass1RunId: r.id });
        threadRunId = t.threadRunId;
        threadMetrics = {
          threadEnabled: true,
          candidatesIn: t.candidatesIn,
          threadsFormed: t.threadsFormed,
          rowsAbsorbed: t.rowsAbsorbed,
          threadFailedCalls: t.failedCalls,
        };
        threadGate = gateThread(
          {
            candidatesIn: t.candidatesIn,
            threadsFormed: t.threadsFormed,
            failedCalls: t.failedCalls,
          },
          cfg.thread,
        );
      }

      const pile = await assembleGroupingPile(r.id, threadRunId ?? undefined);
      const pileItems = pile.threadsInPile + pile.clustersInPile + pile.singletonsInPile;

      const pass1Metrics = { itemsIn: r.itemsIn, unscored, pileItems };
      return {
        stageRunId: r.id,
        metrics: {
          ...pass1Metrics,
          ...threadMetrics,
          pileId: pile.pileId,
          threadsInPile: pile.threadsInPile,
          clustersInPile: pile.clustersInPile,
          singletonsInPile: pile.singletonsInPile,
          scoreCutoff: pile.scoreCutoff,
        },
        gate: merge(gateGroupingPass1(pass1Metrics, cfg.grouping_pass1), threadGate),
        lineage: {
          groupingPass1RunId: r.id,
          threadRunId,
          pileId: pile.pileId,
          groupingRunId: r.groupingRunId,
        },
      };
    },
  },

  {
    name: "editor",
    async run(ctx) {
      const pool = getPool();
      const cfg = loadModelConfig().pipeline.gates.editor;
      const r = await runEditor(ctx.lineage.pileId !== null ? { pileId: ctx.lineage.pileId } : {});

      // Migration 040. NULL means a run before it, where the console was the
      // only record -- which is the state this whole runner exists to end.
      const { rows } = await pool.query<{
        tie_break_calls: number | null;
        tie_break_failed_calls: number | null;
      }>("SELECT tie_break_calls, tie_break_failed_calls FROM editor_runs WHERE id = $1", [r.id]);

      const metrics = {
        itemsIn: r.itemsIn,
        itemsFeature: r.itemsFeature,
        itemsStandard: r.itemsStandard,
        itemsBrief: r.itemsBrief,
        itemsCut: r.itemsCut,
        tieBreakCalls: rows[0]?.tie_break_calls ?? null,
        tieBreakFailedCalls: rows[0]?.tie_break_failed_calls ?? null,
      };
      return {
        stageRunId: r.id,
        metrics,
        gate: gateEditor(metrics, cfg),
        lineage: { editorRunId: r.id, pileId: r.pileId, groupingRunId: r.groupingRunId },
      };
    },
  },

  {
    name: "fetch-text",
    async run(ctx) {
      if (ctx.lineage.editorRunId === null) {
        return abortBecause("no editor run to fetch article text for");
      }
      const cfg = loadModelConfig().pipeline.gates.fetch;
      const r = await runArticleFetch({ editorRunId: ctx.lineage.editorRunId });

      // What the last run found in cooldown, so the gate can report the change
      // rather than the condition. This is the metrics column earning its keep:
      // it was added so thresholds could be tuned against history, and the same
      // history answers "is this new?".
      const previous = await previousCooldownHosts(ctx.pipelineRunId);
      const newlyCooledHosts =
        previous === null ? [] : r.cooldownHosts.filter((h) => !previous.has(h));

      const gate = gateFetch(
        {
          requested: r.requested,
          ok: r.ok,
          thin: r.thin,
          newlyCooledHosts,
          cooldownHosts: r.cooldownHosts,
        },
        cfg,
      );

      return {
        stageRunId: null,
        metrics: {
          considered: r.considered,
          requested: r.requested,
          hosts: r.hosts,
          ok: r.ok,
          thin: r.thin,
          blocked: r.blocked,
          error: r.error,
          skipped: r.skipped,
          cooldownHosts: r.cooldownHosts,
          newlyCooledHosts,
          charsBefore: r.charsBefore,
          charsAfter: r.charsAfter,
        },
        gate,
        lineage: {},
      };
    },
  },

  {
    name: "write",
    async run(ctx) {
      if (ctx.lineage.editorRunId === null) {
        return abortBecause("no editor run to write");
      }
      const config = loadModelConfig();
      const cfg = config.pipeline.gates.writers;
      const { repair_attempts, repair_delay_ms } = config.pipeline.writers;

      let summary = await runWriters({ editorRunId: ctx.lineage.editorRunId });

      // The breaker trips on a provider outage, not on hard material, and
      // --repair exists for exactly this: run #35 lost 32 pieces to five
      // budget-exhaustion calls and one repair pass recovered all 32. An
      // unattended run has nobody to type it, so it types it.
      let repairsRun = 0;
      for (let i = 0; i < repair_attempts && summary.piecesFailed > 0; i++) {
        console.log(
          `[pipeline] ${summary.piecesFailed} piece(s) failed — repair pass ${i + 1} of ` +
            `${repair_attempts} in ${Math.round(repair_delay_ms / 1000)}s`,
        );
        await new Promise((resolve) => setTimeout(resolve, repair_delay_ms));
        summary = await repairWriterRun(summary.runId);
        repairsRun++;
      }

      const metrics = {
        piecesIn: summary.piecesIn,
        piecesWritten: summary.piecesWritten,
        piecesFailed: summary.piecesFailed,
        failedCalls: summary.failedCalls,
        repairAttempts: repairsRun,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
      };
      return {
        stageRunId: summary.runId,
        metrics,
        gate: gateWriters(metrics, cfg),
        lineage: { writerRunId: summary.runId },
      };
    },
  },

  {
    name: "publish",
    async run(ctx) {
      if (ctx.lineage.writerRunId === null) {
        return abortBecause("no writer run to publish");
      }
      const cfg = loadModelConfig().pipeline.gates.publisher;
      const r = await runPublisher({ writerRunId: ctx.lineage.writerRunId });
      const metrics = {
        publishedOn: r.publishedOn,
        storyCount: r.storyCount,
        pieceCount: r.pieceCount,
        sourceCount: r.sourceCount,
        wordCount: r.wordCount,
        piecesSkipped: r.piecesSkipped,
        piecesUnsourced: r.piecesUnsourced,
        replaced: r.replaced,
        replacedPieceCount: r.replacedPieceCount,
      };
      return {
        stageRunId: r.paperId,
        metrics,
        gate: gatePublisher(
          {
            pieceCount: r.pieceCount,
            piecesSkipped: r.piecesSkipped,
            piecesUnsourced: r.piecesUnsourced,
          },
          cfg,
        ),
        lineage: { paperId: r.paperId },
      };
    },
  },
];
