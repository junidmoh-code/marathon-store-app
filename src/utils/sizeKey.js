// ─── RTDB-key-safe size encoder/decoder ───────────────────────────────────────
// Firebase RTDB rejects any key containing ".", "#", "$", "/", "[", "]" (and
// treats them as path separators / special). Shoe half-sizes are the trigger:
// "5.5", "6.5", … blow up a /stock (and /inventory) write — the same bug PR #36
// fixed on the POS side.
//
// CROSS-APP CONTRACT: this is the SAME encoding marathon-pos-app uses in
// src/shared/sizeKey.js — `replace(/[.#$[\]/\s]/g, "_")` — which itself mirrors the
// long-standing store-app convention in App.jsx. Both apps therefore key /stock and
// /inventory with identical size keys (e.g. "5.5" → "5_5"). Do NOT introduce a
// second scheme; import from here.
//
// Round-trip: decodeSizeKey(encodeSizeKey(s)) === s for realistic sizes. The encode
// is technically lossy (every illegal char collapses to "_"), but "." is the only
// one that appears in a real size, so the decode (digit_digit → digit.digit) is
// lossless in practice and leaves "M"/"XL"/the "_" no-size sentinel untouched.

const ILLEGAL_RTDB_CHARS = /[.#$[\]/\s]/g;

export function encodeSizeKey(size) {
  // Coerce numeric sizes (e.g. 5.5) to a string first — otherwise a number would
  // pass through unencoded and "." would still reach the RTDB key. (Superset of
  // the POS encoder, which is only ever called with strings; the string-encoding
  // result is byte-identical.)
  if (typeof size === "number") size = String(size);
  if (typeof size !== "string") return size;
  return size.replace(ILLEGAL_RTDB_CHARS, "_");
}

export function decodeSizeKey(key) {
  if (typeof key !== "string") return key;
  // Only convert underscores between two digits ("5_5" → "5.5"); a broad
  // replace(/_/g, ".") would mis-decode "ONE_SIZE" and the "_" sentinel.
  return key.replace(/(\d)_(\d)/g, "$1.$2");
}

// The /stock cell size key. A one-size / null / empty size maps to the "_"
// sentinel — byte-identical to the POS (engineBuild.js: `size == null ? "_" :
// encodeSizeKey(size)`), so a one-size item's POS sale and the store-app Set Qty
// hit the SAME cell. Empty string is also folded to "_" (an empty RTDB key is
// invalid). Everything else is dot-free-encoded.
export function stockSizeKey(size) {
  if (size == null || size === "") return "_";
  return encodeSizeKey(size);
}

// The single construction point for a /stock balance-cell path. Every writer and
// the read-modify path in applyMovement build the key through here, so a half-size
// or one-size can never reach RTDB un-encoded.
export function stockCellPath(loc, productId, size) {
  return `stock/${loc}/${productId}/${stockSizeKey(size)}`;
}
