// ─── STOCK AUDIT — pure list-building tests (node --test) ────────────────────
// Covers lib/stock-audit.cjs: the config validator, the once-a-day gate, the
// Tab A source/ordering rules, the two Tab B signals, and — the one that
// matters most — a simulated multi-cycle proof that the rotation covers every
// product and starves none. Run: cd functions && npm test
//
// The fixtures are deliberately NON-TRIVIAL: every assertion below would still
// pass against an empty list if the fixture produced nothing, so each test
// pins a positive row count as well as its shape.

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const sa = require("../lib/stock-audit.cjs");

// ── fixture ──────────────────────────────────────────────────────────────────
// A small but realistic slice: two clothing products at the shop, one that is
// also short at Hub 2, one accessory (productType "clothing", no letter sizes —
// in scope by design), and one sneaker that must never appear anywhere.
const PRODUCTS = {
  tee:   { name: "Nike Tee Black",        productType: "clothing" },
  hood:  { name: "Adidas Hoodie Grey",    productType: "clothing" },
  belt:  { name: "Lacoste Belt Brown",    productType: "clothing" },   // accessory, one size
  shoe:  { name: "Air Force 1 White",     category: "Footwear", productType: "sneaker" },
};

const ROUTES = { "marathon-pe": "hub2", trophy: "hub2", hub2: "central", hub1: "central" };

const STOCK = {
  "marathon-pe": {
    tee:  { S: { qty: 4 }, M: { qty: 0 }, L: { qty: -2 } },
    hood: { M: { qty: 3 } },
    belt: { _: { qty: 6 } },
  },
  trophy: { tee: { S: { qty: 2 } } },
  // hub1 still believes it has three of the size it refused — the phantom.
  hub1: { shoe: { 9: { qty: 3 }, 6: { qty: 1 } }, boot: { 7: { qty: 0 }, 8: { qty: 0 }, 10: { qty: 0 } } },
  hub2: { shoe: { 11: { qty: 0 } } },
  hub3: { boot: { 9: { qty: 0 } } },
};

const NOW = Date.parse("2026-09-08T09:00:00.000Z");   // Tue 11:00 SAST
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// Live-shaped orders. A hub answers a customer with "sold out"
// (outOfStockAt) or "coming tomorrow" (comingTomorrowAt); readyAt/collectedAt
// mean it was found and handed over.
const ord = (o) => ({ productType: "sneaker", placedAtHub: "hub1", ...o });
const ORDERS = {
  // hub1 said sold out while its own cell reads 3 — the phantom
  "1": ord({ productId: "shoe", productName: "Air Force 1 White", size: "9",
             status: "out_of_stock", outOfStockAt: iso(2 * 3600e3) }),
  // the same size refused again an hour later — ONE shelf, not two rows
  "2": ord({ productId: "shoe", productName: "Air Force 1 White", size: "9",
             status: "out_of_stock", outOfStockAt: iso(1 * 3600e3) }),
  // coming tomorrow, still pending
  "3": ord({ productId: "boot", productName: "Timberland Motion 6", size: "7",
             status: "coming_tomorrow", comingTomorrowAt: iso(3 * 3600e3) }),
  // told sold out, then FOUND and collected — nothing left to check
  "4": ord({ productId: "boot", productName: "Timberland Motion 6", size: "8",
             status: "collected", outOfStockAt: iso(4 * 3600e3), collectedAt: iso(1e3) }),
  // told coming tomorrow, then made ready — also resolved
  "5": ord({ productId: "boot", productName: "Timberland Motion 6", size: "10",
             status: "ready", comingTomorrowAt: iso(4 * 3600e3), readyAt: iso(1e3) }),
  // another hub's shelf
  "6": ord({ placedAtHub: "hub2", productId: "shoe", productName: "Air Force 1 White",
             size: "11", status: "out_of_stock", outOfStockAt: iso(1 * 3600e3) }),
  // CLOTHING — out of scope for this tab entirely
  "7": ord({ productType: "clothing", productId: "tee", productName: "Nike Tee Black",
             size: "L", status: "out_of_stock", outOfStockAt: iso(1 * 3600e3) }),
  // outside the lookback window
  "8": ord({ productId: "shoe", productName: "Air Force 1 White", size: "6",
             status: "out_of_stock", outOfStockAt: iso(40 * 3600e3) }),
  // an ordinary order nobody was turned away from
  "9": ord({ productId: "shoe", productName: "Air Force 1 White", size: "12", status: "incoming" }),
  // hub named by the legacy `hub` field only
  "10": ord({ placedAtHub: null, hub: "hub3", productId: "boot", productName: "Timberland Motion 6",
              size: "9", status: "out_of_stock", outOfStockAt: iso(1 * 3600e3) }),
};

