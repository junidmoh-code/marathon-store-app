// ─── firstBatchCore — scope, the per-size split, the atomic write, the undo ──
// Pure functions, called for real. The scope tests are the load-bearing ones:
// each "out of scope" row is a Solve that must stay byte-for-byte the old path.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  FIRST_BATCH_HUB, FIRST_BATCH_RUN_PREFIX, SOLVE_UNDONE_REASON, CENTRAL_DECLINED_REASON, isFirstBatchShopLeg, firstBatchRunId, solveIdFor,
  firstBatchEligible, isSneakerOrSlide, EXCLUDED_KEYS, firstBatchSplit, buildFirstBatchSolveUpdate,
  firstBatchUndoBlockers, firstBatchUndoCancelTxn, firstBatchEstimate,
  buildPlacementIndex, firstBatchHistory, firstBatchStoreChoice, HISTORY_STORES,
  centralReservedBySize, centralFreeFor, pruneClosedLocks, lockRefillIds, lockKeyFor,
} from "./firstBatchCore.js";
import { categoryRun, resolvedRun, categoryPolicyLocs } from "./solvePlan.js";

const ROUTES = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };
const TEE = { id: "tee1", name: "Essentials Tee", productType: "clothing", sizes: ["S", "M", "L"] };
const BAG = { id: "bag1", name: "Gym Bag", productType: "clothing", categoryKey: "bags", sizes: ["_"] };
const PERFUME = { id: "pf1", name: "Sauvage", categoryKey: "perfumes", sizes: ["_"] };
const SNEAKER = { id: "sn1", name: "Air Max", category: "Footwear", subcategory: "Sneakers", sizes: ["8"] };
const POLICY = {
  bags: { hub2: { target: 4, minQty: 2 }, trophy: { target: 2, minQty: 1 } },
  slides: { hub2: { carriedOnly: true, sizes: { 8: { target: 3 } } }, perSize: true },
};
const RUN = { hub2: { S: 2, M: 3, L: 3 }, trophy: { S: 2, M: 2, L: 2 }, "marathon-pe": { S: 2, M: 2, L: 1 } };

describe("scope — every category except sneakers and slides (owner rule 2026-09-17)", () => {
  const base = { source: "central", store: "trophy", product: TEE, routes: ROUTES, categoryPolicy: POLICY, targets: {} };
  it("IN: a Central-stranded clothing product, shop routed via Hub 2", () => {
    expect(firstBatchEligible(base)).toBe(true);
    expect(firstBatchEligible({ ...base, store: "marathon-pe" })).toBe(true);
  });
  it("OUT: a hub-stranded card — the hub-to-hub Solve is frozen", () => {
    expect(firstBatchEligible({ ...base, source: "hub2" })).toBe(false);
  });
  it("OUT: a shop whose route is not Hub 2 (and no routes at all)", () => {
    expect(firstBatchEligible({ ...base, routes: { ...ROUTES, trophy: "hub3" } })).toBe(false);
    expect(firstBatchEligible({ ...base, routes: undefined })).toBe(false);
    expect(firstBatchEligible({ ...base, store: "marathon-pine" })).toBe(false);
  });
  it("IN (was OUT in #607): a mapped category with an unscoped Hub 2 leg — bags, and every other live map key", () => {
    expect(firstBatchEligible({ ...base, product: BAG })).toBe(true);
    for (const key of ["belts", "caps-beanies", "fitted-caps", "gloves", "perfumes", "soccer-jerseys", "sunglasses", "underwear"]) {
      expect(firstBatchEligible({ ...base, product: { ...BAG, categoryKey: key } }), key).toBe(true);
    }
  });
  it("IN (was OUT in #607): perfume — not clothing in the engine's sense, but on the path", () => {
    expect(firstBatchEligible({ ...base, product: PERFUME })).toBe(true);
  });
  it("IN (was OUT in #607): an explicit /stock_targets row at Hub 2 — the row IS Hub 2's policy", () => {
    expect(firstBatchEligible({ ...base, targets: { hub2: { tee1: { M: { target: 5 } } } } })).toBe(true);
  });
  it("IN: a typeless, keyless non-footwear record (the tab now admits it; its policy decides the rest)", () => {
    expect(firstBatchEligible({ ...base, product: { id: "x1", name: "Phone case", sizes: ["_"] } })).toBe(true);
    expect(firstBatchEligible({ ...base, product: { id: "x2", name: "Suit jacket", categoryKey: "suits", productType: "sneaker", sizes: ["S"] } })).toBe(true);
  });
  it("OUT: sneakers and slides, by every identity the catalogue uses", () => {
    expect(firstBatchEligible({ ...base, product: { ...TEE, categoryKey: "sneakers" } })).toBe(false);
    expect(firstBatchEligible({ ...base, product: { ...TEE, categoryKey: "slides" } })).toBe(false);
    expect(firstBatchEligible({ ...base, product: { ...TEE, categoryKey: " slides " } })).toBe(false);   // trimmed like the engine
    expect(firstBatchEligible({ ...base, product: SNEAKER })).toBe(false);          // keyless legacy sneaker (Footwear + Sneakers)
    expect(firstBatchEligible({ ...base, product: { id: "sl", name: "Arizona", category: "Footwear", subcategory: "Sandals & Slides", sizes: ["8"] } })).toBe(false);
    expect(firstBatchEligible({ ...base, product: null })).toBe(false);
  });
  it("the exclusion is EXACT: no other footwear key is excluded by the predicate (they never reach this Solve; the tab owns that)", () => {
    expect(EXCLUDED_KEYS).toEqual(["sneakers", "slides"]);
    for (const key of ["boots", "soccer-boots", "loafers", "running-shoes", "kids-shoes", "designer-shoes"]) {
      expect(isSneakerOrSlide({ id: "b", categoryKey: key, category: "Footwear", sizes: ["8"] }), key).toBe(false);
    }
    // an assigned key WINS over the legacy pair, both ways
    expect(isSneakerOrSlide({ categoryKey: "boots", category: "Footwear", subcategory: "Sneakers" })).toBe(false);
    expect(isSneakerOrSlide({ categoryKey: "sneakers", category: "Clothing", subcategory: "T-Shirts" })).toBe(true);
    expect(isSneakerOrSlide(SNEAKER)).toBe(true);
    expect(isSneakerOrSlide({ category: "Footwear", subcategory: "Boots" })).toBe(false);
    // a keyless "Footwear" record with NO leaf is not a sneaker to the catalogue
    // either (effectiveCategoryKey answers null) — it is footwear, and the tab
    // keeps it off this Solve; the predicate itself stays exact.
    expect(isSneakerOrSlide({ category: "Footwear", sizes: ["8"] })).toBe(false);
  });
});

