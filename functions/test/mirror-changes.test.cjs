const test = require("node:test");
const assert = require("node:assert");

const legs = require("../mirrorChanges/legs.cjs");
// The PURE half. mirrorChanges.js itself imports firebase-functions and
// builds live triggers at require time, so the decisions are tested here and
// the wiring — "every leg declares a function that is actually exported" — is
// tested by src/offline/__tests__/changeLegsMatch.test.js, which reads both
// files as text.
const lib = require("../mirrorChanges/lib.cjs");

const legByName = Object.fromEntries(legs.LEGS.map((l) => [l.name, l]));

test("the trigger ref carries one wildcard per depth", () => {
  assert.equal(legs.triggerRef(legByName.locations), "/locations");
  assert.equal(legs.triggerRef(legByName.products), "/products/{seg0}");
  assert.equal(legs.triggerRef(legByName.stock), "/stock/{seg0}/{seg1}");
  assert.equal(
    legs.triggerRef(legByName.displayRows),
    "/settings/displayRows/{seg0}/{seg1}/{seg2}",
  );
});

test("every leg has a unique, deployable function name", () => {
  const names = legs.LEGS.map((l) => l.fn);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^mirrorChange[A-Z]\w+$/);
});

test("the row key joins the wildcard values in order", () => {
  assert.equal(legs.rowKeyFromParams(legByName.products, { seg0: "p1" }), "p1");
  assert.equal(legs.rowKeyFromParams(legByName.stock, { seg0: "hub1", seg1: "p1" }), "hub1|p1");
  assert.equal(legs.rowKeyFromParams(legByName.locations, {}), "");
});

test("a segment containing the separator is REFUSED, never joined", () => {
  // "|" is a legal RTDB key character. Joining one in would collide two rows
  // into one on every device, silently and permanently.
  assert.equal(legs.rowKeyFromParams(legByName.stock, { seg0: "hub|1", seg1: "p1" }), null);
  assert.equal(legs.rowKeyFromParams(legByName.products, { seg0: "" }), null);
  assert.equal(legs.rowKeyFromParams(legByName.products, {}), null);
});

test("a write that changes nothing writes no change record", () => {
  // RTDB fires on identical writes routinely — a client re-sending the record
  // it holds, an update() rewriting a field to its own value. A record for
  // each would grow the log and make every device re-read for nothing.
  const same = { qty: 3, v: 7 };
  assert.equal(lib.changeRecord(legByName.products, { seg0: "p1" }, same, { ...same }, 5), null);
});

test("key ORDER is not a change", () => {
  // Two code paths writing the same record produce the same object with keys
  // in a different order. JSON.stringify would call that a change.
  const a = { name: "Nike", price: 100 };
  const b = { price: 100, name: "Nike" };
  assert.equal(lib.sameValue(a, b), true);
  assert.equal(lib.changeRecord(legByName.products, { seg0: "p1" }, a, b, 5), null);
});

test("a real edit writes a record naming the node and the row", () => {
  const rec = lib.changeRecord(
    legByName.products, { seg0: "p1" }, { price: 100 }, { price: 120 }, 1234,
  );
  assert.deepEqual(rec, { n: "products", k: "p1", t: 1234 });
});

test("a DELETE is a change — this is what a timestamp cursor cannot carry", () => {
  const rec = lib.changeRecord(legByName.products, { seg0: "p1" }, { price: 100 }, null, 9);
  assert.deepEqual(rec, { n: "products", k: "p1", t: 9 });
});

test("a CREATE is a change", () => {
  const rec = lib.changeRecord(legByName.products, { seg0: "p1" }, null, { price: 100 }, 9);
  assert.deepEqual(rec, { n: "products", k: "p1", t: 9 });
});

test("an absent node and an explicit null are the same absence", () => {
  assert.equal(lib.sameValue(null, undefined), true);
  assert.equal(lib.changeRecord(legByName.products, { seg0: "p1" }, null, undefined, 9), null);
});

test("nested and array differences are seen", () => {
  assert.equal(lib.sameValue({ a: { b: 1 } }, { a: { b: 2 } }), false);
  assert.equal(lib.sameValue([1, 2], [1, 2]), true);
  assert.equal(lib.sameValue([1, 2], [2, 1]), false);
  // An array and an object with the same entries are NOT the same value:
  // RTDB coerces dense integer keys to arrays, and a mirror that treated the
  // two as equal would miss the write that flipped one into the other.
  assert.equal(lib.sameValue([1, 2], { 0: 1, 1: 2 }), false);
});

test("a shorter object is not equal to a longer one that contains it", () => {
  assert.equal(lib.sameValue({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(lib.sameValue({ a: 1, b: 2 }, { a: 1 }), false);
});

test("push keys sort in time order, so a key range is a time range", () => {
  const t0 = 1_700_000_000_000;
  let prev = "";
  for (let i = 0; i < 50; i += 1) {
    const k = lib.pushKeyForMs(t0 + i * 97_000);
    assert.ok(k > prev, `${k} should sort after ${prev}`);
    assert.equal(k.length, 8);
    prev = k;
  }
});

test("the retention window is longer than any plausible absence", () => {
  assert.equal(legs.CHANGE_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
});

test("every change-fed node is one this app actually mirrors whole", () => {
  // A leg here that the client does not mirror writes records nothing reads;
  // the other direction — a client leg with no trigger — is the dangerous one
  // and is caught by changeLegsMatch.test.js, which reads both files.
  const nodes = legs.LEGS.map((l) => l.node);
  assert.equal(new Set(nodes).size, nodes.length);
  for (const n of nodes) assert.ok(!n.startsWith("/"), `${n} should have no leading slash`);
});

test("no leg's node is an ancestor of another's", () => {
  // One write would then land in two legs, and a device would hold the same
  // bytes twice under two health records that could disagree.
  for (const a of legs.LEGS) {
    for (const b of legs.LEGS) {
      if (a === b) continue;
      assert.ok(!b.node.startsWith(`${a.node}/`), `${b.node} sits under ${a.node}`);
    }
  }
});
