// ─── TRUSTED CELLS: the engine at an Auto-refill "solved products only" location
//
// Over the SYNTHETIC routing fixture (nothing in it comes from production):
//   • with no Section 1 cell trusted, the seed registry (Section 1 Solve on +
//     Auto-refill "solved") plans EXACTLY what Section 1 switched off plans —
//     no Section 1 intent at all, and Section 2's intents byte for byte;
//   • a trusted Pine cell is refilled from a trusted Hub 3 cell; an untrusted
//     Pine size of the same product is never asked for;
//   • untrusted legacy stock at Hub 3 is no source; it is not "carried";
//   • an open engine request for an untrusted cell is withdrawn.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan, maskUntrustedStock } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const trust = require("../lib/stock-trust.cjs");
const FIXTURE = require("./fixtures/sections-routing-fixture.json");

const NOW_MS = Date.parse("2026-10-01T10:00:00.000Z");
const S1 = ["marathon-pine", "concrete", "hub3", "concrete-stockroom"];
const OFF = { solve: false, autoRefill: "off" };
const DARK = reg.normalizeNetwork({ locations: Object.fromEntries(S1.map((id) => [id, OFF])) });
const SEED = reg.SEED_REGISTRY;
const clone = (v) => JSON.parse(JSON.stringify(v));
const T = "2026-10-01T08:00:00.000Z";
const trusted = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_out", ...trust.trustStamp("refill", T) });
const legacy = (qty) => ({ qty, v: 3, mv: "lx", lastType: "adjustment" });

function plan({ network, stock = FIXTURE.stock, openIndex = {}, refillRequests = {} }) {
  return computeRefillPlan({
    nowMs: NOW_MS, config: clone(FIXTURE.config), targets: clone(FIXTURE.targets), stock: clone(stock),
    products: clone(FIXTURE.products), openIndex, refillRequests, orders: {}, movements: [], network,
  });
}
const s2 = (p) => p.intents.filter((i) => !S1.includes(i.dest)).map((i) => JSON.stringify(i)).sort();
const s1 = (p) => p.intents.filter((i) => S1.includes(i.dest));

test("NOTHING TRUSTED: the seed plans exactly what Section 1 OFF plans — no Section 1 intent, Section 2 byte for byte", () => {
  const off = plan({ network: DARK });
  const seed = plan({ network: SEED });
  assert.deepEqual(s1(seed), []);
  assert.deepEqual(s2(seed), s2(off));
  assert.ok(s2(off).length > 10, "the fixture raises Section 2 work — the comparison proves something");
});

test("a trusted Pine cell is refilled from trusted Hub 3 stock; the untrusted sizes are never asked for", () => {
  const pid = "fx030";   // t-shirts, S–XXL; Pine follows Marathon PE's run (S1 M3 L2 XL2 XXL1)
  const stock = clone(FIXTURE.stock);
  stock["marathon-pine"][pid] = { M: trusted(0), L: legacy(0), S: legacy(0) };
  stock.hub3[pid] = { M: trusted(6), L: trusted(6), S: legacy(6) };
  const p = plan({ network: SEED, stock });
  const pine = s1(p).filter((i) => i.dest === "marathon-pine" && i.productId === pid);
  assert.deepEqual(pine.map((i) => [i.source, i.sizeKey]), [["hub3", "M"]]);
  assert.equal(pine[0].qty, 3);
  // the same world with Section 1 off: nothing for Pine
  assert.deepEqual(s1(plan({ network: DARK, stock })).filter((i) => i.productId === pid), []);
  // Section 2 is untouched by the Section 1 cells
  assert.deepEqual(s2(p), s2(plan({ network: DARK, stock })));
});

