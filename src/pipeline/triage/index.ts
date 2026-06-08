import "dotenv/config";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import type { Spine } from "../../config/models.js";
import { callLLM } from "../../llm/index.js";
import {
  assembleTriageDocument,
  getTriageItems,
  formatTriageItemBlocks,
} from "../preprocessor/assembler.js";
import type { PreprocessedItemRow } from "../preprocessor/assembler.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildIncrementalUserPrompt,
  buildSemanticMergeSystemPrompt,
  buildSemanticMergeUserPrompt,
} from "./prompt.js";

export interface SpineBucket {
  name: string;
  items: PreprocessedItemRow[];
}

/**
 * Splits items into a seed bucket (items whose `group` — set on
 * preprocessed_items at preprocess time from config/sources.yaml, a
 * structural clustering axis, not an editorial tag — appears in `seedGroups`)
 * and an ordered list of spine buckets (items whose group appears in that
 * spine's `groups`, claimed in config order so each item lands in exactly one
 * bucket). Any item claimed by neither the seed nor a configured spine —
 * including items with no group set — is swept into an implicit fallback
 * "rest" spine appended at the end, so nothing is silently excluded.
 */
function bucketItemsForSpines(
  items: PreprocessedItemRow[],
  seedGroups: string[],
  spines: Spine[],
): { seedBucket: PreprocessedItemRow[]; spineBuckets: SpineBucket[] } {
  const claimed = new Set<number>();
  const seedSet = new Set(seedGroups);

  const seedBucket: PreprocessedItemRow[] = [];
  for (const item of items) {
    if (item.group !== null && seedSet.has(item.group)) {
      seedBucket.push(item);
      claimed.add(Number(item.id));
    }
  }

  const spineBuckets: SpineBucket[] = [];
  for (const spine of spines) {
    const groups = new Set(spine.groups);
    const bucket: PreprocessedItemRow[] = [];
    for (const item of items) {
      const id = Number(item.id);
      if (claimed.has(id)) continue;
      if (item.group !== null && groups.has(item.group)) {
        bucket.push(item);
        claimed.add(id);
      }
    }
    spineBuckets.push({ name: spine.name, items: bucket });
  }

  const rest = items.filter((item) => !claimed.has(Number(item.id)));
  if (rest.length > 0) {
    spineBuckets.push({ name: "rest", items: rest });
  }

  return { seedBucket, spineBuckets };
}

const TITLE_WORD_MIN_LENGTH = 3;
const TITLE_SIMILARITY_THRESHOLD = 0.6;

function titleWordSet(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= TITLE_WORD_MIN_LENGTH),
  );
}

/**
 * Jaccard similarity over normalized title word sets, thresholded — a cheap
 * heuristic for flagging probable same-story clusters that the deterministic
 * id-union merge can't catch because they share no item ids (e.g. the same
 * story covered only by sources in two different spines). Not a merge
 * decision — see `mergeSpineClusters`'s `possibleDuplicates`.
 */
function titlesAreSimilar(a: string, b: string): boolean {
  const setA = titleWordSet(a);
  const setB = titleWordSet(b);
  if (setA.size === 0 || setB.size === 0) return false;

  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 && intersection / union >= TITLE_SIMILARITY_THRESHOLD;
}

export interface SpineMergeResult {
  clusters: TriageCluster[];
  clustersBeforeMerge: number;
  mergedByShareCount: number;
  possibleDuplicates: { a: string; b: string }[];
}

/**
 * Deterministically merges every spine's re-emitted cluster list into one —
 * software, not an LLM call. Every spine accreted onto the SAME seed cluster
 * list, so the same major story appears in multiple spines' outputs sharing
 * the seed's item ids: an exact, free merge key that needs no semantic
 * matching. Any two clusters (from any spines, including different copies of
 * the same re-emitted seed cluster) that share >= 1 id are unioned,
 * transitively; within each merged group, ids are deduped keep-first (in
 * gather order: spine config order, then each spine's emission order) and the
 * largest contributing cluster's label/summary is kept as canonical.
 *
 * Clusters that share no id but have highly similar titles are NOT merged —
 * that would require semantic judgment this pass doesn't make. They're
 * surfaced via `possibleDuplicates` for inspection, and the semantic
 * merge/attach pass (the final clustering step, see docs/decisions.md) gets
 * a chance to resolve them with editorial judgment over the small merged list.
 */
