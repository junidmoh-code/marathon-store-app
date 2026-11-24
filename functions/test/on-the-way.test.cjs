// ─── STOCK ON THE WAY IS NEVER COUNTED AS MISSING (Junid, 24 Nov 2026 evening) ─
// functions/lib/on-the-way.cjs, and what reads it: the single-piece write-down
// (web-writedown.cjs) and the shelf-check answer (webShelf).
// Run: cd functions && npm test
"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9";

const test = require("node:test");
const assert = require("node:assert/strict");
const O = require("../lib/on-the-way.cjs");
const W = require("../lib/web-writedown.cjs");
const L = require("../webShelf/lib.cjs");
const { _runAnswer: runAnswer } = require("../webShelf/index.js");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const iso = (ms) => new Date(ms).toISOString();
const DAY = 864e5;
// Tuesday 24 Nov 2026, 15:00 SAST.
const TUE_15 = Date.parse("2026-11-24T13:00:00.000Z");
const at = (s) => Date.parse(s);
const root = (db) => db.state.root;
const moves = (db, type) => Object.entries(root(db).stock_movements || {}).filter(([, m]) => m.type === type);
const cell = (qty, stampMs, mv = "seed", lastType = "received") => ({ qty, updatedAt: iso(stampMs), mv, v: 1, lastType });

test.beforeEach(() => O.forgetConfig());

test("cutoff: 11:00 SAST on the next trading day after the day it was sent; Sunday has no run", () => {
  // Sent Tuesday 15:00 → on the way until Wednesday 11:00 SAST (09:00 UTC).
  assert.equal(O.untilMs(TUE_15), at("2026-11-25T09:00:00.000Z"));
  // Sent Wednesday 08:00 SAST, before that day's cutoff → still the NEXT trading day (Thursday 11:00).
  assert.equal(O.untilMs(at("2026-11-25T06:00:00.000Z")), at("2026-11-26T09:00:00.000Z"));
  // Sent Saturday → Monday 11:00 (no Sunday run).
  assert.equal(O.untilMs(at("2026-11-28T10:00:00.000Z")), at("2026-11-30T09:00:00.000Z"));
  // Sent 23:30 SAST Tuesday is still Tuesday's SA day → Wednesday 11:00.
  assert.equal(O.untilMs(at("2026-11-24T21:30:00.000Z")), at("2026-11-25T09:00:00.000Z"));
  // Settings: another hour, Sunday a run day, nonsense ignored.
  const cfg = O.configFrom({ cutoffHour: 9, closedDays: [] });
  assert.equal(O.untilMs(at("2026-11-28T10:00:00.000Z"), cfg), at("2026-11-29T07:00:00.000Z"));
  assert.deepEqual(O.configFrom({ cutoffHour: "x", closedDays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] }), { on: true, cutoffHour: 11, closedDays: ["Sun"] });
  assert.equal(O.configFrom({ off: true }).on, false);
});

test("what counts as on the way: transfers, refills and fulfilments INTO a shelf; never a sale, a supplier delivery, an adjustment or an arrival from in transit", () => {
  const base = { productId: "p1", size: "5.5", qty: 2, ts: iso(TUE_15) };
  assert.deepEqual(O.inboundLeg({ ...base, type: "transfer_out", from: "central", to: "marathon-pe", reason: "marathon-pe_auto_refill" }), { loc: "marathon-pe", pid: "p1", sizeKey: "5_5", q: 2 });
  assert.deepEqual(O.inboundLeg({ ...base, type: "transfer_in", from: "hub2", to: "trophy" }), { loc: "trophy", pid: "p1", sizeKey: "5_5", q: 2 });
  assert.deepEqual(O.inboundLeg({ ...base, type: "received", to: "hub2", reason: "hub2_refill_uncounted" }), { loc: "hub2", pid: "p1", sizeKey: "5_5", q: 2 });
  assert.equal(O.inboundLeg({ ...base, type: "received", to: "central", reason: null }), null);
  assert.equal(O.inboundLeg({ ...base, type: "sold", from: "marathon-pe" }), null);
  assert.equal(O.inboundLeg({ ...base, type: "adjustment", to: "marathon-pe", reason: "recount" }), null);
  assert.equal(O.inboundLeg({ ...base, type: "return", to: "marathon-pe", reason: "exchange return #1" }), null);
  assert.equal(O.inboundLeg({ ...base, type: "transfer_in", from: "in_transit", to: "trophy" }), null);
  assert.equal(O.inboundLeg({ ...base, type: "transfer_out", from: "central", to: "in_transit" }), null);
  assert.equal(O.inboundLeg({ ...base, type: "transfer_out", from: "hub2", to: "hub2" }), null);
  assert.deepEqual(O.inboundLeg({ ...base, size: "Free Size", type: "transfer_out", from: "central", to: "hub1" }).sizeKey, "_");
});

