// ─── MARATHON DIVISION UNCHANGED — pinned before the Hub 3 policy work (Junid, 9 Nov 2026)
//
// Hub 1, Hub 2, Marathon PE and Trophy stay byte-for-byte unchanged. This golden
// is the live engine config over a generated Marathon world, hashed per
// destination. It was recorded on the engine AS IT WAS before any Hub 3 policy
// code landed, so every later commit is measured against that engine.
//
// The second half adds a full Concrete division to the same world (stock, a
// Hub 3 / shop policy, seats, open Section 1 work). Whatever that division does,
// the Marathon slice of the plan must not move — the division pulls on Central
// through the same gate, but only ever after Marathon's destinations were dealt.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const CONFIG = require("./fixtures/marathon-pin-config.json");

const NOW_MS = Date.parse("2026-11-09T12:00:00.000Z");
const MARATHON = ["hub1", "hub2", "marathon-pe", "trophy"];
const S1 = ["hub3", "marathon-pine", "concrete"];
const clone = (v) => JSON.parse(JSON.stringify(v));

// Small deterministic PRNG: no Math.random in a golden.
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function world(seed, n = 240) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const products = {};
  const stock = { central: {}, hub1: {}, hub2: {}, "marathon-pe": {}, trophy: {} };
  const SHOE = ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11", "12"];
  const CL = ["S", "M", "L", "XL", "XXL"];
  const kinds = [
    { key: "sneakers", sizes: SHOE, category: "Footwear", subcategory: "Sneakers", productType: "sneaker", locs: ["hub1", "hub2"] },
    { key: "soccer-boots", sizes: SHOE, category: "Footwear", subcategory: "Soccer Boots", productType: "sneaker", locs: ["hub1", "hub2"] },
    { key: "slides", sizes: SHOE, category: "Footwear", subcategory: "Slides", productType: "sneaker", locs: ["hub2"] },
    { key: "hoodies", sizes: CL, category: "Clothing", subcategory: "Hoodies", productType: "clothing", locs: ["hub2", "marathon-pe", "trophy"] },
    { key: "t-shirts", sizes: CL, category: "Clothing", subcategory: "T-Shirts", productType: "clothing", locs: ["hub2", "trophy"] },
    { key: "perfumes", sizes: ["_"], category: "Perfume", subcategory: "Perfume", locs: ["hub2", "marathon-pe"] },
    { key: "caps-beanies", sizes: ["_"], category: "Accessories", subcategory: "Caps", locs: ["hub2", "marathon-pe"] },
    { key: "bags", sizes: ["_"], category: "Accessories", subcategory: "Bags", locs: ["hub2", "trophy"] },
  ];
  const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "count", updatedAt: "2026-11-01T08:00:00.000Z" });
  const enc = (s) => String(s).replace(/\./g, "_");
  for (let i = 0; i < n; i++) {
    const pid = `p${seed}_${i}`;
    const k = pick(kinds);
    products[pid] = { id: pid, name: `${k.key} ${i}`, sizes: k.sizes, categoryKey: k.key, category: k.category, subcategory: k.subcategory, ...(k.productType ? { productType: k.productType } : {}) };
    const central = {};
    for (const s of k.sizes) if (r() < 0.8) central[enc(s)] = cell(Math.floor(r() * 7));
    if (Object.keys(central).length) stock.central[pid] = central;
    for (const loc of k.locs) {
      if (r() < 0.25) continue;
      const row = {};
      for (const s of k.sizes) if (r() < 0.85) row[enc(s)] = cell(Math.floor(r() * 5));
      if (Object.keys(row).length) stock[loc][pid] = row;
    }
  }
  return { products, stock };
}

function plan({ config, stock, products, network = reg.SEED_REGISTRY, openIndex = {}, refillRequests = {}, seats }) {
  return computeRefillPlan({ nowMs: NOW_MS, config, targets: {}, stock, products, openIndex, refillRequests, orders: {}, movements: [], network, ...(seats ? { seats } : {}) });
}

const marathonSlice = (p) => {
  const only = (list, f) => list.filter((x) => MARATHON.includes(f(x))).map((x) => JSON.stringify(x)).sort();
  return {
    intents: only(p.intents, (i) => i.dest),
    closes: only(p.closes || [], (c) => c.dest),
    resizes: only(p.resizes || [], (c) => c.dest),
  };
};
const hashOf = (slice) => crypto.createHash("sha256").update(JSON.stringify(slice)).digest("hex").slice(0, 32);

const GOLDEN = require("./fixtures/marathon-pin-golden.json");

