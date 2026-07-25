import "dotenv/config";
import pLimit from "p-limit";
import { getPool } from "../../db/index.js";
import { loadModelConfig } from "../../config/models.js";
import type {
  GroupingDescribeConfig,
  GroupingAttachConfig,
  GroupingSplitConfig,
} from "../../config/models.js";
import { embed, callLLM } from "../../llm/index.js";
import { callWithBackoff } from "../../llm/backoff.js";
import { getClusteringItems, formatItemBlocks } from "../preprocessor/assembler.js";
import type { PreprocessedItemRow } from "../preprocessor/assembler.js";
import type { Cluster } from "../../lib/cluster.js";
import {
  buildDescribeSystemPrompt,
  buildDescribeUserPrompt,
  buildPhaseASystemPrompt,
  buildPhaseAUserPrompt,
  buildPhaseBSystemPrompt,
  buildPhaseBUserPrompt,
  buildSplitSystemPrompt,
  buildSplitUserPrompt,
} from "./prompt.js";

export interface GroupingRun {
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

// Parse pgvector text format "[v1,v2,...,vN]" returned by pg for vector columns.
function parseVectorText(s: string): number[] {
  return s.slice(1, -1).split(",").map(Number);
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function l2Norm(v: number[]): number {
  return Math.sqrt(dotProduct(v, v));
}

function formatFlatClusterLines(clusters: Cluster[]): string {
  return clusters.map((c) => `${c.title};;${c.summary};;${c.item_ids.join(",")}`).join("\n");
}

// Fallback label for a group that has no LLM description yet.
function buildAutoCluster(groupItems: PreprocessedItemRow[]): Cluster {
  const label = groupItems[0]!.title.slice(0, 80);
  const summary = groupItems.map((i) => i.title).join(" | ");
  return {
    title: label,
    item_ids: groupItems.map((i) => Number(i.id)),
    summary,
    notes: null,
  };
}

// --- ATTACH PASS ---
//
// Cluster-centric two-phase design. Call count scales with clusters + proto-groups,
// not singletons.
//
// Phase A: for each step-2 cluster, gather candidate singletons within candidate_floor
//   of any cluster member (title-only cosine). If any exist, ONE LLM call confirms
//   which belong. Lists > ATTACH_CHUNK_SIZE split into chunks; results unioned.
// Phase B: remaining singletons are grouped via union-find at candidate_floor into
//   proto-groups. Each proto-group of size >= 2 gets ONE LLM call to confirm a
//   same-event subset. Chunks applied identically to Phase A.
// Cascade: one bounded re-pass of Phase A restricted to clusters that grew in Phase A
//   or were newly formed in Phase B. No further cascade.

const ATTACH_CHUNK_SIZE = 40;

// Returns IDs of singletons within candidate_floor of any member of the cluster,
// sorted by max similarity descending. Exported for testing.
export function buildClusterCandidateSingletons(
  clusterItemIds: ReadonlyArray<number>,
  singletonIds: ReadonlySet<number>,
  titleNormalizedVectors: ReadonlyMap<number, number[]>,
  candidateFloor: number,
): number[] {
  const scored: Array<{ id: number; maxSim: number }> = [];
  for (const singId of singletonIds) {
    const singVec = titleNormalizedVectors.get(singId);
    if (!singVec) continue;
    let maxSim = 0;
    for (const memberId of clusterItemIds) {
      const memberVec = titleNormalizedVectors.get(memberId);
      if (!memberVec) continue;
      const sim = dotProduct(singVec, memberVec);
      if (sim > maxSim) maxSim = sim;
    }
    if (maxSim >= candidateFloor) scored.push({ id: singId, maxSim });
  }
  scored.sort((a, b) => b.maxSim - a.maxSim);
  return scored.map((s) => s.id);
}

// Groups singletons into proto-groups via union-find on title cosine at candidate_floor.
// Returns arrays of size >= 2 only; isolated singletons are excluded. Exported for testing.
export function buildProtoGroups(
  singletonIds: ReadonlySet<number>,
  titleNormalizedVectors: ReadonlyMap<number, number[]>,
  candidateFloor: number,
): number[][] {
  const ids = [...singletonIds];
  const parent = new Map<number, number>();
  for (const id of ids) parent.set(id, id);

  function find(x: number): number {
    while (parent.get(x) !== x) {
      const px = parent.get(x)!;
      parent.set(x, parent.get(px)!);
      x = px;
    }
    return x;
  }

  for (let i = 0; i < ids.length; i++) {
    const idA = ids[i]!;
    const vA = titleNormalizedVectors.get(idA);
    if (!vA) continue;
    for (let j = i + 1; j < ids.length; j++) {
      const idB = ids[j]!;
      const vB = titleNormalizedVectors.get(idB);
      if (!vB) continue;
      if (dotProduct(vA, vB) >= candidateFloor) {
        const ra = find(idA);
        const rb = find(idB);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }

  const components = new Map<number, number[]>();
  for (const id of ids) {
    const root = find(id);
    const members = components.get(root);
    if (members) members.push(id);
    else components.set(root, [id]);
  }

  return [...components.values()].filter((g) => g.length >= 2);
}

// Splits arr into chunks of at most size elements. Exported for testing.
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function formatClusterMemberLines(
  cluster: Cluster,
  itemById: Map<number, PreprocessedItemRow>,
): string {
  return cluster.item_ids
    .map((id) => {
      const item = itemById.get(id);
      return `  - ${item ? item.title : `[item ${id}]`}`;
    })
    .join("\n");
}

function formatNumberedCandidateBlocks(
  ids: number[],
  itemById: Map<number, PreprocessedItemRow>,
): string {
  return ids
    .map((id, idx) => {
      const item = itemById.get(id);
      return `(${idx + 1}) ${item ? item.title : `[item ${id}]`}`;
    })
    .join("\n");
}

// Fraction of possible member pairs that are actually connected by an edge.
//
// Step 2 forms clusters from union-find connected components, which only requires
// a *path* between members: A~B and B~C puts A, B, C in one component even when A
// and C are unrelated. Density separates the two shapes. A genuine same-event
// cluster is near-fully connected (every article about one fire resembles every
// other), so density approaches 1.0. A component chained through a bridging
// article is a path, so density falls toward 2/n.
//
// Components of size 2 are density 1.0 by construction and cannot be chained.
// Exported for testing.
export function computeComponentDensity(
  memberIds: number[],
  edges: Map<number, Set<number>>,
): number {
  const n = memberIds.length;
  if (n < 2) return 1;
  const possiblePairs = (n * (n - 1)) / 2;
  let present = 0;
  for (let i = 0; i < n; i++) {
    const neighbors = edges.get(memberIds[i]!);
    if (!neighbors) continue;
    for (let j = i + 1; j < n; j++) {
      if (neighbors.has(memberIds[j]!)) present++;
    }
  }
  return present / possiblePairs;
}

// Highest density a component of this size can reach, given that step 2 caps
// each item at top_k neighbours. A 37-item component can hold at most 37*15/2
// edges against 37*36/2 possible pairs, so its density cannot exceed 15/36 =
// 0.42 no matter how coherent it is. Without this correction the largest and
// most important clusters (run #35's 37-source US-Iran cluster) would look
// maximally chained. Exported for testing.
export function maxAchievableDensity(size: number, topK: number): number {
  if (size < 2) return 1;
  return Math.min(1, topK / (size - 1));
}

// Density expressed as a fraction of what the top_k cap actually allows, so the
// measure means the same thing at every component size. 1.0 = as connected as it
// could possibly be; a chain stays near zero regardless of size. This is what the
// split pass thresholds on. Exported for testing.
export function computeCohesion(
  memberIds: number[],
  edges: Map<number, Set<number>>,
  topK: number,
): number {
  const density = computeComponentDensity(memberIds, edges);
  const ceiling = maxAchievableDensity(memberIds.length, topK);
  return ceiling > 0 ? Math.min(1, density / ceiling) : 1;
}

// Parses the split pass output into groups of 1-based member indices: one line
// per group, comma- or space-separated numbers. Out-of-range numbers are dropped.
// An index claimed by more than one group stays with the first — the partition
// must not duplicate an item into two clusters. Groups that fall below two
// members after that are discarded, and any member never claimed is left out
// entirely (the caller turns those into singletons). Exported for testing.
export function parseSplitOutput(text: string, memberCount: number): number[][] {
  const trimmed = text.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];

  const claimed = new Set<number>();
  const groups: number[][] = [];

  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim() || /^none$/i.test(line.trim())) continue;
    const group: number[] = [];
    for (const part of line.split(/[\s,]+/)) {
      const n = parseInt(part.trim(), 10);
      if (isNaN(n) || n < 1 || n > memberCount) continue;
      if (claimed.has(n)) continue;
      claimed.add(n);
      group.push(n);
    }
    if (group.length >= 2) groups.push(group);
    else for (const n of group) claimed.delete(n);
  }

  return groups;
}

// Parses "1,3" or "none" from attach LLM output into a 1-based index set.
// Exported for testing.
export function parseAttachOutput(text: string, candidateCount: number): Set<number> {
  const trimmed = text.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return new Set();
  const result = new Set<number>();
  for (const part of trimmed.split(/[\s,]+/)) {
    const n = parseInt(part.trim(), 10);
    if (!isNaN(n) && n >= 1 && n <= candidateCount) result.add(n);
  }
  return result;
}

interface AttachPassResult {
  clusters: Cluster[];
  remainingSingletonIds: Set<number>;
  phaseACalls: number;
  phaseBCalls: number;
  totalCalls: number;
  failedCalls: number;
  attached: number;
  newClusters: number;
  inputTokens: number | null;
  outputTokens: number | null;
  firstGenerationLogId: bigint | null;
}

async function attachSingletons(
  clusters: Cluster[],
  singletonIds: Set<number>,
  titleNormalizedVectors: Map<number, number[]>,
  itemById: Map<number, PreprocessedItemRow>,
  config: GroupingAttachConfig,
  runId: number,
): Promise<AttachPassResult> {
  if (singletonIds.size === 0) {
    return {
      clusters,
      remainingSingletonIds: new Set(),
      phaseACalls: 0,
      phaseBCalls: 0,
      totalCalls: 0,
      failedCalls: 0,
      attached: 0,
      newClusters: 0,
      inputTokens: 0,
      outputTokens: 0,
      firstGenerationLogId: null,
    };
  }

  const currentClusters: Cluster[] = [...clusters];
  const remainingSingletonIds = new Set(singletonIds);

  let phaseACalls = 0;
  let phaseBCalls = 0;
  let failedCalls = 0;
  let totalAttached = 0;
  let totalNewClusters = 0;
  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let firstGenerationLogId: bigint | null = null;

  const limit = pLimit(config.concurrency);

  function accumTokens(r: {
    inputTokens: number | null;
    outputTokens: number | null;
    generationLogId: bigint | null;
  }): void {
    if (r.inputTokens !== null) {
      totalInputTokens = totalInputTokens !== null ? totalInputTokens + r.inputTokens : null;
    } else if (r.generationLogId !== null) {
      totalInputTokens = null;
    }
    if (r.outputTokens !== null) {
      totalOutputTokens = totalOutputTokens !== null ? totalOutputTokens + r.outputTokens : null;
    } else if (r.generationLogId !== null) {
      totalOutputTokens = null;
    }
    if (r.generationLogId !== null && firstGenerationLogId === null) {
      firstGenerationLogId = r.generationLogId;
    }
  }

  // Run one LLM call for a chunk of candidates. Maps confirmed 1-based indices back to IDs.
  //
  // 429/503 responses are retried with exponential backoff before the call is
  // allowed to fail. This matters more here than it looks: a failed attach call
  // returns an empty set, which is indistinguishable from the model saying "none
  // of these belong" — the cluster silently doesn't grow and the run still
  // reports success. Run #34 (2026-06-19) lost roughly half its attach
  // judgments that way. Exhausted failures are counted into failedCalls so the
  // run summary can report degraded output instead of hiding it.
  async function callAttachChunk(
    phase: "A" | "B",
    label: string,
    systemPrompt: string,
    userPrompt: string,
    chunkIds: number[],
  ): Promise<Set<number>> {
    if (phase === "A") phaseACalls++;
    else phaseBCalls++;
    try {
      const result = await callWithBackoff(
        () =>
          callLLM({
            stage: "grouping",
            stageRunId: runId,
            model: config.model,
            systemPrompt,
            userPrompt,
            temperature: config.temperature,
            maxTokens: config.max_tokens,
            reasoningEffort: config.reasoning_effort,
            provider: config.provider,
            timeoutMs: config.timeout_ms,
            stream: config.stream,
          }),
        config,
        `grouping attach ${phase}`,
      );
      accumTokens(result);
      const confirmedNums = parseAttachOutput(result.text, chunkIds.length);
      const confirmedIds = new Set<number>();
      for (const n of confirmedNums) {
        const id = chunkIds[n - 1];
        if (id !== undefined) confirmedIds.add(id);
      }
      return confirmedIds;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failedCalls++;
      console.warn(
        `[grouping] attach phase ${phase} ${label}: LLM call failed after retries ` +
          `— treating as "attach nothing", grouping is degraded: ${msg}`,
      );
      return new Set();
    }
  }

  // Evaluate candidate singletons for one cluster; run chunked LLM calls sequentially.
  // Does not mutate shared state — callers apply results after Promise.all.
  async function evalCluster(
    clusterIdx: number,
  ): Promise<{ clusterIdx: number; confirmedIds: Set<number> } | null> {
    const cluster = currentClusters[clusterIdx]!;
    const candidates = buildClusterCandidateSingletons(
      cluster.item_ids,
      remainingSingletonIds,
      titleNormalizedVectors,
      config.candidate_floor,
    );
    if (candidates.length === 0) return null;

    const chunks = chunkArray(candidates, ATTACH_CHUNK_SIZE);
    const confirmedIds = new Set<number>();
    for (const chunk of chunks) {
      const chunkConfirmed = await callAttachChunk(
        "A",
        `cluster[${clusterIdx}]`,
        buildPhaseASystemPrompt(),
        buildPhaseAUserPrompt(
          formatClusterMemberLines(cluster, itemById),
          formatNumberedCandidateBlocks(chunk, itemById),
        ),
        chunk,
      );
      for (const id of chunkConfirmed) confirmedIds.add(id);
    }
    return confirmedIds.size > 0 ? { clusterIdx, confirmedIds } : null;
  }

  // Run Phase A for a set of cluster indices concurrently (pLimit).
  async function runPhaseA(clusterIdxs: number[]): Promise<Map<number, Set<number>>> {
    type Entry = { clusterIdx: number; confirmedIds: Set<number> } | null;
    // p-limit's return type is inferred as `any`; the cast restores the typed array.
    const entries = (await Promise.all(
      clusterIdxs.map((idx) => limit(() => evalCluster(idx))),
    )) as Array<Entry>;

    const resultMap = new Map<number, Set<number>>();
    for (const entry of entries) {
      if (entry) resultMap.set(entry.clusterIdx, entry.confirmedIds);
    }
    return resultMap;
  }

  // Apply Phase A results in ascending cluster index order (lower index wins contention).
  // Mutates currentClusters and remainingSingletonIds.
  function applyPhaseAResults(resultMap: Map<number, Set<number>>): Set<number> {
    const changedIdxs = new Set<number>();
    for (const [clusterIdx, confirmedIds] of [...resultMap.entries()].sort((a, b) => a[0] - b[0])) {
      const toAdd = [...confirmedIds].filter((id) => remainingSingletonIds.has(id));
      if (toAdd.length === 0) continue;
      const cluster = currentClusters[clusterIdx]!;
      currentClusters[clusterIdx] = { ...cluster, item_ids: [...cluster.item_ids, ...toAdd] };
      for (const id of toAdd) remainingSingletonIds.delete(id);
      totalAttached += toAdd.length;
      changedIdxs.add(clusterIdx);
    }
    return changedIdxs;
  }

  // --- Phase A: grow existing clusters ---
  const phaseAResultMap = await runPhaseA(currentClusters.map((_, idx) => idx));
  const phaseAChangedIdxs = applyPhaseAResults(phaseAResultMap);

  console.log(
    `[grouping] attach phase A: calls=${phaseACalls}, ` +
      `clusters_with_candidates=${phaseAResultMap.size}, ` +
      `clusters_changed=${phaseAChangedIdxs.size}, attached=${totalAttached}`,
  );

  // --- Phase B: cluster leftover singletons ---
  const phaseBStartIdx = currentClusters.length;
  const protoGroups = buildProtoGroups(
    remainingSingletonIds,
    titleNormalizedVectors,
    config.candidate_floor,
  );

  type PhaseBEntry = Set<number> | null;
  const phaseBEntries = (await Promise.all(
    protoGroups.map((group) =>
      limit(async (): Promise<PhaseBEntry> => {
        const chunks = chunkArray(group, ATTACH_CHUNK_SIZE);
        const confirmedIds = new Set<number>();
        for (const chunk of chunks) {
          const chunkConfirmed = await callAttachChunk(
            "B",
            `proto-group[${group[0]}]`,
            buildPhaseBSystemPrompt(),
            buildPhaseBUserPrompt(formatNumberedCandidateBlocks(chunk, itemById)),
            chunk,
          );
          for (const id of chunkConfirmed) confirmedIds.add(id);
        }
        return confirmedIds.size >= 2 ? confirmedIds : null;
      }),
    ),
  )) as Array<PhaseBEntry>;

  let phaseBNewClusters = 0;
  for (const confirmedIds of phaseBEntries) {
    if (!confirmedIds) continue;
    const members = [...confirmedIds].filter((id) => remainingSingletonIds.has(id));
    if (members.length < 2) continue;
    const groupItems = members
      .map((id) => itemById.get(id))
      .filter((i): i is PreprocessedItemRow => i !== undefined);
    currentClusters.push(buildAutoCluster(groupItems));
    for (const id of members) remainingSingletonIds.delete(id);
    phaseBNewClusters++;
    totalNewClusters++;
  }

  console.log(
    `[grouping] attach phase B: calls=${phaseBCalls}, ` +
      `proto_groups=${protoGroups.length}, new_clusters=${phaseBNewClusters}`,
  );

  // --- Cascade: one bounded re-pass of Phase A for clusters that changed ---
  // Covers clusters that grew in Phase A and new clusters formed in Phase B.
  const cascadeIdxs: number[] = [
    ...phaseAChangedIdxs,
    ...Array.from({ length: currentClusters.length - phaseBStartIdx }, (_, i) => phaseBStartIdx + i),
  ];

  if (cascadeIdxs.length > 0 && remainingSingletonIds.size > 0) {
    const phaseACallsPreCascade = phaseACalls;
    const cascadeResultMap = await runPhaseA(cascadeIdxs);
    const cascadeChangedIdxs = applyPhaseAResults(cascadeResultMap);
    console.log(
      `[grouping] attach cascade: calls=${phaseACalls - phaseACallsPreCascade}, ` +
        `clusters_changed=${cascadeChangedIdxs.size}, attached=${totalAttached}`,
    );
  }

  const totalCalls = phaseACalls + phaseBCalls;
  console.log(
    `[grouping] attach: phase_a_calls=${phaseACalls}, phase_b_calls=${phaseBCalls}, ` +
      `total_calls=${totalCalls}, failed_calls=${failedCalls}`,
  );
  if (failedCalls > 0) {
    console.warn(
      `[grouping] WARNING: ${failedCalls}/${totalCalls} attach call(s) failed after ` +
        `retries. Those clusters were not offered their candidates, so the cluster/` +
        `singleton split below understates real grouping. Re-run before tuning ` +
        `similarity_threshold or judging cluster quality.`,
    );
  }

  return {
    clusters: currentClusters,
    remainingSingletonIds,
    phaseACalls,
    phaseBCalls,
    totalCalls,
    failedCalls,
    attached: totalAttached,
    newClusters: totalNewClusters,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    firstGenerationLogId,
  };
}

// --- SPLIT PASS ---

interface SplitPassResult {
  groups: PreprocessedItemRow[][];
  freedSingletonIds: Set<number>;
  examined: number;
  componentsSplit: number;
  calls: number;
  failedCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  firstGenerationLogId: bigint | null;
}

// Re-partitions step-2 connected components that union-find may have chained
// together. Only components that are both large enough to chain (size >=
// min_size) and loosely connected (density < density_floor) are sent to the LLM;
// dense components are the same-event clusters we want and pass through without
// a call. Members the model does not place in any group are returned as freed
// singletons, where the attach pass can pick them up again.
//
// A call that fails after retries leaves its component intact. That is the
// conservative direction: the result is the over-merge we already had, not a
// shattered cluster. It is distinct from the model legitimately answering
// "none", which does dissolve the component, so failures are counted separately.
async function splitLowDensityComponents(
  candidateGroups: PreprocessedItemRow[][],
  edges: Map<number, Set<number>>,
  topK: number,
  config: GroupingSplitConfig,
  runId: number,
): Promise<SplitPassResult> {
  const freedSingletonIds = new Set<number>();
  let examined = 0;
  let componentsSplit = 0;
  let calls = 0;
  let failedCalls = 0;
  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let firstGenerationLogId: bigint | null = null;

  // Decide up front which components need a call, so the pass-through majority
  // never touches the limiter.
  const suspect: number[] = [];
  const cohesions = new Map<number, number>();
  for (let i = 0; i < candidateGroups.length; i++) {
    const group = candidateGroups[i]!;
    if (group.length < config.min_size) continue;
    const cohesion = computeCohesion(
      group.map((item) => Number(item.id)),
      edges,
      topK,
    );
    cohesions.set(i, cohesion);
    examined++;
    if (cohesion < config.density_floor) suspect.push(i);
  }

  if (suspect.length === 0) {
    console.log(
      `[grouping] split: examined=${examined}, suspect=0, calls=0 — ` +
        `no low-density components`,
    );
    return {
      groups: candidateGroups,
      freedSingletonIds,
      examined,
      componentsSplit: 0,
      calls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      firstGenerationLogId: null,
    };
  }

  const limit = pLimit(config.concurrency);

  const outcomes = await Promise.all(
    suspect.map((groupIdx) =>
      limit(async (): Promise<{ groupIdx: number; partition: number[][] | null }> => {
        const members = candidateGroups[groupIdx]!;
        const memberBlocks = members
          .map((item, idx) => `(${idx + 1}) ${item.title}`)
          .join("\n");
        calls++;
        try {
          const result = await callWithBackoff(
            () =>
              callLLM({
                stage: "grouping",
                stageRunId: runId,
                model: config.model,
                systemPrompt: buildSplitSystemPrompt(),
                userPrompt: buildSplitUserPrompt(memberBlocks),
                temperature: config.temperature,
                maxTokens: config.max_tokens,
                reasoningEffort: config.reasoning_effort,
                provider: config.provider,
                timeoutMs: config.timeout_ms,
                stream: config.stream,
              }),
            config,
            "grouping split",
          );
          if (result.inputTokens !== null && totalInputTokens !== null) {
            totalInputTokens += result.inputTokens;
          } else if (result.generationLogId !== null) {
            totalInputTokens = null;
          }
          if (result.outputTokens !== null && totalOutputTokens !== null) {
            totalOutputTokens += result.outputTokens;
          } else if (result.generationLogId !== null) {
            totalOutputTokens = null;
          }
          if (result.generationLogId !== null && firstGenerationLogId === null) {
            firstGenerationLogId = result.generationLogId;
          }
          return {
            groupIdx,
            partition: parseSplitOutput(result.text, members.length),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failedCalls++;
          console.warn(
            `[grouping] split component ${groupIdx} (size ${members.length}): ` +
              `LLM call failed after retries — leaving the component intact, ` +
              `possible over-merge retained: ${msg}`,
          );
          return { groupIdx, partition: null };
        }
      }),
    ),
  );

  // Apply deterministically, in component order, after every call has returned.
  const replacements = new Map<number, PreprocessedItemRow[][]>();
  for (const { groupIdx, partition } of outcomes) {
    if (partition === null) continue; // failed call — keep original
    const members = candidateGroups[groupIdx]!;
    const rebuilt: PreprocessedItemRow[][] = [];
    const placed = new Set<number>();
    for (const group of partition) {
      const rows = group.map((n) => members[n - 1]!);
      for (const n of group) placed.add(n);
      rebuilt.push(rows);
    }
    for (let n = 1; n <= members.length; n++) {
      if (!placed.has(n)) freedSingletonIds.add(Number(members[n - 1]!.id));
    }
    replacements.set(groupIdx, rebuilt);
    if (rebuilt.length !== 1 || rebuilt[0]!.length !== members.length) {
      componentsSplit++;
      const cohesion = cohesions.get(groupIdx) ?? 0;
      console.log(
        `[grouping] split component ${groupIdx}: size ${members.length} ` +
          `(cohesion ${cohesion.toFixed(2)}) → ${rebuilt.length} group(s) + ` +
          `${members.length - placed.size} singleton(s)`,
      );
    }
  }

  const groups: PreprocessedItemRow[][] = [];
  for (let i = 0; i < candidateGroups.length; i++) {
    const replacement = replacements.get(i);
    if (replacement) groups.push(...replacement);
    else groups.push(candidateGroups[i]!);
  }

  console.log(
    `[grouping] split: examined=${examined}, suspect=${suspect.length}, ` +
      `calls=${calls}, failed_calls=${failedCalls}, ` +
      `components_split=${componentsSplit}, freed_singletons=${freedSingletonIds.size}, ` +
      `groups ${candidateGroups.length}→${groups.length}`,
  );
  if (failedCalls > 0) {
    console.warn(
      `[grouping] WARNING: ${failedCalls}/${calls} split call(s) failed after retries. ` +
        `Those components were left intact and may still be over-merged.`,
    );
  }

  return {
    groups,
    freedSingletonIds,
    examined,
    componentsSplit,
    calls,
    failedCalls,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    firstGenerationLogId,
  };
}

// --- DESCRIBE PASS ---

interface DescribeParseResult {
  localIndex: number;
  title: string;
  summary: string;
}

function parseDescribeOutput(text: string, batchSize: number): Map<number, DescribeParseResult> {
  const results = new Map<number, DescribeParseResult>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const first = line.indexOf(";;");
    if (first === -1) continue;
    const last = line.lastIndexOf(";;");
    if (last === first) continue;
    const idxStr = line.slice(0, first).trim();
    if (!/^\d+$/.test(idxStr)) continue;
    const localIndex = parseInt(idxStr, 10);
    if (localIndex < 0 || localIndex >= batchSize) continue;
    const title = line.slice(first + 2, last).trim();
    const summary = line.slice(last + 2).trim();
    if (!title || !summary) continue;
    if (!results.has(localIndex)) results.set(localIndex, { localIndex, title, summary });
  }
  return results;
}

interface DescribePassResult {
  clusters: Cluster[];
  inputTokens: number | null;
  outputTokens: number | null;
  firstGenerationLogId: bigint | null;
}

async function describeGroups(
  clusters: Cluster[],
  itemById: Map<number, PreprocessedItemRow>,
  config: GroupingDescribeConfig,
  runId: number,
): Promise<DescribePassResult> {
  if (clusters.length === 0) {
    return { clusters: [], inputTokens: 0, outputTokens: 0, firstGenerationLogId: null };
  }

  const limit = pLimit(config.concurrency);

  const batches: Cluster[][] = [];
  for (let i = 0; i < clusters.length; i += config.batch_size) {
    batches.push(clusters.slice(i, i + config.batch_size));
  }

  type BatchResult = {
    descriptions: Map<number, { title: string; summary: string }>;
    inputTokens: number | null;
    outputTokens: number | null;
    generationLogId: bigint | null;
  };

  const batchResults = await Promise.all(
    batches.map((batch, batchIdx) =>
      limit(async (): Promise<BatchResult> => {
        const clusterBlocks = batch
          .map((cluster, localIdx) => {
            const items = cluster.item_ids
              .map((id) => itemById.get(id))
              .filter((i): i is PreprocessedItemRow => i !== undefined);
            return `[CLUSTER ${localIdx}]\n${formatItemBlocks(items)}`;
          })
          .join("\n");

        try {
          const result = await callWithBackoff(
            () =>
              callLLM({
                stage: "grouping",
                stageRunId: runId,
                model: config.model,
                systemPrompt: buildDescribeSystemPrompt(),
                userPrompt: buildDescribeUserPrompt(clusterBlocks),
                temperature: config.temperature,
                maxTokens: config.max_tokens,
                reasoningEffort: config.reasoning_effort,
                provider: config.provider,
                timeoutMs: config.timeout_ms,
                stream: config.stream,
              }),
            config,
            "grouping describe",
          );

          const parsed = parseDescribeOutput(result.text, batch.length);
          const descriptions = new Map<number, { title: string; summary: string }>();
          for (const [localIdx, r] of parsed) {
            descriptions.set(localIdx, { title: r.title, summary: r.summary });
          }

          const missing = batch.length - parsed.size;
          if (missing > 0) {
            console.warn(
              `[grouping] describe batch ${batchIdx + 1}/${batches.length}: ` +
                `${missing} cluster(s) missing from output — keeping fallback label`,
            );
          } else {
            console.log(
              `[grouping] describe batch ${batchIdx + 1}/${batches.length}: ` +
                `parsed ${parsed.size}/${batch.length}`,
            );
          }

          return {
            descriptions,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            generationLogId: result.generationLogId,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `[grouping] describe batch ${batchIdx + 1}/${batches.length}: ` +
              `LLM failed after retries — keeping fallback labels for all ` +
              `${batch.length} cluster(s): ${msg}`,
          );
          return {
            descriptions: new Map(),
            inputTokens: null,
            outputTokens: null,
            generationLogId: null,
          };
        }
      }),
    ),
  );

  const described: Cluster[] = [];
  let totalInputTokens: number | null = 0;
  let totalOutputTokens: number | null = 0;
  let firstGenerationLogId: bigint | null = null;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx]!;
    const result = batchResults[batchIdx]!;

