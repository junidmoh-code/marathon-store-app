import { describe, it, expect } from "vitest";
import {
  estimateParcel, classifyLine, itemWeightKg, chooseLocker, layoutBlock, shoeSizeNumber, toUkAdultSize,
} from "./estimateParcel.js";
import { DEFAULT_SHIPPING_CONFIG, mergeShippingConfig, ITEM_KINDS } from "./shippingConfig.js";

const cfg = DEFAULT_SHIPPING_CONFIG;
const sneaker = (size, qty = 1, extra = {}) => ({ category: "Footwear", subcategory: "Sneakers", name: "Runner", size, qty, ...extra });
const tee = (qty = 1) => ({ category: "Clothing", subcategory: "T-Shirts", name: "Tee", size: "M", qty });

describe("classifyLine — every category", () => {
  it.each([
    [sneaker("9"), "sneakerAdult"],
    [{ category: "Footwear", subcategory: "Soccer Boots", size: "8" }, "sneakerAdult"],
    [{ category: "Footwear", subcategory: "Boots", size: "10" }, "sneakerAdult"],
    [sneaker("30"), "sneakerKids"],
    [sneaker("5", 1, { name: "Air Max 90 GS" }), "sneakerKids"],
    [sneaker("12", 1, { kids: true }), "sneakerKids"],
    [{ category: "Footwear", subcategory: "Sandals & Slides", size: "8" }, "slides"],
    [{ category: "Footwear", subcategory: "Sneakers", name: "Pool Slide", size: "8" }, "slides"],
    [tee(), "foldedTop"],
    [{ category: "Clothing", subcategory: "Hoodies & Sweatshirts" }, "foldedTop"],
    [{ category: "Clothing", subcategory: "Jackets & Coats" }, "foldedTop"],
    [{ category: "Clothing", subcategory: "Jeans & Denim" }, "foldedBottoms"],
    [{ category: "Clothing", subcategory: "Cargos & Pants" }, "foldedBottoms"],
    [{ category: "Clothing", subcategory: "Shorts & Vests" }, "foldedBottoms"],
    [{ category: "Clothing", subcategory: "Tracksuits & Sets" }, "tracksuitSet"],
    [{ category: "Clothing", subcategory: "Caps & Hats" }, "cap"],
    [{ category: "Clothing", subcategory: "Clothing — Uncategorized", name: "Fleece Track Pants" }, "foldedBottoms"],
    [{ category: "Clothing", subcategory: "Clothing — Uncategorized", name: "Tech Fleece Tracksuit" }, "tracksuitSet"],
    [{ category: "Clothing", name: "Trucker Cap" }, "cap"],
    [{ category: "Accessories", subcategory: "Bags" }, "bag"],
    [{ category: "Accessories", subcategory: "Belts" }, "accessory"],
    [{ category: "Accessories", subcategory: "Watches" }, "accessory"],
    [{ category: "Perfume", subcategory: "Perfume" }, "perfume"],
    [{ kind: "bag", category: "Footwear" }, "bag"],
    [{ name: "Mystery item" }, null],
  ])("%j → %s", (line, kind) => expect(classifyLine(line)).toBe(kind));

  it("every configured kind has dims and a weight", () => {
    for (const k of ITEM_KINDS) {
      const s = cfg.items[k];
      expect(s.lengthCm * s.widthCm * s.heightCm).toBeGreaterThan(0);
      expect(itemWeightKg(s, { size: "9" })).toBeGreaterThan(0);
    }
  });
});

describe("footwear weight is stepped by size band", () => {
  const spec = cfg.items.sneakerAdult;
  it.each([
    ["3", 1.2], ["6", 1.2], ["6.5", 1.2], ["6_5", 1.2],
    ["7", 1.3], ["9.5", 1.3], ["9_5", 1.3],
    ["10", 1.4], ["13", 1.4],
    ["EU 40", 1.2], ["EU 41", 1.3], ["42", 1.3], ["45", 1.4], ["39", 1.2],
    ["", 1.3], ["XL", 1.3],
  ])("UK/EU %s → %s kg", (size, kg) => expect(itemWeightKg(spec, { size })).toBe(kg));

  it.each([
    ["22", 0.45], ["26", 0.45], ["27", 0.6], ["33", 0.6], ["34", 0.75],
    ["UK 9", 0.45], ["7", 0.45], ["10", 0.6], ["13.5", 0.6], ["1", 0.75], ["5", 0.75], ["", 0.6],
  ])("kids %s → %s kg (EU scale)", (size, kg) => expect(itemWeightKg(cfg.items.sneakerKids, { size })).toBe(kg));

  it.each([["5", 0.5], ["8", 0.6], ["11", 0.7], ["EU 44", 0.7]])("slides %s → %s kg", (size, kg) =>
    expect(itemWeightKg(cfg.items.slides, { size })).toBe(kg));

  it("band edges are inclusive at upToSize", () => {
    expect(itemWeightKg(spec, { size: "6.5" })).toBe(1.2);
    expect(itemWeightKg(spec, { size: "7" })).toBe(1.3);
  });

  it("size helpers", () => {
    expect(shoeSizeNumber("5_5")).toBe(5.5);
    expect(shoeSizeNumber("UK 8")).toBe(8);
    expect(Number.isNaN(shoeSizeNumber("M"))).toBe(true);
    expect(toUkAdultSize(42)).toBe(8.5);
    expect(toUkAdultSize(9)).toBe(9);
  });

  it("a bigger adult shoe weighs more in the parcel", () => {
    expect(estimateParcel([sneaker("10")]).actualKg).toBeGreaterThan(estimateParcel([sneaker("6")]).actualKg);
  });
});

