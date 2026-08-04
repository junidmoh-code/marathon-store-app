// ─── STYLE CODE CAPTURE — THE DECISION, IN PURE FORM ─────────────────────────
// A staff member confirming a display can also capture the style code off the
// tongue label. That capture is a QUEUE ENTRY, not a product edit: the client
// writes /style_code_captures/{captureId} and a Cloud Function decides what it
// means. This module is that decision, with no IO, so every branch is testable.
//
// ── THE RULE THIS FILE ENFORCES ──────────────────────────────────────────────
// CAPTURING A CODE ON AN EXISTING PRODUCT NEVER TOUCHES ITS NAME, IMAGE OR
// CATEGORY. Not on agreement, not on high confidence, not ever. Those three
// fields are what staff and the POS recognise a product BY; a catalogue that
// silently renames itself overnight is worse than one with gaps, because nobody
// can trust what they are reading.
//
// So the decision splits cleanly in two:
//   • THE CODE       — an identity key the product did not have. Stamped onto
//                      the product, but only into an EMPTY slot, and only once
//                      (styleCodeNormalised is immutable by rule).
//   • THE SUGGESTION — a name, a photo, a brand from an external catalogue.
//                      Goes to `pendingStyleCode` and stays there until a human
//                      decides. `autoConfirmed` means "two images agreed, a
//                      human can approve this quickly" — NOT "applied".
//
// ── WHY DISAGREEMENT IS NOT THE ONLY REVIEW TRIGGER ──────────────────────────
// The comparison can also be IMPOSSIBLE — the product has no photo, or the
// catalogue returned none. "Could not check" must route to review exactly like
// "checked and disagreed". Treating an unverifiable match as agreement would
// auto-confirm precisely the products we know least about.

"use strict";

const { normaliseStyleCode } = require("./style-code.cjs");

const CAPTURES_PATH = "style_code_captures";

// Rules-validated enums. A value outside these is rejected at write time and
// looks like a silent no-op, so they are the contract, not a preference.
const ORIGINS = ["addSneaker", "displayCheck", "receiving", "admin"];
const STATUSES = ["pending", "autoConfirmed", "needsReview", "applied", "rejected"];

// Two images "agree" only above this. The number is deliberately high: the cost
// of a wrong auto-confirm is a mislabelled product nobody re-checks, while the
// cost of an unnecessary review is one person spending three seconds.
const AGREEMENT_MIN_CONFIDENCE = 0.8;

/**
 * Validate a queue entry before anything acts on it.
 * @returns {{ok:true, normalised:string} | {ok:false, code:string}}
 */
function validateCapture(capture) {
  if (!capture || typeof capture !== "object") return { ok: false, code: "malformed" };
  const normalised = normaliseStyleCode(capture.styleCodeNormalised);
  if (!normalised) return { ok: false, code: "bad-style-code" };
  if (!capture.capturedBy || typeof capture.capturedBy !== "string") return { ok: false, code: "no-actor" };
  if (!ORIGINS.includes(capture.origin)) return { ok: false, code: "bad-origin" };
  if (!capture.productId || typeof capture.productId !== "string") return { ok: false, code: "no-product" };
  return { ok: true, normalised };
}

/**
 * Can these two images even be compared?
 * Both must exist, or the answer is "we don't know" — which is a review, not a pass.
 */
function comparable(product, model) {
  return !!(product && product.photoUrl && model && model.imageUrl);
}

/**
 * The whole decision.
 *
 * @param {object} args
 *   capture     the queue entry
 *   product     the live /products record (or null if it vanished)
 *   model       the resolved /sneaker_models record (or null — not in catalogue)
 *   comparison  { sameProduct:boolean, confidence:number, reason:string } | null
 *   nowMs
 *
 * @returns {{
 *   kind: "reject", code: string
 * } | {
 *   kind: "apply",
 *   status: string,                     // autoConfirmed | needsReview
 *   reviewReason: string,               // why, in words, for the log and the queue
 *   stampCode: boolean,                 // write the code onto the product?
 *   productPatch: object,               // ONLY code + provenance. NEVER name/photo/category.
 *   pending: object                     // the suggestion, awaiting a human
 * }}
 */