describe("the per-size split", () => {
  const avail = { S: 4, M: 1, L: 0 };
  it("a size Central can send is a first-batch size at the SHOP's policy quantity, capped by Central", () => {
    const { firstBatch, normal } = firstBatchSplit({ sizes: ["S", "M", "L"], run: RUN, store: "trophy", centralAvail: (s) => avail[s], maxUnitsPerIntent: 20 });
    expect(firstBatch).toEqual([{ size: "S", qty: 2, target: 2, avail: 4 }, { size: "M", qty: 1, target: 2, avail: 1 }]);
    expect(normal).toEqual(["L"]);
  });
  it("the engine's per-intent cap bounds the batch; garbage cap falls back to the engine default 20", () => {
    const big = { hub2: { M: 50 }, trophy: { M: 50 } };
    expect(firstBatchSplit({ sizes: ["M"], run: big, store: "trophy", centralAvail: () => 99, maxUnitsPerIntent: 5 }).firstBatch[0].qty).toBe(5);
    expect(firstBatchSplit({ sizes: ["M"], run: big, store: "trophy", centralAvail: () => 99, maxUnitsPerIntent: "x" }).firstBatch[0].qty).toBe(20);
  });
  it("a size with no store target never becomes a request", () => {
    expect(firstBatchSplit({ sizes: ["XXL"], run: RUN, store: "trophy", centralAvail: () => 9 })).toEqual({ firstBatch: [], normal: ["XXL"] });
  });
});

