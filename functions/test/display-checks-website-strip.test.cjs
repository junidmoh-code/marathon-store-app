// ─── THE WEBSITE STRIP at a store whose Display Checks are off (Junid, 12 Nov 2026) ──
// Pine is not live and its Display Checks switch is unset, so its till sales
// raise no display checks — but website lines routed to Pine sit on its strip
// and must be closable. These pin: the strip gate (isWebsiteStripEnabled), and
// that a website-only store closes ONLY website records through runComplete.
"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9";

const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../displayChecks/lib.cjs");
const { runComplete } = require("../displayChecks/completeCheck.js");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { SEED_REGISTRY } = require("../lib/network-registry.cjs");

const NOW = Date.parse("2026-11-12T09:00:00.000Z");
const STORE = "marathon-pine";
const KEY = "online__9100__0_r1";
const ACTOR = { uid: "u-pine", name: "Pine staff", email: "pine@marathon.internal" };

const pick = (over = {}) => ({
  checkId: "c1", productId: "TEE", productName: "Club Tee", size: "M", sizeKey: "M", status: "open",
  activatedAt: NOW - 60e3, activatedSaDate: "2026-11-12", createdAt: NOW - 60e3, assignedTo: null,
  kind: "online_pick", ref: "#2100", orderId: "9100", lineIndex: 0, qty: 1, dedupeKey: KEY, ...over,
});
const order = () => ({
  ref: "#2100", status: "picking",
  lines: [{ lineId: "l0", pid: "TEE", size: "M", qty: 1, routeGen: 1, source: { locationId: STORE, status: "display", entryKey: `displayChecks_active/${STORE}/${KEY}` } }],
});
const call = (db, over = {}) => runComplete(db, {
  store: STORE, key: KEY, checkId: "c1", result: "handed", override: false, actor: ACTOR, nowMs: NOW,
  storeName: "Marathon Pine", websiteOnly: true, ...over,
});

test("the strip gate: every registry store unless switched OFF explicitly; never a hub or Central", () => {
  assert.equal(lib.isWebsiteStripEnabled("marathon-pine", SEED_REGISTRY, null), true);
  assert.equal(lib.isWebsiteStripEnabled("marathon-pine", SEED_REGISTRY, {}), true);
  assert.equal(lib.isWebsiteStripEnabled("concrete", SEED_REGISTRY, { enabled: true }), true);
  assert.equal(lib.isWebsiteStripEnabled("trophy", SEED_REGISTRY, { enabled: false }), false);
  assert.equal(lib.isWebsiteStripEnabled("hub3", SEED_REGISTRY, null), false);
  assert.equal(lib.isWebsiteStripEnabled("central", SEED_REGISTRY, null), false);
  // …and Pine's sale-driven display checks stay OFF.
  assert.equal(lib.isTriggerStoreEnabled("marathon-pine", SEED_REGISTRY, null), false);
});

test("a website-only store closes a website pick: the order line goes to handed", async () => {
  const db = makeFakeDb({ displayChecks_active: { [STORE]: { [KEY]: pick() } }, online_orders: { 9100: order() } });
  const out = await call(db);
  assert.equal(out.kind, "ok");
  assert.equal(db.state.root.online_orders["9100"].lines["0"].source.status, "handed");
});

test("a website-only store refuses a display-check record (store-off) and leaves it open", async () => {
  const rec = pick();
  for (const k of ["kind", "orderId", "lineIndex", "ref", "dedupeKey"]) delete rec[k];
  const db = makeFakeDb({ displayChecks_active: { [STORE]: { [KEY]: rec } }, online_orders: { 9100: order() } });
  const out = await call(db, { result: "confirmed" });
  assert.deepEqual(out, { kind: "reject", code: "store-off" });
  assert.equal(db.state.root.displayChecks_active[STORE][KEY].status, "open");
});
