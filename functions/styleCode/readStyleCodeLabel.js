// ─── readStyleCodeLabel CALLABLE — THE FOUR-TIER LABEL FUNNEL ────────────────
// Staff photograph the inside-tongue label; this turns that photo into a style
// code. It is a FUNNEL, not one model call, because each tier is an order of
// magnitude cheaper than the next and answers most of the traffic:
//
//   TIER 1  Cloud Vision DOCUMENT_TEXT_DETECTION + regex
//           Cheap, fast, deterministic. Handles a clean label on its own.
//   TIER 2  Gemini 3.6 Flash, structured JSON — ONLY on the residual
//           Fires only when tier 1 returns ZERO or MORE THAN ONE candidate,
//           i.e. only on the photos OCR already failed. That residual is the
//           hard set, which is why this is the full Flash model and NOT a
//           Flash-Lite variant.
//   TIER 3  Confusable-character retry — LOOKUP only, no extra vision call
//           Lives in resolveStyleCode (see runResolve's confusableRetry).
//   TIER 4  Manual entry — always available, never removed, never shape-gated.
//
// Every tier's answer is validated against the accepted formats BEFORE it is
// allowed anywhere near a lookup. A vision model that returns "AIR JORDAN 4" in
// the code field must be caught here, not three screens later.
//
// ── COST CONTROL ─────────────────────────────────────────────────────────────
// Results are cached on a hash of the IMAGE BYTES, so a retake of the same
// photo — or two staff shooting the same label — never re-bills. The cache row
// holds the extracted CODES ONLY: never the Vision payload, which is tens of KB
// of per-symbol bounding boxes and precisely the node shape that has already
// cost this project RTDB download bandwidth. The client downscales to 1024px
// before upload for the same reason.
//
// DEPLOY (scoped, when the owner chooses to):
//   firebase deploy --only functions:readStyleCodeLabel
// REQUIRES: vision.googleapis.com enabled on the project (owner-enabled), and
// the GEMINI_API_KEY secret for tier 2.

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { GoogleAuth } = require("google-auth-library");

