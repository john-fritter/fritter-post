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
  // Items per call when re-asking for scores that came back missing. Small on
  // purpose: the commonest fail-safe is the model dropping one line from a batch
  // of forty, and a dropped line is far harder to hide in a short response.
  straggler_batch_size: z.number().int().positive(),
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
  retry_max_attempts: z.number().int().optional(),
  retry_base_ms: z.number().int().optional(),
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

// Article text fetch for the writers stage. Every threshold here is a policy
// the audit of a real run set, so none of them are allowed to be implicit.
const WritersFetchConfigSchema = z.object({
  enabled: z.boolean(),
  // Tiers whose pieces get fetched. Briefs are one-liners and stay out.
  tiers: z.array(z.enum(["feature", "standard", "brief"])),
  // Fetch only when the feed body is shorter than this.
  feed_chars_floor: z.number().int().nonnegative(),
  // Extraction under this is a paywall or a JS shell, not an article.
  min_extracted_chars: z.number().int().nonnegative(),
  // Hosts in parallel; each host's URLs are always sequential.
  concurrency: z.number().int().positive(),
  per_host_delay_ms: z.number().int().nonnegative(),
  timeout_ms: z.number().int().positive(),
  // Do not re-request an article attempted inside this window.
  refetch_after_hours: z.number().int().nonnegative(),
  max_bytes: z.number().int().positive(),
  retention_days: z.number().int().positive(),
  cooldown: z.object({
    enabled: z.boolean(),
    window_days: z.number().int().positive(),
    min_attempts: z.number().int().positive(),
  }),
});

// Per-tier material budget for one writer packet.
//
// **Source material is not rationed.** `max_articles` and `total_chars` are
// `null` on every tier, meaning no limit: if an item survived collection,
// prefiltering, grouping and the editor, and it is not a verbatim duplicate,
// the writer sees it. Deciding what bears on the story is the writer's job and
// nothing upstream can do it — which is the whole reason the pipeline gathers
// and groups sources in the first place.
//
// Both remain settable because a run may one day meet a page that would blow a
// context window, and a number in config beats a crash. Setting either is an
// editorial decision, not a tuning knob: it discards reporting.
const WritersTierPacketConfigSchema = z.object({
  max_articles: z.number().int().positive().nullable(),
  total_chars: z.number().int().positive().nullable(),
  per_article_chars: z.number().int().positive(),
  // Both of these are inert while `total_chars` is null. They only decide who
  // gets squeezed if a limit is ever set, and they exist so that a squeeze
  // spreads across outlets rather than letting two long sources take it all.
  floor_chars: z.number().int().nonnegative(),
  target_words: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  // Judged per tier: the same 1,000 characters is thin for a feature and
  // adequate for a standard piece.
  thin_material_chars: z.number().int().nonnegative(),
  full_material_chars: z.number().int().nonnegative(),
});

// A thread's section: how many members get their own piece before the rest
// become one-line entries.
const WritersSectionConfigSchema = z.object({
  max_sidebars: z.number().int().nonnegative(),
});

const WritersPacketConfigSchema = z.object({
  section: WritersSectionConfigSchema,
  min_dedup_paragraph_chars: z.number().int().nonnegative(),
  // Sources with less usable text than this are left out of the packet.
  min_article_chars: z.number().int().nonnegative(),
  // Length ceiling for a piece with headline-only material, whatever its tier.
  headline_only_words: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  // Tiers, most prominent first, whose slot a headline-only story may not hold.
  // Anything outside the list accepts headline material. Empty disables the
  // rule and restores the editor's rank-only tiering. See resolveTiersByMaterial.
  tiers_requiring_material: z.array(z.string()),
  tiers: z.object({
    feature: WritersTierPacketConfigSchema,
    standard: WritersTierPacketConfigSchema,
    brief: WritersTierPacketConfigSchema,
    // Section pieces. A sidebar under a standard lead would otherwise take the
    // brief tier's numbers, and a line the brief tier's material; both are the
    // wrong job. See assembleSectionPackets.
    sidebar: WritersTierPacketConfigSchema,
    line: WritersTierPacketConfigSchema,
  }),
});

const WritersStageConfigSchema = StageConfigSchema.extend({
  // In-flight writer calls. Each one is a whole piece of prose, so this is the
  // knob that decides how long the stage takes and how hard the provider is hit.
  concurrency: z.number().int().positive(),
  // Briefs per batched call. 75 separate calls would each re-send the bio and
  // the standing memo.
  brief_batch_size: z.number().int().positive(),
  // Consecutive call failures after which the run stops asking. 0 disables.
  abort_after_consecutive_failures: z.number().int().nonnegative(),
  retry_max_attempts: z.number().int().optional(),
  retry_base_ms: z.number().int().optional(),
  fetch: WritersFetchConfigSchema,
  packet: WritersPacketConfigSchema,
});

const ModelsConfigSchema = z.object({
  preprocessor: PreprocessorConfigSchema,
  prefilter: BatchStageConfigSchema,
  editor: EditorStageConfigSchema,
  thread: ThreadStageConfigSchema,
  writers: WritersStageConfigSchema,
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
export type WritersFetchConfig = z.infer<typeof WritersFetchConfigSchema>;
export type WritersTierPacketConfig = z.infer<typeof WritersTierPacketConfigSchema>;
export type WritersPacketConfig = z.infer<typeof WritersPacketConfigSchema>;
export type WritersStageConfig = z.infer<typeof WritersStageConfigSchema>;
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
