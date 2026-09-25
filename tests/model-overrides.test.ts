import assert from "node:assert/strict";
import { loadModelConfig } from "../src/config/models.js";
import { applyModelOverrides, overridesFromFlags, withModel } from "../src/config/overrides.js";

const writers = loadModelConfig().writers;
const rerun = loadModelConfig().rerun;

function testNoOverridesIsProduction() {
  assert.equal(applyModelOverrides(writers, undefined), writers);
  assert.equal(overridesFromFlags({ "editor-run": "143" }), undefined);
}

function testModelAndBudgetReplaced() {
  const cfg = applyModelOverrides(writers, { model: "deepseek/x", maxTokens: 16000 });
  assert.equal(cfg.model, "deepseek/x");
  assert.equal(cfg.max_tokens, 16000);
  // Everything not overridden is production's, so the comparison is the model alone.
  assert.equal(cfg.temperature, writers.temperature);
  assert.equal(cfg.reasoning_effort, writers.reasoning_effort);
  assert.equal(writers.model, loadModelConfig().writers.model, "production config not mutated");
}

function testReasoningEffortOmitted() {
  // A model that rejects the field must be sent none at all, not "none".
  const cfg = applyModelOverrides(rerun, overridesFromFlags({ "reasoning-effort": "omit" }));
  assert.equal("reasoning_effort" in cfg, false);
  // And the judge's own settings survive.
  assert.equal(cfg.batch_size, rerun.batch_size);
  assert.equal(cfg.candidate_floor, rerun.candidate_floor);
}

function testFlagsParsed() {
  assert.deepEqual(
    overridesFromFlags({ model: "z-ai/glm-5.3", "reasoning-effort": "low", "max-tokens": "8000" }),
    { model: "z-ai/glm-5.3", reasoningEffort: "low", maxTokens: 8000 },
  );
  assert.throws(() => overridesFromFlags({ provider: "anthropic" }));
  assert.throws(() => overridesFromFlags({ "max-tokens": "lots" }));
  assert.deepEqual(overridesFromFlags({ "timeout-ms": "900000" }), { timeoutMs: 900000 });
  assert.throws(() => overridesFromFlags({ "timeout-ms": "forever" }));
  assert.equal(applyModelOverrides(writers, { timeoutMs: 900000 }).timeout_ms, 900000);
}

function testWithModelFoldsOldFlag() {
  assert.equal(withModel(undefined, undefined), undefined);
  assert.deepEqual(withModel(undefined, "x/y"), { model: "x/y" });
  assert.deepEqual(
    withModel({ reasoningEffort: "high" }, "x/y"),
    { reasoningEffort: "high", model: "x/y" },
  );
}

testNoOverridesIsProduction();
testWithModelFoldsOldFlag();
testModelAndBudgetReplaced();
testReasoningEffortOmitted();
testFlagsParsed();
console.log("model override tests passed");