test("the tick keeps only what is still travelling and drops what has landed, through the expiry index alone", async () => {
  const db = makeFakeDb({});
  const ledger = {
    m1: { type: "transfer_out", productId: "p1", size: "M", qty: 1, from: "central", to: "marathon-pe", ts: iso(TUE_15 - 3600e3) },
    m2: { type: "transfer_out", productId: "p1", size: "M", qty: 2, from: "central", to: "marathon-pe", ts: iso(TUE_15 - 2 * DAY) }, // Sunday → landed Monday 11:00
    m3: { type: "sold", productId: "p1", size: "M", qty: 1, from: "marathon-pe", ts: iso(TUE_15) },
  };
  const readSince = async (fromIso) => Object.fromEntries(Object.entries(ledger).filter(([, m]) => m.ts >= fromIso));
  const r = await O.trackOnTheWay(db, { nowMs: TUE_15, readSince });
  assert.deepEqual({ kept: r.kept, read: r.read }, { kept: 1, read: 3 });
  assert.deepEqual(root(db).shelf_on_the_way["marathon-pe"].p1.M, { m1: { q: 1, until: at("2026-11-25T09:00:00.000Z"), at: TUE_15 - 3600e3 } });
  assert.equal((await O.readOnTheWay(db, { loc: "marathon-pe", pid: "p1", sizeKey: "M", nowMs: TUE_15 })).qty, 1);
  // Wednesday 11:01: it has landed. The next tick deletes it and its index entry; the working set is empty again.
  const r2 = await O.trackOnTheWay(db, { nowMs: at("2026-11-25T09:01:00.000Z"), readSince: async () => ({}) });
  assert.equal(r2.expired, 1);
  assert.equal(root(db).shelf_on_the_way, undefined);
  assert.equal(root(db).shelf_on_the_way_due, undefined);
  assert.ok(root(db).shelf_on_the_way_meta.cursor);
});

test("one shelf: a transfer the tick has not seen yet still counts, read from the cell's own last movement", async () => {
  const db = makeFakeDb({ stock_movements: { fresh: { type: "transfer_out", productId: "p1", size: "M", qty: 1, from: "central", to: "trophy", ts: iso(TUE_15 - 60e3) } } });
  const c = cell(2, TUE_15 - 60e3, "fresh");
  assert.equal((await O.readOnTheWay(db, { loc: "trophy", pid: "p1", sizeKey: "M", cell: c, nowMs: TUE_15 })).qty, 1);
  // …but only for its own shelf.
  assert.equal((await O.readOnTheWay(db, { loc: "hub2", pid: "p1", sizeKey: "M", cell: c, nowMs: TUE_15 })).qty, 0);
  // Switched off: nothing is on the way.
  await db.ref(O.OTW_CONFIG_PATH).set({ off: true });
  O.forgetConfig();
  assert.equal((await O.readOnTheWay(db, { loc: "trophy", pid: "p1", sizeKey: "M", cell: c, nowMs: TUE_15 })).qty, 0);
});

test("on the way at a past instant (the backfill's question), from the shelf's own ledger rows", () => {
  const rows = [
    { type: "transfer_out", productId: "p1", size: "M", qty: 1, from: "central", to: "marathon-pe", ts: "2026-11-24T08:00:00.000Z" },
    { type: "transfer_out", productId: "p1", size: "M", qty: 2, from: "central", to: "marathon-pe", ts: "2026-11-23T08:00:00.000Z" }, // landed 24th 11:00
    { type: "sold", productId: "p1", size: "M", qty: 1, from: "marathon-pe", ts: "2026-11-24T08:30:00.000Z" },
  ];
  assert.equal(O.onTheWayAt(rows, at("2026-11-24T08:30:00.000Z")), 3);
  assert.equal(O.onTheWayAt(rows, at("2026-11-24T11:40:00.000Z")), 1);
  assert.equal(O.onTheWayAt(rows, at("2026-11-24T07:00:00.000Z")), 2);
});