const T = (qty = 1) => tee(qty);
const CAP = { category: "Clothing", subcategory: "Caps & Hats", name: "Cap", qty: 1 };
const kinds = (p) => p.contents.map((c) => c.kind);

describe("THE PARCEL RULE — the shoebox is the unit (Junid's four cases)", () => {
  it("one pair + 2 tees + a cap = ONE shoebox parcel (the soft goods ride inside)", () => {
    const r = estimateParcel([sneaker("9"), T(2), CAP]);
    expect(r.parcelCount).toBe(1);
    expect(r.parcels[0]).toMatchObject({ kind: "shoebox", lengthCm: 34, widthCm: 23, heightCm: 13, actualKg: 2.25 });
    expect(kinds(r.parcels[0]).sort()).toEqual(["cap", "foldedTop", "foldedTop", "sneakerAdult"]);
  });

  it("three pairs + 4 tees = THREE shoebox parcels, tees distributed, no fourth parcel", () => {
    const r = estimateParcel([sneaker("9", 3), T(4)]);
    expect(r.parcelCount).toBe(3);
    expect(r.parcels.every((p) => p.kind === "shoebox")).toBe(true);
    expect(r.parcels.map((p) => kinds(p).filter((k) => k === "foldedTop").length)).toEqual([3, 1, 0]);
    expect(r.parcels.map((p) => p.actualKg)).toEqual([2.5, 1.7, 1.3]);
  });

  it("10 tees alone = ONE flat box from the box list", () => {
    const r = estimateParcel([T(10)]);
    expect(r.parcelCount).toBe(1);
    expect(r.parcels[0]).toMatchObject({ kind: "box", boxCode: "MEDIUM" });
  });

  it("fill-budget overflow makes a second parcel ONLY when every shoebox is full", () => {
    // 1 pair: 1.2 kg budget = 3 tees; the 4th overflows into a flat parcel.
    const one = estimateParcel([sneaker("9"), T(4)]);
    expect(one.parcels.map((p) => [p.kind, p.boxCode])).toEqual([["shoebox", "SHOEBOX"], ["box", "FLAT"]]);
    expect(kinds(one.parcels[1])).toEqual(["foldedTop"]);
    // 2 pairs: the same 4 tees fit (3 + 1) — no extra parcel.
    const two = estimateParcel([sneaker("9", 2), T(4)]);
    expect(two.parcelCount).toBe(2);
    expect(two.parcels.every((p) => p.kind === "shoebox")).toBe(true);
    // Exactly at the budget is still inside.
    expect(estimateParcel([sneaker("9"), T(3)]).parcelCount).toBe(1);
  });
});

