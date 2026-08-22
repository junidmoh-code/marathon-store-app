// ── A SUPERVISED, SINGLE-FLIGHT LAUNCHD TICK ─────────────────────────────────
// The scheduling machinery scripts/shopify/reconcile-runner.mjs earned the hard
// way, generalised so a second scheduled job does not have to earn it again:
// a pid-carrying lockfile, rotated timestamped logs, loud failures, and a
// consecutive-failure counter that tells an outage apart from a quiet night.
//
// Every non-obvious decision below is copied deliberately from that file,
// along with the reason it is that way. They are not stylistic:
//
//   THE LOCK IS CREATED ALREADY POPULATED, by link()ing a fully-written temp
//     file into place. An open-then-write is two steps, and a tick reading in
//     between finds an empty file, calls the lock stale and steals it while
//     the writer still believes it holds it — and both run.
//
//   A LIVE OWNER ALWAYS WINS, however long it has been running. Age is a
//     reason to shout, never a reason to reclaim. Overlap is the one thing the
//     lock exists to prevent.
//
//   BOTH PIDS ARE CHECKED — the runner and the child it spawned. If the runner
//     is SIGKILLed its handlers never run and the child carries on as an
//     orphan still talking to a live API; a lock that tracked only the dead
//     parent would be reclaimed and the next tick would overlap that orphan.
//
//   A STALE LOCK IS STOLEN BY RENAME, not unlink. unlink is check-then-act, so
//     two ticks both judging the same lock stale would both delete and both
//     create. rename() is atomic: exactly one racer wins.
//
//   AN UNREADABLE LOCK IS NOT PROOF OF A DEAD OWNER — it may be a holder
//     mid-rewrite. Re-read once before believing it.
//
//   THE exit HANDLER IS REGISTERED AFTER THE LOCK IS TAKEN. A tick that did
//     NOT get the lock exits before the handler exists, so it can never
//     release a lock a different run is holding.
//
// This module is NOT wired into reconcile-runner.mjs. That file is live,
// reviewed and working; swapping its internals out to prove a point about
// reuse would risk the Shopify pipeline to tidy up a duplicate. Adopting it
// there is a separate, testable change for a day when nothing else is moving.
import { spawn } from "node:child_process";
import {
  writeFileSync, readFileSync, unlinkSync, linkSync,
  mkdirSync, statSync, renameSync, appendFileSync,
} from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_GENERATIONS = 5;

