/**
 * The paper's price: pure parts.
 *
 * Every model call the paper took is logged with its tokens. Multiply those by
 * each model's list price (config/models.yaml `pricing`) and sum, and that is
 * the price printed in the masthead. It is an estimate of what the paper would
 * cost at published API prices, not what it costs to run: the models are
 * reached through a flat-rate subscription.
 *
 * This file is the arithmetic and the formatting, so it can be tested without
 * a database. price-record.ts walks a paper's lineage to its calls and freezes
 * the result; read.ts loads it back for the reading view.
 */

import type { ModelsConfig, PricingConfig } from "../../config/models.js";
import type { PaperPrice } from "./read.js";

/** The runner's stages, in order. These are what the /price page lists. */
export const PRICE_STEPS = [
  "collect", "preprocess", "screen", "cluster", "score",
  "rank", "fetch", "write", "publish",
] as const;
export type PriceStep = (typeof PRICE_STEPS)[number];

/**
 * Which step a generation_logs stage label belongs to. Novelty and thread run
 * inside score, and continuity inside publish, which is how the runner counts
 * them too. A label missing here is a call this table cannot place, and the
 * test that lists every label in src/ fails before that can happen silently.
 */
export const LOG_STAGE_STEP: Readonly<Record<string, PriceStep>> = {
  preprocess: "preprocess",
  screen: "screen",
  cluster: "cluster",
  score: "score",
  novelty: "score",
  thread: "score",
  "rank-tie-break": "rank",
  write: "write",
  "write-briefs": "write",
  continuity: "publish",
};

export interface ModelPrice {
  /** How the step names this model ID ("GLM-5.2 (thinking)"). */
  label: string;
  /** The price entry's name, shared by every ID billed at it ("GLM-5.2"). */
  name: string;
  maker: string;
  inputPerMtok: number;
  outputPerMtok: number;
  source: string;
  asOf: string;
}

/** The list price for a logged model ID, or null when config has none. */
export function findPrice(pricing: PricingConfig, model: string): ModelPrice | null {
  for (const entry of pricing.models) {
    const label = entry.ids[model];
    if (label === undefined) continue;
    return {
      label,
      name: entry.name,
      maker: entry.maker,
      inputPerMtok: entry.input_per_mtok,
      outputPerMtok: entry.output_per_mtok,
      source: entry.source,
      asOf: entry.as_of,
    };
  }
  return null;
}

/** Model IDs listed under more than one price entry. The first would win. */
export function duplicatePricedIds(pricing: PricingConfig): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const entry of pricing.models) {
    for (const id of Object.keys(entry.ids)) {
      if (seen.has(id)) dupes.add(id);
      seen.add(id);
    }
  }
  return [...dupes];
}

const TOKENS_PER_MTOK = 1_000_000;

export function costUsd(
  inputTokens: number,
  outputTokens: number,
  price: Pick<ModelPrice, "inputPerMtok" | "outputPerMtok">,
): number {
  return (inputTokens * price.inputPerMtok + outputTokens * price.outputPerMtok) / TOKENS_PER_MTOK;
}

/**
 * Every model the pipeline calls in production, from the config entries that
 * reach callLLM or embed. Explicit rather than a walk over the whole file:
 * `cluster.model` exists only to satisfy the shared stage schema and is never
 * called, and a walk would demand a price for it.
 */
export function calledModels(cfg: ModelsConfig): string[] {
  return [
    cfg.preprocess.translation.model,
    cfg.screen.model,
    cfg.embeddings.model,
    cfg.cluster.split.model,
    cfg.cluster.attach.model,
    cfg.cluster.describe.model,
    cfg.score.model,
    cfg.novelty.model,
    cfg.thread.model,
    cfg.rank.tie_break.model,
    cfg.write.model,
    cfg.publish.continuity.adjudicate.model,
  ];
}

/**
 * How long a step took. The runner's own row is preferred: it times the stage
 * as the pipeline ran it, including the parts with no run row of their own
 * (score's novelty and thread passes, write's repair, publish's continuity).
 * The run table is the fallback for a paper made by hand.
 */
export function stepDuration(
  runner: { startedAt: Date; completedAt: Date } | null,
  fallback: { startedAt: Date | null; completedAt: Date | null },
): { startedAt: Date | null; durationMs: number | null } {
  if (runner) {
    return { startedAt: runner.startedAt, durationMs: runner.completedAt.getTime() - runner.startedAt.getTime() };
  }
  const { startedAt, completedAt } = fallback;
  if (startedAt === null || completedAt === null || completedAt < startedAt) {
    return { startedAt, durationMs: null };
  }
  return { startedAt, durationMs: completedAt.getTime() - startedAt.getTime() };
}

// --- the page's view of a frozen price --------------------------------------

export interface StepView {
  step: PriceStep;
  /** Sum of priced calls. Zero for a step that calls no model. */
  costUsd: number;
  /** This step's cost as a fraction of the most expensive step's, for its bar. */
  share: number;
  calls: number;
  tokens: number;
  /** The models this step called, as the price list names them, in call order. */
  models: string[];
  durationMs: number | null;
  itemsOut: number | null;
  sources: number | null;
}

export interface ModelView {
  name: string;
  maker: string | null;
  inputPerMtok: number | null;
  outputPerMtok: number | null;
  outputTokens: number;
  /** Null when the model has no list price. */
  costUsd: number | null;
  share: number;
  steps: PriceStep[];
  source: string | null;
}

