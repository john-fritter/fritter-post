import "dotenv/config";
import { randomInt } from "node:crypto";
import { writeFileSync } from "node:fs";
import { getPool } from "../src/db/index.js";
import { loadModelConfig } from "../src/config/models.js";
import { overridesFromFlags } from "../src/config/overrides.js";
import { loadThreadCandidates, runThreading } from "../src/pipeline/thread/index.js";

// Runs the thread pass on its own, for model comparison, and exports what every
// thread run over the same grouping-pass-1 runs produced.
//
// Run: writes thread_runs / threads / thread_members (plus generation_logs) and
// nothing else — no pile, no editor run. The pile keeps the thread run it was
// assembled with, so a test run here changes no paper.
//
//   npm run thread-check -- --pass1-runs 55,56 [--model <id>] [--provider nanogpt]
//     [--reasoning-effort <level|omit>] [--max-tokens <n>] [--timeout-ms <n>]
//
// Export: every thread run over those pass-1 runs, member titles resolved, as
// markdown. --blind labels the runs by letter and writes the key separately.
//
//   npm run thread-check -- --export --pass1-runs 55,56 --out /tmp/threads.md [--blind]

function parseArgs(argv: string[]): Record<string, string> {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else {
      flags[a.slice(2)] = "true";
    }
  }
  return flags;
}

function parseIds(s: string | undefined): number[] {
  if (!s) return [];
  return s.split(",").map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n));
}

interface ThreadRow {
  run_id: number;
  model_used: string;
  threads_formed: number | null;
  failed_calls: number | null;
  output_tokens: number | null;
  started_at: string;
}

async function exportRuns(pass1Runs: number[], out: string, blind: boolean): Promise<void> {
  const pool = getPool();
  const cfg = loadModelConfig().thread;
  const lines: string[] = ["# Thread pass comparison", ""];
  const key: string[] = ["# Blind key — withhold until the reading is done", ""];

  for (const pass1 of pass1Runs) {
    // Resolve refs to titles from the candidate set the pass saw.
    const candidates = await loadThreadCandidates(pass1, cfg.candidate_target, cfg.summary_cap);
    const byRef = new Map(candidates.map((c) => [c.ref, c]));

    const { rows: runs } = await pool.query<ThreadRow>(
      `SELECT id AS run_id, model_used, threads_formed, failed_calls, output_tokens,
              started_at::text
       FROM thread_runs
       WHERE grouping_pass1_run_id = $1 AND completed_at IS NOT NULL
       ORDER BY id`,
      [pass1],
    );

    // Shuffle within the day so the order says nothing either.
    const order = runs.map((r) => r);
    if (blind) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
    }

    lines.push(`## grouping-pass-1 run ${pass1} — ${candidates.length} candidates`, "");
    for (let k = 0; k < order.length; k++) {
      const r = order[k]!;
      const label = blind ? `Judge ${String.fromCharCode(65 + k)}` : `run ${r.run_id} (${r.model_used})`;
      if (blind) key.push(`- pass-1 ${pass1}, ${label} = thread run ${r.run_id}, ${r.model_used}`);

      lines.push(
        `### ${label} — ${r.threads_formed ?? 0} thread(s)` +
          (r.failed_calls ? `, **${r.failed_calls} failed call(s)**` : ""),
        "",
      );
      const { rows: threads } = await pool.query<{
        id: string; thread_index: number; title: string; anchor: string | null;
        summary: string | null; score: number; source_count: number;
      }>(
        `SELECT id, thread_index, title, anchor, summary, score, source_count
         FROM threads WHERE thread_run_id = $1 ORDER BY thread_index`,
        [r.run_id],
      );
      for (const t of threads) {
        lines.push(`**T${t.thread_index}: ${t.title}** (score ${t.score}, sources ${t.source_count})`);
        lines.push(`- anchor: ${t.anchor ?? "_(none)_"}`);
        if (t.summary) lines.push(`- summary: ${t.summary}`);
        const { rows: members } = await pool.query<{
          item_type: string; cluster_index: number | null; preprocessed_item_id: string | null; score: number;
        }>(
          `SELECT item_type, cluster_index, preprocessed_item_id, score
           FROM thread_members WHERE thread_id = $1 ORDER BY score DESC, id`,
          [t.id],
        );
        for (const m of members) {
          const ref = m.item_type === "cluster" ? `C${m.cluster_index}` : `S${m.preprocessed_item_id}`;
          lines.push(`  - ${ref} (${m.score}): ${byRef.get(ref)?.title ?? "_(title not resolved)_"}`);
        }
        lines.push("");
      }
      if (threads.length === 0) lines.push("_(no threads)_", "");
    }
  }

  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`[thread-check] wrote ${out}`);
  if (blind) {
    const keyPath = out.replace(/\.md$/, "") + "-key.md";
    writeFileSync(keyPath, key.join("\n") + "\n");
    console.log(`[thread-check] wrote ${keyPath} (withhold until the reading is done)`);
  }
}

async function main() {
  const flags = parseArgs(process.argv);
  const pass1Runs = parseIds(flags["pass1-runs"]);
  if (flags["help"] || pass1Runs.length === 0) {
    console.error(
      "Usage: npm run thread-check -- --pass1-runs <a,b,…> [model override flags]\n" +
        "       npm run thread-check -- --export --pass1-runs <a,b,…> --out <file.md> [--blind]",
    );
    process.exit(flags["help"] ? 0 : 1);
  }

  if (flags["export"]) {
    await exportRuns(pass1Runs, flags["out"] ?? "/tmp/thread-check.md", flags["blind"] === "true");
    process.exit(0);
  }

  const { export: _e, out: _o, blind: _b, "pass1-runs": _p, ...modelFlags } = flags;
  const overrides = overridesFromFlags(modelFlags);
  for (const pass1 of pass1Runs) {
    const s = await runThreading({ groupingPass1RunId: pass1, overrides });
    console.log(
      `[thread-check] pass-1 ${pass1}: thread run ${s.threadRunId}, ` +
        `${s.threadsFormed} thread(s), ${s.rowsAbsorbed} rows, failed_calls=${s.failedCalls}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