for (const seed of [11, 42, 2026]) {
  test(`Marathon plan is the recorded golden (world ${seed})`, () => {
    const { products, stock } = world(seed);
    const p = plan({ config: clone(CONFIG), stock, products });
    assert.equal(hashOf(marathonSlice(p)), GOLDEN[seed], "the Marathon-division plan moved");
    assert.ok(p.intents.length > 0, "the world must actually raise work, or the pin proves nothing");
  });
}

// A whole Concrete division bolted onto the same world.
function withConcreteDivision(w, seed) {
  const r = rng(seed + 7);
  const stock = { ...w.stock, hub3: {}, "marathon-pine": {}, concrete: {} };
  const seats = { hub3: {}, "marathon-pine": {}, concrete: {} };
  const t = (qty) => ({ qty, v: 1, mv: "m", lastType: "count", updatedAt: "2026-11-01T08:00:00.000Z", trusted: true, trustedVia: "count", trustedAt: "2026-11-01T08:00:00.000Z" });
  const u = (qty) => ({ qty, v: 1, mv: "m", lastType: "count", updatedAt: "2026-11-01T08:00:00.000Z" });
  for (const [pid, p] of Object.entries(w.products)) {
    const enc = (s) => String(s).replace(/\./g, "_");
    if (r() < 0.4) { stock.hub3[pid] = Object.fromEntries(p.sizes.map((s) => [enc(s), r() < 0.5 ? t(Math.floor(r() * 3)) : u(Math.floor(r() * 3))])); seats.hub3[pid] = { via: "stock", at: "2026-11-09T10:00:00.000Z", ...(r() < 0.3 ? { owner: "concrete" } : {}) }; }
    if (r() < 0.3) { stock["marathon-pine"][pid] = Object.fromEntries(p.sizes.map((s) => [enc(s), t(Math.floor(r() * 3))])); seats["marathon-pine"][pid] = { via: "stock", at: "2026-11-09T10:00:00.000Z" }; }
    if (r() < 0.3) { stock.concrete[pid] = Object.fromEntries(p.sizes.map((s) => [enc(s), t(Math.floor(r() * 3))])); seats.concrete[pid] = { via: "stock", at: "2026-11-09T10:00:00.000Z" }; }
  }
  return { stock, seats };
}

const DIVISION_CONFIG = (base) => {
  const c = clone(base);
  c.concreteDivision = { shopOnly: { perSize: 2, oneSize: 5 }, fromHub3: { perSize: 1, oneSize: 5, askAt: 0 }, hub3Keep: { on: true, perSize: 2, oneSize: 10 } };
  c.policyGroups["footwear-all"].policy.hub3 = { target: 3, minQty: 2, reorderPoint: 1, carriedOnly: true };
  return c;
};

for (const seed of [11, 42, 2026]) {
  test(`a full Concrete division leaves the Marathon plan untouched (world ${seed})`, () => {
    const w = world(seed);
    const before = marathonSlice(plan({ config: clone(CONFIG), stock: w.stock, products: w.products }));
    const d = withConcreteDivision(w, seed);
    const after = marathonSlice(plan({ config: DIVISION_CONFIG(CONFIG), stock: d.stock, products: w.products, seats: d.seats }));
    // Section 1's demand is planned AFTER Marathon's in the same scan, so with
    // no Section 1 locks open at scan start Marathon's slice is identical.
    assert.deepEqual(after, before);
  });
}

// THE LIVE SHAPE (10 Nov 2026): uncounted shop shelves, sold-out seats, the
// Hub 3 clothing keep OFF. The seated-shelf lift, the sold-out seats and the
// per-size Hub 3 rule all fire here; Marathon's slice must still not move.
function liveShapeDivision(w, seed) {
  const r = rng(seed + 13);
  const stock = { ...w.stock, hub3: {}, "marathon-pine": {}, concrete: {} };
  const seats = { hub3: {}, "marathon-pine": {}, concrete: {} };
  const u = (qty) => ({ qty, v: 1, mv: "m", lastType: "transfer_in", updatedAt: "2026-11-01T08:00:00.000Z" });
  const enc = (s) => String(s).replace(/\./g, "_");
  for (const [pid, p] of Object.entries(w.products)) {
    if (r() < 0.3) { stock.hub3[pid] = Object.fromEntries(p.sizes.filter(() => r() < 0.5).map((s) => [enc(s), u(Math.floor(r() * 3))])); seats.hub3[pid] = { via: "stock", at: "2026-11-09T10:00:00.000Z" }; }
    for (const shop of ["marathon-pine", "concrete"]) {
      if (r() < 0.35) {
        stock[shop][pid] = Object.fromEntries(p.sizes.filter(() => r() < 0.6).map((s) => [enc(s), u(Math.floor(r() * 3))]));
        seats[shop][pid] = { via: "stock", at: "2026-11-09T10:00:00.000Z" };
      } else if (r() < 0.1) seats[shop][pid] = { via: "history", at: "2026-11-09T10:00:00.000Z" };
    }
  }
  return { stock, seats };
}

