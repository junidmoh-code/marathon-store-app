#!/usr/bin/env node
// ── The Concrete store's leg of a reconcile tick ─────────────────────────────
// Started DETACHED by reconcile-runner.mjs and never awaited by it: nothing
// here can delay, block or fail Marathon's tick (architect review, PR #911).
//
//   1. credentials? (CONCRETE_SHOPIFY_CLIENT_ID / CONCRETE_SHOPIFY_CLIENT_SECRET
//      in the repo .env). Absent → "concrete: credentials missing", exit 0.
//   2. single-flight: logs/concrete-leg.lock (pid inside; a dead owner's lock
//      is reclaimed). A tick that finds a live leg simply exits.
//   3. collections: the first time (no /shopify_sync_concrete/_collections),
//      recreate Marathon's storefront collections on Concrete
//      (ensure-collections.mjs --commit, idempotent).
//   4. orders-poll.mjs --commit   — Concrete website orders into the POS
//   5. reconcile.mjs --commit     — publish intents, stock, prices, media
//
// Every child runs with SHOPIFY_STORE=concrete, has its OWN timeout, writes
// to logs/concrete-reconcile.log, and is killed if this process is stopped.
import "./env.mjs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, linkSync, renameSync } from "node:fs";
import { STORES, missingCredentials } from "./storeConfig.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const LOG_DIR = join(REPO, "logs");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, "concrete-reconcile.log");
const LOCK_FILE = join(LOG_DIR, "concrete-leg.lock");
const CONCRETE = STORES.concrete;
const TIMEOUTS = { "ensure-collections.mjs": 5 * 60e3, "orders-poll.mjs": 3 * 60e3, "reconcile.mjs": 20 * 60e3 };

const stamp = () => new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour12: false });
const log = (line) => { try { appendFileSync(LOG_FILE, `${stamp()}  ${line}\n`); } catch { /* nowhere else to say it */ } };

const missing = missingCredentials(CONCRETE);
if (missing.length) {
  console.log(`concrete: credentials missing (${missing.join(", ")}) — the Concrete leg is disabled; see docs/CONCRETE-STORE.md`);
  process.exit(0);
}

// ── Single flight ────────────────────────────────────────────────────────────
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
function acquire() {
  const tmp = `${LOCK_FILE}.${process.pid}`;
  writeFileSync(tmp, String(process.pid));
  try {
    for (let i = 0; i < 2; i++) {
      try { linkSync(tmp, LOCK_FILE); return true; } catch {
        const owner = Number(readFileSync(LOCK_FILE, "utf8")) || 0;
        if (owner && alive(owner)) return false;
        // Reclaim a dead owner's lock WITHOUT ever deleting a replacement:
        // move it aside first, then check what was moved. If another tick had
        // already replaced it, put theirs back and stand down (CodeRabbit, #911).
        const aside = `${LOCK_FILE}.stale.${process.pid}`;
        try { renameSync(LOCK_FILE, aside); } catch { continue; }
        const moved = Number(readFileSync(aside, "utf8")) || 0;
        if (moved !== owner) { try { linkSync(aside, LOCK_FILE); } catch { /* someone holds it */ } try { unlinkSync(aside); } catch { /* gone */ } return false; }
        try { unlinkSync(aside); } catch { /* gone */ }
      }
    }
    return false;
  } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
}
if (!acquire()) process.exit(0);
const release = () => { try { if (Number(readFileSync(LOCK_FILE, "utf8")) === process.pid) unlinkSync(LOCK_FILE); } catch { /* gone */ } };

let current = null;
const stop = (sig) => { if (current) { try { current.kill("SIGKILL"); } catch { /* gone */ } } log(`── stopped (${sig})`); release(); process.exit(130); };
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("exit", release);

const env = { ...process.env, SHOPIFY_STORE: "concrete" };
const run = (script, args = []) => new Promise((done) => {
  const child = spawn(process.execPath, [join(HERE, script), ...args], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  current = child;
  let carry = "";
  const take = (chunk) => {
    const parts = (carry + chunk.toString()).split("\n");
    carry = parts.pop() ?? "";
    for (const l of parts) if (l.trim()) log(`   [${script}] ${l.trimEnd()}`);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const timer = setTimeout(() => { log(`✗ ${script} still running after ${TIMEOUTS[script] / 60e3} min — stopped`); try { child.kill("SIGKILL"); } catch { /* gone */ } }, TIMEOUTS[script] || 10 * 60e3);
  child.on("error", (e) => { clearTimeout(timer); log(`✗ could not start ${script}: ${String(e?.message || e)}`); current = null; done(-1); });
  // `exit`, not `close`: a grandchild holding the pipe must not stall the leg.
  child.on("exit", (c) => { clearTimeout(timer); if (carry.trim()) log(`   [${script}] ${carry.trimEnd()}`); current = null; done(c ?? -1); });
});

log("── concrete leg start");
let worst = 0;
try {
  const admin = createRequire(new URL("../../functions/package.json", import.meta.url))("firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const have = (await admin.database().ref(`${CONCRETE.syncPath}/_collections`).get()).val();
  await admin.app().delete();
  if (!have) {
    log("no collections recorded yet — recreating the storefront collections on Concrete");
    const c = await run("ensure-collections.mjs", ["--commit"]);
    if (c !== 0) { log(`ensure-collections exited ${c}`); worst = c; }
  }
} catch (e) {
  log(`collections check failed (${String(e?.message || e)}) — carrying on`);
}
if (process.env.ONLINE_ORDERS_POLL !== "0") {
  const c = await run("orders-poll.mjs", ["--commit"]);
  if (c !== 0) { log(`orders poll exited ${c}`); worst = worst || c; }
}
const c = await run("reconcile.mjs", ["--commit"]);
if (c !== 0) { log(`reconcile exited ${c}`); worst = worst || c; }
log(`── concrete leg end: ${worst ? "FAILED (see above)" : "OK"}`);
process.exit(worst ? 1 : 0);