describe("the atomic write", () => {
  const now = "2026-09-17T10:00:00.000Z";
  const seedCell = () => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: now, updatedBy: "u1" });
  let n = 0;
  const newKey = () => `k${++n}`;
  const split = firstBatchSplit({ sizes: ["S", "M", "L"], run: RUN, store: "trophy", centralAvail: (s) => ({ S: 4, M: 1, L: 0 })[s] });
  it("seeds the SHOP for every size, Hub 2 ONLY for the normal size, and one request per first-batch size", () => {
    n = 0;
    const { updates, requestIds, paths } = buildFirstBatchSolveUpdate({ pid: "tee1", store: "trophy", split, existing: {}, seedCell, nowIso: now, uid: "u1", solveId: "fb_tee1_x", newKey });
    expect(paths.sort()).toEqual(["stock/hub2/tee1/L", "stock/trophy/tee1/L", "stock/trophy/tee1/M", "stock/trophy/tee1/S"]);
    expect(updates["stock/hub2/tee1/S"]).toBeUndefined();
    expect(updates["stock/hub2/tee1/M"]).toBeUndefined();
    expect(requestIds).toEqual(["k1", "k2"]);
    expect(updates["refill_requests/k1"]).toEqual({
      productId: "tee1", size: "S", qty: 2, requestingLocation: "trophy", status: "open", createdAt: now,
      createdFrom: { firstBatch: true, solveId: "fb_tee1_x", source: "central", store: "trophy", hub: FIRST_BATCH_HUB, via: "missing_products_solve", by: "u1" },
    });
    expect(updates["refill_requests/k2"].size).toBe("M");
    expect(updates["refill_requests/k2"].qty).toBe(1);
    expect(Object.keys(updates)).toHaveLength(6);
  });
  it("the existence probe uses the PATH's encoder: an existing one-size '_' cell is found for a 'Free Size' catalogue size", () => {
    n = 0;
    const s = firstBatchSplit({ sizes: ["Free Size"], run: { hub2: { "FREE SIZE": 2 }, trophy: { "FREE SIZE": 1 } }, store: "trophy", centralAvail: () => 3 });
    const { updates } = buildFirstBatchSolveUpdate({ pid: "os1", store: "trophy", split: s, existing: { trophy: { _: { qty: 5 } } }, seedCell, nowIso: now, uid: "u1", solveId: "s", newKey });
    expect(Object.keys(updates).filter((k) => k.startsWith("stock/"))).toEqual([]);   // the stored "_" cell is seen, nothing seeded over it
    expect(updates["refill_requests/k1"].size).toBe("Free Size");
  });
  it("seed-if-absent: an existing cell is never overwritten; a missing uid is OMITTED, never undefined", () => {
    n = 0;
    const { updates, paths } = buildFirstBatchSolveUpdate({ pid: "tee1", store: "trophy", split, existing: { trophy: { S: { qty: 3 } } }, seedCell, nowIso: now, uid: null, solveId: "s", newKey });
    expect(updates["stock/trophy/tee1/S"]).toBeUndefined();
    expect(paths).not.toContain("stock/trophy/tee1/S");
    expect("by" in updates["refill_requests/k1"].createdFrom).toBe(false);
    expect(JSON.stringify(updates)).not.toMatch(/undefined/);
  });
  it("keys by productId: twins with one name write disjoint paths", () => {
    n = 0;
    const a = buildFirstBatchSolveUpdate({ pid: "tee1", store: "trophy", split, existing: {}, seedCell, nowIso: now, uid: "u1", solveId: "a", newKey });
    const b = buildFirstBatchSolveUpdate({ pid: "tee2", store: "trophy", split, existing: {}, seedCell, nowIso: now, uid: "u1", solveId: "b", newKey });
    const cells = (u) => Object.keys(u.updates).filter((k) => k.startsWith("stock/"));
    expect(cells(a).some((k) => cells(b).includes(k))).toBe(false);
    expect(Object.values(a.updates).filter((v) => v.productId).every((v) => v.productId === "tee1")).toBe(true);
    expect(Object.values(b.updates).filter((v) => v.productId).every((v) => v.productId === "tee2")).toBe(true);
  });
  it("encodes a size that needs it on the cell path, never the raw size", () => {
    const s = firstBatchSplit({ sizes: ["5.5"], run: { hub2: { "5.5": 2 }, trophy: { "5.5": 1 } }, store: "trophy", centralAvail: () => 3 });
    const { updates } = buildFirstBatchSolveUpdate({ pid: "x", store: "trophy", split: s, existing: {}, seedCell, nowIso: now, uid: "u1", solveId: "s", newKey });
    expect(updates["stock/trophy/x/5_5"]).toBeTruthy();
    expect(updates["stock/trophy/x/5.5"]).toBeUndefined();
    expect(updates["refill_requests/" + Object.keys(updates).find((k) => k.startsWith("refill_requests/")).split("/")[1]].size).toBe("5.5");
  });
});

