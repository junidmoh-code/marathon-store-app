// ─── THE CONCRETE DIVISION — seating, Hub 3 sneakers, keeps, source (Junid, 9 Nov 2026)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const dv = require("../lib/concrete-division.cjs");
const { FOOTWEAR_CATEGORY_KEYS } = require("../lib/policy-resolve.cjs");
const { classifyRequestSource } = require("../lib/request-source.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const ISO = "2026-11-09T12:00:00.000Z";
const base = () => ({
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  ruleBasedTargets: true, maxIntentsPerRun: 500, maxFootwearIntentsPerRun: 500, maxUnitsPerIntent: 20,
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } },
  policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(), policy: { perSize: true, hub3: { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true } } } },
  categoryPolicy: {},
});
const counted = (qty) => ({ qty, v: 1, mv: "m", lastType: "count" });
const trusted = (qty) => ({ ...counted(qty), trusted: true, trustedVia: "solve", trustedAt: ISO });
const SHOE = { id: "s1", name: "Shoe", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", productType: "sneaker", sizes: ["7", "8", "9"] };
const TEE = { id: "t1", name: "Tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M"] };
const CAP = { id: "c1", name: "Cap", category: "Accessories", categoryKey: "caps-beanies", sizes: ["_"] };
const products = { s1: SHOE, t1: TEE, c1: CAP };
const seat = (o) => ({ via: "stock", at: ISO, ...o });
function plan({ stock, seats = {}, config = base(), openIndex = {}, refillRequests = {}, targets = {} }) {
  return computeRefillPlan({ nowMs: NOW, config, targets, stock: { central: {}, hub3: {}, concrete: {}, "marathon-pine": {}, ...stock }, products, openIndex, refillRequests, orders: {}, movements: [], network: reg.SEED_REGISTRY, seats });
}
const lines = (p, dest) => p.intents.filter((i) => i.dest === dest).map((i) => `${i.source}:${i.size || "_"}:${i.qty}`).sort();
const central = { s1: { 7: counted(9), 8: counted(9), 9: counted(9) }, t1: { S: counted(9), M: counted(9) }, c1: { _: counted(20) } };

test("seats: units seat a product; a sell-out keeps it; only a transfer out releases it", () => {
  // Since 10 Nov 2026 a cell at zero seats too (t1 at Hub 3).
  const stock = { hub3: { s1: { 7: counted(2) }, t1: { S: counted(0) } }, concrete: { c1: { _: counted(1) } } };
  const r = dv.planSeats({ rawStock: stock, seats: {}, movements: [], nowIso: ISO });
  assert.deepEqual(Object.keys(r.effective.hub3).sort(), ["s1", "t1"]);
  assert.deepEqual(Object.keys(r.effective.concrete), ["c1"]);
  assert.equal(r.seated, 3);
  assert.equal(r.effective.hub3.t1.via, "cell");
  const seats = { hub3: { t1: seat() } };
  const sold = dv.planSeats({ rawStock: { hub3: { t1: { S: counted(0) } } }, seats, movements: [{ productId: "t1", from: "hub3", to: "customer", type: "sold", ts: ISO }], nowIso: ISO });
  assert.ok(sold.effective.hub3.t1, "a sale leaves it seated");
  const moved = dv.planSeats({ rawStock: { hub3: { t1: { S: counted(0) } } }, seats, movements: [{ productId: "t1", from: "hub3", to: "central", type: "transfer_out", ts: "2026-11-09T13:00:00.000Z" }], nowIso: ISO });
  assert.equal(moved.effective.hub3.t1, undefined);
  assert.equal(moved.writes["hub3/t1"], null);
  const stillHeld = dv.planSeats({ rawStock: { hub3: { t1: { S: counted(1) } } }, seats, movements: [{ productId: "t1", from: "hub3", to: "central", type: "transfer_out", ts: ISO }], nowIso: ISO });
  assert.ok(stillHeld.effective.hub3.t1);
});

