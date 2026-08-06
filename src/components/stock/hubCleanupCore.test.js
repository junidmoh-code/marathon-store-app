// ─── HUB STOCK CLEANUP — CORE DECISIONS ──────────────────────────────────────
// Scan resolution, the Leftovers population, and the hub scope. These are the
// behaviours the operator sees; the store tests cover what lands in the data.

import { describe, it, expect } from "vitest";
import {
  CLEANUP_HUBS, isCleanupHub, registerMovementId, extraUnitMovementId,
  resolveCleanupScan, openDuplicateFor, buildLeftovers, locationsHolding,
  registrationProgress, realSizes,
  registerPanelFor, styleStepSatisfied, chooseFromLabelRead, styleCodeOwners,
  countPanelFor, resolveStyleNumber,
} from "./hubCleanupCore";

const P = (id, over = {}) => ({ id, name: `Product ${id}`, category: "Footwear", sizes: ["6", "7"], ...over });

describe("scope — Hub 1 and Hub 2 only, Pine never", () => {
  it("the hub list is exactly hub1 and hub2", () => {
    expect(CLEANUP_HUBS).toEqual(["hub1", "hub2"]);
  });
  it("every Pine-flavoured id is out", () => {
    for (const id of ["hub3", "marathon-pine", "pine", "marathon-pe", "trophy", "central"]) {
      expect(isCleanupHub(id)).toBe(false);
    }
  });
});

