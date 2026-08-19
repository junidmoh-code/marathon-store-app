// ─── SHOPIFY PUBLISHING — BACKGROUND CLEANUP (Gemini) ────────────────────────
// One photo at a time: ask the SERVER to send the original to Google's Gemini
// image model with a background-replacement-ONLY instruction, then run an
// AUTOMATIC subject-preservation check here before anything is shown. The
// truthfulness rule this file exists to enforce (owner spec 2026-08-14):
//
//   The photo a customer sees must be a truthful depiction of the item they
//   will receive. Background replacement and cutout are permitted. The
//   product's pixels must survive — regenerating, restyling or synthesising
//   the product is forbidden, and removing or obscuring logos, marks, scuffs,
//   wear or damage is MISREPRESENTATION OF GOODS. The TEXT compliance rules
//   (shopifyTriggers.js) are never extended to photos.
//
// Junid rejects any generated image that changes the item even slightly — and
// the gate does not rely on his eye: assessSubjectPreservation compares the
// product region pixel-for-pixel between original and candidate and DISCARDS
// the result (with a logged reason) before it is ever offered. Only passing
// candidates reach the side-by-side accept step, and accepting stores a NEW
// Storage object beside the original (photoTools records derivedFrom); the
// original is never overwritten or deleted.
//
// ── THE KEY IS NOT HERE, AND MUST NEVER BE ───────────────────────────────────
// This file used to hold `__GEMINI_API_KEY__`, baked into the bundle at build
// time by vite. Its own comment admitted the consequence: the key is publicly
// visible in the bundle and spendable by anyone who extracts it, with a quota
// cap as the only real containment. Junid's instruction is that the key is
// never exposed to the browser, so the paid call moved to a Cloud Function
// (functions/photoClean/cleanProductPhoto.js) where a Cloud Functions secret
// holds it. The action also shipped DISABLED for want of a build-time key;
// with the key on the server there is nothing left to disable.
//
// WHAT STAYED HERE, AND WHY: the subject-preservation gate. Both images are
// already decoded onto a canvas in this process; running the same comparison
// server-side would mean decoding both again to reach the same verdict with
// the same code. The gate is unchanged — the same three pixel thresholds, the
// same interior-hole check, the same aspect gate, the same tests.
//
// Cost per image is charged to the project, not the browser: ~$0.067 (~R1.20)
// on gemini-3.1-flash-image. One image per click, no bulk generate — Junid's
// painted backdrop stays the default for ordinary catalogue photos and is
// never bulk-regenerated.
//
// ── WHAT THE GATE ACTUALLY DOES ON A REAL PHOTO (measured 2026-08-19) ────────
// The gate had never been run against a real product image before this. It has
// now, on p1777895620932 (a live cream/black/grey low-top on the shop's painted
// backdrop, 592x800), seven real generations:
//
//   · ONE deliberately tampered prompt — "recolour the shoe deep red, remove
//     every logo, clean off all scuffs". The model did exactly that. DISCARDED,
//     never shown. That is the check doing the job it exists for.
//   · SIX honest background-swap prompts, the wording below verbatim, twice
//     with the output size pinned to the original's aspect. ALL SIX DISCARDED.
//
// The six are not a false alarm — they are the model re-rendering rather than
// editing. It returns its own resolution (880x1189 for a 592x800 input),
// reframes and rescales the shoe inside the frame, and redraws detail it
// cannot reproduce: on the first run the shoe's printed side text came back as
// "NAKE AND THE SWOOTH … SNOOSH". A customer shown that would be looking at a
// shoe that does not exist. The gate was right every time.
//
// SO: THE ACTION IS SAFE, AND ON PHOTOS LIKE THESE IT CURRENTLY PRODUCES
// NOTHING. Expect "discarded" on a photo shot against the shop backdrop with
// the rack visible — replacing that much of the frame is a re-render, and a
// re-render never survives a pixel comparison. A photo already on a plain
// field, where the model has little to invent, is the case with a chance.
// Pixel-preserving background replacement is a SEGMENTATION-AND-COMPOSITE job,
// not a generation job; if this action is ever wanted as a working tool rather
// than a safe one, that is the change to make, and it is not a prompt tweak.
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";

// The instruction the model is given lives with the call, on the server
// (functions/photoClean/cleanProductPhoto.js). It is load-bearing wording and
// it is deliberately NOT trusted — the pixel gate below is what holds the line.
const cleanPhotoCall = httpsCallable(functions, "cleanProductPhoto");

// Comparison frame: both images resampled onto this square grid. Stretching
// ignores aspect — safe because an aspect change is rejected before this.
const CMP = 384;

