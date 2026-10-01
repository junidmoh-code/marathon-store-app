// ─── HUB 2'S "OUT OF STOCK" CARRIES A NAME (2026-09-23) ──────────────────────
// Hub 2 refuses a shop's line on the ORDER (App.jsx clothing batch: Reject),
// not on the request — so, until now, the only record of who said no was the
// hub itself, and the #642 write-off list read "Hub 2 staff (no name
// recorded)". The app now stamps the signed-in account on the order
// (clothingOutOfStockByUid); the hourly scan's close copies it into the
// request's resolvedBy — the field Central's queue has always written — and
// the write-off resolves it to a name exactly as it does for Central.
//
// The chain is pinned link by link, then end to end: order → plan close →
// request → write-off record. Old refusals (no account on the order) stay
// unnamed; a request that already names someone is never re-attributed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { computeRefillPlan, sanitizeUpdate } = require("../lib/refill-engine.cjs");
const { planRefusalWriteoffs, applyRefusalWriteoffs } = require("../lib/refusal-writeoff.cjs");
const { _closeRequestTxn: closeRequestTxn } = require("../refill-scan.cjs");

const PID = "p1780382141061";
const NOW = Date.parse("2026-09-23T12:45:00.000Z");
const CONFIG = {
  enabled: true,
  mode: { hub1: "live", hub2: "live", "marathon-pe": "live", trophy: "live" },
  routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
  ruleBasedTargets: true, maxUnitsPerIntent: 20, maxIntentsPerRun: 75,
  recheckCooldownMinutes: 1440, rejectStreakLimit: 4, staleIntentHours: 168,
};
const PRODUCTS = { [PID]: { name: "Nike Tech Fleece Tracksuit Brown 2", productType: "clothing", sizes: ["M"] } };
const TARGETS = { hub2: { [PID]: { M: { target: 3, minQty: 2 } } }, "marathon-pe": { [PID]: { M: { target: 2, minQty: 1 } } } };
const cell = (qty) => ({ qty, v: 4, mv: "seed", lastType: "transfer_out", updatedAt: "2026-09-09T13:18:11.169Z" });
const STOCK = () => ({ "marathon-pe": { [PID]: { M: cell(0) } }, hub2: { [PID]: { M: cell(3) } }, central: { [PID]: { M: cell(38) } }, trophy: {}, hub1: {} });

const openRr = (createdAt) => ({ productId: PID, size: "M", qty: 2, requestingLocation: "marathon-pe", status: "open",
  createdAt, createdFrom: { engine: true, source: "hub2" } });
const rejectedOrder = (createdAt, refusedAt, uid) => ({
  customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: PID, size: "M", qty: 2, createdAt,
  clothingRefillStatus: "rejected", clothingOutOfStockAt: refusedAt, clothingRefilledBy: "hub2",
  ...(uid !== undefined ? { clothingOutOfStockByUid: uid } : {}),
});

// What the scan does with one refused line: plan the close, then run the close
// transaction against the open request.
function closeOne({ createdAt, refusedAt, uid, rr }) {
  const order = rejectedOrder(createdAt, refusedAt, uid);
  const plan = computeRefillPlan({
    nowMs: Date.parse(refusedAt) + 3600e3, config: CONFIG, targets: TARGETS, products: PRODUCTS, stock: STOCK(),
    heldLines: {}, movements: [], retryState: {}, rejectStreak: {},
    orders: { "R001-1": order }, refillRequests: { rq: rr || openRr(createdAt) },
    openIndex: { "marathon-pe": { [PID]: { M: { refillId: "rq", orderId: "R001-1", orderCreatedAt: createdAt, qty: 2, createdAt } } } },
  });
  const c = plan.closes.find((x) => x.refillId === "rq");
  const startedAt = new Date(Date.parse(refusedAt) + 3600e3).toISOString();
  return { c, next: closeRequestTxn(rr || openRr(createdAt), c, startedAt) };
}

test("the plan close carries the account that pressed Out of Stock at Hub 2", () => {
  const { c } = closeOne({ createdAt: "2026-09-17T10:15:16.579Z", refusedAt: "2026-09-17T14:05:00.000Z", uid: "u_mike" });
  assert.equal(c.humanReject, true);
  assert.equal(c.denier, "hub2");
  assert.equal(c.refusedByUid, "u_mike");
});

test("the close writes it into resolvedBy — the field Central's queue writes", () => {
  const { next } = closeOne({ createdAt: "2026-09-17T10:15:16.579Z", refusedAt: "2026-09-17T14:05:00.000Z", uid: "u_mike" });
  assert.equal(next.status, "cancelled");
  assert.equal(next.resolvedBy, "u_mike");
  assert.equal(next.refusedAt, "2026-09-17T14:05:00.000Z");
  assert.equal(next.refusedByLoc, "hub2");
});