test("seats: a refill leaving, or a Solve newer than the move, does not release a seat", () => {
  const seats = { hub3: { t1: seat() } };
  const refill = dv.planSeats({ rawStock: { hub3: { t1: { S: counted(0) } } }, seats, movements: [{ productId: "t1", from: "hub3", to: "concrete", type: "transfer_out", ts: "2026-11-09T13:00:00.000Z", link: { refillId: "r" } }], nowIso: ISO });
  assert.ok(refill.effective.hub3.t1, "a refill leaving is the hub doing its job");
  const resolve = dv.planSeats({ rawStock: { hub3: { t1: { S: counted(0) } } }, seats: { hub3: { t1: seat({ via: "solve", at: "2026-11-09T12:00:00.000Z" }) } }, movements: [{ productId: "t1", from: "hub3", to: "central", type: "transfer_out", ts: "2026-11-01T08:00:00.000Z" }], nowIso: ISO });
  assert.ok(resolve.effective.hub3.t1, "the Solve came after the move");
});

test("seat: a second Solve cannot take a product from its owning shop; clear removes only its own Solve", async () => {
  const db = makeFakeDb({ users: { u1: { stockRole: "store" } }, products: { t1: TEE } });
  const ctx = { db, callerUid: "u1", nowIso: ISO };
  await dv.applyDivisionSeat({ ...ctx, data: { location: "hub3", pid: "t1", owner: "concrete", solveId: "a" } });
  await assert.rejects(dv.applyDivisionSeat({ ...ctx, data: { location: "hub3", pid: "t1", owner: "marathon-pine", solveId: "b" } }), /already belongs/);
  const other = await dv.applyDivisionSeat({ ...ctx, data: { location: "hub3", pid: "t1", clear: true, solveId: "b" } });
  assert.equal(other.cleared, false);
  const mine = await dv.applyDivisionSeat({ ...ctx, data: { location: "hub3", pid: "t1", clear: true, solveId: "a" } });
  assert.equal(mine.cleared, true);
});

test("Hub 3 sneakers: keep 3, ask at 1, every declared size, seated only, counted through the trust mask", () => {
  const stock = { central, hub3: { s1: { 7: counted(2), 8: counted(1) } } };
  const unseated = plan({ stock });
  assert.deepEqual(lines(unseated, "hub3"), [], "not seated — nothing");
  const p = plan({ stock, seats: { hub3: { s1: seat() } } });
  assert.deepEqual(lines(p, "hub3"), ["central:8:2", "central:9:3"], "7 holds 2 (above the ask), 8 tops up to 3, 9 has no cell and is a declared size");
  assert.ok(p.intents.filter((i) => i.dest === "hub3").every((i) => i.seatedHub3 === true));
});

test("Hub 3 sneakers: a trusted cell with no seat arms nothing (a moved-out product keeps its cells)", () => {
  const p = plan({ stock: { central, hub3: { s1: { 7: trusted(0), 8: trusted(0) } } } });
  assert.deepEqual(lines(p, "hub3"), []);
});

test("Hub 3 sneakers never remove excess, and a size nobody holds anywhere stays quiet", () => {
  const stock = { central: {}, hub3: { s1: { 7: counted(9) } } };
  const p = plan({ stock, seats: { hub3: { s1: seat() } } });
  assert.deepEqual(lines(p, "hub3"), []);
  assert.equal((p.closes || []).length, 0);
});

test("Hub 3 non-sneakers are off at go-live, seated or not, and switch on through the one key", () => {
  const stock = { central, hub3: { t1: { S: trusted(0), M: trusted(0) } } };
  const seats = { hub3: { t1: seat({ owner: "concrete" }) } };
  assert.deepEqual(lines(plan({ stock, seats }), "hub3"), []);
  const on = base(); on.concreteDivision.hub3Keep.on = true;
  assert.deepEqual(lines(plan({ stock, seats, config: on }), "hub3"), ["central:M:2", "central:S:2"]);
});

