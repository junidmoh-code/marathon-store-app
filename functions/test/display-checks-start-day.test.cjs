// ─── DISPLAY CHECKS — PINE ON, FROM THE SALES OF 23 NOV 2026 (Junid, 22 Nov 2026)
// Pine's display check was off only because nothing had switched it on: a shop
// follows the registry's "fully live" flag unless /displayChecks_settings/
// {shop}/enabled says otherwise, and Pine is not fully live. It is now ON, for
// everything except sneakers (as Trophy), with a start day so nothing sold
// before 23 Nov (Africa/Johannesburg) becomes a task.
"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9";
const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../displayChecks/lib.cjs");
const reg = require("../lib/network-registry.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");
const { __resetDisplaySettingsCacheForTests, loadStoreSettings } = require("../displayChecks/settings.cjs");
const { handleDisplaySale } = require("../displayChecks/onDisplaySale.js");

const SEED = reg.SEED_REGISTRY;
const PINE = "marathon-pine";
// What the go-live writes for Pine (scripts/display/pine-display-check-on.mjs).
const PINE_ON = { enabled: true, scope: "all_but_sneakers", startsOn: "2026-11-23" };
// SAST is UTC+2: 23 Nov 00:00 SAST is 22 Nov 22:00 UTC.
const sast = (s) => Date.parse(`${s}+02:00`);

const P = {
  tee: { id: "tee", name: "Tee", productType: "clothing", category: "Clothing", sizes: ["M"] },
  sun: { id: "sun", name: "Ray", category: "Accessories", categoryKey: "sunglasses", sizes: ["_"] },
  perfume: { id: "perfume", name: "Scent", category: "Perfume", sizes: ["_"] },
  sneaker: { id: "sneaker", name: "Shoe", productType: "sneaker", category: "Footwear", subcategory: "Sneakers", sizes: ["9"] },
  slide: { id: "slide", name: "Slide", category: "Footwear", subcategory: "Slides", sizes: ["9"] },
};

test("why it was off: with no switch Pine follows the live flag, and Pine is not fully live", () => {
  assert.equal(SEED.locations[PINE].live, false);
  assert.equal(lib.isTriggerStoreEnabled(PINE, SEED, null), false);
  assert.equal(lib.isTriggerStoreEnabled(PINE, SEED, {}), false);
  assert.equal(lib.isTriggerStoreEnabled(PINE, SEED, PINE_ON), true);
  assert.equal(lib.normStoreSettings(PINE_ON).scope, "all_but_sneakers");
  assert.deepEqual(lib.triggerStores(SEED).sort(), ["marathon-pe", "trophy"]);
  assert.deepEqual(lib.triggerStores(SEED, { [PINE]: PINE_ON }).sort(), [PINE, "marathon-pe", "trophy"].sort());
});

test("the start day: a readable YYYY-MM-DD or nothing", () => {
  assert.equal(lib.normStoreSettings(PINE_ON).startsOn, "2026-11-23");
  for (const junk of [undefined, null, "", "23 Nov", "2026-11-23T00:00", 20261123, true]) {
    assert.equal(lib.normStoreSettings({ enabled: true, startsOn: junk }).startsOn, null);
  }
});

test("saleOnOrAfterStart: 22 Nov never counts, 23 Nov does — on the SA calendar, to the minute", () => {
  const ok = (nowMs, saleTs) => lib.saleOnOrAfterStart(PINE_ON, { nowMs, saleTs });
  assert.equal(ok(sast("2026-11-22T10:00:00"), sast("2026-11-22T10:00:00")), false);
  assert.equal(ok(sast("2026-11-22T23:59:59"), sast("2026-11-22T23:59:59")), false);   // 21:59 UTC on the 22nd
  assert.equal(ok(sast("2026-11-23T00:00:00"), sast("2026-11-23T00:00:00")), true);    // 22:00 UTC on the 22nd
  assert.equal(ok(sast("2026-11-23T09:30:00"), sast("2026-11-23T09:30:00")), true);
  assert.equal(ok(sast("2026-11-30T09:30:00"), sast("2026-11-30T09:30:00")), true);
  // NO BACKLOG: rung up on the 22nd, reaching the server on the 23rd (a till
  // that synced late) — still nothing.
  assert.equal(ok(sast("2026-11-23T08:00:00"), sast("2026-11-22T17:45:00")), false);
  assert.equal(ok(sast("2026-11-23T08:00:00"), "2026-11-22T15:45:00.000Z"), false);    // an ISO time is read too
  // A sale with no time of its own is judged on the server's day.
  assert.equal(ok(sast("2026-11-23T08:00:00"), null), true);
  assert.equal(ok(sast("2026-11-22T08:00:00"), null), false);
  assert.equal(ok(sast("2026-11-23T08:00:00"), "not a time"), true);
});