describe("identity and the undo", () => {
  it("solve ids are product-scoped and server-time-stamped; leg run ids share the solve", () => {
    expect(solveIdFor("tee1", 1000)).toBe("fb_tee1_rs");
    expect(solveIdFor("tee1", 1000)).not.toBe(solveIdFor("tee2", 1000));
    expect(firstBatchRunId("fb_tee1_rs")).toBe(`${FIRST_BATCH_RUN_PREFIX}fb_tee1_rs`);
  });
  it("undo is blocked once Central has sent, answered or partially sent; a vanished row or this solve's own finished cancel is not a blocker", () => {
    expect(firstBatchUndoBlockers({ liveRequests: { a: { status: "open", size: "M" }, b: null } })).toEqual([]);
    // a retry after a partial undo: its own cancel already landed
    expect(firstBatchUndoBlockers({ liveRequests: { a: { status: "cancelled", cancelReason: SOLVE_UNDONE_REASON, size: "M" } } })).toEqual([]);
    expect(firstBatchUndoBlockers({ liveRequests: { a: { status: "fulfilled", size: "M" } }, storeLabel: "Trophy" })[0]).toMatch(/already sent/);
    expect(firstBatchUndoBlockers({ liveRequests: { a: { status: "cancelled", size: "M" } } })[0]).toMatch(/answered/);
    expect(firstBatchUndoBlockers({ liveRequests: { a: { status: "open", sentQty: 1, size: "L" } } })[0]).toMatch(/started sending size L/);
  });
  it("the undo cancels WITH the solve_undone reason, as a CAS that refuses a row Central got to first", () => {
    const txn = firstBatchUndoCancelTxn({ nowIso: "t", uid: "u1" });
    const open = { productId: "p", size: "M", qty: 2, status: "open", createdFrom: { firstBatch: true } };
    expect(txn(open)).toEqual({ ...open, status: "cancelled", cancelReason: SOLVE_UNDONE_REASON, resolvedAt: "t", resolvedBy: "u1" });
    expect("resolvedBy" in firstBatchUndoCancelTxn({ nowIso: "t", uid: null })(open)).toBe(false);
    // Central fulfilled it in the gap → abort (undefined), the row stands
    expect(txn({ ...open, status: "fulfilled" })).toBeUndefined();
    // Central sent a tranche in the gap → abort
    expect(txn({ ...open, qty: 1, sentQty: 1 })).toBeUndefined();
    // cold-cache null is answered, never aborted (the one-shot abort trap)
    expect(txn(null)).toBe(null);
  });
  it("the panel estimate: shop units now, Hub 2's policy units after", () => {
    const split = firstBatchSplit({ sizes: ["S", "M", "L"], run: RUN, store: "trophy", centralAvail: (s) => ({ S: 4, M: 1, L: 0 })[s] });
    expect(firstBatchEstimate({ split, run: RUN })).toEqual({ shopNow: 3, hubAfter: 5, sizesNow: ["S", "M"], sizesNormal: ["L"] });
  });
});

