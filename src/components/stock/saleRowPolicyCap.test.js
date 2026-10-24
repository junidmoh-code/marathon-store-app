import { describe, it, expect } from "vitest";
import { policyKeepFor, capSaleRowsToPolicy } from "./saleRowPolicyCap";

// Junid's standing hub sneaker policy, in the exact live shape of
// /config/refillEngine/policyGroups/footwear-all (5.5 stored "5_5").
const JUNID = { 3: 2, 4: 2, 5: 2, "5_5": 2, 6: 3, 7: 3, 8: 3, 9: 2, 10: 2, 11: 2, 12: 2, 13: 2 };
const sizesMap = () => Object.fromEntries(Object.entries(JUNID).map(([k, t]) => [k, { target: t, minQty: Math.ceil(t / 2), reorderPoint: 1 }]));
const CONFIG = {
  policyGroups: {
    "footwear-all": {
      armed: true, label: "Footwear",
      memberCategoryKeys: ["boots", "designer-shoes", "kids-shoes", "loafers", "running-shoes", "slides", "sneakers", "soccer-boots"],
      policy: { perSize: true, hub1: { carriedOnly: true, sizes: sizesMap() }, hub2: { carriedOnly: true, sizes: sizesMap() } },
    },
  },
};
const AJ1 = { id: "pAJ1", name: "Air Jordan 1 SE Craft Tech Grey", categoryKey: "sneakers", category: "Footwear",
  sizes: ["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11", "12", "13"] };
const TEE = { id: "pTee", name: "Tee", categoryKey: "mens-tshirts", category: "Clothing", productType: "clothing", sizes: ["S", "M", "L"] };

const cellsOf = (m) => Object.fromEntries(Object.entries(m).map(([s, q]) => [s, { qty: q }]));
const ctxFor = ({ cells = {}, explicitRows = null, products = [AJ1, TEE], config = CONFIG } = {}) => ({
  config,
  productsById: new Map(products.map((p) => [p.id, p])),
  destCells: cells,
  explicitRows,
});
const row = (pid, size, qty, { sent = 0, date = "2026-10-23", createdMs = Date.parse("2026-10-22T22:00:00Z") } = {}) => ({
  origin: "sale", rowKey: `sale:${date}:${pid}:${size}`, date, key: pid, productId: pid, size: String(size), qty, sent, createdMs,
});
const capWith = (ctx, rows, requests = []) =>
  capSaleRowsToPolicy(rows, { requests, destCells: ctx.destCells, keepFor: (pid, size) => policyKeepFor(ctx, "hub2", pid, size) });

describe("policyKeepFor — Junid's per-size map, armed", () => {
  // The hub needs a cell for carriedOnly; one zero cell is enough.
  const ctx = ctxFor({ cells: { pAJ1: cellsOf({ 7: 0 }) } });
  it("sizes 9–13 resolve to 2", () => {
    for (const s of ["9", "10", "11", "12", "13"]) expect(policyKeepFor(ctx, "hub2", "pAJ1", s)).toBe(2);
  });
  it("sizes 6–8 resolve to 3", () => {
    for (const s of ["6", "7", "8"]) expect(policyKeepFor(ctx, "hub2", "pAJ1", s)).toBe(3);
  });
  it("sizes 3, 4, 5 and 5.5 resolve to 2 (half size through its encoded key)", () => {
    for (const s of ["3", "4", "5", "5.5"]) expect(policyKeepFor(ctx, "hub2", "pAJ1", s)).toBe(2);
  });
  it("Hub 1 resolves the same numbers", () => {
    // destCells are the cells of the hub asked about; none → carriedOnly gate.
    expect(policyKeepFor({ ...ctx, destCells: {} }, "hub1", "pAJ1", "9")).toBeNull();
    const h1 = { ...ctx, destCells: { pAJ1: cellsOf({ 9: 0 }) } };
    expect(policyKeepFor(h1, "hub1", "pAJ1", "9")).toBe(2);
    expect(policyKeepFor(h1, "hub1", "pAJ1", "7")).toBe(3);
  });
  it("a hub cell sold to zero is NOT a dead size — the sale row proves the size exists", () => {
    const zero = ctxFor({ cells: { pAJ1: cellsOf({ 9: 0, 7: 0 }) } });
    expect(policyKeepFor(zero, "hub2", "pAJ1", "9")).toBe(2);
  });
  it("an explicit row wins over the group, and an explicit 0 is a decision", () => {
    const ex = ctxFor({ cells: { pAJ1: cellsOf({ 9: 1 }) }, explicitRows: { pAJ1: { 9: { target: 3, minQty: 2 }, 10: { target: 0, minQty: 0 } } } });
    expect(policyKeepFor(ex, "hub2", "pAJ1", "9")).toBe(3);
    expect(policyKeepFor(ex, "hub2", "pAJ1", "10")).toBe(0);
    expect(policyKeepFor(ex, "hub2", "pAJ1", "11")).toBe(2);
  });
  it("no keep for clothing, an unknown product, a disarmed group, or a size the map does not name", () => {
    const c = ctxFor({ cells: { pAJ1: cellsOf({ 7: 0 }), pTee: cellsOf({ M: 1 }) } });
    expect(policyKeepFor(c, "hub2", "pTee", "M")).toBeNull();
    expect(policyKeepFor(c, "hub2", "pNope", "9")).toBeNull();
    expect(policyKeepFor({ ...c, config: { policyGroups: { "footwear-all": { ...CONFIG.policyGroups["footwear-all"], armed: false } } } }, "hub2", "pAJ1", "9")).toBeNull();
    expect(policyKeepFor({ ...c, productsById: new Map([["pAJ1", { ...AJ1, sizes: [...AJ1.sizes, "14"] }]]) }, "hub2", "pAJ1", "14")).toBeNull();
  });
  it("RTDB drops an empty size map — a location entry with NO sizes child arms nothing", () => {
    // Real RTDB never stores `sizes: {}`; writing it deletes the key. The fake
    // must look like what a reader actually gets back: the key is absent.
    const g = CONFIG.policyGroups["footwear-all"];
    const cfg = { policyGroups: { "footwear-all": { ...g, policy: { perSize: true, hub2: { carriedOnly: true } } } } };
    expect(policyKeepFor({ ...ctx, config: cfg }, "hub2", "pAJ1", "9")).toBeNull();
  });
  it("designer-shoes is a group member even though the POS footwear list omits it", () => {
    const d = { ...AJ1, id: "pD", categoryKey: "designer-shoes" };
    const c = ctxFor({ cells: { pD: cellsOf({ 9: 0 }) }, products: [d] });
    expect(policyKeepFor(c, "hub2", "pD", "9")).toBe(2);
  });
});

