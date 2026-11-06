import { describe, it, expect } from "vitest";
import {
  estimateParcel, classifyLine, itemWeightKg, chooseLocker, shoeSizeNumber, toUkAdultSize, shoeboxStack, fitsInLayers,
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
    // Measured 6 Nov 2026 (TCG weighed our single pairs at 1.02–1.3 kg).
    ["3", 1.1], ["6", 1.1], ["6.5", 1.1], ["6_5", 1.1],
    ["7", 1.2], ["9.5", 1.2], ["9_5", 1.2],
    ["10", 1.3], ["13", 1.3],
    ["EU 40", 1.1], ["EU 41", 1.2], ["42", 1.2], ["45", 1.3], ["39", 1.1],
    ["", 1.2], ["XL", 1.2],
  ])("UK/EU %s → %s kg", (size, kg) => expect(itemWeightKg(spec, { size })).toBe(kg));

  it.each([
    ["22", 0.45], ["26", 0.45], ["27", 0.6], ["33", 0.6], ["34", 0.75],
    ["UK 9", 0.45], ["7", 0.45], ["10", 0.6], ["13.5", 0.6], ["1", 0.75], ["5", 0.75], ["", 0.6],
  ])("kids %s → %s kg (EU scale)", (size, kg) => expect(itemWeightKg(cfg.items.sneakerKids, { size })).toBe(kg));

  it.each([["5", 0.5], ["8", 0.6], ["11", 0.7], ["EU 44", 0.7]])("slides %s → %s kg", (size, kg) =>
    expect(itemWeightKg(cfg.items.slides, { size })).toBe(kg));

  it("band edges are inclusive at upToSize", () => {
    expect(itemWeightKg(spec, { size: "6.5" })).toBe(1.1);
    expect(itemWeightKg(spec, { size: "7" })).toBe(1.2);
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

describe("THE PARCEL RULE — ONE parcel, never split (Junid, 23 Oct 2026)", () => {
  it("one pair + 2 tees + a cap = ONE shoebox 34×23×13 (the soft goods ride inside)", () => {
    const r = estimateParcel([sneaker("9"), T(2), CAP]);
    expect(r.parcelCount).toBe(1);
    expect(r.parcels).toHaveLength(1);
    expect(r.parcels[0]).toMatchObject({ kind: "shoebox", lengthCm: 34, widthCm: 23, heightCm: 13, actualKg: 2.15, pairs: 1, overflowBundles: 0, layout: { columns: 1, rows: 1 } });
    expect(kinds(r.parcels[0]).sort()).toEqual(["cap", "foldedTop", "foldedTop", "sneakerAdult"]);
  });

  it("two pairs = two shoeboxes stacked, 34×23×26", () => {
    expect(estimateParcel([sneaker("9", 2)]).parcels[0]).toMatchObject({ lengthCm: 34, widthCm: 23, heightCm: 26, pairs: 2, layout: { columns: 1, rows: 2 }, actualKg: 2.4 });
  });

  it("three pairs + 4 tees = ONE parcel 34×23×39 (the tees fit the 3.6 kg budget)", () => {
    const r = estimateParcel([sneaker("9", 3), T(4)]);
    expect(r.parcelCount).toBe(1);
    const p = r.parcels[0];
    expect(p).toMatchObject({ kind: "shoebox", lengthCm: 34, widthCm: 23, heightCm: 39, pairs: 3, overflowBundles: 0 });
    expect(Math.max(p.lengthCm, p.widthCm, p.heightCm)).toBeLessThanOrEqual(39);
    expect(p.actualKg).toBe(5.2); // 3 × 1.2 + 4 × 0.4
    expect(kinds(p).filter((k) => k === "foldedTop")).toHaveLength(4);
  });

  it("four pairs = 2×2 side by side, 34×46×26 (longest side 46 beats a 52 cm stack)", () => {
    expect(estimateParcel([sneaker("9", 4)]).parcels[0]).toMatchObject({ lengthCm: 34, widthCm: 46, heightCm: 26, layout: { columns: 2, rows: 2 } });
    expect(shoeboxStack(4, cfg.shoebox)).toMatchObject({ columns: 2, rows: 2, lengthCm: 34, widthCm: 46, heightCm: 26 });
    expect(shoeboxStack(3, cfg.shoebox)).toMatchObject({ columns: 1, rows: 3, lengthCm: 34, widthCm: 23, heightCm: 39 });
    expect(shoeboxStack(10, cfg.shoebox)).toMatchObject({ columns: 2, rows: 5, lengthCm: 34, widthCm: 46, heightCm: 65 }); // longest 65 beats 130 / 69 / 92
    expect(shoeboxStack(1, cfg.shoebox)).toMatchObject({ columns: 1, rows: 1, lengthCm: 34, widthCm: 23, heightCm: 13 });
  });

  it("ten pairs are STILL one parcel", () => {
    const r = estimateParcel([sneaker("9", 10)]);
    expect(r.parcelCount).toBe(1);
    expect(r.parcels[0]).toMatchObject({ pairs: 10, actualKg: 12 });
    expect(r.parcels[0].layout.columns * r.parcels[0].layout.rows).toBeGreaterThanOrEqual(10);
  });

  it("clothing with no footwear = ONE flat courier bag as thick as the goods (TCG measured 3 tees at 5.7–8 cm)", () => {
    const r = estimateParcel([T(3)]);
    expect(r.parcelCount).toBe(1);
    // 3 × 2.2 = 6.6 cm, never below the bag's 8 cm; 0.05 kg bag.
    expect(r.parcels[0]).toMatchObject({ kind: "flatBag", boxCode: "BAG", lengthCm: 41, widthCm: 34, heightCm: 8, actualKg: 1.25, pairs: 0, layout: null });
    // Four tops + a tracksuit: 8.8 + 5 = 13.8 cm.
    expect(estimateParcel([T(4), { category: "Clothing", subcategory: "Tracksuits & Sets", qty: 1 }]).parcels[0]).toMatchObject({ kind: "flatBag", heightCm: 13.8 });
  });

  it("10 tees are thicker than a bag holds (22 cm > 18) → ONE box from the box list", () => {
    const r = estimateParcel([T(10)]);
    expect(r.parcelCount).toBe(1);
    expect(r.parcels[0]).toMatchObject({ kind: "box", boxCode: "MEDIUM", pairs: 0, layout: null });
  });

  it("soft goods past the fill budget NEVER make a second parcel: they lie on top at their own thickness, no padding", () => {
    // 1 pair: 1.2 kg budget = 3 tees; the 4th (0.4 kg) lies on top, +2.2 cm.
    const one = estimateParcel([sneaker("9"), T(4)]);
    expect(one.parcelCount).toBe(1);
    expect(one.parcels[0]).toMatchObject({ kind: "shoebox", heightCm: 15.2, overflowBundles: 1, actualKg: 2.8 });
    // 7 tees: 4 on top → +8.8 cm.
    expect(estimateParcel([sneaker("9"), T(7)]).parcels[0]).toMatchObject({ heightCm: 21.8, overflowBundles: 4 });
    // 2 pairs: the same 4 tees fit the 2.4 kg budget — no extra height.
    expect(estimateParcel([sneaker("9", 2), T(4)]).parcels[0]).toMatchObject({ heightCm: 26, overflowBundles: 0 });
    // Exactly at the budget is still inside.
    expect(estimateParcel([sneaker("9"), T(3)]).parcels[0].overflowBundles).toBe(0);
  });
});

describe("THE PARCEL RULE — the details", () => {
  it("weight: a shoebox with a pair is 1.2 kg (size bands stay) plus what is stuffed in it", () => {
    expect(estimateParcel([sneaker("8")]).parcels[0].actualKg).toBe(1.2);
    expect(estimateParcel([sneaker("11")]).parcels[0].actualKg).toBe(1.3);
    expect(estimateParcel([sneaker("8"), CAP]).parcels[0].actualKg).toBe(1.35);
  });

  it("chargeable = max(actual, volumetric) for the one parcel; the totals ARE the parcel", () => {
    const r = estimateParcel([sneaker("9", 2)]);
    const p = r.parcels[0];
    expect(p.volumetricKg).toBe(5.08); // 34×23×26 / 4000
    expect(p.chargeableKg).toBe(Math.max(p.actualKg, p.volumetricKg));
    expect(r.chargeableKg).toBe(5.08);
    expect(r.actualKg).toBe(2.4);
  });

  it("kids pairs and slides are shoeboxes in the stack, unless their item says otherwise", () => {
    const r = estimateParcel([sneaker("30"), { category: "Footwear", subcategory: "Sandals & Slides", size: "9" }]);
    expect(r.parcels[0]).toMatchObject({ kind: "shoebox", pairs: 2, heightCm: 26 });
    const stuffSlides = mergeShippingConfig({ items: { slides: { ownShoebox: false, stuffable: true } } });
    const s2 = estimateParcel([sneaker("9"), { category: "Footwear", subcategory: "Sandals & Slides", size: "9" }], stuffSlides);
    expect(s2.parcels[0]).toMatchObject({ pairs: 1, heightCm: 13 });
  });

  it("a bag is neither a shoebox nor stuffed: it lies on top at its flat thickness (3 cm), same parcel", () => {
    const r = estimateParcel([sneaker("9"), { category: "Accessories", subcategory: "Bags", qty: 1 }]);
    expect(r.parcelCount).toBe(1);
    expect(r.parcels[0]).toMatchObject({ kind: "shoebox", overflowBundles: 1, heightCm: 16 });
    expect(kinds(r.parcels[0]).sort()).toEqual(["bag", "sneakerAdult"]);
  });

  it("the shoebox size, the fill budget and each item's flat thickness come from the card", () => {
    const cfg = mergeShippingConfig({ shoebox: { lengthCm: 35, widthCm: 24, heightCm: 14, fillBudgetKg: 0.4 }, items: { foldedTop: { flatCm: 5 } } });
    const r = estimateParcel([sneaker("9"), T(2)], cfg);
    expect(r.parcelCount).toBe(1);
    expect(r.parcels[0]).toMatchObject({ lengthCm: 35, widthCm: 24, heightCm: 19, overflowBundles: 1 }); // one tee fits, one on top (+5)
  });

  it("an old card's overflowBundleCm pads nothing any more", () => {
    const cfg = mergeShippingConfig({ shoebox: { overflowBundleCm: 9 } });
    expect(estimateParcel([sneaker("9"), T(4)], cfg).parcels[0].heightCm).toBe(15.2);
  });

  it("no footwear and nothing fits a box → a custom parcel, fits:false", () => {
    const r = estimateParcel([{ category: "Accessories", subcategory: "Bags", qty: 30 }]);
    expect(r.fits).toBe(false);
    expect(r.parcels[0].kind).toBe("custom");
  });

  const NO_BAG = mergeShippingConfig({ flatBag: null });
  const caps = { category: "Clothing", subcategory: "Caps & Hats" };
  const order1859 = [
    { category: "Accessories", subcategory: "Bags", qty: 1 },
    { ...caps, qty: 1 }, { ...caps, qty: 3 }, { ...caps, qty: 2 },
  ];

  it("order #1859 (6 caps + a bag): the caps nest in the flat bag, 41×34×14 — not the 55×40×35 LARGE box", () => {
    // TCG measured it at 37.5×32.3×15.4 and re-rated R355.68 → R143.52.
    const r = estimateParcel(order1859);
    expect(r.fits).toBe(true);
    expect(r.parcels[0]).toMatchObject({ kind: "flatBag", lengthCm: 41, widthCm: 34, heightCm: 14 }); // bag 3 + cap 6 + 5 × 1
  });

  it("without a bag, caps lie 2×2 per layer: #1859 fits the LARGE box", () => {
    const r = estimateParcel(order1859, NO_BAG);
    expect(r.fits).toBe(true);
    expect(r.parcels[0]).toMatchObject({ kind: "box", boxCode: "LARGE" });
  });

  it("without a bag, side by side still wins when layers can't: a tee + a perfume lie next to each other in FLAT", () => {
    const r = estimateParcel([T(1), { category: "Perfume", qty: 1 }], NO_BAG);
    expect(r.parcels[0]).toMatchObject({ kind: "box", boxCode: "FLAT" });
  });

  it("layers: a bad box row never fits, and decimal heights fit exactly", () => {
    const cap = { l: 26, w: 19, h: 12, kg: 0.15 };
    expect(fitsInLayers([cap], [-1, 40, 30])).toBe(false);
    expect(fitsInLayers([cap], [0, 40, 30])).toBe(false);
    expect(fitsInLayers([cap], [Number.NaN, 40, 30])).toBe(false);
    expect(fitsInLayers([{ ...cap, h: 0 }], [55, 40, 35])).toBe(false);
    expect(fitsInLayers([1, 2, 3].map(() => ({ ...cap, h: 8.4 })), [26, 19, 25.2])).toBe(true);
  });

  it("door-to-door by default: the drop box is off", () => {
    expect(estimateParcel([T(1)])).toMatchObject({ dropBoxEligible: false, service: "ECO" });
  });

  it("the drop box (when switched on) takes the one parcel only when it fits a locker", () => {
    const on = mergeShippingConfig({ dropBox: { enabled: true } });
    expect(estimateParcel([T(1)], on)).toMatchObject({ dropBoxEligible: true, lockerSize: "S" });
    expect(estimateParcel([sneaker("9", 2)], on)).toMatchObject({ dropBoxEligible: true, lockerSize: "L" }); // 34×26×23 fits 60×41×41
    expect(estimateParcel([sneaker("9", 10)], on).dropBoxEligible).toBe(false);
  });

  it("qty 0 lines are skipped; an empty order throws", () => {
    expect(estimateParcel([tee(0), tee(1)]).items).toBe(1);
    expect(() => estimateParcel([])).toThrow(/no units/);
  });

  it("an unclassifiable line is treated as a folded top and reported", () => {
    const r = estimateParcel([{ name: "Mystery item", qty: 1 }]);
    expect(r.guessed).toEqual(["Mystery item"]);
    expect(r.parcels[0].boxCode).toBe("BAG");
  });

  it("reports which numbers are still unmeasured", () => {
    expect(estimateParcel([sneaker("9")]).unmeasured).toEqual([]);
    expect(estimateParcel([T(1)]).unmeasured).toEqual([]);
    expect(estimateParcel([T(1), { category: "Perfume", qty: 1 }], NO_BAG).unmeasured).toEqual(["item:perfume", "box:FLAT"]);
    expect(estimateParcel([sneaker("9")], mergeShippingConfig({ shoebox: { measured: false } })).unmeasured).toEqual(["shoebox"]);
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