const MOVEMENTS = [
  { type: "sold", from: "marathon-pe", productId: "tee", size: "S", ts: iso(5 * 864e5) },
  { type: "sold", from: "marathon-pe", productId: "tee", size: "L", ts: iso(40 * 864e5) },   // outside 21d
  { type: "sold", from: "trophy",      productId: "hood", size: "M", ts: iso(2 * 864e5) },   // other store
  { type: "received", to: "marathon-pe", productId: "hood", size: "M", ts: iso(1 * 864e5) }, // not a sale
];

const CFG = sa.auditConfig({ enabled: true });

// ── config ───────────────────────────────────────────────────────────────────
test("auditConfig defaults, and refuses nonsense rather than degrading silently", () => {
  const d = sa.auditConfig(undefined);
  assert.equal(d.enabled, false);                    // absent = off, per the kill switch
  assert.equal(d.batchSize, 30);
  assert.deepEqual(d.rotationDays, ["Mon", "Wed", "Fri"]);
  assert.equal(d.soldWindowDays, 21);

  assert.equal(sa.auditConfig({ enabled: "true" }).enabled, false);       // only true is true
  assert.equal(sa.auditConfig({ batchSize: 0 }).batchSize, 30);
  assert.equal(sa.auditConfig({ batchSize: "45" }).batchSize, 45);        // console types strings
  assert.equal(sa.auditConfig({ batchSize: 99999 }).batchSize, 30);       // out of range → default
  assert.deepEqual(sa.auditConfig({ rotationDays: ["Monday", "Sat"] }).rotationDays, ["Mon", "Sat"]);
  assert.deepEqual(sa.auditConfig({ rotationDays: ["nope"] }).rotationDays, ["Mon", "Wed", "Fri"]);
  assert.deepEqual(sa.auditConfig({ rotationDays: "Mon" }).rotationDays, ["Mon", "Wed", "Fri"]);
});

// ── the once-a-day gate ──────────────────────────────────────────────────────
test("daily pass runs once, at or after the pass hour, idempotently", () => {
  const early = Date.parse("2026-09-08T04:30:00.000Z");   // 06:30 SAST
  const late  = Date.parse("2026-09-08T05:10:00.000Z");   // 07:10 SAST
  assert.equal(sa.shouldRunDailyPass({ nowMs: early, lastPassDate: null }).run, false);
  assert.equal(sa.shouldRunDailyPass({ nowMs: early, lastPassDate: null }).why, "before_pass_hour");

  const first = sa.shouldRunDailyPass({ nowMs: late, lastPassDate: "2026-09-07" });
  assert.equal(first.run, true);
  assert.equal(first.saDate, "2026-09-08");
  // the same run again, and every later run of the same day
  assert.equal(sa.shouldRunDailyPass({ nowMs: late, lastPassDate: "2026-09-08" }).run, false);
  assert.equal(sa.shouldRunDailyPass({ nowMs: late + 6 * 3600e3, lastPassDate: "2026-09-08" }).run, false);
});

test("a future lastPassDate does not wedge the pass forever", () => {
  const t = Date.parse("2026-09-08T05:10:00.000Z");
  // A hand-edited / clock-skewed stamp from tomorrow. A `<=` comparison would
  // suppress the pass until the date caught up; a !== comparison runs today.
  assert.equal(sa.shouldRunDailyPass({ nowMs: t, lastPassDate: "2026-12-25" }).run, true);
});

