import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { soldPairEntries, computeRestockCounts } from "../../utils/insights";
import { pendingSaleRows } from "./refillQueueCore";
import { capSaleRowsToPolicy, policyKeepFor } from "./saleRowPolicyCap";

// Junid's rules (24 Oct 2026): stock leaves a location only through a SALE;
// a request is raised only by the scan comparing on hand against policy.
// "Replace what sold" counts pairs sold, never times an order was marked
// ready, and a duplicate or re-placed order can never raise a line.

const JUNID = { 3: 2, 4: 2, 5: 2, "5_5": 2, 6: 3, 7: 3, 8: 3, 9: 2, 10: 2, 11: 2, 12: 2, 13: 2 };
const sizes = () => Object.fromEntries(Object.entries(JUNID).map(([k, t]) => [k, { target: t, minQty: Math.ceil(t / 2), reorderPoint: 1 }]));
const CONFIG = { policyGroups: { "footwear-all": {
  armed: true, label: "Footwear",
  memberCategoryKeys: ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers", "soccer-boots"],
  policy: { perSize: true, hub1: { carriedOnly: true, sizes: sizes() }, hub2: { carriedOnly: true, sizes: sizes() } },
} } };
const AJ1 = { id: "pCraft", name: "Air Jordan 1 SE Craft Tech Grey", categoryKey: "sneakers", category: "Footwear", sizes: ["7", "8", "9", "10", "11"] };
const MOCHA = { id: "pMocha", name: "Air Jordan 1 Retro High Travis Scott Mocha", categoryKey: "sneakers", category: "Footwear", sizes: ["8", "9", "10"] };

describe("soldPairEntries — one sale = at most one line per pair", () => {
  const order = (n, extra = {}) => ({ saleId: "-S1", orderNumber: n, productId: "pCraft", size: "9", hub: "hub2", source: "pos", ...extra });
  const walk = () => ({ saleId: "-S2", orderNumber: null, productId: "pCraft", size: "9", hub: "hub2", source: "pos_walkin" });
  it("a double-written order row counts once", () => {
    expect(soldPairEntries([order("051"), order("051")])).toHaveLength(1);
  });
  it("a double-written order row with no sale id counts once too", () => {
    expect(soldPairEntries([order("051", { saleId: null }), order("051", { saleId: null })])).toHaveLength(1);
  });
  it("two orders in one sale are two pairs", () => {
    expect(soldPairEntries([order("051"), order("052")])).toHaveLength(2);
  });
  it("a walk-in of two identical pairs is two pairs (the POS writes one row per unit)", () => {
    expect(soldPairEntries([walk(), walk()])).toHaveLength(2);
  });
});

