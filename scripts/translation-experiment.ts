/**
 * Translation model comparison — same items, same prompt, different models.
 *
 * Translation feeds every judgment stage (prefilter, scoring, thread, the
 * tie-break) and the writers' feed text through `english_*`, so a model swap
 * here is a change to what the whole pipeline reads. This script re-translates
 * a fixed sample of one preprocessor run's non-English items with each
 * candidate model through the production path (`batchTranslateItems`: same
 * prompt, parser, split-on-failure and backoff), and writes a side-by-side
 * report next to the translation production stored for that run.
 *
 * Writes nothing but a report file and the generation_logs rows every call
 * writes (stage 'translation-experiment'). preprocessed_items is not touched.
 *
 * Usage:
 *   tsx scripts/translation-experiment.ts \
 *     --model nanogpt:Qwen/Qwen3.6-35B-A3B \
 *     --model nanogpt:<candidate> \
 *     [--preprocessor-run-id <n>] [--limit 40] [--out <path>]
 *
 * Put the production model first: re-running it is the noise control, since
 * two runs of one model at temperature 0.1 already differ.
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { getPool } from "../src/db/index.js";
import { loadModelConfig } from "../src/config/models.js";
import type { LLMProvider } from "../src/llm/index.js";
import {
  batchTranslateItems,
  defaultCallBatchLLM,
  detectLanguageCode,
  isEnglish,
  type BatchLLMCallFn,
} from "../src/pipeline/preprocessor/translation.js";

const DEFAULT_LIMIT = 40;
const REPORT_BODY_CHARS = 400;
const PROVIDERS: LLMProvider[] = ["ollama-cloud", "nanogpt", "openrouter"];

interface ModelSpec {
  provider: LLMProvider;
  model: string;
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const models: ModelSpec[] = [];
  let runId: number | undefined;
  let limit = DEFAULT_LIMIT;
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--model" && i + 1 < args.length) {
      const raw = args[++i]!;
      const sep = raw.indexOf(":");
      const provider = raw.slice(0, sep) as LLMProvider;
      if (sep < 0 || !PROVIDERS.includes(provider)) {
        throw new Error(`--model must be <provider>:<model-id>, got "${raw}"`);
      }
      models.push({ provider, model: raw.slice(sep + 1) });
    } else if (arg === "--preprocessor-run-id" && i + 1 < args.length) {
      runId = parseInt(args[++i]!, 10);
    } else if (arg === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[++i]!, 10);
    } else if (arg === "--out" && i + 1 < args.length) {
      out = args[++i];
    }
  }
  return { models, runId, limit, out };
}

interface SampleItem {
  id: string;
  lang: string;
  title: string;
  bodyText: string | null;
  prodTitle: string | null;
  prodBody: string | null;
  prodFailed: boolean | null;
}

async function loadSample(runId: number | undefined, limit: number) {
  const pool = getPool();
  const resolved =
    runId ??
    Number(
      (
        await pool.query<{ id: number }>(
          `SELECT id FROM preprocessor_runs WHERE completed_at IS NOT NULL
           ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0]?.id,
    );
  if (!Number.isFinite(resolved)) throw new Error("No completed preprocessor run found");

  const { rows } = await pool.query<{
    id: string;
    title: string;
    body_text: string | null;
    english_title: string | null;
    english_body: string | null;
    translation_failed: boolean | null;
  }>(
    `SELECT id, title, body_text, english_title, english_body, translation_failed
     FROM preprocessed_items WHERE preprocessor_run_id = $1 ORDER BY id`,
    [resolved],
  );

  // The preprocessor's own detector, so the sample is what production translates.
  const sample: SampleItem[] = [];
  for (const r of rows) {
    const lang = detectLanguageCode(r.title, r.body_text);
    if (isEnglish(lang, r.title, r.body_text)) continue;
    sample.push({
      id: String(r.id),
      lang,
      title: r.title,
      bodyText: r.body_text,
      prodTitle: r.english_title,
      prodBody: r.english_body,
      prodFailed: r.translation_failed,
    });
  }
  // Spread the sample across the run rather than taking the first feeds' items,
  // which would be one or two outlets in one language. Deterministic.
  const step = Math.max(1, Math.floor(sample.length / limit));
  const picked = sample.filter((_, i) => i % step === 0).slice(0, limit);
  return { runId: resolved, eligible: sample.length, items: picked };
}

function clip(text: string | null | undefined): string {
  if (!text) return "_(none)_";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > REPORT_BODY_CHARS ? `${flat.slice(0, REPORT_BODY_CHARS)}…` : flat;
}

async function main() {
  const { models, runId, limit, out } = parseArgs(process.argv);
  if (models.length === 0) {
    console.error(
      "Usage: tsx scripts/translation-experiment.ts --model <provider>:<id> [--model …] " +
        "[--preprocessor-run-id <n>] [--limit <n>] [--out <path>]",
    );
    process.exit(1);
  }

  const prodConfig = loadModelConfig().preprocessor.translation;
  const sample = await loadSample(runId, limit);
  console.log(
    `[translation-experiment] preprocessor run #${sample.runId}: ${sample.eligible} non-English ` +
      `items, sampling ${sample.items.length}. Production model: ${prodConfig.model}`,
  );

  const callAsExperiment: BatchLLMCallFn = (items, config, _stage, id) =>
    defaultCallBatchLLM(items, config, "translation-experiment", id);

  const results: Array<{
    spec: ModelSpec;
    seconds: number;
    stats: Awaited<ReturnType<typeof batchTranslateItems>>["stats"];
    fields: Awaited<ReturnType<typeof batchTranslateItems>>["fields"];
  }> = [];

  for (const spec of models) {
    const config = { ...prodConfig, model: spec.model, provider: spec.provider };
    const t0 = Date.now();
    const { fields, stats } = await batchTranslateItems(
      sample.items.map((i) => ({ id: i.id, title: i.title, bodyText: i.bodyText })),
      config,
      sample.runId,
      callAsExperiment,
    );
    const seconds = (Date.now() - t0) / 1000;
    console.log(
      `  ${spec.provider}:${spec.model} — ${stats.translated} translated, ` +
        `${stats.fallbacks} fallback(s), ${stats.splitRetries} split-retries ` +
        `(${stats.callSplits} from call failures), ${seconds.toFixed(1)}s` +
        (stats.breakerTripped ? `, BREAKER: ${stats.breakerTripped}` : ""),
    );
    results.push({ spec, seconds, stats, fields });
  }

  const lines: string[] = [];
  lines.push(`# Translation experiment — preprocessor run #${sample.runId}`);
  lines.push("");
  lines.push(
    `${sample.items.length} of ${sample.eligible} non-English items, spread across the run. ` +
      `"production" is what run #${sample.runId} stored (model at the time: ` +
      `see generation_logs). Config other than model/provider is production's ` +
      `(\`preprocessor.translation\`).`,
  );
  lines.push("");
  lines.push("| model | translated | fallbacks | split-retries | call splits | seconds |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(
      `| ${r.spec.provider}:${r.spec.model} | ${r.stats.translated} | ${r.stats.fallbacks} | ` +
        `${r.stats.splitRetries} | ${r.stats.callSplits} | ${r.seconds.toFixed(1)} |`,
    );
  }
  lines.push("");

  const langs = new Map<string, number>();
  for (const i of sample.items) langs.set(i.lang, (langs.get(i.lang) ?? 0) + 1);
  lines.push(
    `Languages: ${[...langs.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`).join(", ")}`,
  );
  lines.push("");

  for (const item of sample.items) {
    lines.push(`## item ${item.id} (${item.lang})`);
    lines.push("");
    lines.push(`**original:** ${item.title}`);
    lines.push("");
    lines.push(`> ${clip(item.bodyText)}`);
    lines.push("");
    lines.push(
      `**production${item.prodFailed ? " (FAILED — original text)" : ""}:** ${item.prodTitle ?? "_(none)_"}`,
    );
    lines.push("");
    lines.push(`> ${clip(item.prodBody)}`);
    lines.push("");
    for (const r of results) {
      const f = r.fields.get(item.id);
      const tag = f?.failed ? " (FAILED — original text)" : "";
      lines.push(`**${r.spec.model}${tag}:** ${f?.english_title ?? "_(missing)_"}`);
      lines.push("");
      lines.push(`> ${clip(f?.english_body)}`);
      lines.push("");
    }
  }

  const path =
    out ?? `translation-experiment-run${sample.runId}-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.md`;
  writeFileSync(path, lines.join("\n"));
  console.log(`[translation-experiment] report: ${path}`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
