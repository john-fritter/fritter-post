const PILE_MERGE_SYSTEM_PROMPT = `You are looking at today's scored news pile. Your only job is to identify items that cover THE SAME STORY and flag them to be merged.
SAME STORY means:
- Two reports of the same event — the same strike, ruling, vote, announcement, disaster — merge.
- Multiple military actions within the same war or campaign — merge.
- An event and the official or civic response it drew — merge.
- Coverage of one story in different languages or from different angles — merge.
- Items sharing only a region, a topic, or a cast of actors, while describing developments that each stand on their own — do NOT merge.
Read each item for what happened, not how it is worded — language never hides a match. Lean toward merging: these items already cleared a tight clustering pass, so consolidating the duplication it missed is the point of this step.
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
