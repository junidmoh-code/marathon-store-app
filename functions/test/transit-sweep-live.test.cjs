// The stranded-transit sweep releases nothing into a location that is not live.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { holdNonLiveReleases } = require("../lib/transit-sweep.cjs");
const reg = require("../lib/network-registry.cjs");

const rel = (dest, lineId = `l-${dest}`) => ({ lineId, dest, productId: "p1", sizeKey: "M", qty: 1, why: "window passed" });
const plan = (dests) => ({ releases: dests.map((d) => rel(d)), refusals: [], pending: [{ lineId: "x", why: "early" }], skipped: [], retirements: [] });

test("every Section 2 destination passes — the plan is the SAME object", () => {
  const p = plan(["hub1", "hub2", "marathon-pe", "trophy"]);
  assert.equal(holdNonLiveReleases(p, reg.SEED_REGISTRY), p);
  assert.equal(holdNonLiveReleases(p, null), p, "no registry at all = the seed");
});

test("a line parked for a location that is not live stays parked, and says why", () => {
  const out = holdNonLiveReleases(plan(["hub2", "hub3", "concrete-stockroom"]), reg.SEED_REGISTRY);
  assert.deepEqual(out.releases.map((r) => r.dest), ["hub2"]);
  assert.equal(out.pending.length, 3);
  assert.match(out.pending[1].why, /Hub 3 is not live/);
  assert.match(out.pending[2].why, /Concrete Stockroom is not live/);
});

test("once the owner marks it live the sweep releases there", () => {
  const live = reg.normalizeNetwork({ locations: { hub3: { live: true } } });
  const out = holdNonLiveReleases(plan(["hub3", "concrete-stockroom"]), live);
  assert.deepEqual(out.releases.map((r) => r.dest), ["hub3"]);
});

test("an unknown destination is not live", () => {
  assert.deepEqual(holdNonLiveReleases(plan(["hub9"]), reg.SEED_REGISTRY).releases, []);
});
