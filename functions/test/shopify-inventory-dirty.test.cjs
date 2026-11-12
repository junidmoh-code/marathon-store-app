// ── The marker trigger: what earns a mark, and what must not ─────────────────
// The decision has four gates, and each one has a way of being wrong that is
// invisible in production: an over-mark costs a wasted sweep, an UNDER-mark
// leaves a product oversellable and silent. So the under-marking cases are
// tested hardest.
const test = require("node:test");
const assert = require("node:assert");
const {
  sellableQty, sellableChanged, isLiveOn, markInventoryDirty,
  UNSELLABLE_LOCATIONS, ONLINE_EXCLUDED_LOCATIONS, DIRTY_PATH, REVIEW_DIRTY_PATH,
} = require("../lib/shopify-inventory-dirty.cjs");

// A fake db: get() reads a path from a plain object, set() records the write.
function fakeDb(store) {
  const writes = [];
  const at = (path) => {
    let node = store;
    for (const p of path.split("/")) { node = node?.[p]; if (node === undefined) return null; }
    return node === undefined ? null : node;
  };
  return {
    writes,
    db: { ref: (path) => ({ get: async () => ({ val: () => at(path) }), set: async (v) => writes.push([path, v]) }) },
  };
}
const INCREMENT = (n) => ({ __increment: n });
const deps = (store) => { const f = fakeDb(store); return { f, d: { db: f.db, increment: INCREMENT } }; };

const LIVE = { state: "live", liveState: "on" };

test("sellableQty clamps negatives and reads the movement-stamped cell shape", () => {
  assert.equal(sellableQty({ qty: 4, lastType: "sale" }), 4);
  assert.equal(sellableQty({ qty: -3 }), 0);   // negatives are bookkeeping, never sellable
  assert.equal(sellableQty(7), 7);             // bare number, old data
  assert.equal(sellableQty(null), 0);
  assert.equal(sellableQty(undefined), 0);
  assert.equal(sellableQty({}), 0);
});

test("sellableChanged compares PER SIZE, so a swap between sizes is a change", () => {
  // The sum is 5 both sides. Summing first would decline to mark the single
  // most common shop-floor movement, and two variants would stay wrong.
  assert.equal(sellableChanged({ S: { qty: 3 }, M: { qty: 2 } }, { S: { qty: 2 }, M: { qty: 3 } }), true);
});

test("sellableChanged ignores an edit that does not move a sellable quantity", () => {
  assert.equal(sellableChanged({ M: { qty: 2, mv: "a" } }, { M: { qty: 2, mv: "b" } }), false);
  // Two different flavours of nothing must also read as nothing.
  assert.equal(sellableChanged({ M: { qty: -1 } }, { M: { qty: -5 } }), false);
});

test("sellableChanged sees a cell appearing and a cell disappearing", () => {
  assert.equal(sellableChanged(null, { M: { qty: 1 } }), true);
  assert.equal(sellableChanged({ M: { qty: 1 } }, null), true);
  assert.equal(sellableChanged(null, null), false);
});

test("isLiveOn requires BOTH — a live product switched off sells nothing", () => {
  assert.equal(isLiveOn(LIVE), true);
  assert.equal(isLiveOn({ state: "live", liveState: "off" }), false);
  assert.equal(isLiveOn({ state: "awaiting", liveState: "on" }), false);
  assert.equal(isLiveOn(null), false);
});

test("marks a live product whose stock moved", async () => {
  const { f, d } = deps({
    stock: { pe: { p1: { M: { qty: 2 } } } },
    shopify_publish: { p1: LIVE },
  });
  const r = await markInventoryDirty(d, { loc: "pe", pid: "p1", before: { M: { qty: 5 } } });
  assert.equal(r.marked, true);
  assert.deepEqual(f.writes, [[`${DIRTY_PATH}/p1`, { __increment: 1 }]]);
});

test("the marker value is an INCREMENT, never a timestamp", async () => {
  // The sweep clears a marker only when the revision still matches. Two
  // movements in the same millisecond must be two revisions, which a clock
  // cannot promise and an atomic increment can.
  const { f, d } = deps({ stock: { pe: { p1: { M: { qty: 1 } } } }, shopify_publish: { p1: LIVE } });
  await markInventoryDirty(d, { loc: "pe", pid: "p1", before: null });
  assert.deepEqual(f.writes[0][1], { __increment: 1 });
});

