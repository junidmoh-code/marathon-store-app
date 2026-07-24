import { test } from "vitest";
import assert from "node:assert";
import { needsCost, needsRetail, needsAny, typeOf, createdAt, updatedAt, buildUpdates, validatePrices } from "./missingPrices";

const p = (over = {}) => ({ id: "p1234567890", name: "Test", ...over });

test("needsCost: null, empty, 0 are missing", () => {
  assert.equal(needsCost(p({ stockPrice: null })), true);
  assert.equal(needsCost(p({ stockPrice: "" })), true);
  assert.equal(needsCost(p({ stockPrice: 0 })), true);
  assert.equal(needsCost(p({ stockPrice: 100 })), false);
});

test("needsRetail: null, empty, 0 are missing", () => {
  assert.equal(needsRetail(p({ retailPrice: null })), true);
  assert.equal(needsRetail(p({ retailPrice: "" })), true);
  assert.equal(needsRetail(p({ retailPrice: 0 })), true);
  assert.equal(needsRetail(p({ retailPrice: 100 })), false);
});

test("needsAny: either missing counts", () => {
  assert.equal(needsAny(p({ stockPrice: null, retailPrice: 100 })), true);
  assert.equal(needsAny(p({ stockPrice: 100, retailPrice: null })), true);
  assert.equal(needsAny(p({ stockPrice: 100, retailPrice: 100 })), false);
});

test("typeOf: category drives the bucket, not the unreliable productType", () => {
  // The real `category` field is the signal — one of the four top-levels.
  assert.equal(typeOf(p({ category: "Footwear" })), "Footwear");
  assert.equal(typeOf(p({ category: "Clothing" })), "Clothing");
  assert.equal(typeOf(p({ category: "Accessories" })), "Accessories");
  assert.equal(typeOf(p({ category: "Perfume" })), "Perfume");
  // The two live mis-bucketings this fixes: 329 accessories carry productType
  // "clothing" and perfumes carry productType "sneaker" — category must win so
  // they stop hiding under Clothing / Shoes.
  assert.equal(typeOf(p({ category: "Accessories", productType: "clothing" })), "Accessories");
  assert.equal(typeOf(p({ category: "Perfume", productType: "sneaker" })), "Perfume");
  // No / unknown category → the Uncategorized catch-all (never silently dropped).
  assert.equal(typeOf(p({ productType: "clothing" })), "Uncategorized");
  assert.equal(typeOf(p({ category: "Other" })), "Uncategorized");
  assert.equal(typeOf(p({})), "Uncategorized");
});

test("createdAt: parses p-timestamp id", () => {
  assert.equal(createdAt(p({ id: "p1234567890" })), 1234567890);
  assert.equal(createdAt(p({ id: "invalid" })), 0);
});

test("updatedAt: photoUpdatedAt wins, falls back to createdAt", () => {
  assert.equal(updatedAt(p({ id: "p1234567890", photoUpdatedAt: 999 })), 999);
  assert.equal(updatedAt(p({ id: "p1234567890" })), 1234567890);
});

test("buildUpdates: missing retail only → only retailPrice written", () => {
  const updates = buildUpdates(p({ stockPrice: 100, retailPrice: null }), "100", "150");
  assert.deepEqual(updates, { retailPrice: 150 });
});

test("buildUpdates: missing cost only → only stockPrice written", () => {
  const updates = buildUpdates(p({ stockPrice: null, retailPrice: 150 }), "100", "150");
  assert.deepEqual(updates, { stockPrice: 100 });
});

test("buildUpdates: missing both → both written", () => {
  const updates = buildUpdates(p({ stockPrice: null, retailPrice: null }), "100", "150");
  assert.deepEqual(updates, { stockPrice: 100, retailPrice: 150 });
});

test("validatePrices: missing retail only → requires retail", () => {
  const v = validatePrices(p({ stockPrice: 100, retailPrice: null }), "100", "150");
  assert.equal(v.ok, true);
  const bad = validatePrices(p({ stockPrice: 100, retailPrice: null }), "100", "");
  assert.equal(bad.ok, false);
});

test("validatePrices: missing cost only → requires cost", () => {
  const v = validatePrices(p({ stockPrice: null, retailPrice: 150 }), "100", "150");
  assert.equal(v.ok, true);
  const bad = validatePrices(p({ stockPrice: null, retailPrice: 150 }), "", "150");
  assert.equal(bad.ok, false);
});

test("validatePrices: missing both → requires both", () => {
  const v = validatePrices(p({ stockPrice: null, retailPrice: null }), "100", "150");
  assert.equal(v.ok, true);
  const bad1 = validatePrices(p({ stockPrice: null, retailPrice: null }), "", "150");
  assert.equal(bad1.ok, false);
  const bad2 = validatePrices(p({ stockPrice: null, retailPrice: null }), "100", "");
  assert.equal(bad2.ok, false);
});

test("validatePrices: retail < cost requires confirmation", () => {
  const v = validatePrices(p({ stockPrice: null, retailPrice: null }), "150", "100");
  assert.equal(v.ok, false);
  assert.equal(v.needsConfirm, true);
});

test("validatePrices: retail >= cost passes", () => {
  const v = validatePrices(p({ stockPrice: null, retailPrice: null }), "100", "150");
  assert.equal(v.ok, true);
});

test("validatePrices: skips margin check when one draft is empty (precondition)", () => {
  // This documents the precondition the HIGH bug exploited: when one draft is
  // empty, the retail<cost check is skipped. The Save & Next flow must prefill
  // drafts via openEdit so the check runs.
  const v = validatePrices(p({ stockPrice: 100, retailPrice: null }), "", "50");
  assert.equal(v.ok, true, "empty cost draft skips the margin check");
  const v2 = validatePrices(p({ stockPrice: null, retailPrice: 150 }), "200", "");
  assert.equal(v2.ok, true, "empty retail draft skips the margin check");
});

test("buildUpdates: invalid input silently produces empty/partial updates", () => {
  assert.deepEqual(buildUpdates(p({ stockPrice: null, retailPrice: null }), "0", "-5"), {});
  assert.deepEqual(buildUpdates(p({ stockPrice: null, retailPrice: null }), "abc", "xyz"), {});
  assert.deepEqual(buildUpdates(p({ stockPrice: null, retailPrice: null }), "", ""), {});
});

test("buildUpdates: whitespace-only drafts treated as empty", () => {
  assert.deepEqual(buildUpdates(p({ stockPrice: null, retailPrice: null }), "   ", "  "), {});
});

test("needsCost/needsRetail: negative, NaN, and string prices count as present", () => {
  assert.equal(needsCost(p({ stockPrice: -5 })), false, "negative counts as present (tight predicate would flag it)");
  assert.equal(needsCost(p({ stockPrice: NaN })), false, "NaN counts as present");
  assert.equal(needsCost(p({ stockPrice: "0" })), false, "string '0' counts as present");
  assert.equal(needsRetail(p({ retailPrice: -5 })), false);
  assert.equal(needsRetail(p({ retailPrice: NaN })), false);
});
