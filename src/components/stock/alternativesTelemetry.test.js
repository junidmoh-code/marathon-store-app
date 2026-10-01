import { describe, it, expect } from "vitest";
import { shownEntry, pickedEntry, ALTERNATIVES_LOG_PATH } from "./alternativesTelemetry";
import { alternativesForSize } from "./alternativesCore";
import { encodeNeighbour } from "../../utils/productNeighbours";

// What RTDB actually stores: an empty array (or an object left empty) is
// DELETED, so a reader must never rely on a `[]` coming back.
const asStored = (v) => {
  if (Array.isArray(v)) return v.length ? v.map(asStored) : undefined;
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) { const c = asStored(x); if (c !== undefined && c !== null) out[k] = c; }
    return Object.keys(out).length ? out : undefined;
  }
  return v;
};

const P = (id, sizes) => ({ id, name: id, retailPrice: 700, photoUrl: "u", sizes });
const run = (products, size) => alternativesForSize({
  neighbours: Object.keys(products).map((pid) => encodeNeighbour(pid, "s")),
  requestedSize: size,
  resolveProduct: (pid) => products[pid] || null,
  sizesOf: (p) => p.sizes,
  availabilityKnown: () => true,
  sizeAvailable: () => true,
  isSellable: () => true,
});

describe("the sheet-open row", () => {
  it("records what the size gate removed — Junid's Air Force, size 8", () => {
    const products = { small: P("small", ["3", "4", "5", "5.5", "6"]), ok: P("ok", ["7", "8"]) };
    const e = shownEntry({ ts: 1, shop: "marathon-pe", surface: "sheet", product: { id: "af" }, size: "8", result: run(products, "8") });
    expect(e).toEqual({
      ts: 1, shop: "marathon-pe", event: "shown", surface: "sheet", productId: "af", size: "8",
      candidates: 2, shown: 1, sizeGateRemoved: 1, shownIds: ["ok"],
    });
  });
  it("an empty sheet survives the store: the zeros stay, the empty id list is gone", () => {
    const products = { small: P("small", ["3", "4"]) };
    const stored = asStored(shownEntry({ ts: 1, surface: "sheet", product: { id: "af" }, size: "8", result: run(products, "8") }));
    expect(stored.shown).toBe(0);
    expect(stored.sizeGateRemoved).toBe(1);
    expect(stored.shownIds).toBeUndefined();
    expect(stored.shownIds || []).toEqual([]);
  });
  it("nothing is written for a sheet that has not answered", () => {
    expect(shownEntry({ ts: 1, surface: "sheet", product: { id: "af" }, size: "8", result: null })).toBe(null);
  });
});

describe("the pick row", () => {
  it("records the chosen shoe and ITS label for the size", () => {
    const e = pickedEntry({ ts: 2, surface: "quickview", product: { id: "af" }, size: "8_5",
                            row: { product: { id: "ok" }, matchedSize: "8.5" } });
    expect(e).toMatchObject({ event: "picked", productId: "af", size: "8_5", pickedId: "ok", pickedSize: "8.5" });
  });
  it("null-safe", () => {
    expect(pickedEntry({ ts: 2, product: { id: "af" }, size: "8", row: null })).toBe(null);
  });
});

it("its own node, never the insights feed", () => {
  expect(ALTERNATIVES_LOG_PATH).toBe("alternatives_log");
});
