/**
 * Novelty preview: grade past papers' candidates with the current rerun check,
 * then rebuild each day's ranking under those grades and show it beside the
 * same day without them.
 *
 * For each paper it runs the rerun check on that day's grouping-pass-1 run, as
 * of the paper's date, so it judges against the editions that existed that
 * morning. That writes rerun_runs / rerun_assessments / generation_logs rows,
 * which nothing in production reads (the pile records the run it used). Then
 * src/pipeline/novelty/preview.ts re-ranks the day twice from the stored pass-1
 * scores and threads:
 *
 *   before  the old check's withholds, no reductions -- the day as it ran,
 *           less the LLM tie-break
 *   after   the new grades: reruns withheld, minor and routine reduced
 *
 *   npm run novelty-preview -- --papers 43-52 --out preview.md
 *   npm run novelty-preview -- --papers 43,44 --rerun-runs 43:120,44:121 --out p.md
 *
 * `--rerun-runs paper:run,…` re-renders from rerun runs already made instead of
 * grading again (the grades are the expensive, non-deterministic part).
 * Writes `<out>` and `<out>.tsv` (one row per graded candidate).
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { getPool } from "../src/db/index.js";
import { loadModelConfig } from "../src/config/models.js";
import { englishTitle } from "../src/lib/text.js";
import { parseGroupingDigest } from "../src/pipeline/score/index.js";
import { runNovelty } from "../src/pipeline/novelty/index.js";
import type { NoveltyGrade } from "../src/pipeline/novelty/prompt.js";
import { effectOf, type NoveltyEffect, type PieceTier } from "../src/pipeline/novelty/select.js";
import {
  previewRanking,
  type PreviewRow,
  type PreviewStory,
  type PreviewThread,
} from "../src/pipeline/novelty/preview.js";

const TOP = 30;

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--") && i + 1 < args.length) flags[args[i]!.slice(2)] = args[++i]!;
  }
  return flags;
}

function parsePaperList(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`bad --papers entry "${part}"`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = a; n <= b; n++) out.push(n);
  }
  return out;
}

function tsv(values: Array<string | number | null | undefined>): string {
  return values.map((v) => String(v ?? "").replace(/[\t\n|]/g, " ")).join("\t");
}

function cell(text: string | null | undefined, max = 90): string {
  const flat = (text ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

interface Assessment {
  row_key: string;
  row_title: string;
  grade: NoveltyGrade | null;
  news: string | null;
  prior_on: string | null;
  prior_headline: string | null;
  similarity: number | null;
  score_before: number | null;
  penalty: number;
  max_tier: PieceTier | null;
}

async function main() {
  const flags = parseArgs(process.argv);
  if (!flags["papers"] || !flags["out"]) {
    console.error(
      "Usage: npm run novelty-preview -- --papers <a-b|a,b,…> --out <file.md> [--rerun-runs paper:run,…]",
    );
    process.exit(1);
  }
  const papers = parsePaperList(flags["papers"]);
  const reuse = new Map<number, number>(
    (flags["rerun-runs"] ?? "")
      .split(",")
      .filter((s) => s.includes(":"))
      .map((s) => s.split(":").map(Number) as [number, number]),
  );
  const config = loadModelConfig();
  const previewCfg = {
    pileTarget: config.cluster.pile_target,
    sourceWeight: config.rank.source_weight,
    featureCount: config.rank.tiers.feature,
    standardCount: config.rank.tiers.standard,
  };
  const pool = getPool();

  const md: string[] = [
    "# Novelty preview",
    "",
    `Papers ${papers.join(", ")}. Grades from the rerun check as of each paper's date; ` +
      `penalties minor -${config.novelty.grades.minor.penalty} (max ${config.novelty.grades.minor.max_tier ?? "none"}), ` +
      `routine -${config.novelty.grades.routine.penalty} (max ${config.novelty.grades.routine.max_tier ?? "none"}).`,
    "",
    "**before** = the day re-ranked with the old check's withholds and no reductions; " +
      "**after** = the new grades applied. Both omit the editor's LLM tie-break and the " +
      "writers' material swap, so ranks can differ by a place or two from the printed paper; " +
      "the difference between the two columns is the change. Titles are the printed headline " +
      "where the story ran, otherwise the row's own title.",
    "",
  ];
  const summary: string[] = [
    "| paper | date | graded | rerun | minor | routine | development | new | ungraded | old check withheld | top-10 changed |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const tsvLines = [
    tsv([
      "paper", "date", "key", "grade", "score_before", "penalty", "max_tier",
      "before_rank", "after_rank", "before_tier", "after_tier", "old_check_withheld",
      "printed_headline", "row_title", "prior_on", "prior_headline", "similarity", "news",
    ]),
  ];
  const sections: string[] = [];

  for (const paperId of papers) {
    const { rows: meta } = await pool.query<{
      published_on: string;
      pass1: number;
      thread_run_id: number | null;
      grouping_run_id: number;
    }>(
      `SELECT to_char(p.published_on, 'YYYY-MM-DD') AS published_on,
              ep.grouping_pass1_run_id AS pass1, ep.thread_run_id, ep.grouping_run_id
         FROM papers p
         JOIN editor_runs er ON er.id = p.editor_run_id
         JOIN editor_piles ep ON ep.id = er.pile_id
        WHERE p.id = $1`,
      [paperId],
    );
    const m = meta[0];
    if (!m) {
      console.warn(`[novelty-preview] paper #${paperId} not found — skipped`);
      continue;
    }

    // The check the day actually ran with: the first rerun run on its pass-1 run.
    const { rows: oldRun } = await pool.query<{ id: number }>(
      "SELECT id FROM rerun_runs WHERE grouping_pass1_run_id = $1 ORDER BY id ASC LIMIT 1",
      [m.pass1],
    );
    const oldWithheld = new Set<string>();
    if (oldRun[0]) {
      const { rows } = await pool.query<{ row_key: string }>(
        `SELECT DISTINCT row_key FROM rerun_verdicts WHERE rerun_run_id = $1 AND verdict = 'rerun'
         UNION
         SELECT DISTINCT row_key FROM rerun_assessments WHERE rerun_run_id = $1 AND grade = 'rerun'`,
        [oldRun[0].id],
      );
      for (const r of rows) oldWithheld.add(r.row_key);
    }

    let newRunId = reuse.get(paperId);
    if (newRunId === undefined) {
      console.log(`[novelty-preview] paper #${paperId} (${m.published_on}): grading pass-1 run #${m.pass1}`);
      const r = await runNovelty({ groupingPass1RunId: m.pass1, asOf: m.published_on });
      newRunId = r.rerunRunId!;
    }
    const { rows: assessments } = await pool.query<Assessment>(
      `SELECT row_key, row_title, grade, news, to_char(prior_published_on, 'YYYY-MM-DD') AS prior_on,
              prior_headline, similarity, score_before, penalty, max_tier
         FROM rerun_assessments WHERE rerun_run_id = $1`,
      [newRunId],
    );
    const byKey = new Map(assessments.map((a) => [a.row_key, a]));
    const effects = new Map<string, NoveltyEffect>(
      assessments.map((a) => [a.row_key, effectOf(a.grade, config.novelty.grades)]),
    );
    const oldEffects = new Map<string, NoveltyEffect>(
      [...oldWithheld].map((k) => [k, { withhold: true, penalty: 0, maxTier: null }]),
    );

    // The day's rows and threads, from the stored pass-1 scores.
    const { rows: digestRows } = await pool.query<{ digest: string | null }>(
      "SELECT digest FROM grouping_runs WHERE id = $1",
      [m.grouping_run_id],
    );
    const clusterTitle = new Map(
      parseGroupingDigest(digestRows[0]?.digest ?? "").map((c) => [c.clusterIndex, c.title]),
    );
    const { rows: resultRows } = await pool.query<{
      item_type: string;
      cluster_index: number | null;
      preprocessed_item_id: string | null;
      score: number;
      source_count: number | null;
      title: string | null;
      english_title: string | null;
    }>(
      `SELECT r.item_type, r.cluster_index, r.preprocessed_item_id::text AS preprocessed_item_id,
              r.score, r.source_count, pi.title, pi.english_title
         FROM grouping_pass1_results r
         LEFT JOIN preprocessed_items pi ON pi.id = r.preprocessed_item_id
        WHERE r.run_id = $1`,
      [m.pass1],
    );
    const rowByKey = new Map<string, PreviewRow>();
    for (const r of resultRows) {
      const key = r.item_type === "cluster" ? `C${r.cluster_index}` : `S${r.preprocessed_item_id}`;
      rowByKey.set(key, {
        key,
        title:
          r.item_type === "cluster"
            ? (clusterTitle.get(r.cluster_index!) ?? key)
            : r.title !== null
              ? englishTitle({ title: r.title, english_title: r.english_title })
              : key,
        score: r.score,
        sourceCount: r.source_count ?? 1,
      });
    }
    const threads: PreviewThread[] = [];
    if (m.thread_run_id !== null) {
      const { rows: memberRows } = await pool.query<{
        thread_index: number;
        title: string;
        item_type: string;
        cluster_index: number | null;
        preprocessed_item_id: string | null;
      }>(
        `SELECT t.thread_index, t.title, tm.item_type, tm.cluster_index,
                tm.preprocessed_item_id::text AS preprocessed_item_id
           FROM threads t JOIN thread_members tm ON tm.thread_id = t.id
          WHERE t.thread_run_id = $1
          ORDER BY t.thread_index`,
        [m.thread_run_id],
      );
      const byIndex = new Map<number, PreviewThread>();
      for (const r of memberRows) {
        const key = r.item_type === "cluster" ? `C${r.cluster_index}` : `S${r.preprocessed_item_id}`;
        const t = byIndex.get(r.thread_index) ?? { key: `T${r.thread_index}`, title: r.title, members: [] };
        const row = rowByKey.get(key);
        if (row) t.members.push(row);
        byIndex.set(r.thread_index, t);
      }
      threads.push(...byIndex.values());
    }

    // Printed headlines, so the report reads like the paper did.
    const { rows: printed } = await pool.query<{ ref: string; headline: string | null; body: string }>(
      "SELECT ref, headline, body FROM paper_pieces WHERE paper_id = $1",
      [paperId],
    );
    const printedHeadline = new Map(
      printed.map((p) => [p.ref, p.headline ?? `(line) ${p.body.slice(0, 80)}`]),
    );
    const titleOf = (s: PreviewStory) =>
      s.kind === "thread"
        ? `§ ${s.title}`
        : (printedHeadline.get(s.key) ?? s.title);

    const rows = [...rowByKey.values()];
    const before = previewRanking(rows, threads, oldEffects, previewCfg);
    const after = previewRanking(rows, threads, effects, previewCfg);
    const beforeByKey = new Map(before.map((s) => [s.key, s]));
    const afterByKey = new Map(after.map((s) => [s.key, s]));
    // Which story a row sits in, so a thread member's grade shows on its section.
    const storyOfRow = (stories: PreviewStory[]) => {
      const map = new Map<string, PreviewStory>();
      for (const s of stories) {
        map.set(s.key, s);
        for (const k of s.memberKeys) map.set(k, s);
      }
      return map;
    };
    const beforeOf = storyOfRow(before);
    const afterOf = storyOfRow(after);
    const gradeLabel = (s: PreviewStory) => {
      const keys = s.kind === "thread" ? s.memberKeys : [s.key];
      const gs = keys.map((k) => byKey.get(k)?.grade).filter((g): g is NoveltyGrade => !!g);
      return gs.length === 0 ? "" : s.kind === "thread" ? gs.join("/") : gs[0]!;
    };

    // Summary row.
    const count = (g: NoveltyGrade | null) => assessments.filter((a) => a.grade === g).length;
    const top10Before = new Set(before.slice(0, 10).map((s) => s.key));
    const top10Changed = after.slice(0, 10).filter((s) => !top10Before.has(s.key)).length;
    summary.push(
      `| #${paperId} | ${m.published_on} | ${assessments.length} | ${count("rerun")} | ${count("minor")} | ` +
        `${count("routine")} | ${count("development")} | ${count("new")} | ${count(null)} | ` +
        `${oldWithheld.size} | ${top10Changed} of 10 |`,
    );

    const sec: string[] = [
      `## Paper #${paperId} — ${m.published_on}`,
      "",
      `pass-1 run #${m.pass1}, new rerun run #${newRunId}` +
        (oldRun[0] ? `, old rerun run #${oldRun[0].id}` : "") + ".",
      "",
      `### Top ${TOP}: before → after`,
      "",
      "| before | after | tier | grade | story |",
      "|---|---|---|---|---|",
    ];
    for (const s of before.slice(0, TOP)) {
      const a = afterByKey.get(s.key);
      const tier = a ? (a.tier === s.tier ? s.tier : `${s.tier} → **${a.tier}**`) : s.tier;
      const where = a ? (a.rank === s.rank ? `${a.rank}` : `**${a.rank}**`) : "**out**";
      sec.push(`| ${s.rank} | ${where} | ${tier} | ${gradeLabel(s)} | ${cell(titleOf(s))} |`);
    }
    const entered = after.slice(0, TOP).filter((s) => (beforeByKey.get(s.key)?.rank ?? Infinity) > TOP);
    if (entered.length > 0) {
      sec.push("", `Entering the top ${TOP}:`, "");
      for (const s of entered) {
        sec.push(`- ${s.rank} (${s.tier}, was ${beforeByKey.get(s.key)?.rank ?? "out"}) ${cell(titleOf(s), 120)} ${gradeLabel(s) ? `[${gradeLabel(s)}]` : ""}`);
      }
    }

    sec.push("", "### Every graded row, by grade", "");
    const order: Array<NoveltyGrade | null> = ["rerun", "routine", "minor", "development", "new", null];
    for (const g of order) {
      const list = assessments
        .filter((a) => a.grade === g)
        .sort((x, y) => (y.score_before ?? 0) - (x.score_before ?? 0));
      if (list.length === 0) continue;
      sec.push(`**${g ?? "ungraded"}** (${list.length})`, "");
      for (const a of list) {
        const b = beforeOf.get(a.row_key);
        const af = afterOf.get(a.row_key);
        const pos = `${b ? `#${b.rank}` : "–"} → ${af ? `#${af.rank}` : "out"}`;
        const was = oldWithheld.has(a.row_key) ? " _(old check withheld it)_" : "";
        sec.push(
          `- \`${a.row_key}\` ${pos} · score ${a.score_before}${a.penalty ? `−${a.penalty}` : ""}` +
            `${a.max_tier ? ` · max ${a.max_tier}` : ""}${was} — ${cell(printedHeadline.get(a.row_key) ?? a.row_title, 140)}`,
        );
        sec.push(`  - printed ${a.prior_on}: ${cell(a.prior_headline ?? "(line)", 140)} [${Number(a.similarity ?? 0).toFixed(3)}]`);
        if (a.news) sec.push(`  - today: ${cell(a.news, 240)}`);
      }
      sec.push("");
    }
    sections.push(sec.join("\n"));

    for (const a of assessments) {
      const b = beforeOf.get(a.row_key);
      const af = afterOf.get(a.row_key);
      tsvLines.push(
        tsv([
          paperId, m.published_on, a.row_key, a.grade ?? "ungraded", a.score_before, a.penalty, a.max_tier,
          b?.rank, af?.rank, b?.tier, af?.tier, oldWithheld.has(a.row_key) ? "yes" : "",
          printedHeadline.get(a.row_key), a.row_title, a.prior_on, a.prior_headline,
          a.similarity, a.news,
        ]),
      );
    }
  }

  md.push("## Summary", "", ...summary, "", ...sections);
  writeFileSync(flags["out"], md.join("\n") + "\n");
  writeFileSync(`${flags["out"]}.tsv`, tsvLines.join("\n") + "\n");
  console.log(`[novelty-preview] wrote ${flags["out"]} and ${flags["out"]}.tsv`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