    for (let localIdx = 0; localIdx < batch.length; localIdx++) {
      const cluster = batch[localIdx]!;
      const desc = result.descriptions.get(localIdx);
      described.push(desc ? { ...cluster, title: desc.title, summary: desc.summary } : cluster);
    }

    if (result.inputTokens !== null) {
      totalInputTokens = totalInputTokens !== null ? totalInputTokens + result.inputTokens : null;
    } else if (result.generationLogId !== null) {
      totalInputTokens = null;
    }
    if (result.outputTokens !== null) {
      totalOutputTokens =
        totalOutputTokens !== null ? totalOutputTokens + result.outputTokens : null;
    } else if (result.generationLogId !== null) {
      totalOutputTokens = null;
    }
    if (result.generationLogId !== null && firstGenerationLogId === null) {
      firstGenerationLogId = result.generationLogId;
    }
  }

  return {
    clusters: described,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    firstGenerationLogId,
  };
}

// --- MAIN EXPORT ---

export async function runGrouping(
  options: { preprocessorRunId?: number; modelOverride?: string } = {},
): Promise<GroupingRun> {
  const pool = getPool();
  const modelConfig = loadModelConfig();
  const groupingConfig = modelConfig.grouping;
  const embConfig = modelConfig.embeddings;

  // 1. Find preprocessor run (explicit id or latest completed).
  let preprocessorRunId: number;
  if (options.preprocessorRunId !== undefined) {
    preprocessorRunId = options.preprocessorRunId;
  } else {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM preprocessor_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
    );
    if (!rows[0]) throw new Error("No completed preprocessor runs found");
    preprocessorRunId = rows[0].id;
  }

  const model = options.modelOverride ?? groupingConfig.model;
  const bodyCap = groupingConfig.embedding.body_cap;
  const threshold = groupingConfig.embedding.similarity_threshold;
  const topK = groupingConfig.embedding.top_k;

  // 2. Create grouping_runs row.
  const { rows: runRows } = await pool.query<{ id: number }>(
    `INSERT INTO grouping_runs (started_at, preprocessor_run_id, model_used)
     VALUES (NOW(), $1, $2) RETURNING id`,
    [preprocessorRunId, model],
  );
  const runId = runRows[0]!.id;
  console.log(`[grouping] run #${runId}: preprocessor_run_id=${preprocessorRunId}, model=${model}`);
  console.log(
    `[grouping] config: similarity_threshold=${threshold}, top_k=${topK}, ` +
      `attach=${groupingConfig.attach.enabled}`,
  );

  try {
    const stageStartedAt = Date.now();

    // --- STEP 1: EMBED ---
    // Compute two embeddings per item in the same batched loop:
    //   body embedding  = title + body[:body_cap]  (used for step-2 connected-components)
    //   title embedding = title only               (used for step-3 attach pass)
    const items = await getClusteringItems(preprocessorRunId);
    console.log(`[grouping] step 1 embed: ${items.length} items to embed`);

    const batchSize = embConfig.batch_size;
    let embeddedCount = 0;
    for (let offset = 0; offset < items.length; offset += batchSize) {
      const batch = items.slice(offset, offset + batchSize);

      // Build body and title embed texts from english_* columns so all clustering
      // happens in one English embedding space. Fallback to original title/body
      // for rows that pre-date the migration (english_title IS NULL).
      const bodyTexts = batch.map((item) => {
        const title = item.english_title ?? item.title;
        const body = (item.english_body ?? item.body_text)?.replace(/\s+/g, " ").trim() ?? "";
        return body.length > 0 ? `${title}\n${body.slice(0, bodyCap)}` : title;
      });
      const titleTexts = batch.map((item) => item.english_title ?? item.title);

      // Interleave [body0, title0, body1, title1, ...] so one API call covers both.
      const interleavedTexts = batch.flatMap((_, i) => [bodyTexts[i]!, titleTexts[i]!]);

      const vectors = await embed(interleavedTexts, {
        stage: "grouping",
        stageRunId: runId,
        model: embConfig.model,
        provider: embConfig.provider,
        timeoutMs: embConfig.timeout_ms,
      });

      for (let i = 0; i < batch.length; i++) {
        const itemId = Number(batch[i]!.id);
        const bodyVec = vectors[2 * i]!;
        const titleVec = vectors[2 * i + 1]!;
        const bodyVecStr = `[${bodyVec.join(",")}]`;
        const titleVecStr = `[${titleVec.join(",")}]`;
        await pool.query(
          `INSERT INTO item_embeddings (preprocessed_item_id, model, dims, embedding, title_embedding)
           VALUES ($1, $2, $3, $4::vector, $5::vector)
           ON CONFLICT (preprocessed_item_id) DO UPDATE
             SET model           = EXCLUDED.model,
                 dims            = EXCLUDED.dims,
                 embedding       = EXCLUDED.embedding,
                 title_embedding = EXCLUDED.title_embedding`,
          [itemId, embConfig.model, embConfig.dims, bodyVecStr, titleVecStr],
        );
        embeddedCount++;
      }
      console.log(`[grouping] embedded ${embeddedCount}/${items.length}`);
    }

    // --- STEP 2: CANDIDATE GROUPS ---
    // First-pass clustering runs on body embeddings at similarity_threshold,
    // deliberately conservative to keep a low false-merge rate.
    const itemIds = items.map((i) => Number(i.id));

    const { rows: embRows } = await pool.query<{
      preprocessed_item_id: string;
      embedding: string;
      title_embedding: string | null;
    }>(
      `SELECT preprocessed_item_id, embedding::text, title_embedding::text
       FROM item_embeddings
       WHERE preprocessed_item_id = ANY($1)`,
      [itemIds],
    );

    if (embRows.length < itemIds.length) {
      console.warn(
        `[grouping] ${itemIds.length - embRows.length} item(s) have no embedding — will be singletons`,
      );
    }

    const normalizedVectors = new Map<number, number[]>();
    const titleNormalizedVectors = new Map<number, number[]>();
    for (const row of embRows) {
      const id = Number(row.preprocessed_item_id);
      // Body embedding — used for connected-components (step 2).
      const v = parseVectorText(row.embedding);
      const norm = l2Norm(v);
      if (norm > 0) normalizedVectors.set(id, v.map((x) => x / norm));
      // Title embedding — used for the attach pass (step 3).
      if (row.title_embedding) {
        const tv = parseVectorText(row.title_embedding);
        const tnorm = l2Norm(tv);
        if (tnorm > 0) titleNormalizedVectors.set(id, tv.map((x) => x / tnorm));
      }
    }

    const embeddedIds = [...normalizedVectors.keys()];
    const edges = new Map<number, Set<number>>();
    for (const id of embeddedIds) edges.set(id, new Set());

    let totalPairsAboveThreshold = 0;
    for (let i = 0; i < embeddedIds.length; i++) {
      const idA = embeddedIds[i]!;
      const vA = normalizedVectors.get(idA)!;
      const aboveThreshold: [number, number][] = [];
      for (let j = i + 1; j < embeddedIds.length; j++) {
        const idB = embeddedIds[j]!;
        const sim = dotProduct(vA, normalizedVectors.get(idB)!);
        if (sim >= threshold) aboveThreshold.push([idB, sim]);
      }
      totalPairsAboveThreshold += aboveThreshold.length;
      aboveThreshold.sort((a, b) => b[1] - a[1]);
      for (const [idB] of aboveThreshold.slice(0, topK)) {
        edges.get(idA)!.add(idB);
        edges.get(idB)!.add(idA);
      }
    }

    const parent = new Map<number, number>();
    for (const id of embeddedIds) parent.set(id, id);

    function find(x: number): number {
      while (parent.get(x) !== x) {
        const px = parent.get(x)!;
        parent.set(x, parent.get(px)!);
        x = px;
      }
      return x;
    }

    function union(a: number, b: number): void {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    for (const [idA, neighbors] of edges) {
      for (const idB of neighbors) union(idA, idB);
    }

    const components = new Map<number, number[]>();
    for (const id of embeddedIds) {
      const root = find(id);
      const members = components.get(root);
      if (members) members.push(id);
      else components.set(root, [id]);
    }

    const itemById = new Map<number, PreprocessedItemRow>();
    for (const item of items) itemById.set(Number(item.id), item);

    const candidateGroups: PreprocessedItemRow[][] = [];
    const clusteredIds = new Set<number>();
    for (const members of components.values()) {
      if (members.length >= 2) {
        const sorted = members
          .map((id) => itemById.get(id)!)
          .sort((a, b) => Number(a.id) - Number(b.id));
        candidateGroups.push(sorted);
        for (const item of sorted) clusteredIds.add(Number(item.id));
      }
    }

    const singletonIds = new Set<number>();
    for (const id of itemIds) {
      if (!clusteredIds.has(id)) singletonIds.add(id);
    }

    const sizeDistribution = new Map<number, number>();
    for (const g of candidateGroups) {
      sizeDistribution.set(g.length, (sizeDistribution.get(g.length) ?? 0) + 1);
    }
    const distStr = [...sizeDistribution.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sz, n]) => `size=${sz}:${n}`)
      .join(", ");
    console.log(
      `[grouping] step 2 candidate groups: items=${embeddedIds.length}, ` +
        `groups=${candidateGroups.length}, singletons=${singletonIds.size}, ` +
        `pairs_above_threshold=${totalPairsAboveThreshold}` +
        (distStr.length > 0 ? `, size_distribution=[${distStr}]` : ""),
    );

    let totalInputTokens: number | null = 0;
    let totalOutputTokens: number | null = 0;
    let firstGenerationLogId: bigint | null = null;

    function accumulateTokens(
      inputTokens: number | null,
      outputTokens: number | null,
      generationLogId: bigint | null,
    ): void {
      if (inputTokens !== null) {
        totalInputTokens = totalInputTokens !== null ? totalInputTokens + inputTokens : null;
      } else if (generationLogId !== null) {
        totalInputTokens = null;
      }
      if (outputTokens !== null) {
        totalOutputTokens =
          totalOutputTokens !== null ? totalOutputTokens + outputTokens : null;
      } else if (generationLogId !== null) {
        totalOutputTokens = null;
      }
      if (generationLogId !== null && firstGenerationLogId === null) {
        firstGenerationLogId = generationLogId;
      }
    }

    // --- STEP 2b: SPLIT ---
    // Union-find only requires a path between members, so a bridging article can
    // chain unrelated stories into one component. Low-density components are
    // re-partitioned by the LLM before anything downstream treats them as
    // clusters; dense ones pass through untouched. Freed members rejoin the
    // singleton pool, where the attach pass can place them properly.
    let workingGroups = candidateGroups;

    if (groupingConfig.split.enabled) {
      const splitResult = await splitLowDensityComponents(
        candidateGroups,
        edges,
        topK,
        groupingConfig.split,
        runId,
      );
      workingGroups = splitResult.groups;
      for (const id of splitResult.freedSingletonIds) singletonIds.add(id);
      accumulateTokens(
        splitResult.inputTokens,
        splitResult.outputTokens,
        splitResult.firstGenerationLogId,
      );
      console.log(
        `[grouping] step 2b split: groups=${workingGroups.length}, ` +
          `singletons=${singletonIds.size}`,
      );
    } else {
      console.log(`[grouping] step 2b split: disabled`);
    }

    // --- STEP 3: ATTACH ---
    // Anchor-centric, title-embedding-based. Covers two cases:
    //   singleton → existing cluster  (LLM confirms same event as cluster)
    //   singleton ↔ singleton         (LLM confirms same event; forms new cluster)
    // Sequential union-find: anchors processed in descending best-title-sim order;
    // consumed singletons are not reprocessed; newly formed pairs are available
    // as cluster candidates for subsequent anchors.
    let preClusters: Cluster[];
    let remainingSingletonIds: Set<number>;

    const singletonsBefore = singletonIds.size;

    if (!groupingConfig.attach.enabled) {
      console.log(
        `[grouping] step 3 attach: disabled — ${singletonIds.size} singletons unchanged`,
      );
      preClusters = workingGroups.map(buildAutoCluster);
      remainingSingletonIds = new Set(singletonIds);
    } else {
      const initialClusters = workingGroups.map(buildAutoCluster);
      const attachResult = await attachSingletons(
        initialClusters,
        singletonIds,
        titleNormalizedVectors,
        itemById,
        groupingConfig.attach,
        runId,
      );
      preClusters = attachResult.clusters;
      remainingSingletonIds = attachResult.remainingSingletonIds;
      accumulateTokens(
        attachResult.inputTokens,
        attachResult.outputTokens,
        attachResult.firstGenerationLogId,
      );
      console.log(
        `[grouping] step 3 attach: phase_a_calls=${attachResult.phaseACalls}, ` +
          `phase_b_calls=${attachResult.phaseBCalls}, ` +
          `total_calls=${attachResult.totalCalls}, ` +
          `failed_calls=${attachResult.failedCalls}, ` +
          `attached=${attachResult.attached}, ` +
          `new_clusters=${attachResult.newClusters}, ` +
          `singletons=${singletonsBefore}→${remainingSingletonIds.size}`,
      );
    }

    let finalClusters: Cluster[] = preClusters;

    // --- STEP 4: DESCRIBE ---
    // Batch LLM pass that writes a neutral title + short summary for every
    // multi-item cluster. Singletons skip this pass.
    const describeResult = await describeGroups(
      finalClusters,
      itemById,
      groupingConfig.describe,
      runId,
    );
    finalClusters = describeResult.clusters;

    accumulateTokens(
      describeResult.inputTokens,
      describeResult.outputTokens,
      describeResult.firstGenerationLogId,
    );

    console.log(
      `[grouping] step 4 describe: ${finalClusters.length} clusters described, ` +
        `${remainingSingletonIds.size} singletons pass through unchanged`,
    );

    const digestText = formatFlatClusterLines(finalClusters);
    const totalDurationMs = Date.now() - stageStartedAt;

    await pool.query(
      `UPDATE grouping_runs
       SET completed_at      = NOW(),
           input_tokens      = $1,
           output_tokens     = $2,
           duration_ms       = $3,
           digest            = $4,
           generation_log_id = $5
       WHERE id = $6`,
      [totalInputTokens, totalOutputTokens, totalDurationMs, digestText, firstGenerationLogId, runId],
    );

    console.log(
      `[grouping] run #${runId} complete: ${finalClusters.length} clusters, ` +
        `${remainingSingletonIds.size} singletons, duration=${totalDurationMs}ms`,
    );

    return await fetchGroupingRun(pool, runId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE grouping_runs SET completed_at = NOW() WHERE id = $1 AND completed_at IS NULL`,
      [runId],
    );
    throw new Error(`Grouping run #${runId} failed: ${msg}`);
  }
}

interface GroupingRunRow {
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

async function fetchGroupingRun(pool: import("pg").Pool, runId: number): Promise<GroupingRun> {
  const { rows } = await pool.query<GroupingRunRow>(
    "SELECT * FROM grouping_runs WHERE id = $1",
    [runId],
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
