// ─── processStyleCodeCapture — THE QUEUE WORKER ──────────────────────────────
// Fires on a new /style_code_captures/{captureId}. The client only ever ENQUEUES
// (it cannot write `status` — the rules reserve that for admins), and this
// function does everything that follows: resolve the code, compare the catalogue
// photo against the product's own photo, decide, and write the outcome.
//
// ── WHY A QUEUE AND NOT A CALLABLE ───────────────────────────────────────────
// The displayChecks subtree is READ-ONLY to the client — it has .read rules and
// no .write rule anywhere, because every write to it already goes through a
// Cloud Function with the Admin SDK. So the display-check UI cannot write its
// capture there. It writes to /style_code_captures instead, which staff CAN
// create (create-once), and this trigger picks it up. Same shape as the existing
// pos/storeCreditQueue.
//
// ── THE GUARANTEE ────────────────────────────────────────────────────────────
// Capturing a code on an EXISTING product writes the CODE, the label photo and
// the resolved data into PENDING fields. It NEVER overwrites the live name,
// image or category. The decision itself is pure and lives in
// lib/style-code-capture.cjs, where a test asserts the forbidden fields cannot
// appear in the product patch.
//
// BOTH OUTCOMES ARE LOGGED — agreement and disagreement. A silent auto-confirm
// is indistinguishable from a bug that never ran.
//
// DEPLOY (scoped, when the owner chooses to):
//   firebase deploy --only functions:processStyleCodeCapture

"use strict";

const { onValueCreated } = require("firebase-functions/v2/database");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const {
  CAPTURES_PATH,
  captureDecision,
  comparable,
} = require("../lib/style-code-capture.cjs");
const { SNEAKER_MODELS_PATH } = require("../lib/style-code-providers.cjs");
const { normaliseStyleCode } = require("../lib/style-code.cjs");
const { STYLE_CODE_INDEX_PATH } = require("./resolveStyleCode.js");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const geminiApiKey = defineSecret("GEMINI_API_KEY");