function captureDecision({ capture, product, model, comparison, nowMs }) {
  const valid = validateCapture(capture);
  if (!valid.ok) return { kind: "reject", code: valid.code };
  if (!product) return { kind: "reject", code: "product-missing" };

  const normalised = valid.normalised;
  const existing = normaliseStyleCode(product.styleCodeNormalised);

  // The product already carries a DIFFERENT code. styleCodeNormalised is
  // immutable by rule and this is not ours to resolve — a human must decide
  // which label is right. Never overwrite, never "correct".
  if (existing && existing !== normalised) {
    return { kind: "reject", code: "code-conflict" };
  }

  // ── Agreement ────────────────────────────────────────────────────────────
  const canCompare = comparable(product, model);
  const agreed = !!(comparison && comparison.sameProduct === true
    && Number(comparison.confidence) >= AGREEMENT_MIN_CONFIDENCE);

  let status;
  let reviewReason;
  if (!model) {
    status = "needsReview";
    reviewReason = "no-catalogue-match";
  } else if (!canCompare) {
    // "Could not check" is NOT "checked and passed". Auto-confirming here would
    // rubber-stamp exactly the products we have the least evidence about.
    status = "needsReview";
    reviewReason = product && product.photoUrl ? "catalogue-image-missing" : "product-image-missing";
  } else if (agreed) {
    status = "autoConfirmed";
    reviewReason = "images-agree";
  } else {
    status = "needsReview";
    reviewReason = comparison ? "images-disagree" : "comparison-unavailable";
  }

  // ── What goes ON the product: the CODE and its provenance. Nothing else. ──
  // Only into an empty slot: styleCodeNormalised is immutable once set.
  const stampCode = !existing;
  const productPatch = stampCode ? {
    styleCode: capture.styleCode || normalised,
    styleCodeNormalised: normalised,
    styleCodeSource: model ? "api" : "manual",
    styleCodeFetchedAt: nowMs,
    styleCodeConfirmedBy: capture.capturedBy,
    ...(capture.labelPhotoUrl ? { styleCodeLabelPhoto: capture.labelPhotoUrl } : {}),
  } : {};

  // ── What goes in PENDING: the suggestion, for a human. ────────────────────
  // suggestedName / suggestedImageUrl are deliberately named "suggested". No
  // reader may treat them as the product's name or photo.
  const pending = {
    styleCodeNormalised: normalised,
    status,
    reviewReason,
    capturedBy: capture.capturedBy,
    capturedAt: Number(capture.capturedAt) || nowMs,
    origin: capture.origin,
    decidedAt: nowMs,
    suggestedName: model ? ([model.brand, model.model, model.colorwayName].filter(Boolean).join(" ").trim() || null) : null,
    suggestedBrand: (model && model.brand) || null,
    suggestedImageUrl: (model && model.imageUrl) || null,
    labelPhotoUrl: capture.labelPhotoUrl || null,
    comparedConfidence: comparison && Number.isFinite(Number(comparison.confidence))
      ? Number(comparison.confidence) : null,
    comparisonReason: (comparison && typeof comparison.reason === "string") ? comparison.reason.slice(0, 300) : null,
  };

  return { kind: "apply", status, reviewReason, stampCode, productPatch, pending };
}

/**
 * The fields a capture decision is ALLOWED to write to /products.
 * Exported so a test can assert the live-data fields are not in the list —
 * the guarantee is worth more as an executable check than as a comment.
 */
const ALLOWED_PRODUCT_FIELDS = [
  "styleCode", "styleCodeNormalised", "styleCodeSource",
  "styleCodeFetchedAt", "styleCodeConfirmedBy", "styleCodeLabelPhoto",
];
const FORBIDDEN_PRODUCT_FIELDS = ["name", "photo", "photoUrl", "category", "categoryKey", "subcategory", "productType", "brand"];

module.exports = {
  CAPTURES_PATH,
  ORIGINS,
  STATUSES,
  AGREEMENT_MIN_CONFIDENCE,
  ALLOWED_PRODUCT_FIELDS,
  FORBIDDEN_PRODUCT_FIELDS,
  validateCapture,
  comparable,
  captureDecision,
};
