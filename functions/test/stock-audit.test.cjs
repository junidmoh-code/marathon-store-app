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
    shoe: { 9: { qty: -5 } },                       // negative, but a sneaker
  },
  hub2: {
    tee:  { M: { qty: 0 }, L: { qty: 7 } },
    hood: { M: { qty: -1 } },
  },
  central: {
    tee: { M: { qty: 12 } },
  },
  trophy: { tee: { S: { qty: 2 } } },
};

const NOW = Date.parse("2026-09-08T09:00:00.000Z");   // Tue 11:00 SAST
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const REQUESTS = {
  // human "not here" at hub2 while hub2's cell still reads 7 → the loudest phantom
  r1: { requestingLocation: "marathon-pe", productId: "tee", size: "L", status: "cancelled",
        resolvedAt: iso(3 * 3600e3), createdFrom: { source: "hub2" } },
  // engine self-withdrawal, source empty
  r2: { requestingLocation: "marathon-pe", productId: "tee", size: "M", status: "cancelled",
        cancelReason: "awaiting_upstream", resolvedAt: iso(5 * 3600e3), createdFrom: { source: "hub2" } },
  // still open, source cell reads 0
  r3: { requestingLocation: "marathon-pe", productId: "belt", size: null, status: "open",
        createdAt: iso(20 * 3600e3), createdFrom: { source: "hub2" } },
  // bookkeeping tidy-up — must NOT produce a row
  r4: { requestingLocation: "marathon-pe", productId: "hood", size: "M", status: "cancelled",
        cancelReason: "already_in_stock", resolvedAt: iso(2 * 3600e3), createdFrom: { source: "hub2" } },
  // outside the lookback window
  r5: { requestingLocation: "marathon-pe", productId: "hood", size: "S", status: "cancelled",
        cancelReason: "unfillable", resolvedAt: iso(40 * 3600e3), createdFrom: { source: "hub2" } },
  // another store's problem
  r6: { requestingLocation: "trophy", productId: "tee", size: "S", status: "cancelled",
        cancelReason: "unfillable", resolvedAt: iso(1 * 3600e3), createdFrom: { source: "hub2" } },
  // a sneaker — out of scope entirely
  r7: { requestingLocation: "marathon-pe", productId: "shoe", size: "9", status: "cancelled",
        cancelReason: "unfillable", resolvedAt: iso(1 * 3600e3), createdFrom: { source: "hub1" } },
  // Engine bookkeeping on cells NOTHING ELSE touches, so only the reason
  // whitelist can keep them off the list. r4 above cannot prove that: its cell
  // is already on the list as a negative, and first-writer-wins would mask an
  // admitted tidy-up. (Found by the mutation harness — A3 came back PASS.)
  r8: { requestingLocation: "marathon-pe", productId: "hood", size: "XL", status: "cancelled",
        cancelReason: "already_in_stock", resolvedAt: iso(1 * 3600e3), createdFrom: { source: "hub2" } },
  r9: { requestingLocation: "marathon-pe", productId: "hood", size: "XXL", status: "cancelled",
        cancelReason: "order_lost", resolvedAt: iso(1 * 3600e3), createdFrom: { source: "hub2" } },
  r10: { requestingLocation: "marathon-pe", productId: "hood", size: "XXXL", status: "cancelled",
         cancelReason: "no_longer_needed", resolvedAt: iso(1 * 3600e3), createdFrom: { source: "hub2" } },
  // fulfilled — the line arrived; there is nothing to check
  r11: { requestingLocation: "marathon-pe", productId: "hood", size: "S", status: "fulfilled",
         resolvedAt: iso(1 * 3600e3), createdFrom: { source: "hub2" } },
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

// ── TAB A ────────────────────────────────────────────────────────────────────
test("out-of-stock list: sources, scope and the place the stock was supposed to be", () => {
  const { rows, total } = sa.buildOutOfStock({
    store: "marathon-pe", nowMs: NOW, cfg: CFG,
    stock: STOCK, products: PRODUCTS, refillRequests: REQUESTS, routes: ROUTES,
  });
  assert.ok(rows.length >= 4, `fixture must produce real rows, got ${rows.length}`);
  assert.equal(total, rows.length);
  const by = Object.fromEntries(rows.map((r) => [r.k, r]));

  // negative at the shop itself
  assert.deepEqual(
    { w: by["tee__L__marathon-pe"].w, q: by["tee__L__marathon-pe"].q, r: by["tee__L__marathon-pe"].r },
    { w: "marathon-pe", q: -2, r: "negative_cell" });
  // negative at the source (Hub 2) — a different shelf, so a different row
  assert.equal(by["hood__M__hub2"].r, "negative_cell");
  assert.equal(by["hood__M__hub2"].w, "hub2");

  // human reject at hub2 while hub2 still reads 7 — believed qty is on the row
  assert.equal(by["tee__L__hub2"].r, "rejected");
  assert.equal(by["tee__L__hub2"].q, 7);
  assert.equal(by["tee__L__hub2"].w, "hub2");

  // engine withdrawal, source empty
  assert.equal(by["tee__M__hub2"].r, "awaiting_upstream");
  assert.equal(by["tee__M__hub2"].q, 0);

  // open request against an empty source — one-size folds to the "_" cell
  const beltKey = sa.cellKey("belt", "_", "hub2");
  assert.ok(by[beltKey], `expected a one-size row at ${beltKey}`);
  assert.equal(by[beltKey].r, "open_source_empty");
  assert.equal(by[beltKey].s, "One size");
  assert.equal(by[beltKey].sk, "_");

  // excluded: bookkeeping tidy-up, stale resolution, the other store, the sneaker
  for (const k of ["hood__XL__hub2", "hood__XXL__hub2", "hood__XXXL__hub2", "hood__S__hub2"]) {
    assert.equal(by[k], undefined, `${k} is the engine tidying its own books — never a shelf walk`);
  }
  assert.equal(rows.some((r) => r.k === "hood__S__hub2"), false);
  assert.equal(rows.some((r) => r.p === "shoe"), false);
  assert.equal(rows.some((r) => r.w === "trophy"), false);
});

test("out-of-stock list ranks proof and phantoms above routine rows, then caps", () => {
  const { rows } = sa.buildOutOfStock({
    store: "marathon-pe", nowMs: NOW, cfg: CFG,
    stock: STOCK, products: PRODUCTS, refillRequests: REQUESTS, routes: ROUTES,
  });
  const firstOther = rows.findIndex((r) => r.r !== "negative_cell");
  assert.ok(firstOther > 0, "negatives must come first");
  assert.equal(rows.slice(0, firstOther).every((r) => r.r === "negative_cell"), true);
  // the phantom (rejected against a positive cell) outranks the routine rows
  const iPhantom = rows.findIndex((r) => r.k === "tee__L__hub2");
  const iRoutine = rows.findIndex((r) => r.k === "tee__M__hub2");
  assert.ok(iPhantom < iRoutine, "a reject against live stock must sort above an empty-source row");

  const capped = sa.buildOutOfStock({
    store: "marathon-pe", nowMs: NOW, cfg: sa.auditConfig({ maxOutOfStockRows: 2 }),
    stock: STOCK, products: PRODUCTS, refillRequests: REQUESTS, routes: ROUTES,
  });
  assert.equal(capped.rows.length, 2);
  assert.equal(capped.truncated, true);
  assert.ok(capped.total > 2);
  assert.equal(capped.rows.every((r) => r.r === "negative_cell"), true);
  // `rank` is a sort key, never snapshot bytes
  assert.equal("rank" in capped.rows[0], false);
});

test("the same line missing from two places is two rows, never one", () => {
  const stock = { "marathon-pe": { tee: { M: { qty: -1 } } }, hub2: { tee: { M: { qty: -3 } } } };
  const { rows } = sa.buildOutOfStock({
    store: "marathon-pe", nowMs: NOW, cfg: CFG,
    stock, products: PRODUCTS, refillRequests: {}, routes: ROUTES,
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.w).sort(), ["hub2", "marathon-pe"]);
});

test("the STRONGER reading wins a collision, whatever order the records arrive in", () => {
  // Two CANCELLED records for the same cell, and the source now reads 7:
  //   • an old engine withdrawal — it gave up when hub2 was empty, and hub2 has
  //     since restocked                                            → rank 2
  //   • a newer human "not here" against that same restocked cell  → rank 1,
  //     the loudest phantom this tab can produce
  // RTDB iterates push-ids chronologically, so the old one is seen FIRST. A
  // first-writer-wins dedup keeps the weaker reading and hands the row a rank
  // that is the first thing the cap truncates.
  //
  // (The reviewer's original scenario — an OPEN request colliding with a
  // rejection — is not reachable: the open branch only emits when the source
  // reads <= 0, and rank 1 requires it to read > 0, so the two can never meet
  // on one cell. The guard is real; this is the collision that reaches it.)
  const older = { requestingLocation: "marathon-pe", productId: "tee", size: "L", status: "cancelled",
                  cancelReason: "awaiting_upstream", resolvedAt: iso(4 * 3600e3), createdFrom: { source: "hub2" } };
  const newer = { requestingLocation: "marathon-pe", productId: "tee", size: "L", status: "cancelled",
                  resolvedAt: iso(1 * 3600e3), createdFrom: { source: "hub2" } };
  const run = (rr) => sa.buildOutOfStock({
    store: "marathon-pe", nowMs: NOW, cfg: CFG,
    stock: { "marathon-pe": {}, hub2: STOCK.hub2, central: {} },
    products: PRODUCTS, refillRequests: rr, routes: ROUTES,
  }).rows.find((r) => r.k === "tee__L__hub2");

  assert.equal(run({ "-old": older, "-new": newer }).r, "rejected");
  assert.equal(run({ "-new": newer, "-old": older }).r, "rejected");   // and the other way round
  assert.equal(run({ "-old": older, "-new": newer }).q, 7);
});

test("a request with no recorded source falls back to the route table", () => {
  const { rows } = sa.buildOutOfStock({
    store: "marathon-pe", nowMs: NOW, cfg: CFG,
    stock: STOCK, products: PRODUCTS, routes: ROUTES,
    refillRequests: { x: { requestingLocation: "marathon-pe", productId: "tee", size: "M",
                           status: "cancelled", resolvedAt: iso(1e3) } },
  });
  assert.equal(rows.find((r) => r.k === "tee__M__hub2").r, "rejected");
});

// ── TAB B: universe + signals ────────────────────────────────────────────────
test("rotation universe is clothing this store actually holds", () => {
  const u = sa.rotationUniverse({ store: "marathon-pe", stock: STOCK, products: PRODUCTS });
  assert.deepEqual(u.map((x) => x.pid).sort(), ["belt", "hood", "tee"]);
  // zero and negative cells are not shelf to walk to; the sneaker is out of scope
  assert.deepEqual(u.find((x) => x.pid === "tee").sizes, [{ sk: "S", q: 4 }]);
  assert.equal(u.some((x) => x.pid === "shoe"), false);
});

test("the two signals: sold in the window, and a display registered here", () => {
  const rot = sa.buildRotation({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: STOCK, products: PRODUCTS, movements: MOVEMENTS,
    rotationState: {}, displayKeys: ["hood__M", "tee__XXL"], prevBatchPids: null,
  });
  assert.equal(rot.rows.length, 3);
  const by = Object.fromEntries(rot.rows.map((r) => [r.p, r]));

  // sold: only a `sold` movement FROM this store inside 21 days counts
  assert.equal(by.tee.sold, true);          // S sold 5 days ago
  assert.equal(by.hood.sold, false);        // sold at trophy, and a receive here
  assert.equal(by.belt.sold, false);

  // the size view resolves the same signals to the cell
  assert.deepEqual(by.tee.z, [{ s: "S", sk: "S", q: 4, sold: true, disp: false }]);

  // display: registered for hood/M here; tee's registration is a size this
  // store does not hold, so the product reads registered and the size does not
  assert.equal(by.hood.disp, true);
  assert.equal(by.hood.z[0].disp, true);
  assert.equal(by.tee.disp, true);
  assert.equal(by.tee.z[0].disp, false);
  assert.equal(by.belt.disp, false);

  // the three outcomes the check is built on are all reachable from this fixture
  assert.equal(by.belt.sold === false && by.belt.disp === false, true);   // not on the floor
  assert.equal(by.hood.sold === false && by.hood.disp === true, true);    // wrong stock or size
});

test("a 40-day-old sale does not count as sold, and 21 days is the boundary", () => {
  const mk = (daysAgo) => [{ type: "sold", from: "marathon-pe", productId: "tee", size: "S",
                             ts: new Date(NOW - daysAgo * 864e5).toISOString() }];
  const at = (daysAgo) => sa.soldIndex({ store: "marathon-pe", nowMs: NOW, movements: mk(daysAgo), soldWindowDays: 21 }).byPid.has("tee");
  assert.equal(at(20), true);
  assert.equal(at(22), false);
});

test("present-but-slow is carried as settled, not re-raised", () => {
  const rot = sa.buildRotation({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: STOCK, products: PRODUCTS, movements: MOVEMENTS,
    rotationState: { belt: { at: NOW - 864e5, o: "slow" }, hood: { at: NOW - 864e5, o: "present" } },
    displayKeys: [], prevBatchPids: null,
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
    movements: MOVEMENTS, rotationState: {}, displayKeys: [],
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
    movements: MOVEMENTS, displayKeys: [],
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

test("a stamp from BEFORE this batch was minted does not count as walked", () => {
  // The whole point of a rotation is that a product checked months ago comes
  // round again. Comparing against the batch's mint time, not merely "has a
  // stamp", is what keeps that true.
  const args = {
    store: "marathon-pe", nowMs: NOW, cfg: CFG, stock: STOCK, products: PRODUCTS,
    movements: MOVEMENTS, displayKeys: [], saDate: "2026-09-08",
  };
  const MON = Date.parse("2026-09-07T06:00:00.000Z");
  const old = sa.buildRotation({
    ...args, rotationState: { tee: { at: MON - 90 * 864e5, o: "present" } },
    prevBatchPids: ["tee", "hood"], prevBatchAt: MON,
  });
  assert.deepEqual(old.rows.map((r) => r.p), ["tee", "hood"]);
  assert.equal(old.walked, 0);
});

test("the out-of-stock cap cannot be filled entirely by SHARED upstream rows", () => {
  // hub2 and central are the source for BOTH audit stores, so their negatives
  // land in both lists at rank 0 — ahead of every row the shop itself owns.
  const products = {}, pe = {}, hub2 = {};
  for (let i = 0; i < 200; i++) {
    const pid = `u${String(i).padStart(3, "0")}`;
    products[pid] = { name: `Upstream ${i}`, productType: "clothing" };
    hub2[pid] = { M: { qty: -1 } };
  }
  for (let i = 0; i < 40; i++) {
    const pid = `s${String(i).padStart(3, "0")}`;
    products[pid] = { name: `Shop ${i}`, productType: "clothing" };
    pe[pid] = { M: { qty: -1 } };
  }
  const { rows, total, truncated } = sa.buildOutOfStock({
    store: "marathon-pe", nowMs: NOW, cfg: sa.auditConfig({ maxOutOfStockRows: 100 }),
    stock: { "marathon-pe": pe, hub2, central: {} }, products, refillRequests: {}, routes: ROUTES,
  });
  assert.equal(total, 240);
  assert.equal(truncated, true);
  assert.equal(rows.length, 100);
  const own = rows.filter((r) => r.w === "marathon-pe");
  assert.equal(own.length, 40, "every one of the shop's own rows must survive the cap");
  assert.equal(rows.length - own.length, 60, "and the shared upstream rows take the rest");
});

test("with nothing upstream, the shop's own rows may take the whole budget", () => {
  const products = {}, pe = {};
  for (let i = 0; i < 200; i++) {
    const pid = `s${String(i).padStart(3, "0")}`;
    products[pid] = { name: `Shop ${i}`, productType: "clothing" };
    pe[pid] = { M: { qty: -1 } };
  }
  const { rows } = sa.buildOutOfStock({
    store: "marathon-pe", nowMs: NOW, cfg: sa.auditConfig({ maxOutOfStockRows: 100 }),
    stock: { "marathon-pe": pe, hub2: {}, central: {} }, products, refillRequests: {}, routes: ROUTES,
  });
  assert.equal(rows.length, 100);
  assert.equal(rows.every((r) => r.w === "marathon-pe"), true);
});

test("the cell key is /stock's own fold, not the engine's trimming encoder", () => {
  // The engine encoder trims (" M" -> "M"); applyMovement, which WROTE every
  // cell, does not (" M" -> "_M"). Deriving a row's key with the wrong one
  // named a cell that does not exist, and the Adjust that followed created a
  // second cell beside the real units.
  assert.equal(sa.stockSizeKey(" M"), "_M");
  assert.equal(sa.stockSizeKey("Free Size"), "_");
  assert.equal(sa.stockSizeKey(""), "_");
  assert.equal(sa.stockSizeKey(null), "_");
  assert.equal(sa.stockSizeKey(5.5), "5_5");
  assert.equal(sa.stockSizeKey("XXXL"), "XXXL");

  const { rows } = sa.buildOutOfStock({
    store: "marathon-pe", nowMs: NOW, cfg: CFG,
    stock: { "marathon-pe": {}, hub2: { tee: { _M: { qty: 6 } } }, central: {} },
    products: PRODUCTS, routes: ROUTES,
    refillRequests: { x: { requestingLocation: "marathon-pe", productId: "tee", size: " M",
                          status: "cancelled", resolvedAt: iso(1e3), createdFrom: { source: "hub2" } } },
  });
  const row = rows.find((r) => r.p === "tee");
  assert.equal(row.sk, "_M");
  assert.equal(row.q, 6, "the row must read the cell that actually holds the units");
  assert.equal(row.k, "tee___M__hub2");
});

test("inside one rank the FRESHER evidence wins, not the first record read", () => {
  const older = { requestingLocation: "marathon-pe", productId: "tee", size: "M", status: "cancelled",
                  cancelReason: "unfillable", resolvedAt: iso(5 * 3600e3), createdFrom: { source: "hub2" } };
  const newer = { requestingLocation: "marathon-pe", productId: "tee", size: "M", status: "cancelled",
                  cancelReason: "awaiting_upstream", resolvedAt: iso(1 * 3600e3), createdFrom: { source: "hub2" } };
  const run = (rr) => sa.buildOutOfStock({
    store: "marathon-pe", nowMs: NOW, cfg: CFG,
    stock: { "marathon-pe": {}, hub2: STOCK.hub2, central: {} },
    products: PRODUCTS, refillRequests: rr, routes: ROUTES,
  }).rows.find((r) => r.k === "tee__M__hub2");
  assert.equal(run({ a: older, b: newer }).r, "awaiting_upstream");
  assert.equal(run({ b: newer, a: older }).r, "awaiting_upstream");
});

// ── THE ROTATION PROOF ───────────────────────────────────────────────────────
// The claim this feature rests on: the sweep reaches EVERY product and starves
// none. Simulated over many cycles against a universe that does not divide
// evenly by the batch size (137 vs 30 — a remainder is where a naive cursor
// loses records), with every batch stamped as checked.
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
test("the snapshot carries only what the card renders, and stays small", () => {
  const snap = sa.buildStoreSnapshot({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: STOCK, products: PRODUCTS, refillRequests: REQUESTS, movements: MOVEMENTS,
    routes: ROUTES, rotationState: {}, displayKeys: ["hood__M"], prevBatchPids: null,
  });
  assert.equal(snap.store, "marathon-pe");
  assert.equal(snap.saDate, "2026-09-07");
  assert.ok(snap.oos.rows.length > 0 && snap.rotation.rows.length > 0);
  assert.equal(snap.rotation.universeSize, 3);
  assert.equal(snap.rotation.cycleBatches, 1);
  assert.equal(JSON.stringify(snap).includes("photoUrl"), false);
  assert.ok(JSON.stringify(snap).length < 50 * 1024);
});

// THE SIZE BUDGET, AT LIVE SCALE. The fixture above is small enough to pass
// this on nothing, so here it is again at the real numbers: 1,400 clothing
// products at the store (live count 2026-09-08 was 1,300 held at Marathon PE),
// a full S–XXXL run each, catalogue-length names, and enough recent unavailable
// requests to fill the Tab A cap. A future field added to a row multiplies by
// 120 and by 30 — this is what stops that being discovered on the bill.
test("the snapshot stays inside its size budget at live catalogue scale", () => {
  const NAME = "Nike Sportswear Tech Fleece Full-Zip Hoodie Heather Grey/Black";
  const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];
  const products = {}, pe = {}, hub2 = {}, rr = {};
  for (let i = 0; i < 1400; i++) {
    const pid = `p17812345678${String(i).padStart(4, "0")}`;
    products[pid] = { name: `${NAME} ${i}`, productType: "clothing" };
    pe[pid] = {}; hub2[pid] = {};
    for (const sz of SIZES) { pe[pid][sz] = { qty: 3 }; hub2[pid][sz] = { qty: i % 3 === 0 ? -2 : 0 }; }
  }
  let n = 0;
  for (const pid of Object.keys(products).slice(0, 400)) {
    rr[`r${n++}`] = { requestingLocation: "marathon-pe", productId: pid, size: "XXXL", status: "cancelled",
                      resolvedAt: iso(3600e3), createdFrom: { source: "hub2" } };
  }
  const snap = sa.buildStoreSnapshot({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: { "marathon-pe": pe, hub2, central: {} }, products, refillRequests: rr, movements: [],
    routes: ROUTES, rotationState: {}, displayKeys: [], prevBatchPids: null,
  });
  assert.equal(snap.oos.rows.length, CFG.maxOutOfStockRows);   // the cap is doing work
  assert.equal(snap.oos.truncated, true);
  assert.ok(snap.oos.total > 3000);
  assert.equal(snap.rotation.rows.length, CFG.batchSize);
  assert.equal(snap.rotation.universeSize, 1400);
  const bytes = JSON.stringify(snap).length;
  assert.ok(bytes < 50 * 1024, `snapshot is ${(bytes / 1024).toFixed(1)} KB — the budget is 50 KB`);
});

test("the snapshot is JSON-safe: no undefined reaches an RTDB write", () => {
  // A product record with no name, a request with no size, a cell with no qty —
  // every one of these produced an `undefined` in an early draft, and RTDB
  // rejects an undefined SYNCHRONOUSLY (the #269 outage class).
  const snap = sa.buildStoreSnapshot({
    store: "marathon-pe", nowMs: NOW, cfg: CFG, saDate: "2026-09-07",
    stock: { "marathon-pe": { x: { M: {} } }, hub2: {} },
    products: { x: { productType: "clothing" } },
    refillRequests: { q: { requestingLocation: "marathon-pe", productId: "x", status: "cancelled", resolvedAt: iso(1e3) } },
    movements: [], routes: ROUTES, rotationState: {}, displayKeys: [], prevBatchPids: null,
  });
  const walk = (v, path = "$") => {
    assert.notEqual(v, undefined, `undefined at ${path}`);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`);
  };
  walk(snap);
  assert.equal(snap.oos.rows[0].n, "x");             // falls back to the id, never undefined
});
