// ─── GUIDED PRODUCT PHOTOS — who gets which guide, and what blocks the save ──
// Owner spec 2026-10-02, revised 3 Oct. Pinned here, pure:
//   • footwear (by CATALOGUE KEY) → ONE required photo: the shoe WITH its box
//   • clothing → one OPTIONAL garment step
//   • everything else → no guide at all (the form is unchanged)
//   • the copy says which way the toe points — the direction is the point
//   • the footwear form cannot be saved without that one photo

import { describe, it, expect } from "vitest";
import {
  guideFor, missingPhotoSteps, stepFilled, containRect, placeOutline,
  SHOE_STEP, GARMENT_STEP,
} from "./photoGuides.js";
import * as photoGuides from "./photoGuides.js";
import { FOOTWEAR_CATEGORY_KEYS } from "../../utils/footwearLine.js";

describe("guideFor", () => {
  it.each(FOOTWEAR_CATEGORY_KEYS)("footwear key %s → ONE required step: the shoe with its box", (key) => {
    const g = guideFor({ categoryKey: key });
    expect(g.kind).toBe("footwear");
    expect(g.steps).toEqual([SHOE_STEP]);
    expect(g.steps[0].required).toBe(true);
  });

  it("there is no separate box step any more", () => {
    expect(photoGuides.BOX_STEP).toBeUndefined();
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
  it("the shoe step asks for the shoe AND its box in one photo", () => {
    expect(SHOE_STEP.title).toBe("Shoe + box photo");
    expect(SHOE_STEP.instruction).toMatch(/shoe AND its box/);
    expect(SHOE_STEP.instruction).toMatch(/One photo/);
  });
  it("the shoe step says right shoe, outer side, toe pointing right", () => {
    expect(SHOE_STEP.instruction).toContain("toe pointing right");
    expect(SHOE_STEP.instruction).toMatch(/right shoe/i);
    expect(SHOE_STEP.instruction).toMatch(/outer side/);
  });
  it("there is no No box option", () => {
    expect(SHOE_STEP.skippable).toBeFalsy();
    expect(SHOE_STEP.skipLabel).toBeUndefined();
  });
  it("the garment step asks for the front, on a hanger, whole garment", () => {
    expect(GARMENT_STEP.instruction).toMatch(/Front of the garment/);
    expect(GARMENT_STEP.instruction).toMatch(/hanger/);
    expect(GARMENT_STEP.instruction).toMatch(/whole garment/);
  });
});

describe("missingPhotoSteps — the footwear form refuses to save without its one photo", () => {
  const shoes = guideFor({ categoryKey: "sneakers" });
  it("nothing taken → the shoe (with box) photo is missing", () => {
    expect(missingPhotoSteps(shoes, {}).map((s) => s.id)).toEqual(["shoe"]);
  });
  it("the photo taken → nothing missing", () => {
    expect(missingPhotoSteps(shoes, { photoBlob: {} })).toEqual([]);
  });
  it("old box-only fields do not count as the photo", () => {
    expect(missingPhotoSteps(shoes, { boxBlob: {}, boxSkipped: true }).map((s) => s.id)).toEqual(["shoe"]);
  });
  it("clothing with no photo → nothing missing (the photo stays optional)", () => {
    expect(missingPhotoSteps(guideFor({ isClothing: true }), {})).toEqual([]);
  });
  it("no guide → nothing missing", () => {
    expect(missingPhotoSteps(null, {})).toEqual([]);
  });
  it("stepFilled reads the photo slot", () => {
    expect(stepFilled(SHOE_STEP, { photoBlob: {} })).toBe(true);
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
  it("the shoe-with-box outline holds two shapes (box + shoe); the garment taller than wide", () => {
    expect((SHOE_STEP.shape.outline.match(/M /g) || []).length).toBeGreaterThanOrEqual(2);
    expect(SHOE_STEP.shape.outline).toMatch(/Z/); // the box rectangle
    expect(GARMENT_STEP.shape.h).toBeGreaterThan(GARMENT_STEP.shape.w);
  });
});

describe("the one-photo step covers every key the photo pipeline treats as footwear", () => {
  it("designer shoes and sandals get it too", () => {
    expect(guideFor({ categoryKey: "designer-shoes" }).steps.map((x) => x.id)).toEqual(["shoe"]);
    expect(guideFor({ categoryKey: "sandals" }).steps.map((x) => x.id)).toEqual(["shoe"]);
  });
});
