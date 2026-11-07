// ─── HUB 3 DISPLAY REGISTRATION vs THE PAUSED SCAN (Junid, 7 Nov 2026) ────────
// A display registered at Hub 3 adds one unit to a Hub 3 cell through a plain
// `received` movement — no refill/order link, so it never stamps trust
// (stock-trust.cjs arrivalTrust). Hub 3's Auto-refill is "solved": the engine
// reads TRUSTED cells only there. This pins what the scan does with that unit
// while /config/refillEngine/pausedLocations/hub3 is on:
//   1. on an untrusted cell (1,621 of Hub 3's 1,647 cells on 7 Nov) the scan's
//      plan is unchanged — nothing raised, nothing unparked, anywhere;
//   2. Hub 3 as a DESTINATION stays held whatever its cells hold;
//   3. THE BOUNDARY (reported to Junid, not changed — CLAUDE.md): on a cell
//      that ALREADY carries a trust marker, the unit is real Hub 3 stock to the
//      scan, and Pine's trusted short cells are fed from it. The pause holds
//      Hub 3 only as a destination (#858), so that is the scan comparing on
//      hand against policy — the one legitimate requester.
// Run: cd functions && node --test test/hub3-display-baseline.test.cjs
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeRefillPlan } = require("../lib/refill-engine.cjs");
const reg = require("../lib/network-registry.cjs");
const trust = require("../lib/stock-trust.cjs");
const pl = require("../lib/paused-locations.cjs");
const FIXTURE = require("./fixtures/sections-routing-fixture.json");

const clone = (v) => JSON.parse(JSON.stringify(v));
const T = "2026-11-06T08:00:00.000Z";
const trusted = (qty) => ({ qty, v: 1, mv: "m", lastType: "adjustment", ...trust.trustStamp("refill", T) });
const untrusted = (qty) => ({ qty, v: 1, mv: "m", lastType: "adjustment" });
const CONFIG = { ...clone(FIXTURE.config), pausedLocations: { hub3: true } };
const PAUSED = pl.pausedLocationSet(CONFIG);

function scan(stock) {
  return pl.withoutPausedDestinations(computeRefillPlan({
    nowMs: Date.parse("2026-11-06T10:00:00.000Z"), config: clone(CONFIG), targets: clone(FIXTURE.targets),
    stock, products: clone(FIXTURE.products), openIndex: {}, refillRequests: {}, orders: {}, movements: [],
    network: reg.SEED_REGISTRY,
  }), PAUSED);
}
const sig = (plan) => JSON.stringify(Object.fromEntries(pl.DEST_LISTS.map((k) => [k, (plan[k] || []).map((e) => JSON.stringify(e)).sort()])));

// A world where Pine has trusted short cells for products Marathon PE is being
// refilled with — so a Hub 3 source WOULD be used if the scan could see one.
// Without this the "nothing raised" claims below would be vacuous.
function world(hub3Cell) {
  const stock = clone(FIXTURE.stock);
  for (const [pid, sizes] of Object.entries(stock.hub3 || {})) for (const k of Object.keys(sizes || {})) stock.hub3[pid][k] = untrusted(0);
  const base = scan(clone(FIXTURE.stock)).intents.filter((i) => i.dest === "marathon-pe").slice(0, 5);
  assert.ok(base.length >= 3, "fixture must refill Marathon PE");
  stock["marathon-pine"] = stock["marathon-pine"] || {};
  for (const i of base) {
    stock["marathon-pine"][i.productId] = { ...(stock["marathon-pine"][i.productId] || {}), [i.sizeKey]: trusted(0) };
    stock.hub3[i.productId] = { ...(stock.hub3[i.productId] || {}), [i.sizeKey]: hub3Cell(0) };
  }
  return { stock, cells: base.map((i) => [i.productId, i.sizeKey]) };
}
const register = (stock, [pid, k]) => {   // the registration's write: +1, lastType received, marker untouched
  const s = clone(stock);
  s.hub3[pid][k] = { ...s.hub3[pid][k], qty: (s.hub3[pid][k].qty || 0) + 1, lastType: "received" };
  return s;
};

test("1. a registration on an UNTRUSTED zeroed Hub 3 cell changes nothing in the paused scan", () => {
  const { stock, cells } = world(untrusted);
  const before = sig(scan(stock));
  for (const c of cells) assert.equal(sig(scan(register(stock, c))), before, `cell ${c}`);
  let all = stock; for (const c of cells) all = register(all, c);
  assert.equal(sig(scan(all)), before, "all of them at once");
});

test("2. Hub 3 as a destination stays held, whatever a registration puts there", () => {
  for (const make of [untrusted, trusted]) {
    const { stock, cells } = world(make);
    let all = stock; for (const c of cells) all = register(all, c);
    const p = scan(all);
    for (const k of pl.DEST_LISTS) assert.equal((p[k] || []).filter((e) => e.dest === "hub3").length, 0, k);
  }
});

test("3. THE BOUNDARY: on an already-TRUSTED Hub 3 cell the unit is Hub 3 stock to the scan (reported, not changed)", () => {
  const { stock, cells } = world(trusted);
  const before = scan(stock);
  assert.equal(before.intents.filter((i) => i.source === "hub3").length, 0, "zeroed: Hub 3 feeds nothing");
  let all = stock; for (const c of cells) all = register(all, c);
  const after = scan(all).intents.filter((i) => i.source === "hub3");
  assert.ok(after.length > 0, "a trusted unit at Hub 3 feeds Pine's trusted short cells");
  for (const i of after) assert.equal(i.dest, "marathon-pine");
});

test("the registration movement itself never stamps trust", () => {
  assert.equal(trust.arrivalTrust({ type: "received", to: "hub3", productId: "p", size: "7", qty: 1 }), null);
});
