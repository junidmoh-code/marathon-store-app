#!/usr/bin/env node
// ── The website-order agent on the Mac mini (Junid's brief, 14 Nov 2026) ─────
// Pushes every blocked ("red") website order toward "ready to pack" — see
// scripts/online/orderAgent/run.mjs for what it does and never does.
//
//   node scripts/online/order-agent.mjs            dry run: prints what it would do, writes nothing
//   node scripts/online/order-agent.mjs --commit   one real run (launchd: com.marathon.orderagent)
//   --force                                        run outside 08:00–18:30 SAST too
//
// launchd keeps it alive: KeepAlive + ThrottleInterval 900 → one run every 15 minutes; outside the run window a
// start exits at once. Kill switch: /config/onlineOrders/orderAgentOff === true → no run.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import "../shopify/env.mjs";
import { graphql } from "../shopify/client.mjs";
import { runOrderAgent } from "./orderAgent/run.mjs";
import { openChaseQueue } from "./orderAgent/chaseQueue.mjs";
import { makeHubPush } from "./orderAgent/push.mjs";
import { inRunWindow, hhmm } from "./orderAgent/hours.mjs";

const COMMIT = process.argv.includes("--commit");
const FORCE = process.argv.includes("--force");
const now = Date.now();

if (!FORCE && !inRunWindow(now)) {
  console.log(`[order-agent] ${new Date(now).toISOString()} outside 08:00–18:30 SAST — no run`);
  process.exit(0);
}

const fnRequire = createRequire(new URL("../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: "marathon-club", databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();

const off = (await db.ref("config/onlineOrders/orderAgentOff").get()).val() === true;
if (off) { console.log("[order-agent] switched off (/config/onlineOrders/orderAgentOff) — no run"); process.exit(0); }

const JIMMY_DB = join(homedir(), "marathon-dm-agent", "data", "agent.db");
const chase = existsSync(JIMMY_DB) ? await openChaseQueue(JIMMY_DB) : { available: false, insert: () => false, exists: () => false, todayCounts: () => null, close() {} };
if (!existsSync(JIMMY_DB)) console.log(`[order-agent] Jamie's database is not at ${JIMMY_DB} — hand-offs are skipped`);
const push = makeHubPush({ db, messaging: admin.messaging() });

// ONE run at a time: a manual run beside launchd must not double-nudge (a 10-minute lease in RTDB).
if (COMMIT) {
  const lease = await db.ref("online_order_agent/lock").transaction((cur) => (cur && Number(cur.at) > now - 10 * 60e3 ? undefined : { at: now, pid: process.pid }));
  if (!lease.committed) { console.log("[order-agent] another run holds the lock — no run"); process.exit(0); }
}
console.log(`[order-agent] ${new Date(now).toISOString()} (${hhmm(now)} SAST) ${COMMIT ? "COMMIT" : "dry run"}`);
try {
  const r = await runOrderAgent({ db, graphql, chase, push, now, commit: COMMIT, log: (m) => console.log(m) });
  console.log(`[order-agent] run ${r.runId}: ${r.checked} checked · ${r.green} green · ${r.red} red · ${r.incoming} incoming · ${r.actions.length} actions`);
  if (r.summary) console.log(`[order-agent] daily summary${COMMIT ? " queued for the Jamie app" : " (dry)"}:\n${r.summary}`);
  if (process.argv.includes("--json")) console.log(JSON.stringify(r.outcomes, null, 1));
} catch (e) {
  console.error(`[order-agent] run failed: ${e?.stack || e}`);
  process.exitCode = 1;
} finally {
  chase.close?.();
  if (COMMIT) await db.ref("online_order_agent/lock").set(null).catch(() => {});
}
process.exit(process.exitCode || 0);
