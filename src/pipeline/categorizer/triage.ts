import "dotenv/config";
import pLimit from "p-limit";
import { z } from "zod";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import { assembleTriageDocumentForItemIds } from "../preprocessor/assembler.js";
import { buildSystemPrompt as buildTriageSystemPrompt, buildUserPrompt as buildTriageUserPrompt } from "../triage/prompt.js";

// Re-define triage output schemas locally so this file has no coupling to
// triage/index.ts internals. The prompt is imported verbatim (the whole point).
const ClusterSchema = z.object({
  title: z.string(),
  item_ids: z.array(z.number().int()),
  summary: z.string(),
  notes: z.string().nullable(),
});

const TriageOutputSchema = z.object({
  clusters: z.array(ClusterSchema),
});

type ParsedCluster = z.infer<typeof ClusterSchema>;

export interface SectionResult {
  section: string;
  clusters: ParsedCluster[];
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
}

export interface StraddleEntry {
  itemId: number;
  appearances: { section: string; clusterTitle: string }[];
}

export interface IntegrityFlags {
  fabricatedIds: number[];
  duplicateIdsWithinSection: { id: number; section: string }[];
  singletonClusters: { section: string; clusterIndex: number }[];
}

export interface CategorizedTriageRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  categorizerRunId: number;
  preprocessorRunId: number;
  modelUsed: string;
  totalClusters: number | null;
  combinedOutput: SectionResult[] | null;
  straddleReport: StraddleEntry[] | null;
  integrityFlags: IntegrityFlags | null;
  residualItemIds: number[] | null;
}

interface CategorizedTriageRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  categorizer_run_id: number;
  preprocessor_run_id: number;
  model_used: string;
  total_clusters: number | null;
  combined_output: SectionResult[] | null;
  straddle_report: StraddleEntry[] | null;
  integrity_flags: IntegrityFlags | null;
  residual_item_ids: number[] | null;
}

