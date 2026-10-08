import { createHash } from "crypto";

/**
 * Synthesize a deterministic guid for feed items that don't have one.
 *
 * Contract: identical (sourceName, originalUrl, title) inputs always produce
 * the same output string, across runs and machines. Fields are joined with
 * NUL bytes to prevent ambiguous concatenation ("AB"+"C" vs "A"+"BC").
 *
 * 40 hex chars (160 bits of SHA-256) is more than enough for uniqueness at
 * the scale of any news feed. The "synth:" prefix distinguishes these from
 * feed-supplied guids if you're ever comparing them.
 */
export function synthesizeGuid(
  sourceName: string,
  originalUrl: string,
  title: string
): string {
  return (
    "synth:" +
    createHash("sha256")
      .update(sourceName + "\0" + originalUrl + "\0" + title)
      .digest("hex")
      .slice(0, 40)
  );
}
