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
    ["3", 1.1], ["6", 1.1], ["6.5", 1.1], ["6_5", 1.1],
    ["7", 1.3], ["9.5", 1.3], ["9_5", 1.3],
    ["10", 1.5], ["13", 1.5],
    ["EU 40", 1.1], ["EU 41", 1.3], ["42", 1.3], ["45", 1.5], ["39", 1.1],
    ["", 1.3], ["XL", 1.3],
  ])("UK/EU %s → %s kg", (size, kg) => expect(itemWeightKg(spec, { size })).toBe(kg));

  it("band edges are inclusive at upToSize", () => {
    expect(itemWeightKg(spec, { size: "6.5" })).toBe(1.1);
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

describe("estimateParcel — single items, every category", () => {
  it("one adult sneaker → the shoe mailer, locker M", () => {
    expect(estimateParcel([sneaker("9")])).toMatchObject({
      boxCode: "SHOE", lengthCm: 35, widthCm: 23, heightCm: 14,
      actualKg: 1.5, volumetricKg: 2.82, chargeableKg: 2.82,
      service: "L2DM - ECO", dropBoxEligible: true, lockerSize: "M", fits: true, items: 1,
    });
  });

  it("kids sneaker → shoe mailer, lighter", () => {
    expect(estimateParcel([sneaker("30")])).toMatchObject({ boxCode: "SHOE", actualKg: 0.9, lockerSize: "M" });
  });

  it("slides → shoe mailer (9 cm is too thick for the flat mailer)", () => {
    expect(estimateParcel([{ category: "Footwear", subcategory: "Sandals & Slides", size: "9" }]))
      .toMatchObject({ boxCode: "SHOE", actualKg: 0.8 });
  });

  it.each([
    ["one tee", tee(), "FLAT", 0.55, "S"],
    ["bottoms", { category: "Clothing", subcategory: "Jeans & Denim" }, "FLAT", 0.65, "S"],
    ["tracksuit set", { category: "Clothing", subcategory: "Tracksuits & Sets" }, "FLAT", 1.15, "S"],
    ["bag", { category: "Accessories", subcategory: "Bags" }, "FLAT", 0.65, "S"],
    ["perfume", { category: "Perfume" }, "FLAT", 0.5, "S"],
    ["belt", { category: "Accessories", subcategory: "Belts" }, "FLAT", 0.35, "S"],
    ["cap", { category: "Clothing", subcategory: "Caps & Hats" }, "SHOE", 0.35, "M"],
  ])("%s → %s box, %s kg, locker %s", (_n, line, box, kg, locker) => {
    const p = estimateParcel([line]);
    expect(p.boxCode).toBe(box);
    expect(p.actualKg).toBe(kg);
    expect(p.lockerSize).toBe(locker);
    expect(p.chargeableKg).toBe(Math.max(p.actualKg, p.volumetricKg));
  });

  it("FLAT parcel volumetric uses the configured divisor (4000)", () => {
    expect(estimateParcel([tee()]).volumetricKg).toBe(2.4); // 40×30×8 / 4000
    const p = estimateParcel([tee()], { volumetricDivisor: 5000 });
    expect(p.volumetricKg).toBe(1.92);
  });
});

describe("estimateParcel — mixed and multi-unit orders", () => {
  it("three tees stack by thickness into the small box", () => {
    expect(estimateParcel([tee(3)])).toMatchObject({ boxCode: "SMALL", actualKg: 1.5, lockerSize: "M" });
  });

  it("sneaker + two tees: the shoebox keeps its footprint, tees stack → medium, locker L", () => {
    expect(estimateParcel([sneaker("10"), tee(2)])).toMatchObject({
      boxCode: "MEDIUM", lengthCm: 45, widthCm: 35, heightCm: 25,
      actualKg: 2.75, volumetricKg: 9.84, chargeableKg: 9.84, lockerSize: "L", service: "L2DL - ECO",
    });
  });

  it("each sneaker keeps its own box footprint (never squashed): two pairs are never in the shoe mailer", () => {
    const p = estimateParcel([sneaker("9", 2)]);
    expect(p.boxCode).toBe("MEDIUM");
    expect(layoutBlock([{ l: 33, w: 20, h: 11 }, { l: 33, w: 20, h: 11 }], 1)).toEqual([33, 20, 22]);
    expect(layoutBlock([{ l: 33, w: 20, h: 11 }, { l: 33, w: 20, h: 11 }], 2)).toEqual([33, 40, 11]);
  });

  it("six pairs → two columns in the large box, still a locker L", () => {
    expect(estimateParcel([sneaker("10", 6)])).toMatchObject({ boxCode: "LARGE", actualKg: 9.65, lockerSize: "L" });
  });

  it("ten pairs fit the large box but are over every locker's weight → door, ECO", () => {
    expect(estimateParcel([sneaker("10", 10)])).toMatchObject({
      boxCode: "LARGE", actualKg: 15.65, dropBoxEligible: false, lockerSize: null, service: "ECO",
    });
  });

  it("an order no standard box holds → fits:false, custom parcel, door", () => {
    const p = estimateParcel([sneaker("10", 20)]);
    expect(p).toMatchObject({ boxCode: null, fits: false, dropBoxEligible: false, service: "ECO" });
    expect([p.lengthCm, p.widthCm, p.heightCm]).toEqual([220, 33, 20]);
    expect(p.actualKg).toBe(30);
  });

  it("qty 0 lines are skipped; an empty order throws", () => {
    expect(estimateParcel([tee(0), tee(1)]).items).toBe(1);
    expect(() => estimateParcel([])).toThrow(/no units/);
    expect(() => estimateParcel([tee(0)])).toThrow(/no units/);
  });

  it("an unclassifiable line packs as a folded top and is reported", () => {
    const p = estimateParcel([{ name: "Mystery item", qty: 1 }]);
    expect(p.boxCode).toBe("FLAT");
    expect(p.guessed).toEqual(["Mystery item"]);
  });

  it("reports which numbers are still unmeasured", () => {
    expect(estimateParcel([sneaker("9")]).unmeasured).toEqual(["item:sneakerAdult", "box:SHOE"]);
    const measured = mergeShippingConfig({
      items: { sneakerAdult: { measured: true } },
      boxes: cfg.boxes.map((b) => ({ ...b, measured: true })),
    });
    expect(estimateParcel([sneaker("9")], measured).unmeasured).toEqual([]);
  });

  it("is deterministic and does not mutate its inputs", () => {
    const lines = [sneaker("10"), tee(2)];
    const before = JSON.stringify(lines);
    expect(estimateParcel(lines)).toEqual(estimateParcel(lines));
    expect(JSON.stringify(lines)).toBe(before);
  });
});

describe("the drop-box threshold edges", () => {
  const dropBox = cfg.dropBox;
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

  it("disabled drop box → always door", () => {
    expect(chooseLocker([10, 10, 5], 0.1, { ...dropBox, enabled: false })).toBeNull();
    expect(estimateParcel([tee()], { dropBox: { enabled: false } })).toMatchObject({ dropBoxEligible: false, service: "ECO" });
  });

  it("whole-pipeline edge: exactly 5.00 kg in the flat mailer is locker S, 5.01 is locker M", () => {
    const at = mergeShippingConfig({ items: { perfume: { kg: 4.85 } } });
    expect(estimateParcel([{ category: "Perfume" }], at)).toMatchObject({ boxCode: "FLAT", actualKg: 5, lockerSize: "S", service: "L2DS - ECO" });
    const over = mergeShippingConfig({ items: { perfume: { kg: 4.86 } } });
    expect(estimateParcel([{ category: "Perfume" }], over)).toMatchObject({ actualKg: 5.01, lockerSize: "M", service: "L2DM - ECO" });
  });

  it("whole-pipeline edge: 15.00 kg is locker L, 15.01 is the door", () => {
    // LARGE box (0.65 tare) with ten pairs at a custom band weight.
    const band = (kg) => mergeShippingConfig({ items: { sneakerAdult: { bands: [{ upToSize: 99, kg }] } } });
    expect(estimateParcel([sneaker("10", 10)], band(1.435))).toMatchObject({ actualKg: 15, lockerSize: "L" });
    expect(estimateParcel([sneaker("10", 10)], band(1.436))).toMatchObject({ actualKg: 15.01, lockerSize: null, service: "ECO" });
  });

  it("the threshold and the service code come from config", () => {
    const custom = mergeShippingConfig({ dropBox: { lockers: [{ size: "ONLY", serviceCode: "X-1", lengthCm: 50, widthCm: 50, heightCm: 50, maxKg: 1 }] } });
    expect(estimateParcel([tee()], custom)).toMatchObject({ lockerSize: "ONLY", service: "X-1" });
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
