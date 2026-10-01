// ─── THE HOLE IN LEFTOVERS ────────────────────────────────────────────────────
// BUG 2 (owner, 2026-08-31): an UNREGISTERED product could be in no list at all.
//
//   buildLeftovers      requires stock AT THIS HUB   (hubStock + hubQty > 0)
//   buildFinishedLines  requires zero EVERYWHERE     (cells exist, net <= 0)
//
// Two shapes fell between them, and both are common live (census 2026-08-31):
//   • stock held ONLY outside hub1/hub2 — 60 products, mostly the Pine soccer
//     boots (one holds 24 units at marathon-pine);
//   • no stock cells anywhere at all — 114 products.
// 174 products, none registered, none visible anywhere.
//
// buildUnregisteredElsewhere is the third section. These tests pin that the
// three lists PARTITION the unregistered universe: every unregistered footwear
// product lands in exactly one of them, and none lands in two.

import { describe, it, expect } from "vitest";
import { buildLeftovers, buildFinishedLines, buildUnregisteredElsewhere } from "./hubCleanupCore.js";

const shoe = (id, name, over = {}) => ({ id, name, categoryKey: "sneakers", productType: "sneaker", sizes: ["9"], ...over });
const cell = (qty) => ({ qty, v: 0 });

const PRODUCTS = [
  shoe("pHub", "Held at the hub"),                        // → leftovers
  shoe("pEmpty", "Sold to zero everywhere"),              // → finished lines
  shoe("pPine", "Pine soccer boot"),                      // → the hole (stock elsewhere)
  shoe("pGhost", "No cells anywhere"),                    // → the hole (no cells)
  shoe("pCoded", "Registered", { styleCodeNormalised: "BQ6817302" }),
  shoe("pDead", "Retired", { deactivated: { at: 1, by: "u" } }),
];
const ALL_STOCK = {
  hub1: { pHub: { 9: cell(4) }, pEmpty: { 9: cell(0) }, pCoded: { 9: cell(2) }, pDead: { 9: cell(1) } },
  "marathon-pine": { pPine: { 9: cell(24) } },
  hub3: { pPine: { 9: cell(-1) } },
};
const args = { hub: "hub1", products: PRODUCTS, hubStock: ALL_STOCK.hub1, registered: {}, allStock: ALL_STOCK, identityMap: null };

describe("the third section closes both doors", () => {
  it("lists the product whose stock is ONLY outside the cleanup hubs", () => {
    const rows = buildUnregisteredElsewhere(args);
    const pine = rows.find((r) => r.product.id === "pPine");
    expect(pine).toBeTruthy();
    expect(pine.net).toBe(23);                                  // 24 at pine, −1 at hub3
    expect(pine.cellLocs.sort()).toEqual(["hub3", "marathon-pine"]);
    // locationsHolding lists every NON-ZERO cell — the −1 at hub3 is a real
    // signal (a negative cell is stock the ledger says was oversold), so it is
    // shown too. Only genuinely empty cells are omitted.
    expect(pine.locations.map((l) => l.loc)).toEqual(["marathon-pine", "hub3"]);
  });

  it("lists the product with NO cells anywhere — invisible before this", () => {
    expect(buildUnregisteredElsewhere(args).map((r) => r.product.id)).toContain("pGhost");
  });

  it("never repeats a card the other two lists already show", () => {
    const rows = buildUnregisteredElsewhere(args).map((r) => r.product.id);
    expect(rows).not.toContain("pHub");     // a leftover at this hub
    expect(rows).not.toContain("pEmpty");   // a finished line
  });

  it("respects registration and deactivation exactly as its siblings do", () => {
    const rows = buildUnregisteredElsewhere(args).map((r) => r.product.id);
    expect(rows).not.toContain("pCoded");
    expect(rows).not.toContain("pDead");
  });

  it("a register-pass record is registration here too", () => {
    const rows = buildUnregisteredElsewhere({ ...args, registered: { r1: { productId: "pPine" } } });
    expect(rows.map((r) => r.product.id)).not.toContain("pPine");
  });

  it("most units first — the biggest invisible pile at the top", () => {
    const rows = buildUnregisteredElsewhere(args);
    expect(rows[0].product.id).toBe("pPine");
  });

  it("fails soft: no network view, no claims", () => {
    expect(buildUnregisteredElsewhere({ ...args, allStock: null })).toEqual([]);
  });

  it("THE PARTITION: every unregistered footwear product is in exactly one list", () => {
    const l = buildLeftovers(args).map((r) => r.product.id);
    const f = buildFinishedLines(args).map((r) => r.product.id);
    const u = buildUnregisteredElsewhere(args).map((r) => r.product.id);
    expect([...l, ...f, ...u].sort()).toEqual(["pEmpty", "pGhost", "pHub", "pPine"]);
    expect(new Set([...l, ...f, ...u]).size).toBe(4);   // no product in two lists
  });
});