function mergeSpineClusters(spineOutputs: { name: string; clusters: TriageCluster[] }[]): SpineMergeResult {
  const gathered: TriageCluster[] = [];
  for (const spine of spineOutputs) {
    gathered.push(...spine.clusters);
  }

  const n = gathered.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const idToIndices = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    for (const id of gathered[i]!.item_ids) {
      const indices = idToIndices.get(id);
      if (indices) indices.push(i);
      else idToIndices.set(id, [i]);
    }
  }
  for (const indices of idToIndices.values()) {
    for (let k = 1; k < indices.length; k++) union(indices[0]!, indices[k]!);
  }

  const components = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const members = components.get(root);
    if (members) members.push(i);
    else components.set(root, [i]);
  }

  const merged: TriageCluster[] = [];
  let mergedByShareCount = 0;

  for (const members of components.values()) {
    if (members.length > 1) mergedByShareCount += members.length - 1;

    let canonicalIdx = members[0]!;
    for (const idx of members) {
      if (gathered[idx]!.item_ids.length > gathered[canonicalIdx]!.item_ids.length) {
        canonicalIdx = idx;
      }
    }
    const canonical = gathered[canonicalIdx]!;

    const seen = new Set<number>();
    const ids: number[] = [];
    for (const idx of members) {
      for (const id of gathered[idx]!.item_ids) {
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }

    merged.push({ title: canonical.title, summary: canonical.summary, item_ids: ids, notes: null });
  }

  // Order by item count descending — "most-covered story first," the same
  // convention the system prompt asks the model to follow. This order
  // becomes cluster_index downstream.
  merged.sort((a, b) => b.item_ids.length - a.item_ids.length);

  const possibleDuplicates: { a: string; b: string }[] = [];
  for (let i = 0; i < merged.length; i++) {
    for (let j = i + 1; j < merged.length; j++) {
      if (titlesAreSimilar(merged[i]!.title, merged[j]!.title)) {
        possibleDuplicates.push({ a: merged[i]!.title, b: merged[j]!.title });
      }
    }
  }

  return { clusters: merged, clustersBeforeMerge: n, mergedByShareCount, possibleDuplicates };
}

