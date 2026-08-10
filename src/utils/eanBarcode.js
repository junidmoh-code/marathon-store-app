// ─── PRINTED MANUFACTURER BARCODE (EAN-13 / EAN-8 / UPC-A) — pure value model ─
// Perfume arrives with a REAL printed barcode already on the box, and those
// codes are consistent across the stock. Minting a shop code for it is wasted
// work: a label to print, a label to stick, and a second number to reconcile.
// So for perfume we capture the manufacturer's own code instead.
//
// THIS MODULE IS THE GATE. Whatever the source — a 1D symbol decoded off a
// camera frame, digits read by OCR, or an operator typing them in — a code only
// becomes a real identity by passing through normalisePrintedBarcode(). It is
// PURE (no Firebase, no DOM) so the check-digit maths is unit-tested directly.
//
// ── WHY THE CHECK DIGIT IS NON-NEGOTIABLE ────────────────────────────────────
// Every one of these symbologies carries a modulo-10 check digit precisely so a
// misread is caught at the point of reading. An OCR pass that turns an 8 into a
// 3, or a decoder that resolves a smudged bar, produces a number that LOOKS
// like a barcode. Writing it would put a code in /barcodes that no physical box
// on earth carries — invisible until a cashier scans and the POS says "unknown
// product". So nothing is ever accepted without the check digit agreeing, and
// that rule applies to typed entry exactly as it does to the camera.
//
// ── SHOP CODES ARE A DIFFERENT NAMESPACE ─────────────────────────────────────
// Our own minted codes are 8-digit sequential (components/stock/barcode.js).
// These are 8/12/13-digit manufacturer codes. They share the /barcodes index,
// which is deliberately MANY-to-one: several codes may point at one product+size,
// so a captured EAN is an ADDITIONAL entry and never replaces an auto-generated
// one. Any label already stuck on stock keeps scanning.

// The symbologies a perfume box actually carries. EAN-13 is the overwhelming
// majority (all three reference bottles — Honeyed Fantasy 6298750137969, Oud
// Mood 6291106065114, Epic 6291103660466 — are EAN-13); UPC-A appears on US
// stock and EAN-8 on small cartons.
export const PRINTED_BARCODE_LENGTHS = [8, 12, 13];

/**
 * The GS1 modulo-10 check digit for a body of digits (the code WITHOUT its
 * final check digit). Weights alternate 3,1,3,1… from the RIGHTMOST body digit
 * leftwards — the same rule for EAN-8, UPC-A and EAN-13, which is why one
 * function covers all three rather than three near-copies that can drift.
 */
export function eanCheckDigit(body) {
  const digits = String(body ?? "");
  if (!/^\d+$/.test(digits)) return null;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    // Position from the right: 0 → weight 3, 1 → weight 1, alternating.
    const fromRight = digits.length - 1 - i;
    sum += Number(digits[i]) * (fromRight % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** True when a full code's trailing check digit agrees with its body. */
export function hasValidCheckDigit(code) {
  const s = String(code ?? "");
  if (!/^\d{2,}$/.test(s)) return false;
  const expected = eanCheckDigit(s.slice(0, -1));
  return expected != null && expected === Number(s[s.length - 1]);
}

// Refusal reasons, so the UI can say WHICH thing was wrong rather than a single
// blanket "invalid". The operator's next action differs: a wrong length means
// the read was partial (retake), a wrong check digit means a digit was misread
// (retake or type it), and empty means nothing was read at all.
export const REFUSE_EMPTY = "empty";
export const REFUSE_LENGTH = "length";
export const REFUSE_CHECK_DIGIT = "check_digit";

/**
 * THE ONE ENTRY POINT. Raw input (decoded symbol, OCR'd digits, typed text) →
 * an accepted code, or a refusal carrying an operator-readable message.
 *
 * Separators a human types or a decoder emits ("6291 1060 65114", "629-110…")
 * are stripped, because they are print formatting and never part of the number.
 * ANY other character — a letter, a currency symbol — means this was not a
 * barcode reading and is refused on length rather than silently salvaged.
 *
 * @returns {{ok:true, code:string} | {ok:false, reason:string, message:string}}
 */
export function normalisePrintedBarcode(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: REFUSE_EMPTY, message: "No barcode number was read." };

  // Only spaces and hyphens are print formatting. Anything else disqualifies
  // the whole reading — stripping letters out of "EAN 6291106065114X" would
  // invent a code from a string that was never one.
  const digits = text.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || !PRINTED_BARCODE_LENGTHS.includes(digits.length)) {
    return {
      ok: false,
      reason: REFUSE_LENGTH,
      message: `“${text}” is not a printed barcode — those are 13 digits (EAN-13), 12 (UPC-A) or 8 (EAN-8).`,
    };
  }

  if (!hasValidCheckDigit(digits)) {
    return {
      ok: false,
      reason: REFUSE_CHECK_DIGIT,
      message: `${digits} failed its check digit — one of the numbers is wrong. Photograph the barcode again, or type it from the box.`,
    };
  }

  return { ok: true, code: digits };
}

