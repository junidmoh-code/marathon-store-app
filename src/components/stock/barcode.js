// ─── BARCODE VALUE MODEL (pure) ───────────────────────────────────────────────
// Per-(product, size) barcode identity for scan-to-sell. PURE module — no Firebase
// import — so the value model is unit-tested in isolation. The Firebase side
// (reserve / store / reverse-index) lives in barcodeStore.js.
//
// FORMAT (document this — the POS scans it to sell):
//   • An 8-digit, zero-padded, sequential decimal string, e.g. "00000042".
//   • Reserved from the SINGLE shared counter /products_meta.lastBarcode — the
//     SAME counter App.jsx's reserveNextSkuAndBarcode() advances for product-level
//     codes (its comment always anticipated "a future size-level barcode feature
//     will advance the barcode counter per (product, size)"). There is NO second
//     scheme: product-level and per-size codes draw from one monotonic sequence.
//   • Rendered as Code 128 (subset B) on the label.
//   • The code is OPAQUE (sequential, not derived from the ids), so resolution is a
//     reverse-index lookup, NOT parsing: /barcodes/{code} -> { productId, size }.
//     The POS scans a code, reads /barcodes/{code}, and gets the product+size to
//     sell and the /stock cell to deduct. (That lookup is the separate POS build;
//     this app WRITES the index so it will work.)
//
// PERMANENCE: a code is generated the first time a product+size needs a label,
// then stored at /products/{id}/barcodes/{sizeKey} forever. Reads reuse it; a new
// number is NEVER reserved for a size that already has one, and a stored code is
// NEVER overwritten. See barcodeStore.ensureBarcode for the transaction guards.

export const BARCODE_DIGITS = 8;
export const BARCODE_MAX = 99999999; // 8-digit zero-padded ceiling (mirrors App.jsx)

// Format a counter integer as the canonical 8-digit code string.
export function formatBarcode(n) {
  return String(n).padStart(BARCODE_DIGITS, "0");
}

// A valid stored code is exactly 8 decimal digits.
export function isValidBarcode(v) {
  return typeof v === "string" && /^\d{8}$/.test(v);
}

// Reuse-if-present decision (the permanence guard, in pure form): return the
// existing code when it's valid, else null (→ caller must reserve a fresh one).
export function reuseOrNull(existing) {
  return isValidBarcode(existing) ? existing : null;
}

// Pure transaction updater for the shared counter: given the current
// /products_meta value, return the next counter value + the code it yields.
// Throws on exhaustion. Used by barcodeStore.reserveNextBarcode inside a
// runTransaction so concurrent reservations can never collide on a number.
export function nextBarcodeFromMeta(currentMeta) {
  const last = (currentMeta && typeof currentMeta.lastBarcode === "number") ? currentMeta.lastBarcode : 0;
  const next = last + 1;
  if (next > BARCODE_MAX) {
    throw new Error("Barcode counter exhausted (max 99999999). Contact admin to expand width.");
  }
  return { next, code: formatBarcode(next) };
}

// Firebase keys cannot contain . $ # [ ] / — sizes can ("5.5"). The STORED VALUE
// and the reverse index keep the RAW size; only the per-size storage KEY under
// /products/{id}/barcodes/{KEY} is encoded (dots → "-", e.g. "5.5" -> "5-5").
export function barcodeSizeKey(size) {
  return String(size).replace(/[.$#[\]/]/g, "-");
}

// ─── Code 128 (subset B) encoder ──────────────────────────────────────────────
// Standard 107-pattern table (indices 0–102 data, 103 StartA, 104 StartB,
// 105 StartC, 106 Stop). Each entry is the 6 (Stop: 7) module widths, alternating
// bar/space starting with a bar.
const CODE128_PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112",
];
const START_B = 104;
const STOP = 106;

// The Code 128B symbol sequence for a value: [StartB, ...charValues, checksum, Stop].
// charValue = ASCII - 32 (printable 32–126). Checksum = (StartB + Σ val_i*i) mod 103,
// position i starting at 1. PURE + deterministic — the part a scanner depends on.
export function code128Symbols(value) {
  const s = String(value);
  const vals = [];
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp < 32 || cp > 126) throw new Error(`Code128B cannot encode char code ${cp}`);
    vals.push(cp - 32);
  }
  let sum = START_B;
  vals.forEach((v, i) => { sum += v * (i + 1); });
  const checksum = sum % 103;
  return [START_B, ...vals, checksum, STOP];
}

// Flatten the symbol sequence to an array of { width, bar } modules for rendering.
export function code128Modules(value) {
  const modules = [];
  for (const sym of code128Symbols(value)) {
    const pattern = CODE128_PATTERNS[sym];
    for (let i = 0; i < pattern.length; i++) {
      modules.push({ width: Number(pattern[i]), bar: i % 2 === 0 });
    }
  }
  return modules;
}

// Total module count of the rendered symbol (for sizing the SVG viewBox).
export function code128Width(value) {
  return code128Modules(value).reduce((sum, m) => sum + m.width, 0);
}
