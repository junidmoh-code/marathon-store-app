// ─── firstBatchCore — scope, the per-size split, the atomic write, the undo ──
// Pure functions, called for real. The scope tests are the load-bearing ones:
// each "out of scope" row is a Solve that must stay byte-for-byte the old path.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import {
  FIRST_BATCH_HUB, FIRST_BATCH_RUN_PREFIX, SOLVE_UNDONE_REASON, firstBatchRunId, solveIdFor,
  firstBatchEligible, firstBatchSplit, buildFirstBatchSolveUpdate,
  firstBatchUndoBlockers, firstBatchUndoCancelUpdate, firstBatchEstimate,
} from "./firstBatchCore.js";

const ROUTES = { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" };
const TEE = { id: "tee1", name: "Essentials Tee", productType: "clothing", sizes: ["S", "M", "L"] };
const BAG = { id: "bag1", name: "Gym Bag", productType: "clothing", categoryKey: "bags", sizes: ["_"] };
const PERFUME = { id: "pf1", name: "Sauvage", categoryKey: "perfumes", sizes: ["_"] };
const SNEAKER = { id: "sn1", name: "Air Max", category: "Footwear", sizes: ["8"] };
const POLICY = {
  bags: { hub2: { target: 4, minQty: 2 }, trophy: { target: 2, minQty: 1 } },
  slides: { hub2: { carriedOnly: true, sizes: { 8: { target: 3 } } }, perSize: true },
};
const RUN = { hub2: { S: 2, M: 3, L: 3 }, trophy: { S: 2, M: 2, L: 2 }, "marathon-pe": { S: 2, M: 2, L: 1 } };

describe("scope — which Solve routes shop quantities through Hub 2", () => {
  const base = { source: "central", store: "trophy", product: TEE, routes: ROUTES, categoryPolicy: POLICY, targets: {} };
  it("IN: a Central-stranded clothing product, shop routed via Hub 2, unmapped, no explicit Hub 2 row", () => {
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
  it("OUT: a mapped category whose Hub 2 leg is unscoped — the engine already asks with no Solve", () => {
    expect(firstBatchEligible({ ...base, product: BAG })).toBe(false);
  });
  it("IN: a mapped category whose Hub 2 leg is carriedOnly still needs the cell", () => {
    const slide = { ...TEE, categoryKey: "slides" };
    expect(firstBatchEligible({ ...base, product: slide })).toBe(true);
  });
  it("OUT: perfume and sneakers — not clothing in the engine's sense", () => {
    expect(firstBatchEligible({ ...base, product: PERFUME })).toBe(false);
    expect(firstBatchEligible({ ...base, product: SNEAKER })).toBe(false);
    expect(firstBatchEligible({ ...base, product: null })).toBe(false);
  });
  it("OUT: an explicit /stock_targets row at Hub 2 — the engine manages Hub 2 for it regardless of a cell", () => {
    expect(firstBatchEligible({ ...base, targets: { hub2: { tee1: { M: { target: 5 } } } } })).toBe(false);
    // another product's row is not this product's row
    expect(firstBatchEligible({ ...base, targets: { hub2: { other: { M: { target: 5 } } } } })).toBe(true);
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
  it("undo is blocked once Central has sent, answered or partially sent; a vanished row is not a blocker", () => {
    expect(firstBatchUndoBlockers({ liveRequests: { a: { status: "open", size: "M" }, b: null } })).toEqual([]);
    expect(firstBatchUndoBlockers({ liveRequests: { a: { status: "fulfilled", size: "M" } }, storeLabel: "Trophy" })[0]).toMatch(/already sent/);
    expect(firstBatchUndoBlockers({ liveRequests: { a: { status: "cancelled", size: "M" } } })[0]).toMatch(/answered/);
    expect(firstBatchUndoBlockers({ liveRequests: { a: { status: "open", sentQty: 1, size: "L" } } })[0]).toMatch(/started sending size L/);
  });
  it("the undo cancels WITH the solve_undone reason (an engine-style withdrawal, and the trigger's no-leg signal)", () => {
    const upd = firstBatchUndoCancelUpdate({ requestIds: ["a", "b"], nowIso: "t", uid: "u1" });
    expect(upd["refill_requests/a/status"]).toBe("cancelled");
    expect(upd["refill_requests/a/cancelReason"]).toBe(SOLVE_UNDONE_REASON);
    expect(upd["refill_requests/b/resolvedAt"]).toBe("t");
    expect(upd["refill_requests/b/resolvedBy"]).toBe("u1");
    expect("refill_requests/a/resolvedBy" in firstBatchUndoCancelUpdate({ requestIds: ["a"], nowIso: "t", uid: null })).toBe(false);
  });
  it("the panel estimate: shop units now, Hub 2's policy units after", () => {
    const split = firstBatchSplit({ sizes: ["S", "M", "L"], run: RUN, store: "trophy", centralAvail: (s) => ({ S: 4, M: 1, L: 0 })[s] });
    expect(firstBatchEstimate({ split, run: RUN })).toEqual({ shopNow: 3, hubAfter: 5, sizesNow: ["S", "M"], sizesNormal: ["L"] });
  });
});

describe("the CJS twin in functions/lib/first-batch.cjs speaks the same constants", () => {
  it("hub, run prefix and undo reason are identical on both sides", () => {
    const require = createRequire(import.meta.url);
    const fb = require("../../../functions/lib/first-batch.cjs");
    expect(fb.FIRST_BATCH_HUB).toBe(FIRST_BATCH_HUB);
    expect(fb.FIRST_BATCH_RUN_PREFIX).toBe(FIRST_BATCH_RUN_PREFIX);
    expect(fb.SOLVE_UNDONE_REASON).toBe(SOLVE_UNDONE_REASON);
    expect(fb.firstBatchRunId("x")).toBe(firstBatchRunId("x"));
  });
});
