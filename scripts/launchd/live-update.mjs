#!/usr/bin/env node
// ── Merged code reaches the Mac mini by itself ───────────────────────────────
// Until this existed there was NO mechanism: ~/marathon-store-app moved only
// when a person (or a session) ran `git pull` / `git checkout origin/main` in
// it by hand — 122 times in its reflog, at whatever moment someone remembered.
// MAC-MINI-SETUP.md records it found nine merged PRs behind on 3 Sep 2026, and
// on 11 Nov 2026 it was two behind again. A fix that is merged and not running
// is not a fix.
//
// One run (launchd, every 5 minutes — com.marathon.liveupdate.plist):
//   1. `git fetch origin main`. Already there → exit, one line an hour.
//   2. REFUSE (and say so) unless this is a plain fast-forward of a checkout
//      nobody has edited: never backwards, never over a person's work
//      (liveUpdatePlan.mjs — every branch tested).
//   3. TAKE THE RECONCILER'S OWN RUN LOCK (logs/shopify-reconcile.lock, the
//      same link()-into-place protocol as reconcile-runner.mjs). A tick in
//      flight → wait for the next run; while we hold it, a tick that fires
//      stands down exactly as it does for a slow run. So no orders poll and no
//      reconcile ever runs half on the old code and half on the new, or
//      against a half-installed node_modules.
//   4. `git checkout --detach origin/main` (how this checkout has been moved
//      since 7 Nov), `npm ci` only in a tree whose lockfile changed, then
//      `node --check` every changed script.
//   5. ANY failure → back to the commit it was on (and its node_modules), the
//      failure in the log and on stderr (logs/live-update.err.log), exit 1.
//      The target is remembered as bad and not tried again until main moves.
//   6. Restart the one long-lived service if code it loads changed. Every
//      other job runs a tick and exits, so its next tick is already new code.
//
// It runs FROM the checkout it updates; a run is one short process, so it is
// always the previous version that installs the next. --dry-run prints the
// plan and changes nothing.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { appendFileSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { planLiveUpdate } from "./liveUpdatePlan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const LOG_DIR = join(REPO, "logs");
const LOG_FILE = join(LOG_DIR, "live-update.log");
const STATE_FILE = join(LOG_DIR, "live-update.state.json");
const LOCK_FILE = join(LOG_DIR, "shopify-reconcile.lock");
const DRY = process.argv.includes("--dry-run");

mkdirSync(LOG_DIR, { recursive: true });
const stamp = () => new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour12: false });
const log = (line) => { appendFileSync(LOG_FILE, `${stamp()}  ${line}\n`); if (DRY) console.log(line); };
const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const readState = () => { try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; } };
const writeState = (patch) => { try { writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch })); } catch { /* the log has it */ } };

function takeLock() {
  const tmp = `${LOCK_FILE}.new.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, childPid: null, startedAt: Date.now(), by: "live-update" }));
  try { linkSync(tmp, LOCK_FILE); return true; }
  catch (e) { if (e?.code === "EEXIST") return false; throw e; }
  finally { try { unlinkSync(tmp); } catch { /* linked or never made */ } }
}
function releaseLock() {
  try { if (JSON.parse(readFileSync(LOCK_FILE, "utf8"))?.pid !== process.pid) return; } catch { return; }
  try { unlinkSync(LOCK_FILE); } catch { /* gone */ }
}

let head = "";
try {
  git("fetch", "--quiet", "origin", "main");
  head = git("rev-parse", "HEAD");
  const target = git("rev-parse", "origin/main");
  let descends = false;
  try { git("merge-base", "--is-ancestor", head, target); descends = true; } catch { descends = false; }
  const plan = planLiveUpdate({
    head, target, targetDescendsFromHead: descends,
    // Unstaged edits, and staged changes to files main already has. A file
    // only ADDED here (untracked or staged-new) is not an edit of live code.
    trackedEdits: [...new Set([...lines(git("diff", "--name-only")), ...lines(git("diff", "--cached", "--name-only", "--diff-filter=MDRT"))])],
    changedFiles: head === target ? [] : lines(git("diff", "--name-only", head, target)),
  });
  const state = readState();
  if (plan.action === "none") {
    const hour = new Date().toISOString().slice(0, 13);
    if (state.lastIdleLog !== hour) { log(`up to date at ${head.slice(0, 8)}`); writeState({ lastIdleLog: hour }); }
    process.exit(0);
  }
  if (plan.action === "refuse") {
    if (state.lastRefusal !== `${head}:${target}:${plan.why}`) { log(`✗ NOT UPDATED — ${plan.why}`); writeState({ lastRefusal: `${head}:${target}:${plan.why}` }); }
    process.exit(0);
  }
  if (state.badTarget === target) process.exit(0); // already tried, already rolled back, already said so
  if (DRY) { log(`DRY RUN — would move ${head.slice(0, 8)} → ${target.slice(0, 8)}: ${plan.why}; npm ci in [${plan.npmCi.join(", ")}]; restart [${plan.restart.join(", ")}]; parse ${plan.check.length} file(s)`); process.exit(0); }
  if (!takeLock()) process.exit(0); // a tick is running — five minutes is soon enough

  let moved = false;
  try {
    git("checkout", "--quiet", "--detach", target);
    moved = true;
    for (const dir of plan.npmCi) execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: join(REPO, dir), stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60_000 });
    for (const file of plan.check) {
      // A file this update DELETED is not there to parse.
      try { readFileSync(join(REPO, file)); } catch { continue; }
      execFileSync(process.execPath, ["--check", join(REPO, file)], { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    }
    log(`✓ updated ${head.slice(0, 8)} → ${target.slice(0, 8)} (${plan.why}${plan.npmCi.length ? `; npm ci: ${plan.npmCi.join(", ")}` : ""})`);
    writeState({ at: Date.now(), from: head, to: target, badTarget: null, lastRefusal: null });
  } catch (e) {
    const why = String(e?.stderr || e?.message || e).trim().split("\n").slice(-3).join(" | ").slice(0, 600);
    log(`✗✗ UPDATE TO ${target.slice(0, 8)} FAILED — ${why}`);
    if (moved) {
      try {
        git("checkout", "--quiet", "--detach", head);
        for (const dir of plan.npmCi) execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: join(REPO, dir), stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60_000 });
        log(`   rolled back to ${head.slice(0, 8)} — the services keep running what they ran before`);
      } catch (e2) {
        log(`   ‼ ROLLBACK FAILED TOO (${String(e2?.message || e2).slice(0, 300)}) — this checkout needs a person NOW`);
      }
    }
    writeState({ badTarget: target, failedAt: Date.now() });
    console.error(`[live-update] update to ${target} failed: ${why}`);
    process.exitCode = 1;
    plan.restart.length = 0;
  } finally {
    releaseLock();
  }
  for (const label of plan.restart) {
    try {
      execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${label}`], { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      log(`   restarted ${label} (it stays up between ticks, so it was still on the old code)`);
    } catch (e) {
      log(`   ⚠ could not restart ${label} (${String(e?.message || e).slice(0, 200)}) — it keeps running the old code until it is restarted`);
    }
  }
} catch (e) {
  // fetch failed (network), git missing, logs/ unwritable: the next run retries.
  const why = String(e?.stderr || e?.message || e).trim().split("\n").slice(-2).join(" | ").slice(0, 400);
  try { log(`⚠ could not check for an update (${why}) — retried in five minutes`); } catch { /* logs/ unwritable */ }
  console.error(`[live-update] ${why}`);
  process.exit(1);
}