describe("location history — which shop is nominated (owner rule 2026-09-17)", () => {
  const cell = (qty) => ({ qty, v: 1, mv: "m" });
  const LABELS = { "marathon-pe": "Marathon PE", trophy: "Trophy" };
  // The stranded product (no shop cell), two siblings by style-code STAMP, a
  // duplicate-NAME twin with no code, and the rest of its category.
  const CARD = { id: "tee1", name: "Essentials Tee Olive", categoryKey: "t-shirts", productType: "clothing", styleCodeNormalised: "ES1", sizes: ["S", "M"] };
  const SIB_A = { id: "tee2", name: "Essentials Tee Black", categoryKey: "t-shirts", productType: "clothing", styleCodeNormalised: "ES1", sizes: ["S", "M"] };
  const SIB_B = { id: "tee3", name: "Essentials Tee Navy", categoryKey: "t-shirts", productType: "clothing", styleCodeNormalised: " ES1 ", sizes: ["S", "M"] };
  const NAME_TWIN = { id: "tee9", name: "Essentials Tee Olive", categoryKey: "t-shirts", productType: "clothing", sizes: ["S", "M"] };
  const OTHER_TEES = [4, 5, 6, 7].map((n) => ({ id: `t${n}`, name: `Tee ${n}`, categoryKey: "t-shirts", productType: "clothing", sizes: ["M"] }));
  const LEGACY_SNEAKER = { id: "sn9", name: "Campus", category: "Footwear", subcategory: "Sneakers", sizes: ["8"] };
  const KEYLESS = { id: "k1", name: "Mystery", sizes: ["M"] };
  const PRODUCTS = [CARD, SIB_A, SIB_B, NAME_TWIN, ...OTHER_TEES, LEGACY_SNEAKER, KEYLESS];
  const STOCK = {
    central: { tee1: { S: cell(4) } },
    trophy: { tee2: { S: cell(2), M: cell(0) }, tee3: { S: cell(0) }, t4: { M: cell(1) }, t5: { M: cell(0) }, sn9: { 8: cell(1) } },
    "marathon-pe": { tee9: { S: cell(9) }, t6: { M: cell(3) }, t7: { M: cell(2) }, k1: { M: cell(1) } },
  };
  const index = buildPlacementIndex({ products: PRODUCTS, allStock: STOCK });

  it("the index counts CARRIED products per category per shop (qty-0 cells count: sent before and sold out) and groups siblings by the trimmed stamp", () => {
    expect(index.byKey["t-shirts"]).toEqual({ trophy: 4, "marathon-pe": 3 });   // tee2, tee3, t4, t5 · tee9, t6, t7
    expect(index.byKey.sneakers).toEqual({ trophy: 1 });                           // the keyless legacy sneaker resolves its key
    expect(index.byKey["(no key)"]).toBeUndefined();
    expect(Object.keys(index.byKey)).not.toContain("null");                        // a keyless record is in no bucket
    expect(index.byCode.ES1.sort()).toEqual(["tee1", "tee2", "tee3"]);
    expect(index.stores).toEqual(HISTORY_STORES);
  });
  it("siblings are found by the style-code stamp, NEVER by name: the duplicate-name twin at PE is not history", () => {
    const h = firstBatchHistory({ pid: "tee1", product: CARD, index, allStock: STOCK, targets: null });
    expect(h.siblings.sort()).toEqual(["tee2", "tee3"]);
    expect(h.byStore.trophy).toEqual({ ownRow: false, siblingCells: 2, siblingUnits: 2, categoryCarried: 4 });
    expect(h.byStore["marathon-pe"]).toEqual({ ownRow: false, siblingCells: 0, siblingUnits: 0, categoryCarried: 3 });
    expect(h.categoryTotal).toBe(7);
  });
  it("tier 1 — the product's OWN positive explicit row wins over siblings and category; an explicit 0 row is not a seat", () => {
    const targets = { "marathon-pe": { tee1: { S: { target: 2 } } } };
    const h = firstBatchHistory({ pid: "tee1", product: CARD, index, allStock: STOCK, targets });
    expect(h.byStore["marathon-pe"].ownRow).toBe(true);
    const c = firstBatchStoreChoice({ history: h, candidates: ["marathon-pe", "trophy"], labels: LABELS });
    expect(c).toEqual({ store: "marathon-pe", tier: "own_row", sentence: "Marathon PE first — this product has its own target row there." });
    const zero = firstBatchHistory({ pid: "tee1", product: CARD, index, allStock: STOCK, targets: { "marathon-pe": { tee1: { S: { target: 0 } } } } });
    expect(zero.byStore["marathon-pe"].ownRow).toBe(false);
  });
  it("tier 2 — colourway siblings' shop wins over the category prior", () => {
    const stock = { ...STOCK, "marathon-pe": { ...STOCK["marathon-pe"], t8: { M: cell(1) }, t9: { M: cell(1) } } };
    const idx = buildPlacementIndex({ products: [...PRODUCTS, { id: "t8", categoryKey: "t-shirts", productType: "clothing", sizes: ["M"] }, { id: "t9", categoryKey: "t-shirts", productType: "clothing", sizes: ["M"] }], allStock: stock });
    const h = firstBatchHistory({ pid: "tee1", product: CARD, index: idx, allStock: stock, targets: null });
    expect(h.byStore["marathon-pe"].categoryCarried).toBe(5);   // PE now leads the category…
    const c = firstBatchStoreChoice({ history: h, candidates: ["marathon-pe", "trophy"], labels: LABELS });
    expect(c.store).toBe("trophy");                               // …but the siblings sit at Trophy
    expect(c.tier).toBe("siblings");
    expect(c.sentence).toBe("Trophy first — 2 colourway siblings are kept there (2 units).");
  });
  it("tier 3 — the category's placement decides when the product has no row and no siblings", () => {
    const h = firstBatchHistory({ pid: "t4", product: OTHER_TEES[0], index, allStock: STOCK, targets: null });
    const c = firstBatchStoreChoice({ history: h, candidates: ["marathon-pe", "trophy"], labels: LABELS });
    expect(c).toEqual({ store: "trophy", tier: "category", sentence: "Trophy first — where 4 of 7 t-shirts lines are kept." });
  });
  it("a tie at a tier falls through; no history at all → today's default (the first candidate) with no sentence", () => {
    const tied = { key: "bags", siblings: [], categoryTotal: 4, byStore: { "marathon-pe": { ownRow: true, siblingCells: 0, siblingUnits: 0, categoryCarried: 2 }, trophy: { ownRow: true, siblingCells: 0, siblingUnits: 0, categoryCarried: 2 } } };
    expect(firstBatchStoreChoice({ history: tied, candidates: ["marathon-pe", "trophy"] })).toEqual({ store: "marathon-pe", tier: "default", sentence: null });
    const empty = firstBatchHistory({ pid: "k1", product: KEYLESS, index, allStock: {}, targets: null });
    expect(empty.categoryTotal).toBe(0);
    expect(firstBatchStoreChoice({ history: empty, candidates: ["trophy", "marathon-pe"] })).toEqual({ store: "trophy", tier: "default", sentence: null });
    expect(firstBatchStoreChoice({ history: empty, candidates: [] })).toEqual({ store: null, tier: null, sentence: null });
    expect(firstBatchStoreChoice({ history: null, candidates: ["trophy"] })).toEqual({ store: null, tier: null, sentence: null });
  });
  it("history only orders the shops the POLICY allows: a shop with no qualifying sizes is never nominated, whatever its history", () => {
    const h = firstBatchHistory({ pid: "tee1", product: CARD, index, allStock: STOCK, targets: null });   // Trophy has the siblings + the category
    expect(firstBatchStoreChoice({ history: h, candidates: ["marathon-pe"], labels: LABELS })).toEqual({ store: "marathon-pe", tier: "category", sentence: "Marathon PE first — where 3 of 7 t-shirts lines are kept." });
  });
  it("a deactivated or merged record is not history: it is skipped by the index (siblings and the category prior alike)", () => {
    const dead = { ...SIB_A, id: "teeD", deactivated: { at: 1, by: "u" } };
    const merged = { ...SIB_B, id: "teeM", mergedInto: "tee2" };
    const idx = buildPlacementIndex({ products: [CARD, dead, merged, ...OTHER_TEES], allStock: { trophy: { teeD: { S: cell(9) }, teeM: { S: cell(9) }, t4: { M: cell(1) } } } });
    expect(idx.byKey["t-shirts"]).toEqual({ trophy: 1 });
    expect(idx.byCode.ES1).toEqual(["tee1"]);
    const h = firstBatchHistory({ pid: "tee1", product: CARD, index: idx, allStock: { trophy: { teeD: { S: cell(9) } } }, targets: null });
    expect(h.siblings).toEqual([]);
  });
  it("an array-coerced sibling row (null holes) counts once, its units clamp at 0, and a one-size sibling is history like any other", () => {
    const stock = { trophy: { tee2: [null, null, cell(-1)], tee3: { _: cell(3) } } };
    const h = firstBatchHistory({ pid: "tee1", product: CARD, index, allStock: stock, targets: null });
    expect(h.byStore.trophy).toMatchObject({ siblingCells: 2, siblingUnits: 3 });
  });
});

