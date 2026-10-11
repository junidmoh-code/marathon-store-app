// The app's copy of the online pool must give the push's answer, always.
import { describe, it, expect } from "vitest";
import { onlineUnits, ONLINE_EXCLUDED_LOCATIONS } from "./onlinePool.js";
import { networkTotals, ONLINE_EXCLUDED_LOCATIONS as PUSH_EXCLUDED } from "../../scripts/shopify/inventory.mjs";

const pushTotal = (byLoc, sizes) => {
  const tree = Object.fromEntries(Object.entries(byLoc).map(([loc, cells]) => [loc, { p: cells }]));
  return Object.values(networkTotals(tree, "p", sizes)).reduce((a, b) => a + b, 0);
};

describe("the Total Stock card's online figure is the Shopify push's number", () => {
  it("excludes exactly the same locations", () => {
    expect([...ONLINE_EXCLUDED_LOCATIONS].sort()).toEqual([...PUSH_EXCLUDED].sort());
  });

  const cases = [
    ["a plain pool", { central: { 6: { qty: 2 } }, hub1: { 7: { qty: 1 } }, trophy: { 6: { qty: 1 } } }, ["6", "7"]],
    ["in transit, Pine, Hub 3 and Concrete are not sold online", { in_transit: { 6: { qty: 5 } }, "marathon-pine": { 6: { qty: 3 } }, hub3: { 6: { qty: 2 } }, concrete: { 6: { qty: 1 } }, hub2: { 6: { qty: 1 } } }, ["6"]],
    ["a stray size cell does not ship", { central: { 6: { qty: 2 }, 13: { qty: 9 } } }, ["6"]],
    ["negatives count zero", { central: { 6: { qty: -4 } }, hub1: { 6: { qty: 1 } } }, ["6"]],
    ["half sizes and one-size", { hub1: { "5_5": { qty: 2 }, _: { qty: 1 } } }, ["5.5", "Free Size"]],
    ["array-shaped cell maps", { hub1: [null, null, null, null, null, null, { qty: 3 }] }, ["6"]],
    ["bare-number legacy cells", { hub1: { 6: 2 } }, ["6"]],
    ["no size list sells nothing", { hub1: { 6: { qty: 2 } } }, []],
  ];
  for (const [name, byLoc, sizes] of cases) {
    it(name, () => expect(onlineUnits(byLoc, sizes)).toBe(pushTotal(byLoc, sizes)));
  }
});
