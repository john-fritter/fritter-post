/**
 * Cross-language embedding experiment — does translation earn its keep?
 *
 * The preprocessor translates every non-English item to English so that all
 * clustering happens in one vector space (decision 2026-06-17). That stage costs
 * ~90 LLM calls and ~13 minutes per run, and run #44 lost 23 of 601 non-English
 * items to call failures. The premise behind it was that `qwen3-embedding-8b`
 * keeps per-language sub-spaces that don't collapse: same-event pairs in
 * different languages measured 0.4–0.5 cosine against a 0.66 threshold.
 *
 * That premise is testable. This script measures, on real data and without
 * translating anything, whether a candidate embedding model puts same-event
 * cross-language pairs above the threshold on their ORIGINAL text. If one does,
 * the translation stage can be deleted rather than hardened.
 *
 * Ground truth comes from clusters the pipeline already produced: a cluster with
 * both English and non-English members is a set of same-event articles that the
 * attach and describe passes validated. Those members are the positive pairs.
 * Members of *different* clusters are the negative control — the numbers only
 * mean something if same-event pairs score high AND different-event pairs
 * score low.
 *
 * Read-only apart from the generation_logs rows that embed() writes, per the
 * project's every-call-is-logged rule.
 *
 * Usage:
 *   tsx scripts/embedding-experiment.ts --list nanogpt
 *   tsx scripts/embedding-experiment.ts \
 *     --model openrouter:qwen/qwen3-embedding-8b \
 *     --model nanogpt:BAAI/bge-m3 \
 *     --body-cap 2000 --body-cap 600 \
 *     --max-pairs 60
 *
 * --model may be repeated; each is <provider>:<model-id>. Providers are the same
 * three the pipeline uses: nanogpt, openrouter, ollama-cloud.
 */

import "dotenv/config";
import { getPool } from "../src/db/index.js";
import { embed } from "../src/llm/index.js";
import type { LLMProvider } from "../src/llm/index.js";
import { parseGroupingDigest } from "../src/pipeline/editor-pass-1/index.js";
import {
  detectLanguageCode,
  isEnglish,
} from "../src/pipeline/preprocessor/translation.js";

const DEFAULT_BODY_CAP = 2000;
const DEFAULT_MAX_PAIRS = 60;
const EMBED_BATCH = 50;
const PRODUCTION_THRESHOLD = 0.66;
const ATTACH_FLOOR = 0.55;

interface ModelSpec {
  provider: LLMProvider;
  model: string;
}

interface ItemRow {
  id: number;
  title: string;
  bodyText: string | null;
  englishTitle: string | null;
  englishBody: string | null;
  isEnglish: boolean;
}

interface Pair {
  a: number;
  b: number;
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const models: ModelSpec[] = [];
  const bodyCaps: number[] = [];
  let groupingRunId: number | undefined;
  let maxPairs = DEFAULT_MAX_PAIRS;
  let listProvider: string | undefined;
  let probeProvider: string | undefined;
  const extraCandidates: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--probe" && i + 1 < args.length) {
      probeProvider = args[++i];
    } else if (arg === "--candidate" && i + 1 < args.length) {
      extraCandidates.push(args[++i]!);
    } else if (arg === "--model" && i + 1 < args.length) {
      const raw = args[++i]!;
      const idx = raw.indexOf(":");
      if (idx === -1) {
        throw new Error(`--model must be <provider>:<model-id>, got "${raw}"`);
      }
      models.push({
        provider: raw.slice(0, idx) as LLMProvider,
        model: raw.slice(idx + 1),
      });
    } else if (arg === "--body-cap" && i + 1 < args.length) {
      bodyCaps.push(parseInt(args[++i]!, 10));
    } else if (arg === "--grouping-run-id" && i + 1 < args.length) {
      groupingRunId = parseInt(args[++i]!, 10);
    } else if (arg === "--max-pairs" && i + 1 < args.length) {
      maxPairs = parseInt(args[++i]!, 10);
    } else if (arg === "--list" && i + 1 < args.length) {
      listProvider = args[++i];
    }
  }

  return {
    models,
    bodyCaps: bodyCaps.length > 0 ? bodyCaps : [DEFAULT_BODY_CAP],
    groupingRunId,
    maxPairs,
    listProvider,
    probeProvider,
    extraCandidates,
  };
}