// Same model constant as the label read — one place to swap it. No
// temperature/top_p/top_k: deprecated on the 3.x models.
const COMPARE_MODEL = "gemini-3.6-flash";
const COMPARE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${COMPARE_MODEL}:generateContent`;
const COMPARE_TIMEOUT_MS = 30000;
const COMPARE_MAX_BYTES = 6 * 1024 * 1024;

const COMPARE_PROMPT = [
  "You are shown TWO photographs of footwear.",
  "IMAGE 1 is a product photo from our own catalogue.",
  "IMAGE 2 is the official catalogue photo for a manufacturer style code.",
  "",
  "Decide whether they are THE SAME PRODUCT — same model AND same colourway.",
  "",
  "Be strict about colourway. The same silhouette in a different colour is a",
  "DIFFERENT product with a different style code, and treating them as the same",
  "is the exact error this check exists to catch.",
  "Ignore differences in background, lighting, angle, shadow and image quality.",
  "",
  "If you are not confident, say sameProduct false with a low confidence — a",
  "human will look. Never guess to be helpful.",
].join("\n");

const COMPARE_SCHEMA = {
  type: "OBJECT",
  properties: {
    sameProduct: { type: "BOOLEAN" },
    confidence: { type: "NUMBER" },
    reason: { type: "STRING" },
  },
  required: ["sameProduct", "confidence"],
};

async function fetchImageBase64(url, fetchImpl) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const res = await doFetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > COMPARE_MAX_BYTES) throw new Error("image too large to compare");
  const ct = (res.headers.get && (res.headers.get("content-type") || "")).toLowerCase();
  const mime = ct.includes("png") ? "image/png" : ct.includes("webp") ? "image/webp" : "image/jpeg";
  return { data: buf.toString("base64"), mime };
}

/**
 * The vision comparison. Returns null when it could not be performed — which
 * the decision treats as "needs a human", never as agreement.
 */
async function compareImages(productUrl, catalogueUrl, apiKey, { fetchImpl, imageFetch } = {}) {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const [a, b] = await Promise.all([
    fetchImageBase64(productUrl, imageFetch),
    fetchImageBase64(catalogueUrl, imageFetch),
  ]);
  const res = await doFetch(`${COMPARE_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: "IMAGE 1 — our catalogue photo:" },
          { inline_data: { mime_type: a.mime, data: a.data } },
          { text: "IMAGE 2 — the official photo for the style code:" },
          { inline_data: { mime_type: b.mime, data: b.data } },
          { text: COMPARE_PROMPT },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", responseSchema: COMPARE_SCHEMA },
    }),
    signal: AbortSignal.timeout(COMPARE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
  const payload = await res.json();
  const text = ((((payload.candidates || [])[0] || {}).content || {}).parts || [])
    .map((p) => p && p.text).filter(Boolean).join("");
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed.sameProduct !== "boolean") return null;
  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  return {
    sameProduct: parsed.sameProduct,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

/**
 * Claim the style-code index create-once from the SERVER.
 *
 * The Admin SDK bypasses rules, so the create-once guarantee has to be
 * reimplemented here rather than inherited — a plain set() would silently
 * steal a code another product already owns. A transaction gives the same
 * "first writer wins" semantics the rule gives the client.
 *
 * @returns {{claimed:boolean, ownerId:string|null}}
 */
async function claimIndexServerSide(db, normalised, productId, uid, nowMs) {
  const ref = db.ref(`${STYLE_CODE_INDEX_PATH}/${normalised}`);
  const res = await ref.transaction((cur) => {
    if (cur) return undefined;             // occupied — abort, do NOT overwrite
    const claim = { productId, claimedAt: nowMs };
    if (uid) claim.claimedBy = uid;
    return claim;
  });
  const val = res.snapshot.val();
  const ownerId = val && typeof val.productId === "string" ? val.productId : null;
  return { claimed: !!res.committed && ownerId === productId, ownerId };
}

/**
 * The worker core — injectable IO so every branch is testable without
 * firebase-admin, a network, or a vision model.
 */
async function runCapture(db, captureId, capture, {
  nowMs, geminiKey, compareFn, resolveFn,
}) {
  const capturesRef = db.ref(`${CAPTURES_PATH}/${captureId}`);

  const normalised = normaliseStyleCode(capture && capture.styleCodeNormalised);
  const productId = capture && capture.productId;
  const product = productId ? (await db.ref(`products/${productId}`).get()).val() : null;

  // The code's catalogue identity. Prefer the permanent cache; only ask the
  // resolver (which can reach the metered API) when the cache is empty.
  let model = normalised ? (await db.ref(`${SNEAKER_MODELS_PATH}/${normalised}`).get()).val() : null;
  if (!model && resolveFn) {
    try { model = await resolveFn(normalised); } catch (err) {
      console.warn(`processStyleCodeCapture: resolve failed for ${normalised}:`, err && err.message);
    }
  }

  // ── THE COMPARISON ────────────────────────────────────────────────────────
  // Only attempted when both images exist. A failure yields null, and null
  // routes to review — "could not check" is never "checked and passed".
  let comparison = null;
  let comparisonError = null;
  if (comparable(product, model)) {
    try {
      comparison = compareFn
        ? await compareFn(product.photoUrl, model.imageUrl)
        : await compareImages(product.photoUrl, model.imageUrl, geminiKey);
    } catch (err) {
      comparisonError = (err && err.message) || String(err);
      console.warn(`processStyleCodeCapture: comparison failed for ${captureId}:`, comparisonError);
    }
  }

  const decision = captureDecision({ capture, product, model, comparison, nowMs });

  if (decision.kind === "reject") {
    // Rejections are recorded, not dropped. A capture that vanished with no
    // trace is indistinguishable from one that was never made.
    await capturesRef.update({
      status: "rejected",
      review: { reason: decision.code, decidedAt: nowMs },
    });
    console.log(`processStyleCodeCapture: ${captureId} REJECTED (${decision.code})`);
    return { kind: "rejected", code: decision.code };
  }

  // ── Stamp the CODE onto the product, claiming the index first ─────────────
  let stamped = false;
  let claimConflict = null;
  if (decision.stampCode) {
    const claim = await claimIndexServerSide(db, normalised, productId, capture.capturedBy, nowMs);
    if (claim.claimed) {
      await db.ref(`products/${productId}`).update(decision.productPatch);
      stamped = true;
    } else {
      // Another product owns this code. Do not stamp, do not merge — flag it.
      claimConflict = claim.ownerId;
      console.warn(`processStyleCodeCapture: ${normalised} already claimed by ${claim.ownerId}, not stamping ${productId}`);
    }
  }

  // ── The SUGGESTION goes to pending, never to the live fields ──────────────
  await db.ref(`products/${productId}/pendingStyleCode`).set({
    ...decision.pending,
    captureId,
    ...(claimConflict ? { claimConflictWith: claimConflict, status: "needsReview", reviewReason: "code-claimed-elsewhere" } : {}),
    ...(comparisonError ? { comparisonError: String(comparisonError).slice(0, 300) } : {}),
  });

  const finalStatus = claimConflict ? "needsReview" : decision.status;
  await capturesRef.update({
    status: finalStatus,
    review: {
      reason: claimConflict ? "code-claimed-elsewhere" : decision.reviewReason,
      confidence: decision.pending.comparedConfidence,
      stamped,
      decidedAt: nowMs,
    },
  });

  // ── LOG BOTH OUTCOMES ─────────────────────────────────────────────────────
  // Agreement is logged as loudly as disagreement. An auto-confirm nobody can
  // see is indistinguishable from a function that silently stopped running.
  console.log(
    `processStyleCodeCapture: ${captureId} ${finalStatus} — product=${productId} code=${normalised} ` +
    `reason=${claimConflict ? "code-claimed-elsewhere" : decision.reviewReason} ` +
    `confidence=${decision.pending.comparedConfidence} stampedCode=${stamped} origin=${capture.origin}`
  );

  return { kind: "decided", status: finalStatus, stamped, claimConflict, comparison };
}

exports.runCapture = runCapture;
exports.compareImages = compareImages;
exports.claimIndexServerSide = claimIndexServerSide;
exports.COMPARE_MODEL = COMPARE_MODEL;

exports.processStyleCodeCapture = onValueCreated(
  {
    ref: `/${CAPTURES_PATH}/{captureId}`,
    region: "europe-west1",
    secrets: [geminiApiKey],
    memory: "512MiB",
    timeoutSeconds: 120,
  },
  async (event) => {
    const capture = event.data.val();
    // The client cannot write `status` (rules), so a record that arrives with
    // one was written by an admin tool — leave it alone rather than re-deciding.
    if (!capture || capture.status) return;
    await runCapture(admin.database(), event.params.captureId, capture, {
      nowMs: Date.now(),
      geminiKey: geminiApiKey.value(),
    });
  }
);
