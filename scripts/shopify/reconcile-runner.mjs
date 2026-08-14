// ── The scheduled reconciler runner (Mac mini) ───────────────────────────────
// Publish in the app writes INTENT only; scripts/shopify/reconcile.mjs is what
// actually talks to Shopify. Until 2026-08-14 that was a command Junid typed on
// his MacBook — and his laptop's network already failed one commit run with
// ETIMEDOUT mid-push. This wrapper is what makes Publish "just work": launchd
// on the always-on Mac mini fires it every 2 minutes (owner spec 2026-08-14).
//
// What the wrapper adds over calling reconcile.mjs directly:
//
//   SINGLE-FLIGHT — a run already in progress is NEVER overlapped. launchd
//     will not start a second copy of the same job, but that guarantee ends at
//     the job boundary (a manual run, a re-loaded agent, a second install
//     would all slip past it), and an overlapped run means two processes
//     pushing the same product to Shopify. The lock is held HERE, in a
//     lockfile carrying the owning pid, so it holds regardless of who started
//     the run. A lock whose owner is gone (crash, kill -9, power cut) is
//     reclaimed; a lock whose owner is alive is respected and the tick exits 0
//     — a skipped tick is not a failure, the next one is 2 minutes away.
//
//   CHEAP NO-OP TICKS — reconcile.mjs exits at "nothing to do" before it mints
//     a Shopify token or opens a single HTTP connection, so an idle tick costs
//     one RTDB read of /shopify_publish and a node boot. Idle ticks are logged
//     as a single line so a quiet log still proves the schedule is alive.
//
//   LOUD FAILURES — a run that cannot reach Shopify must be OBVIOUS in the log
//     and must not silently clear intent. reconcile.mjs already leaves intent
//     unapplied on failure (it only confirms after Shopify agrees); this
//     wrapper makes the failure visible: the child's exit code is recorded,
//     a non-zero exit is banner-logged with the word FAILED, and consecutive
//     failures are counted so a persistent outage reads as an outage rather
//     than as a run that happened to be quiet.
//
//   ROTATED, READABLE LOGS — every line is timestamped (SAST, the clock Junid
//     reads); the log rotates at 5 MB keeping 5 generations, so an unattended
//     machine cannot fill its disk. See MAC-MINI-SETUP.md for the exact
//     command to read recent runs over SSH.
//
// Credentials are NOT this file's business: reconcile.mjs reads them through
// scripts/shopify/env.mjs (SHOPIFY_SHOP / SHOPIFY_CLIENT_ID /
// SHOPIFY_CLIENT_SECRET, from the environment or a git-ignored .env at the
// repo root) and firebase-admin picks up Application Default Credentials.
// Nothing here logs, echoes or copies a credential value.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  openSync, closeSync, writeSync, writeFileSync, readFileSync, unlinkSync,
  mkdirSync, statSync, renameSync, appendFileSync,
} from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const LOG_DIR = join(REPO, "logs");
const LOG_FILE = join(LOG_DIR, "shopify-reconcile.log");
const LOCK_FILE = join(LOG_DIR, "shopify-reconcile.lock");
const STATE_FILE = join(LOG_DIR, "shopify-reconcile.state.json");

// A run that has not finished in this long is treated as WEDGED: its lock is
// reclaimed and a banner says so. Sized well above a full cap-25 commit run
// (media polling dominates: ~15 polls × 2 s per product, plus throttle waits).
const STALE_LOCK_MS = 30 * 60 * 1000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_GENERATIONS = 5;

mkdirSync(LOG_DIR, { recursive: true });

