/**
 * Generates the systemd unit and timer from `pipeline.schedule` in models.yaml.
 *
 * The hour the paper is made is configuration, and configuration in this project
 * lives in models.yaml. But a systemd timer cannot read YAML, so without this
 * the time would exist in two places and drift -- the failure mode being a
 * reader who changes the config, sees nothing happen, and has no reason to
 * suspect the unit file. Generating the unit makes models.yaml the only copy.
 *
 * Pure: takes the schedule, returns the file contents. Unit-tested.
 */

export interface TimerInputs {
  /** "HH:MM", 24-hour, in `timezone`. */
  time: string;
  /** IANA zone, e.g. America/Los_Angeles. */
  timezone: string;
  /** Directory holding docker-compose.yml on the host. */
  workingDir: string;
  /**
   * The runner's own between-stages deadline. systemd's kill has to sit well
   * clear of it: the runner refuses to START a stage past the deadline, so a
   * stage that begins one minute before it still gets to run to completion.
   */
  maxDurationMinutes: number;
}

export interface TimerUnits {
  onCalendar: string;
  serviceName: string;
  timerName: string;
  service: string;
  timer: string;
}

/**
 * systemd's hard kill, in minutes.
 *
 * The runner's deadline bounds when a stage may start, not how long it may run,
 * so the two are not the same number and systemd's must be the larger. The
 * slack is one hour: the writers are the longest stage and the one most likely
 * to be in flight at the deadline.
 */
export function killTimeoutMinutes(maxDurationMinutes: number): number {
  return maxDurationMinutes + 60;
}

export function buildTimerUnits(inputs: TimerInputs): TimerUnits {
  const { time, timezone, workingDir, maxDurationMinutes } = inputs;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error(`schedule.time must be "HH:MM", got "${time}"`);
  }

  // The timezone-qualified calendar spec needs systemd 252 or newer. Older
  // systemd parses OnCalendar in the host's local time and would silently run
  // at the right clock face in the wrong zone, so the unit says so rather than
  // leaving it to be discovered in the spring.
  const onCalendar = `*-*-* ${time}:00 ${timezone}`;
  const killTimeout = killTimeoutMinutes(maxDurationMinutes);

  const service = `[Unit]
Description=The Fritter Post — daily pipeline
Documentation=https://post.fritter.lol
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
WorkingDirectory=${workingDir}

# The pipeline runs inside the app container, which is where the config, the
# credentials and the database connection are. It is not started here: a
# \`compose up\` would recreate the container and drop it off seedbox_default,
# which is how this deployment 502s. If the container is down, the run should
# fail loudly rather than quietly repair the site into a different state.
ExecStartPre=/bin/sh -c 'docker compose ps --status running --quiet app | grep -q .'
ExecStart=/usr/bin/docker compose exec -T app npm run pipeline

# Longer than the runner's own ${maxDurationMinutes}-minute deadline, because
# that deadline only refuses to start new stages — a stage already running when
# it passes still runs to completion. This is the kill that can actually kill.
TimeoutStartSec=${killTimeout}min

[Install]
WantedBy=multi-user.target
`;

  const timer = `[Unit]
Description=The Fritter Post — daily pipeline at ${time} ${timezone}

[Timer]
# Generated from pipeline.schedule in config/models.yaml. Do not edit here:
# regenerate with \`npm run pipeline -- --print-timer\`.
#
# The timezone suffix requires systemd 252 or newer. On older systemd this is
# parsed in the host's local time — check with \`systemctl --version\`, and
# either set the host timezone to ${timezone} or convert the hour to the
# host's zone by hand, remembering that the offset moves twice a year.
OnCalendar=${onCalendar}

# A box that was asleep at ${time} still makes the paper when it wakes. A late
# paper beats no paper, and the publisher dates the edition by the reader's
# local day, so a catch-up run publishes the day it actually ran for.
Persistent=true

# No RandomizedDelaySec: a newspaper arrives at a time.

[Install]
WantedBy=timers.target
`;

  return {
    onCalendar,
    serviceName: "fritter-post-pipeline.service",
    timerName: "fritter-post-pipeline.timer",
    service,
    timer,
  };
}