// ── c) the website write-down ────────────────────────────────────────────────
const W1 = { pid: "p9", sizeKey: "M", size: "M", loc: "marathon-pe", kind: "shop_not_found", orderId: "5550001", orderNumber: 2301, line: 1, gen: 0, by: "u-z", at: TUE_15 };
const otwNode = (q, until = at("2026-11-25T09:00:00.000Z")) => ({ "marathon-pe": { p9: { M: { r1: { q, until, at: TUE_15 - 3 * 3600e3 } } } } });

test("write-down: a shelf showing 2 with 1 on the way → down by ONE, to the on-the-way number, never zero; the row knows its floor", async () => {
  const db = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(2, TUE_15 - 3 * 3600e3, "r1", "transfer_out") } } }, shelf_on_the_way: otwNode(1) });
  const r = await W.writeDownSingle(db, W1, { nowIso: iso(TUE_15 + 60e3) });
  assert.deepEqual({ wroteDown: r.wroteDown, onTheWay: r.onTheWay }, { wroteDown: true, onTheWay: 1 });
  assert.equal(root(db).stock["marathon-pe"].p9.M.qty, 1);
  const [[, mv]] = moves(db, "web_not_found");
  assert.deepEqual({ before: mv.before, after: mv.after, otw: mv.web.onTheWay }, { before: { "marathon-pe": 2 }, after: { "marathon-pe": 1 }, otw: 1 });
  assert.match(mv.reason, /1 more on the way, left on the count/);
  assert.equal(root(db).online_writedowns.p9.M["marathon-pe"].otw, 1);
});

test("write-down: a shelf showing 1 with 1 on the way → nothing changes (the piece is still travelling); 3 with 1 → held, not written", async () => {
  for (const [qty, q] of [[1, 1], [2, 2], [3, 1]]) {
    const db = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(qty, TUE_15 - 3 * 3600e3, "r1", "transfer_out") } } }, shelf_on_the_way: otwNode(q) });
    const r = await W.writeDownSingle(db, W1, { nowIso: iso(TUE_15 + 60e3) });
    assert.deepEqual({ wroteDown: r.wroteDown, qty: r.qty, onTheWay: r.onTheWay }, { wroteDown: false, qty, onTheWay: q });
    assert.equal(root(db).stock["marathon-pe"].p9.M.qty, qty);
    assert.equal(root(db).stock_movements, undefined);
  }
});

test("write-down: once the cutoff has passed, nothing is on the way any more and the old rule applies", async () => {
  const db = makeFakeDb({ stock: { "marathon-pe": { p9: { M: cell(1, TUE_15 - 3 * 3600e3, "r1", "transfer_out") } } }, shelf_on_the_way: otwNode(1, TUE_15 - 1) });
  const r = await W.writeDownSingle(db, W1, { nowIso: iso(TUE_15 + 60e3) });
  assert.equal(r.wroteDown, true);
  assert.equal(root(db).stock["marathon-pe"].p9.M.qty, 0);
});

test("the self-reversal still works after a write-down to the on-the-way number: sales of the arriving piece keep the row; a sale beyond it restores", () => {
  const row = { mvId: "web_nf_x", at: TUE_15, otw: 1 };
  assert.equal(W.sweepDecision(row, { qty: 1, mv: "web_nf_x" }, TUE_15 + 1), "keep");
  // The arriving piece sold: the shelf shows 0, only ever sold from → still waiting for proof.
  assert.equal(W.sweepDecision(row, { qty: 0, mv: "sale1", lastType: "sold" }, TUE_15 + 2), "keep");
  // A sale beyond it took the shelf below zero → the missing piece was there: restore.
  assert.equal(W.sweepDecision(row, { qty: -1, mv: "sale2", lastType: "sold" }, TUE_15 + 3), "restore");
  // A count or a delivery settled it.
  assert.equal(W.sweepDecision(row, { qty: 4, mv: "rf", lastType: "transfer_out" }, TUE_15 + 3), "close");
  assert.equal(W.sweepDecision(row, { qty: 0, mv: "adj", lastType: "adjustment" }, TUE_15 + 3), "close");
  // Without a floor the rule is exactly as before: any other movement closes it.
  assert.equal(W.sweepDecision({ mvId: "web_nf_y", at: TUE_15 }, { qty: 0, mv: "sale1", lastType: "sold" }, TUE_15 + 2), "close");
});

