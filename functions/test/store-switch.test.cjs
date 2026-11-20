// ─── ALL-STORE ACCESS — audit log + completion gate/stamp ───────────────────
// Run: cd functions && npm test -- test/store-switch.test.cjs
// The fake RTDB deletes like the real one (null / empty children vanish), so
// an audit line from "no shop" (from:null) is checked as the database stores it.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb, readAt } = require("./helpers/fake-rtdb.cjs");
const { buildSwitchEntry, runLogStoreSwitch } = require("../storeSwitch/logStoreSwitch.js");
const { _displayCheckAllowed, _completionActor } = require("../displayChecks/completeCheck.js");

const SHOPS = ["marathon-pe", "trophy", "marathon-pine", "concrete"];
const NOW = Date.UTC(2026, 10, 20, 9, 0, 0); // 11:00 SAST, 20 Nov 2026

test("buildSwitchEntry: a confirmed switch is shaped with the server's uid and the user's own shop", () => {
  const out = buildSwitchEntry({
    uid: "u1", userRec: { displayName: "Asanda", destShop: "marathon-pe" }, shopIds: SHOPS, nowMs: NOW,
    data: { from: "marathon-pe", to: "concrete", reason: "switch", deviceId: "dev-123", clientAtMs: NOW - 500, uid: "forged" },
  });
  assert.equal(out.ok, true);
  assert.equal(out.saDate, "2026-11-20");
  assert.deepEqual(out.entry, { uid: "u1", name: "Asanda", from: "marathon-pe", to: "concrete", home: "marathon-pe", reason: "switch", deviceId: "dev-123", clientAtMs: NOW - 500 });
});

test("buildSwitchEntry: unknown shops, no-op switches and made-up reasons are refused", () => {
  const base = { uid: "u1", userRec: {}, shopIds: SHOPS, nowMs: NOW };
  assert.equal(buildSwitchEntry({ ...base, data: { from: "marathon-pe", to: "hub1", reason: "switch" } }).code, "unknown-shop");
  assert.equal(buildSwitchEntry({ ...base, data: { from: "trophy", to: "trophy", reason: "switch" } }).code, "no-change");
  assert.equal(buildSwitchEntry({ ...base, data: { from: "trophy", to: "concrete", reason: "because" } }).code, "bad-reason");
});

test("buildSwitchEntry: a queued line keeps its own SA day; a wild client clock falls back to today", () => {
  const base = { uid: "u1", userRec: {}, shopIds: SHOPS, nowMs: NOW, };
  const lateNight = Date.UTC(2026, 10, 19, 21, 30); // 23:30 SAST on the 19th
  assert.equal(buildSwitchEntry({ ...base, data: { from: "concrete", to: "trophy", reason: "daily-reset", clientAtMs: lateNight } }).saDate, "2026-11-19");
  assert.equal(buildSwitchEntry({ ...base, data: { from: "concrete", to: "trophy", reason: "daily-reset", clientAtMs: NOW - 30 * 86400000 } }).saDate, "2026-11-20");
});

test("runLogStoreSwitch appends ONE line under the SA day; nulls are dropped the way RTDB drops them", async () => {
  const db = makeFakeDb({ users: { u1: { displayName: "Junid", permissions: [] } } });
  const a = await runLogStoreSwitch(db, { uid: "u1", email: "x@y", nowMs: NOW, at: NOW, data: { from: null, to: "trophy", reason: "switch" } });
  const b = await runLogStoreSwitch(db, { uid: "u1", email: "x@y", nowMs: NOW, at: NOW + 1, data: { from: "trophy", to: null, reason: "daily-reset" } });
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  const day = readAt(db.state.root, "store_switch_log/2026-11-20");
  assert.deepEqual(Object.keys(day).sort(), [a.id, b.id].sort());
  // from/home/deviceId/clientAtMs were null → absent, exactly as stored live.
  assert.deepEqual(day[a.id], { uid: "u1", name: "Junid", to: "trophy", reason: "switch", at: NOW });
  assert.deepEqual(day[b.id], { uid: "u1", name: "Junid", from: "trophy", reason: "daily-reset", at: NOW + 1 });
  // Nothing else in the tree was touched (the seeded empty permissions array
  // never existed — RTDB, and this fake, delete empty-array children).
  assert.deepEqual(readAt(db.state.root, "users"), { u1: { displayName: "Junid" } });
});

