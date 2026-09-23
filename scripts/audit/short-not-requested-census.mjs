// ─── SHORT BUT NOT REQUESTED — CENSUS (READ ONLY) ─────────────────────────────
//
// WRITES NOTHING. Counts every SHOP cell (Marathon PE, Trophy — and Pine, which
// has no keep numbers at all, see below) where:
//
//   on hand < keep         the engine's own resolveTarget, AFTER its reorder-point
//                          gate (a cell held quiet by an ask-at the owner set is
//                          by design and is not counted)
//   upstream has it        the shop's feeding hub (config.routes) OR that hub's
//                          own source (Central) counts at least one unit
//   nothing is on its way  no open lock / open request / manual order / held line
//                          for the cell, no open or held leg for it at its hub,
//                          and the plan raises none this scan (for the shop, or
//                          a pass-through leg at its hub on the shop's behalf)
//
// and then says WHY, from the bucket the real computeRefillPlan filed the cell
// in — it replays the engine, it never re-implements it:
//
//   recount              reject-streak loop guard: the hub rejected N times while
//                        its count still shows stock (refill-engine.cjs loop guard)
//   hub_no_target        hub empty, Central holds units, but the hub resolves no
//                        target for the size, so no Central→hub leg ever forms
//   upstream_blocked     the hub's own Central leg was rejected / is streak-parked
//   confirmed_out        denied at BOTH levels in the confirmed-out window
//   cooldown             inside the 24h retry window after an ordinary rejection
//   awaiting_upstream    the hub is empty and the chain is said to be flowing
//
// Two headline numbers, because the owner's question has two readings:
//   STRICT — also no request of ANY status raised for the cell in 14 days
//   BROAD  — nothing open for it right now (a request raised and rejected last
//            week does not make the shop any less empty)
//
// ── READS ────────────────────────────────────────────────────────────────────
// Exactly the nodes refillHealthScan reads, once. Two ways in:
//
//   node scripts/audit/short-not-requested-census.mjs --from-dir DIR [--json OUT]
//       DIR holds one JSON file per scan read, path "/" → "_":
//       config_refillEngine.json, stock_targets.json, products.json,
//       refill_engine_open.json, refill_requests.json, orders.json,
//       refill_engine_rejectStreak.json, refill_engine_retryState.json,
//       settings_stockHold_held.json, stock_movements.json (the 45-day
//       orderBy=ts window), stock_<loc>.json for every routed location.
//       (This is how it runs on a machine whose node cannot reach Google — dump
//       with curl + an OAuth bearer, then replay. See reference notes.)
//
//   node scripts/audit/short-not-requested-census.mjs        (live, Admin SDK)
//
// --engine PATH replays a different engine file (e.g. the pre-fix one from
// `git show <sha>:functions/lib/refill-engine.cjs`) against the same snapshot —
// that is how the before/after counts in the PR were produced.

import { createRequire } from "module";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(n);
  if (i < 0) return null;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) { console.error(`${n} needs a value`); process.exit(2); }
  return v;
};
const require = createRequire(import.meta.url);
const enginePath = resolve(opt("--engine") || join(ROOT, "functions/lib/refill-engine.cjs"));
const engine = require(enginePath);
const { computeRefillPlan, resolveTarget, encodeSizeKey } = engine;

const WINDOW_DAYS = 45;          // refill-scan.cjs MOVEMENTS_WINDOW_DAYS
const RAISED_WINDOW_DAYS = 14;

async function loadFromDir(dir) {
  const read = (name, fallback = {}) => {
    const f = join(dir, `${name}.json`);
    if (!existsSync(f)) return fallback;
    return JSON.parse(readFileSync(f, "utf8")) ?? fallback;
  };
  const config = read("config_refillEngine", null) || read("config", null);
  if (!config) throw new Error(`no config_refillEngine.json in ${dir}`);
  const locs = [...new Set([...Object.keys(config.routes || {}), ...Object.values(config.routes || {})])];
  const stock = Object.fromEntries(locs.map((l) => [l, read(`stock_${l}`)]));
  return {
    config, stock,
    targets: read("stock_targets"), products: read("products"),
    openIndex: read("refill_engine_open"), refillRequests: read("refill_requests"),
    orders: read("orders"), rejectStreak: read("refill_engine_rejectStreak"),
    retryState: read("refill_engine_retryState"), heldLines: read("settings_stockHold_held"),
    targetDecisions: read("stock_targets_decisions"),
    movements: Object.values(read("stock_movements")),
    pineTargets: read("stock_targets")?.["marathon-pine"] || null,
  };
}

