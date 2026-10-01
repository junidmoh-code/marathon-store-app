// ─── HUB 2'S "OUT OF STOCK" NAMES THE PHONE TOO (2026-09-25) ─────────────────
// Four Hub 2 orders were falsely refused on 25 Sep 2026 and nothing on the
// records could say which phone did it — accounts are shared. The app now
// stamps the phone on the order line (clothingOutOfStockDeviceId, the same id
// the Mirror Fleet screen lists and quarantines) beside the account. The same
// chain as hub2-refusal-name.test.cjs carries it, link by link and end to end:
// order → plan close (refusedByDeviceId) → request (resolvedDeviceId) →
// write-off record (byDeviceId). Central's queue writes resolvedDeviceId
// itself. Old lines (no phone) stay unattributed; a request that already names
// a phone is never re-attributed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { computeRefillPlan, sanitizeUpdate } = require("../lib/refill-engine.cjs");
const { planRefusalWriteoffs, applyRefusalWriteoffs } = require("../lib/refusal-writeoff.cjs");
const { _closeRequestTxn: closeRequestTxn } = require("../refill-scan.cjs");

const PID = "p1780382141061";
const NOW = Date.parse("2026-09-23T12:45:00.000Z");
const PHONE = "2964c145-ecad-4f61-9f7a-304231af0e01";
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
const rejectedOrder = (createdAt, refusedAt, uid, deviceId) => ({
  customerName: "Shop Refill", autoRefill: true, destShop: "marathon-pe", productId: PID, size: "M", qty: 2, createdAt,
  clothingRefillStatus: "rejected", clothingOutOfStockAt: refusedAt, clothingRefilledBy: "hub2",
  ...(uid !== undefined ? { clothingOutOfStockByUid: uid } : {}),
  ...(deviceId !== undefined ? { clothingOutOfStockDeviceId: deviceId } : {}),
});
function closeOne({ createdAt, refusedAt, uid = "u_ayob", deviceId, rr }) {
  const order = rejectedOrder(createdAt, refusedAt, uid, deviceId);
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

test("the plan close carries the phone that pressed Reject at Hub 2", () => {
  const { c } = closeOne({ createdAt: "2026-09-17T10:15:16.579Z", refusedAt: "2026-09-17T14:05:00.000Z", deviceId: PHONE });
  assert.equal(c.humanReject, true);
  assert.equal(c.refusedByDeviceId, PHONE);
});

test("the close writes it into resolvedDeviceId — the field Central's queue writes", () => {
  const { next } = closeOne({ createdAt: "2026-09-17T10:15:16.579Z", refusedAt: "2026-09-17T14:05:00.000Z", deviceId: PHONE });
  assert.equal(next.resolvedDeviceId, PHONE);
  assert.equal(next.resolvedBy, "u_ayob");
});

test("an old refusal (no phone on the order) gains no resolvedDeviceId", () => {
  for (const deviceId of [undefined, null, "", 42]) {
    const { c, next } = closeOne({ createdAt: "2026-09-12T08:00:00.000Z", refusedAt: "2026-09-12T11:30:40.428Z", deviceId });
    assert.equal(c.refusedByDeviceId, null, `deviceId=${String(deviceId)}`);
    assert.equal("resolvedDeviceId" in next, false, `deviceId=${String(deviceId)}`);
  }
});

test("a request that already names a phone is never re-attributed", () => {
  const rr = { ...openRr("2026-09-17T10:15:16.579Z"), resolvedDeviceId: "first-phone-0001" };
  const { next } = closeOne({ createdAt: "2026-09-17T10:15:16.579Z", refusedAt: "2026-09-17T14:05:00.000Z", deviceId: PHONE, rr });
  assert.equal(next.resolvedDeviceId, "first-phone-0001");
});

test("an engine withdrawal never picks up a phone, even if the order carries one", () => {
  const next = closeRequestTxn(openRr("2026-09-17T10:15:16.579Z"),
    { rrStatus: "cancelled", cancelReason: "no_longer_needed", refusedByDeviceId: PHONE }, "2026-09-17T15:00:00.000Z");
  assert.equal("resolvedDeviceId" in next, false);
});

test("end to end: four refusals → the write-off record names the phone of each that recorded one", async () => {
  const days = [
    ["2026-09-12T08:00:00.000Z", "2026-09-12T11:30:40.428Z", undefined],       // before phones were recorded
    ["2026-09-14T06:00:00.000Z", "2026-09-14T08:45:31.184Z", PHONE],
    ["2026-09-16T07:00:00.000Z", "2026-09-16T10:15:04.806Z", PHONE],
    ["2026-09-17T10:15:16.579Z", "2026-09-17T14:15:22.516Z", "other-phone-0002"],
  ];
  const rr = {};
  days.forEach(([createdAt, refusedAt, deviceId], i) => { rr[`rq${i}`] = closeOne({ createdAt, refusedAt, deviceId }).next; });
  // …and one refused in Central's queue, which writes resolvedDeviceId itself,
  // is read the same way (a request of its own, below).
  const db = makeFakeDb({ stock: STOCK(), refill_requests: rr, refill_engine: {}, stock_movements: {}, users: { u_ayob: { displayName: "Ayob" } } });
  const root = db.state.root;
  const snapshot = {
    nowMs: NOW, config: CONFIG, products: PRODUCTS, stock: structuredClone(root.stock), refillRequests: structuredClone(root.refill_requests),
    movements: [], rejectStreak: {}, cursors: {}, windowStartMs: NOW - 45 * 864e5,
  };
  const plan = planRefusalWriteoffs(snapshot);
  assert.equal(plan.writeoffs.length, 1);
  const update = async (patch) => { await db.ref().update(sanitizeUpdate(patch).safe); return true; };
  const res = await applyRefusalWriteoffs({ db, writeoffs: plan.writeoffs, snapshot, update, nowMs: NOW, runId: "r1" });
  const rec = (await db.ref(`refill_engine/refusalWriteoffs/${res.applied[0].id}`).once("value")).val();
  const list = Array.isArray(rec.refusals) ? rec.refusals : Object.values(rec.refusals);
  assert.deepEqual(list.map((x) => x.byDeviceId ?? null), [null, PHONE, PHONE, "other-phone-0002"]);
  assert.deepEqual(list.map((x) => x.byName ?? null), ["Ayob", "Ayob", "Ayob", "Ayob"]);
});

test("Central's queue refusal: resolvedDeviceId on the request reaches the write-off event", () => {
  const at = (d) => `2026-09-${d}T09:00:00.000Z`;
  const rrs = {};
  ["12", "14", "16", "17"].forEach((d, i) => {
    rrs[`c${i}`] = { productId: PID, size: "M", qty: 2, requestingLocation: "hub2", status: "cancelled", createdAt: at(d), resolvedAt: at(d),
      createdFrom: { engine: true, source: "central" }, resolvedBy: "u_mike", ...(i === 3 ? { resolvedDeviceId: PHONE } : {}) };
  });
  const plan = planRefusalWriteoffs({
    nowMs: NOW, config: CONFIG, products: PRODUCTS, stock: STOCK(), refillRequests: rrs,
    movements: [], rejectStreak: {}, cursors: {}, windowStartMs: NOW - 45 * 864e5,
  });
  assert.equal(plan.writeoffs.length, 1);
  assert.deepEqual(plan.writeoffs[0].refusals.map((x) => x.byDeviceId), [null, null, null, PHONE]);
});
