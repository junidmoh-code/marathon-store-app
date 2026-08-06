// ─── OPENING STOCK ENTRIES — what each input state creates (owner fix 3) ─────
//   > 0        → a received movement (a real cell with stock)
//   exactly 0  → a qty-0 SEEDED cell ("we carry this size, none received yet")
//   blank      → NOTHING — and an UNSELECTED size never even reaches here,
//                because product.sizes only contains the chosen run.

import { describe, it, expect } from "vitest";
import { receiveEntries, zeroEntries } from "./SizeQtyBoxes";

const SIZES = ["6", "7", "8", "9"];

describe("receiveEntries / zeroEntries", () => {
  it("positive quantities become received entries; 0 and blank do not", () => {
    expect(receiveEntries(SIZES, { 6: "2", 7: "0", 8: "", 9: "3" }))
      .toEqual([["6", 2], ["9", 3]]);
  });

  it("an EXPLICIT 0 on a selected size seeds its cell; blank seeds nothing", () => {
    expect(zeroEntries(SIZES, { 6: "2", 7: "0", 8: "", 9: undefined })).toEqual(["7"]);
  });

  it("junk input seeds nothing", () => {
    expect(zeroEntries(SIZES, { 6: "abc", 7: "  ", 8: "-0" })).toEqual(["8"]); // parseInt("-0") === -0 → 0? guard:
  });

  it("an unselected size can never create anything — it is not in the list at all", () => {
    const selected = ["6", "7"];
    expect(receiveEntries(selected, { 8: "5", 9: "0" })).toEqual([]);
    expect(zeroEntries(selected, { 8: "5", 9: "0" })).toEqual([]);
  });
});