async function loadLive() {
  const { adminRequire } = await import("../adminRequire.mjs");
  const admin = adminRequire(import.meta.url)("firebase-admin");
  if (!admin.apps.length) {
    admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  }
  const db = admin.database();
  const val = async (p) => (await db.ref(p).once("value")).val() || {};
  const config = await val("config/refillEngine");
  const locs = [...new Set([...Object.keys(config.routes || {}), ...Object.values(config.routes || {})])];
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString();
  const [targets, products, openIndex, refillRequests, orders, rejectStreak, retryState, heldLines, targetDecisions, mv, ...stocks] = await Promise.all([
    val("stock_targets"), val("products"), val("refill_engine/open"), val("refill_requests"), val("orders"),
    val("refill_engine/rejectStreak"), val("refill_engine/retryState"), val("settings/stockHold/held"),
    val("stock_targets_decisions"),
    db.ref("stock_movements").orderByChild("ts").startAt(windowStart).once("value").then((s) => s.val() || {}),
    ...locs.map((l) => val(`stock/${l}`).then((s) => [l, s])),
  ]);
  await admin.app().delete();
  return { config, stock: Object.fromEntries(stocks), targets, products, openIndex, refillRequests, orders,
    rejectStreak, retryState, heldLines, targetDecisions, movements: Object.values(mv), pineTargets: targets?.["marathon-pine"] || null };
}

const dir = opt("--from-dir");
const snap = dir ? await loadFromDir(resolve(dir)) : await loadLive();
const nowMs = opt("--now") ? Date.parse(opt("--now")) : Date.now();
const { config, stock, products } = snap;
const routes = config.routes || {};
const plan = computeRefillPlan({ ...snap, nowMs, uncapped: true });
const X = plan.exceptions;
// An engine without the `uncapped` switch (anything before this census
// shipped) truncates belowTarget at 1,500 — the count would silently be a
// floor. Say so rather than print it as a total.
if (X.belowTarget.count !== X.belowTarget.items.length) {
  console.error(`WARNING: this engine capped belowTarget (${X.belowTarget.items.length} of ${X.belowTarget.count}) — every figure below is a FLOOR.`);
}
const qty = (loc, pid, sk) => Math.max(Number(stock?.[loc]?.[pid]?.[sk]?.qty) || 0, 0);

// A SHOP is a destination whose source is itself routed — a store fed through
// a hub. Hubs (fed straight from Central) are not shop cells.
const shops = Object.keys(routes).filter((d) => routes[routes[d]] != null).sort();

const since = nowMs - RAISED_WINDOW_DAYS * 864e5;
const raised = new Set(), open = new Set();
for (const r of Object.values(snap.refillRequests || {})) {
  if (!r || !r.productId || r.shadow || !r.requestingLocation) continue;
  const k = `${r.requestingLocation}|${r.productId}|${encodeSizeKey(r.size)}`;
  if (Date.parse(r.createdAt || 0) >= since) raised.add(k);
  if (r.status === "open") open.add(k);
}

const fate = new Map();
const file = (list, tag, rename) => {
  for (const x of list?.items || []) {
    const k = `${x.loc}|${x.pid}|${encodeSizeKey(x.size)}`;
    if (!fate.has(k)) fate.set(k, { cause: rename ? rename(x) : tag, note: x.note || "" });
  }
};
// A countDisputed row is a note about a HUB's count after a pass-through
// landed — it parks nothing, so it must not label the shop cell.
file({ items: (X.recountNeeded?.items || []).filter((x) => !x.countDisputed) }, "recount", (x) => (x.rejections == null ? "confirmed_out" : "recount"));
file(X.waitingForStock, "cooldown");
file(X.awaitingUpstream, "awaiting_upstream", (x) => (/pass-through/.test(x.note || "") ? "pass_through" : "awaiting_upstream"));
file(X.awaitingSupplier, "", (x) => (/no buffer target/.test(x.note) ? "hub_no_target"
  : /blocked/.test(x.note) ? "upstream_blocked" : "chain_empty"));
