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
  it("the reviewed publishing set replaces the record's photos wholesale, in its order", () => {
    const publish = [
      "https://firebasestorage.googleapis.com/x/gen_clean.jpg?alt=media",
      "https://firebasestorage.googleapis.com/x/angle1.jpg?alt=media",
    ];
    const plan = buildMediaPlan(product, "Low-top sneaker black", publish);
    // photo.jpg (the record's hero) is OUT — a removal in the page must
    // actually remove from the push, so there is no fallback mixing.
    expect(plan.map((m) => m.originalSource)).toEqual(publish);
    expect(plan[0].alt).toBe("Low-top sneaker black");
  });
  it("a null/empty publishing set falls back to photoUrl + gallery", () => {
    expect(buildMediaPlan(product, "Sneaker black", null)).toHaveLength(2);
    expect(buildMediaPlan(product, "Sneaker black", [])).toHaveLength(2);
  });
  it("the publishing set passes the same host allowlist as record photos", () => {
    expect(() => buildMediaPlan(product, "Sneaker black", ["https://evil.example.com/x.jpg"]))
      .toThrow(/not the app's Firebase Storage/);
  });
});

describe("networkTotals — one sellable pool", () => {
  // Real /stock shape: movement-stamped cell objects (applyMovement), with a
  // bare-number tolerance for legacy cells.
  const cell = (qty) => ({ qty, lastType: "received", mv: "-Ox123", v: 1 });
  const stock = {
    "marathon-pe": { p1: { "8": cell(3), "9": cell(1), "5_5": cell(2) } },
    hub2:          { p1: { "8": cell(2), "9": cell(-4) } },   // negative clamps to 0
    in_transit:    { p1: { "8": 100 } },                      // NOT sellable — excluded
    trophy:        { p2: { "8": cell(99) } },                 // other product — ignored
  };
  it("sums every SELLABLE location per size, clamping negative cells to 0", () => {
    expect(networkTotals(stock, "p1", ["8", "9", "5.5"])).toEqual({
      "8": 5, "9": 1, "5_5": 2,
    });
  });
  it("in_transit stock never counts as sellable", () => {
    expect(networkTotals({ in_transit: { p1: { "8": cell(9) } } }, "p1", ["8"])).toEqual({ "8": 0 });
  });
  it("sizes not in the record are excluded; missing cells read 0", () => {
    const totals = networkTotals(stock, "p1", ["8"]);
    expect(totals).toEqual({ "8": 5 });
    expect(networkTotals(stock, "p1", ["12"])).toEqual({ "12": 0 });
  });
  it("one-size uses the '_' sentinel cell", () => {
    const t = networkTotals({ pe: { p3: { _: cell(5) } } }, "p3", ["_"]);
    expect(t).toEqual({ _: 5 });
  });
  it("empty tree → zeros, never a crash", () => {
    expect(networkTotals(null, "p1", ["8"])).toEqual({ "8": 0 });
  });
});
