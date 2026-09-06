// Pins the TV orders key range: every customer order key (daily numeric
// "001"…"999") is inside it, every clothing-refill cart key ("R###-…") and
// any legacy non-numeric key is outside. This is the contract that makes the
// TV's server-side scoped subscription behaviour-identical to the old
// full-node listen + client-side "Shop Refill" filter.
import { test, expect, describe, it } from "vitest";
import { TV_ORDER_KEY_START, TV_ORDER_KEY_END, keyInTvOrdersRange } from "./tvOrdersRange.js";

test("range bounds bracket all numeric keys, including multi-digit past a bare 9", () => {
  expect(TV_ORDER_KEY_START).toBe("0");
  expect(TV_ORDER_KEY_END).toBe("9"); // high sentinel keeps "901"…"999" inside
  for (const k of ["001", "059", "099", "1", "42", "599", "9", "901", "999"]) {
    expect(keyInTvOrdersRange(k), `${k} should reach the TV`).toBe(true);
  }
});

test("refill cart keys and legacy keys are excluded", () => {
  for (const k of ["R001-1", "R001-1015", "R123-9", "items", "~C123", "-Nabc123"]) {
    expect(keyInTvOrdersRange(k), `${k} must NOT reach the TV`).toBe(false);
  }
});

// ─── THE SHAPES THAT ACTUALLY LIVE IN /orders (measured 2026-09-06) ──────────
// Added after a reviewer questioned a COPY of this range in a census script.
// The copy had hand-typed `endAt("9")` and dropped the \uf8ff sentinel, which
// on live data returns EIGHT of the 565 customer orders. The real constant was
// then re-measured against live /orders and is correct: 565/565 numeric rows,
// 0 refill keys leaked.
//
// The lesson is the one this file can pin: the bound is not "9", it only looks
// like "9" in a terminal, and the sentinel is invisible in `sed`, `grep` and
// `JSON.stringify` alike. Anything that reproduces this range must IMPORT the
// constant rather than retype what it appears to say.
//
// WHAT THIS FILE CANNOT PROVE. keyInTvOrdersRange is a LEXICOGRAPHIC mirror;
// RTDB additionally sorts integer-like keys ahead of string keys. A pass here
// does not mean "the query is correct" — that was measured live, not asserted.
describe("every key shape the live node holds", () => {
  const CUSTOMER = ["001", "008", "009", "010", "099", "100", "101", "500", "565", "999"];
  const REFILL = ["R001-abc", "R100-xyz", "R999-zzz"];

  it("keeps every customer order, padded or unpadded", () => {
    // The live node holds BOTH shapes — 466 unpadded like "100", 99 padded
    // like "099" — and the original tests only ever asked about "001".
    for (const k of CUSTOMER) expect(keyInTvOrdersRange(k), k).toBe(true);
  });
  it("still excludes every refill cart — the payload this range exists to drop", () => {
    for (const k of REFILL) expect(keyInTvOrdersRange(k), k).toBe(false);
  });
  it("the end bound carries the sentinel, which is invisible when printed", () => {
    expect(TV_ORDER_KEY_END).toBe("9\uf8ff");
    expect(TV_ORDER_KEY_END).not.toBe("9");            // what it looks like
    expect(TV_ORDER_KEY_END.length).toBe(2);
  });
  it("and the sentinel is what admits a key ABOVE \"9\" that still starts with 9", () => {
    expect("999" <= "9").toBe(false);                  // the bound it is not
    expect("999" <= TV_ORDER_KEY_END).toBe(true);      // the bound it is
  });
});