test("SA weekday and rotation days", () => {
  assert.equal(sa.saWeekday("2026-09-07"), "Mon");
  assert.equal(sa.saWeekday("2026-09-08"), "Tue");
  assert.equal(sa.isRotationDay("2026-09-07", CFG.rotationDays), true);
  assert.equal(sa.isRotationDay("2026-09-08", CFG.rotationDays), false);
  assert.equal(sa.isRotationDay("2026-09-09", CFG.rotationDays), true);
});

test("saHour reads SAST, not UTC", () => {
  assert.equal(sa.saHour(Date.parse("2026-09-08T05:00:00.000Z")), 7);
  assert.equal(sa.saHour(Date.parse("2026-09-08T22:30:00.000Z")), 0);   // next SA day
});

// ── TAB A — PER HUB, SNEAKERS, THE TWO ANSWERS THAT TURN A CUSTOMER AWAY ─────
test("the hub list is the sneaker lines that hub answered with sold-out or tomorrow", () => {
  const { rows, total } = sa.buildOutOfStock({
    hub: "hub1", nowMs: NOW, cfg: CFG, stock: STOCK, products: PRODUCTS, orders: ORDERS,
  });
  assert.ok(rows.length >= 2, `fixture must produce real rows, got ${rows.length}`);
  assert.equal(total, rows.length);
  const by = Object.fromEntries(rows.map((r) => [r.k, r]));

  // sold out against a cell the hub still believes holds three
  assert.deepEqual(
    { r: by["shoe__9__hub1"].r, q: by["shoe__9__hub1"].q, w: by["shoe__9__hub1"].w, s: by["shoe__9__hub1"].s },
    { r: "out_of_stock", q: 3, w: "hub1", s: "9" });
  // two customers refused the same size is ONE shelf to walk to
  assert.equal(by["shoe__9__hub1"].c, 2);

  assert.equal(by["boot__7__hub1"].r, "coming_tomorrow");
  assert.equal(by["boot__7__hub1"].q, 0);

  // RESOLVED lines are not checks — found and handed over
  assert.equal(by["boot__8__hub1"], undefined, "a collected order is not a shelf to walk to");
  assert.equal(by["boot__10__hub1"], undefined, "an order made ready is not either");
  // out of window, never refused at all, out of scope, another hub's shelf
  assert.equal(by["shoe__6__hub1"], undefined);
  assert.equal(by["shoe__12__hub1"], undefined);
  assert.equal(rows.some((r) => r.p === "tee"), false, "clothing is not in this tab");
  assert.equal(rows.some((r) => r.w !== "hub1"), false, "and neither is another hub's shelf");
});

test("REJECTIONS AND NEGATIVE CELLS ARE NOT IN THIS TAB", () => {
  // The tab is customers turned away, not two warehouses disagreeing. A refill
  // request refused, and a cell gone negative, are both real problems that
  // belong somewhere else.
  const { rows } = sa.buildOutOfStock({
    hub: "hub1", nowMs: NOW, cfg: CFG, products: PRODUCTS,
    stock: { hub1: { shoe: { 4: { qty: -6 } } } }, orders: {},
  });
  assert.deepEqual(rows, [], "a negative cell alone puts nothing on the list");
});

test("each hub gets its own list, and the legacy `hub` field still names one", () => {
  const at = (hub) => sa.buildOutOfStock({ hub, nowMs: NOW, cfg: CFG, stock: STOCK, products: PRODUCTS, orders: ORDERS }).rows;
  assert.deepEqual(at("hub2").map((r) => r.k), ["shoe__11__hub2"]);
  assert.deepEqual(at("hub3").map((r) => r.k), ["boot__9__hub3"]);   // order 10 has only `hub`
  assert.deepEqual(at("central"), []);
});

test("a phantom leads the list, whatever the timestamps say", () => {
  const { rows } = sa.buildOutOfStock({
    hub: "hub1", nowMs: NOW, cfg: CFG, stock: STOCK, products: PRODUCTS, orders: ORDERS,
  });
  assert.equal(rows[0].k, "shoe__9__hub1");
  assert.equal(rows[0].r, "out_of_stock");
  assert.ok(rows[0].q > 0);
  // and the rest follow the freshest answer
  assert.equal(rows[1].k, "boot__7__hub1");
});

