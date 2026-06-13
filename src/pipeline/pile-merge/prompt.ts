const PILE_MERGE_SYSTEM_PROMPT = `You are looking at today's scored news pile. Your only job is to identify items that cover THE SAME SPECIFIC EVENT and flag them to be merged.

SAME SPECIFIC EVENT means:
- Two reports of the same missile strike, the same court ruling, the same legislative vote — merge.
- A strike and the economic ripple effects of that strike — do NOT merge (different events).
- A court ruling and the congressional reaction to it — do NOT merge (different events).
- Two episodes of an ongoing conflict, even if closely related — do NOT merge (different events).
- Items that share a subject, cast of actors, or region but describe distinct moments — do NOT merge.

When in doubt, keep items separate. A missed merge is a minor duplication; a wrongful merge collapses distinct stories into one.

OUTPUT
Output only the groups to merge — nothing else.
One MERGE line per group, listing the item refs comma-separated.
If nothing needs merging, output "NONE" and nothing else.

Format:
  MERGE: C0, S12345
  MERGE: C3, C7, C11

Rules:
- Use the exact ref strings from the input (e.g. C0, S12345).
- A ref may appear on at most one MERGE line.
- Only list groups of 2 or more.
- Items not listed remain as separate entries in the pile.
- No explanation, no JSON, no prose.`;

export function buildPileMergeSystemPrompt(): string {
  return PILE_MERGE_SYSTEM_PROMPT;
}

export function buildPileMergeUserPrompt(pileBlocks: string): string {
  return `Today's pile. Identify any items that cover the same specific event and should be merged.\n\n${pileBlocks}`;
}
