// ─── SWEEP — OPEN DEMAND AIMED AT STORES THAT DO NOT TRADE THE LINE (READ-ONLY) ─
//
// WHY THIS FILE EXISTS
// `storeCarries(stock, loc, pid)` (functions/lib/refill-engine.cjs:200-202) is the
// gate the clothing and footwear rules use to decide "does this store sell this
// product". Its whole definition is:
//
//     !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0
//
// A CELL EXISTS. Not "holds units", not "has ever held units", not "has ever sold
// one" — the object is present. /stock cells are never deleted, so ANY event that
// once routed a unit through a shop leaves that shop permanently "carrying" the
// product, and the size run arms there on the very next scan.
//
// The 2026-08-17 Lacoste sweatshirt recurrence is that shape exactly: a customer
// collection was dispatched hub2 → marathon-pe, staff walked the unit next door to
// trophy where the customer actually was, and the qty-0 husk left at marathon-pe
// armed PE's full M/L/XL run for two products that belong to Trophy.
//
// This sweep asks, across EVERY location and EVERY category, how wide that is. It
// classifies each (destination, pid) pair carrying open demand using LEDGER FACTS
// only — never a name, never a guess:
//
//   TRADES        — the store has sold this pid at least once. Legitimate demand.
//   STOCKED       — never sold there, but the store currently holds units.
//   PASS-THROUGH  — never sold there, holds nothing, and every REASON that ever
//                   brought units in is a pass-through reason (a customer-order
//                   dispatch or a CR fulfil). Membership of the reason set, NOT a net
//                   of undos — see the ledger-facts block below for why, and for
//                   which module is authoritative. The husk-armed set.
//   HUSK          — never sold there, holds nothing, and NO movement ever put a
//                   positive quantity into the cell at all (created by a
//                   decrement, a seed, or a state flip).
//
// PASS-THROUGH + HUSK together are "the destination store has never carried the
// product" stated in evidence rather than in intuition.
//
// IDENTITY RULE — PID ONLY. Names are printed for the humans reading the named
// lists and used for nothing else; 177 exact-duplicate name groups exist in this
// catalogue. Every join in this file is on the pid read off the request/order.
//
// Writes nothing. Reads only.
//
// Usage:
//   node scripts/sweep-destination-carries.mjs
//   SWEEP_MD=~/refill-destination-sweep.md node scripts/sweep-destination-carries.mjs

import { createRequire } from "module";
import { writeFileSync } from "fs";
import { homedir } from "os";

const require = createRequire(new URL("../functions/package.json", import.meta.url));
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
});
const db = admin.database();

// The two shops the owner asked to see named individually.
const NAMED = new Set((process.env.SWEEP_NAMED || "trophy,marathon-pe").split(",").map((s) => s.trim()));

// refill-engine.cjs:200-202, copied verbatim — the definition under test.
const storeCarries = (stock, loc, pid) =>
  !!stock?.[loc]?.[pid] && Object.keys(stock[loc][pid]).length > 0;

const units = (cells) => Object.values(cells || {}).reduce((s, c) => s + Math.max(0, Number(c?.qty) || 0), 0);

// Movement reasons that mean "this store was a waypoint, not a shelf".
const PASS_THROUGH_IN = new Set(["clothing_order", "clothing_cr", "clothing_cr_uncounted"]);

const out = [];
const say = (s = "") => { out.push(s); console.log(s); };

async function readPaged(path, pageSize = 2000, onRecord = null) {
  const acc = onRecord ? null : {};
  let lastKey = null, count = 0;
  for (;;) {
    let q = db.ref(path).orderByKey().limitToFirst(pageSize + (lastKey ? 1 : 0));
    if (lastKey) q = q.startAt(lastKey);
    const snap = await q.once("value");
    const keys = [];
    snap.forEach((c) => { keys.push(c.key); });   // braces load-bearing — a truthy
    let added = 0;                                 // return cancels RTDB forEach
    for (const k of keys) {
      if (k === lastKey) continue;
      const v = snap.child(k).val();
      added += 1; count += 1;
      if (onRecord) onRecord(k, v); else acc[k] = v;
    }
    if (added === 0) break;
    lastKey = keys[keys.length - 1];
    if (added < pageSize) break;
  }
  return onRecord ? count : acc;
}