// ── The subject-preservation gate (pure — unit-tested) ───────────────────────
// Inputs are {data: RGBA Uint8ClampedArray, width, height} at IDENTICAL
// dimensions. Strategy: the candidate's background is a plain studio field by
// construction, so its border ring prices the background colour; pixels far
// from it are the subject. Over that (eroded) subject region the candidate
// must match the ORIGINAL almost exactly — a subject that moved, rescaled or
// was redrawn produces wholesale pixel differences there. Thresholds are
// deliberately tight: a false DISCARD costs a retry, a false PASS ships a
// misrepresented product.
export function assessSubjectPreservation(orig, cand) {
  const w = orig.width, h = orig.height;
  if (cand.width !== w || cand.height !== h) {
    return { pass: false, reason: "dimension mismatch between original and candidate", metrics: {} };
  }
  // Candidate background colour: per-channel median of the border ring.
  const B = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const ringR = [], ringG = [], ringB = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= B && y >= B && x < w - B && y < h - B) continue;
      const i = (y * w + x) * 4;
      ringR.push(cand.data[i]); ringG.push(cand.data[i + 1]); ringB.push(cand.data[i + 2]);
    }
  }
  const median = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  const bg = [median(ringR), median(ringG), median(ringB)];

  // Subject mask: candidate pixels far from the background colour.
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const dr = cand.data[i] - bg[0], dg = cand.data[i + 1] - bg[1], db = cand.data[i + 2] - bg[2];
    if (Math.sqrt(dr * dr + dg * dg + db * db) > 40) mask[p] = 1;
  }
  // Erode by one 4-neighbour pass — the cutout edge itself legitimately
  // differs (it borders the new background); the INTERIOR must not.
  const eroded = new Uint8Array(w * h);
  let subjectArea = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (mask[p] && mask[p - 1] && mask[p + 1] && mask[p - w] && mask[p + w]) {
        eroded[p] = 1;
        subjectArea++;
      }
    }
  }
  const areaFrac = subjectArea / (w * h);
  if (areaFrac < 0.03) {
    return { pass: false, reason: "no clear subject found against the new background", metrics: { areaFrac } };
  }

  // INTERIOR-HOLE gate. The pixel-diff below only covers the candidate's
  // subject mask — a mark erased by painting it WITH the background colour
  // reads as background, drops out of the mask, and would never be compared
  // (reviewer finding, 2026-08-14). Any background-coloured region trapped
  // INSIDE the product silhouette (unreachable from the border by flood
  // fill across background pixels) is treated as exactly that erasure and
  // discards the candidate. Known cost: products with genuine closed
  // see-through openings (a bag handle's loop) can be discarded falsely —
  // acceptable by policy; a false pass ships misrepresentation.
  const seen = new Uint8Array(w * h);
  const queue = [];
  for (let x = 0; x < w; x++) { queue.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { queue.push(y * w, y * w + (w - 1)); }
  for (const p of queue) { if (!mask[p]) seen[p] = 1; }
  while (queue.length) {
    const p = queue.pop();
    if (mask[p] || !seen[p]) continue;
    const x = p % w, y = (p / w) | 0;
    for (const q of [p - 1, p + 1, p - w, p + w]) {
      if (q < 0 || q >= w * h) continue;
      if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
      if (!mask[q] && !seen[q]) { seen[q] = 1; queue.push(q); }
    }
  }
  let holeArea = 0;
  for (let p = 0; p < w * h; p++) if (!mask[p] && !seen[p]) holeArea++;
  const holeFrac = holeArea / subjectArea;
  if (holeFrac > 0.005) {
    // The reason names BOTH readings, because in practice the second one is
    // the common cause and the first alone reads as a false accusation. A
    // background-coloured island inside the silhouette is either a mark
    // painted out, or — far more often — a whole re-render whose subject sits
    // somewhere else in the frame, so the two silhouettes do not line up at
    // all. Naming only "a mark may have been painted out" sent a reader
    // hunting for an erasure that was not there (measured 2026-08-19).
    return {
      pass: false,
      reason: `the product region does not line up with the original ` +
              `(${(holeFrac * 100).toFixed(2)}% of it reads as background — either a mark was painted out, ` +
              `or the whole photo was re-rendered and the item moved)`,
      metrics: { areaFrac: Number(areaFrac.toFixed(4)), holeFrac: Number(holeFrac.toFixed(4)) },
    };
  }

  // Pixel difference over the subject interior, candidate vs ORIGINAL. Three
  // gates, because each has a blind spot the others cover: mean catches
  // global drift, p95 catches broad tails — and BOTH would let a small
  // concentrated edit hide in the tail (a logo or scuff erased over ~3% of
  // the subject moves the mean by units and sits inside p95's 5% allowance;
  // reviewer finding 2026-08-14). changedFrac closes that hole: at most 0.5%
  // of subject pixels may differ beyond the re-encode noise floor.
  const diffs = [];
  let sum = 0;
  let changed = 0;
  for (let p = 0; p < w * h; p++) {
    if (!eroded[p]) continue;
    const i = p * 4;
    const d = (Math.abs(cand.data[i] - orig.data[i]) +
               Math.abs(cand.data[i + 1] - orig.data[i + 1]) +
               Math.abs(cand.data[i + 2] - orig.data[i + 2])) / 3;
    diffs.push(d);
    sum += d;
    if (d > 30) changed += 1;
  }
  diffs.sort((a, b) => a - b);
  const mean = sum / diffs.length;
  const p95 = diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * 0.95))];
  const changedFrac = changed / diffs.length;
  const metrics = {
    areaFrac: Number(areaFrac.toFixed(4)),
    holeFrac: Number(holeFrac.toFixed(4)),
    mean: Number(mean.toFixed(2)),
    p95,
    changedFrac: Number(changedFrac.toFixed(4)),
  };
  if (mean > 10 || p95 > 48 || changedFrac > 0.005) {
    return { pass: false, reason: `product pixels changed (mean diff ${metrics.mean}, p95 ${p95}, ${(changedFrac * 100).toFixed(2)}% of the subject beyond noise — the subject did not survive intact)`, metrics };
  }
  return { pass: true, reason: null, metrics };
}