/**
 * Every /barcodes key this one physical code should resolve under.
 *
 * UPC-A and EAN-13 are the SAME number: an EAN-13 beginning with 0 is a UPC-A
 * with the zero written out, and padding it does not change the check digit.
 * Which of the two a scanner reports depends on the scanner, not the box — so a
 * captured UPC-A registers BOTH forms. That is not a duplicate product; it is
 * one product reachable by either spelling of its own code, which is exactly
 * what a many-to-one index is for.
 *
 * EAN-13 and EAN-8 have no such twin and register as themselves alone.
 */
export function indexCodesFor(code) {
  const s = String(code ?? "");
  if (!/^\d+$/.test(s)) return [];
  if (s.length === 12) return [s, `0${s}`];
  return [s];
}

// ─── WHAT AN ALREADY-INDEXED CODE MEANS ──────────────────────────────────────
// /barcodes/$code is CREATE-ONLY under client auth, and its .validate requires
// the referenced product to exist. A code already in the index therefore CANNOT
// be overwritten from the app — an attempt is simply denied, and a denied write
// that nobody checks looks exactly like a successful one. So the index is READ
// first and the answer decides the flow, rather than a write being fired hopefully.
//
// Three outcomes, and there is no fourth:
//   "free"     no entry (or only entries we already own that are incomplete) →
//              register the missing ones.
//   "already"  every form of this code already points at THIS product → nothing
//              to do; say so and move on. Not an error.
//   "conflict" some form points at a DIFFERENT product → the same printed code
//              on two records means one physical product exists twice in the
//              catalogue. Refuse, and hand it to the duplicate flow.
export const PRINTED_FREE = "free";
export const PRINTED_ALREADY = "already";
export const PRINTED_CONFLICT = "conflict";

/**
 * Decide from index readings alone. PURE — the caller does the reads.
 *
 * @param {Array<{code:string, productId:(string|null)}>} owners one entry per
 *        index code, productId null when the slot is free.
 * @param {string|null} productId the product being captured for; null while
 *        creating a product that does not exist yet (every existing owner is
 *        then, by definition, a different product).
 */
export function printedBarcodeOutcome(owners, productId) {
  const rows = Array.isArray(owners) ? owners : [];
  // A conflict outranks everything else: if ANY form of this code is owned
  // elsewhere, registering the other forms would spread one duplicate into two.
  const clash = rows.find((r) => r && r.productId && r.productId !== productId);
  if (clash) return { kind: PRINTED_CONFLICT, code: clash.code, otherProductId: clash.productId };

  const free = rows.filter((r) => r && !r.productId).map((r) => r.code);
  if (!free.length && rows.length) return { kind: PRINTED_ALREADY };
  return { kind: PRINTED_FREE, codes: free };
}