const [stock, products, refillRequests, orders, config] = await Promise.all([
  db.ref("/stock").once("value").then((s) => s.val() || {}),
  readPaged("/products"),
  readPaged("/refill_requests"),
  readPaged("/orders"),
  db.ref("/config/refillEngine").once("value").then((s) => s.val() || {}),
]);

// ── ledger facts per (loc, pid) ──────────────────────────────────────────────
// CodeRabbit, PR #376: this block previously documented a `maxAfter` the script never
// computed, filled an `undone` map that `classify` never read, and described
// `inflow` as "movements that ADDED units" when it accumulates every movement naming
// the location as `to` regardless of sign. Since the 165-pair result rests on this
// classification, the comments now describe what the code actually does — and the two
// unused structures are gone rather than left as a claim about behaviour that is not
// there.
//
//   soldAt[loc|pid]  = how many `sold` movements the location recorded
//   inflowBy[loc|pid] = { reason: summed qty } over every movement naming this
//                       location as `to`, whatever the sign. Only the SET OF REASON
//                       KEYS is used below; the sums are carried for the report.
//
// Note the deliberate scope limit: this sweep classifies from REASON MEMBERSHIP, not
// from net units, so a partially-undone fulfil still reads as PASS-THROUGH here. The
// authoritative predicate — which does net undos — is
// src/components/stock/provenanceClass.js, and scripts/provenance-study.mjs is what
// the 165 figure was confirmed against. This sweep is the exploratory pass that
// found the shape; it is not the arbiter of it.
const soldAt = new Map(), inflowBy = new Map();
const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

const scanned = await readPaged("/stock_movements", 3000, (_id, m) => {
  if (!m || !m.productId) return;
  const q = Number(m.qty) || 0;
  if (m.type === "sold" && m.from) bump(soldAt, `${m.from}|${m.productId}`, 1);
  if (m.to && m.type !== "sold") {
    const k = `${m.to}|${m.productId}`;
    const r = m.reason || "(none)";
    const byReason = inflowBy.get(k) || {};
    byReason[r] = (byReason[r] || 0) + q;
    inflowBy.set(k, byReason);
  }
});

// ── classify one (dest, pid) ─────────────────────────────────────────────────
function classify(dest, pid) {
  const k = `${dest}|${pid}`;
  const held = units(stock?.[dest]?.[pid]);
  const sold = soldAt.get(k) || 0;
  const inflow = inflowBy.get(k) || {};
  const reasons = Object.keys(inflow);
  if (sold > 0) return { cls: "TRADES", held, sold, reasons };
  if (held > 0) return { cls: "STOCKED", held, sold, reasons };
  if (!reasons.length) return { cls: "HUSK", held, sold, reasons };
  if (reasons.every((r) => PASS_THROUGH_IN.has(r))) return { cls: "PASS-THROUGH", held, sold, reasons };
  return { cls: "STOCKED", held, sold, reasons };   // real inflow of another kind
}

const catOf = (pid) => products?.[pid]?.categoryKey || products?.[pid]?.productType || "(uncategorised)";
const nameOf = (pid) => products?.[pid]?.name ?? null;

// ── the open demand population ───────────────────────────────────────────────
// Two independent sources, kept separate so neither can hide the other:
//   • /refill_requests  status === "open"      (the engine's asks)
//   • /orders           unresolved refill/dispatch lines (what the warehouse sees)
const rows = [];