// ── Browser plumbing ─────────────────────────────────────────────────────────

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("could not read image data"));
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("could not decode image"));
    img.src = src;
  });
}

function imageDataAt(img, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size);
}

// The paid call, made by the server. Returns { mimeType, data } exactly as the
// browser version did, so everything downstream is untouched.
async function callCleanFunction(productId, photoUrl) {
  let res;
  try {
    res = await cleanPhotoCall({ productId, photoUrl });
  } catch (e) {
    // httpsCallable wraps the function's HttpsError; its `message` is the
    // plain sentence the function wrote for exactly this purpose.
    throw new Error(String(e?.message || e));
  }
  const out = res?.data;
  if (!out?.data) throw new Error("The image service returned no image.");
  return { mimeType: out.mimeType || "image/png", data: out.data };
}

/**
 * Clean ONE photo's background. Returns
 *   { ok: true,  blob, previewUrl, metrics }   — candidate PASSED the gate
 *   { ok: false, discarded: true, reason }     — generated but failed; logged, never shown
 * Throws on transport/API errors (the caller shows the message).
 * The caller owns previewUrl (URL.revokeObjectURL when done).
 *
 * `productId` is what the SERVER uses to look the photo up: the function reads
 * the URL off the product record rather than trusting one from the browser, so
 * this cannot become a fetch proxy. `originalUrl` is still fetched here too —
 * the gate needs the original's own pixels to compare against.
 */
export async function cleanBackground(originalUrl, productId) {
  const srcRes = await fetch(originalUrl,
    typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(20000) } : {});
  if (!srcRes.ok) throw new Error(`could not fetch the original photo (HTTP ${srcRes.status})`);
  const srcBlob = await srcRes.blob();
  const srcDataUrl = await blobToDataURL(srcBlob);

  const out = await callCleanFunction(productId, originalUrl);
  const outBlob = await (await fetch(`data:${out.mimeType};base64,${out.data}`)).blob();

  const candUrl = URL.createObjectURL(outBlob);
  const [origImg, candImg] = await Promise.all([loadImage(srcDataUrl), loadImage(candUrl)]);
  // Aspect gate BEFORE the stretched comparison: a reframed result would
  // otherwise be compared through two different stretches and could slip by.
  const origAspect = origImg.width / origImg.height;
  const candAspect = candImg.width / candImg.height;
  if (Math.abs(origAspect - candAspect) / origAspect > 0.02) {
    URL.revokeObjectURL(candUrl);
    console.warn(`[cleanBackground] DISCARDED for ${originalUrl}: aspect changed ${origAspect.toFixed(3)} → ${candAspect.toFixed(3)}`);
    return { ok: false, discarded: true, reason: "the framing changed" };
  }
  const verdict = assessSubjectPreservation(imageDataAt(origImg, CMP), imageDataAt(candImg, CMP));
  if (!verdict.pass) {
    URL.revokeObjectURL(candUrl);
    console.warn(`[cleanBackground] DISCARDED for ${originalUrl}: ${verdict.reason}`, verdict.metrics);
    return { ok: false, discarded: true, reason: verdict.reason };
  }
  return { ok: true, blob: outBlob, previewUrl: candUrl, metrics: verdict.metrics };
}
