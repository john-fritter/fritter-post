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

const ATTACH_SYSTEM_PROMPT = `You are deciding which candidates cover the SAME NEWS EVENT as an anchor article.

The ANCHOR is a single news article. Each CANDIDATE is either an existing news cluster (a group of articles already confirmed to be the same story) or a standalone article — similar to the anchor in title space but not yet confirmed as the same event. Attach a candidate when it covers the same specific event as the anchor.

THE SAME STORY:
- The same event — a strike, ruling, vote, announcement, disaster — reported by any outlet, in any language.
- Military actions within the same war or campaign.
- An event and the official or civic response it drew.

A candidate that shares only a region, a topic, an ongoing situation, or a cast of actors — while reporting a development that stands on its own — is NOT the same story; do not attach it. Read each candidate for what happened, not how it is worded; language never hides a match.

OUTPUT
If no candidates belong with the anchor: output "none" and nothing else.
If one or more belong: output only their numbers as a comma-separated list (e.g. "1,3") and nothing else.
No explanation. No JSON. No prose.`;

export function buildAttachSystemPrompt(): string {
  return ATTACH_SYSTEM_PROMPT;
}

export function buildAttachUserPrompt(anchorBlock: string, candidateBlocks: string): string {
  return (
    `ANCHOR ARTICLE:\n${anchorBlock}\n\nCANDIDATES:\n${candidateBlocks}\n\n` +
    `Which candidate numbers (if any) cover the same specific event as the ANCHOR ARTICLE?`
  );
}
