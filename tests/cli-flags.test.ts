import assert from "node:assert/strict";
import { RENAMED_FLAGS, withRenamedFlags } from "../src/lib/cli-flags.js";

// The old spelling is rewritten to the new one, with its value left alone.
assert.deepEqual(
  withRenamedFlags(["node", "write.ts", "--editor-run", "112", "--tier", "brief"]),
  ["node", "write.ts", "--rank-run", "112", "--tier", "brief"],
);

// The new spelling passes through unchanged.
assert.deepEqual(withRenamedFlags(["--rank-run", "112"]), ["--rank-run", "112"]);

// Only whole flags are rewritten: a value or a longer flag that merely contains
// an old name is not a flag of ours.
assert.deepEqual(
  withRenamedFlags(["--out", "--editor-run.md", "--editor-runs", "1"]),
  ["--out", "--editor-run.md", "--editor-runs", "1"],
);

// Every alias lands on a `--<stage>-run(s)` name, and no new name is itself an
// old one (which would make the mapping order-dependent).
for (const [oldName, newName] of Object.entries(RENAMED_FLAGS)) {
  assert.match(newName, /^--[a-z]+-runs?$/, `${oldName} -> ${newName}`);
  assert.equal(RENAMED_FLAGS[newName], undefined, `${newName} is also an old name`);
}

console.log("cli flag tests passed");
