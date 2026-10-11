// ── The nightly stock-truth sweep's runner (Mac mini) ────────────────────────
// launchd (com.marathon.shopifystocksweep) starts this every 10 minutes with
// KeepAlive + ThrottleInterval — NOT StartCalendarInterval. On 2026-08-31
// launchd silently stopped firing every interval/calendar agent in the
// session at once and only the KeepAlive one survived (see the reconciler's
// plist), so a once-a-night job is built the same way: wake often, do nothing
// unless due, exit.
//
// DUE = it is 02:30 SAST or later and no sweep has completed today (SAST).
// 02:30 sits in the middle of the reconciler's idle night, so the two never
// compete for Shopify; a mini that was off at 02:30 sweeps as soon as it is
// back, and shopifyInventoryHealthScan emails Junid if no sweep reports for
// 26 hours.
//
// Single-flight by a lockfile naming the owning pid; a lock whose owner is
// gone is reclaimed. The sweep's own output is appended to
// logs/shopify-stock-sweep.log (rotated at 5 MB, 3 generations).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync, linkSync,
} from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const LOG_DIR = join(REPO, "logs");
const LOG_FILE = join(LOG_DIR, "shopify-stock-sweep.log");
const STATE_FILE = join(LOG_DIR, "shopify-stock-sweep.state.json");
const LOCK_FILE = join(LOG_DIR, "shopify-stock-sweep.lock");
export const DUE_MINUTE = 2 * 60 + 30;

/** Pure: should a sweep run now? */
export function sweepDue(nowMs, state = {}) {
  const d = new Date(nowMs + 2 * 3600e3);
  const date = d.toISOString().slice(0, 10);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { due: minute >= DUE_MINUTE && state.lastRunDate !== date, date };
}

function log(line) {
  try { if (statSync(LOG_FILE).size > 5 * 1024 * 1024) { try { renameSync(`${LOG_FILE}.2`, `${LOG_FILE}.3`); } catch {} try { renameSync(`${LOG_FILE}.1`, `${LOG_FILE}.2`); } catch {} renameSync(LOG_FILE, `${LOG_FILE}.1`); } } catch { /* no log yet */ }
  const ts = new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour12: false });
  appendFileSync(LOG_FILE, `${ts}  ${line}\n`);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };

function takeLock() {
  const tmp = `${LOCK_FILE}.${process.pid}`;
  writeFileSync(tmp, String(process.pid));
  try { linkSync(tmp, LOCK_FILE); return true; } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    const held = Number(readFileSync(LOCK_FILE, "utf8"));
    if (alive(held)) return false;
    renameSync(LOCK_FILE, `${LOCK_FILE}.stale.${process.pid}`);
    try { unlinkSync(`${LOCK_FILE}.stale.${process.pid}`); } catch {}
    try { linkSync(tmp, LOCK_FILE); return true; } catch { return false; }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  mkdirSync(LOG_DIR, { recursive: true });
  let state = {};
  try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { /* first run */ }
  const { due, date } = sweepDue(Date.now(), state);
  if (!due) process.exit(0);
  if (!takeLock()) process.exit(0);
  try {
    log(`── nightly stock-truth sweep for ${date} ──`);
    const r = spawnSync(process.execPath, [join(HERE, "stock-truth-sweep.mjs"), "--commit"], {
      cwd: REPO, env: process.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    });
    for (const l of `${r.stdout || ""}${r.stderr || ""}`.split("\n")) if (l.trim()) log(`   ${l}`);
    // Stamped whatever the exit code: a sweep that ran and REFUSED or could
    // not correct something has reported that at /shopify_inventory_health,
    // and the watchdog emails it. Re-running every 10 minutes would only
    // repeat it. A sweep that could not start at all (no exit code) retries.
    if (r.status !== null) writeFileSync(STATE_FILE, JSON.stringify({ ...state, lastRunDate: date, lastExit: r.status, lastRunAt: Date.now() }));
    log(`── sweep end: exit ${r.status ?? r.signal ?? r.error?.message} ──`);
  } finally {
    try { unlinkSync(LOCK_FILE); } catch {}
  }
}
