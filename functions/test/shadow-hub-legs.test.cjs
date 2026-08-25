// ─── SHADOW SYNC — hub legs vs store legs (PR #449, owner order 2026-08-25) ──
// Run: cd functions && node --test test/shadow-hub-legs.test.cjs
//
// While a destination runs in shadow, its planned requests appear in the REAL
// operational surfaces as read-only artifacts. The pre-fix predicate was
// `dest === "hub2"`, so a hub1 shadow plan fell into the store-leg branch and
// surfaced in the warehouse CLOTHING queue as a bogus "Shop Refill" ORDER
// (productType clothing, destShop hub1) instead of a shadow refill_requests
// row on the Hub 1 Refill tab. The rule now: ANY non-store destination
// shadows as a refill_requests row in its own queue.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { _shadowSyncUpdates: shadowSyncUpdates } = require("../refill-scan.cjs");

const CTX = { products: { p1: { name: "Runner" } }, orders: {}, refillRequests: {}, runId: "r1", startedAt: "2026-08-25T10:00:00.000Z" };
const node = (dest) => ({ [dest]: { p1: { "8": { qty: 2, source: "central", priority: "normal" } } } });

test("a hub1 shadow plan is a refill_requests row in ITS queue — never a store order", () => {
  const upd = shadowSyncUpdates({ ...CTX, shadowNode: node("hub1") });
  const key = "refill_requests/SHDWrr-hub1-p1-8";
  assert.ok(upd[key], `expected ${key}, got ${JSON.stringify(Object.keys(upd))}`);
  assert.equal(upd[key].requestingLocation, "hub1");
  assert.equal(upd[key].shadow, true);
  assert.ok(!Object.keys(upd).some((k) => k.startsWith("orders/")), "no bogus Shop Refill order");
});

test("hub2 keeps its HISTORIC key byte-for-byte (no dest infix)", () => {
  const upd = shadowSyncUpdates({ ...CTX, shadowNode: node("hub2") });
  assert.ok(upd["refill_requests/SHDWrr-p1-8"], "hub2's deterministic key must not change shape");
  assert.equal(upd["refill_requests/SHDWrr-p1-8"].requestingLocation, "hub2");
});

test("a STORE leg still shadows as an order in the clothing queue", () => {
  const upd = shadowSyncUpdates({ ...CTX, shadowNode: node("marathon-pe") });
  const key = "orders/SHDW-marathon-pe-p1-8";
  assert.ok(upd[key]);
  assert.equal(upd[key].destShop, "marathon-pe");
  assert.equal(upd[key].autoShadow, true);
});

test("stale shadow artifacts of BOTH row formats are swept", () => {
  const upd = shadowSyncUpdates({
    ...CTX,
    shadowNode: {},
    orders: { "SHDW-marathon-pe-pX-9": { id: "x" }, "R001-1": { id: "keep" } },
    refillRequests: { "SHDWrr-pX-9": { shadow: true }, "SHDWrr-hub1-pX-9": { shadow: true }, real1: { status: "open" } },
  });
  assert.equal(upd["orders/SHDW-marathon-pe-pX-9"], null);
  assert.equal(upd["refill_requests/SHDWrr-pX-9"], null);
  assert.equal(upd["refill_requests/SHDWrr-hub1-pX-9"], null);
  assert.ok(!("orders/R001-1" in upd) && !("refill_requests/real1" in upd), "real rows untouched");
});