file(X.missingSizes, "", (x) => (/denied at both/.test(x.note) ? "confirmed_out" : "nothing_anywhere"));

// Cells with a leg planned THIS scan — for the shop itself, or a pass-through
// leg at its hub raised on the shop's behalf.
const planned = new Set();
for (const i of plan.intents) {
  planned.add(`${i.dest}|${i.productId}|${i.sizeKey}`);
  for (const d of i.forDests || []) planned.add(`${d}|${i.productId}|${i.sizeKey}`);
}

const heldAt = (loc, pid, sk) => Object.values(snap.heldLines?.[loc] || {}).some((l) =>
  l && l.productId === pid && (l.sizeKey != null ? String(l.sizeKey) : encodeSizeKey(l.size)) === sk);
const rows = [];
for (const b of X.belowTarget.items) {
  if (!shops.includes(b.loc)) continue;
  const sk = encodeSizeKey(b.size);
  const hub = routes[b.loc], up = routes[hub];
  const hubHas = qty(hub, b.pid, sk), upHas = up ? qty(up, b.pid, sk) : 0;
  if (hubHas + upHas <= 0) continue;
  const k = `${b.loc}|${b.pid}|${sk}`;
  if (b.inbound > 0 || open.has(k) || planned.has(k)) continue;
  // The hub's own leg for this cell is open or held in transit — the chain is
  // carrying the shop's need; the shop leg follows the arrival.
  if (snap.openIndex?.[hub]?.[b.pid]?.[sk] || heldAt(hub, b.pid, sk)) continue;
  const f = fate.get(k) || { cause: "unclassified", note: "" };
  // A pass-through leg the engine computed but the per-run cap deferred: the
  // shop still has nothing on its way this hour. (A planned one is already in
  // `planned` above.)
  if (f.cause === "pass_through") f.cause = "throttled";
  const p = products?.[b.pid] || {};
  rows.push({
    loc: b.loc, pid: b.pid, name: p.name || "", category: p.categoryKey || p.category || "?",
    size: b.size, have: b.have, keep: b.target, hub, hubHas, upstream: up, upHas,
    cause: f.cause, note: f.note, raisedIn14d: raised.has(k),
  });
}
rows.sort((a, b) => a.cause.localeCompare(b.cause) || a.loc.localeCompare(b.loc) || a.name.localeCompare(b.name) || String(a.size).localeCompare(String(b.size)));
const tally = (list, f) => list.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
const strict = rows.filter((r) => !r.raisedIn14d);

// Pine: the engine has no route for it and no keep numbers exist, so no cell
// can be "below keep". Reported, never guessed.
const pineRows = snap.pineTargets ? Object.values(snap.pineTargets).reduce((n, bySize) => n + Object.keys(bySize || {}).length, 0) : 0;

console.log(`engine: ${enginePath}`);
console.log(`shops: ${shops.join(", ")} — marathon-pine: ${routes["marathon-pine"] ? "routed" : "NOT routed"}, ${pineRows} keep rows`);
console.log(`\nBROAD  (nothing on its way now): ${rows.length}`);
console.log("  by cause   ", tally(rows, (r) => r.cause));
console.log("  by shop    ", tally(rows, (r) => r.loc));
console.log("  by category", tally(rows, (r) => r.category));
console.log(`\nSTRICT (and no request of any status in ${RAISED_WINDOW_DAYS} days): ${strict.length}`);
console.log("  by cause   ", tally(strict, (r) => r.cause));
console.log("  by shop    ", tally(strict, (r) => r.loc));
console.log("  by category", tally(strict, (r) => r.category));
console.log("\ncause | shop | product | size | have/keep | hub | central | raised<14d");
for (const r of rows) {
  console.log(`${r.cause} | ${r.loc} | ${r.name} | ${r.size} | ${r.have}/${r.keep} | ${r.hubHas} | ${r.upHas} | ${r.raisedIn14d ? "yes" : "no"}`);
}
const out = opt("--json");
if (out) writeFileSync(out, JSON.stringify({ nowMs, engine: enginePath, broad: rows.length, strict: strict.length, rows }, null, 1));
