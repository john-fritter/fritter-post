import "dotenv/config";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import type { ClusteringRound } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import {
  assembleTriageDocument,
  getTriageItems,
  formatTriageItemBlocks,
} from "../preprocessor/assembler.js";
import type { PreprocessedItemRow } from "../preprocessor/assembler.js";
import { buildSystemPrompt, buildUserPrompt, buildIncrementalUserPrompt } from "./prompt.js";

/**
 * Buckets items into clustering rounds by their source's `group` (set on
 * preprocessed_items at preprocess time from config/sources.yaml — a
 * structural clustering axis, not an editorial tag), in round order.
 * Membership is config-driven: a round admits items whose group appears in
 * its `groups`, or — if `groups` includes the catch-all "*" — every item not
 * already claimed by an earlier round (including items with no group set).
 * Each item lands in exactly one bucket, in its original (chronological)
 * order.
 */
function bucketItemsByRound(
  items: PreprocessedItemRow[],
  rounds: ClusteringRound[],
): PreprocessedItemRow[][] {
  const buckets: PreprocessedItemRow[][] = rounds.map(() => []);
  const claimed = new Set<number>();

  for (let r = 0; r < rounds.length; r++) {
    const groups = rounds[r]!.groups;
    const isCatchAll = groups.includes("*");
    for (const item of items) {
      const id = Number(item.id);
      if (claimed.has(id)) continue;
      if (isCatchAll || (item.group !== null && groups.includes(item.group))) {
        buckets[r]!.push(item);
        claimed.add(id);
      }
    }
  }

  return buckets;
}

export interface TriageCluster {
  title: string;
  item_ids: number[];
  summary: string;
  notes: string | null;
}

export interface TriageOutput {
  clusters: TriageCluster[];
}

export interface FlatClusterParseResult {
  clusters: TriageCluster[];
  fabricatedIds: number[];
  duplicateIds: number[];
  droppedSingletonCount: number;
  parsedLineCount: number;
}

/**
 * Parses the flat line-based cluster format:
 *   label;;summary;;id,id,id,...
 *
 * The id list is last so any ;; inside summary cannot shift the id column.
 * Validates each cluster against inputIds: drops fabricated ids (logs them),
 * records duplicates (logs them), and drops clusters with fewer than 2 valid ids.
 * Returns null only if the entire output has no parseable cluster lines.
 */