test("an old refusal (no account on the order) stays exactly as before: no resolvedBy", () => {
  for (const uid of [undefined, null, "", 42]) {
    const { c, next } = closeOne({ createdAt: "2026-09-12T08:00:00.000Z", refusedAt: "2026-09-12T11:30:40.428Z", uid });
    assert.equal(c.refusedByUid, null, `uid=${String(uid)}`);
    assert.equal("resolvedBy" in next, false, `uid=${String(uid)}`);
    assert.equal(next.refusedByLoc, "hub2");
  }
});

test("a request that already names someone is never re-attributed", () => {
  const rr = { ...openRr("2026-09-17T10:15:16.579Z"), resolvedBy: "u_first" };
  const { next } = closeOne({ createdAt: "2026-09-17T10:15:16.579Z", refusedAt: "2026-09-17T14:05:00.000Z", uid: "u_mike", rr });
  assert.equal(next.resolvedBy, "u_first");
});

test("an engine withdrawal never picks up a refuser, even if the order carries one", () => {
  const next = closeRequestTxn(openRr("2026-09-17T10:15:16.579Z"),
    { rrStatus: "cancelled", cancelReason: "no_longer_needed", refusedByUid: "u_mike" }, "2026-09-17T15:00:00.000Z");
  assert.equal("resolvedBy" in next, false);
  assert.equal(next.cancelReason, "no_longer_needed");
});

test("end to end: four named Hub 2 refusals → the write-off record names the person", async () => {
  const days = [
    ["2026-09-12T08:00:00.000Z", "2026-09-12T11:30:40.428Z", "u_mike"],
    ["2026-09-14T06:00:00.000Z", "2026-09-14T08:45:31.184Z", "u_mike"],
    ["2026-09-16T07:00:00.000Z", "2026-09-16T10:15:04.806Z", "u_zee"],
    ["2026-09-17T10:15:16.579Z", "2026-09-17T14:15:22.516Z", null],      // refused before the app recorded names
  ];
  const rr = {};
  days.forEach(([createdAt, refusedAt, uid], i) => { rr[`rq${i}`] = closeOne({ createdAt, refusedAt, uid }).next; });
  const db = makeFakeDb({
    stock: STOCK(), refill_requests: rr, refill_engine: {}, stock_movements: {},
    users: { u_mike: { displayName: "Mike" }, u_zee: { displayName: "Zee" } },
  });
  const root = db.state.root;
  const snapshot = {
    nowMs: NOW, config: CONFIG, products: PRODUCTS, stock: structuredClone(root.stock), refillRequests: structuredClone(root.refill_requests),
    movements: [], rejectStreak: {}, cursors: {}, windowStartMs: NOW - 45 * 864e5,
  };
  const plan = planRefusalWriteoffs(snapshot);
  assert.equal(plan.writeoffs.length, 1);
  const update = async (patch) => { await db.ref().update(sanitizeUpdate(patch).safe); return true; };
  const res = await applyRefusalWriteoffs({ db, writeoffs: plan.writeoffs, snapshot, update, nowMs: NOW, runId: "r1" });
  assert.equal(res.applied.length, 1);
  const rec = (await db.ref(`refill_engine/refusalWriteoffs/${res.applied[0].id}`).once("value")).val();
  const names = (Array.isArray(rec.refusals) ? rec.refusals : Object.values(rec.refusals)).map((x) => x.byName || null);
  assert.deepEqual(names, ["Mike", "Mike", "Zee", null]);
});

// Property fuzz of closeRequestTxn — 20,000 seeded random requests × closes.
test("closeRequestTxn fuzz: never re-attributes, only human refusals gain a name, resolved rows untouched", () => {
  let s = 642 >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  for (let i = 0; i < 20000; i++) {
    const cur = { productId: PID, size: "M", qty: 2, requestingLocation: "marathon-pe" };
    const st = pick(["open", "fulfilled", "cancelled", undefined]);
    if (st) cur.status = st;
    if (r() < 0.3) cur.resolvedBy = "u_prev";
    const c = {
      rrStatus: pick(["cancelled", "fulfilled"]),
      ...(r() < 0.5 ? { humanReject: true, denier: "hub2" } : { cancelReason: "no_longer_needed" }),
      ...(r() < 0.5 ? { refusedAt: "2026-09-17T14:05:00.000Z" } : {}),
      refusedByUid: pick(["u_mike", null, undefined]),
    };
    const before = JSON.stringify(cur);
    const next = closeRequestTxn(cur, c, "2026-09-17T15:00:00.000Z");
    assert.equal(JSON.stringify(cur), before);
    if (cur.status && cur.status !== "open") { assert.equal(next, undefined); continue; }
    if (cur.resolvedBy) assert.equal(next.resolvedBy, "u_prev");
    else if (c.humanReject && c.refusedByUid) assert.equal(next.resolvedBy, c.refusedByUid);
    else assert.equal("resolvedBy" in next, false);
    assert.equal(closeRequestTxn(null, c, "x"), null);
  }
});