for (const [id, r] of Object.entries(refillRequests)) {
  if (!r || r.status !== "open") continue;
  const pid = r.productId, dest = r.requestingLocation;
  if (!pid || !dest) continue;
  rows.push({ kind: "refill_request", demand: "REFILL", id, pid, dest, size: r.size, qty: Number(r.qty) || 0, createdAt: r.createdAt, engine: r.createdFrom?.engine === true });
}

// DEMAND KIND is the load-bearing distinction and the reason this sweep does not
// report one number. Two completely different things live in /orders:
//
//   REFILL   — "put stock on this shop's shelf". Destination IS a stocking
//              decision, so a destination that never trades the line is a defect.
//              These are the engine's own asks (autoRefill) and the shop-placed
//              R### refill carts, plus every open /refill_requests record.
//
//   CUSTOMER — "a named person collects this parcel here". Destination is a
//              COLLECTION POINT, not a stocking decision. A customer may collect a
//              Trophy-owned sneaker at Marathon PE and that is correct business;
//              PE was never meant to stock it. Counting these as damage would
//              inflate the number with normal trade — and worse, hide the real
//              lines inside it.
//
// The Lacoste incident is precisely the seam between them: customer order 017/018
// dispatched legitimately to marathon-pe, and the qty-0 cell that dispatch left
// behind then armed REFILL demand there. One kind creates the husk; the other kind
// is the damage. They must be counted apart.
const OPEN_ORDER_STATUS = new Set(["incoming", "open", "pending", "ready", "requested", undefined, null, ""]);
const isRefillOrder = (id, o) => o.autoRefill === true || /^R\d/.test(String(id)) || String(o.customerName || "") === "Shop Refill";
for (const [id, o] of Object.entries(orders)) {
  if (!o) continue;
  const pid = o.productId, dest = o.destShop;
  if (!pid || !dest) continue;
  if (!OPEN_ORDER_STATUS.has(o.status)) continue;
  const refill = isRefillOrder(id, o);
  rows.push({ kind: refill ? "refill_order" : "customer_order", demand: refill ? "REFILL" : "CUSTOMER", id, pid, dest, size: o.size, qty: Number(o.qty) || 1, createdAt: o.createdAt, engine: o.autoRefill === true, orderStatus: o.status ?? "(none)" });
}

for (const row of rows) Object.assign(row, classify(row.dest, row.pid), { cat: catOf(row.pid), carries: storeCarries(stock, row.dest, row.pid) });

const BAD = new Set(["PASS-THROUGH", "HUSK"]);
// THE HEADLINE SET IS REFILL ONLY. A customer order's destination is a collection
// point; it is not a claim that the shop stocks the line, so it cannot be damage.
const bad = rows.filter((r) => BAD.has(r.cls) && r.demand === "REFILL");
const badCustomer = rows.filter((r) => BAD.has(r.cls) && r.demand === "CUSTOMER");