/** SAST — the log is read by a person in that timezone. */
function stamp() {
  return new Date().toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

/**
 * Run one supervised tick.
 *
 * @param name        short slug — names the log, lock and state files
 * @param logDir      where those live (the repo's logs/)
 * @param script      absolute path of the program to run
 * @param args        its arguments
 * @param cwd         working directory for the child
 * @param staleLockMs how long a run may go before the log SAYS SO on every
 *                    tick. Not a reclaim threshold — a live run is never
 *                    interrupted, however slow.
 * @param idleWhen    (line) => true when this line proves the tick had nothing
 *                    to do. Until the tick is classified, output is buffered so
 *                    an idle run stays one line; once it is classified as real
 *                    work, output STREAMS — so `tail -f` shows it live and a
 *                    run killed mid-flight still leaves a record of how far it
 *                    got instead of vanishing with the buffer.
 * @param busyWhen    (line) => true when this line proves there IS work.
 */
export async function runTick({
  name, logDir, script, args = [], cwd,
  staleLockMs = 30 * 60 * 1000,
  // A HARD ceiling on the child. Without one, a run hung on a call with no
  // timeout of its own (firebase-admin retries indefinitely) holds the lock
  // until someone notices — which on a three-times-a-week cadence could be
  // days. Killed, the tick fails loudly and the next one runs.
  maxRunMs = 60 * 60 * 1000,
  busyWhen = () => true,
  idleLine = null,
}) {
  const LOG_FILE = join(logDir, `${name}.log`);
  const LOCK_FILE = join(logDir, `${name}.lock`);
  const STATE_FILE = join(logDir, `${name}.state.json`);
  mkdirSync(logDir, { recursive: true });

  // Rotate BEFORE writing, so the check runs on every line-batch and the file
  // can never run away between ticks.
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
  const log = (line) => { rotateIfNeeded(); appendFileSync(LOG_FILE, `${stamp()}  ${line}\n`); };

  const readState = () => {
    try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { consecutiveFailures: 0 }; }
  };
  const writeState = (s) => {
    try { writeFileSync(STATE_FILE, JSON.stringify(s)); }
    catch (e) { log(`⚠ could not write ${STATE_FILE}: ${String(e?.message || e)}`); }
  };

  const lockOwners = { pid: process.pid, childPid: null, startedAt: Date.now() };

  function writeLockAtomically() {
    const tmp = `${LOCK_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(lockOwners));
    renameSync(tmp, LOCK_FILE);   // a reader sees the old lock or the new one, never half
  }

  function acquireLock() {
    // Three rounds, not two. The old bound could STEAL a stale lock on the
    // final round and then fall out of the loop returning false — the tick
    // stood down having just cleared the way for nobody. On a Mon/Wed/Sat
    // cadence that is a post lost until the next slot. Still absolutely
    // bounded; a contended lock resolves in one extra round.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tmp = `${LOCK_FILE}.new.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(lockOwners));
        try { linkSync(tmp, LOCK_FILE); } finally { try { unlinkSync(tmp); } catch { /* linked or never created */ } }
        return true;
      } catch (e) {
        if (e?.code !== "EEXIST") throw e;
        let held = null;
        try { held = JSON.parse(readFileSync(LOCK_FILE, "utf8")); } catch { /* mid-rewrite? */ }
        if (held === null) { try { held = JSON.parse(readFileSync(LOCK_FILE, "utf8")); } catch { /* genuinely corrupt */ } }
        const owner = held?.pid && processAlive(held.pid) ? held.pid
          : held?.childPid && processAlive(held.childPid) ? held.childPid
          : null;
        if (owner) {
          const age = held.startedAt ? Date.now() - held.startedAt : null;
          // ── A LIVE OWNER ALWAYS WINS. NO EXCEPTIONS, INCLUDING AGE ───────
          // An earlier version stole the lock from a pid it had just confirmed
          // was ALIVE, once the lock passed an "impossible age", on the premise
          // that the child is time-bounded. The child is not time-bounded by
          // anything except maxRunMs below — and before that existed, a run
          // hung on an RTDB call would have had its lock stolen and a second
          // publisher started alongside it. That is the one outcome this lock
          // exists to prevent, so age is a reason to SHOUT and never to steal.
          //
          // The pid-reuse case that motivated the exception is handled properly
          // instead: maxRunMs kills a hung child, so a lock naming a live pid
          // that is genuinely ours cannot outlive it by hours.
          if (age !== null && age > staleLockMs) {
            log(`⚠ run pid ${owner} has been going ${Math.round(age / 60000)} min — still alive, so this tick stands down. If it is genuinely stuck: kill ${owner}`);
          }
          return false;
        }
        const stolen = `${LOCK_FILE}.stale.${process.pid}`;
        try { renameSync(LOCK_FILE, stolen); } catch { continue; }
        log(`⚠ stale lock from pid ${held?.pid ?? "unknown"} (owner gone) — reclaimed`);
        try { unlinkSync(stolen); } catch { /* nothing to clean */ }
      }
    }
    return false;
  }

  function releaseLock() {
    // ── ONLY EVER REMOVE A LOCK WE CAN SEE IS OURS ───────────────────────────
    // The earlier version treated an unreadable or absent lock as "ours" and
    // unlinked whatever was at the path — the exact inverse of this file's own
    // rule that an unreadable lock is not proof of anything. If that landed in
    // the window between another tick's steal-rename and its linkSync, it
    // deleted the NEW holder's lock and the following tick overlapped a live
    // run. Re-read once (a holder rewriting its lock is atomic, so a second
    // failure means it really is unreadable), and on any doubt leave it: a
    // stale lock is reclaimed by the next tick, an over-eager delete is not
    // recoverable.
    let held = null;
    try { held = JSON.parse(readFileSync(LOCK_FILE, "utf8")); }
    catch { try { held = JSON.parse(readFileSync(LOCK_FILE, "utf8")); } catch { held = null; } }
    if (!held || held.pid !== process.pid) return;
    try { unlinkSync(LOCK_FILE); } catch { /* already gone */ }
  }

  let child = null;
  try {
    if (!acquireLock()) {
      log("tick skipped — a run is still in progress (single-flight)");
      return 0;
    }
  } catch (e) {
    // Cannot reach the rotated log by definition — stderr, which the plist
    // captures, and a non-zero exit so it is not mistaken for a quiet tick.
    console.error(`[${name}] cannot take the run lock in ${logDir}: ${String(e?.message || e)}`);
    return 1;
  }

  let released = false;
  const release = () => { if (!released) { released = true; releaseLock(); } };

  // POSITION IS LOAD-BEARING — below the acquire block. See the header.
  process.on("exit", () => {
    if (child && child.exitCode === null) {
      // SIGKILL is a request, not a receipt, and an exit listener may not go
      // async — so the child may still be mid-syscall. DO NOT release: the
      // lock names the child, and the next tick decides properly.
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      return;
    }
    release();
  });

  let shuttingDown = false;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;   // a deliberate stop must not be logged as a crash
      if (!child || child.exitCode !== null) { release(); process.exit(130); }
      try { log(`⚠ runner received ${sig} — stopping the in-flight run (pid ${child.pid}); the next tick resumes`); } catch { /* log unavailable */ }
      try { child.kill("SIGTERM"); } catch { release(); process.exit(130); }
      const force = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } process.exit(130); }, 10_000);
      force.unref?.();
    });
  }

  child = spawn(process.execPath, [script, ...args], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  lockOwners.childPid = child.pid;
  try {
    writeLockAtomically();
  } catch (e) {
    // An UNRECORDED child is an untrackable run: if this runner then died, the
    // next tick would see only a dead runner pid and start a second one. A run
    // we cannot guarantee is single-flight is a run we do not take.
    log(`✗ could not record the child pid in the lock (${String(e?.message || e)}) — stopping this run; the next tick retries`);
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    return 1;
  }

  // Buffer only long enough to classify the tick, then stream.
  let live = false, buffered = "";
  const streams = { out: { emitCarry: "" }, err: { emitCarry: "" } };
  const emitLines = (s, text) => {
    const parts = (s.emitCarry + text).split("\n");
    s.emitCarry = parts.pop() ?? "";
    for (const l of parts) if (l.trim() !== "") log(`   ${l.trimEnd()}`);
  };
  const goLive = () => {
    if (live) return;
    live = true;
    log("── run start ──");
    const pending = buffered;
    buffered = "";
    emitLines(streams.out, pending);
  };
  const onChunk = (text, isErr) => {
    const s = isErr ? streams.err : streams.out;
    if (live) { emitLines(s, text); return; }
    buffered += text;
    // ANY stderr settles it: a tick that wrote to stderr is not idle.
    if (isErr || busyWhen(buffered)) goLive();
  };
  child.stdout.on("data", (b) => onChunk(b.toString(), false));
  child.stderr.on("data", (b) => onChunk(b.toString(), true));

  let killedForTime = false;
  const killTimer = setTimeout(() => {
    killedForTime = true;
    log(`✗✗ run exceeded ${Math.round(maxRunMs / 60000)} min — killing it. A hung run must not hold the schedule.`);
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 10_000).unref?.();
  }, maxRunMs);
  killTimer.unref?.();

  const code = await new Promise((resolve) => {
    child.on("close", (c) => resolve(killedForTime ? 1 : (c ?? 1)));
    child.on("error", (e) => { log(`✗ could not start ${script}: ${String(e?.message || e)}`); resolve(1); });
  });
  clearTimeout(killTimer);

  // Flush partial lines held at end of run.
  for (const s of Object.values(streams)) {
    if (s.emitCarry.trim() !== "") log(`   ${s.emitCarry.trimEnd()}`);
    s.emitCarry = "";
  }

  const state = readState();
  if (shuttingDown) {
    log("run stopped by a signal — not counted as a failure");
    release();
    return 130;
  }
  if (code === 0) {
    if (state.consecutiveFailures) log(`recovered after ${state.consecutiveFailures} failed tick(s)`);
    writeState({ consecutiveFailures: 0, lastOkAt: Date.now() });
    if (!live) log(idleLine || "tick: nothing to do");
    else log("── run complete ──");
  } else {
    const n = Number(state.consecutiveFailures || 0) + 1;
    writeState({ ...state, consecutiveFailures: n, lastFailAt: Date.now() });
    goLive();   // a failed tick is never a one-liner
    log(`✗✗ RUN FAILED (exit ${code})${n > 1 ? ` — ${n} ticks in a row. This is an outage, not a blip.` : ""}`);
  }
  release();
  return code;
}