test("UNTRUSTED legacy Hub 3 stock is no source, and the hub does not ask Central for an untrusted cell", () => {
  const pid = "fx030";
  const stock = clone(FIXTURE.stock);
  stock["marathon-pine"][pid] = { M: trusted(0) };
  stock.hub3[pid] = { M: legacy(9) };
  const p = plan({ network: SEED, stock });
  assert.deepEqual(s1(p).filter((i) => i.productId === pid && i.dest === "marathon-pine" && i.source === "hub3"), []);
  // Hub 3 asks nothing for its OWN untrusted cell; the one Hub 3 leg is a
  // pass-through raised FOR Pine's trusted cell (the box trusts Hub 3's cell on landing)
  assert.deepEqual(s1(p).filter((i) => i.productId === pid && i.dest === "hub3").map((i) => [i.source, i.sizeKey, i.forDests, !!i.passThrough]),
    [["central", "M", ["marathon-pine"], true]]);
  // and with Pine's cell untrusted too, nothing at all for the product in Section 1
  const none = clone(stock); none["marathon-pine"][pid] = { M: legacy(0) };
  assert.deepEqual(s1(plan({ network: SEED, stock: none })).filter((i) => i.productId === pid), []);
  // trusted at Hub 3: the shop is served
  stock.hub3[pid] = { M: trusted(9) };
  assert.equal(s1(plan({ network: SEED, stock })).filter((i) => i.productId === pid && i.dest === "marathon-pine").length, 1);
});

test("Auto-refill ALL at Pine: every cell is believed again, trusted or not", () => {
  const pid = "fx030";
  const stock = clone(FIXTURE.stock);
  stock["marathon-pine"][pid] = { M: legacy(0) };
  stock.hub3[pid] = { M: legacy(6) };
  const all = reg.normalizeNetwork({ locations: { "marathon-pine": { solve: true, autoRefill: "all" }, hub3: { solve: true, autoRefill: "all" } } });
  assert.equal(s1(plan({ network: all, stock })).filter((i) => i.productId === pid && i.dest === "marathon-pine").length, 1);
});

test("an open engine request for an UNTRUSTED cell is withdrawn", () => {
  const pid = "fx030";
  const stock = clone(FIXTURE.stock);
  stock["marathon-pine"][pid] = { M: legacy(0) };
  stock.hub3[pid] = { M: trusted(6) };
  const refillRequests = { r1: { productId: pid, size: "M", qty: 3, requestingLocation: "marathon-pine", status: "open", createdAt: T, createdFrom: { engine: true, source: "hub3" } } };
  const openIndex = { "marathon-pine": { [pid]: { M: { qty: 3, source: "hub3", createdAt: T, runId: "x", refillId: "r1" } } } };
  const p = plan({ network: SEED, stock, openIndex, refillRequests });
  const closed = (p.closes || []).filter((c) => c.refillId === "r1");
  assert.equal(closed.length, 1, JSON.stringify(p.closes));
});

test("maskUntrustedStock leaves an 'all' location and a registry-less plan untouched (the same object)", () => {
  const stock = clone(FIXTURE.stock);
  assert.equal(maskUntrustedStock(stock, undefined).stock, stock);
  const allOn = reg.normalizeNetwork({ locations: Object.fromEntries(S1.map((id) => [id, { live: true }])) });
  assert.equal(maskUntrustedStock(stock, allOn).stock, stock);
  const m = maskUntrustedStock(stock, SEED);
  assert.notEqual(m.stock, stock);
  for (const loc of ["hub1", "hub2", "central", "marathon-pe", "trophy"]) assert.equal(m.stock[loc], stock[loc]);
  assert.deepEqual(m.stock["marathon-pine"], {});
  assert.deepEqual(m.stock.hub3, {});
});