function providerEnv(provider: string): { baseUrl: string; apiKey: string } {
  const table: Record<string, [string, string]> = {
    nanogpt: ["NANOGPT_BASE_URL", "NANOGPT_API_KEY"],
    openrouter: ["OPENROUTER_BASE_URL", "OPENROUTER_API_KEY"],
    "ollama-cloud": ["LLM_BASE_URL", "LLM_API_KEY"],
  };
  const entry = table[provider];
  if (!entry) throw new Error(`Unknown provider "${provider}"`);
  const baseUrl = process.env[entry[0]];
  const apiKey = process.env[entry[1]];
  if (!baseUrl) throw new Error(`${entry[0]} is not set`);
  if (!apiKey) throw new Error(`${entry[1]} is not set`);
  return { baseUrl, apiKey };
}

/**
 * Candidates for the probe, in rough order of interest for cross-lingual
 * alignment. The first entry is the incumbent and serves as the positive
 * control: if it fails, the probe itself is broken, not the catalog.
 *
 * Several spellings per family are included on purpose — gateways differ on
 * casing and namespace (`baai/bge-m3` vs `BAAI/bge-m3`), and a probe is cheap.
 */
const PROBE_CANDIDATES: string[] = [
  // Incumbent / positive control.
  "qwen/qwen3-embedding-8b",
  "Qwen/Qwen3-Embedding-8B",
  "qwen/qwen3-embedding-4b",
  "qwen/qwen3-embedding-0.6b",
  // BGE-M3 — built for multilingual + cross-lingual retrieval.
  "baai/bge-m3",
  "BAAI/bge-m3",
  "bge-m3",
  // multilingual-e5 — strong cross-lingual alignment.
  "intfloat/multilingual-e5-large",
  "intfloat/multilingual-e5-large-instruct",
  "multilingual-e5-large",
  // LaBSE — purpose-built for cross-lingual sentence alignment.
  "sentence-transformers/LaBSE",
  "LaBSE",
  // Others plausibly carried by an OpenAI-compatible gateway.
  "jinaai/jina-embeddings-v3",
  "jina-embeddings-v3",
  "Alibaba-NLP/gte-multilingual-base",
  "gte-multilingual-base",
  "openai/text-embedding-3-large",
  "text-embedding-3-large",
  "openai/text-embedding-3-small",
  "cohere/embed-multilingual-v3.0",
  "embed-multilingual-v3.0",
  "mistralai/mistral-embed",
  "mistral-embed",
  "nomic-ai/nomic-embed-text-v2-moe",
  "voyage/voyage-multilingual-2",
];

/**
 * Probes candidate model ids with a one-text embedding call and reports which
 * ones the provider actually serves, with the dimension each returns.
 *
 * This exists because `/v1/models` on these gateways does NOT enumerate
 * embedding models: both nanogpt and openrouter returned 295 and 367 chat
 * models respectively and zero embedding models, including omitting
 * `qwen/qwen3-embedding-8b` — which production embeds through successfully.
 * Cataloguing therefore cannot answer "is this model available"; asking can.
 *
 * This is not guessing at ids and hoping. A probe converts a guess into a
 * provider-sourced yes/no before anything depends on it, which is what the
 * "ids must come from the provider" rule is protecting against.
 */