function parseTriageOutput(text: string): { clusters: ParsedCluster[] } | null {
  try {
    const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    const parsed: unknown = JSON.parse(stripped);
    return TriageOutputSchema.parse(parsed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[categorized-triage] output parse failed: ${reason}`);
    return null;
  }
}

export async function runCategorizedTriage(
  options: {
    categorizerRunId?: number;
    modelOverride?: string;
  } = {}
): Promise<CategorizedTriageRun> {
  const pool = getPool();

  // 1. Find categorizer run (explicit id or latest completed).
  let categorizerRunId: number;
  let preprocessorRunId: number;

  if (options.categorizerRunId !== undefined) {
    categorizerRunId = options.categorizerRunId;
    const { rows } = await pool.query<{ preprocessor_run_id: number }>(
      "SELECT preprocessor_run_id FROM categorizer_runs WHERE id = $1 AND completed_at IS NOT NULL",
      [categorizerRunId]
    );
    if (!rows[0]) throw new Error(`No completed categorizer run #${categorizerRunId} found`);
    preprocessorRunId = rows[0].preprocessor_run_id;
  } else {
    const { rows } = await pool.query<{ id: number; preprocessor_run_id: number }>(
      "SELECT id, preprocessor_run_id FROM categorizer_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1"
    );
    if (!rows[0]) throw new Error("No completed categorizer runs found");
    categorizerRunId = rows[0].id;
    preprocessorRunId = rows[0].preprocessor_run_id;
  }

  // 2. Load config.
  const modelConfig = loadModelConfig();
  const model = options.modelOverride ?? modelConfig.categorized_triage.model;
  const temperature = modelConfig.categorized_triage.temperature;
  const maxTokens = modelConfig.categorized_triage.max_tokens;
  const concurrency = modelConfig.categorized_triage.concurrency;
  const reasoningEffort = modelConfig.categorized_triage.reasoning_effort;

  // 3. Create categorized_triage_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO categorized_triage_runs (started_at, categorizer_run_id, preprocessor_run_id, model_used)
     VALUES (NOW(), $1, $2, $3)
     RETURNING id`,
    [categorizerRunId, preprocessorRunId, model]
  );
  const runId = runRows[0]!.id;

  try {
    // 4. Load categorizer results: build section → item IDs map.
    const { rows: catResults } = await pool.query<{
      preprocessed_item_id: string;
      sections: string[];
    }>(
      `SELECT preprocessed_item_id, sections
       FROM categorizer_results
       WHERE categorizer_run_id = $1`,
      [categorizerRunId]
    );

    const sectionToIds = new Map<string, Set<number>>();
    for (const row of catResults) {
      const itemId = Number(row.preprocessed_item_id);
      for (const section of row.sections) {
        if (!sectionToIds.has(section)) sectionToIds.set(section, new Set());
        sectionToIds.get(section)!.add(itemId);
      }
    }

    const allItemIds = new Set(catResults.map((r) => Number(r.preprocessed_item_id)));

    // 5. Load all preprocessed items for integrity checks.
    const { rows: prepItems } = await pool.query<{ id: string; source_name: string; title: string }>(
      `SELECT id, source_name, title FROM preprocessed_items WHERE preprocessor_run_id = $1`,
      [preprocessorRunId]
    );
    const itemMap = new Map<number, { source_name: string; title: string }>();
    for (const pi of prepItems) {
      itemMap.set(Number(pi.id), { source_name: pi.source_name, title: pi.title });
    }

    // 6. Process each section concurrently (hard cap: concurrency 3).
    const sections = [...sectionToIds.keys()].sort();
    const limit = pLimit(concurrency);

    const sectionResults = await Promise.all(
      sections.map((section) =>
        limit(async (): Promise<SectionResult> => {
          const itemIds = sectionToIds.get(section)!;
          console.log(`[categorized-triage] section "${section}": ${itemIds.size} items`);

          const document = await assembleTriageDocumentForItemIds(preprocessorRunId, itemIds);

          const llmResult = await callLLM({
            stage: "categorized_triage",
            stageRunId: runId,
            model,
            systemPrompt: buildTriageSystemPrompt(),
            userPrompt: buildTriageUserPrompt(document),
            temperature,
            maxTokens,
            reasoningEffort,
          });

          const parsed = parseTriageOutput(llmResult.text);
          if (parsed === null) {
            console.warn(`[categorized-triage] section "${section}": parse failed — 0 clusters for this section`);
          }

          return {
            section,
            clusters: parsed?.clusters ?? [],
            inputTokens: llmResult.inputTokens,
            outputTokens: llmResult.outputTokens,
            durationMs: llmResult.durationMs,
          };
        })
      )
    );

    // 7. Compute post-processing.
    const totalClusters = sectionResults.reduce((sum, s) => sum + s.clusters.length, 0);

    // Map: item_id → [{section, clusterTitle}] for straddle report and integrity.
    const itemToAppearances = new Map<number, { section: string; clusterTitle: string }[]>();
    const fabricatedIds: number[] = [];
    const duplicateIdsWithinSection: { id: number; section: string }[] = [];
    const singletonClusters: { section: string; clusterIndex: number }[] = [];

    for (const sectionResult of sectionResults) {
      const seenInSection = new Set<number>();
      for (let ci = 0; ci < sectionResult.clusters.length; ci++) {
        const cluster = sectionResult.clusters[ci]!;
        if (cluster.item_ids.length < 2) {
          singletonClusters.push({ section: sectionResult.section, clusterIndex: ci + 1 });
        }
        for (const id of cluster.item_ids) {
          if (!allItemIds.has(id) && !itemMap.has(id)) {
            if (!fabricatedIds.includes(id)) fabricatedIds.push(id);
            continue;
          }
          if (seenInSection.has(id)) {
            duplicateIdsWithinSection.push({ id, section: sectionResult.section });
            continue;
          }
          seenInSection.add(id);
          const existing = itemToAppearances.get(id) ?? [];
          existing.push({ section: sectionResult.section, clusterTitle: cluster.title });
          itemToAppearances.set(id, existing);
        }
      }
    }

    // Straddle report: items that appear in clusters from more than one section.
    const straddleReport: StraddleEntry[] = [...itemToAppearances.entries()]
      .filter(([, appearances]) => appearances.length > 1)
      .map(([itemId, appearances]) => ({ itemId, appearances }));

    const integrityFlags: IntegrityFlags = {
      fabricatedIds,
      duplicateIdsWithinSection,
      singletonClusters,
    };

    // Residual: items in the categorizer run that did not land in any cluster.
    const clusteredItemIds = new Set(itemToAppearances.keys());
    const residualItemIds = [...allItemIds].filter((id) => !clusteredItemIds.has(id));

    // 8. Persist to DB.
    await pool.query(
      `UPDATE categorized_triage_runs
       SET completed_at      = NOW(),
           total_clusters    = $1,
           combined_output   = $2::jsonb,
           straddle_report   = $3::jsonb,
           integrity_flags   = $4::jsonb,
           residual_item_ids = $5::jsonb
       WHERE id = $6`,
      [
        totalClusters,
        JSON.stringify(sectionResults),
        JSON.stringify(straddleReport),
        JSON.stringify(integrityFlags),
        JSON.stringify(residualItemIds),
        runId,
      ]
    );

    return await fetchCategorizedTriageRun(pool, runId);
  } catch (err) {
    await pool.query(
      `UPDATE categorized_triage_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId]
    );
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Categorized triage run #${runId} failed: ${msg}`);
  }
}

async function fetchCategorizedTriageRun(
  pool: import("pg").Pool,
  runId: number
): Promise<CategorizedTriageRun> {
  const { rows } = await pool.query<CategorizedTriageRunRow>(
    "SELECT * FROM categorized_triage_runs WHERE id = $1",
    [runId]
  );
  const r = rows[0]!;
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    categorizerRunId: r.categorizer_run_id,
    preprocessorRunId: r.preprocessor_run_id,
    modelUsed: r.model_used,
    totalClusters: r.total_clusters,
    combinedOutput: r.combined_output,
    straddleReport: r.straddle_report,
    integrityFlags: r.integrity_flags,
    residualItemIds: r.residual_item_ids,
  };
}
