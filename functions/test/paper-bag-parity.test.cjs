// ─── PARITY: the paper-bag change moves NOTHING for any other category ───────
//
// Junid's rule for this change: sneaker, perfume and clothing requests must be
// identical before and after. "Before" is not a memory here, it is code:
// test/fixtures/refill-engine.pre-paper-bags.cjs is the engine as it stood on
// main before the change. Both engines are run over the same random snapshots
// — sneakers on a per-size policy, perfumes with an ask-at, clothing on rows
// and on the size run, handbags and caps on one-size entries, with open
// requests, partial sends and short sources — and every plan must match field
// for field: intents, resizes, closes, exceptions.
//
// The fuzz is held honest by its own counters: if it stops producing intents,
// resizes and closes in volume it fails, rather than passing over nothing.
//
// Run: cd functions && node --test test/paper-bag-parity.test.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const live = require("../lib/refill-engine.cjs");
const frozen = require("./fixtures/refill-engine.pre-paper-bags.cjs");

const NOW = Date.parse("2026-10-16T13:00:00.000Z");
const iso = (minsAgo) => new Date(NOW - minsAgo * 60e3).toISOString();

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const SHOE_RUN = { 6: { target: 3, minQty: 2, reorderPoint: 1 }, 7: { target: 3, minQty: 2, reorderPoint: 1 }, "5_5": { target: 2, minQty: 1 } };
const POLICY = {
  perfumes: { hub2: { target: 10, reorderPoint: 5, minQty: 5 }, "marathon-pe": { target: 8, reorderPoint: 3, minQty: 4 } },
  bags: { hub2: { target: 4, reorderPoint: 0, minQty: 2 }, trophy: { target: 2, reorderPoint: 0, minQty: 1 } },
  "caps-beanies": { hub2: { target: 10, minQty: 5 }, "marathon-pe": { target: 5, minQty: 3, carriedOnly: true } },
  sneakers: { perSize: true, hub1: { sizes: SHOE_RUN, carriedOnly: true }, hub2: { sizes: SHOE_RUN, carriedOnly: true } },
  // An armed paper-bag entry is present in every snapshot, so the parity
  // also proves its mere existence changes nothing for anyone else.
  "paper-bags": { hub2: { target: 50, reorderPoint: 10, minQty: 25 }, trophy: { target: 50, reorderPoint: 10, minQty: 25, carriedOnly: true } },
};

const KINDS = [
  { cat: "perfumes", name: "Dior Sauvage EDT", sizes: ["_"], extra: { category: "Perfume", subcategory: "Perfume" } },
  { cat: "bags", name: "Louis Vuitton Keepall bag", sizes: ["_"], extra: { category: "Accessories", subcategory: "Bags", productType: "clothing" } },
  { cat: "bags", name: "Boss back bag", sizes: ["_"], extra: { category: "Accessories", subcategory: "Bags", productType: "clothing" } },
  { cat: "caps-beanies", name: "Nike beanie black", sizes: ["_"], extra: { category: "Clothing", subcategory: "Caps & Hats", productType: "clothing" } },
  { cat: "sneakers", name: "Nike Air Force 1", sizes: ["5.5", "6", "7"], extra: { category: "Footwear", subcategory: "Sneakers", productType: "sneaker" } },
  { cat: null, name: "Adidas campus black", sizes: ["6", "7"], extra: { category: "Footwear", subcategory: "Sneakers", productType: "sneaker" } },
  { cat: "t-shirts", name: "Nike tee white", sizes: ["S", "M", "L"], extra: { category: "Clothing", subcategory: "T-Shirts", productType: "clothing" } },
  { cat: "hoodies", name: "Essentials hoodie", sizes: ["M", "L", "XL"], extra: { category: "Clothing", subcategory: "Hoodies", productType: "clothing" } },
];
const LOCS = ["central", "hub1", "hub2", "marathon-pe", "trophy"];
const DESTS = ["hub1", "hub2", "marathon-pe", "trophy"];
const ROUTES = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };
const enc = (s) => String(s).replace(/\./g, "_");