test("does NOT inventory-mark a product that is not live on the storefront (review marker only)", async () => {
  const { f, d } = deps({
    stock: { pe: { p1: { M: { qty: 2 } } } },
    shopify_publish: { p1: { state: "live", liveState: "off" } },
  });
  const r = await markInventoryDirty(d, { loc: "pe", pid: "p1", before: { M: { qty: 5 } } });
  assert.equal(r.marked, false);
  assert.deepEqual(f.writes, [[`${REVIEW_DIRTY_PATH}/p1`, { __increment: 1 }]]);
});

test("does NOT inventory-mark a product with no publish node at all", async () => {
  const { f, d } = deps({ stock: { pe: { p1: { M: { qty: 2 } } } } });
  assert.equal((await markInventoryDirty(d, { loc: "pe", pid: "p1", before: null })).marked, false);
  assert.ok(!f.writes.some(([p]) => p.startsWith(DIRTY_PATH + "/")));
});

// ── THE REVIEW LIST'S MARKER (docs/SHOPIFY-REVIEW-INSTOCK.md) ───────────────
test("review-marks a not-live product whose last unit at a location sold", async () => {
  const { f, d } = deps({
    stock: { pe: { p1: { M: { qty: 0 } } } },
    shopify_publish: { p1: { state: "awaiting" } },
  });
  const r = await markInventoryDirty(d, { loc: "pe", pid: "p1", before: { M: { qty: 1 } } });
  assert.equal(r.marked, false);        // no Shopify inventory push
  assert.equal(r.reviewMarked, true);
  assert.deepEqual(f.writes, [[`${REVIEW_DIRTY_PATH}/p1`, { __increment: 1 }]]);
});

test("review-marks a product with NO node on restock — never-reviewed products are in the list too", async () => {
  const { f, d } = deps({ stock: { pe: { p1: { M: { qty: 2 } } } } });
  const r = await markInventoryDirty(d, { loc: "pe", pid: "p1", before: null });
  assert.equal(r.reviewMarked, true);
  assert.deepEqual(f.writes, [[`${REVIEW_DIRTY_PATH}/p1`, { __increment: 1 }]]);
});

test("review-marks ANY sellable change — 5→4 can cross the 4-unit bar with no size reaching zero", async () => {
  const { f, d } = deps({ stock: { pe: { p1: { M: { qty: 2 } } } }, shopify_publish: { p1: { state: "awaiting" } } });
  const r = await markInventoryDirty(d, { loc: "pe", pid: "p1", before: { M: { qty: 3 } } });
  assert.equal(r.reviewMarked, true);
  assert.deepEqual(f.writes, [[`${REVIEW_DIRTY_PATH}/p1`, { __increment: 1 }]]);
});

test("does NOT review-mark an edit that changes nothing sellable", async () => {
  const { f, d } = deps({ stock: { pe: { p1: { M: { qty: 2, mv: "b" } } } }, shopify_publish: { p1: { state: "awaiting" } } });
  await markInventoryDirty(d, { loc: "pe", pid: "p1", before: { M: { qty: 2, mv: "a" } } });
  assert.deepEqual(f.writes, []);
});

test("a live+on product gets the INVENTORY marker only, never the review marker", async () => {
  const { f, d } = deps({ stock: { pe: { p1: { M: { qty: 0 } } } }, shopify_publish: { p1: LIVE } });
  await markInventoryDirty(d, { loc: "pe", pid: "p1", before: { M: { qty: 1 } } });
  assert.deepEqual(f.writes, [[`${DIRTY_PATH}/p1`, { __increment: 1 }]]);
});

test("review-marks at Pine — its units count toward the website since 12 Nov 2026", async () => {
  const { f, d } = deps({ stock: { "marathon-pine": { p1: { M: { qty: 0 } } } } });
  await markInventoryDirty(d, { loc: "marathon-pine", pid: "p1", before: { M: { qty: 1 } } });
  assert.equal(f.writes.length, 1);
});