test("with the Hub 3 keep on, an uncounted Hub 3 clothing cell still raises nothing", () => {
  const on = base(); on.concreteDivision.hub3Keep.on = true;
  const p = plan({ stock: { central, hub3: { t1: { S: counted(0) } } }, seats: { hub3: { t1: seat() } }, config: on });
  assert.deepEqual(lines(p, "hub3"), []);
});

test("Solved to Hub 3: no shop request until Hub 3 has received; then the owner asks Hub 3, one per size, at 0", () => {
  const seats = { hub3: { t1: seat({ via: "solve", owner: "concrete" }) } };
  const before = plan({ stock: { central, hub3: { t1: { S: trusted(0), M: trusted(0) } }, concrete: { t1: { S: trusted(0), M: trusted(0) } } }, seats });
  assert.deepEqual(lines(before, "concrete"), [], "receipt-gated");
  assert.deepEqual(lines(before, "hub3"), [], "and no pass-through leg either");
  const after = plan({ stock: { central, hub3: { t1: { S: trusted(2), M: trusted(0) } }, concrete: { t1: { S: trusted(0), M: trusted(0) } } }, seats });
  assert.deepEqual(lines(after, "concrete"), ["hub3:S:1"]);
  assert.deepEqual(lines(after, "marathon-pine"), []);
  const holding = plan({ stock: { central, hub3: { t1: { S: trusted(2) } }, concrete: { t1: { S: trusted(1) } } }, seats });
  assert.deepEqual(lines(holding, "concrete"), [], "ask at 0");
});

test("the shop that is not the owner asks nothing; a one-size item keeps 5 from Hub 3", () => {
  const seats = { hub3: { c1: seat({ via: "solve", owner: "concrete" }) } };
  const stock = { central, hub3: { c1: { _: trusted(9) } }, concrete: { c1: { _: trusted(0) } }, "marathon-pine": { c1: { _: trusted(0) } } };
  const p = plan({ stock, seats });
  assert.deepEqual(lines(p, "concrete"), ["hub3:_:5"]);
  assert.deepEqual(lines(p, "marathon-pine"), []);
});

test("shop-only: straight from Central, 2 per size and 5 per design, any shortfall including one piece", () => {
  const stock = { central, concrete: { t1: { S: trusted(1), M: trusted(0) } }, "marathon-pine": { c1: { _: trusted(4) } } };
  const p = plan({ stock });
  assert.deepEqual(lines(p, "concrete"), ["central:M:2", "central:S:1"]);
  assert.deepEqual(lines(p, "marathon-pine"), ["central:_:1"]);
});

test("HARD RULE: a product at Hub 3 by any means is never requested from Central by a shop", () => {
  for (const hub3 of [{ t1: { S: counted(0) } }, { t1: { S: trusted(0) } }]) {
    const p = plan({ stock: { central, hub3, concrete: { t1: { S: trusted(0), M: trusted(0) } } } });
    assert.ok(!p.intents.some((i) => i.dest === "concrete" && i.source === "central"), JSON.stringify(hub3));
  }
  const locked = plan({ stock: { central, concrete: { t1: { S: trusted(0) } } }, openIndex: { hub3: { t1: { S: { qty: 1, source: "central", refillId: "x", createdAt: ISO } } } }, refillRequests: { x: { status: "open", productId: "t1", size: "S", requestingLocation: "hub3", createdAt: ISO } } });
  assert.ok(!locked.intents.some((i) => i.dest === "concrete" && i.source === "central"));
});

test("an explicit row of 0 (the Seating switch-off) still wins at every division location", () => {
  const targets = { concrete: { t1: { S: { target: 0, minQty: 0 } } }, hub3: { s1: { 9: { target: 0, minQty: 0 } } } };
  const p = plan({ stock: { central, concrete: { t1: { S: trusted(0), M: trusted(0) } }, hub3: { s1: { 7: counted(2) } } }, seats: { hub3: { s1: seat() } }, targets });
  assert.deepEqual(lines(p, "concrete"), ["central:M:2"]);
  assert.ok(!lines(p, "hub3").some((l) => l.includes(":9:")));
});