test("runLogStoreSwitch refuses a bad line and writes nothing", async () => {
  const db = makeFakeDb({ users: { u1: { destShop: "trophy" } } });
  const out = await runLogStoreSwitch(db, { uid: "u1", nowMs: NOW, at: NOW, data: { from: "trophy", to: "nowhere", reason: "switch" } });
  assert.equal(out.ok, false);
  assert.equal(readAt(db.state.root, "store_switch_log"), null);
});

test("completeDisplayCheck gate: display_checks holders may complete for ANY shop; no grant still fails", () => {
  const staff = { permissions: ["display_checks"], destShop: "marathon-pe" };
  for (const store of SHOPS) {
    assert.equal(_displayCheckAllowed({ email: "s@x", emailVerified: true, userRec: staff, store }), true, store);
  }
  assert.equal(_displayCheckAllowed({ email: "s@x", emailVerified: true, userRec: { permissions: [] }, store: "concrete" }), false);
  assert.equal(_displayCheckAllowed({ email: "s@x", emailVerified: true, userRec: staff, store: "" }), false);
});

test("completedBy carries the shop the check counted for and the completer's own shop", () => {
  const away = _completionActor({ uid: "u1", email: "a@b", store: "concrete", userRec: { displayName: "Asanda", destShop: "marathon-pe" } });
  assert.deepEqual(away, { uid: "u1", name: "Asanda", email: "a@b", actingStore: "concrete", actingHomeStore: "marathon-pe", actingAway: true });
  const home = _completionActor({ uid: "u1", email: "a@b", store: "marathon-pe", userRec: { destShop: "marathon-pe" } });
  assert.equal(home.actingAway, false);
  const owner = _completionActor({ uid: "u2", email: "o@b", store: "trophy", userRec: {} });
  assert.equal(owner.actingHomeStore, null); assert.equal(owner.actingAway, false);
});

test("runLogStoreSwitch is capped per account per SA day", async () => {
  const db = makeFakeDb({ store_switch_log_count: { "2026-11-20": { u1: 200 } } });
  const out = await runLogStoreSwitch(db, { uid: "u1", nowMs: NOW, at: NOW, data: { from: "trophy", to: "concrete", reason: "switch" } });
  assert.deepEqual(out, { ok: false, code: "rate-limited" });
  assert.equal(readAt(db.state.root, "store_switch_log"), null);
  const other = await runLogStoreSwitch(db, { uid: "u2", nowMs: NOW, at: NOW, data: { from: "trophy", to: "concrete", reason: "sign-out" } });
  assert.equal(other.ok, true);
  assert.equal(readAt(db.state.root, "store_switch_log_count/2026-11-20/u2"), 1);
});

test("a resent queued line (same id) is written once, never overwritten", async () => {
  const db = makeFakeDb({});
  const data = { id: "1795600000000_abc123", from: "trophy", to: "concrete", reason: "switch" };
  const a = await runLogStoreSwitch(db, { uid: "u1", nowMs: NOW, at: NOW, data });
  const b = await runLogStoreSwitch(db, { uid: "u1", nowMs: NOW, at: NOW + 5, data });
  assert.equal(a.id, data.id); assert.equal(b.duplicate, true);
  const day = readAt(db.state.root, "store_switch_log/2026-11-20");
  assert.deepEqual(Object.keys(day), [data.id]);
  assert.equal(day[data.id].at, NOW);
});

test("a resend does not spend the daily allowance", async () => {
  const db = makeFakeDb({});
  const data = { id: "1795600000000_zzz999", from: "trophy", to: "concrete", reason: "switch" };
  await runLogStoreSwitch(db, { uid: "u1", nowMs: NOW, at: NOW, data });
  await runLogStoreSwitch(db, { uid: "u1", nowMs: NOW, at: NOW, data });
  assert.equal(readAt(db.state.root, "store_switch_log_count/2026-11-20/u1"), 1);
});
