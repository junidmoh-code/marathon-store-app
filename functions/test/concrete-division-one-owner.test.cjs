// ─── ONE SHOP PER PRODUCT: PINE OR CONCRETE (Junid, 24 Nov 2026) ─────────────
// "Make sure Pine and Concrete are not set to request the same product from
// Central — they sell separate products, like Marathon PE and Trophy."
// A non-footwear product seated at both shops is supplied to ONE of them, the
// owner, decided once and kept. Nothing is unseated, no number changes, and a
// request already open at the other shop is left to run (never withdrawn).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const dv = require("../lib/concrete-division.cjs");
const { FOOTWEAR_CATEGORY_KEYS } = require("../lib/policy-resolve.cjs");

const NOW = Date.parse("2026-11-24T06:00:00.000Z");
const ISO = "2026-11-24T06:00:00.000Z";
const config = () => ({
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  ruleBasedTargets: true, maxIntentsPerRun: 500, maxFootwearIntentsPerRun: 500, maxUnitsPerIntent: 20,
  concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } },
  policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(), policy: { perSize: true, hub3: { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true } } } },
  categoryPolicy: {},
});
const shelf = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_in" });
const counted = (qty) => ({ qty, v: 1, mv: "m", lastType: "count" });
const TEE = { id: "t1", name: "Tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M"] };
const SHOE = { id: "s1", name: "Shoe", category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", productType: "sneaker", sizes: ["8"] };
const products = { t1: TEE, s1: SHOE };
const CENTRAL = { t1: { S: counted(9), M: counted(9) }, s1: { 8: counted(9) } };
const seatAt = (at) => ({ via: "stock", at });
const bothSeated = (aAt = ISO, bAt = ISO) => ({ concrete: { t1: seatAt(aAt) }, "marathon-pine": { t1: seatAt(bAt) }, hub3: {} });

function plan({ stock, seats, owners, openIndex = {}, refillRequests = {}, targets = {} }) {
  const fullStock = { central: CENTRAL, hub3: {}, concrete: {}, "marathon-pine": {}, ...stock };
  const own = owners === undefined ? dv.planDivisionOwners({ seats, rawStock: fullStock, owners: {}, products, nowIso: ISO }).effective : owners;
  return computeRefillPlan({
    nowMs: NOW, config: config(), targets, products, openIndex, refillRequests, orders: {}, movements: [],
    stock: fullStock, network: reg.SEED_REGISTRY, seats, divisionOwners: own,
  });
}
const lines = (p, dest) => p.intents.filter((i) => i.dest === dest).map((i) => `${i.sizeKey}:${i.qty}`).sort();

test("the owner: more units wins; a tie goes to the older seat; still a tie → Concrete", () => {
  const stock = (c, p) => ({ concrete: { t1: { S: shelf(c) } }, "marathon-pine": { t1: { S: shelf(p) } } });
  assert.equal(dv.chooseDivisionOwner({ seats: bothSeated(), rawStock: stock(1, 3), pid: "t1" }).shop, "marathon-pine");
  assert.equal(dv.chooseDivisionOwner({ seats: bothSeated(), rawStock: stock(4, 3), pid: "t1" }).shop, "concrete");
  const older = dv.chooseDivisionOwner({ seats: bothSeated("2026-11-20T00:00:00Z", "2026-11-09T00:00:00Z"), rawStock: stock(0, 0), pid: "t1" });
  assert.deepEqual([older.shop, older.why], ["marathon-pine", "seated_first"]);
  const tie = dv.chooseDivisionOwner({ seats: bothSeated(), rawStock: stock(2, 2), pid: "t1" });
  assert.deepEqual([tie.shop, tie.why], ["concrete", "default"]);
});

test("units already on their way count: a shop whose open request is about to land is not handed to the other (review)", () => {
  const rawStock = { concrete: { t1: { S: shelf(1) } }, "marathon-pine": {} };
  const openIndex = { "marathon-pine": { t1: { S: { refillId: "r1", qty: 2 }, M: { refillId: "r2", qty: 2 } } } };
  const refillRequests = { r1: { status: "open" }, r2: { status: "open" } };
  const c = dv.chooseDivisionOwner({ seats: bothSeated(), rawStock, openIndex, refillRequests, pid: "t1" });
  assert.equal(c.shop, "marathon-pine");
  assert.deepEqual(c.inbound, { concrete: 0, "marathon-pine": 4 });
});

test("a lock whose request was already fulfilled is not 'on its way' (CodeRabbit)", () => {
  const rawStock = { concrete: { t1: { S: shelf(3) } }, "marathon-pine": { t1: { S: shelf(2) } } };
  const openIndex = { "marathon-pine": { t1: { S: { refillId: "r1", qty: 2 } } } };
  const fulfilled = { r1: { status: "fulfilled" } };
  assert.equal(dv.chooseDivisionOwner({ seats: bothSeated(), rawStock, openIndex, refillRequests: fulfilled, pid: "t1" }).shop, "concrete");
  const open = { r1: { status: "open" } };
  assert.equal(dv.chooseDivisionOwner({ seats: bothSeated(), rawStock, openIndex, refillRequests: open, pid: "t1" }).shop, "marathon-pine");
});

test("a non-owner lock closed in the same plan never lets the deficit loop raise a NEW request there (CodeRabbit)", () => {
  const owners = { t1: { shop: "concrete", why: "units", at: ISO } };
  // Pine's request was fulfilled and the units sold before this scan: the lock is still in the snapshot.
  const openIndex = { "marathon-pine": { t1: { S: { refillId: "r1", qty: 2, source: "central", createdAt: ISO } } } };
  const refillRequests = { r1: { productId: "t1", size: "S", qty: 2, status: "fulfilled", requestingLocation: "marathon-pine", createdAt: ISO, createdFrom: { engine: true, source: "central" } } };
  const p = plan({ stock: { "marathon-pine": { t1: { S: shelf(0) } } }, seats: bothSeated(), owners, openIndex, refillRequests });
  assert.ok(p.closes.some((c) => c.dest === "marathon-pine" && c.refillId === "r1"), "the stale lock is reconciled");
  assert.deepEqual(lines(p, "marathon-pine"), [], "…and nothing new is raised at Pine");
});

test("the Decision Queue does not ask about a stocked product at the shop that does not own it (CodeRabbit)", () => {
  // Pine owns it; Concrete still holds COUNTED (trusted) units — the cells the queue reads.
  const owners = { t1: { shop: "marathon-pine", why: "units", at: ISO } };
  const cfg = { ...config(), concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 } } };
  const trustedCell = (qty) => ({ ...counted(qty), trusted: true, trustedVia: "refill", trustedAt: ISO });
  const stock = { central: CENTRAL, hub3: {}, concrete: { t1: { S: trustedCell(3), M: trustedCell(1) } }, "marathon-pine": { t1: { S: trustedCell(5) } } };
  const p = computeRefillPlan({ nowMs: NOW, config: cfg, targets: {}, products, openIndex: {}, refillRequests: {}, orders: {}, movements: [], stock, network: reg.SEED_REGISTRY, seats: bothSeated(), divisionOwners: owners });
  const asked = (p.exceptions.noTarget?.items || []).filter((x) => x.pid === "t1");
  assert.deepEqual(asked, []);
});

