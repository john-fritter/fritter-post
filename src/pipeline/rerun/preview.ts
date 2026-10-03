// Re-ranking a past day under a set of novelty grades, without the pipeline.
//
// The novelty grades change three numbers the editor already ranks on -- a
// row's score, a thread's score and a thread's source count -- plus a size cap,
// and everything downstream of those is arithmetic: the pile cut, the combined
// score and the tier ladder. So a day's front page under new grades can be
// rebuilt from the stored pass-1 scores and threads without re-running
// threading, the editor or the writers, and shown beside the same day without
// them. That is what lets the reader judge the change on ten real papers before
// it runs once.
//
// What it does not reproduce: the thread pass's membership (it keeps the day's
// actual threads), the editor's LLM tie-break (ties fall to score, then key),
// and the writers' material-based tier swap. All three apply equally to the
// "before" and "after" columns, so they move both and the difference stays the
// change's.

import { combinedScore, assignTiersWithCaps, type EditorTier } from "../editor/index.js";
import { deriveThreadScores, type ThreadCandidate } from "../thread/index.js";
import { adjustedScore, mostPermissiveTier, type NoveltyEffect, type PieceTier } from "./select.js";

export interface PreviewRow {
  /** C<clusterIndex> or S<preprocessedItemId>. */
  key: string;
  title: string;
  score: number;
  sourceCount: number;
}

export interface PreviewThread {
  /** T<threadIndex>. */
  key: string;
  title: string;
  members: PreviewRow[];
}

export interface PreviewConfig {
  pileTarget: number;
  sourceWeight: number;
  featureCount: number;
  standardCount: number;
}

export interface PreviewStory {
  key: string;
  kind: "thread" | "row";
  title: string;
  score: number;
  sourceCount: number;
  combined: number;
  rank: number;
  tier: EditorTier;
  maxTier: PieceTier | null;
  /** For a thread, its member keys after withholding. */
  memberKeys: string[];
}

/**
 * The ranked, tiered paper a day's rows and threads produce under `effects`
 * (row key → what its grade does). A row with no effect is unchanged. `withheld`
 * rows leave the paper -- as a story, and as a thread member.
 */
export function previewRanking(
  rows: PreviewRow[],
  threads: PreviewThread[],
  effects: Map<string, NoveltyEffect>,
  cfg: PreviewConfig,
): PreviewStory[] {
  const effect = (key: string): NoveltyEffect | undefined => effects.get(key);
  const absorbed = new Set(threads.flatMap((t) => t.members.map((m) => m.key)));

  type Pending = Omit<PreviewStory, "combined" | "rank" | "tier">;
  const pending: Pending[] = [];

  for (const r of rows) {
    if (absorbed.has(r.key)) continue;
    const e = effect(r.key);
    if (e?.withhold) continue;
    pending.push({
      key: r.key,
      kind: "row",
      title: r.title,
      score: adjustedScore(r.score, e?.penalty ?? 0),
      sourceCount: Math.max(1, r.sourceCount),
      maxTier: e?.maxTier ?? null,
      memberKeys: [],
    });
  }

  for (const t of threads) {
    const kept = t.members.filter((m) => !effect(m.key)?.withhold);
    if (kept.length === 0) continue;
    const candidates: ThreadCandidate[] = kept.map((m) => {
      const e = effect(m.key);
      const reduced = (e?.penalty ?? 0) > 0 || (e?.maxTier ?? null) !== null;
      return {
        ref: m.key,
        itemType: m.key.startsWith("C") ? "cluster" : "singleton",
        clusterIndex: null,
        preprocessedItemId: null,
        score: adjustedScore(m.score, e?.penalty ?? 0),
        sourceCount: m.sourceCount,
        title: m.title,
        summary: "",
        ...(reduced ? { reduced: true } : {}),
      };
    });
    const { score, sourceCount } = deriveThreadScores(candidates);
    pending.push({
      key: t.key,
      kind: "thread",
      title: t.title,
      score,
      sourceCount,
      maxTier: mostPermissiveTier(kept.map((m) => effect(m.key)?.maxTier ?? null)),
      memberKeys: kept.map((m) => m.key),
    });
  }

  // The pile: top `pileTarget` by score, as assembleGroupingPile cuts it.
  const pile = [...pending]
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, cfg.pileTarget);

  // The editor: combined desc, then score, then key (no LLM tie-break here).
  const ranked = pile
    .map((p) => ({ ...p, combined: combinedScore(p.score, p.sourceCount, cfg.sourceWeight) }))
    .sort((a, b) => b.combined - a.combined || b.score - a.score || a.key.localeCompare(b.key));
  const tiers = assignTiersWithCaps(
    ranked.map((r) => r.maxTier),
    cfg.featureCount,
    cfg.standardCount,
  );
  return ranked.map((r, i) => ({ ...r, rank: i + 1, tier: tiers[i]! }));
}
