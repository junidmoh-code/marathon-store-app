// ─── THE STOREFRONT HANDLE, AND READING ONE BACK OUT OF A REFUSAL ────────────
// A Shopify handle is the product's public URL slug, derived from its cleaned
// listing title and nothing else. compliance.mjs's buildHandle is THIS
// function — it imports from here rather than keeping a second copy, because
// the browser now has to answer a question that needs the exact same slug the
// reconciler would build: *is this recorded refusal still about this product?*
//
// WHY THAT QUESTION EXISTS. When the reconciler cannot create a product because
// something on Shopify already owns the handle it wants, it records the refusal
// verbatim and consumes the intent — a block only clears when somebody
// publishes again. So a product blocked in August under the name
// "Sneaker Roam Brown" still shows August's sentence today, naming a handle
// (`sneaker-roam-brown`) that its CURRENT name — "Toggle-lace chunky runner
// with ribbed midfoot cage" — no longer produces. The collision the block
// describes cannot happen any more. The row was telling the truth about a
// product that no longer exists.
//
// Deliberately dependency-free: loaded by the browser bundle AND by the
// Admin-SDK scripts under plain Node ESM.

/**
 * The slug Shopify would carry for this title. Lowercase alphanumerics, single
 * hyphens, no leading or trailing hyphen.
 *
 * Returns "" for a title that yields nothing — the callers here want an answer,
 * not an exception. compliance.mjs's buildHandle wraps this and throws, because
 * on the push path an empty handle must stop the push.
 */
export function handleFromName(cleanTitle) {
  return String(cleanTitle ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The handle named inside a recorded handle-collision refusal. The reconciler
// writes exactly one shape, and this reads exactly that shape back:
//
//   … already owns handle "sneaker-roam-brown" …
//
// Anything else — a compliance refusal, a missing-condition refusal, a reason
// written by an older build — returns null, and the block stands as recorded.
// NEVER a lookbehind: a parse-time SyntaxError in this bundle blanks the whole
// app on Safari below 16.4.
const HANDLE_IN_REASON = /already owns handle "([a-z0-9-]+)"/;

export function handleInBlockedReason(reason) {
  const m = HANDLE_IN_REASON.exec(String(reason ?? ""));
  return m ? m[1] : null;
}

/**
 * Is this node's recorded block STALE — i.e. does it describe a handle
 * collision under a name the product no longer has?
 *
 * → { stale, recordedHandle, wantedHandle }
 *
 * `stale` is true ONLY when the reason names a handle AND the current
 * effective name produces a different, non-empty one. Every other case is
 * false, and false means the block stands: this must never talk a product
 * past a refusal it would hit again. The reconciler re-validates everything at
 * apply time regardless — this only decides what the row SAYS.
 */
export function staleHandleBlock(recordedReason, effectiveName) {
  const recordedHandle = handleInBlockedReason(recordedReason);
  if (!recordedHandle) return { stale: false, recordedHandle: null, wantedHandle: null };
  const wantedHandle = handleFromName(effectiveName);
  if (!wantedHandle) return { stale: false, recordedHandle, wantedHandle: null };
  return { stale: wantedHandle !== recordedHandle, recordedHandle, wantedHandle };
}