function formatFlatClusterLines(clusters: TriageCluster[]): string {
  return clusters.map((c) => `${c.title};;${c.summary};;${c.item_ids.join(",")}`).join("\n");
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
    // news-item id set for the run — broader than any single seed/spine
    // pile, same validation set as the old whole-pile call.
    const { rows: itemIdRows } = await pool.query<{ id: string }>(
      "SELECT id FROM preprocessed_items WHERE preprocessor_run_id = $1",
      [preprocessorRunId],
    );
    const inputIds = new Set<number>(itemIdRows.map((r: { id: string }) => Number(r.id)));

    // 5. Fetch the kept items (post filter-run, post junk-filter — the same
    // set the old whole-pile document contained) and split them into a wire
    // seed bucket plus an ordered set of thematic spine buckets, per
    // config/models.yaml's clustering.{seed, spines}.
    const allItems = await getTriageItems(preprocessorRunId);
    const clusteringConfig = modelConfig.triage.clustering;
    const { seedBucket, spineBuckets } = bucketItemsForSpines(
      allItems,
      clusteringConfig.seed,
      clusteringConfig.spines,
    );

    const roundDigests: { name: string; text: string }[] = [];
    const stageStartedAt = Date.now();

    // 6. SEED — cluster only the seed (wire) items in one call. This produces
    // the day's major-story clusters; every spine accretes onto this same
    // list independently, so its item ids become the merge key in step 8.
    const seedBucketIds = new Set(seedBucket.map((item) => Number(item.id)));
    const seedDocument = await assembleTriageDocument(preprocessorRunId, (item) => seedBucketIds.has(Number(item.id)));
    const seedResult = await callLLM({
      stage: "triage",
      stageRunId: runId,
      model,
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt(seedDocument),
      temperature,
      maxTokens,
      reasoningEffort,
    });
    const seedParse = parseFlatClusterOutput(seedResult.text, inputIds);
    const seedClusters = seedParse?.clusters ?? [];
    const seedClusteredIds = new Set<number>();
    for (const cluster of seedClusters) {
      for (const id of cluster.item_ids) seedClusteredIds.add(id);
    }

    console.log(
      `[triage] seed: items_in=${seedBucket.length}, clusters_out=${seedClusters.length}` +
      (seedParse && seedParse.fabricatedIds.length > 0 ? `, fabricated=${seedParse.fabricatedIds.length}` : "") +
      (seedParse && seedParse.duplicateIds.length > 0 ? `, duplicates=${seedParse.duplicateIds.length}` : "") +
      (seedParse && seedParse.droppedSingletonCount > 0 ? `, dropped-singletons=${seedParse.droppedSingletonCount}` : ""),
    );
    roundDigests.push({ name: "seed", text: seedResult.text });

    // 7. SPINES — run concurrently, capped at max_concurrent_spines. Each
    // spine sees the seed's cluster list verbatim plus its own items as "new
    // items," and re-emits the complete updated list — the same
    // attach/merge/create/re-emit instruction as before, just with no
    // carry-forward between spines: every spine starts fresh from the same
    // seed and sees only its own group's items, so every prompt stays in the
    // model's working range no matter how large the total pile is.
    const spineLimit = pLimit(clusteringConfig.max_concurrent_spines);
    const spineCalls = await Promise.all(
      spineBuckets.map((bucket) =>
        spineLimit(async () => {
          const userPrompt = buildIncrementalUserPrompt(seedResult.text, formatTriageItemBlocks(bucket.items));
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
          const parse = parseFlatClusterOutput(result.text, inputIds);
          return { name: bucket.name, itemCount: bucket.items.length, result, parse };
        }),
      ),
    );

    const allSpineClusteredIds = new Set<number>();
    for (const spine of spineCalls) {
      const clusters = spine.parse?.clusters ?? [];
      for (const cluster of clusters) {
        for (const id of cluster.item_ids) allSpineClusteredIds.add(id);
      }

      console.log(
        `[triage] spine="${spine.name}": items_in=${spine.itemCount}, clusters_out=${clusters.length}` +
        (spine.parse && spine.parse.fabricatedIds.length > 0 ? `, fabricated=${spine.parse.fabricatedIds.length}` : "") +
        (spine.parse && spine.parse.duplicateIds.length > 0 ? `, duplicates=${spine.parse.duplicateIds.length}` : "") +
        (spine.parse && spine.parse.droppedSingletonCount > 0 ? `, dropped-singletons=${spine.parse.droppedSingletonCount}` : ""),
      );
      roundDigests.push({ name: `spine:${spine.name}`, text: spine.result.text });
    }

    // A spine call may silently drop a seed cluster (or one of its ids) on
    // re-emission. As long as some other spine retains it, the id-union merge
    // in step 8 recovers it for free. But if an id is absent from EVERY
    // spine's output, it's gone from the final digest entirely — log it
    // loudly so it's visible (unlike the chained-rounds design, there's no
    // next round to give it another chance).
    const lostFromSeed = [...seedClusteredIds].filter((id) => !allSpineClusteredIds.has(id));
    if (lostFromSeed.length > 0) {
      console.warn(
        `[triage] LOST ${lostFromSeed.length} seed-cluster id(s) absent from every spine's output: ${lostFromSeed.join(", ")}`,
      );
    }

    // 8. MERGE — deterministic software, not an LLM call. Every spine
    // re-emitted the complete list it started from (the seed clusters) plus
    // whatever it added, so the same major story appears in multiple spines'
    // outputs sharing the seed's item ids — an exact, free merge key. Union
    // any two clusters across all spine outputs that share >= 1 id,
    // transitively, then dedupe ids keep-first within each merged group.
    const spineOutputsForMerge = spineCalls.map((spine) => ({
      name: spine.name,
      clusters: spine.parse?.clusters ?? [],
    }));
    const mergeResult = mergeSpineClusters(spineOutputsForMerge);

    console.log(
      `[triage] merge: clusters_before=${mergeResult.clustersBeforeMerge}, ` +
      `clusters_after=${mergeResult.clusters.length}, ` +
      `merged_by_shared_id=${mergeResult.mergedByShareCount}, ` +
      `possible_duplicates=${mergeResult.possibleDuplicates.length}`,
    );
    for (const dup of mergeResult.possibleDuplicates) {
      console.warn(`[triage] possible unmerged duplicate (no shared ids — the semantic merge pass below may resolve this): "${dup.a}" ~ "${dup.b}"`);
    }

    const idUnionDigestText = formatFlatClusterLines(mergeResult.clusters);
    roundDigests.push({ name: "merged", text: idUnionDigestText });

    // 9. SEMANTIC MERGE/ATTACH — one additional LLM call, the final
    // clustering step. The deterministic id-union merge above only fuses
    // clusters that share an item id; it misses (a) same-story clusters
    // covered by disjoint source sets that share no ids at all, and (b)
    // orphaned high-relevance singletons that belong in an existing cluster —
    // especially cross-language items and tangential angles (an explainer, a
    // regional reaction). Both are recall failures at the edges that need
    // editorial judgment, not id matching — exactly the gap `possibleDuplicates`
    // above flags but can't resolve on its own. This pass operates on a SMALL
    // input — the merged cluster list plus a bounded slice of high-relevance
    // singletons, not the whole pile — so it stays far below the size that
    // caused the earlier whole-pile timeouts. See docs/decisions.md.
    let finalClusters = mergeResult.clusters;
    const semanticConfig = clusteringConfig.semantic_merge;
    let semanticCallResult: Awaited<ReturnType<typeof callLLM>> | null = null;

    if (!semanticConfig.enabled) {
      console.log(`[triage] semantic merge: disabled by config — using id-union merge result as final`);
    } else {
      const preSemanticIds = new Set<number>();
      for (const cluster of mergeResult.clusters) {
        for (const id of cluster.item_ids) preSemanticIds.add(id);
      }
      const residualSingletons = allItems.filter(
        (item: PreprocessedItemRow) => !preSemanticIds.has(Number(item.id)),
      );

      // Pass-1 scoring hasn't run yet at triage time, so there's no relevance
      // score to rank residuals by here. Recency is the most meaningful signal
      // directly available — a recently-published orphan is the likeliest to
      // be a same-day angle on, or cross-language report of, a running story:
      // exactly the case this pass exists to catch. Bounded by count (not all
      // ~500 residuals) — keeping the input small is the whole point.
      const singletonCandidates = [...residualSingletons]
        .sort((a, b) => {
          const aTime = a.published_at ? new Date(a.published_at).getTime() : -Infinity;
          const bTime = b.published_at ? new Date(b.published_at).getTime() : -Infinity;
          return bTime - aTime;
        })
        .slice(0, semanticConfig.max_singletons);
      const candidateIds = new Set(singletonCandidates.map((item) => Number(item.id)));

      const semanticResult = await callLLM({
        stage: "triage",
        stageRunId: runId,
        model: semanticConfig.model,
        systemPrompt: buildSemanticMergeSystemPrompt(),
        userPrompt: buildSemanticMergeUserPrompt(idUnionDigestText, formatTriageItemBlocks(singletonCandidates)),
        temperature,
        maxTokens: semanticConfig.max_tokens,
        reasoningEffort: semanticConfig.reasoning_effort,
      });
      semanticCallResult = semanticResult;
      roundDigests.push({ name: "semantic_merge", text: semanticResult.text });

      const semanticParse = parseFlatClusterOutput(semanticResult.text, inputIds);
      if (semanticParse === null) {
        console.warn(
          `[triage] semantic merge: parse failed — keeping id-union merge result as final (${mergeResult.clusters.length} clusters)`,
        );
      } else {
        // Integrity: how many pre-pass clusters fused into each post-pass
        // cluster (a "merge"), how many offered singletons made it into the
        // final list (an "attach"), and whether any previously-clustered id
        // vanished from the output entirely (a "loss" — same as the seed/spine
        // LOST handling above, it falls back to residual; nothing recovers it
        // because this is the final clustering step).
        const idToPreIndex = new Map<number, number>();
        mergeResult.clusters.forEach((cluster, idx) => {
          for (const id of cluster.item_ids) idToPreIndex.set(id, idx);
        });

        let mergedCount = 0;
        const postIds = new Set<number>();
        for (const cluster of semanticParse.clusters) {
          const preIndices = new Set<number>();
          for (const id of cluster.item_ids) {
            postIds.add(id);
            const preIdx = idToPreIndex.get(id);
            if (preIdx !== undefined) preIndices.add(preIdx);
          }
          if (preIndices.size > 1) mergedCount += preIndices.size - 1;
        }
        const attachedCount = [...candidateIds].filter((id) => postIds.has(id)).length;
        const lostIds = [...preSemanticIds].filter((id) => !postIds.has(id));

        console.log(
          `[triage] semantic merge: clusters_before=${mergeResult.clusters.length}, ` +
          `clusters_after=${semanticParse.clusters.length}, merged=${mergedCount}, ` +
          `singletons_offered=${singletonCandidates.length}, attached=${attachedCount}`,
        );
        if (lostIds.length > 0) {
          console.warn(
            `[triage] semantic merge LOST ${lostIds.length} previously-clustered id(s) — ` +
            `absent from its output, falling back to residual: ${lostIds.join(", ")}`,
          );
        }

        finalClusters = semanticParse.clusters;
      }
    }

    const finalDigestText = formatFlatClusterLines(finalClusters);

    console.log(
      `[triage] run #${runId}: seed=${seedBucket.length} items, ${spineBuckets.length} spines, ` +
      `clusters=${finalClusters.length}`,
    );

    // 10. Update triage_runs with results. digest holds the final cluster list
    // — id-union merge plus the semantic merge/attach pass's edits, when
    // enabled — in the same flat format as before, so the contract with
    // everything downstream (parseFlatClusterOutput, cluster_index, the
    // editor, assemble-pile) is unchanged. round_digests additionally
    // preserves the seed output, every spine's output, the id-union merge
    // result, and the semantic merge pass's raw output (when it ran), so a
    // run is inspectable stage by stage. Token/duration figures are summed
    // across every LLM call this run made (seed + each spine + the semantic
    // merge pass, if it ran); generation_log_id points at the seed call — the
    // one call every other call accreted onto.
    const allCalls = [seedResult, ...spineCalls.map((s) => s.result)];
    if (semanticCallResult !== null) allCalls.push(semanticCallResult);
    const totalInputTokens = allCalls.reduce<number | null>(
      (sum, r) => (sum === null || r.inputTokens === null ? null : sum + r.inputTokens),
      0,
    );
    const totalOutputTokens = allCalls.reduce<number | null>(
      (sum, r) => (sum === null || r.outputTokens === null ? null : sum + r.outputTokens),
      0,
    );
    const totalDurationMs = Date.now() - stageStartedAt;

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
        totalInputTokens,
        totalOutputTokens,
        totalDurationMs,
        finalDigestText,
        JSON.stringify(roundDigests),
        seedResult.generationLogId,
        runId,
      ]
    );

    // 11. Return completed run.
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
