import assert from "node:assert/strict";
import { loadModelConfig } from "../src/config/models.js";
import { applyWriterOverrides } from "../src/pipeline/writers/index.js";

const base = loadModelConfig().writers;

function testNoOverridesIsProduction() {
  assert.equal(applyWriterOverrides(base, undefined), base);
}

function testModelAndBudgetReplaced() {
  const cfg = applyWriterOverrides(base, { model: "deepseek/x", maxTokens: 16000 });
  assert.equal(cfg.model, "deepseek/x");
  assert.equal(cfg.max_tokens, 16000);
  // Everything not overridden is production's, so the comparison is the model alone.
  assert.equal(cfg.temperature, base.temperature);
  assert.equal(cfg.reasoning_effort, base.reasoning_effort);
  assert.equal(base.model, loadModelConfig().writers.model, "production config not mutated");
}

function testReasoningEffortOmitted() {
  // A model that rejects the field must be sent none at all, not "none".
  const cfg = applyWriterOverrides(base, { reasoningEffort: null });
  assert.equal("reasoning_effort" in cfg, false);
}

testNoOverridesIsProduction();
testModelAndBudgetReplaced();
testReasoningEffortOmitted();
console.log("writer override tests passed");