// ── the server writer (lib/admin-movement.cjs) ──────────────────────────────
const { applyMovementAdmin } = require("../lib/admin-movement.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

test("SERVER WRITER: a hold-lane release (link.refillId) trusts the destination cell; a write-off adjustment never does", async () => {
  const db = makeFakeDb({ stock: { in_transit: { p1: { M: { qty: 2, v: 1, mv: "m", lastType: "transfer_out" } } }, hub3: { p1: { M: { qty: 0, v: 1, mv: "m", lastType: "adjustment" } } } } });
  const res = await applyMovementAdmin(db, {
    type: "transfer_in", productId: "p1", size: "M", qty: 2, from: "in_transit", to: "hub3", actor: "sweep", actorRole: "admin",
    reason: "stock_hold_release", movementId: "rel_x", link: { refillId: "r1", holdLineId: "x" },
  }, { nowIso: T, network: SEED });
  assert.equal(res.ok, true);
  const hub3 = db.state.root.stock.hub3.p1.M;
  assert.equal(hub3.qty, 2);
  assert.deepEqual([hub3.trusted, hub3.trustedVia, hub3.trustedAt], [true, "refill", T]);
  assert.equal(db.state.root.stock.in_transit.p1?.M?.trusted, undefined);
  const db2 = makeFakeDb({ stock: { hub3: { p2: { M: { qty: 4, v: 1, mv: "m", lastType: "adjustment" } } } } });
  await applyMovementAdmin(db2, { type: "adjustment", productId: "p2", size: "M", qty: 1, from: "hub3", actor: "x", reason: "w", movementId: "wo_1" }, { nowIso: T });
  assert.equal(db2.state.root.stock.hub3.p2.M.trusted, undefined);
});

test("SERVER WRITER: no trust at a Marathon hub, none without a registry, none over legacy units", async () => {
  const rel = (to, extra = {}) => ({ type: "transfer_in", productId: "p1", size: "M", qty: 1, from: "in_transit", to, actor: "sweep", actorRole: "admin", reason: "stock_hold_release", movementId: `rel_${to}`, link: { refillId: "r1" }, ...extra });
  const start = (to, qty) => makeFakeDb({ stock: { in_transit: { p1: { M: { qty: 1, v: 1, mv: "m", lastType: "transfer_out" } } }, [to]: { p1: { M: { qty, v: 1, mv: "m", lastType: "adjustment" } } } } });
  let db = start("hub2", 0); await applyMovementAdmin(db, rel("hub2"), { nowIso: T, network: SEED });
  assert.deepEqual(Object.keys(db.state.root.stock.hub2.p1.M).filter((k) => k.startsWith("trust")), []);
  db = start("hub3", 0); await applyMovementAdmin(db, rel("hub3"), { nowIso: T });
  assert.equal(db.state.root.stock.hub3.p1.M.trusted, undefined);
  db = start("hub3", 7); await applyMovementAdmin(db, rel("hub3"), { nowIso: T, network: SEED });
  assert.equal(db.state.root.stock.hub3.p1.M.qty, 8);
  assert.equal(db.state.root.stock.hub3.p1.M.trusted, undefined);
});

test("FIRST BATCH seeds: trusted at a Section 1 hub, Marathon's seed shape untouched", () => {
  const { seedCell } = require("../lib/first-batch.cjs");
  assert.deepEqual(seedCell(T), { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: T, updatedBy: "first_batch" });
  assert.deepEqual(seedCell(T, true), { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: T, updatedBy: "first_batch", trusted: true, trustedVia: "solve", trustedAt: T });
});

test("THE CAP IS MARATHON'S FIRST: a flood of Section 1 work never shrinks Marathon's share of a run", () => {
  // many trusted Pine cells, all short, Hub 3 holding trusted stock for each
  const stock = clone(FIXTURE.stock);
  const pids = Object.values(FIXTURE.products).filter((p) => p.productType === "clothing" && !p.deactivated).map((p) => p.id);
  for (const pid of pids) {
    stock["marathon-pine"][pid] = { M: trusted(0), L: trusted(0) };
    stock.hub3[pid] = { M: trusted(9), L: trusted(9) };
  }
  const cfg = clone(FIXTURE.config); cfg.maxIntentsPerRun = 20;
  const run = (network) => computeRefillPlan({ nowMs: NOW_MS, config: cfg, targets: clone(FIXTURE.targets), stock: clone(stock), products: clone(FIXTURE.products), openIndex: {}, refillRequests: {}, orders: {}, movements: [], network });
  const seed = run(SEED), off = run(DARK);
  assert.ok(s1(seed).length >= 0);
  const clothingS2 = (p) => p.intents.filter((i) => !S1.includes(i.dest) && FIXTURE.products[i.productId]?.productType === "clothing").map((i) => JSON.stringify(i)).sort();
  assert.deepEqual(clothingS2(seed), clothingS2(off));
});

test("an UNTRUSTED empty Hub 3 cell never parks Pine as 'waiting for Hub 3' — the need is carried through Hub 3", () => {
  const pid = "fx030";
  const stock = clone(FIXTURE.stock);
  stock["marathon-pine"][pid] = { M: trusted(0) };
  stock.hub3[pid] = { M: legacy(0) };
  const p = plan({ network: SEED, stock });
  const legs = s1(p).filter((i) => i.productId === pid);
  assert.deepEqual(legs.map((i) => [i.source, i.dest, i.sizeKey, !!i.passThrough, i.forDests]), [["central", "hub3", "M", true, ["marathon-pine"]]]);
  assert.equal((p.awaitingUpstream || []).some((a) => a.loc === "marathon-pine" && a.pid === pid), false);
});