// ── report ───────────────────────────────────────────────────────────────────
say(`# Sweep — open demand aimed at stores that do not trade the line`);
say();
say(`Read-only. ${scanned} ledger records scanned. Every join on **pid**.`);
say();
const nReq = rows.filter((r) => r.kind === "refill_request").length;
const nRefOrd = rows.filter((r) => r.kind === "refill_order").length;
const nCust = rows.filter((r) => r.kind === "customer_order").length;
say(`Population: ${rows.length} open lines — ${nReq} open \`/refill_requests\`, ${nRefOrd} unresolved REFILL \`/orders\`, ${nCust} unresolved CUSTOMER \`/orders\`.`);
say();
say(`## Classification`);
say();
say(`| class | meaning | REFILL lines | REFILL units | CUSTOMER lines | CUSTOMER units |`);
say(`|---|---|---|---|---|---|`);
for (const cls of ["TRADES", "STOCKED", "PASS-THROUGH", "HUSK"]) {
  const R = rows.filter((r) => r.cls === cls && r.demand === "REFILL");
  const C = rows.filter((r) => r.cls === cls && r.demand === "CUSTOMER");
  const meaning = {
    TRADES: "store has sold this pid — legitimate demand",
    STOCKED: "never sold there, but the store holds units now",
    "PASS-THROUGH": "never sold, holds nothing, every inflow REASON is a dispatch or a CR fulfil",
    HUSK: "never sold, holds nothing, no movement ever added units",
  }[cls];
  say(`| **${cls}** | ${meaning} | ${R.length} | ${R.reduce((s, r) => s + r.qty, 0)} | ${C.length} | ${C.reduce((s, r) => s + r.qty, 0)} |`);
}
say();
say(`### The number that matters`);
say();
say(`**${bad.length} REFILL lines (${bad.reduce((s, r) => s + r.qty, 0)} units) are aimed at a destination that has never carried the product.**`);
say(`Of those, ${bad.filter((r) => r.engine).length} were raised by the ENGINE and ${bad.filter((r) => !r.engine).length} by a human.`);
say();
say(`${badCustomer.length} CUSTOMER lines (${badCustomer.reduce((s, r) => s + r.qty, 0)} units) also point at a shop that never traded the line — these are`);
say(`**collections, not damage**: the parcel is dispatched to where the buyer walks in. They are listed separately at the`);
say(`bottom because each one is a *future* husk: the dispatch will create a cell at that shop and arm the size run there.`);
say();

// by store × category
say(`## By destination store and category`);
say();
const grid = new Map();
for (const r of bad) {
  const k = `${r.dest}|${r.cat}`;
  const g = grid.get(k) || { dest: r.dest, cat: r.cat, lines: 0, qty: 0, pids: new Set(), pt: 0, husk: 0 };
  g.lines += 1; g.qty += r.qty; g.pids.add(r.pid);
  if (r.cls === "PASS-THROUGH") g.pt += 1; else g.husk += 1;
  grid.set(k, g);
}
if (!grid.size) say(`_no lines in this class_`);
else {
  say(`| destination | category | lines | units | distinct pids | PASS-THROUGH | HUSK |`);
  say(`|---|---|---|---|---|---|---|`);
  for (const g of [...grid.values()].sort((a, b) => b.qty - a.qty || a.dest.localeCompare(b.dest))) {
    say(`| \`${g.dest}\` | \`${g.cat}\` | ${g.lines} | ${g.qty} | ${g.pids.size} | ${g.pt} | ${g.husk} |`);
  }
  say();
  say(`Totals by destination:`);
  say();
  say(`| destination | lines | units | distinct pids |`);
  say(`|---|---|---|---|`);
  const byDest = new Map();
  for (const r of bad) {
    const g = byDest.get(r.dest) || { lines: 0, qty: 0, pids: new Set() };
    g.lines += 1; g.qty += r.qty; g.pids.add(r.pid); byDest.set(r.dest, g);
  }
  for (const [d, g] of [...byDest.entries()].sort((a, b) => b[1].qty - a[1].qty)) {
    say(`| \`${d}\` | ${g.lines} | ${g.qty} | ${g.pids.size} |`);
  }
}
say();

// named lists for the two shops the owner asked about
for (const dest of NAMED) {
  const mine = bad.filter((r) => r.dest === dest);
  say(`## Named list — \`${dest}\` (${mine.length} lines, ${mine.reduce((s, r) => s + r.qty, 0)} units)`);
  say();
  if (!mine.length) { say(`_none_`); say(); continue; }
  say(`| pid | name (display only) | category | class | size | qty | source | line | createdAt | held now | sold ever | inflow reasons |`);
  say(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of mine.sort((a, b) => String(a.pid).localeCompare(String(b.pid)) || String(a.size).localeCompare(String(b.size)))) {
    say(`| \`${r.pid}\` | ${JSON.stringify(nameOf(r.pid))} | \`${r.cat}\` | ${r.cls} | ${r.size} | ${r.qty} | ${r.engine ? "ENGINE" : "human"} | ${r.kind} \`${r.id}\` | ${r.createdAt ?? "—"} | ${r.held} | ${r.sold} | ${JSON.stringify(r.reasons)} |`);
  }
  say();
}