async function probeModels(provider: LLMProvider, extra: string[]): Promise<void> {
  const candidates = [...PROBE_CANDIDATES, ...extra];
  console.log(
    `Probing ${candidates.length} candidate id(s) on ${provider} with a ` +
      `single-text embedding call each.\n`,
  );

  const available: Array<{ id: string; dims: number }> = [];

  for (const model of candidates) {
    try {
      const vectors = await embed(["probe"], {
        stage: "embedding-experiment",
        model,
        provider,
        timeoutMs: 60_000,
      });
      const dims = vectors[0]?.length ?? 0;
      available.push({ id: model, dims });
      console.log(`  OK    ${model.padEnd(44)} dims=${dims}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // One line, trimmed — a 404 body can be very long.
      console.log(`  fail  ${model.padEnd(44)} ${msg.slice(0, 90)}`);
    }
  }

  console.log(`\n${available.length} of ${candidates.length} available on ${provider}:`);
  for (const a of available) {
    console.log(`  --model ${provider}:${a.id}    (dims=${a.dims})`);
  }
  if (available.length === 0) {
    console.log(
      "  none — if even the incumbent qwen/qwen3-embedding-8b failed, the probe\n" +
        "  or the credentials are at fault rather than the catalog.",
    );
  }
}

/**
 * Lists a provider's models. NOTE: on both nanogpt and openrouter this returns
 * chat/completion models only and omits embedding models entirely — use
 * --probe to determine embedding availability.
 */
async function listModels(provider: string): Promise<void> {
  const { baseUrl, apiKey } = providerEnv(provider);
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`GET /models returned ${res.status} for ${provider}`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string")
    .sort();

  const looksLikeEmbedding = (id: string) =>
    /embed|bge|gte|e5|labse|nomic|jina|minilm|mxbai/i.test(id);

  const embeddings = ids.filter(looksLikeEmbedding);
  console.log(`${provider}: ${ids.length} model(s) total\n`);
  console.log(`Likely embedding models (${embeddings.length}):`);
  for (const id of embeddings) console.log(`  ${id}`);
  if (embeddings.length === 0) {
    console.log("  (none matched the embedding name heuristic)");
    console.log("\nAll model ids:");
    for (const id of ids) console.log(`  ${id}`);
  }
}

async function loadClusterMembers(
  groupingRunId: number | undefined,
): Promise<{ runId: number; clusters: number[][] }> {
  const pool = getPool();

  let runId = groupingRunId;
  if (runId === undefined) {
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM grouping_runs WHERE completed_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    );
    if (rows.length === 0) throw new Error("No completed grouping runs found");
    runId = rows[0]!.id;
  }

  const { rows } = await pool.query<{ digest: string | null }>(
    "SELECT digest FROM grouping_runs WHERE id = $1",
    [runId],
  );
  const digest = rows[0]?.digest;
  if (!digest) throw new Error(`Grouping run #${runId} has no digest`);

  const clusters = parseGroupingDigest(digest)
    .map((c) => c.memberIds)
    .filter((ids) => ids.length >= 2);

  return { runId, clusters };
}

async function loadItems(ids: number[]): Promise<Map<number, ItemRow>> {
  const pool = getPool();
  const { rows } = await pool.query<{
    id: string;
    title: string;
    body_text: string | null;
    english_title: string | null;
    english_body: string | null;
  }>(
    `SELECT id, title, body_text, english_title, english_body
     FROM preprocessed_items WHERE id = ANY($1)`,
    [ids],
  );

  const items = new Map<number, ItemRow>();
  for (const r of rows) {
    // Classify with the preprocessor's own detector so the split here matches
    // the split that decides what gets translated in production.
    const lang = detectLanguageCode(r.title, r.body_text);
    items.set(Number(r.id), {
      id: Number(r.id),
      title: r.title,
      bodyText: r.body_text,
      englishTitle: r.english_title,
      englishBody: r.english_body,
      isEnglish: isEnglish(lang, r.title, r.body_text),
    });
  }
  return items;
}

/** Deterministic sample so repeated runs compare like with like. */
function take<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}

function buildPairs(
  clusters: number[][],
  items: Map<number, ItemRow>,
  maxPairs: number,
): { xlangSame: Pair[]; sameLangSame: Pair[]; xlangDiff: Pair[] } {
  const xlangSame: Pair[] = [];
  const sameLangSame: Pair[] = [];

  // Positives: within a cluster, pair each non-English member with the
  // English member it is supposed to cluster with.
  const clusterEnglish: number[][] = [];
  const clusterNonEnglish: number[][] = [];

  for (const memberIds of clusters) {
    const present = memberIds.filter((id) => items.has(id));
    const en = present.filter((id) => items.get(id)!.isEnglish);
    const non = present.filter((id) => !items.get(id)!.isEnglish);
    clusterEnglish.push(en);
    clusterNonEnglish.push(non);

    for (const a of en) {
      for (const b of non) xlangSame.push({ a, b });
    }
    // Calibration: same-language same-event pairs, which the current threshold
    // was tuned on. Cap at one per cluster to keep the set balanced.
    if (en.length >= 2) sameLangSame.push({ a: en[0]!, b: en[1]! });
  }

  // Negative control: English from one cluster against non-English from a
  // different cluster. Without this the positive numbers mean nothing — a model
  // that scores everything 0.9 would look perfect.
  const xlangDiff: Pair[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const en = clusterEnglish[i] ?? [];
    if (en.length === 0) continue;
    for (let j = 0; j < clusters.length; j++) {
      if (i === j) continue;
      const non = clusterNonEnglish[j] ?? [];
      if (non.length === 0) continue;
      xlangDiff.push({ a: en[0]!, b: non[0]! });
      break;
    }
  }

  return {
    xlangSame: take(xlangSame, maxPairs),
    sameLangSame: take(sameLangSame, maxPairs),
    xlangDiff: take(xlangDiff, maxPairs * 2),
  };
}

function originalText(item: ItemRow, bodyCap: number): string {
  const body = (item.bodyText ?? "").slice(0, bodyCap);
  return body ? `${item.title}\n\n${body}` : item.title;
}

function translatedText(item: ItemRow, bodyCap: number): string {
  const title = item.englishTitle ?? item.title;
  const body = (item.englishBody ?? item.bodyText ?? "").slice(0, bodyCap);
  return body ? `${title}\n\n${body}` : title;
}

function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm > 0 ? v.map((x) => x / norm) : v;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

async function embedAll(
  ids: number[],
  textOf: (id: number) => string,
  spec: ModelSpec,
): Promise<Map<number, number[]>> {
  const vectors = new Map<number, number[]>();
  for (let i = 0; i < ids.length; i += EMBED_BATCH) {
    const chunk = ids.slice(i, i + EMBED_BATCH);
    const raw = await embed(
      chunk.map(textOf),
      {
        stage: "embedding-experiment",
        model: spec.model,
        provider: spec.provider,
        timeoutMs: 180_000,
      },
    );
    if (raw.length !== chunk.length) {
      throw new Error(
        `${spec.model}: asked for ${chunk.length} vectors, got ${raw.length}`,
      );
    }
    chunk.forEach((id, j) => vectors.set(id, l2Normalize(raw[j]!)));
    process.stdout.write(
      `\r    embedded ${Math.min(i + EMBED_BATCH, ids.length)}/${ids.length}`,
    );
  }
  process.stdout.write("\n");
  return vectors;
}

interface Stats {
  n: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  aboveThreshold: number;
}

function stats(values: number[]): Stats {
  if (values.length === 0) {
    return { n: 0, mean: NaN, median: NaN, p10: NaN, p90: NaN, aboveThreshold: NaN };
  }
  const sorted = [...values].sort((x, y) => x - y);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]!;
  return {
    n: values.length,
    mean: values.reduce((s, x) => s + x, 0) / values.length,
    median: at(0.5),
    p10: at(0.1),
    p90: at(0.9),
    aboveThreshold:
      values.filter((v) => v >= PRODUCTION_THRESHOLD).length / values.length,
  };
}

function scorePairs(pairs: Pair[], vectors: Map<number, number[]>): number[] {
  const out: number[] = [];
  for (const p of pairs) {
    const va = vectors.get(p.a);
    const vb = vectors.get(p.b);
    if (va && vb) out.push(cosine(va, vb));
  }
  return out;
}

function fmt(x: number): string {
  return Number.isNaN(x) ? "  n/a" : x.toFixed(3);
}

function reportRow(label: string, s: Stats): void {
  console.log(
    `    ${label.padEnd(28)} n=${String(s.n).padStart(3)}  ` +
      `mean=${fmt(s.mean)}  median=${fmt(s.median)}  ` +
      `p10=${fmt(s.p10)}  p90=${fmt(s.p90)}  ` +
      `>=${PRODUCTION_THRESHOLD}: ${Number.isNaN(s.aboveThreshold) ? "n/a" : (s.aboveThreshold * 100).toFixed(0) + "%"}`,
  );
}

async function main() {
  const {
    models,
    bodyCaps,
    groupingRunId,
    maxPairs,
    listProvider,
    probeProvider,
    extraCandidates,
  } = parseArgs(process.argv);

  if (probeProvider) {
    await probeModels(probeProvider as LLMProvider, extraCandidates);
    process.exit(0);
  }

  if (listProvider) {
    await listModels(listProvider);
    process.exit(0);
  }

  if (models.length === 0) {
    console.error(
      "No --model given. Example:\n" +
        "  tsx scripts/embedding-experiment.ts --model openrouter:qwen/qwen3-embedding-8b\n\n" +
        "Discover which embedding models a provider actually serves with:\n" +
        "  --probe openrouter   (or --probe nanogpt)\n" +
        "`--list` shows the /v1/models catalog, but on these gateways that\n" +
        "enumerates chat models only and omits embedding models entirely.",
    );
    process.exit(1);
  }

  const { runId, clusters } = await loadClusterMembers(groupingRunId);
  const allIds = [...new Set(clusters.flat())];
  const items = await loadItems(allIds);
  const pairs = buildPairs(clusters, items, maxPairs);

  const involved = [
    ...new Set(
      [...pairs.xlangSame, ...pairs.sameLangSame, ...pairs.xlangDiff].flatMap(
        (p) => [p.a, p.b],
      ),
    ),
  ];

  const nonEnglishCount = [...items.values()].filter((i) => !i.isEnglish).length;

  console.log("Cross-language embedding experiment");
  console.log(`  grouping run:        #${runId}`);
  console.log(`  clusters (size>=2):  ${clusters.length}`);
  console.log(`  items in clusters:   ${items.size} (${nonEnglishCount} non-English)`);
  console.log(`  pairs — same-event cross-language:  ${pairs.xlangSame.length}`);
  console.log(`  pairs — same-event same-language:   ${pairs.sameLangSame.length}`);
  console.log(`  pairs — diff-event cross-language:  ${pairs.xlangDiff.length}`);
  console.log(`  unique items to embed: ${involved.length}`);
  console.log(
    `  projected embed calls: ${Math.ceil(involved.length / EMBED_BATCH) * models.length * bodyCaps.length} ` +
      `(${models.length} model(s) x ${bodyCaps.length} cap(s))`,
  );

  if (pairs.xlangSame.length === 0) {
    console.error(
      "\nNo same-event cross-language pairs in this run — nothing to measure. " +
        "Pick a run whose clusters mix languages (--grouping-run-id).",
    );
    process.exit(1);
  }

  console.log(
    `\nProduction threshold ${PRODUCTION_THRESHOLD}; attach candidate floor ${ATTACH_FLOOR}.`,
  );

  for (const spec of models) {
    for (const cap of bodyCaps) {
      console.log(
        `\n=== ${spec.provider}:${spec.model} — body cap ${cap} ===`,
      );

      console.log("  ORIGINAL text (no translation):");
      const origVectors = await embedAll(
        involved,
        (id) => originalText(items.get(id)!, cap),
        spec,
      );
      const origSame = stats(scorePairs(pairs.xlangSame, origVectors));
      const origDiff = stats(scorePairs(pairs.xlangDiff, origVectors));
      const origCalib = stats(scorePairs(pairs.sameLangSame, origVectors));
      reportRow("same-event cross-language", origSame);
      reportRow("diff-event cross-language", origDiff);
      reportRow("same-event same-language", origCalib);

      const separation = origSame.p10 - origDiff.p90;
      console.log(
        `    separation (p10 same - p90 diff): ${fmt(separation)}` +
          (separation > 0
            ? "  → a clean threshold exists"
            : "  → the classes overlap; no single threshold separates them"),
      );

      console.log("  TRANSLATED text (what production does today):");
      const transVectors = await embedAll(
        involved,
        (id) => translatedText(items.get(id)!, cap),
        spec,
      );
      const transSame = stats(scorePairs(pairs.xlangSame, transVectors));
      const transDiff = stats(scorePairs(pairs.xlangDiff, transVectors));
      reportRow("same-event cross-language", transSame);
      reportRow("diff-event cross-language", transDiff);
      console.log(
        `    separation (p10 same - p90 diff): ${fmt(transSame.p10 - transDiff.p90)}`,
      );

      console.log(
        `  VERDICT for ${spec.model} @ cap ${cap}: original-text same-event median ` +
          `${fmt(origSame.median)} vs translated ${fmt(transSame.median)} — ` +
          (origSame.median >= transSame.median - 0.02
            ? "translation adds little; candidate for removal"
            : "translation is doing real work with this model"),
      );
    }
  }

  console.log(
    "\nHow to read this: translation can be dropped only if a model's ORIGINAL-text\n" +
      "same-event cross-language p10 sits above the threshold you intend to run, AND\n" +
      "its diff-event p90 sits below it. A high same-event mean with an equally high\n" +
      "diff-event mean means the model calls everything similar and is useless here.",
  );

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
