// The stranded-transit sweep releases nothing into a location with BOTH
// switches off (Solve off, Auto-refill off) — nothing routed goes there.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { holdNonLiveReleases } = require("../lib/transit-sweep.cjs");
const reg = require("../lib/network-registry.cjs");

const S1 = ["hub3", "marathon-pine", "concrete"];
const OFF = { solve: false, autoRefill: "off" };
const DARK = reg.normalizeNetwork({ locations: Object.fromEntries(S1.map((id) => [id, OFF])) });

const rel = (dest, lineId = `l-${dest}`) => ({ lineId, dest, productId: "p1", sizeKey: "M", qty: 1, why: "window passed" });
const plan = (dests) => ({ releases: dests.map((d) => rel(d)), refusals: [], pending: [{ lineId: "x", why: "early" }], skipped: [], retirements: [] });

test("every Section 2 destination passes — the plan is the SAME object", () => {
  const p = plan(["hub1", "hub2", "marathon-pe", "trophy"]);
  assert.equal(holdNonLiveReleases(p, reg.SEED_REGISTRY), p);
  assert.equal(holdNonLiveReleases(p, DARK), p);
  assert.equal(holdNonLiveReleases(p, null), p, "no registry at all = the seed");
});

test("the SEED (7 Oct 2026): Section 1 has Solve on + Auto-refill solved — the sweep releases there, same object", () => {
  const p = plan(["hub2", "hub3", "concrete", "marathon-pine"]);
  assert.equal(holdNonLiveReleases(p, reg.SEED_REGISTRY), p);
});

test("a line parked for a location with both switches off stays parked, and says why", () => {
  const out = holdNonLiveReleases(plan(["hub2", "hub3", "concrete"]), DARK);
  assert.deepEqual(out.releases.map((r) => r.dest), ["hub2"]);
  assert.equal(out.pending.length, 3);
  assert.match(out.pending[1].why, /Hub 3 has Solve and Auto-refill off/);
  assert.match(out.pending[2].why, /Concrete has Solve and Auto-refill off/);
});

test("EITHER switch on opens the lane: Solve alone, Auto-refill alone, a legacy live:true", () => {
  for (const hub3 of [{ solve: true, autoRefill: "off" }, { solve: false, autoRefill: "solved" }, { solve: false, autoRefill: "all" }, { live: true }]) {
    const net = reg.normalizeNetwork({ locations: { ...Object.fromEntries(S1.map((id) => [id, OFF])), hub3 } });
    const out = holdNonLiveReleases(plan(["hub3", "concrete"]), net);
    assert.deepEqual(out.releases.map((r) => r.dest), ["hub3"], JSON.stringify(hub3));
  }
});

test("a release whose transit debit already landed is completed even for a location with both switches off", () => {
  const p = plan(["hub3"]);
  p.releases.push({ ...rel("hub3", "l-resumed"), resumed: true });
  const out = holdNonLiveReleases(p, DARK);
  assert.deepEqual(out.releases.map((r) => r.lineId), ["l-resumed"]);
});

test("an unknown destination gets nothing", () => {
  assert.deepEqual(holdNonLiveReleases(plan(["hub9"]), reg.SEED_REGISTRY).releases, []);
});

test("THE CONCRETE STOCKROOM DOES NOT EXIST (8 Oct 2026): nothing is ever released there, even with a stored record switched on", () => {
  for (const net of [reg.SEED_REGISTRY, reg.normalizeNetwork({ locations: { "concrete-stockroom": { type: "hub", section: 1, solve: true, autoRefill: "all" } } })]) {
    assert.equal(net.locations["concrete-stockroom"], undefined);
    assert.deepEqual(holdNonLiveReleases(plan(["concrete-stockroom"]), net).releases, []);
  }
});
