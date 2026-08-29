import assert from "node:assert/strict";
import { buildTimerUnits, killTimeoutMinutes } from "../src/pipeline/runner/timer.js";
import { loadModelConfig } from "../src/config/models.js";

const BASE = {
  time: "06:00",
  timezone: "America/Los_Angeles",
  workingDir: "/opt/fritter-post",
  maxDurationMinutes: 240,
};

function testCalendarCarriesTheTimezone() {
  // The hour is meaningless without the zone: the publisher dates the edition
  // by the reader's local day, so a unit that runs at 06:00 UTC makes a paper
  // for the wrong day.
  const u = buildTimerUnits(BASE);
  assert.equal(u.onCalendar, "*-*-* 06:00:00 America/Los_Angeles");
  assert.match(u.timer, /OnCalendar=\*-\*-\* 06:00:00 America\/Los_Angeles/);
}

function testTimeIsValidated() {
  assert.throws(() => buildTimerUnits({ ...BASE, time: "6:00" }), /HH:MM/);
  assert.throws(() => buildTimerUnits({ ...BASE, time: "24:00" }), /HH:MM/);
  assert.throws(() => buildTimerUnits({ ...BASE, time: "06:60" }), /HH:MM/);
  assert.doesNotThrow(() => buildTimerUnits({ ...BASE, time: "23:59" }));
  assert.doesNotThrow(() => buildTimerUnits({ ...BASE, time: "00:00" }));
}

function testKillTimeoutClearsTheRunnersDeadline() {
  // The runner's deadline refuses to START a stage; a stage already running
  // when it passes runs to completion. systemd's kill has to sit past that or
  // it would cut the writers off mid-paper.
  assert.ok(killTimeoutMinutes(240) > 240);
  const u = buildTimerUnits(BASE);
  assert.match(u.service, /TimeoutStartSec=300min/);
}

function testUnitDoesNotStartTheContainer() {
  // A `compose up` recreates the app container and drops it off
  // seedbox_default, which is how this deployment 502s. The unit checks and
  // fails instead.
  const u = buildTimerUnits(BASE);
  // Directive lines only: the unit's comments explain why `compose up` is not
  // here, and a naive match would find the explanation.
  const directives = u.service.split("\n").filter((l) => /^Exec/.test(l));
  assert.ok(directives.length > 0);
  assert.ok(!directives.some((l) => l.includes("compose up")));
  assert.match(u.service, /ExecStartPre=.*compose ps/);
  assert.match(u.service, /ExecStart=.*compose exec -T app npm run pipeline/);
}

function testNoAutomaticRestart() {
  // Restarting from the top is not a retry: cross-run dedup makes a same-day
  // full re-run come back near-empty, which would replace a good paper with an
  // empty one. Recovery is `--from`, by hand.
  const u = buildTimerUnits(BASE);
  assert.ok(!u.service.split("\n").some((l) => l.startsWith("Restart=")));
}

function testWorkingDirIsCarried() {
  const u = buildTimerUnits({ ...BASE, workingDir: "/srv/fritter-post" });
  assert.match(u.service, /WorkingDirectory=\/srv\/fritter-post/);
}

function testGeneratesFromTheRealConfig() {
  // models.yaml is the only copy of the schedule; this is the check that it can
  // actually produce a unit rather than merely parse.
  const { schedule, max_duration_minutes } = loadModelConfig().pipeline;
  const u = buildTimerUnits({
    time: schedule.time,
    timezone: schedule.timezone,
    workingDir: "/opt/fritter-post",
    maxDurationMinutes: max_duration_minutes,
  });
  assert.ok(u.onCalendar.includes(schedule.time));
  assert.ok(u.onCalendar.includes(schedule.timezone));
}

testCalendarCarriesTheTimezone();
testTimeIsValidated();
testKillTimeoutClearsTheRunnersDeadline();
testUnitDoesNotStartTheContainer();
testNoAutomaticRestart();
testWorkingDirIsCarried();
testGeneratesFromTheRealConfig();
console.log("pipeline timer tests passed");
