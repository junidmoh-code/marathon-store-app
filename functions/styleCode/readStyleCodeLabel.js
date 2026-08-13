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
  labelTokens,
  MAX_CANDIDATES,
  OCR_CACHE_PATH,
  extractStyleCodeCandidates,
  extractLabelExtras,
  detectColourwayLine,
  imageHash,
  buildOcrCacheRecord,
  isOcrCacheFresh,
} = require("../lib/style-code-ocr.cjs");
const {
  normaliseStyleCode,
  isKnownStyleCodeFormat,
  formatStyleCodeForDisplay,
} = require("../lib/style-code.cjs");
const { LAYOUT_RULES_PATH, layoutKeyFor, applyLayoutRule } = require("../lib/label-layout.cjs");
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
  "",
  "Some labels print MORE THAN ONE code-shaped token (an article code, a",
  "production number, a serial). Put the manufacturer style code in styleCode,",
  "and list EVERY OTHER code-shaped token printed on the label in otherCodes,",
  "each exactly as printed. Never invent one; an empty list means the label",
  "prints only the one code.",
  "",
  "SOME labels also print, as separate lines: a MODEL NAME (e.g. \"DUNK GENESIS\"),",
  "and under it a COLOURWAY of slash-separated colour words (e.g.",
  "\"WOLF GREY/PHOTO BLUE\"). Most labels print NEITHER. Return each one only",
  "when it is literally printed on the label — an empty string means not",
  "printed. Never infer a colourway from the shoe itself, and never put a",
  "colourway, a model name or a UPC in the styleCode field.",
  "If a 12-14 digit barcode number (UPC/EAN) is printed, return its digits in",
  "the upc field; otherwise an empty string.",
].join("\n");