describe("Central's open reservations — the engine's sourceReserved, on the client (2026-09-17)", () => {
  const lock = (qty, source) => ({ qty, createdAt: "t", runId: "scan-1", refillId: "r", ...(source ? { source } : {}) });
  it("sums every open lock whose source is Central — explicit, or by the destination's route — per lock key", () => {
    const openByLoc = {
      hub2: { M: lock(3), "5_5": lock(1) },                       // route hub2→central
      hub1: { M: lock(2) },                                       // route hub1→central
      trophy: { M: lock(1, "central"), L: lock(4) },              // a sibling shop's first batch (explicit central) · an engine hub2→trophy leg (route hub2)
      "marathon-pe": { M: lock(2, "hub2") },                      // explicit hub2 source
      hub3: { M: lock(9) },                                       // no route at all → no source
    };
    expect(centralReservedBySize({ openByLoc, routes: ROUTES })).toEqual({ M: 6, "5_5": 1 });
  });
  it("a lock with no usable qty counts as 1 (the engine's own floor); garbage and holes are skipped", () => {
    expect(centralReservedBySize({ openByLoc: { hub2: { M: { source: "central" }, L: { qty: "x", source: "central" }, S: null, XL: 7 } }, routes: ROUTES })).toEqual({ M: 1, L: 1 });
    expect(centralReservedBySize({ openByLoc: { hub2: null, trophy: "junk" }, routes: ROUTES })).toEqual({});
    expect(centralReservedBySize({})).toEqual({});
  });
  it("free = on-hand minus the reservation for the ENCODED size key, floored at 0", () => {
    const reserved = { M: 3, "5_5": 1, _: 2 };
    expect(centralFreeFor({ qtyAt: () => 4, reserved, size: "M" })).toBe(1);
    expect(centralFreeFor({ qtyAt: () => 1, reserved, size: "5.5" })).toBe(0);   // the lock key is "5_5"
    expect(centralFreeFor({ qtyAt: () => 1, reserved, size: "_" })).toBe(0);
    expect(centralFreeFor({ qtyAt: () => 5, reserved, size: "L" })).toBe(5);
    expect(centralFreeFor({ qtyAt: () => -2, reserved: {}, size: "L" })).toBe(0);
  });
  it("a DEAD lock is not a reservation: its request gone, fulfilled or cancelled → dropped; open → kept; a pending lock (no refillId) → kept", () => {
    const openByLoc = {
      trophy: { M: lock(2, "central") },                                                    // an undone solve's lock: request cancelled
      hub2: { M: { ...lock(3), refillId: "done" }, L: { ...lock(1), refillId: "gone" }, S: { qty: 1, source: "central", runId: "first_batch:x", pending: true } },
      "marathon-pe": { M: { ...lock(2, "central"), refillId: "live" } },
    };
    const requestsById = { r: { status: "cancelled", cancelReason: "solve_undone" }, done: { status: "fulfilled" }, gone: null, live: { status: "open" } };
    expect(lockRefillIds(openByLoc).sort()).toEqual(["done", "gone", "live", "r"]);
    const pruned = pruneClosedLocks({ openByLoc, requestsById });
    expect(pruned).toEqual({ trophy: null, hub2: { S: openByLoc.hub2.S }, "marathon-pe": { M: openByLoc["marathon-pe"].M } });
    expect(centralReservedBySize({ openByLoc: pruned, routes: ROUTES })).toEqual({ S: 1, M: 2 });
    // a lock whose request was NOT read stays (never assume a row is dead without looking)
    expect(pruneClosedLocks({ openByLoc: { hub2: { M: lock(3) } }, requestsById: {} })).toEqual({ hub2: { M: lock(3) } });
    expect(pruneClosedLocks({ openByLoc: { hub2: null, x: "junk" }, requestsById: {} })).toEqual({ hub2: null, x: "junk" });
  });
  it("the reservation lookup uses the ENGINE's key: a padded ' 8' finds the lock at '8', a blank size the '_' lock", () => {
    expect(lockKeyFor(" 8")).toBe("8");
    expect(lockKeyFor("")).toBe("_");
    expect(lockKeyFor("5.5")).toBe("5_5");
    expect(lockKeyFor("Free Size")).toBe("Free_Size");
    expect(centralFreeFor({ qtyAt: () => 3, reserved: { 8: 2 }, size: " 8" })).toBe(1);
  });
  it("through the split: a promised unit is never asked for twice, and a fully promised size takes the normal path", () => {
    const reserved = centralReservedBySize({ openByLoc: { hub2: { M: lock(4), S: lock(1) } }, routes: ROUTES });
    const avail = { S: 4, M: 4, L: 2 };
    const { firstBatch, normal } = firstBatchSplit({
      sizes: ["S", "M", "L"], run: RUN, store: "trophy",
      centralAvail: (sz) => centralFreeFor({ qtyAt: (s) => avail[s], reserved, size: sz }), maxUnitsPerIntent: 20,
    });
    expect(firstBatch).toEqual([{ size: "S", qty: 2, target: 2, avail: 3 }, { size: "L", qty: 2, target: 2, avail: 2 }]);
    expect(normal).toEqual(["M"]);
  });
});