describe("THE PARCEL RULE — the details", () => {
  it("weight: a shoebox with a pair is 1.3 kg (size bands stay) plus what is stuffed in it", () => {
    expect(estimateParcel([sneaker("8")]).parcels[0].actualKg).toBe(1.3);
    expect(estimateParcel([sneaker("11")]).parcels[0].actualKg).toBe(1.4);
    expect(estimateParcel([sneaker("8"), CAP]).parcels[0].actualKg).toBe(1.45);
  });

  it("chargeable = max(actual, volumetric) PER parcel; totals add up", () => {
    const r = estimateParcel([sneaker("9", 2)]);
    for (const p of r.parcels) {
      expect(p.volumetricKg).toBe(2.54); // 34×23×13 / 4000
      expect(p.chargeableKg).toBe(Math.max(p.actualKg, p.volumetricKg));
    }
    expect(r.chargeableKg).toBe(5.08);
    expect(r.actualKg).toBe(2.6);
  });

  it("kids pairs and slides are a shoebox each, unless their item says otherwise", () => {
    const r = estimateParcel([sneaker("30"), { category: "Footwear", subcategory: "Sandals & Slides", size: "9" }]);
    expect(r.parcels.map((p) => p.kind)).toEqual(["shoebox", "shoebox"]);
    const stuffSlides = mergeShippingConfig({ items: { slides: { ownShoebox: false, stuffable: true } } });
    const s2 = estimateParcel([sneaker("9"), { category: "Footwear", subcategory: "Sandals & Slides", size: "9" }], stuffSlides);
    expect(s2.parcelCount).toBe(1);
  });

  it("combine pairs ON: one box from the list for all pairs, soft goods still stuffed", () => {
    const cfg = mergeShippingConfig({ shoebox: { combinePairs: true } });
    const r = estimateParcel([sneaker("9", 2), T(2)], cfg);
    expect(r.parcelCount).toBe(1);
    expect(r.parcels[0].kind).toBe("box");
    expect(r.parcels[0].actualKg).toBeCloseTo(2.6 + 0.8 + 0.45, 5);
  });

  it("a bag is neither a shoebox nor stuffed: it goes in a flat box", () => {
    const r = estimateParcel([sneaker("9"), { category: "Accessories", subcategory: "Bags", qty: 1 }]);
    expect(r.parcels.map((p) => p.kind)).toEqual(["shoebox", "box"]);
  });

  it("the shoebox size and the fill budget come from the card", () => {
    const cfg = mergeShippingConfig({ shoebox: { lengthCm: 35, widthCm: 24, heightCm: 14, fillBudgetKg: 0.4 } });
    const r = estimateParcel([sneaker("9"), T(2)], cfg);
    expect(r.parcels[0]).toMatchObject({ lengthCm: 35, widthCm: 24, heightCm: 14 });
    expect(r.parcelCount).toBe(2); // only one tee fits the 0.4 kg budget
  });

  it("no footwear and nothing fits a box → a custom parcel, fits:false", () => {
    const r = estimateParcel([{ category: "Accessories", subcategory: "Bags", qty: 30 }]);
    expect(r.fits).toBe(false);
    expect(r.parcels[0].kind).toBe("custom");
  });

  it("door-to-door by default: the drop box is off", () => {
    expect(estimateParcel([T(1)])).toMatchObject({ dropBoxEligible: false, service: "ECO" });
  });

  it("the drop box (when switched on) only ever takes a ONE-parcel shipment", () => {
    const on = mergeShippingConfig({ dropBox: { enabled: true } });
    expect(estimateParcel([T(1)], on)).toMatchObject({ dropBoxEligible: true, lockerSize: "S" });
    expect(estimateParcel([sneaker("9", 2)], on).dropBoxEligible).toBe(false);
  });

  it("qty 0 lines are skipped; an empty order throws", () => {
    expect(estimateParcel([tee(0), tee(1)]).items).toBe(1);
    expect(() => estimateParcel([])).toThrow(/no units/);
  });

  it("an unclassifiable line is treated as a folded top and reported", () => {
    const r = estimateParcel([{ name: "Mystery item", qty: 1 }]);
    expect(r.guessed).toEqual(["Mystery item"]);
    expect(r.parcels[0].boxCode).toBe("FLAT");
  });

  it("reports which numbers are still unmeasured", () => {
    expect(estimateParcel([sneaker("9")]).unmeasured).toEqual(["item:sneakerAdult", "shoebox"]);
    expect(estimateParcel([T(1)]).unmeasured).toEqual(["item:foldedTop", "box:FLAT"]);
  });

  it("is deterministic and does not mutate its inputs", () => {
    const lines = [sneaker("10"), tee(2)];
    const before = JSON.stringify(lines);
    expect(estimateParcel(lines)).toEqual(estimateParcel(lines));
    expect(JSON.stringify(lines)).toBe(before);
  });
});

describe("the drop-box threshold edges (pure: the locker limits TCG enforces)", () => {
  const dropBox = { ...cfg.dropBox, enabled: true };
  it.each([
    [[60, 17, 8], 2, "XS"],
    [[60, 17, 8], 2.01, "S"],
    [[17, 8, 60], 1, "XS"], // any orientation
    [[60, 41, 8], 5, "S"],
    [[60, 41, 8], 5.01, "M"],
    [[60, 41, 8.5], 1, "M"],
    [[60, 41, 19], 10, "M"],
    [[60, 41, 19], 10.01, "L"],
    [[60, 41, 19.5], 1, "L"],
    [[60, 41, 41], 15, "L"],
    [[60, 41, 41], 15.01, null],
    [[61, 41, 8], 1, null],
    [[60, 42, 8], 1, null],
    [[60, 41, 42], 1, null],
  ])("%j @ %s kg → %s", (dims, kg, size) => {
    expect(chooseLocker(dims, kg, dropBox)?.size ?? null).toBe(size);
  });

  it("disabled drop box → no locker", () => {
    expect(chooseLocker([10, 10, 5], 0.1, { ...dropBox, enabled: false })).toBeNull();
  });
});

describe("mergeShippingConfig", () => {
  it("overlays objects, replaces arrays, never carries `live`", () => {
    const m = mergeShippingConfig({ live: true, volumetricDivisor: 5000, items: { cap: { kg: 0.2 } }, boxes: [{ code: "ONE", lengthCm: 1, widthCm: 1, heightCm: 1, tareKg: 0 }] });
    expect(m.live).toBeUndefined();
    expect(m.volumetricDivisor).toBe(5000);
    expect(m.items.cap).toMatchObject({ kg: 0.2, lengthCm: 26 });
    expect(m.boxes.map((b) => b.code)).toEqual(["ONE"]);
    expect(DEFAULT_SHIPPING_CONFIG.items.cap.kg).toBe(0.15); // defaults untouched
  });
});
