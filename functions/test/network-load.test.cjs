// loadNetwork: one read per minute per instance, the seed on failure, and a
// failure never cached.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadNetwork, TTL_MS, __resetNetworkCacheForTests } = require("../lib/network-load.cjs");
const reg = require("../lib/network-registry.cjs");

function fakeDb(answers) {
  const calls = [];
  return {
    calls,
    ref(path) {
      return {
        async once() {
          calls.push(path);
          const a = answers.shift();
          if (a instanceof Error) throw a;
          return { val: () => a };
        },
      };
    },
  };
}

test("reads /network — that one path — and normalises it", async () => {
  __resetNetworkCacheForTests();
  const db = fakeDb([{ locations: { hub3: { live: true } } }]);
  const R = await loadNetwork(db, { nowMs: 1000 });
  assert.deepEqual(db.calls, ["network"]);
  assert.equal(reg.isLive(R, "hub3"), true);
  assert.equal(reg.isLive(R, "concrete"), false);
});

test("serves the cached registry inside the TTL and re-reads after it", async () => {
  __resetNetworkCacheForTests();
  const db = fakeDb([null, { creditScope: "section" }]);
  await loadNetwork(db, { nowMs: 1000 });
  const again = await loadNetwork(db, { nowMs: 1000 + TTL_MS - 1 });
  assert.equal(db.calls.length, 1);
  assert.equal(again.creditScope, "shared");
  const later = await loadNetwork(db, { nowMs: 1000 + TTL_MS });
  assert.equal(db.calls.length, 2);
  assert.equal(later.creditScope, "section");
});

test("fresh:true bypasses the cache", async () => {
  __resetNetworkCacheForTests();
  const db = fakeDb([null, { creditScope: "section" }]);
  await loadNetwork(db, { nowMs: 1000 });
  const R = await loadNetwork(db, { nowMs: 1001, fresh: true });
  assert.equal(R.creditScope, "section");
});

test("a missing node is the seed: Section 2 live, Section 1 not, wall up", async () => {
  __resetNetworkCacheForTests();
  const R = await loadNetwork(fakeDb([null]), { nowMs: 1 });
  assert.deepEqual(R, reg.SEED_REGISTRY);
  assert.equal(reg.autoRouteAllowed(R, "hub2", "trophy"), true);
  assert.equal(reg.autoRouteAllowed(R, "central", "hub3"), false);
  assert.equal(reg.wallAllows(R, "hub2", "hub3"), false);
});

test("a failed read answers the seed and is not cached", async () => {
  __resetNetworkCacheForTests();
  const origErr = console.error;
  console.error = () => {};
  try {
    const db = fakeDb([new Error("permission denied"), { locations: { hub3: { live: true } } }]);
    const first = await loadNetwork(db, { nowMs: 1000 });
    assert.deepEqual(first, reg.SEED_REGISTRY);
    const second = await loadNetwork(db, { nowMs: 1001 });
    assert.equal(db.calls.length, 2);
    assert.equal(reg.isLive(second, "hub3"), true);
  } finally {
    console.error = origErr;
  }
});

test("a clock that went backwards does not serve a stale cache forever", async () => {
  __resetNetworkCacheForTests();
  const db = fakeDb([null, { creditScope: "section" }]);
  await loadNetwork(db, { nowMs: 5000 });
  const R = await loadNetwork(db, { nowMs: 10 });
  assert.equal(R.creditScope, "section");
});