describe("a per-location SIZE MAP (soccer-jerseys / underwear live shape) resolves on the client exactly as the engine resolves it", () => {
  const require = createRequire(import.meta.url);
  const { resolveTarget } = require("../../../functions/lib/refill-engine.cjs");
  const rows = (t) => Object.fromEntries(["S", "M", "L", "XL", "XXL", "XXXL"].map((k) => [k, { target: t, minQty: 1, reorderPoint: 1 }]));
  const POLICY_MAP = { "soccer-jerseys": { perSize: true, hub2: { sizes: rows(4) }, "marathon-pe": { sizes: rows(2) } } };
  const JERSEY = { id: "sj1", name: "Real Madrid Home", productType: "clothing", categoryKey: "soccer-jerseys", sizes: ["S", "M", "L", "XXXL"] };
  const stock = { central: { sj1: { S: { qty: 3 }, M: { qty: 0 }, L: { qty: 2 } } } };
  const unitsAnywhere = (sz) => Object.values(stock).reduce((t, byPid) => t + Math.max(Number(byPid.sj1?.[sz]?.qty) || 0, 0), 0);
  it("the map arms the named sizes with their own numbers; a size with zero units anywhere is a dead 0; the client agrees with resolveTarget size by size", () => {
    const run = categoryRun({ policy: POLICY_MAP, categoryKey: "soccer-jerseys", sizes: JERSEY.sizes, unitsAnywhere });
    expect(run).toEqual({ hub2: { S: 4, M: 0, L: 4, XXXL: 0 }, "marathon-pe": { S: 2, M: 0, L: 2, XXXL: 0 } });
    const cfg = { categoryPolicy: POLICY_MAP, ruleBasedTargets: true, defaultRunByStore: { hub2: { S: 9, M: 9, L: 9 }, "marathon-pe": { S: 9, M: 9, L: 9 } } };
    for (const dest of ["hub2", "marathon-pe"]) {
      const seeded = { ...stock, [dest]: { sj1: Object.fromEntries(JERSEY.sizes.map((s) => [s, { qty: 0 }])) } };
      const ctx = { config: cfg, products: { sj1: JERSEY }, stock: seeded, targets: {} };
      for (const sz of JERSEY.sizes) {
        const engine = resolveTarget(ctx, dest, "sj1", sz);
        expect(engine?.source, `${dest} ${sz}`).toBe("category_policy");
        expect(run[dest][sz], `${dest} ${sz}`).toBe(engine.target);
      }
    }
    // and through resolvedRun the map beats the letter run, exactly as the engine's branch order
    const rr = resolvedRun({ std: cfg.defaultRunByStore, sizes: JERSEY.sizes, targets: {}, pid: "sj1", ruleBasedTargets: true, categoryPolicy: POLICY_MAP, categoryKey: "soccer-jerseys", unitsAnywhere });
    expect(rr.hub2).toEqual({ S: 4, M: 0, L: 4, XXXL: 0 });
  });
  it("an entry carrying BOTH a collapsed target and a sizes map is garbled: the engine arms nothing for it, and so does the client", () => {
    const garbled = { headwear: { perSize: true, hub2: { target: 5, sizes: rows(3) } } };
    const HAT = { id: "h1", name: "Cap", productType: "clothing", categoryKey: "headwear", sizes: ["S", "M"] };
    expect(categoryRun({ policy: garbled, categoryKey: "headwear", sizes: HAT.sizes, unitsAnywhere: () => 1 })).toEqual({});
    const ctx = { config: { categoryPolicy: garbled }, products: { h1: HAT }, stock: { hub2: { h1: { S: { qty: 0 }, M: { qty: 0 } } }, central: { h1: { S: { qty: 2 } } } }, targets: {} };
    expect(resolveTarget(ctx, "hub2", "h1", "S")).toBe(null);
    expect(categoryPolicyLocs(garbled, "headwear")).toEqual([]);
  });
  it("a map outside perSize mode, or with no usable row, arms nothing (the engine refuses it too)", () => {
    expect(categoryRun({ policy: { x: { hub2: { sizes: rows(4) } } }, categoryKey: "x", sizes: ["S"], unitsAnywhere: () => 1 })).toEqual({});
    expect(categoryRun({ policy: { x: { perSize: true, hub2: { sizes: { S: { target: 0 } } } } }, categoryKey: "x", sizes: ["S"], unitsAnywhere: () => 1 })).toEqual({});
    expect(categoryRun({ policy: { x: { perSize: true, hub2: { sizes: rows(4) } } }, categoryKey: "x", sizes: ["_"], unitsAnywhere: () => 1 })).toEqual({});
  });
});

