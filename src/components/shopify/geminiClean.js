// ─── SHOPIFY PUBLISHING — BACKGROUND CLEANUP (Gemini) ────────────────────────
// One photo at a time: send the original to Google's Gemini image model with
// a background-replacement-ONLY instruction, then run an AUTOMATIC
// subject-preservation check before anything is shown. The truthfulness rule
// this file exists to enforce (owner spec 2026-08-14):
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
// API key: __GEMINI_API_KEY__ is baked at build time from env GEMINI_API_KEY
// (vite.config.js). Absent ⇒ the action is disabled with a plain message and
// everything else works — no stub, no silent no-op, no fallback provider.
// The baked key is publicly visible in the bundle: it must be a key
// restricted to this app's HTTP referrers.
//
// Cost per image (Gemini 2.5 Flash Image pricing, 2026-08): output is a flat
// 1290 tokens/image at $30/1M ⇒ ~$0.039 (~R0.70); the input image + prompt
// add well under $0.001. One image per click, no bulk generate.

const MODEL = "gemini-2.5-flash-image";
const API_KEY = typeof __GEMINI_API_KEY__ !== "undefined" ? __GEMINI_API_KEY__ : "";

export function isCleanBackgroundAvailable() {
  return API_KEY !== "";
}

// Background replacement ONLY. The preservation language is load-bearing —
// and deliberately NOT trusted: the pixel gate below is what actually holds
// the line.
const PROMPT =
  "Replace the background of this product photo with a plain, neutral, evenly lit " +
  "studio background in soft light grey. This is a background replacement ONLY. " +
  "The product itself must be preserved exactly as photographed: identical position, " +
  "scale, angle, colours and every pixel of its surface. Do not redraw, regenerate, " +
  "restyle, enhance or improve the product in any way. Do not remove, soften or hide " +
  "any logo, brand mark, label, tag, scuff, scratch, stain, crease, wear or damage — " +
  "this photo is a truthful record of a real second-hand item and every mark on it " +
  "must remain exactly visible. Return only the edited image.";

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

  // Pixel difference over the subject interior, candidate vs ORIGINAL.
  const diffs = [];
  let sum = 0;
  for (let p = 0; p < w * h; p++) {
    if (!eroded[p]) continue;
    const i = p * 4;
    const d = (Math.abs(cand.data[i] - orig.data[i]) +
               Math.abs(cand.data[i + 1] - orig.data[i + 1]) +
               Math.abs(cand.data[i + 2] - orig.data[i + 2])) / 3;
    diffs.push(d);
    sum += d;
  }
  diffs.sort((a, b) => a - b);
  const mean = sum / diffs.length;
  const p95 = diffs[Math.min(diffs.length - 1, Math.floor(diffs.length * 0.95))];
  const metrics = { areaFrac: Number(areaFrac.toFixed(4)), mean: Number(mean.toFixed(2)), p95 };
  if (mean > 10 || p95 > 48) {
    return { pass: false, reason: `product pixels changed (mean diff ${metrics.mean}, p95 ${p95} — the subject did not survive intact)`, metrics };
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

async function callGemini(base64, mimeType) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ inlineData: { mimeType, data: base64 } }, { text: PROMPT }] }],
      }),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(90000) : undefined,
    }
  );
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p?.inlineData?.data);
  if (!imgPart) {
    const why = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || "no image in response";
    throw new Error(`Gemini returned no image (${why})`);
  }
  return imgPart.inlineData; // { mimeType, data }
}

/**
 * Clean ONE photo's background. Returns
 *   { ok: true,  blob, previewUrl, metrics }   — candidate PASSED the gate
 *   { ok: false, discarded: true, reason }     — generated but failed; logged, never shown
 * Throws on transport/API errors (the caller shows the message).
 * The caller owns previewUrl (URL.revokeObjectURL when done).
 */
export async function cleanBackground(originalUrl) {
  if (!isCleanBackgroundAvailable()) throw new Error("GEMINI_API_KEY was not set at build time — the action is disabled.");
  const srcRes = await fetch(originalUrl);
  if (!srcRes.ok) throw new Error(`could not fetch the original photo (HTTP ${srcRes.status})`);
  const srcBlob = await srcRes.blob();
  const srcDataUrl = await blobToDataURL(srcBlob);
  const [, srcB64] = String(srcDataUrl).split(",");
  const srcMime = srcBlob.type || "image/jpeg";

  const out = await callGemini(srcB64, srcMime);
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