describe("REPLAY — Mike's 23 Oct triple order at Hub 2", () => {
  // Three rounds of the same order were placed and marked READY (08:54, 09:37,
  // 11:28 SAST). Readies are not sales: the POS log only ever saw ONE sale of
  // the pairs. The rows below are what /restock_log holds for that day.
  const posRows = [
    ...["7", "8", "9", "10", "11"].map((s) => ({ saleId: "-SALE", orderNumber: null, productId: "pCraft", productName: AJ1.name, size: s, hub: "hub2", source: "pos_walkin" })),
    ...["8", "9", "10"].map((s) => ({ saleId: "-SALE", orderNumber: null, productId: "pMocha", productName: MOCHA.name, size: s, hub: "hub2", source: "pos_walkin" })),
  ];
  const day = "2026-10-23";
  const rows = pendingSaleRows({
    counts: computeRestockCounts(soldPairEntries(posRows)),
    responses: {}, progress: {}, date: day, tsBySize: null,
    fallbackMs: Date.parse(`${day}T00:00:00Z`) - 2 * 3600e3,
  });

  it("counts ONE pair per size — the sale — never ×3 for three readies", () => {
    const q = Object.fromEntries(rows.map((r) => [`${r.productId}:${r.size}`, r.qty]));
    expect(q).toEqual({ "pCraft:7": 1, "pCraft:8": 1, "pCraft:9": 1, "pCraft:10": 1, "pCraft:11": 1, "pMocha:8": 1, "pMocha:9": 1, "pMocha:10": 1 });
  });

  it("and under Junid's policy the scan owns every one of those cells: nothing is pickable", () => {
    const ctx = { config: CONFIG, productsById: new Map([[AJ1.id, AJ1], [MOCHA.id, MOCHA]]),
      destCells: { pCraft: { 7: { qty: 6 }, 8: { qty: 3 }, 9: { qty: 4 }, 10: { qty: 2 }, 11: { qty: 1 } }, pMocha: { 8: { qty: 2 }, 9: { qty: 1 }, 10: { qty: 2 } } } };
    const { rows: pick, covered } = capSaleRowsToPolicy(rows, {
      destCells: ctx.destCells, scanOnly: true, keepFor: (pid, size) => policyKeepFor(ctx, "hub2", pid, size),
    });
    expect(pick).toEqual([]);
    expect(covered).toHaveLength(rows.length);
    expect(covered.every((r) => r.policyCap.scan === true)).toBe(true);
  });

  it("with sale-raised requests OFF, a product with no policy asks nothing either", () => {
    const tee = [{ saleId: "-T", orderNumber: "090", productId: "pNoPolicy", productName: "x", size: "9", hub: "hub2" }];
    const r = pendingSaleRows({ counts: computeRestockCounts(soldPairEntries(tee)), responses: {}, progress: {}, date: day, fallbackMs: 0 });
    const { rows: pick, covered } = capSaleRowsToPolicy(r, { scanOnly: true, salesRaiseNothing: true, keepFor: () => null });
    expect(pick).toEqual([]);
    expect(covered).toHaveLength(1);
    expect(covered[0].policyCap).toMatchObject({ keep: null, scan: true });
  });

  it("a pid-less legacy sale row is covered too, never dropped", () => {
    const legacy = [{ origin: "sale", rowKey: "sale:d:legacy:9", productId: null, size: "9", qty: 1, sent: 0, createdMs: 0 }];
    const { rows: pick, covered } = capSaleRowsToPolicy(legacy, { salesRaiseNothing: true, keepFor: () => null });
    expect(pick).toEqual([]);
    expect(covered).toHaveLength(1);
  });

  it("(switch back on) a product with no policy gets its sold pair replaced, once", () => {
    const tee = [{ saleId: "-T", orderNumber: "090", productId: "pNoPolicy", productName: "x", size: "9", hub: "hub2" },
                 { saleId: "-T", orderNumber: "090", productId: "pNoPolicy", productName: "x", size: "9", hub: "hub2" }];
    const r = pendingSaleRows({ counts: computeRestockCounts(soldPairEntries(tee)), responses: {}, progress: {}, date: day, fallbackMs: 0 });
    const { rows: pick } = capSaleRowsToPolicy(r, { scanOnly: true, keepFor: () => null });
    expect(pick.map((x) => x.qty)).toEqual([1]);
  });
});

describe("the queue never counts readies again (source pin)", () => {
  const app = readFileSync(new URL("../../App.jsx", import.meta.url), "utf8");
  it("App.jsx builds no sale row from insights 'ready' events", () => {
    expect(app).not.toMatch(/restockCountsFromLog\s*\(/);
  });
  it("every sale-row builder goes through soldPairEntries", () => {
    expect((app.match(/computeRestockCounts\(soldEntriesFor\(/g) || []).length).toBe(4);
  });
  it("the queue passes scanOnly and the switch", () => {
    const q = readFileSync(new URL("./RefillQueue.jsx", import.meta.url), "utf8");
    expect(q).toMatch(/scanOnly:\s*true/);
    expect(q).toMatch(/salesRaiseNothing:\s*!SALE_RAISED_REQUESTS/);
  });
  it("sale-raised requests are OFF", async () => {
    const { SALE_RAISED_REQUESTS } = await import("../../config/saleRaisedRequests");
    expect(SALE_RAISED_REQUESTS).toBe(false);
  });
});
