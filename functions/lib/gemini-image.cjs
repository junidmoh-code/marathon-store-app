// ─── THE GEMINI IMAGE TRANSPORT ──────────────────────────────────────────────
// Moved verbatim out of functions/index.js (2026-10-17, Lookbook poster) so the
// lookbook step and scripts/social/lookbook-real.mjs call the SAME request code
// as every other generator rather than a copy of it. Nothing here changed:
// models, rates, timeout, request and response handling are byte-for-byte what
// index.js had, and index.js requires them back under the same names.
"use strict";

const GEMINI_MODEL          = "gemini-3.1-flash-image";
const GEMINI_OUT_PER_MTOK   = 60;      // $/1M image-output tokens (NB2: 1120 tok ≈ $0.067 per 1K image)
const GEMINI_FLAT_IMAGE_USD = 0.067;   // fallback per-image when usageMetadata is absent
//
// House-style engine: gemini-3-pro-image ("Nano Banana Pro") — multi-reference
// scene conditioning (up to 14 input images), used ONLY for style:"house" runs.
// GA id (verified live; -preview alias also exists). Shares the GEMINI_API_KEY secret.
const NBPRO_MODEL           = "gemini-3-pro-image";
const NBPRO_OUT_PER_MTOK    = 120;     // $/1M image-output tokens (1120 tok ≈ $0.134 per 1K/2K image)
const NBPRO_FLAT_IMAGE_USD  = 0.134;   // fallback per-image when usageMetadata is absent
// Lookbook panel thumbnails (2026-10-18): the cheapest image model that takes a
// reference image. gemini-3.1-flash-lite-image at 1K is $0.0336 an image
// ($30/1M output tokens), half of Flash; Flash is its fallback.
const FLASH_LITE_MODEL          = "gemini-3.1-flash-lite-image";
const FLASH_LITE_OUT_PER_MTOK   = 30;
const FLASH_LITE_FLAT_IMAGE_USD = 0.0336;
//
// Per-request abort so a stalled upstream call fails fast instead of pinning the
// worker for the Cloud Function's full 540s timeout (esp. NB Pro multi-image gens).
// Generous headroom over a normal gen (~30-90s) so legitimate slow calls complete.
const GEMINI_FETCH_TIMEOUT_MS = 180000;

// Core generateContent call shared by both Gemini engines: takes prebuilt
// `parts` (interleaved text labels + inline images) and returns the first
// image in the response. `imageConfig` is only sent when given (the white-bg
// NB2 path sends none — request shape identical to the 2.5-flash-image days).
async function geminiGenerateImage(apiKey, model, parts, { outPerMtok, flatUsd, imageConfig, timeoutMs = GEMINI_FETCH_TIMEOUT_MS } = {}) {
  const body = { contents: [{ parts }] };
  if (imageConfig) body.generationConfig = { imageConfig };
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (err) {
    // Normalise the abort into the same Error-with-message path as HTTP failures,
    // so the per-product worker catch logs it consistently and moves on.
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`gemini request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`gemini HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const outParts = ((((json.candidates || [])[0] || {}).content) || {}).parts || [];
  let b64 = null, mime = "image/png";
  for (const part of outParts) {                    // image lives in inline_data among the parts
    const inl = part.inlineData || part.inline_data; // REST returns camelCase; accept both
    if (inl && inl.data) { b64 = inl.data; mime = inl.mimeType || inl.mime_type || mime; break; }
  }
  if (!b64) throw new Error("gemini returned no image");
  // Cost: image-output tokens × the model's rate, else the documented flat per-image.
  const um = json.usageMetadata || {};
  const outTok = um.candidatesTokenCount || 0;
  const costUSD = outTok ? +((outTok / 1e6) * outPerMtok).toFixed(6) : flatUsd;
  return { buffer: Buffer.from(b64, "base64"), costUSD, mime };
}

const inlineImagePart = (buffer, contentType) =>
  ({ inline_data: { mime_type: contentType, data: buffer.toString("base64") } });

module.exports = {
  GEMINI_MODEL, GEMINI_OUT_PER_MTOK, GEMINI_FLAT_IMAGE_USD,
  NBPRO_MODEL, NBPRO_OUT_PER_MTOK, NBPRO_FLAT_IMAGE_USD,
  FLASH_LITE_MODEL, FLASH_LITE_OUT_PER_MTOK, FLASH_LITE_FLAT_IMAGE_USD,
  GEMINI_FETCH_TIMEOUT_MS, geminiGenerateImage, inlineImagePart,
};
