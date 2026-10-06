// ─── MEDIA HASH INDEX — THE DECISION, WITHOUT FIREBASE ───────────────────────
// 240 products once showed ANOTHER product's photo, most likely a phone's
// gallery picker landing on the wrong shot. Multi-select makes that easier to
// repeat, so every new publishing upload (photo or video) is hashed (SHA-256 of
// the exact bytes picked) and claimed here BEFORE its bytes go to Storage. An
// exact file already owned by a DIFFERENT product is refused, naming that
// product.
//
// The index is one small node, /shopify_sync/_mediaHash/{sha256} =
// { pid, at, uid, kind } — server-only (/shopify_sync is .read/.write false in
// the live rules; the Admin SDK writes it), keyed by the hash, so a lookup is
// one child read and never a scan of /products or /shopify_publish.
//
// OWNERSHIP FOLLOWS USE. A claim is not for ever: if the owning product no
// longer carries that hash in its own media list (Junid removed the wrong
// photo from it, or the upload that claimed it never finished), the claim
// moves to the product asking now. Checking that reads ONE node — the owner's
// /shopify_publish/{pid}/media — never anything wider.
//
// AN UPLOAD IN FLIGHT COUNTS AS USE. A claim younger than CLAIM_HOLD_MS is
// held even though the owner's list does not carry the file yet (its bytes
// may still be uploading) — otherwise two products could each take the same
// file within the same few minutes and both keep it.
"use strict";

const MEDIA_HASH_ROOT = "shopify_sync/_mediaHash";
const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

/** Validate the call's arguments → { pid, sha, kind } or { problem }. */
function parseClaimArgs(data) {
  const pid = typeof data?.productId === "string" ? data.productId : "";
  // THE EMPTY-PID GUARD. An empty id would turn `products/${pid}` into a read
  // of the whole /products node — the exact bug caught once before.
  if (!PID_RE.test(pid)) return { problem: "Which product? (no valid product id was sent)" };
  const sha = typeof data?.sha256 === "string" ? data.sha256.toLowerCase() : "";
  if (!SHA_RE.test(sha)) return { problem: "The file's fingerprint is missing or malformed." };
  const kind = data?.kind === "video" ? "video" : "photo";
  return { pid, sha, kind };
}

/** Does this /shopify_publish/{pid}/media value carry the hash? (array or object shape) */
function mediaHasHash(media, sha) {
  if (!media || typeof media !== "object") return false;
  const items = Array.isArray(media) ? media : Object.values(media);
  return items.some((m) => m && typeof m === "object" && m.sha256 === sha);
}

/**
 * The verdict for a claim, from what is stored now.
 *   existing    — the index entry ({ pid, ... }) or null
 *   ownerUses   — does the existing owner's media list still carry the hash?
 * → { claim: true } | { claim: false, ownerPid }
 */
const CLAIM_HOLD_MS = 15 * 60 * 1000;
function decideClaim({ pid, existing, ownerUses, now = Date.now() }) {
  if (!existing || !existing.pid || existing.pid === pid) return { claim: true };
  const fresh = Number(existing.at) > 0 && now - Number(existing.at) < CLAIM_HOLD_MS;
  if (!ownerUses && !fresh) return { claim: true };
  return { claim: false, ownerPid: existing.pid, inFlight: !ownerUses };
}

/** May this signed-in user edit Shopify publishing? Mirrors the live /shopify_publish/$pid write rule. */
function maySetPublishing(token, userRecord) {
  if (!token || token.firebase?.sign_in_provider === "anonymous") return false;
  if (token.email === "gunidmoh@gmail.com") return true;
  if (userRecord?.stockRole === "admin") return true;
  return userRecord?.permFlags?.shopify_publish === true;
}

module.exports = { CLAIM_HOLD_MS, MEDIA_HASH_ROOT, PID_RE, SHA_RE, parseClaimArgs, mediaHasHash, decideClaim, maySetPublishing };
