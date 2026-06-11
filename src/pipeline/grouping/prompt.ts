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
