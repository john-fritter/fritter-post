// The describe pass writes the label every downstream stage ranks and reads.
//
// It also became the only pass that can catch a whole class of over-merge. The
// split pass repairs *chaining* — union-find joining A~B~C where A and C are
// unrelated — so it suspects components that are loosely connected. Two gold
// mine collapses on different continents are *tightly* connected in embedding
// space, because they are the same kind of event in the same words: high
// cohesion, never suspected. Run #50 produced four of these, including
// "Gold mine collapses kill dozens in Central African Republic and Colombia"
// and "Florida and Alaska primary results".
//
// Describe already reads every multi-item cluster's full material with a
// question in mind, and in run #50 it wrote the defect straight into its own
// title — and nothing read it. So it is asked the question directly now, and a
// cluster it calls MULTI is re-partitioned by the split pass.
const DESCRIBE_SYSTEM_PROMPT = `You are writing brief editorial labels for news clusters, and checking that each cluster is really one story.

For each cluster you are given: decide whether its articles cover ONE event, then write a neutral, factual title and a short summary.

THE ONE-EVENT CHECK

An automated similarity pass built these clusters, and it groups by resemblance. Two separate events of the same kind — two mine collapses in different countries, two states' primary results, two unrelated strikes in the same war — read almost identically to it, so they land in one cluster. You are the only check on that.

ONE means every article covers the same event: the same incident, decision, ruling, announcement, or attack, wherever it was reported and however the accounts differ.

MULTI means the cluster holds more than one event. The clearest tell is your own title: if writing it honestly needs an "and" joining two places, two subjects, or two occurrences — "collapses in X and Y", "results in Florida and Alaska" — the cluster is MULTI. Write that title anyway; the verdict is what matters.

Same topic is not the same event. Same country is not the same event. Same day is not the same event.

When genuinely unsure, answer ONE. A wrongly split cluster loses corroboration; a wrongly merged one publishes two stories under one headline.

OUTPUT
One line per cluster and nothing else — no JSON, no markdown, no prose before or after.

Each line:
  index;;verdict;;title;;summary

Fields:
  index    — the integer from [CLUSTER N], reproduced exactly
  verdict  — exactly ONE or MULTI
  title    — short, neutral, descriptive label; no framing or adjectives not in the sources
  summary  — 2 to 4 factual sentences. What happened. No stakes, no framing.

The delimiter is ;; (two semicolons). Write exactly one line per cluster.`;

export function buildDescribeSystemPrompt(): string {
  return DESCRIBE_SYSTEM_PROMPT;
}

export function buildDescribeUserPrompt(clusterBlocks: string): string {
  return `Here are today's news clusters. For each one, decide ONE or MULTI, then write a title and summary.\n\n${clusterBlocks}`;
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