for (const seed of [11, 42, 2026]) {
  test(`the live division shape (uncounted shelves, Hub 3 keep off) leaves the Marathon plan untouched (world ${seed})`, () => {
    const w = world(seed);
    // Uncapped on both sides, so the division's lines are actually planned (the
    // live cap is dealt to Marathon first and can leave Section 1 nothing here).
    const uncap = (c) => ({ ...c, maxIntentsPerRun: 100000, maxFootwearIntentsPerRun: 100000 });
    const before = marathonSlice(plan({ config: uncap(clone(CONFIG)), stock: w.stock, products: w.products }));
    const d = liveShapeDivision(w, seed);
    const cfg = uncap(DIVISION_CONFIG(CONFIG));
    cfg.concreteDivision.hub3Keep.on = false;
    const p = plan({ config: cfg, stock: d.stock, products: w.products, seats: d.seats });
    assert.ok(p.intents.some((i) => i.dest === "concrete"), "the division must actually raise Concrete work, or the pin proves nothing");
    assert.deepEqual(marathonSlice(p), before);
    // …and under the live caps (Marathon dealt first).
    const liveCfg = DIVISION_CONFIG(CONFIG); liveCfg.concreteDivision.hub3Keep.on = false;
    const capped = plan({ config: liveCfg, stock: d.stock, products: w.products, seats: d.seats });
    assert.deepEqual(marathonSlice(capped), marathonSlice(plan({ config: clone(CONFIG), stock: w.stock, products: w.products })));
  });
}

// THE 12 NOV 2026 MODEL (Junid): Central supplies every Pine/Concrete
// non-footwear item straight to the shop (2 per size / 5 per design), Hub 3 is
// sneakers only (keep 2, ask at 1). Pinned BEFORE that engine change landed:
// with the live shape still holding Hub 3 clothing, owner seats and open Hub 3
// clothing locks, the Marathon slice must be exactly the no-division plan —
// under the new config now, and under whatever the engine does with it later.
const NEW_MODEL_CONFIG = (base) => {
  const c = clone(base);
  c.concreteDivision = { shopOnly: { perSize: 2, oneSize: 5 } };
  c.policyGroups["footwear-all"].policy.hub3 = { target: 2, minQty: 1, reorderPoint: 1, carriedOnly: true };
  return c;
};
function newModelDivision(w, seed) {
  const r = rng(seed + 29);
  const d = liveShapeDivision(w, seed);
  // Hub 3 non-footwear seats with an owning shop (the chooser being removed).
  // No Section 1 lock is open at scan start (as above): an open lock rightly
  // holds Central units, which is availability, not policy.
  for (const [pid, p] of Object.entries(w.products)) {
    if (!d.seats.hub3[pid] || p.category === "Footwear") continue;
    if (r() < 0.5) d.seats.hub3[pid].owner = r() < 0.5 ? "concrete" : "marathon-pine";
  }
  return d;
}

for (const seed of [11, 42, 2026]) {
  test(`the 12 Nov model (shop-only from Central, Hub 3 sneakers only) leaves the Marathon plan untouched (world ${seed})`, () => {
    const w = world(seed);
    const uncap = (c) => ({ ...c, maxIntentsPerRun: 100000, maxFootwearIntentsPerRun: 100000 });
    const d = newModelDivision(w, seed);
    const before = marathonSlice(plan({ config: uncap(clone(CONFIG)), stock: w.stock, products: w.products }));
    const p = plan({ config: uncap(NEW_MODEL_CONFIG(CONFIG)), stock: d.stock, products: w.products, seats: d.seats });
    assert.ok(p.intents.some((i) => i.dest === "concrete" || i.dest === "marathon-pine"), "the division must raise shop work, or the pin proves nothing");
    assert.deepEqual(marathonSlice(p), before);
    const capped = plan({ config: NEW_MODEL_CONFIG(CONFIG), stock: d.stock, products: w.products, seats: d.seats });
    assert.deepEqual(marathonSlice(capped), marathonSlice(plan({ config: clone(CONFIG), stock: w.stock, products: w.products })));
    assert.equal(hashOf(marathonSlice(plan({ config: clone(CONFIG), stock: w.stock, products: w.products }))), GOLDEN[seed]);
  });
}

test("the Marathon destinations are exactly the config routes, and Section 1 is not among them", () => {
  assert.deepEqual(Object.keys(CONFIG.routes).sort(), [...MARATHON].sort());
  for (const loc of S1) assert.equal(CONFIG.routes[loc], undefined);
  assert.equal(CONFIG.policyGroups["footwear-all"].policy.hub3, undefined, "the live group has no Hub 3 leg in the fixture");
});
