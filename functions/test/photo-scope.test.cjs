// ─── generateProductPhotos SCOPING — the decisions that cost money or data ───
// The callable's only behavioural change in this PR had no test at all, which
// is the wrong way round: it is the paid, admin-callable one. These pin the
// two things that go wrong quietly — reading the catalogue when nobody asked
// for it, and writing into a node that belongs to another surface.
"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  PHOTO_MAX_BATCH, APP_STORAGE_PREFIX, isSafeProductId,
  resolveNamedIds, resolveSourceUrl, needsCatalogueScan, pickIds, mayRecordProposal,
} = require("../lib/photo-scope.cjs");

const URL_OK = `${APP_STORAGE_PREFIX}products%2Fp1%2Fshopify%2Fupload_1.jpg?alt=media&token=abc`;

test("named ids and the sweep are told apart", () => {
  assert.deepStrictEqual(resolveNamedIds({ productIds: ["p1", "p2"] }), ["p1", "p2"]);
  assert.strictEqual(resolveNamedIds({}), null);
  assert.strictEqual(resolveNamedIds({ productIds: [] }), null);
  assert.strictEqual(resolveNamedIds({ productIds: "p1" }), null);
});

test("named ids de-duplicate, keep order, and are capped", () => {
  assert.deepStrictEqual(resolveNamedIds({ productIds: ["p2", "p1", "p2"] }), ["p2", "p1"]);
  const many = Array.from({ length: PHOTO_MAX_BATCH + 50 }, (_, i) => `p${i}`);
  assert.strictEqual(resolveNamedIds({ productIds: many }).length, PHOTO_MAX_BATCH);
});

// ── The one that would have been a catastrophe ───────────────────────────────
// Firebase's path parser DROPS empty segments, so an empty id turns
// `products/${id}` into a read of the WHOLE /products node and
// `photoProposals/${id}` into a .set() that REPLACES every pending proposal in
// the database.
test("an empty id can never become a path — it is dropped, not repaired", () => {
  assert.strictEqual(resolveNamedIds({ productIds: [""] }), null);
  assert.deepStrictEqual(resolveNamedIds({ productIds: ["", "p1"] }), ["p1"]);
});

test("an id that would escape its own path is dropped", () => {
  for (const bad of ["p1/name", "p1.x", "p1#a", "p1$a", "p1[0]", "../p2", " p1", "p1 "]) {
    assert.strictEqual(isSafeProductId(bad), false, `${bad} must be refused`);
    assert.strictEqual(resolveNamedIds({ productIds: [bad] }), null, `${bad} must not survive`);
  }
  assert.strictEqual(isSafeProductId("p1777895684767"), true);
  assert.strictEqual(isSafeProductId("a-b_C9"), true);
});

test("the catalogue is read whole ONLY for the sweep", () => {
  assert.strictEqual(needsCatalogueScan(null), true);
  assert.strictEqual(needsCatalogueScan(["p1"]), false);
  // and an all-bad id list falls back to the sweep rather than addressing junk
  assert.strictEqual(needsCatalogueScan(resolveNamedIds({ productIds: ["", "a/b"] })), true);
});

test("sourceUrl is honoured for exactly one named product and nowhere else", () => {
  assert.strictEqual(resolveSourceUrl({ sourceUrl: URL_OK }, ["p1"]), URL_OK);
  assert.strictEqual(resolveSourceUrl({ sourceUrl: URL_OK }, ["p1", "p2"]), null);
  assert.strictEqual(resolveSourceUrl({ sourceUrl: URL_OK }, null), null);
  assert.strictEqual(resolveSourceUrl({}, ["p1"]), null);
  assert.strictEqual(resolveSourceUrl({ sourceUrl: 42 }, ["p1"]), null);
  assert.strictEqual(resolveSourceUrl({ sourceUrl: "   " }, ["p1"]), null);
});

test("sourceUrl is pinned to THIS app's bucket, not merely to googleapis.com", () => {
  // fetchImageBuffer's SSRF guard admits any *.googleapis.com host, which is
  // every Firebase project on earth. The browser already refuses these.
  const foreign = "https://firebasestorage.googleapis.com/v0/b/strangers-app.appspot.com/o/x.jpg";
  assert.strictEqual(resolveSourceUrl({ sourceUrl: foreign }, ["p1"]), null);
  assert.strictEqual(resolveSourceUrl({ sourceUrl: "http://example.com/x.jpg" }, ["p1"]), null);
  assert.strictEqual(resolveSourceUrl({ sourceUrl: `evil${APP_STORAGE_PREFIX}x` }, ["p1"]), null);
});

test("a sourceUrl call writes NO proposal node", () => {
  // The node is product-keyed and written with .set() — a whole-node replace.
  // Writing it from the publishing page would destroy an unreviewed AI Studio
  // candidate, and its originalUrl is what approve copies into
  // products/{id}/photoUrlOriginal.
  assert.strictEqual(mayRecordProposal(URL_OK), false);
  assert.strictEqual(mayRecordProposal(null), true);
});

test("named ids keep the caller's order and drop records that do not exist", () => {
  const products = { p1: { photoUrl: "u1" }, p3: { photoUrl: "u3" } };
  assert.deepStrictEqual(pickIds({ namedIds: ["p3", "p2", "p1"], products }), ["p3", "p1"]);
});

test("a product with no hero is still workable when a source photo was named", () => {
  const products = { p1: {} };
  assert.deepStrictEqual(pickIds({ namedIds: ["p1"], products }), []);
  assert.deepStrictEqual(pickIds({ namedIds: ["p1"], products, sourceUrl: URL_OK }), ["p1"]);
});

test("the sweep behaves exactly as it always did", () => {
  const products = {
    pB: { photoUrl: "u", category: "Footwear" },
    pA: { photoUrl: "u", category: "Footwear" },
    pC: { photoUrl: "u", category: "Clothing" },
    pD: { category: "Footwear" },                       // no photo
    pE: { photoUrl: "u", productType: "Footwear" },     // legacy field
  };
  const existing = { pA: { status: "pending" } };

  // sorted, capped, photo required
  assert.deepStrictEqual(pickIds({ namedIds: null, products, data: {}, limit: 2 }), ["pA", "pB"]);
  // already-proposed skipped unless reprocess
  assert.deepStrictEqual(pickIds({ namedIds: null, products, existing, data: {}, limit: 10 }), ["pB", "pC", "pE"]);
  assert.deepStrictEqual(pickIds({ namedIds: null, products, existing, data: { reprocess: true }, limit: 10 }), ["pA", "pB", "pC", "pE"]);
  // category matches the new field OR the legacy productType
  assert.deepStrictEqual(pickIds({ namedIds: null, products, data: { category: "Footwear" }, limit: 10 }), ["pA", "pB", "pE"]);
  // pD never appears anywhere — no photo, nothing to read
  for (const args of [{}, { category: "Footwear" }, { reprocess: true }]) {
    assert.ok(!pickIds({ namedIds: null, products, existing, data: args, limit: 10 }).includes("pD"));
  }
});