const {
  OCR_CACHE_PATH,
  extractStyleCodeCandidates,
  imageHash,
  buildOcrCacheRecord,
  isOcrCacheFresh,
} = require("../lib/style-code-ocr.cjs");
const {
  normaliseStyleCode,
  isKnownStyleCodeFormat,
  formatStyleCodeForDisplay,
} = require("../lib/style-code.cjs");
const { assertStyleCodeAccess } = require("./access.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const geminiApiKey = defineSecret("GEMINI_API_KEY");

// ── TIER 2 MODEL ─────────────────────────────────────────────────────────────
// ONE named constant, by design — swapping the model is a one-line change.
// Deliberately NOT a Flash-Lite variant: tier 2 only ever sees the photos tier 1
// could not read, so it is the hard residual and needs the stronger model.
//
// NOTE ON SAMPLING PARAMS: temperature / top_p / top_k are DEPRECATED on the
// Gemini 3.x models and are not set here. If this ever needs tuning, the knob is
// thinkingLevel in generationConfig.thinkingConfig — not a sampling parameter.
const TIER2_MODEL = "gemini-3.6-flash";

const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${TIER2_MODEL}:generateContent`;
const VISION_TIMEOUT_MS = 20000;
const GEMINI_TIMEOUT_MS = 30000;

// The client already downscales to 1024px; this is the abuse ceiling, not the
// expected size. A 1024px JPEG is comfortably under 500 KB.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"];

const TIER2_PROMPT = [
  "This is a photograph of the inside-tongue label of a shoe.",
  "Read the MANUFACTURER STYLE CODE printed on it.",
  "",
  "The label also prints a SIZE line (US / UK / EUR / CM) and a PRODUCTION DATE",
  "RANGE (e.g. 08/15/19 - 01/20/20). NEITHER of those is the style code. Never",
  "return a size or a date.",
  "",
  "Style codes look like: CT8527-016 (Nike), 315122-111 (Nike legacy),",
  "IE3437 (adidas), ML574EVG (New Balance), 380190-01 (Puma).",
  "",
  "Return the style code EXACTLY as printed, including its hyphen. Do not",
  "shorten it, do not drop the block after the hyphen, and do not invent one.",
  "If you cannot read a style code, return an empty string for styleCode with",
  "confidence 0 — never a guess, never a placeholder.",
].join("\n");

const TIER2_SCHEMA = {
  type: "OBJECT",
  properties: {
    styleCode: { type: "STRING" },
    brand: { type: "STRING" },
    size: { type: "STRING" },
    styleCodeConfidence: { type: "NUMBER" },
    brandConfidence: { type: "NUMBER" },
    sizeConfidence: { type: "NUMBER" },
  },
  required: ["styleCode", "styleCodeConfidence"],
};

// ── TIER 1 — Cloud Vision ────────────────────────────────────────────────────
// Authenticated with the function's own service-account credentials (ADC), so
// there is no additional API key to manage or leak.
let cachedAuth = null;
async function visionAccessToken() {
  if (!cachedAuth) cachedAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await cachedAuth.getClient();
  const token = await client.getAccessToken();
  const value = typeof token === "string" ? token : token && token.token;
  if (!value) throw new Error("could not obtain a Cloud Vision access token");
  return value;
}

/** @returns {string} the full text Vision read, or "" */
async function runVisionOcr(base64, { fetchImpl, tokenFn } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const token = await (tokenFn || visionAccessToken)();
  const res = await doFetch(VISION_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{ image: { content: base64 }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }],
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`vision HTTP ${res.status}`);
  const payload = await res.json();
  const first = payload && Array.isArray(payload.responses) ? payload.responses[0] : null;
  if (first && first.error && first.error.message) throw new Error(`vision: ${first.error.message}`);
  // The full annotation is read and IMMEDIATELY reduced to text. It is never
  // returned to the client and never written to the database.
  return (first && first.fullTextAnnotation && first.fullTextAnnotation.text) || "";
}

// ── TIER 2 — Gemini Flash, structured JSON ───────────────────────────────────
/** @returns {{code:string|null, brand:string|null, size:string|null, confidence:number}} */
async function runGeminiRead(base64, mimeType, apiKey, { fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const res = await doFetch(GEMINI_ENDPOINT, {
    method: "POST",
    // The key goes in a HEADER, never the query string: URLs end up in access
    // logs, error reports and traces, and we went to some trouble to keep this
    // key off the client — leaking it server-side would waste that.
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: TIER2_PROMPT }],
      }],
      // Structured output. NO temperature / top_p / top_k — deprecated on 3.x.
      generationConfig: { responseMimeType: "application/json", responseSchema: TIER2_SCHEMA },
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
  const payload = await res.json();
  const text = ((((payload.candidates || [])[0] || {}).content || {}).parts || [])
    .map((p) => p && p.text).filter(Boolean).join("");
  let parsed = {};
  try { parsed = JSON.parse(text) || {}; } catch { parsed = {}; }

  // ── VALIDATE BEFORE USE ────────────────────────────────────────────────────
  // A model that returns "AIR JORDAN 4", a size, or a date in the code field is
  // caught HERE. An unrecognised shape is discarded, not passed downstream —
  // manual entry (tier 4) is the fallback, and it always works.
  const raw = typeof parsed.styleCode === "string" ? parsed.styleCode.trim() : "";
  const code = raw && isKnownStyleCodeFormat(raw) ? normaliseStyleCode(raw) : null;
  let confidence = Number(parsed.styleCodeConfidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  return {
    code,
    rejectedRead: raw && !code ? raw : null, // surfaced for logging, never used
    brand: typeof parsed.brand === "string" && parsed.brand.trim() ? parsed.brand.trim() : null,
    size: typeof parsed.size === "string" && parsed.size.trim() ? parsed.size.trim() : null,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

/**
 * The funnel core — injectable IO so tiers 1 and 2 are testable without a
 * network or firebase-admin.
 *
 * @returns {{
 *   candidates: string[], displayCandidates: string[], source: string,
 *   fromCache: boolean, brand: string|null, size: string|null,
 *   confidence: number|null, tier2Used: boolean,
 *   errors: Array<{tier:string,message:string}>
 * }}
 */
async function runLabelRead(db, {
  buffer, base64, mimeType, nowMs, geminiKey, visionFetch, geminiFetch, tokenFn,
}) {
  const hash = imageHash(buffer);
  const cacheRef = db.ref(`${OCR_CACHE_PATH}/${hash}`);
  const errors = [];

  // ── CACHE — a retake of the same photo must never re-bill ──
  const cachedRow = (await cacheRef.get()).val();
  if (isOcrCacheFresh(cachedRow, nowMs)) {
    return {
      candidates: cachedRow.candidates,
      displayCandidates: cachedRow.candidates.map(formatStyleCodeForDisplay),
      source: cachedRow.source, fromCache: true,
      brand: null, size: null, confidence: null, tier2Used: false, errors,
    };
  }

  // ── TIER 1 ──
  let candidates = [];
  try {
    const text = await runVisionOcr(base64, { fetchImpl: visionFetch, tokenFn });
    candidates = extractStyleCodeCandidates(text).map((c) => c.normalised);
  } catch (err) {
    errors.push({ tier: "vision", message: (err && err.message) || String(err) });
  }

  // ── TIER 2 — ONLY on the residual: zero candidates, or an ambiguous many ──
  let brand = null, size = null, confidence = null, tier2Used = false;
  let source = "vision";
  if (candidates.length !== 1) {
    tier2Used = true;
    try {
      const g = await runGeminiRead(base64, mimeType, geminiKey, { fetchImpl: geminiFetch });
      if (g.rejectedRead) {
        console.warn(`readStyleCodeLabel: tier 2 returned an unusable code ${JSON.stringify(g.rejectedRead)} — discarded`);
      }
      // ── THE TRUNCATION GUARD ───────────────────────────────────────────────
      // Shape validation alone cannot catch a shortened code: "CT8527" is a
      // legitimate adidas-block shape, so a model that drops the "-016" off a
      // Nike code returns something that looks perfectly valid. What DOES catch
      // it is context — if tier 1 read a longer code and tier 2's answer is a
      // strict prefix of it, tier 2 truncated and tier 1 is right.
      const truncates = g.code && candidates.some((c) => c !== g.code && c.startsWith(g.code));
      if (truncates) {
        console.warn(`readStyleCodeLabel: tier 2 returned ${g.code}, a prefix of a tier-1 candidate — discarded as a truncation`);
      } else if (g.code) {
        // Tier 2 disambiguates: its single read wins over tier 1's ambiguity.
        candidates = [g.code];
        source = "gemini";
        brand = g.brand; size = g.size; confidence = g.confidence;
      }
    } catch (err) {
      errors.push({ tier: "gemini", message: (err && err.message) || String(err) });
    }
  }

  // ── CACHE THE OUTCOME — BUT ONLY A SETTLED ONE ──
  // Zero candidates is cached: a blank/unreadable photo must not re-bill on
  // every retry either. buildOcrCacheRecord reduces everything to bare codes, so
  // no payload can leak into the node.
  //
  // What must NOT be cached is a result the funnel never finished deciding. If
  // tier 1 returns two candidates and tier 2 THROWS, the answer is still
  // ambiguous — and caching it freezes that ambiguity for the full 90-day TTL,
  // because every later read of the same photo hits the fresh-cache branch and
  // returns before tier 2 is ever retried. A transient Gemini outage would
  // permanently pin an unresolved label. (CodeRabbit, PR #312.)
  const tier2Failed = tier2Used && errors.some((e) => e.tier === "gemini");
  const settled = !tier2Failed && (!errors.length || candidates.length === 1);
  if (settled) {
    try {
      await cacheRef.set(buildOcrCacheRecord({ candidates, source, nowMs }));
    } catch (err) {
      console.warn(`readStyleCodeLabel: OCR cache write failed for ${hash}:`, err && err.message);
    }
  }

  return {
    candidates,
    displayCandidates: candidates.map(formatStyleCodeForDisplay),
    source, fromCache: false, brand, size, confidence, tier2Used, errors,
  };
}

exports.runLabelRead = runLabelRead;
exports.runVisionOcr = runVisionOcr;
exports.runGeminiRead = runGeminiRead;
exports.TIER2_MODEL = TIER2_MODEL;

exports.readStyleCodeLabel = onCall(
  {
    region: "europe-west1",
    secrets: [geminiApiKey],
    timeoutSeconds: 60,
    memory: "512MiB",
  },
  async (request) => {
    const db = admin.database();
    await assertStyleCodeAccess(request, db);

    const { imageBase64, mimeType } = request.data || {};
    if (typeof imageBase64 !== "string" || !imageBase64) {
      throw new HttpsError("invalid-argument", "imageBase64 is required.");
    }
    const mime = ALLOWED_MIME.includes(mimeType) ? mimeType : "image/jpeg";

    // ── SANITISE BEFORE DECODING ──────────────────────────────────────────
    // Buffer.from(x, "base64") does NOT throw on malformed input — it silently
    // drops anything it cannot decode. So junk passes the size check, and the
    // ORIGINAL string (data-URL prefix and all) is what gets forwarded to both
    // providers, where it fails obscurely and bills us for the privilege.
    // Strip the prefix, validate the alphabet, and use the cleaned value
    // everywhere downstream. (CodeRabbit, PR #312.)
    const cleaned = imageBase64.replace(/^data:image\/[a-z+.-]+;base64,/i, "").replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
      throw new HttpsError("invalid-argument", "imageBase64 is not valid base64.");
    }
    const buffer = Buffer.from(cleaned, "base64");
    if (!buffer.length) throw new HttpsError("invalid-argument", "imageBase64 decoded to nothing.");
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new HttpsError("invalid-argument", "Label photo is too large — retake it.");
    }

    return runLabelRead(db, {
      buffer,
      base64: cleaned,
      mimeType: mime,
      nowMs: Date.now(),
      geminiKey: geminiApiKey.value(),
    });
  }
);
