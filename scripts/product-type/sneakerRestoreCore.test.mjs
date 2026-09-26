// The restore planner against the Air Force 1 White as it stood on 26 Sep 2026.
import { describe, it, expect } from "vitest";
import { planSneakerRestore, typeLogEntry, sortShoeSizes, isShoeSize } from "./sneakerRestoreCore.mjs";

const AF1 = {
  id: "p1777979694047", name: "Nike Air Force 1 White", productType: "clothing", category: "Footwear",
  hubs: ["hub2"], hub: "hub3", hasShoeBoxOption: false,
  sizes: ["3", "4", "5", "5.5", "7", "8", "9", "10", "11", "6", "12"],
};
const cell = (qty) => ({ qty, v: 1, mv: "m", lastType: "sold" });
const CELLS = {
  hub1: { 3: cell(2), 4: cell(1), 5: cell(0), 6: cell(0), 7: cell(0), 8: cell(2), 9: cell(1), 10: cell(2), 11: cell(2), "5_5": cell(0) },
  central: { 3: cell(11), 6: cell(16), 10: cell(37) },
  "marathon-pe": { 7: cell(1), _: cell(0) },
};
const HISTORY = { sizes: { 3: 42, 4: 88, 5: 149, 5.5: 50, 6: 272, 7: 258, 8: 217, 9: 145, 10: 46, 11: 27 }, hubs: { hub1: 1022, hub3: 278 } };
const NOW = Date.parse("2026-09-26T09:00:00Z");

describe("planSneakerRestore — the Air Force 1 White", () => {
  const plan = planSneakerRestore(AF1, CELLS, HISTORY, { seatHub2: true, nowMs: NOW });

  it("type back to sneaker, Hub 1 back, the legacy hub aligned", () => {
    expect(plan.ok).toBe(true);
    expect(plan.patch.productType).toBe("sneaker");
    expect(plan.patch.hubs).toEqual(["hub1", "hub2"]);
    expect(plan.patch.hub).toBe("hub1");
  });

  it("sizes from evidence only: 12 (never stocked, sold or ordered) goes; the run is sorted", () => {
    expect(plan.patch.sizes).toEqual(["3", "4", "5", "5.5", "6", "7", "8", "9", "10", "11"]);
    expect(plan.notes.join(" ")).toMatch(/sizes 12 dropped/);
  });

  it("a size with order history but no cell is kept; a one-size '_' cell is not a shoe size", () => {
    const p = planSneakerRestore({ ...AF1, sizes: [] }, { hub1: { _: cell(0) } }, { sizes: { 12: 3 } });
    expect(p.after.sizes).toEqual(["12"]);
  });

  it("Hub 2 seats are qty-0 seed cells for every size without a cell — the shape the rules accept", () => {
    expect(Object.keys(plan.seeds)).toHaveLength(10);
    expect(plan.seeds["stock/hub2/p1777979694047/5_5"]).toEqual({
      qty: 0, v: 0, mv: "seed", lastType: "count", state: "live", updatedAt: "2026-09-26T09:00:00.000Z", updatedBy: "restore",
    });
    const already = planSneakerRestore(AF1, { ...CELLS, hub2: { 6: cell(4) } }, HISTORY, { seatHub2: true, nowMs: NOW });
    expect(already.seeds["stock/hub2/p1777979694047/6"]).toBeUndefined();
  });

  it("never touches a quantity: the only stock writes are seeds, and only where no cell exists", () => {
    for (const [path, v] of Object.entries(plan.seeds)) {
      expect(path.startsWith("stock/hub2/")).toBe(true);
      expect(v.qty).toBe(0);
    }
  });

  it("no seats unless asked; no Hub 1 without Hub 1 evidence", () => {
    const p = planSneakerRestore({ ...AF1, hubs: ["hub3"] }, { central: CELLS.central }, { sizes: HISTORY.sizes, hubs: { hub3: 5 } });
    expect(p.seeds).toEqual({});
    expect(p.after.hubs).toEqual(["hub3"]);
  });

  it("keepSizes only ever adds: a size with no history stays (the catalogue audit)", () => {
    const p = planSneakerRestore({ ...AF1, sizes: ["6", "7", "8"] }, { hub1: { 6: cell(1) } }, { sizes: { 7: 2, 9: 1 } }, { keepSizes: true });
    expect(p.after.sizes).toEqual(["6", "7", "8", "9"]);
  });

  it("refuses to restore blind — no shoe-size evidence at all", () => {
    expect(planSneakerRestore({ ...AF1, sizes: ["S", "M"] }, {}, {})).toEqual({ ok: false, reason: "no shoe-size evidence — not restoring blind" });
  });

  it("the audit entry names who, when, from and to", () => {
    const e = typeLogEntry({ from: "clothing", to: "sneaker", atMs: NOW, by: { personName: "Junid", deviceId: "d1", uid: "u1" }, reason: "r", before: plan.before, after: plan.after });
    expect(e).toMatchObject({ from: "clothing", to: "sneaker", atMs: NOW, personName: "Junid", deviceId: "d1", hubsBefore: ["hub2"], hubsAfter: ["hub1", "hub2"] });
  });

  it("size helpers", () => {
    expect(sortShoeSizes(["10", "5.5", "3", "11", "6", "5"])).toEqual(["3", "5", "5.5", "6", "10", "11"]);
    for (const s of ["3", "5.5", "13", "28"]) expect(isShoeSize(s)).toBe(true);
    for (const s of ["S", "XL", "_", "5.25", "", "99", "38", "40", "17"]) expect(isShoeSize(s)).toBe(false);
  });
});