test("sold-out outranks coming-tomorrow on one cell, whichever was recorded last", () => {
  const mk = (o) => ({ productType: "sneaker", placedAtHub: "hub1", productId: "shoe", size: "9", ...o });
  const run = (orders) => sa.buildOutOfStock({
    hub: "hub1", nowMs: NOW, cfg: CFG, stock: STOCK, products: PRODUCTS, orders,
  }).rows[0];
  const tom = mk({ comingTomorrowAt: iso(1 * 3600e3) });
  const out = mk({ outOfStockAt: iso(5 * 3600e3) });
  assert.equal(run({ a: out, b: tom }).r, "out_of_stock");
  assert.equal(run({ b: tom, a: out }).r, "out_of_stock");
  assert.equal(run({ a: out, b: tom }).c, 2);
});

test("the hub cap keeps the worst rows and says it truncated", () => {
  const orders = {}, products = {}, hub1 = {};
  for (let i = 0; i < 200; i++) {
    const pid = `p${String(i).padStart(3, "0")}`;
    products[pid] = { name: `Shoe ${i}`, category: "Footwear" };
    hub1[pid] = { 9: { qty: i < 5 ? 2 : 0 } };          // the first five are phantoms
    orders[`o${i}`] = { productType: "sneaker", placedAtHub: "hub1", productId: pid,
                        productName: `Shoe ${i}`, size: "9", outOfStockAt: iso(3600e3) };
  }
  const { rows, total, truncated } = sa.buildOutOfStock({
    hub: "hub1", nowMs: NOW, cfg: sa.auditConfig({ maxOutOfStockRows: 20 }),
    stock: { hub1 }, products, orders,
  });
  assert.equal(total, 200);
  assert.equal(truncated, true);
  assert.equal(rows.length, 20);
  assert.equal(rows.slice(0, 5).every((r) => r.q > 0), true, "every phantom survives the cap");
  assert.equal("at" in rows[0], false, "`at` is a sort key, never snapshot bytes");
});

test("the cell key is /stock's own fold, so a half size names the cell that exists", () => {
  assert.equal(sa.stockSizeKey("5.5"), "5_5");
  assert.equal(sa.stockSizeKey(5.5), "5_5");
  assert.equal(sa.stockSizeKey(" 8"), "_8");
  assert.equal(sa.stockSizeKey("Free Size"), "_");
  assert.equal(sa.stockSizeKey(null), "_");
  const { rows } = sa.buildOutOfStock({
    hub: "hub1", nowMs: NOW, cfg: CFG, products: PRODUCTS,
    stock: { hub1: { shoe: { "5_5": { qty: 2 } } } },
    orders: { a: { productType: "sneaker", placedAtHub: "hub1", productId: "shoe",
                   productName: "AF1", size: "5.5", outOfStockAt: iso(3600e3) } },
  });
  assert.equal(rows[0].sk, "5_5", "the KEY is the cell's own");
  assert.equal(rows[0].s, "5.5", "the LABEL is what the person holding the shoe reads");
  assert.equal(sa.sizeLabel("_"), "One size");
  assert.equal(sa.sizeLabel("ONE_SIZE"), "ONE_SIZE", "a broad underscore replace would mangle this");
  assert.equal(sa.sizeLabel("XXXL"), "XXXL");
  assert.equal(rows[0].q, 2, "the row must read the cell that actually holds the units");
});


