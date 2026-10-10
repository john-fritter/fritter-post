import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { loadModelConfig, type PricingConfig } from "../src/config/models.js";
import {
  LOG_STAGE_STEP,
  buildPriceView,
  calledModels,
  costUsd,
  duplicatePricedIds,
  findPrice,
  formatRate,
  formatSpan,
  formatStepTime,
  formatTokenWords,
  formatTokens,
  formatUsd,
  siteName,
  stepDuration,
} from "../src/pipeline/publish/price.js";
import type { PaperCostRow, PaperPrice, PaperStepRow } from "../src/pipeline/publish/read.js";

const PRICING: PricingConfig = {
  models: [
    {
      name: "GLM-5.2",
      maker: "Z.ai",
      ids: { "zai-org/glm-5.2": "GLM-5.2", "zai-org/glm-5.2:thinking": "GLM-5.2 (thinking)" },
      input_per_mtok: 1.4,
      output_per_mtok: 4.4,
      source: "https://example.com/zai",
      as_of: "2026-10-10",
    },
    {
      name: "Embed",
      maker: "Alibaba",
      ids: { "qwen/embed": "Embed" },
      input_per_mtok: 0.01,
      output_per_mtok: 0,
      source: "https://example.com/or",
      as_of: "2026-10-01",
    },
  ],
};

// --- the real config: every model the pipeline calls has a price ------------

function testEveryCalledModelHasAPrice() {
  // Unpriced is shown as unpriced, never as free -- but a model the pipeline
  // calls every morning should never get that far. Swapping a stage's model in
  // models.yaml without adding its price fails here, not on the front page.
  const cfg = loadModelConfig();
  const missing = calledModels(cfg).filter((m) => findPrice(cfg.pricing, m) === null);
  assert.deepEqual(missing, [], `no list price for: ${missing.join(", ")}`);
}

