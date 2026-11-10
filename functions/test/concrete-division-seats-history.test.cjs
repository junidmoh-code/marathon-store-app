// ─── SEATING COVERS SOLD-OUT PRODUCTS (Junid, 10 Nov 2026) ───────────────────
// A product is seated at Pine, Concrete or Hub 3 by an existing cell (zero
// included) or any sold/received/return/transfer movement there since 30 Oct
// 2026 — not only by a cell holding units. A release still wins, and leaves a
// tombstone so the product's leftover zero cells do not seat it again.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const dv = require("../lib/concrete-division.cjs");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const { FOOTWEAR_CATEGORY_KEYS } = require("../lib/policy-resolve.cjs");

const ISO = "2026-11-10T09:00:00.000Z";
const zero = () => ({ qty: 0, v: 1, mv: "m", lastType: "sale" });
const units = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_in" });
const mv = (o) => ({ productId: "t1", qty: 1, ts: "2026-11-05T10:00:00.000Z", ...o });

test("a sold-out cell (zero) seats the product at a shop", () => {
  const r = dv.planSeats({ rawStock: { concrete: { t1: { M: zero() } } }, seats: {}, movements: [], nowIso: ISO });
  assert.deepEqual(r.effective.concrete.t1, { via: "cell", at: ISO });
  assert.deepEqual(r.writes, { "concrete/t1": { via: "cell", at: ISO } });
});

test("each seating movement since 30 Oct seats a product with no cell left", () => {
  for (const m of [
    mv({ type: "sold", from: "marathon-pine", to: "customer" }),
    mv({ type: "received", from: "central", to: "marathon-pine" }),
    mv({ type: "return", from: "customer", to: "marathon-pine" }),
    mv({ type: "transfer_out", from: "central", to: "marathon-pine", link: { refillId: "r1" } }),
  ]) {
    const r = dv.planSeats({ rawStock: {}, seats: {}, movements: [m], nowIso: ISO });
    assert.deepEqual(r.effective["marathon-pine"].t1, { via: "history", at: ISO }, m.type);
  }
});

test("a movement before 30 Oct, or one somewhere else, seats nothing", () => {
  const old = dv.planSeats({ rawStock: {}, seats: {}, movements: [mv({ type: "sold", from: "concrete", ts: "2026-10-29T23:59:59.000Z" })], nowIso: ISO });
  assert.equal(old.effective.concrete.t1, undefined);
  const elsewhere = dv.planSeats({ rawStock: {}, seats: {}, movements: [mv({ type: "sold", from: "hub2" })], nowIso: ISO });
  assert.deepEqual(elsewhere.writes, {});
});

test("a count adjustment alone is not a seating movement", () => {
  const r = dv.planSeats({ rawStock: {}, seats: {}, movements: [mv({ type: "adjustment", to: "concrete" })], nowIso: ISO });
  assert.equal(r.effective.concrete.t1, undefined);
});

test("a product moved out by a person is not seated again off its zero cells", () => {
  const out = mv({ type: "transfer_out", from: "concrete", to: "central", ts: "2026-11-09T10:00:00.000Z" });
  const r = dv.planSeats({ rawStock: { concrete: { t1: { M: zero() } } }, seats: {}, movements: [out], nowIso: ISO });
  assert.equal(r.effective.concrete.t1, undefined);
  assert.deepEqual(r.writes, {});
});

test("a release leaves a tombstone, and the tombstone holds after the move ages out of the ledger", () => {
  const seats = { concrete: { t1: { via: "stock", at: "2026-11-01T08:00:00.000Z" } } };
  const out = mv({ type: "transfer_out", from: "concrete", to: "central", ts: "2026-11-09T10:00:00.000Z" });
  const r = dv.planSeats({ rawStock: { concrete: { t1: { M: zero() } } }, seats, movements: [out], nowIso: ISO });
  assert.equal(r.writes["concrete/t1"], null);
  assert.deepEqual(r.releaseWrites["concrete/t1"], { at: ISO, moveTs: "2026-11-09T10:00:00.000Z" });
  // Weeks later: the transfer is no longer in the window, the zero cell remains.
  const later = dv.planSeats({ rawStock: { concrete: { t1: { M: zero() } } }, seats: {}, movements: [], releases: { concrete: { t1: r.releaseWrites["concrete/t1"] } }, nowIso: "2026-12-30T09:00:00.000Z" });
  assert.equal(later.effective.concrete.t1, undefined);
});

test("something new after the release seats it again and clears the tombstone", () => {
  const releases = { concrete: { t1: { at: ISO, moveTs: "2026-11-09T10:00:00.000Z" } } };
  const sale = mv({ type: "sold", from: "concrete", ts: "2026-11-11T10:00:00.000Z" });
  const r = dv.planSeats({ rawStock: { concrete: { t1: { M: zero() } } }, seats: {}, movements: [sale], releases, nowIso: "2026-11-11T11:00:00.000Z" });
  assert.equal(r.effective.concrete.t1.via, "cell");
  assert.equal(r.releaseWrites["concrete/t1"], null);
  // Units arriving always seat, tombstone or not.
  const back = dv.planSeats({ rawStock: { concrete: { t1: { M: units(2) } } }, seats: {}, movements: [], releases, nowIso: ISO });
  assert.equal(back.effective.concrete.t1.via, "stock");
});