test("the rotation universe is clothing this shop HOLDS and has NOT SOLD", () => {
  const all = sa.rotationUniverse({ store: "marathon-pe", stock: STOCK, products: PRODUCTS });
  assert.deepEqual(all.map((x) => x.pid).sort(), ["belt", "hood", "tee"]);
  // zero and negative cells are not a shelf to walk to
  assert.deepEqual(all.find((x) => x.pid === "tee").sizes, [{ sk: "S", q: 4 }]);

  // THE NOT-SOLD FILTER IS THE UNIVERSE, not a badge. tee sold here five days
  // ago, so it is a line that is working and must not spend a batch slot.
  const sold = sa.soldIndex({ store: "marathon-pe", nowMs: NOW, movements: MOVEMENTS, soldWindowDays: 21 });
  const unsold = sa.rotationUniverse({ store: "marathon-pe", stock: STOCK, products: PRODUCTS, soldPids: sold.byPid });
  assert.deepEqual(unsold.map((x) => x.pid).sort(), ["belt", "hood"]);
});

test("the sold window bounds the universe: 21 days in, 22 days out", () => {
  const mk = (daysAgo) => [{ type: "sold", from: "marathon-pe", productId: "tee", size: "S",
                             ts: new Date(NOW - daysAgo * 864e5).toISOString() }];
  const inUniverse = (daysAgo) => sa.buildRotation({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: STOCK, products: PRODUCTS, movements: mk(daysAgo),
    rotationState: {}, prevBatchPids: null,
  }).rows.some((r) => r.p === "tee");
  assert.equal(inUniverse(20), false, "sold inside the window — not a not-selling line");
  assert.equal(inUniverse(22), true, "sold before the window — it belongs in the sweep");
});

test("present-but-slow is carried as settled, not re-raised", () => {
  const rot = sa.buildRotation({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: STOCK, products: PRODUCTS, movements: MOVEMENTS,
    rotationState: { belt: { at: NOW - 864e5, o: "slow" }, hood: { at: NOW - 864e5, o: "present" } },
    prevBatchPids: null,
  });
  const by = Object.fromEntries(rot.rows.map((r) => [r.p, r]));
  assert.equal(by.belt.slow, true);
  assert.equal(by.hood.slow, false);
  assert.equal(by.belt.last, NOW - 864e5);
});

// ── TAB B: the batch is minted on rotation days only ─────────────────────────
test("a new batch on a rotation day; the standing batch is kept on other days", () => {
  const args = {
    store: "marathon-pe", nowMs: NOW, cfg: CFG, stock: STOCK, products: PRODUCTS,
    movements: [], rotationState: {},
  };
  const kept = sa.buildRotation({ ...args, saDate: "2026-09-08", prevBatchPids: ["hood"] });
  assert.deepEqual(kept.rows.map((r) => r.p), ["hood"]);
  assert.equal(kept.refreshed, false);

  const minted = sa.buildRotation({ ...args, saDate: "2026-09-09", prevBatchPids: ["hood"] });
  assert.equal(minted.refreshed, true);
  assert.equal(minted.rows.length, 3);

  // a carried batch whose products all sold out refills rather than showing nothing
  const empty = sa.buildRotation({ ...args, saDate: "2026-09-08", prevBatchPids: ["gone"] });
  assert.equal(empty.rows.length, 3);
});

test("a batch already walked does not come back on the next non-rotation day", () => {
  // Monday's batch is cleared. Tuesday, Thursday, Saturday and Sunday are not
  // rotation days, so the SAME batch is carried — and the per-day results node
  // cannot remember Monday. Without the stamp check, staff redo finished work
  // four days out of seven and a "present but slow" line is re-asked the very
  // next morning.
  const args = {
    store: "marathon-pe", nowMs: NOW, cfg: CFG, stock: STOCK, products: PRODUCTS,
    movements: [],
  };
  const MON = Date.parse("2026-09-07T06:00:00.000Z");

  const minted = sa.buildRotation({ ...args, saDate: "2026-09-07", nowMs: MON, rotationState: {}, prevBatchPids: null });
  assert.equal(minted.refreshed, true);
  assert.equal(minted.rows.length, 3);
  assert.equal(minted.batchAt, MON);
  assert.deepEqual(minted.batchPids.sort(), ["belt", "hood", "tee"]);

  // Monday: staff walk two of the three, one of them "present but slow".
  const stamped = { tee: { at: MON + 3600e3, o: "present" }, belt: { at: MON + 3700e3, o: "slow" } };
  const tue = sa.buildRotation({
    ...args, saDate: "2026-09-08", rotationState: stamped,
    prevBatchPids: minted.batchPids, prevBatchAt: minted.batchAt,
  });
  assert.equal(tue.refreshed, false);
  assert.deepEqual(tue.rows.map((r) => r.p), ["hood"], "only the unwalked one is still a question");
  assert.equal(tue.walked, 2);
  assert.deepEqual(tue.batchPids.sort(), ["belt", "hood", "tee"], "the batch identity survives");

  // the whole batch walked → the list is finished, and does NOT restart
  const allDone = { ...stamped, hood: { at: MON + 3800e3, o: "present" } };
  const wed = sa.buildRotation({
    ...args, saDate: "2026-09-08", rotationState: allDone,
    prevBatchPids: minted.batchPids, prevBatchAt: minted.batchAt,
  });
  assert.deepEqual(wed.rows, []);
  assert.equal(wed.walked, 3);
  assert.equal(wed.batchPids.length, 3);
});