// customer collections into shops that never traded the line — future husks
say(`## Customer collections into a shop that never traded the line — NOT damage, but the husk source`);
say();
say(`Each of these will leave a qty-0 cell at the collection shop the moment it is dispatched, and`);
say(`\`storeCarries()\` will answer TRUE there for good. Counted by shop and category only — no action implied.`);
say();
if (!badCustomer.length) say(`_none open right now_`);
else {
  const g = new Map();
  for (const r of badCustomer) {
    const k = `${r.dest}|${r.cat}`;
    const e = g.get(k) || { lines: 0, qty: 0, pids: new Set() };
    e.lines += 1; e.qty += r.qty; e.pids.add(r.pid); g.set(k, e);
  }
  say(`| collection shop | category | lines | units | distinct pids |`);
  say(`|---|---|---|---|---|`);
  for (const [k, e] of [...g.entries()].sort((a, b) => b[1].lines - a[1].lines)) {
    const [d, c] = k.split("|");
    say(`| \`${d}\` | \`${c}\` | ${e.lines} | ${e.qty} | ${e.pids.size} |`);
  }
}
say();

// latent population — every (loc,pid) pair storeCarries() would arm today
say(`## Latent exposure — pairs \`storeCarries()\` already answers TRUE for, with no trade behind them`);
say();
say(`This counts (store, pid) pairs with a live cell but no sale ever and nothing on hand — demand`);
say(`the size run will arm the moment the product's category is in scope, whether or not a line is open today.`);
say();
const routes = config?.routes || {};
const destLocs = Object.keys(routes);
say(`Refill destinations from \`/config/refillEngine/routes\`: ${destLocs.map((d) => `\`${d}\``).join(", ")}`);
say();
say(`| destination | cells present | TRADES | STOCKED | PASS-THROUGH | HUSK |`);
say(`|---|---|---|---|---|---|`);
const latent = { "PASS-THROUGH": [], HUSK: [] };
for (const dest of destLocs) {
  const pids = Object.keys(stock?.[dest] || {});
  const tally = { TRADES: 0, STOCKED: 0, "PASS-THROUGH": 0, HUSK: 0 };
  for (const pid of pids) {
    if (!storeCarries(stock, dest, pid)) continue;
    const c = classify(dest, pid);
    tally[c.cls] += 1;
    if (BAD.has(c.cls)) latent[c.cls].push({ dest, pid, cat: catOf(pid) });
  }
  say(`| \`${dest}\` | ${pids.length} | ${tally.TRADES} | ${tally.STOCKED} | ${tally["PASS-THROUGH"]} | ${tally.HUSK} |`);
}
say();
const latentAll = [...latent["PASS-THROUGH"], ...latent.HUSK];
say(`**${latentAll.length} latent (store, pid) pairs** across those destinations — ${latent["PASS-THROUGH"].length} PASS-THROUGH, ${latent.HUSK.length} HUSK.`);
say();
const latentByCat = new Map();
for (const l of latentAll) {
  const k = `${l.dest}|${l.cat}`;
  latentByCat.set(k, (latentByCat.get(k) || 0) + 1);
}
say(`| destination | category | latent pairs |`);
say(`|---|---|---|`);
for (const [k, n] of [...latentByCat.entries()].sort((a, b) => b[1] - a[1])) {
  const [d, c] = k.split("|");
  say(`| \`${d}\` | \`${c}\` | ${n} |`);
}
say();

if (process.env.SWEEP_MD) {
  const p = process.env.SWEEP_MD.replace(/^~/, homedir());
  writeFileSync(p, out.join("\n") + "\n");
  console.log(`\n[written] ${p}`);
}
process.exit(0);
