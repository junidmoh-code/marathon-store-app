// Pins the TV orders key range: every customer order key (daily numeric
// "001"…"999") is inside it, every clothing-refill cart key ("R###-…") and
// any legacy non-numeric key is outside. This is the contract that makes the
// TV's server-side scoped subscription behaviour-identical to the old
// full-node listen + client-side "Shop Refill" filter.
import { test, expect } from "vitest";
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
