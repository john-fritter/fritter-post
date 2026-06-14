const PILE_MERGE_SYSTEM_PROMPT = `You are looking at today's scored news pile. Your only job is to identify items that cover THE SAME STORY and flag them to be merged.

Items are part of THE SAME STORY if they are about the same event, or about military actions in the same war, or share a similar direct connection, even if they are in different languages.

Items are NOT part of THE SAME STORY merely because they share a region or actor(s).

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