test("an existing seat is never rewritten (no churn each scan)", () => {
  const seats = { concrete: { t1: { via: "solve", at: "2026-11-02T08:00:00.000Z" } } };
  const r = dv.planSeats({ rawStock: { concrete: { t1: { M: zero() } } }, seats, movements: [mv({ type: "sold", from: "concrete" })], nowIso: ISO });
  assert.deepEqual(r.writes, {});
  assert.equal(r.seated, 0);
});

test("a sold-out seated shop product asks Central for its keep; a Seating switch-off still wins", () => {
  const products = { t1: { id: "t1", name: "Tee", category: "Clothing", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M"] } };
  const config = {
    routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
    mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
    ruleBasedTargets: true, maxIntentsPerRun: 500, maxFootwearIntentsPerRun: 500,
    concreteDivision: { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: false, perSize: 2, oneSize: 10 } },
    policyGroups: { "footwear-all": { armed: true, memberCategoryKeys: FOOTWEAR_CATEGORY_KEYS.slice(), policy: { perSize: true } } },
  };
  const stock = { central: { t1: { S: { qty: 9, v: 1 }, M: { qty: 9, v: 1 } } }, hub3: {}, concrete: {}, "marathon-pine": {} };
  const { effective } = dv.planSeats({ rawStock: stock, seats: {}, movements: [mv({ type: "sold", from: "concrete" })], nowIso: ISO });
  const run = (targets) => computeRefillPlan({ nowMs: Date.parse(ISO), config, targets, stock, products, openIndex: {}, refillRequests: {}, orders: {}, movements: [], network: reg.SEED_REGISTRY, seats: effective });
  assert.deepEqual(run({}).intents.filter((i) => i.dest === "concrete").map((i) => `${i.sizeKey}:${i.qty}`).sort(), ["M:2", "S:2"]);
  const off = { concrete: { t1: { S: { target: 0, minQty: 0 }, M: { target: 0, minQty: 0 } } } };
  assert.deepEqual(run(off).intents.filter((i) => i.dest === "concrete"), []);
});

// ── Review fixes (Sonnet architect + Fable, PR #884) ─────────────────────────
test("a product moved out BEFORE any tombstone existed gets one, from the ledger while the move is in the window", () => {
  const out = mv({ type: "transfer_out", from: "concrete", to: "central", ts: "2026-11-03T12:53:00.000Z" });
  const r = dv.planSeats({ rawStock: { concrete: { t1: { M: zero() } } }, seats: {}, movements: [out], nowIso: ISO });
  assert.equal(r.effective.concrete.t1, undefined);
  assert.deepEqual(r.releaseWrites["concrete/t1"], { at: ISO, moveTs: "2026-11-03T12:53:00.000Z" });
  // …and once the move has aged out, the tombstone keeps it unseated.
  const later = dv.planSeats({ rawStock: { concrete: { t1: { M: zero() } } }, seats: {}, movements: [], releases: { concrete: { t1: r.releaseWrites["concrete/t1"] } }, nowIso: "2027-01-10T09:00:00.000Z" });
  assert.equal(later.effective.concrete.t1, undefined);
});

test("with the move already out of the ledger, the cells' own transfer-out stamp still says moved out", () => {
  const stampedOut = { qty: 0, v: 1, mv: "-P5WT4_1oaXxd:p:_", lastType: "transfer_out" };
  const r = dv.planSeats({ rawStock: { concrete: { t1: { _: stampedOut } } }, seats: {}, movements: [], nowIso: ISO });
  assert.equal(r.effective.concrete.t1, undefined);
  assert.deepEqual(r.releaseWrites["concrete/t1"], { at: ISO, moveTs: null });
  // A refill leaving (an "rrf_" movement) is the location doing its job: it seats.
  const refilled = { qty: 0, v: 1, mv: "rrf_-P5kiq", lastType: "transfer_out" };
  const s = dv.planSeats({ rawStock: { hub3: { t1: { M: refilled } } }, seats: {}, movements: [], nowIso: ISO });
  assert.equal(s.effective.hub3.t1.via, "cell");
  // A sale since the stamp seats it again.
  const sold = dv.planSeats({ rawStock: { concrete: { t1: { _: stampedOut } } }, seats: {}, movements: [mv({ type: "sold", from: "concrete" })], nowIso: ISO });
  assert.equal(sold.effective.concrete.t1.via, "cell");
});

test("a movement naming a deleted product, or a product id that is not a valid key, seats nothing", () => {
  const r = dv.planSeats({ rawStock: {}, seats: {}, products: { t1: {} }, movements: [mv({ type: "sold", from: "concrete", productId: "gone" }), mv({ type: "sold", from: "concrete", productId: "a.b" })], nowIso: ISO });
  assert.deepEqual(r.writes, {});
  const ok = dv.planSeats({ rawStock: {}, seats: {}, products: { t1: {} }, movements: [mv({ type: "sold", from: "concrete" })], nowIso: ISO });
  assert.ok(ok.effective.concrete.t1);
});
