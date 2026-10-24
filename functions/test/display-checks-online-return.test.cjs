// ─── DISPLAY CHECKS — a swapped line's RETURN TO SHELF (kind "online_return") ──
// scripts/lib/swap-line.mjs writes one onto a shop's Website orders strip when
// the item the swap replaced was already handed over. Pinned here:
//   1. it closes ONLY with "put_back" (and no other kind takes "put_back");
//   2. "Put back" closes the order's return record (who, when, via strip) and
//      nothing else on the order — no line, no status, no stock;
//   3. a late "Handed over" on the entry a swapped line had BEFORE never flips
//      the new line (it has no entry of its own yet).
// Run: cd functions && npm test
"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("../displayChecks/lib.cjs");
const { runComplete } = require("../displayChecks/completeCheck.js");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const NOW = Date.parse("2026-10-24T09:00:00.000Z");
const STORE = "trophy";
const KEY = "online__5550001__1_r1__return";
const ACTOR = { uid: "u-lee", name: "Lee", email: "lee@marathon.internal" };
const returnRecord = (over = {}) => ({
  kind: "online_return", checkId: "cR1", productId: "p9", productName: "Boss Tee", size: "M", sizeKey: "M",
  status: "open", createdAt: NOW - 60e3, activatedAt: NOW - 60e3, activatedSaDate: "2026-10-24",
  orderId: "5550001", lineIndex: 1, returnId: "1_1", ref: "#1801", qty: 1, dedupeKey: KEY, ...over,
});
const order = () => ({
  orderNumber: 1801, status: "picking",
  lines: [
    { lineId: "l0", pid: "p1", size: "9", qty: 1, source: { locationId: "hub1", status: "pick", entryKey: "orders/QGZ", orderKeys: ["QGZ"] } },
    { lineId: "l1", pid: "p7", size: "L", qty: 1, routeGen: 1, swappedFrom: { pid: "p9", size: "M" }, source: { locationId: STORE, status: "display" } },
  ],
  returns: { "1_1": { lineIndex: 1, pid: "p9", locationId: STORE, state: "open", at: NOW - 60e3 } },
});
const world = (rec = returnRecord()) => makeFakeDb({
  displayChecks_active: { [STORE]: { [KEY]: rec } },
  online_orders: { "5550001": order() },
});
const call = (db, over = {}) => runComplete(db, { store: STORE, key: KEY, checkId: "cR1", result: "put_back", override: false, actor: ACTOR, nowMs: NOW, storeName: "Trophy", ...over });

test("the mirrored kind matches src/utils/onlineOrders.js", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "utils", "onlineOrders.js"), "utf8");
  assert.match(src, new RegExp(`ONLINE_RETURN_KIND = "${lib.ONLINE_RETURN_KIND}"`));
});

test("a return takes put_back only; no other kind takes put_back", () => {
  const d = (record, result) => lib.completionDecision({ record, expectedCheckId: record.checkId, result, override: false, stockQty: 4 });
  assert.deepEqual(d(returnRecord(), "put_back"), { kind: "complete", overridden: false });
  for (const r of ["handed", "not_found", "confirmed", "no_stock"]) assert.deepEqual(d(returnRecord(), r), { kind: "reject", code: "wrong-kind" });
  assert.deepEqual(d({ checkId: "c", status: "open", kind: "online_pick" }, "put_back"), { kind: "reject", code: "wrong-kind" });
  assert.deepEqual(d({ checkId: "c", status: "open" }, "put_back"), { kind: "reject", code: "wrong-kind" });
});

test("Put back: tombstone + log, the order's return record is done (who, when) — and nothing else on the order moves", async () => {
  const db = world();
  const before = JSON.parse(JSON.stringify(db.state.root.online_orders["5550001"]));
  const r = await call(db);
  assert.equal(r.kind, "ok");
  assert.equal(db.state.root.displayChecks_active[STORE][KEY].result, "put_back");
  assert.equal(db.state.root.displayChecks_log[STORE]["2026-10"]["cR1_completed"].type, "completed_put_back");
  const after = db.state.root.online_orders["5550001"];
  assert.deepEqual(after.returns["1_1"], { ...before.returns["1_1"], state: "done", doneAt: NOW, doneBy: "Lee", doneVia: "strip" });
  assert.deepEqual(after.lines, before.lines);
  assert.equal(after.status, "picking");
  assert.equal(db.state.root.stock, undefined);
});

test("a return already done is left as it is (a retry writes nothing)", () => {
  const ord = order(); ord.returns["1_1"].state = "done";
  const out = lib.onlineOrderOutcomeUpdates({ record: { ...returnRecord(), status: "completed", result: "put_back", completedAt: NOW }, store: STORE, order: ord });
  assert.deepEqual(out, { updates: {} });
});

test("a late Handed over on the entry a swapped line had BEFORE never flips the new line", () => {
  const ord = order();
  const old = { kind: "online_pick", checkId: "c0", orderId: "5550001", lineIndex: 1, dedupeKey: "online__5550001__1", status: "completed", result: "handed", completedAt: NOW };
  assert.deepEqual(lib.onlineOrderOutcomeUpdates({ record: old, store: STORE, order: ord }), { skip: "stale-entry" });
  // The new line's own (gen 1) entry still flips it.
  const mine = { ...old, dedupeKey: "online__5550001__1_r1" };
  assert.equal(lib.onlineOrderOutcomeUpdates({ record: mine, store: STORE, order: ord }).updates["online_orders/5550001/lines/1/source/status"], "handed");
});
