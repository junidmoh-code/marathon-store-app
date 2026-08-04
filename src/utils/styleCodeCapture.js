// ─── STYLE CODE CAPTURE (client) — ENQUEUE, NEVER DECIDE ─────────────────────
// A staff member confirming a display can also capture the style code off the
// tongue label. The client's entire job is to ENQUEUE that observation. It does
// not resolve the code, does not compare images, does not decide anything, and
// above all does not touch the product.
//
// ── WHY A QUEUE ──────────────────────────────────────────────────────────────
// Two reasons, and either alone would be sufficient:
//   1. The displayChecks subtree is READ-ONLY to the client — it has .read rules
//      and no .write rule anywhere, because every write to it already goes
//      through a Cloud Function with the Admin SDK. The capture cannot live
//      there.
//   2. The rules reserve `status` and `review` on a capture for admins, and only
//      after the record exists. So the client CANNOT write a status — which is
//      exactly right: deciding is the server's job.
// The record is create-once for staff. processStyleCodeCapture picks it up.
//
// ── WHAT THE RULES VALIDATE ──────────────────────────────────────────────────
// /style_code_captures/$captureId
//   required: styleCodeNormalised, capturedBy (=== auth.uid), capturedAt, origin
//   origin:   addSneaker | displayCheck | receiving | admin
//   labelPhotoUrl must begin with https://
// buildCapture() constructs the object field by field so a stray key cannot
// ride along and fail the write — and a failed write here would look, from the
// shop floor, like a button that simply does nothing.

import { ref, push, set } from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { database, storage } from "../firebase";
import { normaliseStyleCode, formatStyleCodeForDisplay } from "./styleCode";

export const CAPTURES_PATH = "style_code_captures";
export const CAPTURE_ORIGINS = ["addSneaker", "displayCheck", "receiving", "admin"];

/** EXACTLY the permitted fields. No status — the client may not write one. */
export function buildCapture({ normalised, styleCode, productId, uid, nowMs, origin, labelPhotoUrl }) {
  const rec = {
    styleCodeNormalised: normalised,
    capturedBy: String(uid),
    capturedAt: Number(nowMs),
    origin,
    productId: String(productId),
    styleCode: styleCode || formatStyleCodeForDisplay(normalised),
  };
  // Must be https:// or the rules reject the write. A local blob/data URL that
  // slipped through would fail the whole capture, so it is dropped instead.
  if (typeof labelPhotoUrl === "string" && /^https:\/\//i.test(labelPhotoUrl)) {
    rec.labelPhotoUrl = labelPhotoUrl;
  }
  return rec;
}

/**
 * Enqueue a style-code capture against an existing product.
 *
 * @returns {Promise<{ok:true, captureId:string, normalised:string} | {ok:false, error:string}>}
 */
export async function enqueueStyleCodeCapture({ code, productId, uid, origin = "displayCheck", labelPhoto, nowMs }) {
  const normalised = normaliseStyleCode(code);
  if (!normalised) return { ok: false, error: "Enter a style code first." };
  if (!productId) return { ok: false, error: "No product to attach this code to." };
  if (!uid) return { ok: false, error: "You need to be signed in to capture a style code." };
  if (!CAPTURE_ORIGINS.includes(origin)) return { ok: false, error: "Invalid capture origin." };

  // Reserve the id first, so the label photo can be named after the capture it
  // belongs to and a retry cannot orphan a second copy of the same image.
  const captureRef = push(ref(database, CAPTURES_PATH));
  const captureId = captureRef.key;

  // Best-effort: the photo is evidence, the CODE is the point. A failed upload
  // must not cost us the capture.
  let labelPhotoUrl = null;
  if (labelPhoto && labelPhoto.blob) {
    try {
      // products/ is the only Storage prefix staff may write to (storage.rules
      // has no catch-all), so label photos live under the product they belong to.
      const sRef = storageRef(storage, `products/${productId}/labels/${captureId}.jpg`);
      await uploadBytes(sRef, labelPhoto.blob, {
        contentType: "image/jpeg",
        cacheControl: "public, max-age=31536000, immutable",
      });
      labelPhotoUrl = await getDownloadURL(sRef);
    } catch (err) {
      console.warn("label photo upload failed (capture continues):", err);
    }
  }

  try {
    await set(captureRef, buildCapture({
      normalised, styleCode: code, productId, uid, nowMs, origin, labelPhotoUrl,
    }));
    return { ok: true, captureId, normalised };
  } catch (err) {
    return {
      ok: false,
      error: (err && /permission/i.test(String(err.message)))
        ? "You don't have permission to capture style codes. Nothing was saved."
        : "Couldn't save that style code. Nothing was changed on the product.",
    };
  }
}

/**
 * Catalogue progress: how many products now carry a confirmed style code.
 *
 * Pure, so the counting rule is testable and stated once.
 *   withCode     — a styleCodeNormalised is stamped on the product
 *   needsReview  — a pending capture a human still has to look at
 *   confirmed    — stamped AND not awaiting review. This is the number that
 *                  answers "how far through are we".
 * A product is never counted as confirmed merely because a suggestion exists;
 * `autoConfirmed` pending data still counts, because the CODE itself is settled
 * even while the suggested name and photo wait for approval.
 */
export function styleCodeProgress(products) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  let withCode = 0, needsReview = 0;
  for (const p of list) {
    if (normaliseStyleCode(p.styleCodeNormalised)) withCode++;
    if (p.pendingStyleCode && p.pendingStyleCode.status === "needsReview") needsReview++;
  }
  const total = list.length;
  const confirmed = Math.max(0, withCode - needsReview);
  return {
    total,
    withCode,
    needsReview,
    confirmed,
    pct: total ? Math.round((confirmed / total) * 100) : 0,
  };
}

/** Only footwear needs a style code — clothing and perfume have none. */
export function styleCodeProgressForFootwear(products) {
  return styleCodeProgress((Array.isArray(products) ? products : []).filter(
    (p) => p && (p.productType === "sneaker" || p.category === "Footwear"),
  ));
}
