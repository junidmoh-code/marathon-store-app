"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseClaimArgs, decideClaim, mediaHasHash, maySetPublishing } = require("../lib/media-hash.cjs");
const { _handleMediaHashClaim } = require("../mediaHash/mediaHashClaim.js");

const SHA = "a".repeat(64);

function fakeDb(store) {
  const reads = [];
  const at = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), store) ?? null;
  const setAt = (path, v) => {
    const ks = path.split("/").filter(Boolean);
    let n = store;
    for (const k of ks.slice(0, -1)) n = n[k] ??= {};
    n[ks.at(-1)] = v;
  };
  return {
    reads,
    ref: (path) => ({
      once: async () => { reads.push(path); const v = at(path); return { val: () => v, exists: () => v != null }; },
      transaction: async (fn) => {
        // The real SDK's cold-cache first pass: an undefined answer ABORTS
        // there and then, without ever asking the server.
        const first = fn(null);
        if (first === undefined) return { committed: false, snapshot: { val: () => at(path) } };
        const real = at(path);
        if (real === null) { setAt(path, first); return { committed: true, snapshot: { val: () => at(path) } }; }
        const next = fn(real);
        if (next !== undefined) setAt(path, next);
        return { committed: next !== undefined, snapshot: { val: () => at(path) } };
      },
    }),
  };
}
const req = (data, token = { email: "gunidmoh@gmail.com", firebase: { sign_in_provider: "password" } }) =>
  ({ auth: { uid: "u1", token }, data });

test("EMPTY-PID GUARD: an empty or malformed product id is refused before any read", async () => {
  for (const bad of ["", null, "a/b", "p1.x", "x".repeat(65)]) {
    assert.match(parseClaimArgs({ productId: bad, sha256: SHA }).problem, /product/);
  }
  const db = fakeDb({ users: { u1: {} }, products: { p1: { name: "x" } } });
  await assert.rejects(_handleMediaHashClaim(req({ productId: "", sha256: SHA }), { db, now: () => 1 }), /Which product/);
  assert.ok(!db.reads.includes("products/"), "never a read of the whole products node");
  assert.ok(db.reads.every((p) => p !== "products" && p !== "products/"));
});

test("an exact file already owned by ANOTHER product is refused, naming that product", async () => {
  const db = fakeDb({
    users: { u1: {} },
    products: { p1: { name: "Plain tee black" }, p2: { name: "Plain tee white" } },
    shopify_publish: { p2: { media: [{ id: "m1", type: "photo", url: "u", sha256: SHA }] } },
    shopify_sync: { _mediaHash: { [SHA]: { pid: "p2", at: 1 } } },
  });
  const r = await _handleMediaHashClaim(req({ productId: "p1", sha256: SHA, kind: "photo" }), { db, now: () => 5 });
  assert.deepEqual(r, { ok: false, ownerPid: "p2", ownerName: "Plain tee white", inFlight: false });
  // Only per-path reads: the owner's media list and name, never a scan.
  assert.ok(db.reads.includes("shopify_publish/p2/media"));
  assert.ok(!db.reads.some((p) => p === "shopify_publish" || p === "products"));
});

test("the claim moves when the owner no longer carries the file (Junid removed the wrong photo)", async () => {
  const store = {
    users: { u1: {} }, products: { p1: { name: "a" }, p2: { name: "b" } },
    shopify_publish: { p2: { media: [{ id: "m9", type: "photo", url: "v", sha256: "b".repeat(64) }] } },
    shopify_sync: { _mediaHash: { [SHA]: { pid: "p2", at: 1 } } },
  };
  const r = await _handleMediaHashClaim(req({ productId: "p1", sha256: SHA }), { db: fakeDb(store), now: () => 20 * 60 * 1000 });
  assert.deepEqual(r, { ok: true, transferredFrom: "p2" });
  assert.equal(store.shopify_sync._mediaHash[SHA].pid, "p1");
});

test("an upload still in flight holds its claim: a second product within 15 minutes is refused", async () => {
  const store = {
    users: { u1: {} }, products: { p1: { name: "a" }, p2: { name: "b" } },
    shopify_sync: { _mediaHash: { [SHA]: { pid: "p2", at: 1_000 } } },
  };
  const r = await _handleMediaHashClaim(req({ productId: "p1", sha256: SHA }), { db: fakeDb(store), now: () => 60_000 });
  assert.deepEqual(r, { ok: false, ownerPid: "p2", ownerName: "b", inFlight: true });
});

test("a new file is claimed; the same product re-claiming is fine", async () => {
  const store = { users: { u1: {} }, products: { p1: { name: "a" } } };
  const db = fakeDb(store);
  assert.deepEqual(await _handleMediaHashClaim(req({ productId: "p1", sha256: SHA, kind: "video" }), { db, now: () => 9 }), { ok: true, transferredFrom: null });
  assert.deepEqual(store.shopify_sync._mediaHash[SHA], { pid: "p1", at: 9, uid: "u1", kind: "video" });
  // Re-claiming an entry that EXISTS — the path the cold-pass abort used to break.
  assert.equal((await _handleMediaHashClaim(req({ productId: "p1", sha256: SHA }), { db, now: () => 10 })).ok, true);
});

test("only Junid, a stock admin or a shopify_publish holder may claim", async () => {
  assert.equal(maySetPublishing({ email: "x@y", firebase: {} }, { stockRole: "staff" }), false);
  assert.equal(maySetPublishing({ email: "x@y", firebase: {} }, { permFlags: { shopify_publish: true } }), true);
  assert.equal(maySetPublishing({ email: "gunidmoh@gmail.com", firebase: { sign_in_provider: "anonymous" } }, {}), false);
  const db = fakeDb({ users: { u1: { stockRole: "staff" } }, products: { p1: { name: "a" } } });
  await assert.rejects(_handleMediaHashClaim(req({ productId: "p1", sha256: SHA }, { email: "s@x", firebase: {} }), { db, now: () => 1 }), /limited to Junid/);
});

test("decideClaim / mediaHasHash", () => {
  assert.deepEqual(decideClaim({ pid: "p1", existing: null, ownerUses: false }), { claim: true });
  assert.deepEqual(decideClaim({ pid: "p1", existing: { pid: "p2" }, ownerUses: true }), { claim: false, ownerPid: "p2", inFlight: false });
  assert.equal(mediaHasHash({ 0: { sha256: SHA }, 3: { sha256: "x" } }, SHA), true); // object shape (a list with a hole)
  assert.equal(mediaHasHash(null, SHA), false);
});
