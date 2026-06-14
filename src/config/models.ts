import { readFileSync } from "fs";
import path from "path";
import { parse } from "yaml";
import { z } from "zod";

const ProviderSchema = z.enum(["ollama-cloud", "nanogpt", "openrouter"]);

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

const FilterStageConfigSchema = StageConfigSchema.extend({
  batch_size: z.number().int(),
  concurrency: z.number().int(),
});

const EditorPass1StageConfigSchema = FilterStageConfigSchema.extend({
  singleton_pile_target: z.number().int(),
});

const EditorFallbackConfigSchema = z.object({
  model: z.string(),
  provider: ProviderSchema.optional(),
  reasoning_effort: z.string().optional(),
});

const EditorStageConfigSchema = StageConfigSchema.extend({
  fallback: EditorFallbackConfigSchema.optional(),
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

const GroupingRefineConfigSchema = z.object({
  enabled: z.boolean(),
  min_group_size: z.number().int(),
  concurrency: z.number().int(),
});

const GroupingAttachConfigSchema = z.object({
  enabled: z.boolean(),
  attach_floor: z.number().min(0).max(1),
  model: z.string(),
  provider: ProviderSchema.optional(),
  temperature: z.number(),
  max_tokens: z.number().int(),
  concurrency: z.number().int(),
  reasoning_effort: z.string().optional(),
  stream: z.boolean().optional(),
  timeout_ms: z.number().int().optional(),
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
});

const GroupingStageConfigSchema = StageConfigSchema.extend({
  embedding: GroupingEmbeddingConfigSchema,
  refine: GroupingRefineConfigSchema,
  attach: GroupingAttachConfigSchema,
  describe: GroupingDescribeConfigSchema,
  pile_target: z.number().int(),
});

const ModelsConfigSchema = z.object({
  filter: FilterStageConfigSchema,
  prefilter: FilterStageConfigSchema,
  researcher: StageConfigSchema,
  editor: EditorStageConfigSchema,
  writers: StageConfigSchema,
  editor_pass_1: EditorPass1StageConfigSchema,
  embeddings: EmbeddingsConfigSchema,
  grouping: GroupingStageConfigSchema,
  pile_merge: StageConfigSchema,
});

export type StageConfig = z.infer<typeof StageConfigSchema>;
export type FilterStageConfig = z.infer<typeof FilterStageConfigSchema>;
export type EditorPass1StageConfig = z.infer<typeof EditorPass1StageConfigSchema>;
export type EditorFallbackConfig = z.infer<typeof EditorFallbackConfigSchema>;
export type EditorStageConfig = z.infer<typeof EditorStageConfigSchema>;
export type EmbeddingsConfig = z.infer<typeof EmbeddingsConfigSchema>;
export type GroupingEmbeddingConfig = z.infer<typeof GroupingEmbeddingConfigSchema>;
export type GroupingRefineConfig = z.infer<typeof GroupingRefineConfigSchema>;
export type GroupingAttachConfig = z.infer<typeof GroupingAttachConfigSchema>;
export type GroupingDescribeConfig = z.infer<typeof GroupingDescribeConfigSchema>;
export type GroupingStageConfig = z.infer<typeof GroupingStageConfigSchema>;
export type PileMergeStageConfig = StageConfig;
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
