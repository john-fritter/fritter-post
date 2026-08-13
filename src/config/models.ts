import { readFileSync } from "fs";
import path from "path";
import { parse } from "yaml";
import { z } from "zod";

const ProviderSchema = z.enum(["ollama-cloud", "nanogpt", "openrouter"]);

const TranslationConfigSchema = z.object({
  model: z.string(),
  provider: ProviderSchema.optional(),
  temperature: z.number(),
  max_tokens: z.number().int(),
  reasoning_effort: z.string().optional(),
  stream: z.boolean().optional(),
  timeout_ms: z.number().int().optional(),
  translation_batch_size: z.number().int(),
  concurrency: z.number().int(),
  retry_max_attempts: z.number().int().optional(),
  retry_base_ms: z.number().int().optional(),
});

// Deterministic preprocessor tuning (recency window + dedup lookback) plus
// per-item translation config for non-English items.
const PreprocessorConfigSchema = z.object({
  recency: z.object({
    window_hours: z.number().int().positive(),
    max_age_days: z.number().int().positive().nullable(),
  }),
  dedup: z.object({
    lookback_days: z.number().int().positive(),
  }),
  translation: TranslationConfigSchema,
});

const StageConfigSchema = z.object({
  model: z.string(),
  temperature: z.number(),
  max_tokens: z.number().int(),
  step_limit: z.number().int().optional(),
  reasoning_effort: z.string().optional(),
  provider: ProviderSchema.optional(),
  timeout_ms: z.number().int().optional(),
  stream: z.boolean().optional(),
});

const BatchStageConfigSchema = StageConfigSchema.extend({
  batch_size: z.number().int(),
  concurrency: z.number().int(),
  // Characters of item body shown to the model per item. Not optional: this is
  // the knob that decides how much a per-item judgment stage actually knows,
  // and leaving it implicit is how prefilter and grouping-pass-1 spent months
  // judging items on 50 characters.
  body_cap: z.number().int().nonnegative(),
  retry_max_attempts: z.number().int().optional(),
  retry_base_ms: z.number().int().optional(),
});

const EditorPass1StageConfigSchema = BatchStageConfigSchema.extend({
  singleton_pile_target: z.number().int(),
  // Characters of cluster describe-summary shown when scoring a cluster.
  // Separate from body_cap: a cluster's summary is already distilled, a
  // singleton's body is raw article text, and they want different budgets.
  summary_cap: z.number().int().nonnegative(),
});

const EditorTieBreakConfigSchema = z.object({
  model: z.string(),
  provider: ProviderSchema.optional(),
  temperature: z.number(),
  max_tokens: z.number().int(),
  concurrency: z.number().int(),
  reasoning_effort: z.string().optional(),
  stream: z.boolean().optional(),
  timeout_ms: z.number().int().optional(),
  // Characters of body/summary shown per item in a tie-break group.
  body_cap: z.number().int().nonnegative(),
});

const EditorStageConfigSchema = z.object({
  source_weight: z.number(),
  tiers: z.object({
    feature: z.number().int().positive(),
    standard: z.number().int().positive(),
    brief: z.number().int().positive(),
  }),
  tie_break: EditorTieBreakConfigSchema,
});

const EmbeddingsConfigSchema = z.object({
  model: z.string(),
  provider: ProviderSchema.optional(),
  dims: z.number().int(),
  batch_size: z.number().int(),
  timeout_ms: z.number().int().optional(),
});

const GroupingEmbeddingConfigSchema = z.object({
  body_cap: z.number().int(),
  similarity_threshold: z.number().min(0).max(1),
  top_k: z.number().int(),
});

const GroupingAttachConfigSchema = z.object({
  enabled: z.boolean(),
  candidate_floor: z.number().min(0).max(1),
  model: z.string(),
  provider: ProviderSchema.optional(),
  temperature: z.number(),
  max_tokens: z.number().int(),
  concurrency: z.number().int(),
  reasoning_effort: z.string().optional(),
  stream: z.boolean().optional(),
  timeout_ms: z.number().int().optional(),
  retry_max_attempts: z.number().int().optional(),
  retry_base_ms: z.number().int().optional(),
});