function testNoModelIsPricedTwice() {
  // findPrice takes the first match, so a second entry would be silently dead.
  assert.deepEqual(duplicatePricedIds(loadModelConfig().pricing), []);
  const twice: PricingConfig = { models: [PRICING.models[0]!, { ...PRICING.models[0]!, name: "Again" }] };
  assert.deepEqual(duplicatePricedIds(twice).sort(), ["zai-org/glm-5.2", "zai-org/glm-5.2:thinking"]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

function testEveryLoggedStageLabelHasAStep() {
  // The price finds a paper's calls by (stage label, run id). A stage that
  // starts logging under a new label would drop out of the price without an
  // error anywhere, so every label written in src/ must be placed or listed
  // here as one that never belongs to a paper.
  const notAPapersCall = new Set(["continuity-check"]);
  const src = path.join(import.meta.dirname, "..", "src", "pipeline");
  const labels = new Set<string>();
  for (const file of sourceFiles(src)) {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const m = /\bstage:\s*([^,]*)/.exec(line);
      if (!m) continue;
      for (const q of m[1]!.matchAll(/"([a-z][a-z0-9-]*)"/g)) labels.add(q[1]!);
    }
  }
  // Translation passes its label positionally rather than as `stage:`.
  labels.add("preprocess");
  assert.ok(labels.size > 5, `found too few stage labels (${labels.size}); the scan is broken`);
  const unplaced = [...labels].filter((l) => !(l in LOG_STAGE_STEP) && !notAPapersCall.has(l));
  assert.deepEqual(unplaced, [], `stage labels with no price step: ${unplaced.join(", ")}`);
}

// --- the arithmetic ---------------------------------------------------------

function testCostIsTokensTimesTheListPrice() {
  const glm = findPrice(PRICING, "zai-org/glm-5.2")!;
  assert.equal(costUsd(1_000_000, 1_000_000, glm), 5.8);
  assert.equal(costUsd(250_000, 0, glm), 0.35);
  assert.equal(costUsd(0, 0, glm), 0);
}

function testOneEntryPricesSeveralIds() {
  const plain = findPrice(PRICING, "zai-org/glm-5.2")!;
  const thinking = findPrice(PRICING, "zai-org/glm-5.2:thinking")!;
  assert.equal(plain.label, "GLM-5.2");
  assert.equal(thinking.label, "GLM-5.2 (thinking)");
  assert.equal(thinking.name, "GLM-5.2");
  assert.equal(thinking.outputPerMtok, 4.4);
  assert.equal(findPrice(PRICING, "someone/else"), null);
}

function testTheRunnerRowIsPreferredForTime() {
  // The runner times score with its novelty and thread passes, and publish with
  // continuity; the run tables do not.
  const t0 = new Date("2026-10-10T13:00:00Z");
  const t1 = new Date("2026-10-10T13:04:00Z");
  const t2 = new Date("2026-10-10T13:02:00Z");
  assert.deepEqual(stepDuration({ startedAt: t0, completedAt: t1 }, { startedAt: t0, completedAt: t2 }), {
    startedAt: t0,
    durationMs: 240_000,
  });
  assert.deepEqual(stepDuration(null, { startedAt: t0, completedAt: t2 }), { startedAt: t0, durationMs: 120_000 });
  // Unknown is unknown, not zero.
  assert.deepEqual(stepDuration(null, { startedAt: t0, completedAt: null }), { startedAt: t0, durationMs: null });
  assert.deepEqual(stepDuration(null, { startedAt: t1, completedAt: t0 }), { startedAt: t1, durationMs: null });
}

// --- formatting -------------------------------------------------------------

function testFormatting() {
  assert.equal(formatUsd(6.6789), "$6.68");
  assert.equal(formatUsd(0), "$0.00");
  // A real cost must not print as nothing.
  assert.equal(formatUsd(0.0031), "<$0.01");
  assert.equal(formatUsd(0.006), "$0.01");

  assert.equal(formatRate(1.4), "$1.40");
  assert.equal(formatRate(0.248), "$0.248");
  assert.equal(formatRate(1.485), "$1.485");
  assert.equal(formatRate(0.01), "$0.01");
  assert.equal(formatRate(0), "$0.00");

  assert.equal(formatTokens(640), "640");
  assert.equal(formatTokens(86_400), "86K");
  assert.equal(formatTokens(999_600), "1.0M");
  assert.equal(formatTokens(2_040_000), "2.0M");
  assert.equal(formatTokenWords(5_090_000), "5.1 million");
  assert.equal(formatTokenWords(640_000), "640 thousand");

  assert.equal(formatStepTime(20_000), "under 1 min");
  assert.equal(formatStepTime(300_000), "5 min");
  assert.equal(formatSpan(21 * 60_000), "21 minutes");
  assert.equal(formatSpan(60_000), "1 minute");
  assert.equal(formatSpan(10_000), "1 minute");
  assert.equal(formatSpan(192 * 60_000), "3 hours 12 minutes");
  assert.equal(formatSpan(60 * 60_000), "1 hour");

  assert.equal(siteName("https://docs.z.ai/guides/overview/pricing"), "z.ai");
  assert.equal(siteName("https://www.alibabacloud.com/help/en/model-studio/model-pricing"), "alibabacloud.com");
  assert.equal(siteName("https://api-docs.deepseek.com/quick_start/pricing"), "deepseek.com");
}

// --- the page's view --------------------------------------------------------

function cost(over: Partial<PaperCostRow>): PaperCostRow {
  return {
    step: "screen", model: "zai-org/glm-5.2", calls: 1, failedCalls: 0,
    inputTokens: 0, outputTokens: 0, modelMs: 0,
    modelLabel: "GLM-5.2", modelName: "GLM-5.2", maker: "Z.ai",
    inputPerMtok: 1.4, outputPerMtok: 4.4,
    priceSource: "https://example.com/zai", priceAsOf: "2026-10-10", costUsd: 0,
    ...over,
  };
}

function step(s: string, durationMs: number | null, itemsOut: number | null = null): PaperStepRow {
  return { step: s, startedAt: durationMs === null ? null : new Date("2026-10-10T13:00:00Z"), durationMs, itemsOut, sources: null };
}

function testTheViewSumsStepsAndGroupsModels() {
  const price: PaperPrice = {
    steps: [
      step("collect", 60_000, 1412), step("preprocess", 300_000), step("screen", 120_000),
      step("cluster", 120_000), step("score", 240_000), step("rank", 120_000),
      step("fetch", null), step("write", 240_000), step("publish", 30_000),
    ],
    costs: [
      cost({ step: "score", model: "zai-org/glm-5.2:thinking", modelLabel: "GLM-5.2 (thinking)", calls: 59, inputTokens: 554_000, outputTokens: 440_000, modelMs: 4_000_000, costUsd: 2.71 }),
      cost({ step: "screen", calls: 30, inputTokens: 252_000, outputTokens: 38_000, modelMs: 900_000, costUsd: 0.52 }),
      cost({ step: "cluster", model: "qwen/embed", modelLabel: "Embed", modelName: "Embed", maker: "Alibaba", inputPerMtok: 0.01, outputPerMtok: 0, priceSource: "https://example.com/or", priceAsOf: "2026-10-01", calls: 8, inputTokens: 610_000, costUsd: 0.0061 }),
      cost({ step: "cluster", calls: 96, inputTokens: 310_000, outputTokens: 72_000, costUsd: 0.75 }),
      cost({ step: "write", model: "mystery/model", modelLabel: null, modelName: null, maker: null, inputPerMtok: null, outputPerMtok: null, priceSource: null, priceAsOf: null, calls: 152, inputTokens: 1_240_000, outputTokens: 760_000, costUsd: null }),
    ],
    tiers: { feature: 12, standard: 38, brief: 84 },
  };
  const v = buildPriceView(price);

  assert.equal(v.totalUsd.toFixed(4), (2.71 + 0.52 + 0.0061 + 0.75).toFixed(4));
  assert.equal(v.calls, 59 + 30 + 8 + 96 + 152);
  assert.equal(v.workMs, 60_000 + 300_000 + 120_000 * 3 + 240_000 * 2 + 30_000);
  assert.equal(v.modelMs, 4_900_000);

  // Steps are in pipeline order, each with its share of the dearest step.
  assert.deepEqual(v.steps.map((s) => s.step), [
    "collect", "preprocess", "screen", "cluster", "score", "rank", "fetch", "write", "publish",
  ]);
  const score = v.steps.find((s) => s.step === "score")!;
  assert.equal(score.share, 1);
  assert.deepEqual(score.models, ["GLM-5.2 (thinking)"]);
  const cluster = v.steps.find((s) => s.step === "cluster")!;
  assert.deepEqual(cluster.models, ["Embed", "GLM-5.2"]);
  assert.equal(v.steps.find((s) => s.step === "collect")!.costUsd, 0);
  assert.equal(v.steps.find((s) => s.step === "collect")!.itemsOut, 1412);
  assert.equal(v.steps.find((s) => s.step === "fetch")!.durationMs, null);

  // Both GLM IDs bill at one price, so the model table has one GLM row.
  const glm = v.models.find((m) => m.name === "GLM-5.2")!;
  assert.deepEqual(glm.steps, ["screen", "cluster", "score"]);
  assert.equal(glm.costUsd!.toFixed(2), "3.98");
  assert.equal(v.models[0]!.name, "GLM-5.2");

  // Unpriced is not free: it has no cost, sorts last, and is named.
  const mystery = v.models.at(-1)!;
  assert.equal(mystery.name, "mystery/model");
  assert.equal(mystery.costUsd, null);
  assert.deepEqual(v.unpriced, ["mystery/model"]);
  assert.equal(v.steps.find((s) => s.step === "write")!.costUsd, 0);

  // One source per price page, named by site, and the newest as-of date.
  assert.deepEqual(v.sources.map((s) => s.url), ["https://example.com/zai", "https://example.com/or"]);
  assert.deepEqual(v.sources.map((s) => s.site), ["example.com", "example.com"]);
  assert.equal(v.pricesAsOf, "2026-10-10");
}

function testAPaperWithNoCallsStillHasAView() {
  const v = buildPriceView({ steps: [step("collect", 60_000)], costs: [], tiers: { feature: 0, standard: 0, brief: 0 } });
  assert.equal(v.totalUsd, 0);
  assert.equal(v.steps.every((s) => s.share === 0), true);
  assert.deepEqual(v.models, []);
}

testEveryCalledModelHasAPrice();
testNoModelIsPricedTwice();
testEveryLoggedStageLabelHasAStep();
testCostIsTokensTimesTheListPrice();
testOneEntryPricesSeveralIds();
testTheRunnerRowIsPreferredForTime();
testFormatting();
testTheViewSumsStepsAndGroupsModels();
testAPaperWithNoCallsStillHasAView();
console.log("paper-price: 9 tests passed");
