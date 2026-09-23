/**
 * Writer bake-off export: several writer runs over the same editor run and the
 * same ranks, one per model, laid side by side for reading.
 *
 * Writes three files into --out:
 *   summary.md  one row per run: model, pieces, failures, calls, tokens, time
 *   pieces.md   every piece in paper order, each model's version under it
 *   packets.md  the exact prompts the FIRST run sent (system prompt once, then
 *               each call's user prompt). The packets are identical across runs,
 *               since they are built from the same editor run.
 *
 * --blind labels each run "Writer A", "Writer B", … in a random order instead
 * of by model, so the prose can be judged without knowing who wrote it. The
 * mapping and the per-model numbers go to key.md and summary.md, which are
 * meant to be withheld until the reading is done.
 *
 * Read-only.
 *
 *   tsx scripts/writer-bakeoff-export.ts --runs 201,202,203 --out /tmp/bakeoff [--blind]
 */

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { join } from "node:path";
import { getPool } from "../src/db/index.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let runs: number[] = [];
  let out = "writer-bakeoff";
  let blind = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--runs" && i + 1 < args.length) {
      runs = args[++i]!.split(",").map((s) => parseInt(s.trim(), 10));
    } else if (args[i] === "--out" && i + 1 < args.length) {
      out = args[++i]!;
    } else if (args[i] === "--blind") {
      blind = true;
    }
  }
  return { runs, out, blind };
}

interface RunRow {
  id: number;
  editor_run_id: number;
  model_used: string;
  pieces_in: number;
  pieces_written: number;
  pieces_failed: number;
  calls: number;
  failed_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  seconds: number | null;
}

interface PieceRow {
  run_id: number;
  rank: number;
  section_rank: number;
  section_ref: string | null;
  section_role: string | null;
  section_title: string | null;
  tier: string;
  ref: string;
  headline: string | null;
  body: string | null;
  word_count: number;
  material_level: string | null;
  source_count: number;
  articles_used: number;
  status: string;
  detail: string | null;
  generation_log_id: string | null;
}

