// ─── COMMIT 6 — THE WITHDRAWAL, PREDICTED AND PROVED (READ-ONLY BY DEFAULT) ────
//
// THE WITHDRAWAL NEEDS NO WRITES, AND THAT IS THE POINT.
//
// The engine already knows how to retract its own asks. When resolveTarget stops
// resolving for an open engine line, `needGone` fires (refill-engine.cjs:853) and
// the close is stamped `cancelReason: "no_longer_needed"` (:878) — request
// cancelled, order deleted, lock dropped. That is the ONLY safe way to clear these
// lines: a cancel with NO cancelReason is read as a human "no" (:1276, :892-894),
// which sets a 24h cooldown AND a shop-level denial keyed on (pid|size) that is
// SHARED between marathon-pe and trophy. Clearing these lines by hand would poison
// Trophy's own demand for the same products.
//
// So this script does not withdraw anything. It PREDICTS what the engine will
// withdraw on its first scan after the rules are published and the backfill runs,
// by calling the REAL computeRefillPlan against live state with the index the
// backfill is about to write — and then proves the safety property that matters:
//
//   EVERY close carries a cancelReason, and NOT ONE is a human reject.
//
// It also separates the lines the engine will NOT touch. Those are the owner's:
// a human-placed request is a human decision, and the engine has no business
// reversing it. For anything in that set that should still be stopped, the script
// stages explicit `target: 0` rows — "deliberately excluded" — which is the
// documented off switch and leaves a permanent, readable record on the row.
//
// Resolve by pid, never by name.
//
// Usage:
//   node scripts/withdraw-plan-provenance.mjs                    # predict + prove
//   node scripts/withdraw-plan-provenance.mjs --stage-zero-rows  # print the payload
//   LEDGER_DIR=/path node scripts/withdraw-plan-provenance.mjs   # use a ledger cache
//   WITHDRAW_MD=~/report.md node scripts/withdraw-plan-provenance.mjs
//
// There is no --execute. Nothing here writes.

import { createRequire } from "module";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { homedir } from "os";
import { foldProvenance, carriesByProvenance } from "../src/components/stock/provenanceClass.js";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const engine = require("../functions/lib/refill-engine.cjs");
const idx = require("../functions/lib/provenance-index.cjs");

const STAGE_ZERO = process.argv.includes("--stage-zero-rows");
const DIR = process.env.LEDGER_DIR || null;
const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

const admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

async function readPaged(path, pageSize = 3000) {
  const acc = {}; let lastKey = null;
  for (;;) {
    let q = db.ref(path).orderByKey().limitToFirst(pageSize + (lastKey ? 1 : 0));
    if (lastKey) q = q.startAt(lastKey);
    const snap = await q.once("value");
    const keys = []; snap.forEach((c) => { keys.push(c.key); });   // braces load-bearing
    let added = 0;
    for (const k of keys) { if (k === lastKey) continue; acc[k] = snap.child(k).val(); added += 1; }
    if (added === 0) break;
    lastKey = keys[keys.length - 1];
    if (added < pageSize) break;
  }
  return acc;
}

// LIVE state for everything the plan depends on. The ledger may come from a cache
// (it is only used to derive the predicted index), but nothing else may: predicting
// a withdrawal from stale locks or stale orders would name the wrong lines.
const [targets, products, openIndex, refillRequests, orders, targetDecisions] = await Promise.all([
  db.ref("stock_targets").once("value").then((s) => s.val() || {}),
  readPaged("/products"),
  db.ref("refill_engine/open").once("value").then((s) => s.val() || {}),
  readPaged("/refill_requests"),
  readPaged("/orders"),
  db.ref("stock_targets_decisions").once("value").then((s) => s.val() || {}),
]);
const config = (await db.ref("config/refillEngine").once("value")).val() || {};
const stock = (await db.ref("stock").once("value")).val() || {};
const heldLines = (await db.ref("settings/stockHold/held").once("value")).val() || {};
const rejectStreak = (await db.ref("refill_engine/rejectStreak").once("value")).val() || {};
const retryState = (await db.ref("refill_engine/retryState").once("value")).val() || {};

