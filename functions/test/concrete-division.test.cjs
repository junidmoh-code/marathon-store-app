// ─── THE CONCRETE DIVISION — seating, Hub 3 sneakers, keeps, source ──────────
// Junid, 9 Nov 2026; the 12 Nov 2026 model: Pine/Concrete non-footwear kept in
// the shop from Central (2 per size / 5 per design); Hub 3 sneakers only (2, ask at 1).
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
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } },
  policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(), policy: { perSize: true, hub3: { target: 2, minQty: 1, reorderPoint: 1, carriedOnly: true } } } },
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
  // Since 10 Nov 2026 a cell at zero seats too (s1's size 8 at Hub 3).
  const stock = { hub3: { s1: { 7: counted(2) } }, concrete: { c1: { _: counted(1) }, t1: { S: counted(0) } } };
  const r = dv.planSeats({ rawStock: stock, seats: {}, movements: [], nowIso: ISO, products });
  assert.deepEqual(Object.keys(r.effective.hub3), ["s1"]);
  assert.deepEqual(Object.keys(r.effective.concrete).sort(), ["c1", "t1"]);
  assert.equal(r.seated, 3);
  assert.equal(r.effective.concrete.t1.via, "cell");
  const seats = { concrete: { t1: seat() } };
  const sold = dv.planSeats({ rawStock: { concrete: { t1: { S: counted(0) } } }, seats, movements: [{ productId: "t1", from: "concrete", to: "customer", type: "sold", ts: ISO }], nowIso: ISO, products });
  assert.ok(sold.effective.concrete.t1, "a sale leaves it seated");
  const moved = dv.planSeats({ rawStock: { concrete: { t1: { S: counted(0) } } }, seats, movements: [{ productId: "t1", from: "concrete", to: "central", type: "transfer_out", ts: "2026-11-09T13:00:00.000Z" }], nowIso: ISO, products });
  assert.equal(moved.effective.concrete.t1, undefined);
  assert.equal(moved.writes["concrete/t1"], null);
  const stillHeld = dv.planSeats({ rawStock: { concrete: { t1: { S: counted(1) } } }, seats, movements: [{ productId: "t1", from: "concrete", to: "central", type: "transfer_out", ts: ISO }], nowIso: ISO, products });
  assert.ok(stillHeld.effective.concrete.t1);
});

test("seats (12 Nov 2026): Hub 3 is never seated with a non-footwear item, and an old seat comes off", () => {
  const stock = { hub3: { t1: { S: counted(3) }, c1: { _: counted(0) }, s1: { 7: counted(1) } } };
  const r = dv.planSeats({ rawStock: stock, seats: { hub3: { c1: seat({ owner: "concrete" }) } }, movements: [], nowIso: ISO, products });
  assert.deepEqual(Object.keys(r.effective.hub3), ["s1"]);
  assert.equal(r.writes["hub3/c1"], null, "the old owner seat is switched off");
  assert.equal(r.writes["hub3/t1"], undefined, "never written");
});

test("seats: a refill leaving, or a Solve newer than the move, does not release a seat", () => {
  const seats = { concrete: { t1: seat() } };
  const refill = dv.planSeats({ rawStock: { concrete: { t1: { S: counted(0) } } }, seats, movements: [{ productId: "t1", from: "concrete", to: "marathon-pine", type: "transfer_out", ts: "2026-11-09T13:00:00.000Z", link: { refillId: "r" } }], nowIso: ISO, products });
  assert.ok(refill.effective.concrete.t1, "a refill leaving is not a person moving it out");
  const resolve = dv.planSeats({ rawStock: { concrete: { t1: { S: counted(0) } } }, seats: { concrete: { t1: seat({ via: "solve", at: "2026-11-09T12:00:00.000Z" }) } }, movements: [{ productId: "t1", from: "concrete", to: "central", type: "transfer_out", ts: "2026-11-01T08:00:00.000Z" }], nowIso: ISO, products });
  assert.ok(resolve.effective.concrete.t1, "the Solve came after the move");
});

test("seat: Hub 3 refuses a non-footwear Solve; there is no owning shop; clear removes only its own Solve", async () => {
  const db = makeFakeDb({ users: { u1: { stockRole: "store" } }, products: { t1: TEE, s1: SHOE } });
  const ctx = { db, callerUid: "u1", nowIso: ISO };
  await assert.rejects(dv.applyDivisionSeat({ ...ctx, data: { location: "hub3", pid: "t1", solveId: "a" } }), /footwear only/);
  await assert.rejects(dv.applyDivisionSeat({ ...ctx, data: { location: "hub3", pid: "t1", owner: "concrete", solveId: "a" } }), /footwear only/);
  await assert.rejects(dv.applyDivisionSeat({ ...ctx, data: { location: "concrete", pid: "t1", owner: "concrete", solveId: "a" } }), /no owning shop/);
  const shop = await dv.applyDivisionSeat({ ...ctx, data: { location: "concrete", pid: "t1", solveId: "a" } });
  assert.equal(shop.seat.owner, undefined);
  await dv.applyDivisionSeat({ ...ctx, data: { location: "hub3", pid: "s1", solveId: "a" } });
  const other = await dv.applyDivisionSeat({ ...ctx, data: { location: "hub3", pid: "s1", clear: true, solveId: "b" } });
  assert.equal(other.cleared, false);
  const mine = await dv.applyDivisionSeat({ ...ctx, data: { location: "hub3", pid: "s1", clear: true, solveId: "a" } });
  assert.equal(mine.cleared, true);
});

