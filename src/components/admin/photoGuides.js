// ─── GUIDED PRODUCT PHOTOS — the outlines, the copy, and who gets which ──────
// Owner spec 2026-10-02: new product uploads get GUIDED photos so the AI Studio
// pipeline can place products consistently. A shoe shot toe-left on one product
// and toe-right on the next forces the model to mirror one of them — and a
// mirrored shoe is a different shoe (the swoosh, the heel tab, the lateral
// panel all flip). So the camera draws the pose, and the operator fills it.
//
//   • FOOTWEAR  → TWO REQUIRED steps: the shoe (RIGHT shoe, outer side, toe
//     pointing RIGHT, sitting low-centre) and the shoe's own box (front/end
//     panel, square on). The box is what house-style sneaker generations
//     attach so the AI reproduces the REAL box (see uploadBoxPhoto in App.jsx).
//   • CLOTHING  → ONE optional step: the garment on a hanger, front facing,
//     full length, centred. Optional because the photo was optional before —
//     the spec adds no new requirement here.
//   • EVERYTHING ELSE (accessories, perfume…) → null: the form's plain photo
//     button, unchanged.
//
// Footwear is decided by the CATALOGUE KEY through footwearLine.js — the same
// FOOTWEAR_CATEGORY_KEYS the cross-app stock contract uses — never by a label,
// which is console-editable. Footwear wins if both somehow say yes: the stricter
// guide is the safer one.
//
// GEOMETRY. Each outline is drawn in its OWN local box (w×h) and placed into
// the camera frame by placeOutline: centre (cx, cy) and maximum size (maxW,
// maxH) as FRACTIONS of the displayed frame, aspect preserved. So the same
// outline sits right on a portrait phone and a landscape tablet without being
// stretched — a squashed shoe outline teaches a squashed shoe.
//
// Pure: no React, no Firebase, no DOM.

import { FOOTWEAR_CATEGORY_KEYS } from "../../utils/footwearLine.js";

export const GUIDE_STROKE = "rgba(255,255,255,.35)";

// RIGHT shoe, LATERAL (outer) side, toe pointing RIGHT. Heel on the left at
// x≈6, toe tip on the right at x≈198, sole flat along y=84. The collar dips
// behind the tongue; the vamp rises from the toe box to the laces.
const SHOE = {
  w: 200, h: 90,
  outline:
    "M 8 84 L 186 84 Q 199 82 198 70 Q 196 58 176 52 L 128 38 L 92 18 " +
    "Q 84 10 72 14 Q 58 26 40 22 Q 22 16 12 14 Q 4 40 6 70 Q 6 80 8 84 Z",
  // Midsole line, plus an arrow above the toe — the direction is the whole
  // point of the guide, so it is drawn as well as written.
  marks: ["M 7 72 L 196 72", "M 150 2 L 186 2 M 178 -4 L 186 2 L 178 8"],
};

// The box's FRONT / end panel, square on: a wide rectangle with the lid's
// lower edge drawn across the top.
const BOX = {
  w: 170, h: 100,
  outline: "M 0 0 H 170 V 100 H 0 Z",
  marks: ["M 0 22 H 170"],
};

// A garment on a hanger, FRONT facing, FULL LENGTH, centred: hook, hanger
// arms, shoulders, short sleeves, body to the hem.
const GARMENT = {
  w: 120, h: 200,
  outline:
    "M 44 34 Q 60 44 76 34 L 98 36 L 118 80 L 102 88 L 96 70 L 96 196 " +
    "L 24 196 L 24 70 L 18 88 L 2 80 L 22 36 Z",
  marks: ["M 60 14 Q 60 4 66 4 Q 72 4 72 10", "M 60 14 L 22 36 M 60 14 L 98 36"],
};

// formField: which form slot a capture fills. "photo" is the product's own
// photo (photoUrl / photoBlob / photoSourceBlob); "box" is the box photo
// (boxBlob / boxPreviewUrl).
export const SHOE_STEP = Object.freeze({
  id: "shoe", formField: "photo", required: true,
  title: "Shoe photo",
  instruction: "Right shoe · outer side · toe pointing right · whole shoe in the outline",
  shape: SHOE,
  // Low-centre: the shoe sits on the lower part of the frame, as it sits on a floor.
  place: { cx: 0.5, cy: 0.62, maxW: 0.86, maxH: 0.5 },
});

