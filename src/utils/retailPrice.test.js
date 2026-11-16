// docs/ASSISTANT-NO-PRICE-SET.md — the one reader every assistant card uses.
import { describe, it, expect } from "vitest";
import { retailPriceOf } from "./retailPrice";

// Exactly what Missing Prices wrote for SKU 6080 on 13 Nov 2026
// (price_history/pb_1794602504745_5ocwzk): numbers in stockPrice/retailPrice.
const MISSING_PRICES_6080 = { id: "p1793455269367", sku: "6080", name: "Manchester city soccer jersey black", productType: "clothing", stockPrice: 250, retailPrice: 300 };
// The R200 jersey that always showed its price.
const OLD_1882 = { id: "p1782464018261", sku: "1882", name: "Puma Manchester City Jersey Pink Purple", stockPrice: 200, retailPrice: 200 };

describe("retailPriceOf", () => {
  it("a Missing Prices-priced product reads its retail price, not its stock price", () => {
    expect(retailPriceOf(MISSING_PRICES_6080)).toBe(300);
  });
  it("an older priced product reads the same way", () => {
    expect(retailPriceOf(OLD_1882)).toBe(200);
  });
  it("a legacy-priced product (only `price`) is not 'No price set'", () => {
    expect(retailPriceOf({ id: "p1", name: "Legacy", price: 450 })).toBe(450);
    expect(retailPriceOf({ id: "p1", name: "Legacy", price: "450" })).toBe(450);
  });
  it("the canonical field wins over a legacy one", () => {
    expect(retailPriceOf({ retailPrice: 300, price: 999 })).toBe(300);
  });
  it("a numeric string in retailPrice reads as the price", () => {
    expect(retailPriceOf({ retailPrice: "300" })).toBe(300);
  });
  it("no price, zero, negative, NaN, junk and a stock price alone are all 'not set'", () => {
    for (const p of [{}, { retailPrice: 0 }, { retailPrice: -5 }, { retailPrice: NaN }, { retailPrice: "R300" },
      { retailPrice: null }, { stockPrice: 250 }, null, undefined]) {
      expect(retailPriceOf(p)).toBeNull();
    }
  });
});