test("a carried batch with no mint time shows the work rather than hiding it", () => {
  // State written before this field existed, or a hand-edited node. Zero would
  // make every stamp in history read as walked and blank the list; an audit
  // must fail towards showing the shelf.
  const rot = sa.buildRotation({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-08",
    stock: STOCK, products: PRODUCTS, movements: [],
    rotationState: { tee: { at: NOW - 864e5, o: "present" }, hood: { at: NOW - 2 * 864e5, o: "present" } },
    prevBatchPids: ["tee", "hood"], prevBatchAt: 0,
  });
  assert.deepEqual(rot.rows.map((r) => r.p).sort(), ["hood", "tee"]);
  assert.equal(rot.walked, 0);
});

test("a carried batch reports the day it was MINTED, not the day the pass ran", () => {
  const MON = Date.parse("2026-09-07T06:00:00.000Z");
  const rot = sa.buildRotation({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-10",
    stock: STOCK, products: PRODUCTS, movements: [],
    rotationState: {}, prevBatchPids: ["tee"], prevBatchAt: MON,
  });
  assert.equal(rot.batchDate, "2026-09-07");
  // and a freshly minted one reports today
  const mint = sa.buildRotation({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-09",
    stock: STOCK, products: PRODUCTS, movements: [],
    rotationState: {}, prevBatchPids: null,
  });
  assert.equal(mint.batchDate, sa.buildStoreSnapshot({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-09",
    stock: STOCK, products: PRODUCTS, refillRequests: {}, movements: [], routes: ROUTES,
    rotationState: {}, prevBatchPids: null,
  }).rotation.batchDate);
});

test("a stamp from BEFORE this batch was minted does not count as walked", () => {
  // The whole point of a rotation is that a product checked months ago comes
  // round again. Comparing against the batch's mint time, not merely "has a
  // stamp", is what keeps that true.
  const args = {
    store: "marathon-pe", nowMs: NOW, cfg: CFG, stock: STOCK, products: PRODUCTS,
    movements: [], saDate: "2026-09-08",
  };
  const MON = Date.parse("2026-09-07T06:00:00.000Z");
  const old = sa.buildRotation({
    ...args, rotationState: { tee: { at: MON - 90 * 864e5, o: "present" } },
    prevBatchPids: ["tee", "hood"], prevBatchAt: MON,
  });
  assert.deepEqual(old.rows.map((r) => r.p), ["tee", "hood"]);
  assert.equal(old.walked, 0);
});

