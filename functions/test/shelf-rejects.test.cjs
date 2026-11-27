// ─── EVERY REJECTION FEEDS THE SHELF CHECK (Junid, 24 Nov 2026 evening) ──────
// functions/lib/shelf-rejects.cjs and the tick that runs it.
"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9";

const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../lib/shelf-rejects.cjs");
const O = require("../lib/on-the-way.cjs");
const { runTick } = require("../webShelf/tick.js");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const NOW = Date.parse("2026-11-24T13:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const root = (db) => db.state.root;
const cell = (qty, stampMs, mv = "seed") => ({ qty, updatedAt: iso(stampMs), mv, v: 1, lastType: "received" });
test.beforeEach(() => O.forgetConfig());

const oosRow = (over = {}) => ({ action: "out_of_stock", customerName: "Chulu", placedAtHub: "hub3", productId: "p1", size: "9", orderNumber: "191", timestamp: iso(NOW - 60e3), ...over });

test("what a log row or a request says: which shelf said no, when, and its source and id", () => {
  assert.deepEqual(R.fromInsight("k1", oosRow()), { loc: "hub3", pid: "p1", sizeKey: "9", size: "9", at: NOW - 60e3, kind: "store_order_oos", ref: "hub3 order 191 2026-11-24", key: "k1" });
  assert.equal(R.fromInsight("k", oosRow({ customerName: "Shop Refill", placedAtHub: "hub2", orderNumber: "R008-10" })).kind, "shop_refill_rej");
  assert.equal(R.fromInsight("k", oosRow({ action: "stock_depleted" })).kind, "stock_depleted");
  // A website order keeps its own path (the single-piece write-down); other actions are not rejections.
  assert.equal(R.fromInsight("k", oosRow({ customerName: "Shopify" })), null);
  assert.equal(R.fromInsight("k", oosRow({ orderNumber: "KQZ" })), null);
  assert.equal(R.fromInsight("k", oosRow({ action: "ready" })), null);
  assert.equal(R.fromInsight("k", oosRow({ placedAtHub: "mars" })), null);
  // A person's refusal = cancelled with no reason; the place that said no is refusedByLoc, else the source.
  const req = { status: "cancelled", productId: "p2", size: "M", refusedAt: iso(NOW - 5 * 60e3), resolvedAt: iso(NOW), refusedByLoc: "hub2", requestingLocation: "marathon-pe", createdFrom: { source: "hub2" } };
  assert.deepEqual(R.fromRequest("-Req1", req), { loc: "hub2", pid: "p2", sizeKey: "M", size: "M", at: NOW - 5 * 60e3, kind: "refill_refused", ref: "request -Req1 for marathon-pe" });
  assert.equal(R.fromRequest("x", { ...req, refusedByLoc: undefined, createdFrom: { source: "central" } }).loc, "central");
  for (const bad of [{ cancelReason: "order_lost" }, { status: "fulfilled" }, { productId: "a/b" }]) assert.equal(R.fromRequest("x", { ...req, ...bad }), null);
});

test("hold plan: never when the shelf moved since, shows nothing, or shows only what is on the way; an earlier standing hold is kept", () => {
  const rej = { at: NOW - 60e3, kind: "store_order_oos", ref: "r" };
  assert.deepEqual(R.holdPlan(rej, cell(2, NOW - 86400e3), 0, null), { hold: { at: NOW - 60e3, kind: "store_order_oos", orderId: "r", line: 0, qty: 2, src: "store" } });
  assert.deepEqual(R.holdPlan(rej, cell(2, NOW), 0, null), { skip: "moved_since" });
  assert.deepEqual(R.holdPlan(rej, cell(0, NOW - 86400e3), 0, null), { skip: "nothing_there" });
  assert.deepEqual(R.holdPlan(rej, cell(2, NOW - 86400e3), 2, null), { skip: "nothing_there" });
  assert.deepEqual(R.holdPlan(rej, cell(2, NOW - 86400e3), 0, { at: NOW - 3600e3, kind: "hub_out_of_stock" }), { skip: "held_already" });
  // An old hold the shelf has moved past no longer stands: the new rejection holds it.
  assert.ok(R.holdPlan(rej, cell(2, NOW - 1800e3), 0, { at: NOW - 3600e3 }).hold);
});

test("push keys round-trip the time they were minted at (the cursor)", () => {
  const k = R.pushKeyAt(NOW);
  assert.equal(k.length, 8);
  assert.equal(R.pushKeyTime(k + "abcdefghijkl"), NOW);
  assert.ok(R.pushKeyAt(NOW - 1) < k);
});

test("the tick: new rejections since the cursor hold their shelves (count NOT changed), each source tagged; the next tick starts from the cursor", async () => {
  const db = makeFakeDb({ stock: { hub3: { p1: { 9: cell(2, NOW - 5 * 86400e3) } }, hub2: { p2: { M: cell(1, NOW - 9 * 86400e3) }, p3: { L: cell(0, NOW - 9 * 86400e3) } } } });
  const insights = { [R.pushKeyAt(NOW - 60e3) + "aaaaaaaaaaaa"]: oosRow(), [R.pushKeyAt(NOW - 50e3) + "aaaaaaaaaaaa"]: oosRow({ timestamp: iso(NOW - 50e3) }) };
  const requests = {
    "-R1": { status: "cancelled", productId: "p2", size: "M", refusedAt: iso(NOW - 120e3), resolvedAt: iso(NOW - 60e3), refusedByLoc: "hub2", requestingLocation: "trophy" },
    "-R2": { status: "cancelled", productId: "p3", size: "L", resolvedAt: iso(NOW - 60e3), createdFrom: { source: "hub2" } }, // shows 0: agrees
    "-R3": { status: "fulfilled", productId: "p2", size: "M", resolvedAt: iso(NOW - 60e3) },
  };
  const seen = { insights: [], requests: [] };
  const dirty = [];
  const io = {
    readSince: async () => ({}),
    readInsights: async (k) => { seen.insights.push(k); return Object.fromEntries(Object.entries(insights).filter(([key]) => key >= k)); },
    readRequests: async (from) => { seen.requests.push(from); return Object.fromEntries(Object.entries(requests).filter(([, r]) => r.resolvedAt >= from)); },
    markDirty: async (pid) => dirty.push(pid),
  };
  const out = await runTick(db, { nowMs: NOW, io });
  assert.equal(out.rejections.held, 2);
  assert.deepEqual(out.rejections.skipped, { nothing_there: 1 });
  assert.deepEqual(root(db).online_cell_holds.p1["9"].hub3, { at: NOW - 60e3, kind: "store_order_oos", orderId: "hub3 order 191 2026-11-24", line: 0, qty: 2, src: "store" });
  assert.equal(root(db).online_cell_holds.p2.M.hub2.kind, "refill_refused");
  assert.equal(root(db).online_cell_holds.p3, undefined);
  assert.deepEqual(dirty.sort(), ["p1", "p2"]);
  // Counts untouched.
  assert.equal(root(db).stock.hub3.p1["9"].qty, 2);
  assert.equal(root(db).stock_movements, undefined);
  // Second tick: from the cursor (half an hour of overlap), nothing new held, nothing doubled.
  const again = await runTick(db, { nowMs: NOW + 600e3, io });
  assert.equal(again.rejections.held, 0);
  assert.ok(seen.insights[1] >= R.pushKeyAt(NOW - 50e3 - 30 * 60e3));
  assert.ok(seen.requests[1] >= iso(NOW - 60e3 - 30 * 60e3));
});

test("a display check's No Stock over stock the app shows holds the shop's shelf (display_no_stock)", async () => {
  const db = makeFakeDb({ stock: { trophy: { p5: { M: cell(3, NOW - 86400e3) } } } });
  const r = await R.holdRejection(db, { loc: "trophy", pid: "p5", sizeKey: "M", at: NOW, kind: "display_no_stock", ref: "display check c1" }, { nowMs: NOW });
  assert.deepEqual(r, { held: true });
  assert.equal(root(db).online_cell_holds.p5.M.trophy.kind, "display_no_stock");
  assert.deepEqual(await R.holdRejection(db, { loc: "trophy", pid: "p5", sizeKey: "M", at: NOW, kind: "made_up" }), { held: false, why: "bad_request" });
});

test("a push key minted by a phone whose clock runs ahead never carries the cursor past rows still to come", async () => {
  const db = makeFakeDb({});
  const ahead = R.pushKeyAt(NOW + 6 * 3600e3) + "zzzzzzzzzzzz";
  const normal = R.pushKeyAt(NOW - 60e3) + "aaaaaaaaaaaa";
  await R.scanRejections(db, { nowMs: NOW, readInsights: async () => ({ [normal]: oosRow({ action: "ready" }), [ahead]: oosRow({ action: "ready" }) }), readRequests: async () => ({}) });
  assert.equal(root(db).shelf_checks_meta.rejects.insightsKey, normal);
});

test("several rejections of one shelf in a window: an earlier one the shelf moved past does not hide a later one", async () => {
  const db = makeFakeDb({ stock: { hub2: { p1: { 9: cell(2, NOW - 30 * 60e3) } } } });
  const a = R.pushKeyAt(NOW - 60 * 60e3) + "aaaaaaaaaaaa", b = R.pushKeyAt(NOW - 10 * 60e3) + "aaaaaaaaaaaa";
  const out = await R.scanRejections(db, { nowMs: NOW, readInsights: async () => ({ [a]: oosRow({ placedAtHub: "hub2", timestamp: iso(NOW - 60 * 60e3) }), [b]: oosRow({ placedAtHub: "hub2", timestamp: iso(NOW - 10 * 60e3) }) }), readRequests: async () => ({}) });
  assert.equal(out.held, 1);
  assert.equal(root(db).online_cell_holds.p1["9"].hub2.at, NOW - 10 * 60e3);
});