export function parseFlatClusterOutput(
  text: string,
  inputIds: Set<number>,
): FlatClusterParseResult | null {
  const seenIds = new Set<number>();
  const clusters: TriageCluster[] = [];
  const allFabricated: number[] = [];
  const allDuplicates: number[] = [];
  let parsedLineCount = 0;
  let droppedSingletonCount = 0;

  // Pre-pass: join split-line clusters.
  // The model may emit "label;;summary" on one line and "id,id,..." on the next.
  // Detect: line with exactly one ;;, followed by a bare id-list line.
  const rawLines = text.split(/\r?\n/);
  const lines: string[] = [];
  {
    let i = 0;
    while (i < rawLines.length) {
      const line = rawLines[i]!.trim();
      const firstSep = line.indexOf(";;");
      if (firstSep !== -1 && line.indexOf(";;", firstSep + 2) === -1) {
        // Exactly one ;; — look ahead for a bare id list.
        let j = i + 1;
        while (j < rawLines.length && rawLines[j]!.trim().length === 0) j++;
        if (j < rawLines.length && /^\d+(?:,\s*\d+)*$/.test(rawLines[j]!.trim())) {
          lines.push(`${line};;${rawLines[j]!.trim()}`);
          i = j + 1;
          continue;
        }
      }
      lines.push(line);
      i++;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue; // only one ;; — needs exactly two distinct occurrences

    parsedLineCount++;

    const label = line.slice(0, first).trim();
    const summary = line.slice(first + 2, last).trim(); // absorbs any ;; inside summary
    const idPart = line.slice(last + 2).trim();

    if (label.length === 0 || summary.length === 0) {
      console.warn(`[triage] skipping malformed line: empty label or summary`);
      continue;
    }

    const fabricated: number[] = [];
    const duplicate: number[] = [];
    const validIds: number[] = [];

    for (const tok of idPart.split(",")) {
      const trimmed = tok.trim();
      if (!/^\d+$/.test(trimmed)) continue;
      const id = Number.parseInt(trimmed, 10);
      if (!inputIds.has(id)) {
        fabricated.push(id);
      } else if (seenIds.has(id)) {
        duplicate.push(id);
      } else {
        validIds.push(id);
        seenIds.add(id);
      }
    }

    if (fabricated.length > 0) {
      console.warn(`[triage] fabricated ids in cluster "${label}": ${fabricated.join(", ")}`);
      allFabricated.push(...fabricated);
    }
    if (duplicate.length > 0) {
      console.warn(`[triage] duplicate ids (appeared in earlier cluster): ${duplicate.join(", ")}`);
      allDuplicates.push(...duplicate);
    }

    if (validIds.length < 2) {
      console.warn(
        `[triage] dropped cluster "${label}": only ${validIds.length} valid id(s) after filtering`,
      );
      droppedSingletonCount++;
      continue;
    }

    clusters.push({ title: label, item_ids: validIds, summary, notes: null });
  }

  if (parsedLineCount === 0) {
    console.warn(`[triage] digest parse failed: no cluster lines found`);
    console.warn(`[triage] first 500 chars: ${text.slice(0, 500)}`);
    return null;
  }

  return {
    clusters,
    fabricatedIds: allFabricated,
    duplicateIds: allDuplicates,
    droppedSingletonCount,
    parsedLineCount,
  };
}

export interface TriageRun {
  id: number;
  startedAt: Date;
  completedAt: Date | null;
  preprocessorRunId: number;
  modelUsed: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  digest: string | null;
  generationLogId: bigint | null;
}

export async function runTriage(options: {
  preprocessorRunId?: number;
  modelOverride?: string;
} = {}): Promise<TriageRun> {
  const pool = getPool();

  // 1. Find preprocessor run (explicit id or latest).
  let preprocessorRunId: number;

  if (options.preprocessorRunId !== undefined) {
    preprocessorRunId = options.preprocessorRunId;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM preprocessor_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1"
    );
    if (!rows[0]) {
      throw new Error("No completed preprocessor runs found");
    }
    preprocessorRunId = rows[0].id;
  }

  // 2. Load model config and resolve model string.
  const modelConfig = loadModelConfig();
  const model = options.modelOverride ?? modelConfig.triage.model;
  const temperature = modelConfig.triage.temperature;
  const maxTokens = modelConfig.triage.max_tokens;
  const reasoningEffort = modelConfig.triage.reasoning_effort;

  // 3. Create triage_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO triage_runs (started_at, preprocessor_run_id, model_used)
     VALUES (NOW(), $1, $2)
     RETURNING id`,
    [preprocessorRunId, model]
  );
  const runId = runRows[0]!.id;

  try {
    // 4. Fetch input item ids for parse-time validation. This is the full
    // news-item id set for the run (union across all rounds) — broader than
    // any single round's pile, same validation set as the old whole-pile call.
    const { rows: itemIdRows } = await pool.query<{ id: string }>(
      "SELECT id FROM preprocessed_items WHERE preprocessor_run_id = $1",
      [preprocessorRunId],
    );
    const inputIds = new Set<number>(itemIdRows.map((r: { id: string }) => Number(r.id)));

    // 5. Fetch the kept items (post filter-run, post junk-filter — the same
    // set the old whole-pile document contained) and bucket them into rounds
    // by source `group`, per config/models.yaml's clustering.rounds.
    const allItems = await getTriageItems(preprocessorRunId);
    const rounds = modelConfig.triage.clustering.rounds;
    const buckets = bucketItemsByRound(allItems, rounds);

    // 6. Run each round in order. Each round sees the cumulative cluster list
    // re-emitted by the prior round plus its own new items and any items that
    // haven't clustered yet — and re-emits the complete updated cluster list.
    // The final round's raw text becomes triage_runs.digest, unchanged.
    const roundDigests: { name: string; text: string }[] = [];
    let seenItems: typeof allItems = [];
    let priorClusteredIds = new Set<number>();
    let priorRoundText: string | null = null;
    let lastResult: Awaited<ReturnType<typeof callLLM>> | null = null;
    let lastParse: FlatClusterParseResult | null = null;

    for (let r = 0; r < rounds.length; r++) {
      const round = rounds[r]!;
      const bucket = buckets[r]!;
      const looseItems = seenItems.filter((item) => !priorClusteredIds.has(Number(item.id)));
      const roundItems = [...bucket, ...looseItems];

      let userPrompt: string;
      if (r === 0) {
        const bucketIds = new Set(bucket.map((item) => Number(item.id)));
        const document = await assembleTriageDocument(preprocessorRunId, (item) => bucketIds.has(Number(item.id)));
        userPrompt = buildUserPrompt(document);
      } else {
        userPrompt = buildIncrementalUserPrompt(priorRoundText!, formatTriageItemBlocks(roundItems));
      }

      const result = await callLLM({
        stage: "triage",
        stageRunId: runId,
        model,
        systemPrompt: buildSystemPrompt(),
        userPrompt,
        temperature,
        maxTokens,
        reasoningEffort,
      });

      // Defensively parse the output. Warn on failure but do not throw —
      // the next round (if any) still gets this round's raw text verbatim.
      const parseResult = parseFlatClusterOutput(result.text, inputIds);
      const currentClusteredIds = new Set<number>();
      if (parseResult !== null) {
        for (const cluster of parseResult.clusters) {
          for (const id of cluster.item_ids) currentClusteredIds.add(id);
        }
      }

      // A re-emission round may silently drop a cluster or a previously
      // clustered id. Anything that was clustered going in but isn't
      // clustered coming out is "lost" — log it loudly. It rejoins the loose
      // pool above on the next iteration (priorClusteredIds no longer
      // contains it, so it reappears in `seenItems.filter(...)`), so it gets
      // another chance rather than silently vanishing.
      const lostIds = [...priorClusteredIds].filter((id) => !currentClusteredIds.has(id));
      if (lostIds.length > 0) {
        console.warn(
          `[triage] round "${round.name}": LOST ${lostIds.length} previously-clustered id(s) on re-emission: ${lostIds.join(", ")}`,
        );
      }

      // Watch the loose pool: `total_prompt_items` is the number to watch.
      // If it climbs back toward full-pile size in late rounds, the split
      // isn't holding — items aren't landing in clusters and are piling up
      // as loose carry-forward instead.
      const parts = [
        `round="${round.name}"`,
        `new=${bucket.length}`,
        `loose=${looseItems.length}`,
        `total_prompt_items=${roundItems.length}`,
        `clusters_out=${parseResult?.clusters.length ?? 0}`,
      ];
      if (parseResult && parseResult.fabricatedIds.length > 0) parts.push(`fabricated=${parseResult.fabricatedIds.length}`);
      if (parseResult && parseResult.duplicateIds.length > 0) parts.push(`duplicates=${parseResult.duplicateIds.length}`);
      if (parseResult && parseResult.droppedSingletonCount > 0) parts.push(`dropped-singletons=${parseResult.droppedSingletonCount}`);
      if (lostIds.length > 0) parts.push(`lost-from-prior=${lostIds.length}`);
      console.log(`[triage] ${parts.join(", ")}`);

      roundDigests.push({ name: round.name, text: result.text });
      seenItems = [...seenItems, ...bucket];
      priorClusteredIds = currentClusteredIds;
      priorRoundText = result.text;
      lastResult = result;
      lastParse = parseResult;
    }

    const finalResult = lastResult!;

    // Final run-level summary, in the same shape the old whole-pile call logged.
    if (lastParse !== null) {
      const summaryParts = [
        `rounds=${rounds.length}`,
        `clusters=${lastParse.clusters.length}`,
        `lines=${lastParse.parsedLineCount}`,
      ];
      if (lastParse.fabricatedIds.length > 0) summaryParts.push(`fabricated=${lastParse.fabricatedIds.length}`);
      if (lastParse.duplicateIds.length > 0) summaryParts.push(`duplicates=${lastParse.duplicateIds.length}`);
      if (lastParse.droppedSingletonCount > 0) summaryParts.push(`dropped-singletons=${lastParse.droppedSingletonCount}`);
      console.log(`[triage] run #${runId}: ${summaryParts.join(", ")}`);
    } else {
      console.log(`[triage] run #${runId}: rounds=${rounds.length}, final round failed to parse`);
    }

    // 7. Update triage_runs with results (store raw text regardless of parse
    // outcome). digest holds the final round's text, exactly as before;
    // round_digests additionally preserves every round's raw text for
    // round-by-round inspection.
    await pool.query(
      `UPDATE triage_runs
       SET completed_at       = NOW(),
           input_tokens       = $1,
           output_tokens      = $2,
           duration_ms        = $3,
           digest             = $4,
           round_digests      = $5::jsonb,
           generation_log_id  = $6
       WHERE id = $7`,
      [
        finalResult.inputTokens,
        finalResult.outputTokens,
        finalResult.durationMs,
        finalResult.text,
        JSON.stringify(roundDigests),
        finalResult.generationLogId,
        runId,
      ]
    );

    // 8. Return completed run.
    return await fetchTriageRun(pool, runId);
  } catch (err) {
    // Mark run as failed with a note if it never completed.
    const msg = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE triage_runs
       SET completed_at = NOW()
       WHERE id = $1 AND completed_at IS NULL`,
      [runId]
    );
    throw new Error(`Triage run #${runId} failed: ${msg}`);
  }
}

interface TriageRunRow {
  id: number;
  started_at: string;
  completed_at: string | null;
  preprocessor_run_id: number;
  model_used: string;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  digest: string | null;
  generation_log_id: string | null;
}

async function fetchTriageRun(pool: import("pg").Pool, runId: number): Promise<TriageRun> {
  const { rows } = await pool.query<TriageRunRow>(
    "SELECT * FROM triage_runs WHERE id = $1",
    [runId]
  );
  const r = rows[0]!;
  return {
    id: r.id,
    startedAt: new Date(r.started_at),
    completedAt: r.completed_at ? new Date(r.completed_at) : null,
    preprocessorRunId: r.preprocessor_run_id,
    modelUsed: r.model_used,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    durationMs: r.duration_ms,
    digest: r.digest,
    generationLogId: r.generation_log_id !== null ? BigInt(r.generation_log_id) : null,
  };
}