test("a stale owner record never gates a product seated at one shop only", () => {
  const division = { owners: { t1: { shop: "concrete" } }, openIndex: {}, seats: { concrete: {}, "marathon-pine": { t1: seatAt(ISO) } } };
  assert.equal(dv.divisionNotOwner(division, "marathon-pine", "t1", "S", products), false);
});

test("an owner the scan could not save holds BOTH shops: no new request at either (substitute review)", () => {
  const p = plan({ stock: {}, seats: bothSeated(), owners: { t1: { hold: true } } });
  assert.deepEqual(lines(p, "concrete"), []);
  assert.deepEqual(lines(p, "marathon-pine"), []);
});

test("a product row missing for one scan keeps its owner and the gate (review)", () => {
  const kept = { t1: { shop: "concrete", why: "units", at: ISO } };
  const own = dv.planDivisionOwners({ seats: bothSeated(), rawStock: {}, owners: kept, products: {}, nowIso: ISO });
  assert.deepEqual(own.writes, {});
  assert.equal(own.effective.t1.shop, "concrete");
});

test("seated at both, empty at both: only the owner asks Central (before: both did)", () => {
  const seats = bothSeated();
  const before = plan({ stock: {}, seats, owners: {} });
  assert.deepEqual(lines(before, "concrete"), ["M:2", "S:2"]);
  assert.deepEqual(lines(before, "marathon-pine"), ["M:2", "S:2"], "the overlap Junid saw: one product requested for both shops");
  const after = plan({ stock: {}, seats });
  assert.deepEqual(lines(after, "concrete"), ["M:2", "S:2"]);
  assert.deepEqual(lines(after, "marathon-pine"), [], "Pine is not the owner: no request");
});

test("the shop with more units owns it, and keeps being refilled; the other gets nothing", () => {
  const p = plan({ stock: { "marathon-pine": { t1: { S: shelf(1), M: shelf(1) } }, concrete: { t1: { S: shelf(0) } } }, seats: bothSeated() });
  assert.deepEqual(lines(p, "marathon-pine"), ["M:1", "S:1"]);
  assert.deepEqual(lines(p, "concrete"), []);
});

test("a kept owner does not flip when units sell (decided once)", () => {
  const seats = bothSeated();
  const first = dv.planDivisionOwners({ seats, rawStock: { concrete: { t1: { S: shelf(5) } }, "marathon-pine": {} }, owners: {}, products, nowIso: ISO });
  assert.equal(first.effective.t1.shop, "concrete");
  assert.equal(first.decided, 1);
  // Concrete sold out, Pine now holds more — the kept owner stands, nothing is written.
  const later = dv.planDivisionOwners({ seats, rawStock: { concrete: { t1: { S: shelf(0) } }, "marathon-pine": { t1: { S: shelf(3) } } }, owners: { t1: first.writes.t1 }, products, nowIso: ISO });
  assert.equal(later.effective.t1.shop, "concrete");
  assert.deepEqual(later.writes, {});
});