describe("deterministic movement ids — the idempotency keys", () => {
  it("the same slot always builds the same id, and it is RTDB-key safe", () => {
    const id = registerMovementId("hub2", "p100", "5_5");
    expect(id).toBe(registerMovementId("hub2", "p100", "5_5"));
    expect(id).not.toMatch(/[.#$/\[\]\s]/);
  });
  it("extra units key off the prior quantity, so racing devices collide safely", () => {
    expect(extraUnitMovementId("hub2", "p100", "6", 1)).toBe(extraUnitMovementId("hub2", "p100", "6", 1));
    expect(extraUnitMovementId("hub2", "p100", "6", 1)).not.toBe(extraUnitMovementId("hub2", "p100", "6", 2));
  });
});

describe("scan resolution", () => {
  const products = [
    P("p1", { styleCodeNormalised: "CT8527016" }),
    P("p2"),
    P("p3", { styleCodeNormalised: "DD1391100" }),
  ];

  it("a barcode row resolves to its product, carrying the per-size size", () => {
    const out = resolveCleanupScan("00000601", { products, barcodeRow: { productId: "p2", size: "7" } });
    expect(out.kind).toBe("product");
    expect(out.product.id).toBe("p2");
    expect(out.size).toBe("7");
  });

  it("a barcode row pointing at a merged-away product follows the pointer to the survivor", () => {
    const merged = [P("pOld", { mergedInto: "p2" }), ...products];
    const out = resolveCleanupScan("00000601", { products: merged, barcodeRow: { productId: "pOld", size: "6" } });
    expect(out.kind).toBe("product");
    expect(out.product.id).toBe("p2");
  });

  it("a style code resolves through styleCodeNormalised, size unknown", () => {
    const out = resolveCleanupScan("CT8527-016", { products });
    expect(out.kind).toBe("product");
    expect(out.product.id).toBe("p1");
    expect(out.size).toBe(null);
  });

  it("a code two live products claim is a DUPLICATE, never a guess", () => {
    const twins = [...products, P("p9", { styleCodeNormalised: "CT8527016" })];
    const out = resolveCleanupScan("CT8527-016", { products: twins });
    expect(out.kind).toBe("duplicate");
    expect(out.products.map((p) => p.id).sort()).toEqual(["p1", "p9"]);
  });

  it("an unknown code is UNRESOLVED — a calm signal, not an error", () => {
    const out = resolveCleanupScan("6009999999", { products });
    expect(out.kind).toBe("unresolved");
    expect(out.code).toBe("6009999999");
  });

  it("a merged-away product never resolves as itself from a style code", () => {
    const withMerged = [P("pOld", { styleCodeNormalised: "ZZ111222", mergedInto: "p2" }), ...products];
    const out = resolveCleanupScan("ZZ111-222", { products: withMerged });
    expect(out.kind).toBe("unresolved");
  });
});

// ─── THE REGISTRATION ENTRY (owner correction 2026-08-06) ────────────────────
describe("every way in lands on the SAME panel", () => {
  const product = P("p1");
  it("search, the unregistered list, and the barcode shortcut build identical panels", () => {
    const fromSearch = registerPanelFor(product);
    const fromList = registerPanelFor(product);
    const fromShortcut = registerPanelFor(product, "7");
    expect(fromSearch).toEqual({ mode: "register", product, size: null, code: null });
    expect(fromList).toEqual(fromSearch);
    expect(fromShortcut).toEqual({ ...fromSearch, size: "7" });
  });
  it("no product, no panel", () => {
    expect(registerPanelFor(null)).toBe(null);
    expect(registerPanelFor({})).toBe(null);
  });
});

describe("the style-number step", () => {
  it("is satisfied by a code on file, a captured code, or a reasoned skip — nothing else", () => {
    expect(styleStepSatisfied(P("p1", { styleCodeNormalised: "CT8527016" }), null)).toBe(true);
    expect(styleStepSatisfied(P("p1"), { code: "CT8527-016" })).toBe(true);
    expect(styleStepSatisfied(P("p1"), { code: "ct8527 016" })).toBe(true);   // typing is never shape-gated
    expect(styleStepSatisfied(P("p1"), { skipped: "label_unreadable" })).toBe(true);
    expect(styleStepSatisfied(P("p1"), { skipped: "label_missing" })).toBe(true);
    expect(styleStepSatisfied(P("p1"), { skipped: "no_code_exists" })).toBe(true);
    expect(styleStepSatisfied(P("p1"), null)).toBe(false);
    expect(styleStepSatisfied(P("p1"), { code: "###" })).toBe(false);         // normalises to nothing
    expect(styleStepSatisfied(P("p1"), { skipped: "dunno" })).toBe(false);
  });

  it("a tongue-label read: one clean candidate is chosen, several become options, none says why", () => {
    expect(chooseFromLabelRead({ candidates: ["CT8527016"], displayCandidates: ["CT8527-016"] }))
      .toEqual({ kind: "chosen", code: "CT8527-016" });
    const many = chooseFromLabelRead({ candidates: ["CT8527016", "DD1391100"], displayCandidates: ["CT8527-016", "DD1391-100"] });
    expect(many.kind).toBe("options");
    expect(many.options).toEqual(["CT8527-016", "DD1391-100"]);
    expect(chooseFromLabelRead({ candidates: [], errors: [{ tier: "vision", message: "x" }] }).message).toMatch(/unavailable/);
    expect(chooseFromLabelRead({ candidates: [] }).message).toMatch(/type it/);
  });

  it("a code another live product owns is a conflict; merged-away owners don't count", () => {
    const products = [
      P("pMine"),
      P("pOther", { styleCodeNormalised: "CT8527016" }),
      P("pDead", { styleCodeNormalised: "CT8527016", mergedInto: "pOther" }),
    ];
    const owners = styleCodeOwners("CT8527-016", products, "pMine");
    expect(owners.map((p) => p.id)).toEqual(["pOther"]);
    expect(styleCodeOwners("ZZ999", products, "pMine")).toEqual([]);
    // The product's own claim is not a conflict with itself:
    expect(styleCodeOwners("CT8527-016", products, "pOther")).toEqual([]);
  });
});

// ─── THE COUNT ENTRY (owner reversal 2026-08-06: tongue label, not barcode) ──
describe("count entry — every way in lands on the SAME panel", () => {
  const product = P("p1");
  it("label read, manual entry, name search and the shortcut build identical panels", () => {
    expect(countPanelFor(product)).toEqual({ mode: "count", product, size: null, code: null });
    expect(countPanelFor(product)).toEqual(countPanelFor(product));
    expect(countPanelFor(product, "7")).toEqual({ mode: "count", product, size: "7", code: null });
    expect(countPanelFor(null)).toBe(null);
  });
});

describe("a style number resolves to its product — the claim is the authority", () => {
  const products = [P("p1"), P("p2", { styleCodeNormalised: "DD1391100" })];

  it("the /style_code_index claim wins, even when no local record carries the code", () => {
    const out = resolveStyleNumber("CT8527-016", { products, claim: { productId: "p1", claimedAt: 1 } });
    expect(out).toEqual({ kind: "claim", productId: "p1", normalised: "CT8527016" });
  });

  it("without a claim, a single live catalogue owner answers", () => {
    const out = resolveStyleNumber("DD1391-100", { products, claim: null });
    expect(out.kind).toBe("product");
    expect(out.product.id).toBe("p2");
  });

  it("two live owners are a DUPLICATE — routed to merge, never guessed", () => {
    const twins = [...products, P("p9", { styleCodeNormalised: "DD1391100" })];
    const out = resolveStyleNumber("DD1391-100", { products: twins, claim: null });
    expect(out.kind).toBe("duplicate");
    expect(out.products.map((p) => p.id).sort()).toEqual(["p2", "p9"]);
  });

  it("a CLEAN read that nothing owns is the never-registered signal", () => {
    const out = resolveStyleNumber("ZZ9999-999", { products, claim: null });
    expect(out).toEqual({ kind: "unresolved", normalised: "ZZ9999999" });
  });

  it("a merged-away catalogue owner does not answer for a code", () => {
    const withMerged = [P("pOld", { styleCodeNormalised: "AA111222", mergedInto: "p1" }), ...products];
    expect(resolveStyleNumber("AA111-222", { products: withMerged, claim: null }).kind).toBe("unresolved");
  });

  it("junk that normalises to nothing is unresolved without consulting anything", () => {
    expect(resolveStyleNumber("###", { products, claim: { productId: "p1" } }).kind).toBe("unresolved");
  });
});

describe("duplicate rows", () => {
  it("finds the open row involving a product and names the other half", () => {
    const rows = {
      a__b: { productIdA: "a", productIdB: "b", status: "open" },
      c__d: { productIdA: "c", productIdB: "d", status: "merged" },
    };
    expect(openDuplicateFor("b", rows).otherId).toBe("a");
    expect(openDuplicateFor("d", rows)).toBe(null); // closed rows stay closed
    expect(openDuplicateFor("x", rows)).toBe(null);
  });
});

describe("leftovers — what was never seen on the floor", () => {
  const products = [P("p1"), P("p2"), P("p3"), P("pClothing", { category: "Clothing", productType: "clothing" })];
  const hubStock = {
    p1: { 6: { qty: 2 } },
    p2: { 7: { qty: 1 } },
    p3: { 6: { qty: 0 } },            // zero-only cells hold nothing
    pClothing: { M: { qty: 5 } },     // clothing is not this cleanup's business
  };

  it("stock-holding footwear minus the registered set, biggest first", () => {
    const left = buildLeftovers({
      hub: "hub2", products, hubStock,
      registered: { p2__7: { productId: "p2", qty: 1 } },
    });
    expect(left.map((l) => l.product.id)).toEqual(["p1"]);
    expect(left[0].hubQty).toBe(2);
  });

  it("shows EVERY location the product holds, with per-size detail", () => {
    const allStock = {
      central: { p1: { 6: { qty: 10 }, 7: { qty: 2 } } },
      hub2: { p1: { 6: { qty: 2 } } },
      "marathon-pe": { p1: { 6: { qty: -1 } } },
      trophy: {},
    };
    const locs = locationsHolding("p1", allStock);
    expect(locs.map((l) => l.loc)).toEqual(["central", "hub2", "marathon-pe"]);
    expect(locs[0].qty).toBe(12);
    expect(locs[0].sizes).toEqual({ 6: 10, 7: 2 });
    expect(locs[2].qty).toBe(-1);     // a negative cell is shown, never hidden
  });

  it("a merged-away product is nobody's leftover", () => {
    const withMerged = [...products, P("pOld", { mergedInto: "p1" })];
    const left = buildLeftovers({
      hub: "hub2", products: withMerged,
      hubStock: { ...hubStock, pOld: { 6: { qty: 9 } } },
      registered: {},
    });
    expect(left.map((l) => l.product.id).includes("pOld")).toBe(false);
  });
});

describe("progress — scanned versus expected for the zone", () => {
  it("counts stock-holding footwear seen against expected", () => {
    const products = [P("p1"), P("p2"), P("p3")];
    const hubStock = { p1: { 6: { qty: 1 } }, p2: { 7: { qty: 3 } } };
    const registered = { p1__6: { productId: "p1", qty: 1 } };
    const prog = registrationProgress({ products, hubStock, registered });
    expect(prog.seen).toBe(1);
    expect(prog.expected).toBe(2);
    expect(prog.units).toBe(1);
  });
});

describe("sizes", () => {
  it("the one-size sentinel is never a pickable display size", () => {
    expect(realSizes({ sizes: ["6", "_", " ", "7"] })).toEqual(["6", "7"]);
    expect(realSizes({})).toEqual([]);
  });
});
