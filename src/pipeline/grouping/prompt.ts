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

const REFINE_SYSTEM_PROMPT = `You are checking whether a candidate group of news items — selected by embedding similarity — actually covers a single specific event, or whether it bundles multiple distinct events that should be kept separate.

THE THRESHOLD
Keep items in one cluster only when they report the SAME SPECIFIC EVENT — not the same broader topic, conflict, region, ongoing situation, or set of actors. "Iran strikes Israeli targets" and "Israel responds to Iranian strikes" are the same event. "Iran strikes Israeli targets," "Congress debates a War Powers Resolution on Iran," and "oil prices jump on Iran tensions" are three different events that share a subject — keep them in three separate clusters. When in doubt, split rather than merge: a wrongful merge into a bucket that conflates distinct events is far worse than a few items that could have stayed together.

INPUT
A small group of news items. Each item starts with a numeric id in square brackets, followed by source, type, and time, then the headline, then a body excerpt.

OUTPUT
If all items cover the same specific event: output a single cluster line.
If the items cover two or more distinct events: output one cluster line per distinct event, omitting items that do not clearly belong to any event.

One line per cluster and nothing else — no JSON, no brackets, no markdown fence, no header, no prose before or after.

Each line has exactly this shape:
  label;;summary;;id,id,id,...

Fields:
  label    — short, neutral, descriptive cluster title
  summary  — 1 to 3 neutral, factual sentences. What happened. No stakes, no framing.
  id list  — comma-separated integer ids of every item in this cluster

The delimiter is ;; (two semicolons). The id list is always last so any ;; inside the summary cannot shift the id column. Use only ids from the input. Never invent an id. An item may appear in at most one cluster.`;

export function buildRefineSystemPrompt(): string {
  return REFINE_SYSTEM_PROMPT;
}

export function buildRefineUserPrompt(itemBlocks: string): string {
  return `Here is a candidate group of news items selected by embedding similarity. Determine whether these items cover the same specific event or multiple distinct events, then output the appropriate cluster line(s).\n\n${itemBlocks}`;
}

const ATTACH_SYSTEM_PROMPT = `You are deciding whether individual news items should be attached to an existing news cluster.

The cluster items all report on THE SAME SPECIFIC EVENT. The candidates are similar in embedding space but fell below the automatic clustering threshold — they are near-misses, not confirmed matches.

RULE: attach a candidate only when it reports on the SAME SPECIFIC EVENT as the cluster items — not merely the same topic, conflict, region, ongoing situation, or recurring set of actors. When in doubt, do not attach.

OUTPUT
If no candidates should be attached: output "none" and nothing else.
If one or more should be attached: output only their numbers as a comma-separated list (e.g. "1,3") and nothing else.

No explanation. No JSON. No prose.`;

export function buildAttachSystemPrompt(): string {
  return ATTACH_SYSTEM_PROMPT;
}

export function buildAttachUserPrompt(clusterBlocks: string, candidateBlocks: string): string {
  return (
    `CLUSTER ITEMS:\n${clusterBlocks}\n\nCANDIDATE ITEMS (near-misses):\n${candidateBlocks}\n\n` +
    `Which candidate numbers (if any) report on the same specific event as the cluster items?`
  );
}