// REQUIRED as a DECISION for every new footwear upload — the box photo, or one
// tap on "No box" (Junid, 3 Oct: the box step must never block an upload). A
// shoe with no box photo gets a box of its brand from the poster's box library.
export const BOX_STEP = Object.freeze({
  id: "box", formField: "box", required: true, skippable: true, skipLabel: "No box",
  title: "Box photo",
  instruction: "The shoe's own box · front panel facing you · whole box in the outline",
  shape: BOX,
  place: { cx: 0.5, cy: 0.55, maxW: 0.84, maxH: 0.55 },
});

export const GARMENT_STEP = Object.freeze({
  id: "garment", formField: "photo", required: false,
  title: "Garment photo",
  instruction: "Front of the garment · on a hanger · whole garment in the outline",
  shape: GARMENT,
  place: { cx: 0.5, cy: 0.5, maxW: 0.7, maxH: 0.86 },
});

/**
 * Which guided photo steps a new product gets.
 * @param {{ categoryKey?: string, isFootwear?: boolean, isClothing?: boolean }} q
 * @returns {{ kind: "footwear"|"clothing", steps: object[] } | null}
 */
// Every key the New Arrivals photo pipeline composes on the FOOTWEAR plate
// (marathon-group-poster src/plates.mjs FOOTWEAR_KEYS). Wider than the stock
// FOOTWEAR_CATEGORY_KEYS on purpose: a designer shoe or a sandal needs the same
// box step.
export const BOX_PHOTO_KEYS = Object.freeze([...new Set([...FOOTWEAR_CATEGORY_KEYS, "designer-shoes", "sandals"])]);

export function guideFor({ categoryKey, isFootwear, isClothing } = {}) {
  const key = typeof categoryKey === "string" ? categoryKey.trim() : "";
  if (isFootwear === true || (key && BOX_PHOTO_KEYS.includes(key))) {
    return { kind: "footwear", steps: [SHOE_STEP, BOX_STEP] };
  }
  if (isClothing === true) return { kind: "clothing", steps: [GARMENT_STEP] };
  return null;
}

/** Has the form got the capture this step asks for? */
export function stepFilled(step, form) {
  if (!step || !form) return false;
  // "No box" (one tap) answers the box step as fully as a photo does.
  if (step.formField === "box") return !!form.boxBlob || form.boxSkipped === true;
  return !!form.photoBlob;
}

/**
 * The REQUIRED steps still missing — the "why can't I save" list. Empty when
 * the product may be saved (including every category with no guide at all).
 * Returns the step objects so callers can name them by title.
 */
export function missingPhotoSteps(guide, form) {
  if (!guide) return [];
  return guide.steps.filter((s) => s.required && !stepFilled(s, form));
}

/**
 * Where a media of mediaW×mediaH actually lands inside a box of boxW×boxH
 * under object-fit: contain — the letterboxed rect the overlay must cover so
 * the outline sits on the PICTURE, not on the black bars.
 */
export function containRect(boxW, boxH, mediaW, mediaH) {
  if (!(boxW > 0 && boxH > 0)) return { left: 0, top: 0, width: 0, height: 0 };
  if (!(mediaW > 0 && mediaH > 0)) return { left: 0, top: 0, width: boxW, height: boxH };
  const scale = Math.min(boxW / mediaW, boxH / mediaH);
  const width = mediaW * scale;
  const height = mediaH * scale;
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

/**
 * Place a step's outline in a frame of frameW×frameH: the SVG transform that
 * maps the outline's local box onto its slot, aspect preserved.
 * @returns {{ x: number, y: number, scale: number }}
 */
export function placeOutline(step, frameW, frameH) {
  const { shape, place } = step;
  const scale = Math.min((place.maxW * frameW) / shape.w, (place.maxH * frameH) / shape.h);
  return {
    x: place.cx * frameW - (shape.w * scale) / 2,
    y: place.cy * frameH - (shape.h * scale) / 2,
    scale,
  };
}
