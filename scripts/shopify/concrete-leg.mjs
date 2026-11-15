#!/usr/bin/env node
// ── The Concrete store's leg of one reconcile tick ───────────────────────────
// reconcile-runner.mjs runs this as its own child, under its own timeout,
// BEFORE Marathon's reconcile — and nothing it does or fails at changes
// Marathon's run: its exit code is logged, never counted as a Marathon failure.
//
//   1. credentials? (CONCRETE_SHOPIFY_CLIENT_ID / CONCRETE_SHOPIFY_CLIENT_SECRET
//      in the repo .env). Absent → print "concrete: credentials missing" and
//      exit 0. No Shopify call, no database write.
//   2. collections: the first time (no /shopify_sync_concrete/_collections),
//      recreate Marathon's storefront collections on Concrete
//      (ensure-collections.mjs --commit, idempotent).
//   3. orders-poll.mjs --commit   — Concrete website orders into the POS
//   4. reconcile.mjs --commit     — publish intents, stock, prices, media
//
// Every child runs with SHOPIFY_STORE=concrete; storeConfig.mjs binds the
// shop, credentials and node names to Concrete for that process only.
import "./env.mjs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { STORES, missingCredentials } from "./storeConfig.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const CONCRETE = STORES.concrete;

const missing = missingCredentials(CONCRETE);
if (missing.length) {
  console.log(`concrete: credentials missing (${missing.join(", ")}) — the Concrete leg is disabled; see docs/CONCRETE-STORE.md`);
  process.exit(0);
}

const env = { ...process.env, SHOPIFY_STORE: "concrete" };
const run = (script, args = []) => new Promise((res) => {
  const child = spawn(process.execPath, [join(HERE, script), ...args], { cwd: REPO, env, stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (e) => { console.log(`concrete: could not start ${script}: ${String(e?.message || e)}`); res(-1); });
  child.on("close", (c) => res(c));
});

let worst = 0;
try {
  const admin = createRequire(new URL("../../functions/package.json", import.meta.url))("firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  const have = (await admin.database().ref(`${CONCRETE.syncPath}/_collections`).get()).val();
  if (!have) {
    console.log("concrete: no collections recorded yet — recreating the storefront collections on Concrete");
    const c = await run("ensure-collections.mjs", ["--commit"]);
    if (c !== 0) { console.log(`concrete: ensure-collections exited ${c}`); worst = c; }
  }
  await admin.app().delete();
} catch (e) {
  console.log(`concrete: collections check failed (${String(e?.message || e)}) — carrying on`);
}

if (process.env.ONLINE_ORDERS_POLL !== "0") {
  const c = await run("orders-poll.mjs", ["--commit"]);
  if (c !== 0) { console.log(`concrete: orders poll exited ${c}`); worst = worst || c; }
}
const c = await run("reconcile.mjs", ["--commit"]);
if (c !== 0) { console.log(`concrete: reconcile exited ${c}`); worst = worst || c; }
process.exit(worst ? 1 : 0);
