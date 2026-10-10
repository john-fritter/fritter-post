/**
 * Run-id flags are named for the stage whose run they name: `--rank-run 112`,
 * not `--editor-run 112`. The stages were renamed on 2026-10-08 and the flags
 * followed on 2026-10-10; the old spellings are kept as aliases so older notes,
 * Gizmo prompts and shell history keep working.
 *
 * Applied to argv before a script parses it, so each script reads only the new
 * name. The tables and columns these ids point into still carry the old names
 * (`editor_runs`, `grouping_run_id`); see docs/design.md §6.
 */

export const RENAMED_FLAGS: Readonly<Record<string, string>> = {
  "--collector-run-id": "--collect-run",
  "--preprocessor-run-id": "--preprocess-run",
  "--grouping-run-id": "--cluster-run",
  "--grouping-pass1-run": "--score-run",
  "--pass1-runs": "--score-runs",
  "--rerun-runs": "--novelty-runs",
  "--editor-run": "--rank-run",
  "--writer-run": "--write-run",
};

/** argv with every old flag spelling replaced by its current one. */
export function withRenamedFlags(argv: readonly string[]): string[] {
  return argv.map((arg) => RENAMED_FLAGS[arg] ?? arg);
}
