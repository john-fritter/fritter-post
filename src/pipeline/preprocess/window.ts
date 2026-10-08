/**
 * Pure helpers for preprocessor window selection — extracted so tests can
 * exercise the logic without a database connection or dotenv side-effects.
 */

export function computeWindowStart(windowHours: number, nowMs: number = Date.now()): Date {
  return new Date(nowMs - windowHours * 60 * 60 * 1000);
}

export function isInWindow(fetchedAt: Date, windowStart: Date): boolean {
  return fetchedAt >= windowStart;
}

/**
 * Returns true if the backstop should DROP this item (published_at predates
 * the max_age_days cutoff). Null published_at and null max_age_days are never
 * dropped — the backstop is a guard against archive-dump feeds only.
 */
export function isBackstopDropped(
  publishedAt: Date | null,
  maxAgeDays: number | null,
  nowMs: number = Date.now(),
): boolean {
  if (publishedAt === null || maxAgeDays === null) return false;
  const cutoff = new Date(nowMs - maxAgeDays * 24 * 60 * 60 * 1000);
  return publishedAt < cutoff;
}