export interface PriceView {
  totalUsd: number;
  calls: number;
  tokens: number;
  /** Summed call time: more than the run took, because calls overlap. */
  modelMs: number;
  /** Summed step time, over the steps whose time is known. */
  workMs: number;
  startedAt: Date | null;
  steps: StepView[];
  models: ModelView[];
  /** Price pages, one per URL, in model-table order, named by site. */
  sources: Array<{ site: string; url: string }>;
  /** The newest as-of date among the prices used, YYYY-MM-DD. */
  pricesAsOf: string | null;
  unpriced: string[];
}

/**
 * "z.ai" for https://docs.z.ai/..., "alibabacloud.com" for www.alibabacloud.com.
 * Named by site rather than maker because two models from one maker can be
 * priced on two sites (Alibaba's own, and OpenRouter's for the embedding).
 */
export function siteName(url: string): string {
  try {
    return new URL(url).hostname.split(".").slice(-2).join(".");
  } catch {
    return url;
  }
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

export function buildPriceView(price: PaperPrice): PriceView {
  const stepIndex = (s: string) => PRICE_STEPS.indexOf(s as PriceStep);
  const costs = [...price.costs].sort((a, b) => stepIndex(a.step) - stepIndex(b.step));

  const steps: StepView[] = PRICE_STEPS.map((step) => {
    const row = price.steps.find((s) => s.step === step);
    const mine = costs.filter((c) => c.step === step);
    const models: string[] = [];
    for (const c of mine) {
      const label = c.modelLabel ?? c.model;
      if (!models.includes(label)) models.push(label);
    }
    return {
      step,
      costUsd: mine.reduce((a, c) => a + (c.costUsd ?? 0), 0),
      share: 0,
      calls: mine.reduce((a, c) => a + c.calls, 0),
      tokens: mine.reduce((a, c) => a + c.inputTokens + c.outputTokens, 0),
      models,
      durationMs: row?.durationMs ?? null,
      itemsOut: row?.itemsOut ?? null,
      sources: row?.sources ?? null,
    };
  });
  const maxStep = Math.max(0, ...steps.map((s) => s.costUsd));
  for (const s of steps) s.share = ratio(s.costUsd, maxStep);

  const byName = new Map<string, ModelView>();
  for (const c of costs) {
    const name = c.modelName ?? c.model;
    let m = byName.get(name);
    if (!m) {
      m = {
        name,
        maker: c.maker,
        inputPerMtok: c.inputPerMtok,
        outputPerMtok: c.outputPerMtok,
        outputTokens: 0,
        costUsd: c.costUsd === null ? null : 0,
        share: 0,
        steps: [],
        source: c.priceSource,
      };
      byName.set(name, m);
    }
    m.outputTokens += c.outputTokens;
    if (m.costUsd !== null && c.costUsd !== null) m.costUsd += c.costUsd;
    const step = c.step as PriceStep;
    if (!m.steps.includes(step)) m.steps.push(step);
  }
  const models = [...byName.values()].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));
  const maxModel = Math.max(0, ...models.map((m) => m.costUsd ?? 0));
  for (const m of models) m.share = ratio(m.costUsd ?? 0, maxModel);

  const sources: Array<{ site: string; url: string }> = [];
  for (const m of models) {
    if (m.source && !sources.some((s) => s.url === m.source)) {
      sources.push({ site: siteName(m.source), url: m.source });
    }
  }
  const asOfs = costs.map((c) => c.priceAsOf).filter((d): d is string => d !== null).sort();

  return {
    totalUsd: steps.reduce((a, s) => a + s.costUsd, 0),
    calls: steps.reduce((a, s) => a + s.calls, 0),
    tokens: steps.reduce((a, s) => a + s.tokens, 0),
    modelMs: costs.reduce((a, c) => a + c.modelMs, 0),
    workMs: steps.reduce((a, s) => a + (s.durationMs ?? 0), 0),
    startedAt: price.steps.find((s) => s.startedAt !== null)?.startedAt ?? null,
    steps,
    models,
    sources,
    pricesAsOf: asOfs.at(-1) ?? null,
    unpriced: models.filter((m) => m.costUsd === null).map((m) => m.name),
  };
}

// --- formatting, for the reading view ---------------------------------------

/** "$6.68". A real cost under half a cent reads "<$0.01", not "$0.00". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** A per-million rate: "$1.40", "$0.248", "$0.01". */
export function formatRate(usd: number): string {
  const s = usd.toFixed(3);
  return `$${s.endsWith("0") ? s.slice(0, -1) : s}`;
}

/** "86K", "2.0M", "640". */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  const k = Math.round(n / 1_000);
  if (k < 1_000) return `${k}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "5.1 million", "640 thousand". For prose. */
export function formatTokenWords(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} million`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} thousand`;
  return String(n);
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/** A step's time: "5 min", "under 1 min". */
export function formatStepTime(ms: number): string {
  if (ms < MS_PER_MINUTE) return "under 1 min";
  return `${Math.round(ms / MS_PER_MINUTE)} min`;
}

/** A long span in words: "21 minutes", "3 hours 12 minutes", "1 hour". */
export function formatSpan(ms: number): string {
  const total = Math.max(1, Math.round(ms / MS_PER_MINUTE));
  const hours = Math.floor(total / MINUTES_PER_HOUR);
  const minutes = total % MINUTES_PER_HOUR;
  const m = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (hours === 0) return m;
  const h = `${hours} hour${hours === 1 ? "" : "s"}`;
  return minutes === 0 ? h : `${h} ${m}`;
}
