import type { NoveltyGrade } from "./prompt.js";

/** The sizes a story can run as, largest first. */
export type PieceTier = "feature" | "standard" | "brief";
const TIER_ORDER: PieceTier[] = ["feature", "standard", "brief"];

/** What a grade does to a row. */
export interface NoveltyEffect {
  /** Withheld from threading and the pile: news the reader already has. */
  withhold: boolean;
  /** Points off the pass-1 score before anything ranks on it. */
  penalty: number;
  /** The largest piece the story may run as; null is uncapped. */
  maxTier: PieceTier | null;
}

export interface GradeEffects {
  minor: { penalty: number; max_tier: PieceTier | null };
  routine: { penalty: number; max_tier: PieceTier | null };
}

const UNCHANGED: NoveltyEffect = { withhold: false, penalty: 0, maxTier: null };

/**
 * The effect of a grade. Only `minor` and `routine` reduce, and by how much is
 * the reader's policy (models.yaml `rerun.grades`). `new` and `development` pass
 * unchanged. `rerun` is withheld. A missing grade -- a failed call, an
 * unreadable line -- is unchanged: the check fails open.
 */
export function effectOf(grade: NoveltyGrade | null, grades: GradeEffects): NoveltyEffect {
  switch (grade) {
    case "rerun":
      return { withhold: true, penalty: 0, maxTier: null };
    case "minor":
      return { withhold: false, penalty: grades.minor.penalty, maxTier: grades.minor.max_tier };
    case "routine":
      return { withhold: false, penalty: grades.routine.penalty, maxTier: grades.routine.max_tier };
    default:
      return UNCHANGED;
  }
}

/** The score a reduced row ranks on. Never below zero: a score is 0-100. */
export function adjustedScore(score: number, penalty: number): number {
  return Math.max(0, score - penalty);
}

/** True when `tier` is no larger than `maxTier`. A null cap allows anything. */
export function withinCap(tier: string, maxTier: PieceTier | null): boolean {
  if (maxTier === null) return true;
  const t = TIER_ORDER.indexOf(tier as PieceTier);
  // Anything off the ladder (cut) is smaller than every tier on it.
  return t === -1 || t >= TIER_ORDER.indexOf(maxTier);
}

/**
 * A thread's cap is its least-capped member's. A section runs as large as its
 * biggest real news allows: one development among five routine strikes is
 * still a development, and the routine members are reduced by their own lower
 * scores (the thread is as important as its best *adjusted* member).
 */
export function mostPermissiveTier(caps: Array<PieceTier | null>): PieceTier | null {
  if (caps.length === 0 || caps.includes(null)) return null;
  return caps.reduce((a, b) => (TIER_ORDER.indexOf(a!) <= TIER_ORDER.indexOf(b!) ? a : b))!;
}

/** One printed piece retrieved for a candidate. */
export interface PriorMatch {
  rowKey: string;
  similarity: number;
  publishedOn: string;
}

/**
 * Groups retrieved priors by candidate. The judge reads them newest first,
 * because the most recent printed story is what the reader has freshest; the
 * closest by similarity are the ones shown with their bodies (`bodiesShown`).
 */
export function groupPriors<T extends PriorMatch>(
  pairs: T[],
  bodiesShown: number,
): Map<string, Array<T & { withBody: boolean }>> {
  const byRow = new Map<string, T[]>();
  for (const p of pairs) {
    const list = byRow.get(p.rowKey) ?? [];
    list.push(p);
    byRow.set(p.rowKey, list);
  }
  const out = new Map<string, Array<T & { withBody: boolean }>>();
  for (const [key, list] of byRow) {
    const closest = new Set(
      [...list].sort((a, b) => b.similarity - a.similarity).slice(0, bodiesShown),
    );
    out.set(
      key,
      [...list]
        .sort((a, b) => b.publishedOn.localeCompare(a.publishedOn) || b.similarity - a.similarity)
        .map((p) => ({ ...p, withBody: closest.has(p) })),
    );
  }
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