const TIER2_SCHEMA = {
  type: "OBJECT",
  properties: {
    styleCode: { type: "STRING" },
    otherCodes: { type: "ARRAY", items: { type: "STRING" } },
    brand: { type: "STRING" },
    size: { type: "STRING" },
    modelName: { type: "STRING" },
    colorway: { type: "STRING" },
    upc: { type: "STRING" },
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
  // Every OTHER code-shaped token the model saw (multi-token labels, owner
  // spec 2026-08-13). Validated one by one through the same shape gate as the
  // code itself; anything unrecognisable is dropped, never passed downstream.
  const otherCodes = [...new Set((Array.isArray(parsed.otherCodes) ? parsed.otherCodes : [])
    .filter((c) => typeof c === "string" && isKnownStyleCodeFormat(c.trim()))
    .map((c) => normaliseStyleCode(c.trim())))]
    .filter((c) => c && c !== code)
    .slice(0, 8);
  let confidence = Number(parsed.styleCodeConfidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  // Extras are validated the same way the code is — a value that does not look
  // like what it claims to be is DROPPED, not passed downstream. The colourway
  // must survive the same conservative slash-and-lexicon gate the tier-1 text
  // parse uses; the UPC must be a bare 12-14 digit run; the model name is
  // bounded and letters-led. Missing stays null — never a guess.
  const cwRaw = typeof parsed.colorway === "string" ? parsed.colorway.trim() : "";
  const upcRaw = typeof parsed.upc === "string" ? parsed.upc.replace(/\D/g, "") : "";
  const mnRaw = typeof parsed.modelName === "string" ? parsed.modelName.trim() : "";
  return {
    code,
    otherCodes,
    rejectedRead: raw && !code ? raw : null, // surfaced for logging, never used
    brand: typeof parsed.brand === "string" && parsed.brand.trim() ? parsed.brand.trim() : null,
    size: typeof parsed.size === "string" && parsed.size.trim() ? parsed.size.trim() : null,
    colorway: cwRaw ? detectColourwayLine(cwRaw) : null,
    upc: /^\d{12,14}$/.test(upcRaw) ? upcRaw : null,
    modelName: mnRaw && /^[A-Za-z]/.test(mnRaw) ? mnRaw.slice(0, 64) : null,
    confidence: Math.max(0, Math.min(1, confidence)),
  };
}

// A candidate that is a strict PREFIX of another candidate is a truncation of
// it, not a second code — the collapse this whole feature forbids (CT8527-016
// and CT8527-700 both reduce to "CT8527"). Order is preserved; the longer
// read always wins. Used on the tier-2 union in both branches.
function dropStrictPrefixes(codes) {
  return codes.filter((c) => c && !codes.some((t) => t && t !== c && t.startsWith(c)));
}

// ── TIER 2.5 — THE LEARNED LAYOUT RULE (owner spec 2026-08-08) ───────────────
// When the funnel still holds SEVERAL candidates, a human has possibly already
// answered "which token is the style number" for this label LAYOUT (the shape
// multiset of the candidates — lib/label-layout.cjs). If a live rule decides
// this set, the response carries `autoPick` so the client resolves without
// asking the same question twice. The candidate list still rides the response
// in full — the pick is transparent, never a truncation. Consulted on BOTH the
// cached and the fresh path (a rule can be learned after a row was cached),
// and never written into the cache row: rules change; cached OCR must not pin
// a stale answer.
async function consultLayoutRule(db, candidates) {
  if (!Array.isArray(candidates) || candidates.length < 2) return { autoPick: null, layoutKey: null };
  const layoutKey = layoutKeyFor(candidates);
  if (!layoutKey) return { autoPick: null, layoutKey: null };
  try {
    const rule = (await db.ref(`${LAYOUT_RULES_PATH}/${layoutKey}`).get()).val();
    return { autoPick: applyLayoutRule(rule, candidates), layoutKey };
  } catch (err) {
    // A failed rule read degrades to asking — never to a broken read.
    console.warn(`readStyleCodeLabel: layout rule read failed for ${layoutKey}:`, err && err.message);
    return { autoPick: null, layoutKey };
  }
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
  // A zero-candidate row from BEFORE the fingerprint field existed would pin
  // "nothing readable" for its whole TTL when the label actually yields a
  // fingerprint now — treat exactly that shape as a miss, once, so the row
  // upgrades itself. (A row with candidates, or with a fingerprint, is served.)
  // (fpv<2 candidates-less rows are already stale via isOcrCacheFresh)
  if (isOcrCacheFresh(cachedRow, nowMs)) {
    // RTDB drops an empty candidates array — default it back.
    const cachedCandidates = Array.isArray(cachedRow.candidates) ? cachedRow.candidates : [];
    const layout = await consultLayoutRule(db, cachedCandidates);
    // Tier 2's pick rides the cache under `pk` — honoured only when it still
    // names one of the row's own candidates (fail closed on a malformed row).
    const cachedPreferred = typeof cachedRow.pk === "string" && cachedCandidates.includes(cachedRow.pk)
      ? cachedRow.pk : null;
    return {
      candidates: cachedCandidates,
      displayCandidates: cachedCandidates.map(formatStyleCodeForDisplay),
      autoPick: layout.autoPick,
      autoPickDisplay: layout.autoPick ? formatStyleCodeForDisplay(layout.autoPick) : null,
      layoutKey: layout.layoutKey,
      preferred: cachedPreferred,
      preferredDisplay: cachedPreferred ? formatStyleCodeForDisplay(cachedPreferred) : null,
      tokens: cachedRow.tk && typeof cachedRow.tk === "object" ? Object.keys(cachedRow.tk).sort() : [],
      // Label extras ride the cache under short keys (cw/upc/mn) — see
      // buildOcrCacheRecord. Older rows simply have none, which reads as null.
      colorway: typeof cachedRow.cw === "string" ? cachedRow.cw : null,
      upc: typeof cachedRow.upc === "string" ? cachedRow.upc : null,
      modelName: typeof cachedRow.mn === "string" ? cachedRow.mn : null,
      source: cachedRow.source, fromCache: true,
      brand: null, size: null, confidence: null, tier2Used: false, errors,
    };
  }

  // ── TIER 1 ──
  let candidates = [];
  let visionText = "";
  try {
    visionText = await runVisionOcr(base64, { fetchImpl: visionFetch, tokenFn });
    candidates = extractStyleCodeCandidates(visionText).map((c) => c.normalised);
  } catch (err) {
    errors.push({ tier: "vision", message: (err && err.message) || String(err) });
  }

  // ── LABEL EXTRAS — colourway line / UPC, off the tier-1 text ──────────────
  // Read regardless of whether a code was found: a label can print a colourway
  // and no readable code, or vice versa. Tier 2 may fill gaps below; a tier-1
  // read is never overwritten by tier 2 (the deterministic parse saw the
  // actual printed line; the model is the fallback, not the authority).
  const tier1Extras = extractLabelExtras(visionText);
  let colorway = tier1Extras.colourway;
  let upc = tier1Extras.upc;
  // modelName is a TIER-2-RESIDUAL bonus, by DESIGN and by cost: only a
  // layout-aware model can tell the model-name line from an address line, and
  // tier 2 fires only when tier 1 could not settle the code. A label whose
  // code reads cleanly in tier 1 therefore returns modelName null — that is
  // the documented contract (SCHEMA.md `labelModelName`), not a gap. Paying a
  // Gemini call on EVERY clean read to fill a prefill-only field would invert
  // the funnel's whole cost design. Colourway and UPC don't have this limit:
  // their tier-1 text gates are deterministic.
  let modelName = null;

  // ── TIER 2 — ONLY on the residual: zero candidates, or an ambiguous many ──
  // A learned LAYOUT RULE is consulted FIRST (owner spec 2026-08-13): when a
  // human has already answered "which token is the style number" for this
  // layout, the ambiguity is settled for free and tier 2 is skipped — the
  // rule's pick rides `autoPick` exactly as before.
  let brand = null, size = null, confidence = null, tier2Used = false;
  let source = "vision";
  let preferred = null; // tier 2's pick — the FULL candidate set survives beside it
  let layout = candidates.length > 1 ? await consultLayoutRule(db, candidates) : { autoPick: null, layoutKey: null };
  if (candidates.length !== 1 && !layout.autoPick) {
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
      // A code-less-OR-truncated primary must not take its otherCodes down
      // with it (architect review, PR #354): those extra tokens are
      // independently validated reads with nothing to do with the primary's
      // fate. One merge helper, used by both non-primary branches below.
      const mergeOtherCodes = () => {
        if (!Array.isArray(g.otherCodes) || !g.otherCodes.length) return;
        const hadNone = candidates.length === 0;
        candidates = dropStrictPrefixes([...new Set([...candidates, ...g.otherCodes])]).slice(0, MAX_CANDIDATES);
        if (hadNone && candidates.length) source = "gemini";
      };
      const truncates = g.code && candidates.some((c) => c !== g.code && c.startsWith(g.code));
      if (truncates) {
        console.warn(`readStyleCodeLabel: tier 2 returned ${g.code}, a prefix of a tier-1 candidate — discarded as a truncation`);
        mergeOtherCodes();
      } else if (g.code) {
        // ── TIER 2 PREFERS, IT NO LONGER ERASES (owner root cause 2026-08-13:
        // the OCR captured ONE line and WHICH line varied between
        // registrations — everything downstream inherited that mistake). Its
        // pick leads the list and rides `preferred` so the client still
        // resolves in one step, but EVERY code-shaped token tier 1 read — and
        // every extra token tier 2 itself saw — stays a candidate, gets filed
        // as an identity, and can match an existing product.
        // THE GUARD CUTS BOTH WAYS (review, PR #354): tier 1 can be the
        // truncator too — a blurred label reads "CT8527" beside a second
        // token, tier 2 reads the full CT8527-016. Keeping the prefix would
        // file it as a permanent alias and a later blurred scan of the -700
        // colourway would silently resolve to the wrong product. So the
        // union drops every candidate that is a strict prefix of another
        // kept candidate, whichever tier produced it.
        candidates = dropStrictPrefixes([g.code,
          ...[...new Set([...(g.otherCodes || []), ...candidates])].filter((c) => c !== g.code),
        ]).slice(0, MAX_CANDIDATES);
        preferred = g.code;
        source = "gemini";
        brand = g.brand; size = g.size; confidence = g.confidence;
      } else {
        // No trusted PRIMARY code — but the validated extra tokens are still
        // real tokens off a real label; dropping them re-created the one-line
        // loss one branch over (CodeRabbit, PR #354). No `preferred` is set:
        // nothing here says which token is the style number, so a
        // multi-candidate result still asks. The same both-ways prefix guard
        // applies inside the merge helper.
        mergeOtherCodes();
      }
      // Extras: tier 2 only FILLS GAPS tier 1 left. Both were validated
      // through the same gates (lexicon line / digit run), and a code-less
      // tier-2 answer can still carry a perfectly good colourway.
      if (!colorway && g.colorway) colorway = g.colorway;
      if (!upc && g.upc) upc = g.upc;
      if (!modelName && g.modelName) modelName = g.modelName;
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
  // ── THE TOKEN SET ALWAYS RIDES (owner spec 2026-08-13) ──
  // Previously computed only when NO candidate matched a known format — which
  // threw away the model-name line ("LGUARD BRKR CTT", "GRIPSHOT MID") on
  // every label that DID print a code. The stable token set is now extracted
  // on every read: the code-less flow consumes it exactly as before, and the
  // link panel's name tier gets the label's wording even when codes exist.
  const tokens = labelTokens(visionText);

  const tier2Failed = tier2Used && errors.some((e) => e.tier === "gemini");
  // A tier-2 pick SETTLES a multi-candidate read — the ambiguity is decided,
  // not frozen, and the pick rides the cache as `pk`. Without the `preferred`
  // clause a vision-tier error beside a successful tier-2 read (which now
  // keeps the full token set, so candidates.length > 1) would make the photo
  // permanently uncacheable and re-bill BOTH tiers on every retake for the
  // 90-day TTL (review, PR #354). The unsettled case stays exactly what it
  // was: an error left the funnel undecided, so nothing is cached.
  const settled = !tier2Failed && (!errors.length || candidates.length === 1 || preferred !== null);
  if (settled) {
    try {
      await cacheRef.set(buildOcrCacheRecord({
        candidates, source, nowMs, tokens, preferred,
        extras: { colourway: colorway, upc, modelName },
      }));
    } catch (err) {
      console.warn(`readStyleCodeLabel: OCR cache write failed for ${hash}:`, err && err.message);
    }
  }

  // Tier 2's union can CHANGE the candidate set, so the rule consulted before
  // tier 2 may no longer key this layout — re-consult only in that case.
  if (candidates.length > 1 && !layout.autoPick && tier2Used) {
    layout = await consultLayoutRule(db, candidates);
  }
  return {
    candidates,
    displayCandidates: candidates.map(formatStyleCodeForDisplay),
    autoPick: layout.autoPick,
    autoPickDisplay: layout.autoPick ? formatStyleCodeForDisplay(layout.autoPick) : null,
    layoutKey: layout.layoutKey,
    // Tier 2's pick, when it fired — the client resolves with it exactly as it
    // does with autoPick, but the wording can say "read", not "learned".
    preferred,
    preferredDisplay: preferred ? formatStyleCodeForDisplay(preferred) : null,
    tokens,
    colorway, upc, modelName,
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
    // REJECT, do not relabel. Silently calling an unsupported type "image/jpeg"
    // sends bytes the providers cannot decode and bills us for the failure,
    // while the operator is told nothing useful. An absent mimeType is the one
    // tolerated case — the client always sends JPEG. (CodeRabbit, PR #312.)
    if (mimeType != null && !ALLOWED_MIME.includes(mimeType)) {
      throw new HttpsError("invalid-argument", `Unsupported image type: ${mimeType}`);
    }
    const mime = mimeType || "image/jpeg";

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