test("the rotation covers every product and never starves one", () => {
  const N = 137, BATCH = 30;
  const products = {}, cells = {};
  for (let i = 0; i < N; i++) {
    const pid = `p${String(i).padStart(3, "0")}`;
    products[pid] = { name: `Item ${i}`, productType: "clothing" };
    cells[pid] = { M: { qty: 1 + (i % 4) } };
  }
  const stock = { "marathon-pe": cells };
  const cfg = sa.auditConfig({ batchSize: BATCH });
  const rotationState = {};
  const seen = new Map();               // pid → times checked
  let t = NOW;

  // Five full cycles' worth of batches.
  const batches = Math.ceil(N / BATCH) * 5;
  for (let b = 0; b < batches; b++) {
    const universe = sa.rotationUniverse({ store: "marathon-pe", stock, products });
    const picked = sa.selectRotationBatch({ universe, rotationState, batchSize: BATCH });
    assert.equal(picked.length, BATCH, `batch ${b} must be full while the universe is larger`);
    // no product may appear twice inside one batch
    assert.equal(new Set(picked.map((p) => p.pid)).size, BATCH);
    for (const { pid } of picked) {
      seen.set(pid, (seen.get(pid) || 0) + 1);
      t += 60e3;                                     // stamps are strictly increasing
      rotationState[pid] = { at: t, o: "present" };
    }
    // FIRST FULL SWEEP: after ceil(N/BATCH) batches every product has been seen.
    if (b === Math.ceil(N / BATCH) - 1) {
      assert.equal(seen.size, N, "one cycle must reach every product");
    }
  }

  assert.equal(seen.size, N);
  const counts = [...seen.values()];
  const lo = Math.min(...counts), hi = Math.max(...counts);
  // Nothing starves: after five cycles the least-checked and most-checked
  // products differ by at most one visit. A severity ranking would fail this.
  assert.ok(hi - lo <= 1, `visit spread must be <= 1, got ${lo}..${hi}`);
  assert.ok(lo >= 4, `every product must have been checked repeatedly, got ${lo}`);
});

test("a never-checked product jumps the queue ahead of everything stamped", () => {
  const products = { a: { productType: "clothing" }, b: { productType: "clothing" }, c: { productType: "clothing" } };
  const stock = { "marathon-pe": { a: { M: { qty: 1 } }, b: { M: { qty: 1 } }, c: { M: { qty: 1 } } } };
  const universe = sa.rotationUniverse({ store: "marathon-pe", stock, products });
  // a is stamped; c has never been seen; b carries an unreadable stamp. Both
  // of the latter must be treated as never-checked — an audit that trusts a
  // broken stamp stops auditing that product forever, which is the one failure
  // this ordering exists to prevent.
  const picked = sa.selectRotationBatch({
    universe, batchSize: 2, rotationState: { a: { at: NOW }, b: { at: 0 } },
  });
  assert.deepEqual(picked.map((p) => p.pid), ["b", "c"]);
  assert.deepEqual(
    sa.selectRotationBatch({ universe, batchSize: 1, rotationState: { a: { at: NOW }, b: { at: NOW - 1 }, c: { at: "nonsense" } } })
      .map((p) => p.pid),
    ["c"]);
});

test("the batch is deterministic when every product is unchecked", () => {
  const products = {}, cells = {};
  for (const pid of ["zz", "aa", "mm", "bb"]) { products[pid] = { productType: "clothing" }; cells[pid] = { M: { qty: 1 } }; }
  const universe = sa.rotationUniverse({ store: "marathon-pe", stock: { "marathon-pe": cells }, products });
  const a = sa.selectRotationBatch({ universe, rotationState: {}, batchSize: 3 }).map((p) => p.pid);
  const b = sa.selectRotationBatch({ universe: [...universe].reverse(), rotationState: {}, batchSize: 3 }).map((p) => p.pid);
  assert.deepEqual(a, ["aa", "bb", "mm"]);
  assert.deepEqual(a, b, "the batch must not depend on object key order");
});

// ── the snapshot ─────────────────────────────────────────────────────────────
test("the shop snapshot carries only the rotation, and the hub snapshot only its list", () => {
  const shop = sa.buildStoreSnapshot({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: STOCK, products: PRODUCTS, movements: [], rotationState: {}, prevBatchPids: null,
  });
  assert.equal(shop.store, "marathon-pe");
  assert.equal(shop.saDate, "2026-09-07");
  assert.equal(shop.oos, undefined, "a shop never carries the hub tab");
  assert.equal(shop.rotation.universeSize, 3);
  assert.equal(shop.rotation.cycleBatches, 1);

  const hub = sa.buildHubSnapshot({
    hub: "hub1", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: STOCK, products: PRODUCTS, orders: ORDERS,
  });
  assert.equal(hub.hub, "hub1");
  assert.equal(hub.rotation, undefined, "a hub never carries the shop tab");
  assert.ok(hub.oos.rows.length > 0);
  assert.equal(JSON.stringify(hub).includes("photoUrl"), false);
  assert.equal(JSON.stringify(hub).includes("customerPhone"), false, "a shelf list carries no customer data");
});

