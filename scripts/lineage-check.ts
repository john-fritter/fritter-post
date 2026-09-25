/**
 * Lineage replay: re-judge published papers' "previously" candidates, write
 * nothing, and diff the links against the ones the paper printed.
 *
 * The lineage judge runs inside the publisher, and its links are live on the
 * reader's pages, so a model comparison cannot simply re-run it. This does the
 * whole pass (the same retrieval, prompt, parser and link selection) with
 * `dryRun`, then compares its links with `paper_piece_lineage`. Only the
 * generation_logs rows every call writes are written (stage 'lineage-check', so
 * the production judge's logs stay clean for `inspect publisher`).
 *
 *   npm run lineage-check -- --last 7 [--model <id>] [--provider nanogpt] \
 *     [--reasoning-effort none|low|omit] [--max-tokens <n>] [--out <path>]
 *   npm run lineage-check -- --papers 41,42,43 ...
 *
 * Run it once with no --model first: the production judge re-asked is the
 * noise control, and a verdict or two flips run to run (1 of 71 on 2026-09-05).
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { getPool } from "../src/db/index.js";
import { overridesFromFlags } from "../src/config/overrides.js";
import { loadModelConfig } from "../src/config/models.js";
import { buildPaperLineage, type JudgedPair } from "../src/pipeline/lineage/index.js";

const REPORT_BODY_CHARS = 300;

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--") && i + 1 < args.length) flags[args[i]!.slice(2)] = args[++i]!;
  }
  return flags;
}

function clip(text: string | null | undefined): string {
  if (!text) return "_(none)_";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > REPORT_BODY_CHARS ? `${flat.slice(0, REPORT_BODY_CHARS)}…` : flat;
}

function tsv(values: Array<string | number | boolean | null>): string {
  return values.map((v) => String(v ?? "").replace(/[\t\n]/g, " ")).join("\t");
}

async function main() {
  // A bare --help used to fall through to a full default replay.
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: npm run lineage-check -- (--last <n> | --papers <a,b,…>) [--out <file.md>]\n" +
        "         [--model <id>] [--provider nanogpt] [--reasoning-effort <level|omit>]\n" +
        "         [--max-tokens <n>] [--timeout-ms <n>]",
    );
    process.exit(0);
  }
  const flags = parseArgs(process.argv);
  const overrides = overridesFromFlags(flags);
  const pool = getPool();

  let papers: Array<{ id: number; published_on: string }>;
  if (flags["papers"]) {
    const ids = flags["papers"].split(",").map((s) => parseInt(s.trim(), 10));
    papers = (
      await pool.query<{ id: number; published_on: string }>(
        `SELECT id, to_char(published_on, 'YYYY-MM-DD') AS published_on
         FROM papers WHERE id = ANY($1) ORDER BY published_on`,
        [ids],
      )
    ).rows;
  } else {
    const last = parseInt(flags["last"] ?? "7", 10);
    papers = (
      await pool.query<{ id: number; published_on: string }>(
        `SELECT id, published_on FROM (
           SELECT id, to_char(published_on, 'YYYY-MM-DD') AS published_on
           FROM papers ORDER BY published_on DESC LIMIT $1
         ) t ORDER BY published_on`,
        [last],
      )
    ).rows;
  }
  if (papers.length === 0) throw new Error("No papers selected");

  const judgeModel = overrides?.model ?? loadModelConfig().publisher.lineage.adjudicate.model;
  console.log(
    `[lineage-check] ${papers.length} paper(s), judge ${judgeModel}` +
      (overrides?.reasoningEffort !== undefined ? `, reasoning ${overrides.reasoningEffort ?? "omitted"}` : ""),
  );

  const summary: string[] = [];
  const detail: string[] = [];
  const rows: string[] = [
    tsv(["paper_id", "published_on", "ref", "prior_published_on", "prior_ref", "similarity",
      "verdict", "linked_replay", "linked_prod", "reason", "headline", "prior_headline"]),
  ];
  let totals = { pairs: 0, yes: 0, failed: 0, replayLinks: 0, prodLinks: 0, both: 0 };

  for (const paper of papers) {
    const result = await buildPaperLineage(paper.id, paper.published_on, {
      dryRun: true,
      ...(overrides ? { overrides } : {}),
    });

    const { rows: prod } = await pool.query<{ piece: string; prior: string | null; reason: string | null }>(
      `SELECT paper_piece_id::text AS piece, prior_paper_piece_id::text AS prior, judge_reason AS reason
       FROM paper_piece_lineage WHERE paper_id = $1`,
      [paper.id],
    );
    const prodKey = new Map(prod.map((p) => [`${p.piece}>${p.prior}`, p.reason]));
    const replayKey = new Set(result.links.map((l) => `${l.paperPieceId}>${l.priorPaperPieceId}`));

    const both = [...replayKey].filter((k) => prodKey.has(k)).length;
    const yes = result.judged.filter((j) => j.verdict === true).length;
    totals = {
      pairs: totals.pairs + result.judged.length,
      yes: totals.yes + yes,
      failed: totals.failed + (result.judgeFailed ? 1 : 0),
      replayLinks: totals.replayLinks + replayKey.size,
      prodLinks: totals.prodLinks + prodKey.size,
      both: totals.both + both,
    };
    summary.push(
      `| ${paper.id} | ${paper.published_on} | ${result.judged.length} | ${yes} | ` +
        `${replayKey.size} | ${prodKey.size} | ${both} | ${replayKey.size - both} | ` +
        `${prodKey.size - both} | ${result.judgeFailed ? "FAILED" : ""} |`,
    );

    const byKey = new Map<string, JudgedPair>(
      result.judged.map((j) => [`${j.candidate.paperPieceId}>${j.candidate.priorPaperPieceId}`, j]),
    );
    for (const j of result.judged) {
      const k = `${j.candidate.paperPieceId}>${j.candidate.priorPaperPieceId}`;
      rows.push(tsv([
        paper.id, paper.published_on, j.candidate.ref, j.candidate.priorPublishedOn, j.candidate.priorRef,
        j.candidate.similarity.toFixed(4), j.verdict === null ? "FAILED" : j.verdict ? "YES" : "NO",
        replayKey.has(k), prodKey.has(k), j.reason, j.candidate.headline, j.candidate.priorHeadline,
      ]));
    }

    // Disagreements are what a reader has to look at: a link one judge printed
    // and the other did not.
    const disagreements = [
      ...[...replayKey].filter((k) => !prodKey.has(k)).map((k) => ({ k, side: "replay only" })),
      ...[...prodKey.keys()].filter((k) => !replayKey.has(k)).map((k) => ({ k, side: "production only" })),
    ];
    for (const { k, side } of disagreements) {
      const j = byKey.get(k);
      detail.push(`### paper ${paper.id} (${paper.published_on}) — ${side}`);
      detail.push("");
      if (!j) {
        detail.push(`Pair ${k} was not a candidate in the replay (retrieval changed, or below the floor).`);
        detail.push(`Production reason: ${prodKey.get(k) ?? "_(none)_"}`);
        detail.push("");
        continue;
      }
      const c = j.candidate;
      detail.push(`**today (${c.ref}):** ${c.headline ?? "_(section line)_"}`);
      detail.push("");
      detail.push(`> ${clip(c.body)}`);
      detail.push("");
      detail.push(`**prior (${c.priorRef}, ${c.priorPublishedOn}):** ${c.priorHeadline ?? "_(section line)_"}`);
      detail.push("");
      detail.push(`> ${clip(c.priorBody)}`);
      detail.push("");
      detail.push(`similarity ${c.similarity.toFixed(4)} · replay verdict ${j.verdict === null ? "FAILED" : j.verdict ? "YES" : "NO"}`);
      detail.push(`- replay reason: ${j.reason ?? "_(none)_"}`);
      detail.push(`- production reason: ${prodKey.get(k) ?? "_(not linked)_"}`);
      detail.push("");
    }
  }

  const out = flags["out"] ?? `lineage-check-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}`;
  const report = [
    `# Lineage replay — judge ${judgeModel}`,
    "",
    `Replayed with dryRun: nothing written but generation_logs (stage 'lineage-check').`,
    "",
    "| paper | date | pairs judged | YES | replay links | printed links | both | replay only | printed only | |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...summary,
    "",
    `Totals: ${totals.pairs} pairs, ${totals.yes} YES, ${totals.replayLinks} replay links vs ` +
      `${totals.prodLinks} printed, ${totals.both} in both, ${totals.failed} failed judge call(s).`,
    "",
    "## Disagreements",
    "",
    ...(detail.length > 0 ? detail : ["None."]),
  ].join("\n");
  writeFileSync(`${out}.md`, report);
  writeFileSync(`${out}.tsv`, rows.join("\n") + "\n");
  console.log(
    `[lineage-check] ${totals.pairs} pairs, ${totals.replayLinks} replay links vs ${totals.prodLinks} printed, ` +
      `${totals.both} in both. Wrote ${out}.md and ${out}.tsv`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
