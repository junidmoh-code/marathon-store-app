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

// ── READING A HANDLE OUT OF AN OLD REFUSAL, AND ONLY AN OLD ONE ──────────────
// The reconciler now records the handle a collision was about as a FIELD
// (`blockedHandle`), because parsing prose for it is a feature that breaks the
// next time somebody edits the wording — and it did exactly that: the first
// version of this work rewrote the refusal sentence and left this reader
// matching a string the code no longer emitted, with its own tests green
// against the dead string (architect review, 2026-08-28).
//
// This parser survives for the blocks ALREADY IN THE DATABASE, written by the
// build that is live today. That is not a hypothetical set — it is the row on
// Junid's screen:
//
//   Shopify product gid://shopify/Product/9338746241173 already owns handle
//   "sneaker-black" (an orphan from a crashed run, or a legacy/twin product)
//
// Both wordings are matched, old and new, so a block recorded by either build
// is read correctly. Anything else — a compliance refusal, a missing-condition
// refusal — returns null and the block stands as recorded.
//
// NEVER a lookbehind: a parse-time SyntaxError in this bundle blanks the whole
// app on Safari below 16.4.
const HANDLE_IN_REASON = [
  /already owns handle "([a-z0-9-]+)"/,                       // the build live today
  /the web address this name would use \("([a-z0-9-]+)"\)/,   // this build's wording
];

export function handleInBlockedReason(reason) {
  const text = String(reason ?? "");
  for (const re of HANDLE_IN_REASON) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
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
export function staleHandleBlock(recordedReason, effectiveName, recordedHandleField = null) {
  // The FIELD wins. It is written by the code that made the refusal, it cannot
  // be broken by an edit to the sentence, and it is null on every refusal that
  // was not a collision — so it never claims a compliance block was about a
  // name. The parser is the fallback for blocks recorded before the field
  // existed.
  const recordedHandle = recordedHandleField || handleInBlockedReason(recordedReason);
  if (!recordedHandle) return { stale: false, recordedHandle: null, wantedHandle: null };
  const wantedHandle = handleFromName(effectiveName);
  if (!wantedHandle) return { stale: false, recordedHandle, wantedHandle: null };
  return { stale: wantedHandle !== recordedHandle, recordedHandle, wantedHandle };
}
