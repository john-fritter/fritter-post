// Shared normalization for LLM-returned item refs (C<digits> / S<digits>).
// Models may echo refs with brackets ("[C3]"), trailing punctuation
// ("S17566."), or inconsistent case. Pile keys are bare and upper-case.
// Extract the canonical token rather than trusting the raw string.

const REF_RE = /[cs]\d+/i;
const REF_RE_GLOBAL = /[cs]\d+/gi;

/** First C/S ref in a token, upper-cased; null if none present. */
export function normalizeRef(token: string): string | null {
  const m = token.match(REF_RE);
  return m ? m[0].toUpperCase() : null;
}

/** All C/S refs in a string, in order, upper-cased. */
export function extractRefs(text: string): string[] {
  const m = text.match(REF_RE_GLOBAL);
  return m ? m.map((r) => r.toUpperCase()) : [];
}