test("Hub 3 sneakers: keep 2, ask at 1, every declared size, seated only, counted through the trust mask", () => {
  const stock = { central, hub3: { s1: { 7: counted(2), 8: counted(1) } } };
  const unseated = plan({ stock });
  assert.deepEqual(lines(unseated, "hub3"), [], "not seated — nothing");
  const p = plan({ stock, seats: { hub3: { s1: seat() } } });
  assert.deepEqual(lines(p, "hub3"), ["central:8:1", "central:9:2"], "7 holds 2, 8 is at the ask (1 left) and tops up to 2, 9 has no cell and is a declared size");
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

test("Hub 3 holds no non-footwear (12 Nov 2026): seated, owned, an explicit row, or an old key's switch — nothing", () => {
  const stock = { central, hub3: { t1: { S: trusted(0), M: trusted(0) }, c1: { _: trusted(0) } } };
  const seats = { hub3: { t1: seat({ owner: "concrete" }), c1: seat({ via: "solve" }) } };
  assert.deepEqual(lines(plan({ stock, seats }), "hub3"), []);
  const old = base(); old.concreteDivision = { ...old.concreteDivision, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: true, perSize: 2, oneSize: 10 } };
  assert.deepEqual(lines(plan({ stock, seats, config: old }), "hub3"), [], "an older key's Hub 3 switch is ignored");
  const targets = { hub3: { t1: { S: { target: 4, minQty: 2 } } } };
  assert.deepEqual(lines(plan({ stock, seats, targets }), "hub3"), [], "above an explicit row too");
});

test("a shop asks Central for its keep whatever Hub 3 holds or has coming, whoever 'owned' it there", () => {
  const seats = { hub3: { t1: seat({ via: "solve", owner: "concrete" }), c1: seat({ owner: "concrete" }) }, concrete: { t1: seat() }, "marathon-pine": { c1: seat() } };
  const solve = (size) => ({ status: "open", productId: "t1", size, qty: 2, requestingLocation: "hub3", createdAt: ISO, createdFrom: { source: "central", divisionSolve: true } });
  const p = plan({
    stock: { central, hub3: { t1: { S: trusted(5), M: trusted(0) }, c1: { _: trusted(9) } }, concrete: { t1: { S: trusted(0), M: trusted(1) } }, "marathon-pine": { c1: { _: trusted(0) } } },
    seats, refillRequests: { rM: solve("M") },
  });
  assert.deepEqual(lines(p, "concrete"), ["central:M:1", "central:S:2"]);
  assert.deepEqual(lines(p, "marathon-pine"), ["central:_:5"], "the other shop is no longer shut out");
  assert.deepEqual(lines(p, "hub3"), []);
});

test("shop-only: straight from Central, 2 per size and 5 per design, any shortfall including one piece", () => {
  const stock = { central, concrete: { t1: { S: trusted(1), M: trusted(0) } }, "marathon-pine": { c1: { _: trusted(4) } } };
  const p = plan({ stock });
  assert.deepEqual(lines(p, "concrete"), ["central:M:2", "central:S:1"]);
  assert.deepEqual(lines(p, "marathon-pine"), ["central:_:1"]);
});

test("a Hub 3 non-footwear row with no lock is withdrawn untouched as never kept there; a picked one finishes", () => {
  const row = { status: "open", productId: "t1", size: "S", qty: 2, requestingLocation: "hub3", createdAt: ISO, createdFrom: { source: "central", via: "hub3_solve", divisionSolve: true } };
  const p = plan({ stock: { central, hub3: { t1: { S: trusted(0) } } }, refillRequests: { r1: row } });
  const c = (p.satisfiedClosures || []).find((x) => x.refillId === "r1");
  assert.ok(c, "withdrawn");
  assert.equal(c.cancelReason, "never_kept_here");
  assert.equal(c.requireUntouched, true);
  const off = base(); delete off.concreteDivision;
  const keyOff = plan({ stock: { central, hub3: { t1: { S: trusted(0) } } }, refillRequests: { r1: row }, config: off });
  assert.ok(!(keyOff.satisfiedClosures || []).some((x) => x.refillId === "r1" && x.cancelReason === "never_kept_here"), "the rule is the division's: key off, not applied");
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

test("seatDivisionSolve: a stock role is needed, Hub 3 takes footwear only, the pair is refused", async () => {
  const make = (uid) => ({ db: makeFakeDb({ users: { u1: { stockRole: "store" } }, products: { t1: TEE, s1: SHOE } }), callerUid: uid, nowIso: ISO });
  await assert.rejects(dv.applyDivisionSeat({ ...make("nobody"), data: { location: "hub3", pid: "s1" } }), /stock role/);
  await assert.rejects(dv.applyDivisionSeat({ ...make("u1"), data: { location: "hub3", pid: "t1" } }), /footwear only/);
  await assert.rejects(dv.applyDivisionSeat({ ...make("u1"), data: { location: "hub3", pid: "s1", hubs: ["hub1", "hub2"] } }), /cannot be solved together/);
  const r = await dv.applyDivisionSeat({ ...make("u1"), data: { location: "hub3", pid: "s1", hubs: ["hub2", "hub3"] } });
  assert.equal(r.seat.via, "solve");
  assert.equal(r.seat.owner, undefined);
});

test("one list of footwear keys; the browser twin is byte-identical", () => {
  assert.deepEqual([...dv.DIVISION_FOOTWEAR_KEYS].sort(), [...FOOTWEAR_CATEGORY_KEYS].sort());
  const body = (s) => s.slice(s.indexOf("// ── BEGIN SHARED BODY"), s.indexOf("// ── END SHARED BODY"));
  const a = fs.readFileSync(path.join(__dirname, "../lib/concrete-division.cjs"), "utf8");
  const b = fs.readFileSync(path.join(__dirname, "../../src/components/stock/concreteDivision.js"), "utf8");
  assert.equal(body(a), body(b));
});
