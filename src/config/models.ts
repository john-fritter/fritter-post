import { readFileSync } from "fs";
import path from "path";
import { parse } from "yaml";
import { z } from "zod";

const StageConfigSchema = z.object({
  model: z.string(),
  temperature: z.number(),
  max_tokens: z.number().int(),
  step_limit: z.number().int().optional(),
  reasoning_effort: z.string().optional(),
  provider: z.enum(["ollama-cloud", "nanogpt"]).optional(),
  timeout_ms: z.number().int().optional(),
});

const FilterStageConfigSchema = StageConfigSchema.extend({
  batch_size: z.number().int(),
  concurrency: z.number().int(),
});

const SpineSchema = z.object({
  name: z.string(),
  groups: z.array(z.string()).min(1),
});

const SemanticMergeConfigSchema = z.object({
  enabled: z.boolean(),
  model: z.string(),
  max_tokens: z.number().int(),
  reasoning_effort: z.string().optional(),
  max_singletons: z.number().int(),
  max_cluster_share: z.number().min(0).max(1),
});

const TriageStageConfigSchema = StageConfigSchema.extend({
  clustering: z.object({
    seed: z.array(z.string()).min(1),
    spines: z.array(SpineSchema).min(1),
    max_concurrent_spines: z.number().int(),
    semantic_merge: SemanticMergeConfigSchema,
  }),
});

const EditorPass1StageConfigSchema = FilterStageConfigSchema.extend({
  singleton_pile_target: z.number().int(),
});

const ModelsConfigSchema = z.object({
  filter: FilterStageConfigSchema,
  prefilter: FilterStageConfigSchema,
  triage: TriageStageConfigSchema,
  researcher: StageConfigSchema,
  editor: StageConfigSchema,
  writers: StageConfigSchema,
  editor_pass_1: EditorPass1StageConfigSchema,
});

export type StageConfig = z.infer<typeof StageConfigSchema>;
export type FilterStageConfig = z.infer<typeof FilterStageConfigSchema>;
export type Spine = z.infer<typeof SpineSchema>;
export type SemanticMergeConfig = z.infer<typeof SemanticMergeConfigSchema>;
export type TriageStageConfig = z.infer<typeof TriageStageConfigSchema>;
export type EditorPass1StageConfig = z.infer<typeof EditorPass1StageConfigSchema>;
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
