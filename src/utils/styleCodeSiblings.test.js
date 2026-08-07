// ─── STYLE CODE SIBLINGS — client/server twin parity + the owners contract ───
// The client twin (src/utils/styleCodeSiblings.js) and the server module
// (functions/lib/style-code-siblings.cjs) must agree on every case: the count
// picker (client) and the duplicate partition (server) read the SAME claim
// node, and a disagreement would make one side see a sibling where the other
// sees a collision — the exact split-brain this feature exists to end.

import { describe, it, expect } from "vitest";
import { createRequire } from "module";
import { claimOwnerIds, isSiblingPair, allRegisteredSiblings } from "./styleCodeSiblings.js";

const require = createRequire(import.meta.url);
const server = require("../../functions/lib/style-code-siblings.cjs");

const CASES = [
  null,
  undefined,
  {},
  "not-an-object",
  { productId: "p1", claimedAt: 5 },
  { productId: "p1", claimedAt: 5, claimedBy: "u1" },
  { productId: "p1", siblings: {} },
  { productId: "p1", siblings: { p2: { addedAt: 1 } } },
  { productId: "p1", siblings: { p3: { addedAt: 1 }, p2: { addedAt: 2 } } },
  { productId: "p1", siblings: { p1: { addedAt: 1 } } },            // primary duplicated
  { siblings: { p2: { addedAt: 1 } } },                             // no primary (malformed)
  { productId: "", siblings: { p2: { addedAt: 1 } } },
  { productId: "p1", siblings: ["p2"] },                            // array — RTDB never stores this, refuse it
];

describe("client twin ⇔ server module parity", () => {
  it("claimOwnerIds agrees on every case", () => {
    for (const c of CASES) {
      expect(claimOwnerIds(c)).toEqual(server.claimOwnerIds(c));
    }
  });
  it("isSiblingPair agrees on every case", () => {
    const pairs = [["p1", "p2"], ["p1", "p9"], ["p2", "p3"], ["p1", "p1"]];
    for (const c of CASES) {
      for (const [a, b] of pairs) {
        expect(isSiblingPair(c, a, b)).toBe(server.isSiblingPair(c, a, b));
      }
    }
  });
});

describe("the owners contract", () => {
  it("a LEGACY claim reads as exactly one owner — existing claims survive unmigrated", () => {
    expect(claimOwnerIds({ productId: "p1", claimedAt: 5, claimedBy: "u1" })).toEqual(["p1"]);
  });
  it("primary first, then siblings sorted, deduped", () => {
    expect(claimOwnerIds({ productId: "p1", siblings: { p3: {}, p2: {}, p1: {} } })).toEqual(["p1", "p2", "p3"]);
  });
  it("allRegisteredSiblings: true only when the index vouches for EVERY id", () => {
    const node = { productId: "p1", siblings: { p2: { addedAt: 1 } } };
    expect(allRegisteredSiblings(node, ["p1", "p2"])).toBe(true);
    expect(allRegisteredSiblings(node, ["p1", "p2", "p9"])).toBe(false);
    expect(allRegisteredSiblings(node, ["p1"])).toBe(false);   // one product is not a pair
    expect(allRegisteredSiblings(null, ["p1", "p2"])).toBe(false);
  });
});
