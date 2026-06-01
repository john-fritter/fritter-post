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
});

const FilterStageConfigSchema = StageConfigSchema.extend({
  batch_size: z.number().int(),
  concurrency: z.number().int(),
});

const ModelsConfigSchema = z.object({
  filter: FilterStageConfigSchema,
  triage: StageConfigSchema,
  researcher: StageConfigSchema,
  editor: StageConfigSchema,
  writers: StageConfigSchema,
  editor_pass_1: FilterStageConfigSchema,
});

export type StageConfig = z.infer<typeof StageConfigSchema>;
export type FilterStageConfig = z.infer<typeof FilterStageConfigSchema>;
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
