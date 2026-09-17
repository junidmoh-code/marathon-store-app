// ─── firstBatchCore — scope, the per-size split, the atomic write, the undo ──
// Pure functions, called for real. The scope tests are the load-bearing ones:
// each "out of scope" row is a Solve that must stay byte-for-byte the old path.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  FIRST_BATCH_HUB, FIRST_BATCH_RUN_PREFIX, SOLVE_UNDONE_REASON, CENTRAL_DECLINED_REASON, isFirstBatchShopLeg, firstBatchRunId, solveIdFor,
  firstBatchEligible, isSneakerOrSlide, EXCLUDED_KEYS, firstBatchSplit, buildFirstBatchSolveUpdate, FIRST_BATCH_ENABLED,
  hub2PresenceSignals, hub2Present,
  firstBatchUndoBlockers, firstBatchUndoCancelTxn, firstBatchEstimate,
  buildPlacementIndex, firstBatchHistory, firstBatchStoreChoice, HISTORY_STORES, firstBatchSizeHints, MIN_LINES_FOR_SIZE_HINT,
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
  // `enabled: true` drives the PATH's scope rule; the live default is OFF
  // (FIRST_BATCH_ENABLED — incident 2026-09-17), pinned in its own block below.
  // `hub2Present: false` is the hard precondition, asserted explicitly (the
  // guard fails closed on anything else — its own block below).
  const base = { source: "central", store: "trophy", product: TEE, routes: ROUTES, categoryPolicy: POLICY, targets: {}, enabled: true, hub2Present: false };
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
    expect(firstBatchSplit({ sizes: ["XXL"], run: RUN, store: "trophy", centralAvail: () => 9 })).toEqual({ firstBatch: [], normal: ["XXL"], held: [] });
  });
});