let movements;
if (DIR && existsSync(`${DIR}/movements.json`)) {
  movements = Object.values(JSON.parse(readFileSync(`${DIR}/movements.json`, "utf8"))).filter(Boolean);
  say(`_ledger from cache ${DIR} (used only to derive the predicted index)_`);
} else {
  movements = Object.values(await readPaged("/stock_movements")).filter(Boolean);
  say(`_ledger read live_`);
}

const nowMs = Date.now();
const locs = [...new Set([...Object.keys(config.routes || {}), ...Object.values(config.routes || {})])];
const dests = Object.keys(config.routes || {});

// ── the index the backfill is about to write ─────────────────────────────────
// Derived here with the same fold the backfill uses, so this prediction is against
// the picture the engine will actually hold — not an approximation of it.
const prov = foldProvenance(movements);
const provenance = {}, provenanceMeta = {};
for (const [key, e] of prov.entries()) {
  const [loc, pid] = key.split("|");
  if (!locs.includes(loc)) continue;
  const rec = idx.toRecord(e);
  if (!Object.keys(rec).length) continue;
  (provenance[loc] ||= {})[pid] = rec;
}
for (const loc of locs) {
  provenanceMeta[loc] = { at: new Date(nowMs).toISOString(), pairs: Object.keys(provenance[loc] || {}).length, version: idx.INDEX_VERSION };
}

// The 45-day window the live scan uses, so the plan sees the same movement slice.
const MOVEMENT_WINDOW_DAYS = Math.max(45, (Number(config.confirmedOutDays) || 14) + 1);
const windowStart = new Date(nowMs - MOVEMENT_WINDOW_DAYS * 864e5).toISOString();
const windowed = movements.filter((m) => String(m.ts || m.appliedAt || "") >= windowStart);

const snapshot = {
  nowMs, config, targets, stock, products, openIndex, refillRequests, orders,
  movements: windowed, targetDecisions, rejectStreak, retryState, heldLines,
  provenance, provenanceMeta,
};

const after = engine.computeRefillPlan(snapshot);

// The BEFORE plan, to isolate what this change causes from what the engine was going
// to do anyway (a sold-out source, a target already met — closes with nothing to do
// with the fix).
//
// The old predicate is reproduced EXACTLY by feeding the new code an index built from
// cell existence: one stocked unit for every (loc, pid) that has a cell, plus a ready
// sentinel everywhere. storeCarries then answers true precisely where
// `!!stock[loc][pid] && Object.keys(...).length > 0` used to, so `before` is the
// genuine pre-fix plan rather than an approximation of it — and it is produced by the
// same engine build, so the two columns differ only in the input under test.
const cellExistenceIndex = {};
for (const loc of locs) {
  const byPid = stock?.[loc] || {};
  for (const pid of Object.keys(byPid)) {
    if (byPid[pid] && Object.keys(byPid[pid]).length > 0) (cellExistenceIndex[loc] ||= {})[pid] = { k: 1 };
  }
}
const before = engine.computeRefillPlan({
  ...snapshot,
  provenance: cellExistenceIndex,
  provenanceMeta: Object.fromEntries(locs.map((l) => [l, { at: new Date(nowMs).toISOString(), pairs: Object.keys(cellExistenceIndex[l] || {}).length, version: idx.INDEX_VERSION }])),
});

if (process.env.WITHDRAW_DEBUG) {
  console.error("BEFORE policy:", JSON.stringify(before.policy));
  console.error("BEFORE errors:", JSON.stringify(before.errors));
  console.error("AFTER  policy:", JSON.stringify(after.policy));
  console.error("AFTER  errors:", JSON.stringify(after.errors));
  console.error("AFTER intents:", JSON.stringify(after.intents.map(i=>[i.dest,i.productId,i.sizeKey,i.qty,i.source])));
  console.error("BEFORE exceptions counts:", JSON.stringify(Object.fromEntries(Object.entries(before.exceptions).map(([k,v])=>[k,v.count]))));
  console.error("AFTER  exceptions counts:", JSON.stringify(Object.fromEntries(Object.entries(after.exceptions).map(([k,v])=>[k,v.count]))));
  console.error("BEFORE closes:", (before.closes||[]).length, "AFTER closes:", (after.closes||[]).length);
}
const nameOf = (pid) => products?.[pid]?.name ?? null;
const catOf = (pid) => products?.[pid]?.categoryKey || products?.[pid]?.productType || "(uncategorised)";