// ── b) a count entered on such a shelf ───────────────────────────────────────
test("answer plan: counted + on the way; Not found on the one piece that should be there writes it down to the on-the-way number", () => {
  const item = (shown) => ({ pid: "a", sizeKey: "M", shown, lastMoved: TUE_15 - DAY });
  const c = (q) => cell(q, TUE_15 - DAY);
  const plan = (shown, result, count, otw) => L.answerPlan({ item: item(shown), cell: c(shown), result, count, onTheWay: otw });
  // 4 shown, 2 on the way, 2 counted on the shelf → right.
  assert.deepEqual(plan(4, "count", 2, 2), { kind: "touch", outcome: "counted", target: 4 });
  // 4 shown, 2 on the way, 1 counted → 3, a correction of one (not three).
  assert.deepEqual(plan(4, "count", 1, 2), { kind: "adjust", delta: -1, outcome: "corrected", target: 3 });
  // 2 shown, 1 on the way: a single piece should be there. Not found → the write-down (to 1); Found → touch.
  assert.deepEqual(plan(2, "not_found", undefined, 1), { kind: "write_down", outcome: "notFound", target: 1 });
  assert.deepEqual(plan(2, "count", 0, 1), { kind: "write_down", outcome: "notFound", target: 1 });
  assert.deepEqual(plan(2, "found", undefined, 1), { kind: "touch", outcome: "found", target: 2 });
  // 1 shown, 1 on the way: nothing should be on the shelf yet; "not found" agrees and changes nothing.
  assert.deepEqual(plan(1, "not_found", undefined, 1), { kind: "touch", outcome: "notFound", target: 1 });
  // No stock on the way: exactly the rule as it was.
  assert.deepEqual(plan(3, "count", 1, 0), { kind: "adjust", delta: -2, outcome: "corrected", target: 1 });
});

test("answer written: a count on a shelf with stock on the way sets counted + on the way and logs both", async () => {
  const listedItem = { pid: "w", sizeKey: "L", shown: 5, why: "store_reject", src: "store_order_oos", ref: "hub2#187", lastMoved: TUE_15 - 3 * 3600e3 };
  const db = makeFakeDb({
    stock: { hub2: { w: { L: cell(5, TUE_15 - 3 * 3600e3, "rf9", "transfer_out") } } },
    shelf_on_the_way: { hub2: { w: { L: { rf9: { q: 2, until: at("2026-11-25T09:00:00.000Z"), at: TUE_15 - 3 * 3600e3 } } } } },
    shelf_checks: { hub2: { open: { w__L: listedItem } } },
  });
  const out = await runAnswer(db, { loc: "hub2", id: "w__L", result: "count", count: 1, uid: "u-mike", name: "Mike", nowMs: TUE_15 });
  assert.deepEqual(out, { outcome: "corrected", unitsCorrected: 2 });
  assert.equal(root(db).stock.hub2.w.L.qty, 3);
  const [[, mv]] = moves(db, "adjustment");
  assert.equal(mv.reason, "shelf check: counted 1 + 2 on the way = 3, the app showed 5");
  const done = root(db).shelf_checks.hub2.done["2026-11-24"].w__L;
  assert.deepEqual({ counted: done.counted, onTheWay: done.onTheWay, setTo: done.setTo, units: done.units, src: done.src, ref: done.ref }, { counted: 1, onTheWay: 2, setTo: 3, units: 2, src: "store_order_oos", ref: "hub2#187" });
});

test("d) the 60-day old-single rule sees a shelf with stock on the way as touched: the arrival stamps the cell", async () => {
  const { applyMovementAdmin } = require("../lib/admin-movement.cjs");
  const db = makeFakeDb({ stock: { trophy: { p1: { M: cell(0, TUE_15 - 90 * DAY) } }, central: { p1: { M: cell(3, TUE_15 - DAY) } } } });
  const res = await applyMovementAdmin(db, { type: "transfer_in", productId: "p1", size: "M", qty: 1, from: "central", to: "trophy", movementId: "rf_test_1", actor: "system:test", reason: "refill" }, { nowIso: iso(TUE_15) });
  assert.equal(res.ok, true);
  // The cell's own stamp is the arrival: pickableStock.oldSingleSizes measures age from it, so the shelf is 0 days old.
  assert.equal(root(db).stock.trophy.p1.M.updatedAt, iso(TUE_15));
});
