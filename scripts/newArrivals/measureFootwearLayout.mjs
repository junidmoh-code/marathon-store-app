#!/usr/bin/env node
// ─── MEASURE THE FOOTWEAR LAYOUT from one finished photo ─────────────────────
// How config/layout-spec.json → footwear was measured from G-0102 (5 Oct 2026):
//
//     node scripts/newArrivals/measureFootwearLayout.mjs <footwear-plate.png> <photo.jpg>
//
// Pixels only, no model call, nothing written: it prints the numbers. The shoe
// and box are found in the photo exactly as the correction finds them
// (functions/newArrivals/studio/lift.mjs); the pedestal is the PLATE's own.
import fs from "node:fs";
import { createRequire } from "node:module";
import { liftFromPlate, pedestalIn } from "../../functions/newArrivals/studio/lift.mjs";
import { layoutFrom } from "../../functions/newArrivals/studio/correct.mjs";

const sharp = createRequire(new URL("../../functions/package.json", import.meta.url))("sharp");

export async function measure(plateBuf, photoBuf) {
  const m = await sharp(plateBuf).metadata(), W = m.width, H = m.height;
  const raw = (buf) => sharp(buf).flatten({ background: "#ffffff" }).resize(W, H, { fit: "cover", position: "centre" }).removeAlpha().blur(1.2).raw().toBuffer();
  const onPlate = pedestalIn(await raw(plateBuf), W, H), inPhoto = pedestalIn(await raw(photoBuf), W, H);
  if (!onPlate || onPlate.backRim === null || onPlate.frontEdge === null) throw new Error("the plate's pedestal could not be read");
  const lifted = await liftFromPlate(photoBuf, { buffer: plateBuf, width: W, height: H });
  if (lifted.problem) throw new Error(`the photo could not be measured — ${lifted.problem}`);
  const pedestal = { left: onPlate.left / W, right: onPlate.right / W, frontEdgeY: onPlate.frontEdge / H, backRimY: onPlate.backRim / H, panelTopY: onPlate.panelTop / H, canvasW: W, canvasH: H };
  return { canvas: { width: W, height: H }, platePedestalPx: onPlate, photoPedestalPx: inPhoto, how: lifted.how, ...layoutFrom(lifted.found, pedestal) };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [plate, photo] = process.argv.slice(2);
  if (!plate || !photo) { console.error("usage: measureFootwearLayout.mjs <footwear-plate.png> <photo.jpg>"); process.exit(2); }
  console.log(JSON.stringify(await measure(fs.readFileSync(plate), fs.readFileSync(photo)), null, 2));
}
