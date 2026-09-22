import assert from "node:assert/strict";
import { parseRerunVerdicts, buildRerunUserPrompt } from "../src/pipeline/rerun/prompt.js";
import { rowsToDrop, chunk } from "../src/pipeline/rerun/select.js";
import { gateRerun } from "../src/pipeline/runner/gates.js";
import { loadModelConfig } from "../src/config/models.js";

// --- parseRerunVerdicts ---

{
  const v = parseRerunVerdicts(
    [
      "1;;RERUN;;same AfD result, 43.8% and three seats short",
      "2;;DEVELOPMENT;;LG now denies continuous recording",
      "3;;NEW;;different ferry, different sea",
    ].join("\n"),
    3,
  );
  assert.equal(v.get(0)?.verdict, "rerun");
  assert.equal(v.get(0)?.reason, "same AfD result, 43.8% and three seats short");
  assert.equal(v.get(1)?.verdict, "development");
  assert.equal(v.get(2)?.verdict, "new");
}

// Shape is forgiven: bold, lower case, a missing reason, prose around it.
{
  const v = parseRerunVerdicts(
    "Here are the verdicts:\n**1**;;**rerun**\n2 ;; Development ;; toll doubled\nDone.",
    2,
  );
  assert.equal(v.get(0)?.verdict, "rerun");
  assert.equal(v.get(0)?.reason, null, "a missing reason costs the reason, not the verdict");
  assert.equal(v.get(1)?.verdict, "development");
}

// Fail open: an unreadable, unknown, out-of-range or missing line yields
// nothing, and nothing means the row stays.
{
  const v = parseRerunVerdicts("1;;MAYBE;;unsure\n7;;RERUN;;out of range\n2 RERUN no delimiter", 3);
  assert.equal(v.size, 0);
}

// The first answer for a number stands; a model that revises later does not
// get to turn a keep into a drop.
{
  const v = parseRerunVerdicts("1;;DEVELOPMENT;;new ruling\n1;;RERUN;;same", 1);
  assert.equal(v.get(0)?.verdict, "development");
}

// --- rowsToDrop ---

{
  const drop = rowsToDrop([
    // Any rerun pair drops the row, even when its other pair is a development:
    // today's AfD recap against Sep 6's "voting today" and Sep 8's result.
    { rowKey: "C4", verdict: "development" },
    { rowKey: "C4", verdict: "rerun" },
    { rowKey: "S100", verdict: "development" },
    { rowKey: "S200", verdict: "new" },
    // Unjudged (a failed call) stays.
    { rowKey: "S300", verdict: null },
  ]);
  assert.deepEqual([...drop], ["C4"]);
}

// --- chunk ---

assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepEqual(chunk([], 3), []);

// --- prompt ---

{
  const p = buildRerunUserPrompt([
    {
      candidateTitle: "Jaguar Land Rover will cut 4,000 jobs over two years",
      candidateText: "Most of the cuts fall at the UK head office.",
      candidateDate: "2026-09-08",
      priorHeadline: "Jaguar Land Rover will cut 4,000 jobs over two years, mostly at its UK head office",
      priorBody: "JLR said on Sunday...",
      priorDate: "2026-09-07",
    },
  ]);
  assert.match(p, /1\.\n {2}CANDIDATE \(2026-09-08\): Jaguar/);
  assert.match(p, /PRINTED \(2026-09-07\)/);
}

// --- gate ---

{
  const cfg = loadModelConfig().pipeline.gates.rerun;
  assert.equal(gateRerun({ candidatesIn: 250, rowsDropped: 6, failedCalls: 0 }, cfg).verdict, "ok",
    "about six a day is the audited rate, and is the check working, not news");
  assert.equal(gateRerun({ candidatesIn: 250, rowsDropped: 6, failedCalls: 1 }, cfg).verdict, "warn");
  assert.equal(gateRerun({ candidatesIn: 250, rowsDropped: 90, failedCalls: 0 }, cfg).verdict, "warn",
    "a judge dropping a third of the paper is the failure a reader cannot see");
  assert.equal(gateRerun({ candidatesIn: 0, rowsDropped: 0, failedCalls: 0 }, cfg).verdict, "ok");
}

console.log("rerun tests passed");
