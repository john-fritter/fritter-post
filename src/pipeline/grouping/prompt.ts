const DESCRIBE_SYSTEM_PROMPT = `You are writing brief editorial labels for news clusters. Each cluster is a group of articles that cover the same or closely related events. For each cluster you are given, write a neutral, factual title and a short summary.

OUTPUT
One line per cluster and nothing else — no JSON, no markdown, no prose before or after.

Each line:
  index;;title;;summary

Fields:
  index    — the integer from [CLUSTER N], reproduced exactly
  title    — short, neutral, descriptive label; no framing or adjectives not in the sources
  summary  — 2 to 4 factual sentences. What happened. No stakes, no framing.

The delimiter is ;; (two semicolons). Write exactly one line per cluster.`;

export function buildDescribeSystemPrompt(): string {
  return DESCRIBE_SYSTEM_PROMPT;
}

export function buildDescribeUserPrompt(clusterBlocks: string): string {
  return `Here are today's news clusters. Write a title and summary for each one.\n\n${clusterBlocks}`;
}

// Split pass: a step-2 connected component chained several stories together via
// union-find transitivity (A~B and B~C puts A, B, C in one component even when A
// and C are unrelated). Partition it back into same-event groups.
const SPLIT_SYSTEM_PROMPT = `You are separating a group of articles that an automated similarity pass may have merged incorrectly.

The articles below were grouped because each one resembled at least one other article in the group. That is a weaker test than covering the same story: a chain of "A resembles B, B resembles C" can pull unrelated stories into one group. Your job is to find the genuine same-event groups inside it.

THE SAME STORY:
- The same event — a strike, ruling, vote, announcement, disaster — reported by any outlet, in any language.
- Military actions within the same war or campaign.
- An event and the official or civic response it drew.

Articles that share only a region, a topic, an ongoing situation, or a cast of actors — while reporting developments that stand on their own — are NOT the same story. Two articles about different incidents in different places belong in different groups even when the same force or trend is behind both.

The group may already be correct. If every article covers one event, say so by returning them as a single group.

OUTPUT
One line per same-event group, each line a comma-separated list of article numbers (e.g. "1,4,5").
Write only groups of two or more. Omit any article that does not share an event with at least one other — omitted articles are treated as standalone.
If no two articles share an event, output "none" and nothing else.
No explanation. No JSON. No prose.`;

export function buildSplitSystemPrompt(): string {
  return SPLIT_SYSTEM_PROMPT;
}

export function buildSplitUserPrompt(memberBlocks: string): string {
  return (
    `ARTICLES:\n${memberBlocks}\n\n` +
    `Which articles cover the same specific event? Group them.`
  );
}

// Phase A: given an existing cluster, which numbered candidate articles belong to it?
const PHASE_A_SYSTEM_PROMPT = `You are deciding which candidate articles belong to an existing news cluster.

A CLUSTER is a group of articles already confirmed to cover the same specific event. Each numbered CANDIDATE is a standalone article that is topically similar but not yet confirmed to be the same event.

Attach a candidate when it covers the SAME SPECIFIC EVENT as the cluster:
- The same event — a strike, ruling, vote, announcement, disaster — reported by any outlet, in any language.
- Military actions within the same war or campaign.
- An event and the official or civic response it drew.

A candidate that shares only a region, a topic, an ongoing situation, or a cast of actors — while reporting a development that stands on its own — is NOT the same event; do not attach it.

OUTPUT
If no candidates belong: output "none" and nothing else.
If one or more belong: output only their numbers as a comma-separated list (e.g. "1,3") and nothing else.
No explanation. No JSON. No prose.`;

export function buildPhaseASystemPrompt(): string {
  return PHASE_A_SYSTEM_PROMPT;
}

export function buildPhaseAUserPrompt(clusterMemberLines: string, candidateBlocks: string): string {
  return (
    `CLUSTER MEMBERS:\n${clusterMemberLines}\n\nCANDIDATES:\n${candidateBlocks}\n\n` +
    `Which candidate numbers (if any) cover the same specific event as this cluster?`
  );
}

// Phase B: given a group of singletons, which ones cover the same specific event?
const PHASE_B_SYSTEM_PROMPT = `You are deciding which articles in a group cover the same specific news event.

THE SAME STORY:
- The same event — a strike, ruling, vote, announcement, disaster — reported by any outlet, in any language.
- Military actions within the same war or campaign.
- An event and the official or civic response it drew.

Articles that share only a region, a topic, an ongoing situation, or a cast of actors — while reporting developments that stand on their own — are NOT the same story.

OUTPUT
List the numbers of articles that all cover the same specific event. If fewer than two articles share the same specific event, output "none" and nothing else.
Output only the numbers as a comma-separated list (e.g. "2,5") and nothing else.
No explanation. No JSON. No prose.`;

export function buildPhaseBSystemPrompt(): string {
  return PHASE_B_SYSTEM_PROMPT;
}

export function buildPhaseBUserPrompt(groupBlocks: string): string {
  return `ARTICLES:\n${groupBlocks}\n\nWhich article numbers (if any) all cover the same specific event?`;
}