async function main() {
  const { runs, out, blind } = parseArgs(process.argv);
  if (runs.length === 0 || runs.some((r) => !Number.isFinite(r))) {
    console.error("Usage: tsx scripts/writer-bakeoff-export.ts --runs <id,id,...> [--out <dir>]");
    process.exit(1);
  }
  const pool = getPool();

  const { rows: runRows } = await pool.query<RunRow>(
    `SELECT id, editor_run_id, model_used, pieces_in, pieces_written, pieces_failed,
            calls, failed_calls, input_tokens, output_tokens,
            EXTRACT(EPOCH FROM (completed_at - started_at))::int AS seconds
     FROM writer_runs WHERE id = ANY($1)`,
    [runs],
  );
  const byId = new Map(runRows.map((r) => [r.id, r]));
  const ordered = runs.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`writer run #${id} not found`);
    return r;
  });
  const editorRuns = new Set(ordered.map((r) => r.editor_run_id));
  if (editorRuns.size !== 1) {
    throw new Error(`runs span editor runs ${[...editorRuns].join(", ")}; a bake-off needs one`);
  }

  const { rows: logRows } = await pool.query<{
    stage_run_id: number;
    calls: number;
    errors: number;
    duration_ms: string;
    max_out: number | null;
  }>(
    `SELECT stage_run_id, count(*)::int AS calls, count(error)::int AS errors,
            sum(duration_ms)::text AS duration_ms, max(output_tokens) AS max_out
     FROM generation_logs
     WHERE stage IN ('writers', 'writers-briefs') AND stage_run_id = ANY($1)
     GROUP BY stage_run_id`,
    [runs],
  );
  const logs = new Map(logRows.map((r) => [r.stage_run_id, r]));

  const { rows: pieces } = await pool.query<PieceRow>(
    `SELECT run_id, rank, section_rank, section_ref, section_role, section_title, tier, ref,
            headline, body, word_count, material_level, source_count, articles_used,
            status, detail, generation_log_id::text
     FROM writer_pieces WHERE run_id = ANY($1)
     ORDER BY rank, section_rank, ref, run_id`,
    [runs],
  );

  mkdirSync(out, { recursive: true });

  // summary.md
  const s: string[] = [];
  s.push(`# Writer bake-off — editor run #${[...editorRuns][0]}`);
  s.push("");
  s.push(
    "| run | model | in | written | failed | calls | failed calls | provider attempts | provider errors | in tok | out tok | max out | wall s |",
  );
  s.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of ordered) {
    const l = logs.get(r.id);
    s.push(
      `| ${r.id} | ${r.model_used} | ${r.pieces_in} | ${r.pieces_written} | ${r.pieces_failed} | ` +
        `${r.calls} | ${r.failed_calls} | ${l?.calls ?? 0} | ${l?.errors ?? 0} | ` +
        `${r.input_tokens ?? ""} | ${r.output_tokens ?? ""} | ${l?.max_out ?? ""} | ${r.seconds ?? ""} |`,
    );
  }
  writeFileSync(join(out, "summary.md"), s.join("\n") + "\n");

  // Labels. Blind: a random permutation of letters, so neither the order of
  // --runs nor the run ids give the model away.
  const labelOf = new Map<number, string>();
  if (blind) {
    const letters = runs.map((_, i) => String.fromCharCode(65 + i));
    for (let i = letters.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [letters[i], letters[j]] = [letters[j]!, letters[i]!];
    }
    runs.forEach((id, i) => labelOf.set(id, `Writer ${letters[i]}`));
    const key = ["# Blind key — withhold until the reading is done", ""];
    for (const r of ordered) key.push(`- ${labelOf.get(r.id)} = ${r.model_used} (run ${r.id})`);
    writeFileSync(join(out, "key.md"), key.join("\n") + "\n");
  } else {
    for (const r of ordered) labelOf.set(r.id, `${r.model_used} (run ${r.id})`);
  }
  // In blind mode each story lists its versions in label order, not --runs order.
  const readingOrder = blind
    ? [...runs].sort((a, b) => labelOf.get(a)!.localeCompare(labelOf.get(b)!))
    : runs;

  // pieces.md
  const groups = new Map<string, PieceRow[]>();
  for (const p of pieces) {
    const key = `${p.rank}|${p.section_rank}|${p.ref}`;
    const g = groups.get(key) ?? [];
    g.push(p);
    groups.set(key, g);
  }
  const lines: string[] = [];
  for (const g of groups.values()) {
    const first = g[0]!;
    const role = first.section_role ? ` · ${first.section_role} of ${first.section_ref} "${first.section_title ?? ""}"` : "";
    lines.push(
      `## rank ${first.rank}.${first.section_rank} · ${first.ref} · ${first.tier}${role} · ` +
        `material=${first.material_level ?? "?"} · sources=${first.source_count} · used=${first.articles_used}`,
    );
    lines.push("");
    for (const runId of readingOrder) {
      const p = g.find((x) => x.run_id === runId);
      lines.push(`### ${labelOf.get(runId)}`);
      if (!p) {
        lines.push("_(no row)_");
      } else if (p.status !== "ok") {
        lines.push(`**FAILED:** ${p.detail ?? ""}`);
      } else {
        lines.push(`**${p.headline ?? "_(no headline)_"}** — ${p.word_count} words`);
        lines.push("");
        lines.push(p.body ?? "");
      }
      lines.push("");
    }
  }
  writeFileSync(join(out, "pieces.md"), lines.join("\n"));

  // packets.md — the first run's prompts, once each
  const firstRun = runs[0]!;
  const { rows: prompts } = await pool.query<{ id: string; stage: string; system_prompt: string; user_prompt: string }>(
    `SELECT id::text, stage, system_prompt, user_prompt FROM generation_logs
     WHERE stage IN ('writers', 'writers-briefs') AND stage_run_id = $1 AND error IS NULL
     ORDER BY id`,
    [firstRun],
  );
  const pk: string[] = [];
  const systems = new Map<string, string>();
  for (const p of prompts) if (!systems.has(p.stage)) systems.set(p.stage, p.system_prompt);
  for (const [stage, sys] of systems) {
    pk.push(`# system prompt — ${stage}`);
    pk.push("");
    pk.push("```");
    pk.push(sys);
    pk.push("```");
    pk.push("");
  }
  const refsByLog = new Map<string, string[]>();
  for (const p of pieces) {
    if (p.run_id !== firstRun || !p.generation_log_id) continue;
    const l = refsByLog.get(p.generation_log_id) ?? [];
    l.push(`${p.ref} (rank ${p.rank}.${p.section_rank})`);
    refsByLog.set(p.generation_log_id, l);
  }
  for (const p of prompts) {
    pk.push(`# ${p.stage} call ${p.id} — ${(refsByLog.get(p.id) ?? ["?"]).join(", ")}`);
    pk.push("");
    pk.push("```");
    pk.push(p.user_prompt);
    pk.push("```");
    pk.push("");
  }
  writeFileSync(join(out, "packets.md"), pk.join("\n"));

  console.log(
    `[bakeoff] wrote summary.md, pieces.md, packets.md${blind ? ", key.md" : ""} to ${out}`,
  );
  // Blind: keep the model names off the console too.
  if (!blind) console.log(s.join("\n"));
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
