/**
 * Test runner. Discovers every tests/*.test.ts file and runs each in its own
 * tsx child process, so one failing suite can't take the others' output with it.
 *
 * Usage: npm test
 *
 * The test files are plain node:assert scripts — they throw on failure and
 * print a "… tests passed" line on success. This runner only cares about exit
 * codes; it reports a per-file pass/fail summary and exits non-zero if any
 * file failed.
 */

import { spawn } from "child_process";
import { readdir } from "fs/promises";
import path from "path";

const TESTS_DIR = path.join(import.meta.dirname, "..", "tests");
const TSX_BIN = path.join(
  import.meta.dirname,
  "..",
  "node_modules",
  ".bin",
  "tsx"
);

function runFile(filepath: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(TSX_BIN, [filepath], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const files = (await readdir(TESTS_DIR))
    .filter((f) => f.endsWith(".test.ts"))
    .sort();

  if (files.length === 0) {
    console.error("No test files found in tests/");
    process.exit(1);
  }

  const failed: string[] = [];

  for (const filename of files) {
    console.log(`\n─── ${filename} ───`);
    const code = await runFile(path.join(TESTS_DIR, filename));
    if (code !== 0) {
      failed.push(filename);
    }
  }

  console.log(`\n${"=".repeat(40)}`);
  if (failed.length > 0) {
    console.error(`${failed.length}/${files.length} test file(s) FAILED:`);
    for (const f of failed) {
      console.error(`  ✗ ${f}`);
    }
    process.exit(1);
  }

  console.log(`All ${files.length} test files passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