// ── Logging ──────────────────────────────────────────────────────────────────
// Timestamps are South Africa time — the log is read by a person in that
// timezone, and a UTC stamp would have him doing arithmetic to answer "did it
// run since I pressed Publish?".
function stamp() {
  return new Date().toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// Rotate BEFORE writing, so the check runs on every line-batch and the file
// can never run away between ticks. Oldest generation is dropped.
function rotateIfNeeded() {
  let size = 0;
  try { size = statSync(LOG_FILE).size; } catch { return; }
  if (size < MAX_LOG_BYTES) return;
  try { unlinkSync(`${LOG_FILE}.${LOG_GENERATIONS}`); } catch { /* none yet */ }
  for (let i = LOG_GENERATIONS - 1; i >= 1; i--) {
    try { renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`); } catch { /* none yet */ }
  }
  try { renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* raced — next tick retries */ }
}

function log(line) {
  rotateIfNeeded();
  appendFileSync(LOG_FILE, `${stamp()}  ${line}\n`);
}

// ── Failure memory ───────────────────────────────────────────────────────────
// One failed tick is noise (a transient DNS blip); a run of them is an outage.
// The count rides a tiny state file so the banner can say WHICH it is.
function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { consecutiveFailures: 0 }; }
}
function writeState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    // Losing the counter costs the "N in a row" wording, nothing else — the
    // failure itself is already in the log.
    log(`⚠ could not write ${STATE_FILE}: ${String(e?.message || e)}`);
  }
}

// ── Single-flight lock ───────────────────────────────────────────────────────
// "wx" is an atomic create-or-fail: two processes racing here cannot both
// win. The pid inside is what lets a crashed run's lock be reclaimed — an
// empty or unparseable lock is treated as stale rather than deadlocking the
// schedule forever.
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

// What the lockfile holds: this runner, and (once spawned) the reconcile it
// is supervising. Either being alive means a run is in flight.
const lockOwners = { pid: process.pid, childPid: null, startedAt: Date.now() };

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      writeSync(fd, JSON.stringify(lockOwners));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      let held = null;
      try { held = JSON.parse(readFileSync(LOCK_FILE, "utf8")); } catch { /* unreadable ⇒ owner unknown */ }
      // A LIVE owner ALWAYS wins, however long it has been running. Age is a
      // reason to shout, never a reason to reclaim: a slow run is exactly what
      // this schedule exists to survive (25 products × preflight HEADs at a
      // 15 s timeout + media READY polling + throttle waits can genuinely
      // exceed the stale threshold), and starting a second reconciler against
      // the same product would make the first one's freshly-created product
      // look like a duplicate handle to the second — which BLOCKS the product
      // and consumes the intent. Overlap is the one thing this lock exists to
      // prevent (reviewer finding, 2026-08-14).
      //
      // BOTH pids are checked. If the runner is SIGKILLed its handlers never
      // run, so the reconcile it spawned keeps going as an orphan STILL
      // pushing to Shopify — a lock that only tracked the dead parent would be
      // reclaimed and the next tick would overlap that orphan.
      const owner = held?.pid && processAlive(held.pid) ? held.pid
        : held?.childPid && processAlive(held.childPid) ? held.childPid
        : null;
      if (owner) {
        const age = held.startedAt ? Date.now() - held.startedAt : null;
        if (age !== null && age > STALE_LOCK_MS) {
          log(`⚠ run pid ${owner} has been going ${Math.round(age / 60000)} min — still alive, so this tick stands down. ` +
              `If it is genuinely stuck, kill it: kill ${owner}`);
        }
        return false;
      }
      // Owner gone (crash, kill -9, power cut) — its lock is meaningless.
      log(`⚠ stale lock from pid ${held?.pid ?? "unknown"} (owner gone) — reclaiming`);
      try { unlinkSync(LOCK_FILE); } catch { /* another tick got there first */ }
    }
  }
  return false;
}

function releaseLock() {
  try {
    const held = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
    if (held?.pid !== process.pid) return; // reclaimed by someone else — not ours to remove
  } catch { /* unreadable — remove it anyway, we are the only known owner */ }
  try { unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

// ── The run ──────────────────────────────────────────────────────────────────
// Anything that throws out here (an unwritable logs/ — full disk, bad
// permissions) must still reach a human. It cannot reach the rotated log by
// definition, so it goes to stderr, which the plist captures in
// logs/launchd.err.log, and the exit code is non-zero so the failure is not
// mistaken for a quiet tick.
let child = null;
try {
  if (!acquireLock()) {
    log("tick skipped — a reconcile run is still in progress (single-flight)");
    process.exit(0);
  }
} catch (e) {
  console.error(`[shopify-reconcile] cannot take the run lock in ${LOG_DIR}: ${String(e?.message || e)}`);
  process.exit(1);
}

let released = false;
const release = () => { if (!released) { released = true; releaseLock(); } };
// A killed runner must not strand the lock — nor leave its child running
// unsupervised with the lock now free, which would let the next tick overlap
// it (reviewer finding, 2026-08-14). Kill the child FIRST, then release.
process.on("exit", release);
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!child || child.exitCode !== null) { release(); process.exit(130); }
    // Releasing the lock while the child is still alive would orphan a
    // reconcile that keeps pushing to Shopify unsupervised — and the next
    // tick, finding the lock free, would start a SECOND one. So: kill it,
    // wait for it to actually die, and only then let go of the lock.
    try { log(`⚠ runner received ${sig} — stopping the in-flight reconcile (pid ${child.pid}); the next tick resumes`); } catch { /* log unavailable */ }
    const finish = () => { release(); process.exit(130); };
    child.once("close", finish);
    try { child.kill("SIGTERM"); } catch { finish(); }
    // A child that ignores SIGTERM must not hold the schedule hostage.
    const force = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      finish();
    }, 10_000);
    force.unref?.();
  });
}

child = spawn(process.execPath, [join(HERE, "reconcile.mjs"), "--commit"], {
  cwd: REPO,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
// Record the child in the lock, so a tick that finds this runner dead can
// still see that the reconcile it started is alive and stand down.
lockOwners.childPid = child.pid;
try {
  writeFileSync(LOCK_FILE, JSON.stringify(lockOwners));
} catch (e) {
  log(`⚠ could not record the reconcile pid in the lock: ${String(e?.message || e)}`);
}

// ── Output handling: buffer only long enough to classify the tick ────────────
// An idle tick must stay ONE line (720 of them a day would otherwise bury the
// runs that matter), but a REAL run must stream — so `tail -f` shows it as it
// happens, and so a run killed mid-flight (reboot, launchctl unload) still
// leaves a record of how far it got instead of vanishing with the buffer
// (reviewer finding, 2026-08-14).
//
// reconcile.mjs announces the worklist size up front, so the first stdout
// chunk settles it. ANY stderr also settles it: that is where the
// pre-migration "run migrate-live-state.mjs first" warnings go, and a tick
// that skipped every node for that reason is not idle — it needs a human.
let live = false;      // streaming yet?
let buffered = "";     // pre-decision output
let sawStderr = false;
let carry = "";        // partial trailing line between chunks
// A bounded copy of everything the child said, kept only to classify the exit
// (did it reach its report, or die before it?). Capped so a pathological run
// cannot grow the runner's memory without bound.
let reportText = "";
const REPORT_KEEP = 64 * 1024;

const emitLines = (text) => {
  const parts = (carry + text).split("\n");
  carry = parts.pop() ?? "";
  for (const l of parts) if (l.trim() !== "") log(`   ${l.trimEnd()}`);
};

const goLive = () => {
  if (live) return;
  live = true;
  log("── run start ──");
  const pending = buffered;
  buffered = "";
  emitLines(pending);
};

const onChunk = (text, isErr) => {
  if (isErr) sawStderr = true;
  reportText += text;
  if (reportText.length > REPORT_KEEP) reportText = reportText.slice(-REPORT_KEEP);
  if (live) { emitLines(text); return; }
  buffered += text;
  // "nodes with unapplied intent: N" — N > 0 means there is real work.
  const m = buffered.match(/nodes with unapplied intent:\s*(\d+)/);
  if (isErr || (m && Number(m[1]) > 0)) goLive();
};

child.stdout.on("data", (b) => onChunk(b.toString(), false));
child.stderr.on("data", (b) => onChunk(b.toString(), true));

child.on("error", (e) => {
  log(`✗ FAILED to start reconcile.mjs: ${String(e?.message || e)}`);
  release();
  process.exit(1);
});

child.on("close", (code) => {
  const idle = !live && !sawStderr && code === 0 && /nothing to do\./.test(buffered);
  const state = readState();

  if (idle) {
    // The one-line quiet tick: proof the schedule is alive without burying the
    // runs that did something.
    log("tick — no unapplied intent");
    writeState({ consecutiveFailures: 0, lastOkAt: Date.now() });
    release();
    process.exit(0);
  }

  goLive();                       // a short/failed run may never have streamed
  if (carry.trim() !== "") log(`   ${carry.trimEnd()}`);
  carry = "";

  if (code === 0) {
    log("── run end: OK ──");
    writeState({ consecutiveFailures: 0, lastOkAt: Date.now() });
    release();
    process.exit(0);
  }

  // A non-zero exit means TWO very different things, and saying the wrong one
  // is worse than saying nothing (reviewer finding, 2026-08-14):
  //
  //   · the run COMPLETED and refused one or more products — the apply-time
  //     validator doing its job. reconcile.mjs prints its report and exits 1.
  //     Those products are now BLOCKED with a reason, and markBlocked has
  //     cleared their intent, so "intent stays unapplied, the next tick
  //     retries" would be a lie: they need a human in the app, and no amount
  //     of retrying will move them.
  //   · the run CRASHED or could not reach Shopify — it never got to a
  //     report. Nothing was consumed; the next tick genuinely does retry.
  //
  // The report banner is the discriminator: it is printed only after the loop
  // has run to completion.
  const completed = /══ RECONCILE REPORT ══/.test(reportText);
  if (completed) {
    const refused = (reportText.match(/^✗ /gm) || []).length;
    log(`── run end: completed, ${refused || "some"} product(s) REFUSED ──`);
    log(`   Refused products are marked blocked in the app with the reason above, and their`);
    log(`   publish intent is cleared — retrying changes nothing until the cause is fixed there.`);
    log(`   Everything else in this run was applied normally.`);
    // NOT an outage: the schedule is healthy, so the consecutive-failure
    // counter must not climb toward a false alarm.
    writeState({ consecutiveFailures: 0, lastOkAt: Date.now() });
  } else {
    const failures = (state.consecutiveFailures || 0) + 1;
    log(`✗✗ RUN FAILED (exit ${code}) — the run did not complete; Shopify was NOT updated.`);
    log(`   Intent stays unapplied; the next tick retries. Consecutive failures: ${failures}.`);
    if (failures >= 5) {
      log(`   ⚠⚠ ${failures} FAILED RUNS IN A ROW — this is an outage, not a blip. ` +
          `Check network/credentials on this machine before pressing Publish again.`);
    }
    writeState({ consecutiveFailures: failures, lastFailAt: Date.now() });
  }
  release();
  process.exit(1);
});
