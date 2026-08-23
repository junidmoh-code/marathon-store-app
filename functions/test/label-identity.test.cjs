// ─── label-identity tests — every route into "this product is registered" ────
// Behavioural: what does the map SAY about a product, given what the two
// admin-only stores hold. Each case is a route the live data actually contains.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { buildIdentityMap } = require("../lib/label-identity.cjs");

test("a style_code_index claim makes its product answer to that code", () => {
  const map = buildIdentityMap(null, { BQ6817302: { productId: "p1", claimedAt: 1 } });
  assert.deepStrictEqual(map.p1.c, ["BQ6817302"]);
});

test("a SIBLING of a claim answers to the code too — a colourway sibling is registered", () => {
  const map = buildIdentityMap(null, { HF5509002: { productId: "p1", siblings: { p2: { at: 5 } } } });
  assert.deepStrictEqual(map.p2.c, ["HF5509002"]);
});

test("a code alias makes its product answer to that code", () => {
  const map = buildIdentityMap({ a1: { productId: "p3", c: { "190935505": true, "74075035": true } } }, null);
  assert.deepStrictEqual(map.p3.c, ["190935505", "74075035"]);
});

test("a wording alias registers a product that owns no code at all", () => {
  const map = buildIdentityMap({ a1: { productId: "p4", t: { NIKE: true, AIR: true, FORCE: true } } }, null);
  assert.deepStrictEqual(map.p4.c, []);
  assert.deepStrictEqual(map.p4.a, [["AIR", "FORCE", "NIKE"]]);
});

test("the same reading filed twice appears once — the screen is a list, not a log", () => {
  const map = buildIdentityMap({
    a1: { productId: "p5", t: { NIKE: true, AIR: true } },
    a2: { productId: "p5", t: { AIR: true, NIKE: true } },
  }, null);
  assert.strictEqual(map.p5.a.length, 1);
});

test("a product with nothing filed anywhere is absent from the map", () => {
  const map = buildIdentityMap({ a1: { productId: "p1", t: { A: true, B: true } } },
                               { X: { productId: "p2" } });
  assert.ok(!("p9" in map));
  assert.deepStrictEqual(Object.keys(map).sort(), ["p1", "p2"]);
});

test("codes from different routes pool onto ONE product, deduped and sorted", () => {
  const map = buildIdentityMap(
    { a1: { productId: "p1", c: { ZZZ111: true, AAA111: true } } },
    { AAA111: { productId: "p1" }, MMM222: { productId: "p9", siblings: { p1: true } } },
  );
  assert.deepStrictEqual(map.p1.c, ["AAA111", "MMM222", "ZZZ111"]);
});

test("malformed records are ignored rather than crashing the fold", () => {
  const map = buildIdentityMap(
    { a1: null, a2: { productId: null, c: { X: true } }, a3: "junk", a4: { productId: "p1", t: "junk" } },
    { K1: null, K2: "junk", K3: { productId: "p2", siblings: "junk" } },
  );
  assert.deepStrictEqual(Object.keys(map).sort(), ["p2"]);
});

test("a falsy entry in a code or sibling map does not register anything", () => {
  const map = buildIdentityMap(
    { a1: { productId: "p1", c: { GONE: false } } },
    { K: { productId: "p2", siblings: { p3: false } } },
  );
  assert.ok(!map.p1, "a retracted code alias is not an identity");
  assert.ok(!map.p3, "a retracted sibling is not an identity");
});