describe("the CJS twin in functions/lib/first-batch.cjs speaks the same constants", () => {
  it("hub, run prefix and undo reason are identical on both sides", () => {
    const require = createRequire(import.meta.url);
    const fb = require("../../../functions/lib/first-batch.cjs");
    expect(fb.FIRST_BATCH_HUB).toBe(FIRST_BATCH_HUB);
    expect(fb.FIRST_BATCH_RUN_PREFIX).toBe(FIRST_BATCH_RUN_PREFIX);
    expect(fb.SOLVE_UNDONE_REASON).toBe(SOLVE_UNDONE_REASON);
    expect(fb.CENTRAL_DECLINED_REASON).toBe(CENTRAL_DECLINED_REASON);
    // and the shop-leg test: a tagged shop row yes, Hub 2's tagged leg no, an engine row no
    expect(isFirstBatchShopLeg({ createdFrom: { firstBatch: true }, requestingLocation: "trophy" })).toBe(true);
    expect(isFirstBatchShopLeg({ createdFrom: { firstBatch: true }, requestingLocation: "hub2" })).toBe(false);
    expect(isFirstBatchShopLeg({ createdFrom: { engine: true }, requestingLocation: "trophy" })).toBe(false);
    expect(fb.firstBatchRunId("x")).toBe(firstBatchRunId("x"));
  });
});