test("no start day (Marathon PE, Trophy, Concrete): every sale counts, exactly as before", () => {
  for (const s of [null, undefined, {}, { enabled: true }, { enabled: true, scope: "all_but_sneakers" }, { enabled: true, startsOn: "soon" }]) {
    assert.equal(lib.saleOnOrAfterStart(s, { nowMs: sast("2026-11-22T10:00:00"), saleTs: sast("2026-01-01T10:00:00") }), true);
    assert.equal(lib.saleOnOrAfterStart(s, { nowMs: 0, saleTs: null }), true);
  }
});

// ── THE TRIGGER, END TO END (a Pine till sale writes no movement: onDisplaySale)
const sale = (createdAt, lines) => ({ type: "sale", status: "completed", storeId: "pine", createdAt, lineItems: lines });
const LINES = {
  L1: { productId: "tee", size: "M", qty: 1 },
  L2: { productId: "sun", size: null, qty: 1 },
  L3: { productId: "perfume", size: null, qty: 1 },
  L4: { productId: "sneaker", size: "9", qty: 1 },
  L5: { productId: "slide", size: "9", qty: 1 },
};
function world(settings) {
  __resetNetworkCacheForTests(); __resetDisplaySettingsCacheForTests();
  return makeFakeDb({
    products: P,
    stock: { [PINE]: { tee: { M: { qty: 2 } }, sun: { _: { qty: 3 } } } },
    displayChecks_settings: settings ? { [PINE]: settings } : {},
  });
}
const active = (db) => db.state.root.displayChecks_active?.[PINE] || {};

test("a Pine sale on 22 Nov creates nothing", async () => {
  const db = world(PINE_ON);
  const at = sast("2026-11-22T16:20:00");
  const r = await handleDisplaySale({ db, saleId: "S22", sale: sale(at, LINES), nowMs: at });
  assert.equal(r.checked, 0);
  assert.equal(r.beforeStart, true);
  assert.equal(db.state.root.displayChecks_active, undefined);
  assert.equal(db.state.root.displayChecks_log, undefined);
  assert.equal(db.state.root.displayChecks_meta, undefined);
  // …nor when that sale only reaches the server on the 23rd.
  const late = await handleDisplaySale({ db, saleId: "S22", sale: sale(at, LINES), nowMs: sast("2026-11-23T08:05:00") });
  assert.equal(late.checked, 0);
  assert.equal(db.state.root.displayChecks_active, undefined);
});

test("a sale with no readable time, received at 23:59 on 22 Nov and processed after midnight, creates nothing", async () => {
  const { eventTimeMs } = require("../displayChecks/lib.cjs");
  const db = world(PINE_ON);
  const received = sast("2026-11-22T23:59:30");
  const noTime = { ...sale(received, LINES), createdAt: null };
  const r = await handleDisplaySale({ db, saleId: "SX", sale: noTime, nowMs: sast("2026-11-23T00:00:20"), eventMs: received });
  assert.equal(r.checked, 0);
  assert.equal(db.state.root.displayChecks_active, undefined);
  assert.equal(eventTimeMs({ time: new Date(received).toISOString() }), received);
  assert.equal(eventTimeMs({}), null);
  assert.equal(eventTimeMs({ time: "nonsense" }), null);
});

test("a Pine non-sneaker sale on 23 Nov creates a display task; a sneaker sale creates none", async () => {
  const db = world(PINE_ON);
  const at = sast("2026-11-23T09:15:00");
  const r = await handleDisplaySale({ db, saleId: "S23", sale: sale(at, LINES), nowMs: at });
  assert.equal(r.checked, 3);
  assert.deepEqual(Object.keys(active(db)).sort(), ["perfume___", "sun___", "tee__M"]);
  assert.equal(active(db)["tee__M"].status, "open");
  assert.equal(active(db)["sun___"].status, "open");
  assert.equal(active(db)["tee__M"].triggerSaleId, "S23");
  assert.equal(Object.keys(active(db)).some((k) => k.startsWith("sneaker") || k.startsWith("slide")), false);
  // A sneaker-only sale: nothing at all.
  const db2 = world(PINE_ON);
  const only = await handleDisplaySale({ db: db2, saleId: "S24", sale: sale(at, { L4: LINES.L4, L5: LINES.L5 }), nowMs: at });
  assert.equal(only.checked, 0);
  assert.equal(db2.state.root.displayChecks_active, undefined);
});

test("with no switch written Pine stays dark — the state before 22 Nov", async () => {
  const db = world(null);
  const at = sast("2026-11-23T09:15:00");
  const r = await handleDisplaySale({ db, saleId: "S23", sale: sale(at, LINES), nowMs: at });
  assert.equal(r.checked, 0);
  assert.equal(r.off, true);
  assert.equal(db.state.root.displayChecks_active, undefined);
});

test("the settings loader reads the start day with the switch and the scope (three keyed reads, never the node)", async () => {
  const db = world({ ...PINE_ON, roster: { locked: true, days: {} } });
  const s = await loadStoreSettings(db, PINE);
  assert.deepEqual(s, PINE_ON);
});