describe("capSaleRowsToPolicy — the 23 Oct incident", () => {
  // One order, placed and marked ready three times: ×3 on every size. Hub 2's
  // shelf after the single real POS sale.
  const cells = { pAJ1: cellsOf({ 7: 6, 8: 3, 9: 4, 10: 2, 11: 1 }) };
  const ctx = ctxFor({ cells });
  const rows = ["7", "8", "9", "10", "11"].map((s) => row("pAJ1", s, 3));

  it("never asks past keep − on hand", () => {
    const { rows: out, covered } = capWith(ctx, rows);
    const q = Object.fromEntries(out.map((r) => [r.size, r.qty]));
    // 7: keep 3, 6 on hand → 0.  8: 3−3 → 0.  9: 2−4 → 0.  10: 2−2 → 0.  11: 2−1 → 1.
    expect(q).toEqual({ 11: 1 });
    expect(covered.map((r) => r.size).sort()).toEqual(["10", "7", "8", "9"]);
    expect(covered.find((r) => r.size === "9").policyCap).toEqual({ asked: 3, keep: 2, onHand: 4, inbound: 0 });
  });

  it("an empty shelf asks the keep, not the event count: ×3 on size 9 becomes ×2, on size 7 stays ×3", () => {
    const empty = ctxFor({ cells: { pAJ1: cellsOf({ 7: 0, 9: 0 }) } });
    const { rows: out } = capWith(empty, [row("pAJ1", "9", 3), row("pAJ1", "7", 3)]);
    expect(out.find((r) => r.size === "9").qty).toBe(2);
    expect(out.find((r) => r.size === "7").qty).toBe(3);
    expect(out.find((r) => r.size === "7").policyCap).toBeUndefined();   // untouched, not merely equal
  });

  it("open requests for the cell count as inbound", () => {
    const empty = ctxFor({ cells: { pAJ1: cellsOf({ 9: 0 }) } });
    const { rows: out, covered } = capWith(empty, [row("pAJ1", "9", 3)], [{ productId: "pAJ1", size: "9", qty: 2, sent: 0 }]);
    expect(out).toEqual([]);
    expect(covered[0].policyCap.inbound).toBe(2);
  });

  it("a partly-sent open request counts its REMAINDER (qty) as inbound, not qty − sent", () => {
    const empty = ctxFor({ cells: { pAJ1: cellsOf({ 9: 0 }) } });
    // keep 2, nothing on hand, a request with 2 still to come (1 already sent) → room 0.
    const { rows: out, covered } = capWith(empty, [row("pAJ1", "9", 3)], [{ productId: "pAJ1", size: "9", qty: 2, sent: 1 }]);
    expect(out).toEqual([]);
    expect(covered[0].policyCap.inbound).toBe(2);
  });

  it("units already sent are never taken back — the cap applies to what is left", () => {
    const empty = ctxFor({ cells: { pAJ1: cellsOf({ 9: 1 }) } });
    const { rows: out } = capWith(empty, [row("pAJ1", "9", 3, { sent: 1 })]);
    // room = 2 − 1 = 1; one already sent, one more allowed → qty 2 of which 1 sent.
    expect(out[0].qty).toBe(2);
    expect(out[0].sent).toBe(1);
  });

  it("two days of rows on one cell share one room, oldest first", () => {
    const empty = ctxFor({ cells: { pAJ1: cellsOf({ 9: 0 }) } });
    const older = row("pAJ1", "9", 1, { date: "2026-10-22", createdMs: 1 });
    const newer = row("pAJ1", "9", 3, { date: "2026-10-23", createdMs: 2 });
    const { rows: out } = capWith(empty, [newer, older]);
    expect(out.map((r) => [r.date, r.qty])).toEqual([["2026-10-23", 1], ["2026-10-22", 1]]);
  });

  it("rows with no policy pass through byte-identical; every input lands exactly once", () => {
    const c = ctxFor({ cells: { pAJ1: cellsOf({ 9: 4 }), pTee: cellsOf({ M: 0 }) } });
    const tee = row("pTee", "M", 5);
    const orphan = { ...row("pX", "9", 2), productId: null };
    const input = [tee, row("pAJ1", "9", 3), orphan];
    const { rows: out, covered } = capWith(c, input);
    expect(out).toContain(tee);
    expect(out).toContain(orphan);
    expect(out.length + covered.length).toBe(input.length);
  });
});