function scenario(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const products = {}, stock = {}, targets = {}, openIndex = {}, refillRequests = {}, orders = {};
  for (const l of LOCS) stock[l] = {};
  const n = 3 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const k = pick(KINDS);
    const pid = `p${seed}_${i}`;
    products[pid] = { id: pid, name: k.name, sizes: k.sizes.slice(), ...k.extra, ...(k.cat ? { categoryKey: k.cat } : {}) };
    for (const l of LOCS) {
      if (r() < 0.35) continue;
      stock[l][pid] = {};
      for (const s of k.sizes) {
        if (r() < 0.25) continue;
        const big = l === "central" ? 40 : l === "hub2" || l === "hub1" ? 15 : 6;
        stock[l][pid][enc(s)] = { qty: Math.floor(r() * big) - (r() < 0.05 ? 2 : 0) };
      }
    }
    // Explicit rows, with and without an ask-at, sometimes a 0 (switch-off).
    for (const d of DESTS) {
      if (r() < 0.75) continue;
      targets[d] = targets[d] || {};
      targets[d][pid] = {};
      for (const s of k.sizes) {
        const t = pick([0, 2, 3, 5, 12, 30]);
        targets[d][pid][enc(s)] = { target: t, minQty: Math.ceil(t / 2), ...(r() < 0.5 ? { reorderPoint: pick([0, 1, 3, 10]) } : {}) };
      }
    }
    // Open engine requests, some partially sent, some on shop legs with orders.
    for (const d of DESTS) {
      if (r() < 0.7) continue;
      const s = pick(k.sizes);
      const sk = enc(s);
      const rid = `rr_${pid}_${d}`;
      const qty = 1 + Math.floor(r() * 25);
      const shop = d === "marathon-pe" || d === "trophy";
      const sent = r() < 0.3 ? Math.floor(r() * qty) : 0;
      const created = iso(30 + Math.floor(r() * 600));
      const lock = { refillId: rid, qty, source: ROUTES[d], createdAt: created, runId: "x" };
      if (shop) {
        const oid = `R0${i}${d.length}`;
        lock.orderId = oid; lock.orderCreatedAt = created;
        orders[oid] = { customerName: "Shop Refill", autoRefill: true, productId: pid, size: s, createdAt: created, clothingRefillStatus: r() < 0.15 ? "available" : null, status: "incoming", qty };
      }
      openIndex[d] = openIndex[d] || {};
      openIndex[d][pid] = openIndex[d][pid] || {};
      openIndex[d][pid][sk] = lock;
      refillRequests[rid] = {
        status: r() < 0.1 ? "cancelled" : "open", productId: pid, size: s, qty: qty - sent,
        ...(sent ? { sentQty: sent } : {}), requestingLocation: d, createdAt: created,
        createdFrom: { engine: true, source: ROUTES[d] },
      };
    }
  }
  const config = {
    enabled: true,
    mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
    routes: ROUTES, ruleBasedTargets: true,
    maxIntentsPerRun: 200, maxFootwearIntentsPerRun: 200, maxUnitsPerIntent: pick([3, 20]),
    defaultRunByStore: { hub2: { S: 2, M: 3, L: 3, XL: 2 }, "marathon-pe": { S: 2, M: 3, L: 3, XL: 2 }, trophy: { S: 2, M: 3, L: 3, XL: 2 } },
    categoryPolicy: POLICY,
  };
  return {
    nowMs: NOW, config, products, stock, targets, openIndex, refillRequests, orders,
    movements: [], targetDecisions: {}, rejectStreak: {}, retryState: {}, heldLines: {},
  };
}

// Deep copy per engine: neither may see the other's mutations.
const clone = (o) => JSON.parse(JSON.stringify(o));
const shape = (plan) => JSON.parse(JSON.stringify({
  intents: plan.intents, resizes: plan.resizes, closes: plan.closes,
  satisfiedClosures: plan.satisfiedClosures, exceptions: plan.exceptions, stats: plan.stats,
}));

test("PARITY: 1,500 random snapshots with no paper bag → identical plans before and after", () => {
  let intents = 0, resizes = 0, closes = 0, units = 0;
  for (let seed = 1; seed <= 1500; seed++) {
    const snap = scenario(seed);
    const a = shape(frozen.computeRefillPlan(clone(snap)));
    const b = shape(live.computeRefillPlan(clone(snap)));
    assert.deepEqual(b, a, `seed ${seed} diverged`);
    intents += a.intents.length; resizes += a.resizes.length; closes += a.closes.length;
    units += a.intents.reduce((t, i) => t + i.qty, 0);
  }
  // The fuzz must be exercising every path it claims to.
  assert.ok(intents > 5000, `intents ${intents}`);
  assert.ok(resizes > 800, `resizes ${resizes}`);
  assert.ok(closes > 5000, `closes ${closes}`);
  assert.ok(units > intents, `units ${units}`);
});

test("PARITY: resolveTarget agrees on every non-paper-bag cell", () => {
  let cells = 0;
  for (let seed = 2001; seed <= 2400; seed++) {
    const snap = scenario(seed);
    const ctx = { config: snap.config, products: snap.products, stock: snap.stock, targets: snap.targets };
    for (const pid of Object.keys(snap.products)) {
      for (const d of DESTS) {
        for (const s of [...snap.products[pid].sizes, "_"]) {
          assert.deepEqual(live.resolveTarget(ctx, d, pid, s), frozen.resolveTarget(ctx, d, pid, s), `${seed} ${d} ${pid} ${s}`);
          cells++;
        }
      }
    }
  }
  assert.ok(cells > 10000, `cells ${cells}`);
});
