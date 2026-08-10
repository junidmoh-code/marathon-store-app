// ─── 1D BARCODE DECODER — the SYMBOL, not the digits ─────────────────────────
// Reading the number printed under a barcode is OCR, and OCR guesses: a 3 for
// an 8, a 1 for a 7, and no way to know it was wrong. DECODING the bar pattern
// is not a guess — the symbology's own check digit either agrees or it does
// not. So the barcode is decoded, and the printed digits are only ever a
// fallback for when the symbol will not read at all.
//
// ── THE DECODER, AND WHY IT COSTS NOTHING ────────────────────────────────────
// html5-qrcode (a ZXing-js port) is ALREADY a dependency of this app — it is
// what reads the QR/DataMatrix on a tongue label and the layby QR. Its
// Html5Qrcode.scanFile() decodes 1D symbologies too; it only needed to be told
// which ones to look for. So this runs entirely CLIENT-SIDE, adds no package,
// no network call and no per-read cost, unlike the OCR fallback below it.
//
// Restricting formatsToSupport is not a nicety: with every symbology enabled
// the decoder spends its time on QR/Aztec/PDF-417 hypotheses that a perfume box
// never carries, and each wrong hypothesis is a chance to resolve noise into a
// plausible number. Three formats, and the check digit still has to agree.

import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { normalisePrintedBarcode } from "./eanBarcode";

// The retail 1D set. UPC-E is deliberately absent: it is a ZERO-SUPPRESSED UPC-A
// whose expansion rules the decoder applies for us on some readers and not
// others, so the same box could yield two different numbers depending on the
// device. A perfume carton has room for the full symbol.
export const RETAIL_1D_FORMATS = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
];

// Hidden mount ids are per-instance — decoding must be safe while another
// reader (the tongue-label QR pass) is mounted on the same screen.
let decoderSeq = 0;

/**
 * Decode one image blob. Resolves to the decoded text, or null when the frame
 * carries no readable retail barcode. NEVER throws — a frame that will not read
 * is the expected case, not an error, and the burst simply moves to the next one.
 */
export async function decodeBlob(blob, { mountId } = {}) {
  const id = mountId || `printed-barcode-reader-${++decoderSeq}`;
  let host = typeof document !== "undefined" ? document.getElementById(id) : null;
  let created = false;
  if (!host && typeof document !== "undefined") {
    host = document.createElement("div");
    host.id = id;
    host.style.display = "none";
    document.body.appendChild(host);
    created = true;
  }
  let scanner = null;
  try {
    scanner = new Html5Qrcode(id, { formatsToSupport: RETAIL_1D_FORMATS, verbose: false });
    const file = new File([blob], "barcode.jpg", { type: blob.type || "image/jpeg" });
    return await scanner.scanFile(file, false);
  } catch {
    return null;                       // no symbol in this frame
  } finally {
    if (scanner) { try { scanner.clear(); } catch { /* nothing mounted */ } }
    if (created && host && host.parentNode) host.parentNode.removeChild(host);
  }
}

/**
 * THE BURST DECISION, pure and injectable — given what each frame decoded to,
 * which reading (if any) do we accept?
 *
 * FIRST VALID WINS, and "valid" means it survived normalisePrintedBarcode: the
 * right length AND its own check digit. A decoder that hands back a truncated
 * or mis-resolved number is therefore discarded here and the next frame gets
 * its turn — which is the entire point of shooting three frames instead of one.
 *
 * @param {Array<string|null>} readings one decoded text per frame (null = no read)
 * @returns {{ok:true, code:string, frameIndex:number} | {ok:false, reason:string, message:string}}
 */
export function pickDecodedBarcode(readings) {
  const list = Array.isArray(readings) ? readings : [];
  let lastRefusal = null;
  for (let i = 0; i < list.length; i++) {
    if (list[i] == null || list[i] === "") continue;
    const result = normalisePrintedBarcode(list[i]);
    if (result.ok) return { ok: true, code: result.code, frameIndex: i };
    lastRefusal = result;              // keep the most specific thing to report
  }
  return lastRefusal || {
    ok: false,
    reason: "no_symbol",
    message: "No barcode could be read from those frames.",
  };
}

/**
 * Decode a whole burst. `decode` is injectable so the burst logic is testable
 * without a DOM or a camera.
 */
export async function decodeFrames(frames, { decode = decodeBlob } = {}) {
  const readings = [];
  for (const frame of frames || []) {
    if (!frame || !frame.blob) { readings.push(null); continue; }
    readings.push(await decode(frame.blob));
  }
  return pickDecodedBarcode(readings);
}

/**
 * THE OCR FALLBACK — reading the printed digits when the symbol will not decode.
 *
 * Reuses the EXISTING readStyleCodeLabel callable rather than adding a second
 * vision path: it already extracts a 12–14 digit UPC/EAN run from the label
 * text, and it is cached on the image-byte hash, so a retake of the same frame
 * re-bills nothing. Its answer is a READING, not an identity — it goes through
 * the same check-digit gate as everything else, and a misread digit is refused
 * exactly as it would be from the camera.
 *
 * KNOWN GAP: that extractor's regex matches 12–14 digits, so an EAN-8 carton
 * whose symbol will not decode falls through to manual typing. Perfume boxes
 * are EAN-13 in practice; widening the regex is a Cloud Function change and is
 * deliberately not bundled into a hosting-only release.
 *
 * @param {function} readLabel the httpsCallable, injected for testability
 * @returns {{ok:true, code:string} | {ok:false, reason:string, message:string}}
 */
export async function readPrintedDigits(frames, readLabel) {
  let lastRefusal = null;
  for (const frame of frames || []) {
    if (!frame || !frame.base64) continue;
    let data;
    try {
      ({ data } = await readLabel({ imageBase64: frame.base64, mimeType: "image/jpeg" }));
    } catch {
      continue;                        // one frame failing must not end the burst
    }
    if (!data || typeof data.upc !== "string" || !data.upc) continue;
    const result = normalisePrintedBarcode(data.upc);
    if (result.ok) return { ok: true, code: result.code, fromDigits: true };
    lastRefusal = result;
  }
  return lastRefusal || {
    ok: false,
    reason: "no_digits",
    message: "The printed number could not be read either — type it from the box.",
  };
}
