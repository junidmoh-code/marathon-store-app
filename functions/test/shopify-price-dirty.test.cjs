// ── The price marker: an app retail edit on a listed product earns a mark ────
const test = require("node:test");
const assert = require("node:assert");
const { markPriceDirty, markRrpDirty, isListed, PRICE_DIRTY_PATH } = require("../lib/shopify-price-dirty.cjs");

function fakeDb(store) {
  const writes = [];
  const at = (path) => {
    let node = store;
    for (const p of path.split("/")) { node = node?.[p]; if (node === undefined) return null; }
    return node === undefined ? null : node;
  };
  return { writes, db: { ref: (path) => ({ get: async () => ({ val: () => at(path) }), set: async (v) => writes.push([path, v]) }) } };
}
const INCREMENT = (n) => ({ __increment: n });
const LIVE_ON = { state: "live", liveState: "on" };

test("Travis Scott: retail R450 → R700 on a live product marks it", async () => {
  const f = fakeDb({ products: { p1: { retailPrice: 700 } }, shopify_publish: { p1: LIVE_ON } });
  const r = await markPriceDirty({ db: f.db, increment: INCREMENT }, { pid: "p1", before: 450 });
  assert.deepStrictEqual(r, { marked: true });
  assert.deepStrictEqual(f.writes, [[`${PRICE_DIRTY_PATH}/p1`, { __increment: 1 }]]);
});

test("a price LOWERED in the app is marked too — the app owns price both ways", async () => {
  const f = fakeDb({ products: { p1: { retailPrice: 200 } }, shopify_publish: { p1: LIVE_ON } });
  assert.strictEqual((await markPriceDirty({ db: f.db, increment: INCREMENT }, { pid: "p1", before: 300 })).marked, true);
});

test("listed but switched OFF (still on Facebook/Instagram) is marked", async () => {
  const f = fakeDb({ products: { p1: { retailPrice: 700 } }, shopify_publish: { p1: { state: "live", liveState: "off" } } });
  assert.strictEqual((await markPriceDirty({ db: f.db, increment: INCREMENT }, { pid: "p1", before: 450 })).marked, true);
});

test("not listed on Shopify: no mark", async () => {
  for (const node of [null, { state: "awaiting" }, { state: "blocked" }]) {
    const f = fakeDb({ products: { p1: { retailPrice: 700 } }, shopify_publish: { p1: node } });
    const r = await markPriceDirty({ db: f.db, increment: INCREMENT }, { pid: "p1", before: 450 });
    assert.strictEqual(r.marked, false);
    assert.strictEqual(f.writes.length, 0);
  }
});

test("the same price written again (700 vs '700.00') is not a change", async () => {
  const f = fakeDb({ products: { p1: { retailPrice: "700.00" } }, shopify_publish: { p1: LIVE_ON } });
  assert.strictEqual((await markPriceDirty({ db: f.db, increment: INCREMENT }, { pid: "p1", before: 700 })).marked, false);
});

test("the CURRENT price is re-read, not taken from a stale event", async () => {
  // A retried delivery whose `before` equals an old value must still mark when
  // the record has since moved.
  const f = fakeDb({ products: { p1: { retailPrice: 700 } }, shopify_publish: { p1: LIVE_ON } });
  assert.strictEqual((await markPriceDirty({ db: f.db, increment: INCREMENT }, { pid: "p1", before: 450 })).marked, true);
});

test("a retail price cleared on a listed product is marked (the sweep decides)", async () => {
  const f = fakeDb({ products: { p1: {} }, shopify_publish: { p1: LIVE_ON } });
  assert.strictEqual((await markPriceDirty({ db: f.db, increment: INCREMENT }, { pid: "p1", before: 450 })).marked, true);
});

test("isListed matches inventorySync's isListedOnShopify (state live)", () => {
  assert.strictEqual(isListed({ state: "live", liveState: "off" }), true);
  assert.strictEqual(isListed({ state: "awaiting" }), false);
});

test("RRP chip 65 → 70 on a listed product marks it", async () => {
  const f = fakeDb({ shopify_publish: { p1: { ...LIVE_ON, rrpDiscountPct: 70 } } });
  assert.deepStrictEqual(await markRrpDirty({ db: f.db, increment: INCREMENT }, { pid: "p1", before: null }), { marked: true });
  assert.deepStrictEqual(f.writes, [[`${PRICE_DIRTY_PATH}/p1`, { __increment: 1 }]]);
});

test("RRP chip: absent ↔ 65 is no change; a non-listed product is not marked", async () => {
  const same = fakeDb({ shopify_publish: { p1: { ...LIVE_ON, rrpDiscountPct: 65 } } });
  assert.strictEqual((await markRrpDirty({ db: same.db, increment: INCREMENT }, { pid: "p1", before: null })).marked, false);
  const awaiting = fakeDb({ shopify_publish: { p1: { state: "awaiting", rrpDiscountPct: 70 } } });
  assert.strictEqual((await markRrpDirty({ db: awaiting.db, increment: INCREMENT }, { pid: "p1", before: 65 })).marked, false);
  assert.strictEqual(same.writes.length + awaiting.writes.length, 0);
});