test("does NOT mark on the dead concrete-stockroom id — a tombstone, never sellable", async () => {
  const { f, d } = deps({
    stock: { "concrete-stockroom": { p1: { M: { qty: 2 } } } },
    shopify_publish: { p1: LIVE },
  });
  assert.equal((await markInventoryDirty(d, { loc: "concrete-stockroom", pid: "p1", before: null })).marked, false);
  assert.deepEqual(f.writes, []);
});

test("does NOT mark on a movement inside in_transit — it is not sellable", async () => {
  const { f, d } = deps({
    stock: { in_transit: { p1: { M: { qty: 2 } } } },
    shopify_publish: { p1: LIVE },
  });
  const r = await markInventoryDirty(d, { loc: "in_transit", pid: "p1", before: { M: { qty: 5 } } });
  assert.equal(r.marked, false);
  assert.deepEqual(f.writes, []);
  // And it never even read the publish node — the gate is first for a reason.
  assert.ok(UNSELLABLE_LOCATIONS.has("in_transit"));
});

// ── EVERY SHOP AND HUB COUNTS (Junid, 12 Nov 2026) ──────────────────────────
// Through the real entry point: a movement at Pine, Hub 3 or Concrete now
// marks the live product, so the storefront hears of it on the next tick.
for (const loc of ["marathon-pine", "hub3", "concrete", "central"]) {
  test(`marks a live product on a movement at ${loc} — its units feed the storefront`, async () => {
    const { f, d } = deps({
      stock: { [loc]: { p1: { M: { qty: 2 } } } },
      shopify_publish: { p1: LIVE },
    });
    const r = await markInventoryDirty(d, { loc, pid: "p1", before: { M: { qty: 5 } } });
    assert.equal(r.marked, true);
    assert.equal(f.writes.length, 1);
  });
}

test("STILL marks a movement at a trusted location — the gate refuses, it does not freeze", async () => {
  const { f, d } = deps({
    stock: { hub2: { p1: { M: { qty: 4 } } } },
    shopify_publish: { p1: LIVE },
  });
  assert.equal((await markInventoryDirty(d, { loc: "hub2", pid: "p1", before: { M: { qty: 1 } } })).marked, true);
  assert.equal(f.writes.length, 1);
});

test("the excluded set refuses mutation rather than pretending to be frozen", () => {
  // Object.freeze on a Set does NOT stop add/delete/clear. This asserts the
  // real refusal, not Object.isFrozen — which answers true either way and is
  // therefore worthless as a guarantee.
  assert.throws(() => ONLINE_EXCLUDED_LOCATIONS.delete("in_transit"), /immutable/);
  assert.throws(() => ONLINE_EXCLUDED_LOCATIONS.add("hub1"), /immutable/);
  assert.ok(ONLINE_EXCLUDED_LOCATIONS.has("in_transit"));
  assert.ok(!ONLINE_EXCLUDED_LOCATIONS.has("hub1"));
});

test("does NOT mark when nothing sellable changed", async () => {
  const { f, d } = deps({
    stock: { pe: { p1: { M: { qty: 2, mv: "new" } } } },
    shopify_publish: { p1: LIVE },
  });
  const r = await markInventoryDirty(d, { loc: "pe", pid: "p1", before: { M: { qty: 2, mv: "old" } } });
  assert.equal(r.marked, false);
  assert.deepEqual(f.writes, []);
});

test("the AFTER side is RE-READ, not taken from the event", async () => {
  // A stale or retried delivery carrying an `after` equal to `before` must not
  // be able to prove "nothing changed" against a node that has since moved.
  // Here the event's before says 5; the node now holds 2; it must mark.
  const store = { stock: { pe: { p1: { M: { qty: 2 } } } }, shopify_publish: { p1: LIVE } };
  const { f, d } = deps(store);
  const r = await markInventoryDirty(d, { loc: "pe", pid: "p1", before: { M: { qty: 5 } } });
  assert.equal(r.marked, true);
  assert.equal(f.writes.length, 1);
});

test("a missing location or product id is refused rather than writing a junk key", async () => {
  const { f, d } = deps({});
  assert.equal((await markInventoryDirty(d, { loc: "", pid: "p1", before: null })).marked, false);
  assert.equal((await markInventoryDirty(d, { loc: "pe", pid: "", before: null })).marked, false);
  assert.deepEqual(f.writes, []);
});