test("a Hub 3 Solve row without a lock is inbound: the scan never asks beside it", () => {
  const refillRequests = { r1: { status: "open", productId: "s1", size: "8", qty: 3, requestingLocation: "hub3", createdAt: ISO, createdFrom: { source: "central", divisionSolve: true } } };
  const p = plan({ stock: { central, hub3: { s1: { 7: counted(3), 8: counted(0), 9: counted(3) } } }, seats: { hub3: { s1: seat() } }, refillRequests });
  assert.deepEqual(lines(p, "hub3"), []);
});

test("the division key off: seats do nothing and the engine is the old one", () => {
  const cfg = base(); delete cfg.concreteDivision;
  const p = plan({ stock: { central, hub3: { s1: { 7: counted(0) } } }, seats: { hub3: { s1: seat() } }, config: cfg });
  assert.deepEqual(lines(p, "hub3"), [], "untrusted cell stays masked");
});

test("Sneaker pairs: any single hub, Hub 1 + 3, Hub 2 + 3; never Hub 1 + 2", () => {
  for (const ok of [["hub1"], ["hub2"], ["hub3"], ["hub1", "hub3"], ["hub2", "hub3"]]) assert.equal(dv.sneakerSolvePairAllowed(ok), true, ok.join("+"));
  for (const no of [["hub1", "hub2"], ["hub1", "hub2", "hub3"], [], ["pine"]]) assert.equal(dv.sneakerSolvePairAllowed(no), false, no.join("+"));
});

test("the server refuses a request row that claims Hub 1 + Hub 2", () => {
  const row = (hubs) => ({ requestSource: "solve", createdFrom: { via: "missing_sneakers", solveHubs: hubs } });
  assert.equal(classifyRequestSource(row(["hub1", "hub3"])), "solve");
  assert.equal(classifyRequestSource(row(["hub1", "hub2"])), null);
  assert.equal(classifyRequestSource({ requestSource: "solve", createdFrom: { via: "hub3_solve", divisionSolve: true } }), "solve");
});

test("seatDivisionSolve: a stock role is needed, a non-sneaker at Hub 3 needs its shop, the pair is refused", async () => {
  const make = (uid) => ({ db: makeFakeDb({ users: { u1: { stockRole: "store" } }, products: { t1: TEE, s1: SHOE } }), callerUid: uid, nowIso: ISO });
  await assert.rejects(dv.applyDivisionSeat({ ...make("nobody"), data: { location: "hub3", pid: "t1", owner: "concrete" } }), /stock role/);
  await assert.rejects(dv.applyDivisionSeat({ ...make("u1"), data: { location: "hub3", pid: "t1" } }), /Pine or Concrete/);
  await assert.rejects(dv.applyDivisionSeat({ ...make("u1"), data: { location: "hub3", pid: "s1", hubs: ["hub1", "hub2"] } }), /cannot be solved together/);
  const ctx = make("u1");
  const r = await dv.applyDivisionSeat({ ...ctx, data: { location: "hub3", pid: "t1", owner: "concrete" } });
  assert.equal(r.seat.owner, "concrete");
});

test("one list of footwear keys; the browser twin is byte-identical", () => {
  assert.deepEqual([...dv.DIVISION_FOOTWEAR_KEYS].sort(), [...FOOTWEAR_CATEGORY_KEYS].sort());
  const body = (s) => s.slice(s.indexOf("// ── BEGIN SHARED BODY"), s.indexOf("// ── END SHARED BODY"));
  const a = fs.readFileSync(path.join(__dirname, "../lib/concrete-division.cjs"), "utf8");
  const b = fs.readFileSync(path.join(__dirname, "../../src/components/stock/concreteDivision.js"), "utf8");
  assert.equal(body(a), body(b));
});