// THE SIZE BUDGET, AT LIVE SCALE. The fixtures above are small enough to pass
// this on nothing, so here it is again at the real numbers: a shop holding
// 1,400 unsold clothing lines with a full S–XXXL run and catalogue-length
// names, and a hub that refused 400 sneaker lines in a day. A field added to a
// row multiplies by 120 and by 30 — this is what stops that being discovered
// on the bill.
test("both snapshots stay inside the size budget at live scale", () => {
  const NAME = "Nike Sportswear Tech Fleece Full-Zip Hoodie Heather Grey/Black";
  const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];
  const products = {}, pe = {};
  for (let i = 0; i < 1400; i++) {
    const pid = `p17812345678${String(i).padStart(4, "0")}`;
    products[pid] = { name: `${NAME} ${i}`, productType: "clothing" };
    pe[pid] = {};
    for (const sz of SIZES) pe[pid][sz] = { qty: 3 };
  }
  const shop = sa.buildStoreSnapshot({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: { "marathon-pe": pe }, products, movements: [], rotationState: {}, prevBatchPids: null,
  });
  assert.equal(shop.rotation.rows.length, CFG.batchSize);
  assert.equal(shop.rotation.universeSize, 1400);
  const shopBytes = JSON.stringify(shop).length;
  assert.ok(shopBytes < 50 * 1024, `shop snapshot is ${(shopBytes / 1024).toFixed(1)} KB — the budget is 50 KB`);

  const sneakers = {}, hub1 = {}, orders = {};
  for (let i = 0; i < 400; i++) {
    const pid = `s${String(i).padStart(4, "0")}`;
    sneakers[pid] = { name: `Nike Air Force 1 '07 LX White Metallic Swoosh Pins ${i}`, category: "Footwear" };
    hub1[pid] = { "9_5": { qty: 0 } };
    orders[`o${i}`] = { productType: "sneaker", placedAtHub: "hub1", productId: pid,
                        productName: sneakers[pid].name, size: "9.5", outOfStockAt: iso(3600e3) };
  }
  const hub = sa.buildHubSnapshot({
    hub: "hub1", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: { hub1 }, products: sneakers, orders,
  });
  assert.equal(hub.oos.rows.length, CFG.maxOutOfStockRows);
  assert.equal(hub.oos.total, 400);
  const hubBytes = JSON.stringify(hub).length;
  assert.ok(hubBytes < 50 * 1024, `hub snapshot is ${(hubBytes / 1024).toFixed(1)} KB — the budget is 50 KB`);
});

test("neither snapshot lets an undefined reach an RTDB write", () => {
  // A product record with no name, an order with no size, a cell with no qty —
  // each produced an `undefined` in an early draft, and RTDB rejects one
  // SYNCHRONOUSLY (the #269 outage class).
  const walk = (v, path = "$") => {
    assert.notEqual(v, undefined, `undefined at ${path}`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
  };
  walk(sa.buildStoreSnapshot({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: { "marathon-pe": { x: { M: {} }, y: { M: { qty: 2 } } } },
    products: { x: { productType: "clothing" }, y: { productType: "clothing" } },
    movements: [], rotationState: {}, prevBatchPids: null,
  }));
  const hub = sa.buildHubSnapshot({
    hub: "hub1", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: { hub1: {} }, products: { z: {} },
    orders: { a: { productType: "sneaker", placedAtHub: "hub1", productId: "z", outOfStockAt: iso(1e3) } },
  });
  walk(hub);
  assert.equal(hub.oos.rows[0].n, "z", "a nameless product falls back to its id, never undefined");
  assert.equal(hub.oos.rows[0].sk, "_", "and a sizeless order folds to the one-size sentinel");
});
