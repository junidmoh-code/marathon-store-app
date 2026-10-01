// Regression pin for PR #600: the clothing order lane's Hub 2 availability
// lookup runs against the DECODED map useStockCells returns. The catalogue
// size must resolve to the decoded cell key — one-size "Free Size" → "_",
// half size "5.5" → "5.5" (stored "5_5", decoded back), S/M/L/XL → themselves.
// The raw lookup (pre-#600) missed "Free Size"; the encoded lookup
// (stockSizeKey) would miss "5.5". decodedCellKey is the only key that hits all.
import { describe, it, expect } from "vitest";
import { decodedCellKey, decodeSizeKey, stockSizeKey } from "./sizeKey";

// Mirror of useStock.js decodeByProduct: stored keys → decoded keys.
const decodedMap = (stored) => Object.fromEntries(Object.entries(stored).map(([k, v]) => [decodeSizeKey(k), v]));

describe("hubQty cell key against the decoded hub map", () => {
  const hub2 = decodedMap({ "_": { qty: 2 }, "5_5": { qty: 3 }, "M": { qty: 4 } });
  const lookup = (size) => hub2[decodedCellKey(size)]?.qty;

  it("one-size 'Free Size' chip reads the '_' cell (the sunglass case)", () => {
    expect(lookup("Free Size")).toBe(2);
    expect(hub2["Free Size"]).toBeUndefined();          // the pre-fix raw lookup
  });
  it("half size reads its decoded cell — stockSizeKey would miss it", () => {
    expect(lookup("5.5")).toBe(3);
    expect(hub2[stockSizeKey("5.5")]).toBeUndefined();   // the encoded key misses
  });
  it("ordinary clothing size is unchanged", () => {
    expect(lookup("M")).toBe(4);
  });
});
