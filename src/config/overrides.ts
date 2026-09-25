/**
 * Model-comparison overrides for one run of an LLM stage.
 *
 * Production reads every model setting from `config/models.yaml`; a comparison
 * needs the same stage, on the same input, with only the model changed. These
 * replace the model-shaped fields of a stage config for that one run and leave
 * everything else — prompt caps, temperature, retries — as production has it, so
 * the difference measured is the model.
 */

import type { LLMProvider } from "../llm/index.js";

export interface ModelOverrides {
  model?: string;
  provider?: LLMProvider;
  /** null sends no reasoning_effort at all, for a model that rejects the field. */
  reasoningEffort?: string | null;
  maxTokens?: number;
  /** Per-call ceiling. A higher reasoning level can outlast production's. */
  timeoutMs?: number;
}

interface ModelShapedConfig {
  model: string;
  provider?: LLMProvider;
  reasoning_effort?: string;
  max_tokens: number;
  timeout_ms?: number;
}

/** Pure: the stage config with a comparison run's overrides applied. */
export function applyModelOverrides<T extends ModelShapedConfig>(
  cfg: T,
  overrides: ModelOverrides | undefined,
): T {
  if (!overrides) return cfg;
  const next: T = { ...cfg };
  if (overrides.model !== undefined) next.model = overrides.model;
  if (overrides.provider !== undefined) next.provider = overrides.provider;
  if (overrides.maxTokens !== undefined) next.max_tokens = overrides.maxTokens;
  if (overrides.timeoutMs !== undefined) next.timeout_ms = overrides.timeoutMs;
  if (overrides.reasoningEffort === null) delete next.reasoning_effort;
  else if (overrides.reasoningEffort !== undefined) next.reasoning_effort = overrides.reasoningEffort;
  return next;
}

/**
 * Folds a stage's older `--model`-only override into the full override set, so
 * a script that has always taken `--model` keeps doing so.
 */
export function withModel(
  overrides: ModelOverrides | undefined,
  modelOverride: string | undefined,
): ModelOverrides | undefined {
  if (modelOverride === undefined) return overrides;
  return { ...overrides, model: modelOverride };
}

const PROVIDERS: LLMProvider[] = ["ollama-cloud", "nanogpt", "openrouter"];

/**
 * Reads --model / --provider / --reasoning-effort <level|omit> / --max-tokens /
 * --timeout-ms from a flag map. Undefined when none is given, so production runs stay
 * untouched.
 */
export function overridesFromFlags(flags: Record<string, string>): ModelOverrides | undefined {
  const { model, provider } = flags;
  const effort = flags["reasoning-effort"];
  const maxTokens = flags["max-tokens"];
  const timeoutMs = flags["timeout-ms"];
  if (!model && !provider && !effort && !maxTokens && !timeoutMs) return undefined;
  if (provider && !PROVIDERS.includes(provider as LLMProvider)) {
    throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}, got "${provider}"`);
  }
  const tokens = maxTokens ? parseInt(maxTokens, 10) : undefined;
  if (tokens !== undefined && !Number.isFinite(tokens)) {
    throw new Error(`--max-tokens must be a number, got "${maxTokens}"`);
  }
  const timeout = timeoutMs ? parseInt(timeoutMs, 10) : undefined;
  if (timeout !== undefined && !Number.isFinite(timeout)) {
    throw new Error(`--timeout-ms must be a number, got "${timeoutMs}"`);
  }
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider: provider as LLMProvider } : {}),
    ...(effort ? { reasoningEffort: effort === "omit" ? null : effort } : {}),
    ...(tokens !== undefined ? { maxTokens: tokens } : {}),
    ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
  };
}