const GroupingDescribeConfigSchema = z.object({
  model: z.string(),
  provider: ProviderSchema.optional(),
  temperature: z.number(),
  max_tokens: z.number().int(),
  batch_size: z.number().int(),
  concurrency: z.number().int(),
  reasoning_effort: z.string().optional(),
  stream: z.boolean().optional(),
  timeout_ms: z.number().int().optional(),
  retry_max_attempts: z.number().int().optional(),
  retry_base_ms: z.number().int().optional(),
});

const GroupingSplitConfigSchema = z.object({
  enabled: z.boolean(),
  // Components below this connectedness are treated as possibly chained.
  density_floor: z.number().min(0).max(1),
  // Components smaller than this cannot be chained, so they are never examined.
  min_size: z.number().int().min(3),
  model: z.string(),
  provider: ProviderSchema.optional(),
  temperature: z.number(),
  max_tokens: z.number().int(),
  concurrency: z.number().int(),
  reasoning_effort: z.string().optional(),
  stream: z.boolean().optional(),
  timeout_ms: z.number().int().optional(),
  retry_max_attempts: z.number().int().optional(),
  retry_base_ms: z.number().int().optional(),
});

const GroupingStageConfigSchema = StageConfigSchema.extend({
  embedding: GroupingEmbeddingConfigSchema,
  split: GroupingSplitConfigSchema,
  attach: GroupingAttachConfigSchema,
  describe: GroupingDescribeConfigSchema,
  pile_target: z.number().int(),
});

const ThreadStageConfigSchema = StageConfigSchema.extend({
  enabled: z.boolean(),
  // Top-scoring grouping-pass-1 rows offered to the pass. Bounded by what one
  // LLM call can hold, not by cost — see runThreading on why it is one call.
  candidate_target: z.number().int(),
  // Characters of cluster summary / singleton body shown per candidate. One
  // call holds the whole candidate set, so this multiplies by candidate_target.
  summary_cap: z.number().int().nonnegative(),
  retry_max_attempts: z.number().int().optional(),
  retry_base_ms: z.number().int().optional(),
});

const ModelsConfigSchema = z.object({
  preprocessor: PreprocessorConfigSchema,
  prefilter: BatchStageConfigSchema,
  editor: EditorStageConfigSchema,
  thread: ThreadStageConfigSchema,
  writers: StageConfigSchema,
  editor_pass_1: EditorPass1StageConfigSchema,
  embeddings: EmbeddingsConfigSchema,
  grouping: GroupingStageConfigSchema,
});

export type TranslationConfig = z.infer<typeof TranslationConfigSchema>;
export type PreprocessorConfig = z.infer<typeof PreprocessorConfigSchema>;
export type StageConfig = z.infer<typeof StageConfigSchema>;
export type BatchStageConfig = z.infer<typeof BatchStageConfigSchema>;
export type EditorPass1StageConfig = z.infer<typeof EditorPass1StageConfigSchema>;
export type EditorTieBreakConfig = z.infer<typeof EditorTieBreakConfigSchema>;
export type EditorStageConfig = z.infer<typeof EditorStageConfigSchema>;
export type ThreadStageConfig = z.infer<typeof ThreadStageConfigSchema>;
export type EmbeddingsConfig = z.infer<typeof EmbeddingsConfigSchema>;
export type GroupingEmbeddingConfig = z.infer<typeof GroupingEmbeddingConfigSchema>;
export type GroupingAttachConfig = z.infer<typeof GroupingAttachConfigSchema>;
export type GroupingSplitConfig = z.infer<typeof GroupingSplitConfigSchema>;
export type GroupingDescribeConfig = z.infer<typeof GroupingDescribeConfigSchema>;
export type GroupingStageConfig = z.infer<typeof GroupingStageConfigSchema>;
export type ModelsConfig = z.infer<typeof ModelsConfigSchema>;

const MODELS_PATH = path.join(
  import.meta.dirname,
  "..",
  "..",
  "config",
  "models.yaml"
);

let cached: ModelsConfig | null = null;

export function loadModelConfig(): ModelsConfig {
  if (cached) return cached;
  const raw = readFileSync(MODELS_PATH, "utf-8");
  cached = ModelsConfigSchema.parse(parse(raw));
  return cached;
}
