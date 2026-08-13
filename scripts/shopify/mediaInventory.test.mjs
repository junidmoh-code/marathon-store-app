// ─── Photos + inventory, pure parts pinned ───────────────────────────────────
import { describe, it, expect } from "vitest";
import { buildMediaPlan } from "./media.mjs";
import { networkTotals } from "./inventory.mjs";

describe("buildMediaPlan", () => {
  const product = {
    photoUrl: "https://firebasestorage.googleapis.com/x/photo.jpg?alt=media&token=t",
    gallery: [
      "https://firebasestorage.googleapis.com/x/angle1.jpg?alt=media",
      "https://firebasestorage.googleapis.com/x/photo.jpg?alt=media&token=t", // dup of hero
    ],
  };
  it("hero first, gallery after, duplicates dropped, alt = cleaned name", () => {
    const plan = buildMediaPlan(product, "Low-top sneaker black");
    expect(plan).toHaveLength(2);
    expect(plan[0].originalSource).toContain("photo.jpg");
    expect(plan[1].originalSource).toContain("angle1.jpg");
    for (const m of plan) {
      expect(m.alt).toBe("Low-top sneaker black");
      expect(m.mediaContentType).toBe("IMAGE");
    }
  });
  it("refuses a photo-less product — imageless products never push", () => {
    expect(() => buildMediaPlan({}, "Sneaker black")).toThrow(/no photoUrl/);
    expect(() => buildMediaPlan({ photoUrl: "" }, "Sneaker black")).toThrow(/no photoUrl/);
  });
  it("refuses non-HTTPS sources and a missing cleaned title", () => {
    expect(() => buildMediaPlan({ photoUrl: "http://insecure/p.jpg" }, "Sneaker")).toThrow(/HTTPS/);
    expect(() => buildMediaPlan(product, "")).toThrow(/cleaned title/);
  });
});

describe("networkTotals — one sellable pool", () => {
  const stock = {
    marathon_pe: { p1: { "8": 3, "9": 1, "5_5": 2 } },
    hub2:        { p1: { "8": 2, "9": -4 } },       // negative clamps to 0
    in_transit:  { p1: { "8": 1 } },
    trophy:      { p2: { "8": 99 } },               // other product — ignored
  };
  it("sums every location per size, clamping negative cells to 0", () => {
    expect(networkTotals(stock, "p1", ["8", "9", "5.5"])).toEqual({
      "8": 6, "9": 1, "5_5": 2,
    });
  });
  it("sizes not in the record are excluded; missing cells read 0", () => {
    const totals = networkTotals(stock, "p1", ["8"]);
    expect(totals).toEqual({ "8": 6 });
    expect(networkTotals(stock, "p1", ["12"])).toEqual({ "12": 0 });
  });
  it("one-size uses the '_' sentinel cell", () => {
    const t = networkTotals({ pe: { p3: { _: 5 } } }, "p3", ["_"]);
    expect(t).toEqual({ _: 5 });
  });
  it("empty tree → zeros, never a crash", () => {
    expect(networkTotals(null, "p1", ["8"])).toEqual({ "8": 0 });
  });
});
