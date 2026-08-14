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

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      let held = null;
      try { held = JSON.parse(readFileSync(LOCK_FILE, "utf8")); } catch { /* unreadable ⇒ stale */ }
      const age = held?.startedAt ? Date.now() - held.startedAt : Infinity;
      if (held?.pid && processAlive(held.pid) && age < STALE_LOCK_MS) return false; // genuinely running
      log(held?.pid && processAlive(held.pid)
        ? `⚠ WEDGED: run pid ${held.pid} has held the lock ${Math.round(age / 60000)} min — reclaiming; check the log above for where it stopped`
        : `⚠ stale lock from pid ${held?.pid ?? "unknown"} (owner gone) — reclaiming`);
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
if (!acquireLock()) {
  log("tick skipped — a reconcile run is still in progress (single-flight)");
  process.exit(0);
}

let released = false;
const release = () => { if (!released) { released = true; releaseLock(); } };
// A killed runner must not strand the lock for STALE_LOCK_MS.
process.on("exit", release);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { release(); process.exit(130); });
}

const child = spawn(process.execPath, [join(HERE, "reconcile.mjs"), "--commit"], {
  cwd: REPO,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});

const out = [];
child.stdout.on("data", (b) => out.push(["out", b.toString()]));
child.stderr.on("data", (b) => out.push(["err", b.toString()]));

child.on("error", (e) => {
  log(`✗ FAILED to start reconcile.mjs: ${String(e?.message || e)}`);
  release();
  process.exit(1);
});

child.on("close", (code) => {
  const text = out.map(([, s]) => s).join("");
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  const idle = code === 0 && /nothing to do\./.test(text);
  const state = readState();

  if (idle) {
    // The one-line quiet tick: proof the schedule is alive without burying the
    // runs that did something.
    log("tick — no unapplied intent");
    writeState({ consecutiveFailures: 0, lastOkAt: Date.now() });
  } else if (code === 0) {
    log("── run start ──");
    for (const l of lines) log(`   ${l}`);
    log("── run end: OK ──");
    writeState({ consecutiveFailures: 0, lastOkAt: Date.now() });
  } else {
    const failures = (state.consecutiveFailures || 0) + 1;
    log(`── run start ──`);
    for (const l of lines) log(`   ${l}`);
    log(`✗✗ RUN FAILED (exit ${code}) — Shopify was NOT updated for at least one product.`);
    log(`   Intent stays unapplied; the next tick retries. Consecutive failures: ${failures}.`);
    if (failures >= 5) {
      log(`   ⚠⚠ ${failures} FAILED RUNS IN A ROW — this is an outage, not a blip. ` +
          `Check network/credentials on this machine before pressing Publish again.`);
    }
    writeState({ consecutiveFailures: failures, lastFailAt: Date.now() });
  }
  release();
  process.exit(code === 0 ? 0 : 1);
});