test("seated at one shop only: no owner, that shop is supplied as before", () => {
  const seats = { concrete: {}, "marathon-pine": { t1: seatAt(ISO) }, hub3: {} };
  const own = dv.planDivisionOwners({ seats, rawStock: {}, owners: {}, products, nowIso: ISO });
  assert.deepEqual(own.effective, {});
  assert.deepEqual(lines(plan({ stock: {}, seats }), "marathon-pine"), ["M:2", "S:2"]);
});

test("the record goes when the product is no longer seated at both (Seating tab switch-off ends the overlap)", () => {
  const seats = { concrete: { t1: seatAt(ISO) }, "marathon-pine": {}, hub3: {} };
  const own = dv.planDivisionOwners({ seats, rawStock: {}, owners: { t1: { shop: "concrete", why: "units", at: ISO } }, products, nowIso: ISO });
  assert.deepEqual(own.writes, { t1: null });
  assert.equal(own.cleared, 1);
});

test("footwear is never given an owner (sneakers come from Hub 3, not Central)", () => {
  const seats = { concrete: { s1: seatAt(ISO) }, "marathon-pine": { s1: seatAt(ISO) }, hub3: {} };
  assert.deepEqual(dv.planDivisionOwners({ seats, rawStock: {}, owners: {}, products, nowIso: ISO }).effective, {});
  assert.equal(dv.divisionNotOwner({ owners: { s1: { shop: "concrete" } }, openIndex: {} }, "marathon-pine", "s1", "8", products), false);
});

test("a request already open at the other shop is NOT withdrawn: its size keeps its keep while the lock stands", () => {
  const seats = bothSeated();
  const owners = { t1: { shop: "concrete", why: "units", at: ISO } };
  const openIndex = { "marathon-pine": { t1: { S: { refillId: "r1", qty: 2, source: "central", createdAt: ISO } } } };
  const refillRequests = { r1: { productId: "t1", size: "S", qty: 2, status: "open", requestingLocation: "marathon-pine", createdAt: ISO, createdFrom: { engine: true, source: "central" } } };
  const p = plan({ stock: { "marathon-pine": { t1: { S: shelf(0) } } }, seats, owners, openIndex, refillRequests });
  assert.equal(p.closes.filter((c) => c.dest === "marathon-pine").length, 0, "nothing at Pine is withdrawn");
  assert.equal(p.satisfiedClosures.filter((c) => c.dest === "marathon-pine").length, 0);
  // …and the size with no request open (M) gets no new one.
  assert.deepEqual(lines(p, "marathon-pine"), []);
});

test("Junid's own row at the other shop still wins (explicit above the rule)", () => {
  const targets = { "marathon-pine": { t1: { S: { target: 3, minQty: 2 } } } };
  const p = plan({ stock: {}, seats: bothSeated(), owners: { t1: { shop: "concrete", why: "units", at: ISO } }, targets });
  assert.deepEqual(lines(p, "marathon-pine"), ["S:3"]);
});

test("Pine follows Trophy does not bring the request back at a Pine that is not the owner", () => {
  const cfg = { ...config(), policyFollow: { "marathon-pine": "trophy" }, categoryPolicy: { "t-shirts": { trophy: { target: 4, minQty: 3 } } } };
  const seats = bothSeated();
  const p = computeRefillPlan({
    nowMs: NOW, config: cfg, targets: {}, products, openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    stock: { central: CENTRAL, hub3: {}, concrete: {}, "marathon-pine": {}, trophy: {} }, network: reg.SEED_REGISTRY, seats,
    divisionOwners: { t1: { shop: "concrete", why: "units", at: ISO } },
  });
  assert.deepEqual(lines(p, "marathon-pine"), []);
});

test("the division audit names the other shop's cells as the rule working, not as a missing keep", () => {
  const p = plan({ stock: {}, seats: bothSeated(), owners: { t1: { shop: "concrete", why: "units", at: ISO } } });
  const audit = p.exceptions.divisionPolicy;
  assert.deepEqual(audit.items.filter((m) => m.loc === "marathon-pine" && m.pid === "t1"), []);
  assert.equal(audit.perLoc["marathon-pine"].products, 1, "the audit did look at Pine's seat");
  assert.equal(audit.perLoc["marathon-pine"].correct, 1);
});

test("with no owners handed in (the key's rollback: delete refill_engine/divisionOwner) the plan is the old one", () => {
  const seats = bothSeated();
  const a = plan({ stock: {}, seats, owners: {} });
  const b = computeRefillPlan({
    nowMs: NOW, config: config(), targets: {}, products, openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    stock: { central: CENTRAL, hub3: {}, concrete: {}, "marathon-pine": {} }, network: reg.SEED_REGISTRY, seats,
  });
  assert.deepEqual(a.intents.map((i) => [i.dest, i.sizeKey, i.qty]).sort(), b.intents.map((i) => [i.dest, i.sizeKey, i.qty]).sort());
});