describe("the atomic write", () => {
  const now = "2026-09-17T10:00:00.000Z";
  const seedCell = () => ({ qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: now, updatedBy: "u1" });
  let n = 0;
  const newKey = () => `k${++n}`;
  const split = firstBatchSplit({ sizes: ["S", "M", "L"], run: RUN, store: "trophy", centralAvail: (s) => ({ S: 4, M: 1, L: 0 })[s] });
  it("seeds the SHOP AND Hub 2 for every size (Hub 2 is always a valid source), one request per first-batch size, and records the Hub 2 seeds it wrote", () => {
    n = 0;
    const { updates, requestIds, paths } = buildFirstBatchSolveUpdate({ pid: "tee1", store: "trophy", split, existing: {}, seedCell, nowIso: now, uid: "u1", solveId: "fb_tee1_x", newKey });
    expect(paths.sort()).toEqual(["stock/hub2/tee1/L", "stock/hub2/tee1/M", "stock/hub2/tee1/S", "stock/trophy/tee1/L", "stock/trophy/tee1/M", "stock/trophy/tee1/S"]);
    expect(updates["stock/hub2/tee1/S"]).toEqual(seedCell());
    expect(updates["stock/hub2/tee1/M"]).toEqual(seedCell());
    expect(requestIds).toEqual(["k1", "k2"]);
    expect(updates["refill_requests/k1"]).toEqual({
      productId: "tee1", size: "S", qty: 2, requestingLocation: "trophy", status: "open", createdAt: now,
      createdFrom: { firstBatch: true, solveId: "fb_tee1_x", source: "central", store: "trophy", hub: FIRST_BATCH_HUB, via: "missing_products_solve", hub2Seeded: ["S", "M"], by: "u1" },
    });
    expect(updates["refill_requests/k2"].size).toBe("M");
    expect(updates["refill_requests/k2"].qty).toBe(1);
    expect(Object.keys(updates)).toHaveLength(8);
  });
  it("hub2Seeded lists ONLY the Hub 2 cells this write creates: an existing Hub 2 cell is neither overwritten nor listed; none → the key is omitted (RTDB cannot store [])", () => {
    n = 0;
    const { updates } = buildFirstBatchSolveUpdate({ pid: "tee1", store: "trophy", split, existing: { hub2: { S: { qty: 0 } } }, seedCell, nowIso: now, uid: "u1", solveId: "fb_tee1_x", newKey });
    expect(updates["stock/hub2/tee1/S"]).toBeUndefined();
    expect(updates["refill_requests/k1"].createdFrom.hub2Seeded).toEqual(["M"]);
    n = 0;
    const { updates: u2 } = buildFirstBatchSolveUpdate({ pid: "tee1", store: "trophy", split, existing: { hub2: { S: { qty: 0 }, M: { qty: 0 } } }, seedCell, nowIso: now, uid: "u1", solveId: "fb_tee1_x", newKey });
    expect(Object.prototype.hasOwnProperty.call(u2["refill_requests/k1"].createdFrom, "hub2Seeded")).toBe(false);
  });
  it("the existence probe uses the PATH's encoder: an existing one-size '_' cell is found for a 'Free Size' catalogue size", () => {
    n = 0;
    const s = firstBatchSplit({ sizes: ["Free Size"], run: { hub2: { "FREE SIZE": 2 }, trophy: { "FREE SIZE": 1 } }, store: "trophy", centralAvail: () => 3 });
    const { updates } = buildFirstBatchSolveUpdate({ pid: "os1", store: "trophy", split: s, existing: { trophy: { _: { qty: 5 } } }, seedCell, nowIso: now, uid: "u1", solveId: "s", newKey });
    expect(Object.keys(updates).filter((k) => k.startsWith("stock/"))).toEqual(["stock/hub2/os1/_"]);   // the stored shop "_" cell is seen, nothing seeded over it; Hub 2 gets its "_" seed
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
    expect(firstBatchEstimate({ split, run: RUN })).toEqual({ shopNow: 3, hubAfter: 5, sizesNow: ["S", "M"], sizesNormal: ["L"], held: [] });
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
    expect(h.byStore.trophy).toMatchObject({ ownRow: false, siblingCells: 2, siblingUnits: 2, categoryCarried: 4 });
    expect(h.byStore["marathon-pe"]).toMatchObject({ ownRow: false, siblingCells: 0, siblingUnits: 0, categoryCarried: 3 });
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

// ── THE FLAG AND THE HUB 2-PRESENCE GUARD (incident 2026-09-17 → Phase 3) ──
describe("the flag: ON with the guard; enabled:false switches the path off; judged strictly", () => {
  const inScope = { source: "central", store: "trophy", product: TEE, routes: ROUTES, hub2Present: false };
  it("FIRST_BATCH_ENABLED is true, and the server twin agrees", () => {
    expect(FIRST_BATCH_ENABLED).toBe(true);
    const req = createRequire(import.meta.url);
    const srv = req("../../../functions/lib/first-batch.cjs");
    expect(srv.FIRST_BATCH_PATH_ENABLED).toBe(FIRST_BATCH_ENABLED);
    expect(srv.PATH_OFF_REASON).toBe("first_batch_path_off");
    expect(srv.HUB2_PRESENT_REASON).toBe("first_batch_hub2_present");
  });
  it("enabled:false / a truthy string → off; the default → on", () => {
    expect(firstBatchEligible(inScope)).toBe(true);
    expect(firstBatchEligible({ ...inScope, enabled: false })).toBe(false);
    expect(firstBatchEligible({ ...inScope, enabled: "true" })).toBe(false);
  });
});

describe("Hub 2 presence — the hard precondition (owner rule: Hub 2 by ANY means → the shop asks Hub 2, never Central)", () => {
  const inScope = { source: "central", store: "trophy", product: TEE, routes: ROUTES };
  const cell = (qty, over = {}) => ({ qty, v: 1, mv: "m", lastType: "received", ...over });
  const ownSeed = { qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedBy: "u1" };
  it("fails CLOSED: unknown or true presence is never eligible; only an explicit false is", () => {
    expect(firstBatchEligible(inScope)).toBe(false);                            // not passed
    expect(firstBatchEligible({ ...inScope, hub2Present: undefined })).toBe(false);
    expect(firstBatchEligible({ ...inScope, hub2Present: null })).toBe(false);
    expect(firstBatchEligible({ ...inScope, hub2Present: true })).toBe(false);
    expect(firstBatchEligible({ ...inScope, hub2Present: 0 })).toBe(false);       // strict
    expect(firstBatchEligible({ ...inScope, hub2Present: false })).toBe(true);
  });
  it("a stock cell of ANY quantity — qty 0 included — is presence (cells are never deleted)", () => {
    expect(hub2PresenceSignals({ hub2Node: { M: cell(3) } })).toEqual(["stock_cell"]);
    expect(hub2PresenceSignals({ hub2Node: { M: cell(0) } })).toEqual(["stock_cell"]);
    expect(hub2PresenceSignals({ hub2Node: { M: { ...ownSeed } } })).toEqual(["stock_cell"]);   // an EARLIER solve's seed
    expect(hub2PresenceSignals({ hub2Node: null })).toEqual([]);
    expect(hub2PresenceSignals({ hub2Node: {} })).toEqual([]);
  });
  it("this Solve's OWN qty-0 seeds (hub2Seeded) are not presence — but a unit in one of them is", () => {
    expect(hub2PresenceSignals({ hub2Node: { M: { ...ownSeed }, L: { ...ownSeed } }, ownSeedKeys: ["M", "L"] })).toEqual([]);
    expect(hub2PresenceSignals({ hub2Node: { M: { ...ownSeed }, L: { ...ownSeed } }, ownSeedKeys: ["M"] })).toEqual(["stock_cell"]);
    expect(hub2PresenceSignals({ hub2Node: { M: { ...ownSeed, qty: 2 } }, ownSeedKeys: ["M"] })).toEqual(["stock_cell"]);
    expect(hub2PresenceSignals({ hub2Node: { M: cell(0) }, ownSeedKeys: ["M"] })).toEqual(["stock_cell"]);   // not a seed shape
  });
  it("an array-coerced Hub 2 row: a hole is nothing, a present index is presence; own seeds by index key", () => {
    expect(hub2PresenceSignals({ hub2Node: [null, null, null] })).toEqual([]);
    expect(hub2PresenceSignals({ hub2Node: [null, null, cell(1)] })).toEqual(["stock_cell"]);
    expect(hub2PresenceSignals({ hub2Node: [null, null, { ...ownSeed }], ownSeedKeys: ["2"] })).toEqual([]);
  });
  it("an engine lock at Hub 2 (a pending inbound) and an open Hub 2 request are presence; an explicit row is NOT (a plan)", () => {
    expect(hub2PresenceSignals({ hub2Locks: { M: { qty: 2, source: "central", runId: "scan-1" } } })).toEqual(["engine_lock"]);
    expect(hub2PresenceSignals({ hub2Locks: { M: null } })).toEqual([]);
    // a lock claimed at/after the request's own createdAt is not PRIOR presence; one before it is
    expect(hub2PresenceSignals({ hub2Locks: { M: { qty: 1, createdAt: "2026-09-17T10:00:00.000Z" } }, sinceIso: "2026-09-17T10:00:00.000Z" })).toEqual([]);
    expect(hub2PresenceSignals({ hub2Locks: { M: { qty: 1, createdAt: "2026-09-17T10:00:05.000Z" } }, sinceIso: "2026-09-17T10:00:00.000Z" })).toEqual([]);
    expect(hub2PresenceSignals({ hub2Locks: { M: { qty: 1, createdAt: "2026-09-17T09:59:59.000Z" } }, sinceIso: "2026-09-17T10:00:00.000Z" })).toEqual(["engine_lock"]);
    expect(hub2PresenceSignals({ hub2Locks: { M: { qty: 1 } }, sinceIso: "2026-09-17T10:00:00.000Z" })).toEqual(["engine_lock"]);   // no createdAt → counts
    expect(hub2PresenceSignals({ hub2OpenRequestIds: ["x"] })).toEqual(["open_hub2_request"]);
    expect(hub2PresenceSignals({ hub2OpenRequestIds: [] })).toEqual([]);
    expect(hub2Present({ hub2Node: { M: cell(1) }, hub2Locks: { M: {} }, hub2OpenRequestIds: ["x"] })).toBe(true);
    expect(hub2Present({})).toBe(false);
  });
  it("a held line in the hold lane for THIS product (units parked at in_transit on the way to Hub 2) is presence; another product's is not; no pid → not judged", () => {
    const held = { rrf_a: { productId: "tee1", dest: "hub2", qty: 2 }, rrf_b: { productId: "other", dest: "hub2", qty: 1 } };
    expect(hub2PresenceSignals({ heldLines: held, pid: "tee1" })).toEqual(["held_inbound"]);
    expect(hub2PresenceSignals({ heldLines: held, pid: "tee9" })).toEqual([]);
    expect(hub2PresenceSignals({ heldLines: held })).toEqual([]);
    expect(hub2PresenceSignals({ heldLines: null, pid: "tee1" })).toEqual([]);
  });
  it("ownSeedAt: a listed own seed must be stamped at the Solve's own time; any other stamp is presence", () => {
    expect(hub2PresenceSignals({ hub2Node: { M: { ...ownSeed, updatedAt: "t1" } }, ownSeedKeys: ["M"], ownSeedAt: "t1" })).toEqual([]);
    expect(hub2PresenceSignals({ hub2Node: { M: { ...ownSeed, updatedAt: "t0" } }, ownSeedKeys: ["M"], ownSeedAt: "t1" })).toEqual(["stock_cell"]);
    expect(hub2PresenceSignals({ hub2Node: { M: { ...ownSeed } }, ownSeedKeys: ["M"], ownSeedAt: "t1" })).toEqual(["stock_cell"]);   // no stamp at all
  });
  it("the server twin computes the SAME signals on the same inputs", () => {
    const req = createRequire(import.meta.url);
    const srv = req("../../../functions/lib/first-batch.cjs");
    const cases = [
      {}, { hub2Node: { M: cell(0) } }, { hub2Node: { M: { ...ownSeed } }, ownSeedKeys: ["M"] }, { hub2Node: [null, cell(1)] },
      { hub2Node: [null, { ...ownSeed }], ownSeedKeys: ["1"] }, { hub2Locks: { M: { qty: 1 } } }, { hub2OpenRequestIds: ["a"] },
      { hub2Node: { M: { ...ownSeed, qty: 1 } }, ownSeedKeys: ["M"] }, { hub2Node: { M: cell(2), L: { ...ownSeed } }, ownSeedKeys: ["L"], hub2Locks: { L: {} } },
      { hub2Locks: { M: { createdAt: "2026-09-17T10:00:01.000Z" } }, sinceIso: "2026-09-17T10:00:00.000Z" }, { hub2Locks: { M: { createdAt: "2026-09-17T09:00:00.000Z" } }, sinceIso: "2026-09-17T10:00:00.000Z" },
      { heldLines: { a: { productId: "p" } }, pid: "p" }, { heldLines: { a: { productId: "q" } }, pid: "p" }, { hub2Node: { M: { ...ownSeed, updatedAt: "t0" } }, ownSeedKeys: ["M"], ownSeedAt: "t1" },
    ];
    for (const c of cases) expect(srv.hub2PresenceSignals(c), JSON.stringify(c)).toEqual(hub2PresenceSignals(c));
  });
});

// ── SCOPE PINNED AGAINST THE LIVE CATALOGUE (read 2026-09-17 21:2xZ) ────────
// Every effective category key with at least one product live today, and the
// live categoryPolicy key list. The rule is the owner's: every category except
// sneakers and slides. Mapped categories (bags, belts, caps-beanies,
// fitted-caps, gloves, perfumes, soccer-jerseys, sunglasses, underwear), the
// one-size ones, keyless clothing and typeless records are all IN; the two
// footwear keys are OUT whatever the productType says. (The footwear group
// beyond those two — boots, soccer-boots, loafers, running-shoes, kids-shoes,
// designer-shoes — never reaches this Solve: the Missing Products tab owns
// the complement of that group.)
describe("scope pinned against the live catalogue: every category except sneakers and slides", () => {
  const LIVE_KEYS_2026_09_17 = ["t-shirts", "bags", "caps-beanies", "pants", "tracksuits", "soccer-jerseys", "golf-t-shirts", "hoodies", "fitted-caps", "jackets",
    "perfumes", "shorts", "suits", "watches", "baseball-shirts", "ladies-tracksuits", "underwear", "shirts", "belts", "sunglasses", "dresses", "packaging",
    "basketball-vests", "visors", "gloves", "chains-bracelets", "sneakers", "slides"];
  const LIVE_POLICY_KEYS_2026_09_17 = ["bags", "belts", "caps-beanies", "fitted-caps", "gloves", "perfumes", "slides", "sneakers", "soccer-jerseys", "sunglasses", "underwear"];
  const base = { source: "central", store: "trophy", routes: ROUTES, hub2Present: false };
  it("every live key except sneakers and slides is eligible; those two never are — with or without a clothing productType", () => {
    for (const key of LIVE_KEYS_2026_09_17) {
      const expected = !["sneakers", "slides"].includes(key);
      expect(firstBatchEligible({ ...base, product: { id: `p_${key}`, name: key, categoryKey: key, sizes: ["_"] } }), key).toBe(expected);
      expect(firstBatchEligible({ ...base, product: { id: `q_${key}`, name: key, productType: "clothing", categoryKey: key, sizes: ["M"] } }), `${key} (clothing)`).toBe(expected);
    }
  });
  it("every live policy (mapped) key is on the path except the two footwear keys", () => {
    for (const key of LIVE_POLICY_KEYS_2026_09_17) {
      expect(firstBatchEligible({ ...base, product: { id: `m_${key}`, name: key, categoryKey: key, sizes: ["_"] } }), key).toBe(!["sneakers", "slides"].includes(key));
    }
  });
  it("the exclusion is by the engine's own category identity: a keyless legacy sneaker and a keyless legacy slide are out; keyless clothing and a typeless keyless record are in", () => {
    expect(firstBatchEligible({ ...base, product: { id: "k1", name: "Air Force", category: "Footwear", subcategory: "Sneakers", sizes: ["8"] } })).toBe(false);
    expect(firstBatchEligible({ ...base, product: { id: "k2", name: "Arizona", category: "Footwear", subcategory: "Sandals & Slides", sizes: ["8"] } })).toBe(false);
    expect(firstBatchEligible({ ...base, product: { id: "k3", name: "Tee", productType: "clothing", sizes: ["M"] } })).toBe(true);
    expect(firstBatchEligible({ ...base, product: { id: "k4", name: "Phone case", sizes: ["_"] } })).toBe(true);
  });
  it("the split works for a one-size product exactly as for a sized one (the '_' key end to end)", () => {
    const s = firstBatchSplit({ sizes: ["_"], run: { hub2: { _: 4 }, trophy: { _: 2 } }, store: "trophy", centralAvail: () => 10 });
    expect(s.firstBatch).toEqual([{ size: "_", qty: 2, target: 2, avail: 10 }]);
    let n = 0;
    const { updates } = buildFirstBatchSolveUpdate({ pid: "bag1", store: "trophy", split: s, existing: {}, seedCell: () => ({ qty: 0 }), nowIso: "t", uid: "u", solveId: "s", newKey: () => `k${++n}` });
    expect(Object.keys(updates).sort()).toEqual(["refill_requests/k1", "stock/hub2/bag1/_", "stock/trophy/bag1/_"]);
    expect(updates["refill_requests/k1"]).toMatchObject({ size: "_", qty: 2, createdFrom: { hub2Seeded: ["_"] } });
  });
});

// ── LOCATION HISTORY INFORMS THE SPLIT (Phase 3, Commit 6) ───────────────────
describe("location history informs the shop / Hub 2 split — per SIZE, never the quantity", () => {
  const cell = (qty) => ({ qty, v: 1, mv: "m" });
  const key = (id, extra = {}) => ({ id, name: id, productType: "clothing", categoryKey: "t-shirts", sizes: ["S", "M", "XXXL"], ...extra });
  // Trophy keeps 12 t-shirt lines: all carry S and M, NONE carries XXXL. PE keeps 3 (below the floor).
  const products = [key("card"), ...Array.from({ length: 12 }, (_, i) => key(`t${i}`)), ...Array.from({ length: 3 }, (_, i) => key(`pe${i}`))];
  const allStock = {
    central: { card: { S: cell(4), M: cell(4), XXXL: cell(4) } },
    trophy: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`t${i}`, { S: cell(1), M: cell(0) }])),
    "marathon-pe": Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`pe${i}`, { S: cell(1) }])),
  };
  const index = buildPlacementIndex({ products, allStock });
  const hist = firstBatchHistory({ pid: "card", product: products[0], index, allStock, targets: null });
  const RUN = { trophy: { S: 2, M: 2, XXXL: 1 }, "marathon-pe": { S: 2, M: 2, XXXL: 1 }, hub2: { S: 2, M: 3, XXXL: 1 } };

  it("the index counts, per category and shop, how many lines carry each size (array-coerced rows and holes included)", () => {
    expect(index.bySize["t-shirts"].trophy).toEqual({ S: 12, M: 12 });
    expect(index.bySize["t-shirts"]["marathon-pe"]).toEqual({ S: 3 });
    const idx2 = buildPlacementIndex({ products: [key("a", { sizes: ["7", "8"] })], allStock: { trophy: { a: [null, null, null, null, null, null, null, cell(1), null, cell(0)] } } });
    expect(idx2.bySize["t-shirts"].trophy).toEqual({ 7: 1, 9: 1 });
    expect(hist.byStore.trophy.sizeCarried).toEqual({ S: 12, M: 12 });
  });
  it("Trophy (12 lines, none with XXXL): XXXL stays at Hub 2 first with the sentence; S and M go first", () => {
    const hints = firstBatchSizeHints({ history: hist, store: "trophy", sizes: ["S", "M", "XXXL"], labels: { trophy: "Trophy" } });
    expect(hints.S).toEqual({ to: "shop", why: null });
    expect(hints.M).toEqual({ to: "shop", why: null });
    expect(hints.XXXL.to).toBe("hub");
    expect(hints.XXXL.why).toBe("XXXL stays at Hub 2 first — none of the 12 t-shirts lines at Trophy carries XXXL; the engine sends it to Trophy from Hub 2 when needed.");
    const split = firstBatchSplit({ sizes: ["S", "M", "XXXL"], run: RUN, store: "trophy", centralAvail: () => 4, sizeHints: hints });
    expect(split.firstBatch.map((l) => l.size)).toEqual(["S", "M"]);
    expect(split.normal).toEqual(["XXXL"]);
    expect(split.held).toEqual([{ size: "XXXL", why: hints.XXXL.why }]);
    const est = firstBatchEstimate({ split, run: RUN });
    expect(est.sizesNormal).toEqual([]);            // held sizes are not "Central has none"
    expect(est.held).toHaveLength(1);
    expect(est.shopNow).toBe(4);
  });
  it("below the floor (PE keeps 3 lines) history has no say: every size Central can send goes first", () => {
    const hints = firstBatchSizeHints({ history: hist, store: "marathon-pe", sizes: ["S", "M", "XXXL"] });
    expect(Object.values(hints).every((h) => h.to === "shop")).toBe(true);
    const split = firstBatchSplit({ sizes: ["S", "M", "XXXL"], run: RUN, store: "marathon-pe", centralAvail: () => 4, sizeHints: hints });
    expect(split.firstBatch.map((l) => l.size)).toEqual(["S", "M", "XXXL"]);
    expect(split.held).toEqual([]);
  });
  it("the floor is exactly MIN_LINES_FOR_SIZE_HINT (10): 9 lines → no say, 10 → a say", () => {
    const mk = (n) => {
      const ps = [key("card"), ...Array.from({ length: n }, (_, i) => key(`t${i}`))];
      const st = { central: { card: { S: cell(1), XXXL: cell(1) } }, trophy: Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, { S: cell(1) }])) };
      const ix = buildPlacementIndex({ products: ps, allStock: st });
      return firstBatchHistory({ pid: "card", product: ps[0], index: ix, allStock: st, targets: null });
    };
    expect(firstBatchSizeHints({ history: mk(9), store: "trophy", sizes: ["XXXL"] }).XXXL.to).toBe("shop");
    expect(firstBatchSizeHints({ history: mk(10), store: "trophy", sizes: ["XXXL"] }).XXXL.to).toBe("hub");
  });
  it("colourway siblings at the shop outrank the category: the sibling carries XXXL at Trophy → XXXL goes first; the sibling lacks M → M stays", () => {
    const ps = [key("card", { styleCodeNormalised: "AB1" }), key("sib", { styleCodeNormalised: "AB1" }), ...Array.from({ length: 12 }, (_, i) => key(`t${i}`))];
    const st = { ...allStock, trophy: { ...allStock.trophy, sib: { S: cell(1), XXXL: cell(2) } } };
    const ix = buildPlacementIndex({ products: ps, allStock: st });
    const h = firstBatchHistory({ pid: "card", product: ps[0], index: ix, allStock: st, targets: null });
    expect(h.byStore.trophy.siblingSizes).toEqual({ S: 1, XXXL: 1 });
    const hints = firstBatchSizeHints({ history: h, store: "trophy", sizes: ["S", "M", "XXXL"], labels: { trophy: "Trophy" } });
    expect(hints.XXXL.to).toBe("shop");
    expect(hints.M.to).toBe("hub");
    expect(hints.M.why).toBe("M stays at Hub 2 first — the colourway sibling at Trophy carries no M; the engine sends it to Trophy from Hub 2 when needed.");
  });
  it("a hint never ADDS a size: a size Central has none of stays normal (not held), and a hint for an unknown size is ignored", () => {
    const hints = firstBatchSizeHints({ history: hist, store: "trophy", sizes: ["S", "XXXL"] });
    const split = firstBatchSplit({ sizes: ["S", "M", "XXXL"], run: RUN, store: "trophy", centralAvail: (sz) => (sz === "S" ? 0 : 4), sizeHints: hints });
    expect(split.firstBatch.map((l) => l.size)).toEqual(["M"]);
    expect(split.normal).toEqual(["S", "XXXL"]);
    expect(split.held).toEqual([{ size: "XXXL", why: hints.XXXL.why }]);
  });
  it("one-size: '_' hints by the '_' cell key and speaks as 'One size'", () => {
    const ps = [{ id: "bag", name: "bag", categoryKey: "bags", sizes: ["_"] }, ...Array.from({ length: 11 }, (_, i) => ({ id: `b${i}`, name: `b${i}`, categoryKey: "bags", sizes: ["M"] }))];
    const st = { central: { bag: { _: cell(3) } }, trophy: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`b${i}`, { M: cell(1) }])) };
    const ix = buildPlacementIndex({ products: ps, allStock: st });
    const h = firstBatchHistory({ pid: "bag", product: ps[0], index: ix, allStock: st, targets: null });
    const hints = firstBatchSizeHints({ history: h, store: "trophy", sizes: ["_"], labels: { trophy: "Trophy" } });
    expect(hints._.to).toBe("hub");
    expect(hints._.why).toMatch(/^One size stays at Hub 2 first — none of the 11 bags lines at Trophy carries one-size;/);
    st.trophy.b0 = { _: cell(1) };
    const h2 = firstBatchHistory({ pid: "bag", product: ps[0], index: buildPlacementIndex({ products: ps, allStock: st }), allStock: st, targets: null });
    expect(firstBatchSizeHints({ history: h2, store: "trophy", sizes: ["_"] })._.to).toBe("shop");
  });
  it("the hint looks cells up by the STORED size key: a '5.5' card is matched to the lines' '5_5' cells, and 'Free Size' to '_'", () => {
    const belt = (id, extra = {}) => ({ id, name: id, categoryKey: "belts", sizes: ["5.5"], ...extra });
    const ps = [belt("card"), ...Array.from({ length: 11 }, (_, i) => belt(`b${i}`))];
    const st = { central: { card: { "5_5": cell(2) } }, trophy: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`b${i}`, { "5_5": cell(1) }])) };
    const h = firstBatchHistory({ pid: "card", product: ps[0], index: buildPlacementIndex({ products: ps, allStock: st }), allStock: st, targets: null });
    expect(firstBatchSizeHints({ history: h, store: "trophy", sizes: ["5.5"] })["5.5"].to).toBe("shop");
    expect(firstBatchSizeHints({ history: h, store: "trophy", sizes: ["6"] })["6"].to).toBe("hub");
    const cap = (id) => ({ id, name: id, categoryKey: "caps-beanies", sizes: ["Free Size"] });
    const ps2 = [cap("c"), ...Array.from({ length: 10 }, (_, i) => cap(`k${i}`))];
    const st2 = { central: { c: { _: cell(2) } }, "marathon-pe": Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, { _: cell(1) }])) };
    const h2 = firstBatchHistory({ pid: "c", product: ps2[0], index: buildPlacementIndex({ products: ps2, allStock: st2 }), allStock: st2, targets: null });
    expect(firstBatchSizeHints({ history: h2, store: "marathon-pe", sizes: ["Free Size"] })["Free Size"].to).toBe("shop");
  });
  it("no history at all → no hints, and the split is byte-for-byte the un-hinted one", () => {
    const h = firstBatchHistory({ pid: "card", product: key("card"), index: buildPlacementIndex({ products: [key("card")], allStock: { central: allStock.central } }), allStock: { central: allStock.central }, targets: null });
    const hints = firstBatchSizeHints({ history: h, store: "trophy", sizes: ["S", "M", "XXXL"] });
    const a = firstBatchSplit({ sizes: ["S", "M", "XXXL"], run: RUN, store: "trophy", centralAvail: () => 4, sizeHints: hints });
    const b = firstBatchSplit({ sizes: ["S", "M", "XXXL"], run: RUN, store: "trophy", centralAvail: () => 4 });
    expect(a).toEqual(b);
    expect(a.held).toEqual([]);
  });
});
