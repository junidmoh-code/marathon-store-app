import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { orderSizesForDisplay } from "./sizeDisplayOrder";

describe("orderSizesForDisplay — the size picker's order (2026-10-03)", () => {
  it("sorts a numeric run ascending (Diesel slide black was stored 10,6,7,8,9,11)", () => {
    expect(orderSizesForDisplay(["10", "6", "7", "8", "9", "11"])).toEqual(["6", "7", "8", "9", "10", "11"]);
  });
  it("sorts half sizes numerically, not as strings", () => {
    expect(orderSizesForDisplay(["10", "9.5", "11", "9"])).toEqual(["9", "9.5", "10", "11"]);
  });
  it("leaves letter, mixed and kids runs in stored order", () => {
    expect(orderSizesForDisplay(["S", "M", "L", "XL"])).toEqual(["S", "M", "L", "XL"]);
    expect(orderSizesForDisplay(["C10", "C11", "1", "2"])).toEqual(["C10", "C11", "1", "2"]);
  });
  it("never mutates the stored array, and tolerates a missing one", () => {
    const stored = ["10", "6"];
    orderSizesForDisplay(stored);
    expect(stored).toEqual(["10", "6"]);
    expect(orderSizesForDisplay(undefined)).toEqual([]);
  });
  // Both Place Order size surfaces — the desktop grid/quick-view (sizesOf) and
  // the phone sheet (selectedSizes) — must go through it, or the two disagree.
  it("both order-screen size lists use it", () => {
    const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
    expect(app).toMatch(/const sizesOf = p => \{ const s = orderSizesForDisplay\(/);
    expect(app).toMatch(/const real = orderSizesForDisplay\(\(selected\?\.sizes/);
  });
});
