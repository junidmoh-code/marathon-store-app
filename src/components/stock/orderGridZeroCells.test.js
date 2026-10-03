import { describe, it, expect } from "vitest";
import { resolveSneakerSourcing } from "./availabilityCore";

// THE DIESEL SLIDE CELLS (2026-10-03), as live: Hub 1 counted 6=0 · 7=2 · 8=2 ·
// 9=2 · 10=0 · 11=0, where 6 and 11 were CLEARED by the Counted Stock review
// (qty 0, state "untracked" — "uncounted") and 10 was sold down to 0. Hub 2
// holds 0 of every size and has no 11 cell at all. A size is selectable only
// where the hub the grid reads holds quantity > 0.
const SLIDE = { id: "p1787222538915", category: "Footwear", productType: "sneaker", hubs: ["hub1", "hub3"] };
const HUB1 = { [SLIDE.id]: {
  "6": { qty: 0, state: "untracked" }, "7": { qty: 2, state: "live" }, "8": { qty: 2 },
  "9": { qty: 2, state: "live" }, "10": { qty: 0 }, "11": { qty: 0, state: "untracked" },
} };
const HUB2 = { [SLIDE.id]: { "6": { qty: 0 }, "7": { qty: 0 }, "8": { qty: 0 }, "9": { qty: 0 }, "10": { qty: 0 } } };
const hubData = {
  hub1: { cells: HUB1, promised: {}, ready: true },
  hub2: { cells: HUB2, promised: {}, ready: true },
};
const out = (size) => {
  const { available } = resolveSneakerSourcing({ product: SLIDE, taggedHub: "hub1", size, hubData });
  return Number.isFinite(available) && available <= 0;
};

describe("Place Order grid — zero and uncounted cells are unavailable", () => {
  it("a zero cell is ✕ (size 10)", () => expect(out("10")).toBe(true));
  it("a cleared / uncounted cell is ✕ (sizes 6 and 11)", () => {
    expect(out("6")).toBe(true);
    expect(out("11")).toBe(true);
  });
  it("a size neither hub has a cell for is ✕", () => expect(out("12")).toBe(true));
  it("counted stock stays selectable (7, 8, 9)", () => {
    for (const s of ["7", "8", "9"]) expect(out(s)).toBe(false);
  });
  it("exactly the counted sizes are offered — 7, 8, 9 and nothing else", () => {
    expect(["6", "7", "8", "9", "10", "11"].filter((s) => !out(s))).toEqual(["7", "8", "9"]);
  });
  it("a size stocked ONLY at Hub 2 is offered, from Hub 2", () => {
    const h2 = { ...hubData, hub2: { ...hubData.hub2, cells: { [SLIDE.id]: { "10": { qty: 1 } } } } };
    const r = resolveSneakerSourcing({ product: SLIDE, taggedHub: "hub1", size: "10", hubData: h2 });
    expect(r).toEqual({ hub: "hub2", available: 1 });
  });
  it("an array-coerced Hub 1 row (null holes) reads the same", () => {
    const arr = []; arr[7] = { qty: 2 }; arr[10] = { qty: 0 };
    const d = { ...hubData, hub1: { ...hubData.hub1, cells: { [SLIDE.id]: Object.fromEntries(Object.entries(arr)) } } };
    const r = (s) => resolveSneakerSourcing({ product: SLIDE, taggedHub: "hub1", size: s, hubData: d }).available;
    expect(r("7")).toBe(2);
    expect(r("10")).toBe(0);
    expect(r("6")).toBe(0);
  });
});
