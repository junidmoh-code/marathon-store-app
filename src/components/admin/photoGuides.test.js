// ─── GUIDED PRODUCT PHOTOS — who gets which guide, and what blocks the save ──
// Owner spec 2026-10-02. Pinned here, pure:
//   • footwear (by CATALOGUE KEY) → shoe (REQUIRED) + box (OPTIONAL — Junid 2 Oct:
//     a same-brand library box is used when there is none)
//   • clothing → one OPTIONAL garment step
//   • everything else → no guide at all (the form is unchanged)
//   • the copy says which way the toe points — the direction is the point
//   • the footwear form cannot be saved without the shoe photo; the box never blocks

import { describe, it, expect } from "vitest";
import {
  guideFor, missingPhotoSteps, stepFilled, containRect, placeOutline,
  SHOE_STEP, BOX_STEP, GARMENT_STEP,
} from "./photoGuides.js";
import { FOOTWEAR_CATEGORY_KEYS } from "../../utils/footwearLine.js";

describe("guideFor", () => {
  it.each(FOOTWEAR_CATEGORY_KEYS)("footwear key %s → shoe (required) then box (optional)", (key) => {
    const g = guideFor({ categoryKey: key });
    expect(g.kind).toBe("footwear");
    expect(g.steps.map((s) => s.id)).toEqual(["shoe", "box"]);
    expect(g.steps.map((s) => s.required)).toEqual([true, false]);
  });

  it("an explicit isFootwear flag also gets the footwear guide", () => {
    expect(guideFor({ categoryKey: "", isFootwear: true }).kind).toBe("footwear");
  });

  it("footwear wins over clothing — the stricter guide is the safer one", () => {
    expect(guideFor({ categoryKey: "sneakers", isClothing: true }).kind).toBe("footwear");
  });

  it("clothing → one optional garment step", () => {
    const g = guideFor({ categoryKey: "t-shirts", isClothing: true });
    expect(g.kind).toBe("clothing");
    expect(g.steps).toEqual([GARMENT_STEP]);
    expect(g.steps[0].required).toBe(false);
  });

  it.each(["perfumes", "bags", "watches", "caps", "", undefined])("everything else (%s) → no guide", (key) => {
    expect(guideFor({ categoryKey: key, isClothing: false })).toBeNull();
  });

  it("no argument at all → no guide, never a throw", () => {
    expect(guideFor()).toBeNull();
  });
});

describe("the copy", () => {
  it("the shoe step says right shoe, outer side, toe pointing right", () => {
    expect(SHOE_STEP.instruction).toContain("toe pointing right");
    expect(SHOE_STEP.instruction).toMatch(/Right shoe/);
    expect(SHOE_STEP.instruction).toMatch(/outer side/);
  });
  it("the box step asks for the shoe's own box, front panel", () => {
    expect(BOX_STEP.instruction).toMatch(/own box/);
    expect(BOX_STEP.required).toBe(false);
    expect(BOX_STEP.instruction).toMatch(/front panel/);
  });
  it("the garment step asks for the front, on a hanger, whole garment", () => {
    expect(GARMENT_STEP.instruction).toMatch(/Front of the garment/);
    expect(GARMENT_STEP.instruction).toMatch(/hanger/);
    expect(GARMENT_STEP.instruction).toMatch(/whole garment/);
  });
});

describe("missingPhotoSteps — the footwear form needs the shoe; the box is optional", () => {
  const shoes = guideFor({ categoryKey: "sneakers" });
  it("nothing taken → only the shoe is missing", () => {
    expect(missingPhotoSteps(shoes, {}).map((s) => s.id)).toEqual(["shoe"]);
  });
  it("shoe taken, NO box → nothing missing (the box is optional)", () => {
    expect(missingPhotoSteps(shoes, { photoBlob: {} })).toEqual([]);
  });
  it("box taken, no shoe → the shoe is missing", () => {
    expect(missingPhotoSteps(shoes, { boxBlob: {} }).map((s) => s.id)).toEqual(["shoe"]);
  });
  it("both taken → nothing missing", () => {
    expect(missingPhotoSteps(shoes, { photoBlob: {}, boxBlob: {} })).toEqual([]);
  });
  it("clothing with no photo → nothing missing (the photo stays optional)", () => {
    expect(missingPhotoSteps(guideFor({ isClothing: true }), {})).toEqual([]);
  });
  it("no guide → nothing missing", () => {
    expect(missingPhotoSteps(null, {})).toEqual([]);
  });
  it("stepFilled reads the right slot", () => {
    expect(stepFilled(BOX_STEP, { photoBlob: {} })).toBe(false);
    expect(stepFilled(SHOE_STEP, { boxBlob: {} })).toBe(false);
  });
});

describe("geometry", () => {
  it("containRect letterboxes a 4:3 landscape picture in a portrait box", () => {
    expect(containRect(300, 600, 400, 300)).toEqual({ left: 0, top: 187.5, width: 300, height: 225 });
  });
  it("containRect with unknown media covers the whole box", () => {
    expect(containRect(300, 600, 0, 0)).toEqual({ left: 0, top: 0, width: 300, height: 600 });
  });
  it("the shoe sits low-centre and inside the frame, aspect preserved", () => {
    const { x, y, scale } = placeOutline(SHOE_STEP, 300, 400);
    const w = SHOE_STEP.shape.w * scale;
    const h = SHOE_STEP.shape.h * scale;
    expect(x + w / 2).toBeCloseTo(150);
    expect(y + h / 2).toBeGreaterThan(200); // below the middle
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(300);
    expect(y + h).toBeLessThanOrEqual(400);
  });
  it("the box is wider than tall; the garment taller than wide", () => {
    expect(BOX_STEP.shape.w).toBeGreaterThan(BOX_STEP.shape.h);
    expect(GARMENT_STEP.shape.h).toBeGreaterThan(GARMENT_STEP.shape.w);
  });
});

describe("box step covers every key the photo pipeline treats as footwear", () => {
  it("designer shoes and sandals get the box step too", () => {
    expect(guideFor({ categoryKey: "designer-shoes" }).steps.map((x) => x.id)).toEqual(["shoe", "box"]);
    expect(guideFor({ categoryKey: "sandals" }).steps.map((x) => x.id)).toEqual(["shoe", "box"]);
  });
});