say(`# Withdrawal plan — what the engine retracts by itself`);
say();
say(`Snapshot: **${new Date(nowMs).toISOString()}**`);
say();
say(`Read-only. Predicted with the REAL \`computeRefillPlan\` against live locks, orders and`);
say(`requests, using the index \`scripts/backfill-stock-provenance.mjs\` is about to write.`);
say(`${movements.length} ledger records folded; ${windowed.length} inside the ${MOVEMENT_WINDOW_DAYS}-day plan window.`);
say();

// ── 1. THE SAFETY PROPERTY ───────────────────────────────────────────────────
const closes = after.closes || [];
const cancels = closes.filter((c) => c.rrStatus === "cancelled");
const bare = cancels.filter((c) => !c.cancelReason);
const humanRejects = closes.filter((c) => c.humanReject);
const byReason = new Map();
for (const c of closes) byReason.set(c.cancelReason || c.reason || "(none)", (byReason.get(c.cancelReason || c.reason || "(none)") || 0) + 1);

say(`## 1. The safety property`);
say();
say(`A cancel with NO \`cancelReason\` is read as a human "no" — 24h cooldown plus a (pid|size)`);
say(`denial SHARED between marathon-pe and trophy. This is the check that must be zero.`);
say();
say(`| | count |`);
say(`|---|---|`);
say(`| closes the engine will apply | ${closes.length} |`);
say(`| …that cancel a request | ${cancels.length} |`);
say(`| **…cancelled with NO cancelReason (must be 0)** | **${bare.length}** |`);
say(`| **…flagged humanReject (must be 0)** | **${humanRejects.length}** |`);
say();
say(`Closes by reason:`);
say();
say(`| reason | count |`);
say(`|---|---|`);
for (const [r, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) say(`| \`${r}\` | ${n} |`);
say();
if (bare.length || humanRejects.length) {
  say(`### ⛔ UNSAFE — do not proceed`);
  say();
  for (const c of [...bare, ...humanRejects].slice(0, 40)) say(`- \`${c.dest}\` / \`${c.pid}\` / \`${c.sizeKey}\` → ${JSON.stringify(c)}`);
  say();
} else {
  say(`✅ Every cancel carries a reason and none is a human reject. The engine is retracting only its own asks.`);
  say();
}

// ── 2. WHAT GETS RETRACTED, NAMED ────────────────────────────────────────────
const withdrawn = closes.filter((c) => c.cancelReason === "no_longer_needed");
say(`## 2. What the engine retracts — \`no_longer_needed\``);
say();
say(`${withdrawn.length} line(s). Each one: request cancelled with the reason stamped, order deleted, lock dropped.`);
say(`No cooldown, no denial, no effect on any other shop — a self-withdrawal is not a rejection.`);
say();
if (withdrawn.length) {
  const grid = new Map();
  for (const c of withdrawn) {
    const k = `${c.dest}|${catOf(c.pid)}`;
    const g = grid.get(k) || { lines: 0, pids: new Set() };
    g.lines += 1; g.pids.add(c.pid); grid.set(k, g);
  }
  say(`| destination | category | lines | pids |`);
  say(`|---|---|---|---|`);
  for (const [k, g] of [...grid.entries()].sort((a, b) => b[1].lines - a[1].lines)) {
    const [d, cat] = k.split("|");
    say(`| \`${d}\` | \`${cat}\` | ${g.lines} | ${g.pids.size} |`);
  }
  say();
  say(`Named, by pid:`);
  say();
  say(`| dest | pid | name (display only) | category | size | refillId | orderId deleted | carries after |`);
  say(`|---|---|---|---|---|---|---|---|`);
  for (const c of withdrawn.sort((a, b) => a.dest.localeCompare(b.dest) || String(a.pid).localeCompare(String(b.pid)) || String(a.sizeKey).localeCompare(String(b.sizeKey)))) {
    say(`| \`${c.dest}\` | \`${c.pid}\` | ${JSON.stringify(nameOf(c.pid))} | \`${catOf(c.pid)}\` | ${c.sizeKey} | \`${c.refillId}\` | ${c.removeOrderId ? `\`${c.removeOrderId}\`` : "—"} | ${carriesByProvenance(prov.get(`${c.dest}|${c.pid}`))} |`);
  }
  say();
}

// ── 3. THE INCIDENT LINES SPECIFICALLY ───────────────────────────────────────
const INCIDENT = ["p1786452575638", "p1786453234097"];
say(`## 3. The two Lacoste sweatshirts`);
say();
say(`| pid | name | dest | size | retracted? | reason |`);
say(`|---|---|---|---|---|---|`);
for (const pid of INCIDENT) {
  const mine = closes.filter((c) => c.pid === pid);
  if (!mine.length) { say(`| \`${pid}\` | ${JSON.stringify(nameOf(pid))} | — | — | **no close predicted** | — |`); continue; }
  for (const c of mine) {
    say(`| \`${pid}\` | ${JSON.stringify(nameOf(pid))} | \`${c.dest}\` | ${c.sizeKey} | ${c.cancelReason === "no_longer_needed" ? "**YES**" : "yes"} | \`${c.cancelReason || c.reason}\` |`);
  }
}
say();
say(`And they must NOT be retracted at trophy, which sells them:`);
say();
for (const pid of INCIDENT) {
  const t = closes.filter((c) => c.pid === pid && c.dest === "trophy");
  say(`- \`${pid}\` @ trophy — closes predicted: **${t.length}** ${t.length ? `(${t.map((c) => c.cancelReason || c.reason).join(", ")})` : "(none — untouched)"}`);
}
say();

// ── 4. WHAT THE ENGINE WILL NOT TOUCH — the owner's lines ────────────────────
// Open REFILL demand at a destination the new predicate refuses, that the engine
// has NOT closed. Almost always because no engine lock owns it: a human placed it.
const OPEN_ORDER_STATUS = new Set(["incoming", "open", "pending", "ready", "requested", undefined, null, ""]);
const isRefillOrder = (id, o) => o.autoRefill === true || /^R\d/.test(String(id)) || String(o.customerName || "") === "Shop Refill";
const closedKeys = new Set(closes.map((c) => `${c.dest}|${c.pid}|${c.sizeKey}`));
const orphans = [];
for (const [id, r] of Object.entries(refillRequests)) {
  if (!r || r.status !== "open" || !r.productId || !r.requestingLocation) continue;
  if (!dests.includes(r.requestingLocation)) continue;
  if (carriesByProvenance(prov.get(`${r.requestingLocation}|${r.productId}`))) continue;
  const sizeKey = engine.encodeSizeKey(r.size);
  if (closedKeys.has(`${r.requestingLocation}|${r.productId}|${sizeKey}`)) continue;
  orphans.push({ kind: "refill_request", id, dest: r.requestingLocation, pid: r.productId, size: r.size, sizeKey, qty: Number(r.qty) || 0, engine: r.createdFrom?.engine === true });
}
for (const [id, o] of Object.entries(orders)) {
  if (!o || !o.productId || !o.destShop || !OPEN_ORDER_STATUS.has(o.status)) continue;
  if (!isRefillOrder(id, o) || !dests.includes(o.destShop)) continue;
  if (carriesByProvenance(prov.get(`${o.destShop}|${o.productId}`))) continue;
  const sizeKey = engine.encodeSizeKey(o.size);
  if (closedKeys.has(`${o.destShop}|${o.productId}|${sizeKey}`)) continue;
  orphans.push({ kind: "refill_order", id, dest: o.destShop, pid: o.productId, size: o.size, sizeKey, qty: Number(o.qty) || 1, engine: o.autoRefill === true });
}

say(`## 4. Lines the engine will NOT retract — yours to decide`);
say();
say(`Open refill demand at a destination the new predicate refuses, with no engine close predicted.`);
say(`The engine leaves these alone by design: with no lock of its own it has no ask to withdraw, and`);
say(`cancelling a human's request without a reason is exactly the poisoning this whole approach avoids.`);
say();
say(`${orphans.length} line(s) — ${orphans.filter((o) => !o.engine).length} human-raised, ${orphans.filter((o) => o.engine).length} engine-stamped but unlocked.`);
say();
if (orphans.length) {
  say(`| kind | id | dest | pid | name (display only) | category | size | qty | source |`);
  say(`|---|---|---|---|---|---|---|---|---|`);
  for (const o of orphans.sort((a, b) => a.dest.localeCompare(b.dest) || String(a.pid).localeCompare(String(b.pid)))) {
    say(`| ${o.kind} | \`${o.id}\` | \`${o.dest}\` | \`${o.pid}\` | ${JSON.stringify(nameOf(o.pid))} | \`${catOf(o.pid)}\` | ${o.size} | ${o.qty} | ${o.engine ? "ENGINE" : "**human**"} |`);
  }
  say();
  // ── the staged target-0 payload ────────────────────────────────────────────
  say(`### Staged \`target: 0\` rows — the documented off switch`);
  say();
  say(`An explicit \`target: 0\` row means "deliberately excluded here" and beats every rule and the`);
  say(`category map. It stops the line permanently and leaves a readable record on the row, which a`);
  say(`cancel does not. It does NOT cancel anything already open — clearing an open human request is`);
  say(`a decision for whoever placed it, in the app.`);
  say();
  const payload = {};
  for (const o of orphans) {
    payload[`stock_targets/${o.dest}/${o.pid}/${o.sizeKey}`] = {
      target: 0, minQty: 0,
      note: "provenance: destination has never traded this line (2026-08-17)",
      updatedAt: new Date(nowMs).toISOString(),
      updatedBy: "scripts/withdraw-plan-provenance.mjs",
    };
  }
  if (STAGE_ZERO) {
    say("```json");
    say(JSON.stringify(payload, null, 2));
    say("```");
  } else {
    say(`${Object.keys(payload).length} row(s) for ${orphans.length} line(s) — a row is keyed (dest, pid, sizeKey), so two open lines`);
    say(`for the same size collapse to one row. That is correct: the row is a standing decision about the`);
    say(`size, not about the request.`);
    say();
    say(`Re-run with \`--stage-zero-rows\` to print the payload.`);
  }
  say();
  say(`⚠ Do NOT paste this blindly. Each row is a standing decision that this shop does not stock this`);
  say(`line. Review the ${orphans.filter((o) => !o.engine).length} human-raised line(s) first — someone asked for those on purpose.`);
  say();
}

// ── 5. what does NOT change ──────────────────────────────────────────────────
say(`## 5. What this does not touch`);
say();
say(`| | before | after |`);
say(`|---|---|---|`);
say(`| intents planned | ${before.intents.length} | ${after.intents.length} |`);
say(`| managed cells | ${before.stats?.managedCells ?? "—"} | ${after.stats?.managedCells ?? "—"} |`);
say(`| closes | ${(before.closes || []).length} | ${closes.length} |`);
say();
say(`The "before" column is the SAME live snapshot with the index rebuilt from cell existence — the`);
say(`old predicate expressed as data, so both columns come from the same engine build and differ only`);
say(`in the input under test. Neither plan was applied.`);
say();
say(`Note what barely moves: the intent count. The ${withdrawn.length} retractions are all EXISTING open locks, not`);
say(`intents this scan would have raised, so the fix mostly stops demand that was already sitting in`);
say(`the queue rather than demand about to be created. \`unintroduced\` rising is the other half of the`);
say(`same event: the refused pairs become visible as needing a decision instead of silently arming.`);
say();
say(`⚠ THESE NUMBERS DRIFT. The engine scans every 15 minutes and this reads live state, so a re-run`);
say(`minutes later legitimately reports different totals — new locks appear, fulfilled ones close.`);
say(`The safety property in §1 is the invariant; the counts are a snapshot of ${new Date(nowMs).toISOString()}.`);
say();
say(`### Apply order`);
say();
say("```bash");
say(`# 1. publish the /stock_provenance rules   (console — PROVENANCE-RULES.md)`);
say(`# 2. build the index`);
say(`node scripts/backfill-stock-provenance.mjs --execute`);
say(`# 3. deploy the engine`);
say(`firebase deploy --only functions:refillHealthScan`);
say(`# 4. the withdrawal happens BY ITSELF on the next scan (≤15 min). Verify:`);
say(`node scripts/withdraw-plan-provenance.mjs`);
say("```");
say();
say(`Step 4 needs no command. That is the whole design: the engine retracts its own asks as`);
say(`\`no_longer_needed\`, so nothing has to reach into /refill_requests and risk a bare cancel.`);
say();

if (process.env.WITHDRAW_MD) {
  const p = process.env.WITHDRAW_MD.replace(/^~/, homedir());
  writeFileSync(p, out.join("\n") + "\n");
  console.log(`\n[written] ${p}`);
}
process.exit(bare.length || humanRejects.length ? 1 : 0);
