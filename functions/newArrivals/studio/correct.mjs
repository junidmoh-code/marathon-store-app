// ── THE FOOTWEAR CORRECTION: one plate, one layout, every time ───────────────
// Junid, 5 Oct: in the final footwear photo EVERYTHING except the shoe and its
// box comes pixel for pixel from the ONE fixed footwear plate — pedestal,
// fence, rails, lighting, crop. Gemini's pedestal and background are always
// discarded. So after Gemini has made its photo:
//   1. the shoe and the box are lifted out of it (lift.mjs — no model call);
//   2. each is scaled UNIFORMLY to the measured layout (config/layout-spec.json,
//      measured from G-0102) — never warped, never recoloured;
//   3. they are placed on the untouched plate with code-drawn shadows (place.mjs).
// If the shoe cannot be lifted cleanly the caller keeps Gemini's photo and the
// card says so.
import sharp from "sharp";
import { liftFromPlate, LIFT_METHOD } from "./lift.mjs";
import { composeOnPlate, placeInBox, fitShoe } from "./place.mjs";

export const CORRECTION_VERSION = "footwear-correction-2026-10-05.1";
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * photoBuf: Gemini's footwear photo · plate: { buffer, width, height } · spec: the footwear layout.
 * → { buffer (JPEG, the plate's size), placed, deviations, found, how, fitted } or { problem }
 */
export async function correctFootwear({ photoBuf, plate, spec, lift = liftFromPlate, allowColourless = false }) {
  // allowColourless: only for a by-hand re-run that a person then looks at (never in the running flow).
  const lifted = await lift(photoBuf, plate, { allowColourless });
  if (lifted.problem) return { problem: lifted.problem };
  const canvas = { width: plate.width, height: plate.height };
  const size = async (png) => { const m = await sharp(png).metadata(); return { width: m.width, height: m.height }; };
  // A TALL shoe (a boot, a high-top) at the layout's length would run up into the box: it is fitted by its
  // height instead — under the box as it is actually placed — centred, its sole on the same line.
  let shoeSpec = spec;
  const withBox = !!(lifted.box && spec.box);
  if (withBox) {
    const bp = placeInBox(await size(lifted.box), spec.box, canvas, { align: "centre" });
    shoeSpec = { ...spec, box: { ...spec.box, bottom: (bp.top + bp.height) / canvas.height } };
  }
  const fitted = fitShoe(shoeSpec, await size(lifted.shoe), canvas, withBox);
  const use = { ...spec, shoe: fitted.shoe };
  const composed = await composeOnPlate({ kind: "footwear", plate, spec: use, parts: { shoe: lifted.shoe, ...(lifted.box ? { box: lifted.box } : {}) }, packagingAt: "rail" });
  for (const r of [composed.placed.shoe, composed.placed.box].filter(Boolean)) {
    if (r.left < -0.002 || r.top < -0.002 || r.right > 1.002 || r.bottom > 1.002) return { problem: "the shoe does not fit the backdrop at the measured layout" };
  }
  return {
    buffer: composed.buffer, placed: composed.placed, deviations: composed.deviations,
    found: { shoe: mapRect(lifted.found.shoe), box: lifted.found.box ? mapRect(lifted.found.box) : null },
    how: lifted.how, method: LIFT_METHOD, version: CORRECTION_VERSION,
    ...(fitted.shoe.fitted ? { fitted: fitted.shoe.fitted, fittedSpec: use } : {}),
  };
}
const mapRect = (b) => ({ left: r3(b.left), top: r3(b.top), right: r3(b.right), bottom: r3(b.bottom) });

/**
 * THE LAYOUT, measured from one finished photo (G-0102): where the shoe and the box were found, against
 * the pedestal of the real plate. All fractions of the frame unless said. Pure.
 *   found: { shoe, box } (fractions) · pedestal: { left, right, frontEdgeY, panelTopY, backRimY } (fractions, the PLATE's)
 */
export function layoutFrom(found, pedestal) {
  const s = found.shoe, b = found.box, pw = pedestal.right - pedestal.left;
  const shoe = { heelX: r3(s.left), toeX: r3(s.right), topY: r3(s.top), soleY: r3(s.bottom), width: r3(s.right - s.left), widthToHeight: r3((s.right - s.left) / (s.bottom - s.top) * (pedestal.canvasW / pedestal.canvasH)) };
  const box = b ? { left: r3(b.left), right: r3(b.right), top: r3(b.top), bottom: r3(b.bottom), centreX: r3((b.left + b.right) / 2), centreY: r3((b.top + b.bottom) / 2) } : null;
  return {
    shoe, box,
    measured: {
      shoeLengthOfPedestalWidth: r3((s.right - s.left) / pw),
      shoeHeightOfFrame: r3(s.bottom - s.top),
      soleBelowPedestalFrontEdge: r3(s.bottom - pedestal.frontEdgeY),
      heelFromPedestalLeft: r3(s.left - pedestal.left),
      toeFromPedestalRight: r3(pedestal.right - s.right),
      marginLeft: r3(s.left), marginRight: r3(1 - s.right),
      ...(b ? { boxWidthOfFrame: r3(b.right - b.left), boxHeightOfFrame: r3(b.bottom - b.top), boxCentreX: r3((b.left + b.right) / 2), boxCentreY: r3((b.top + b.bottom) / 2), boxToPedestalGap: r3(pedestal.backRimY - b.bottom), boxToShoeGap: r3(s.top - b.bottom) } : {}),
    },
  };
}
