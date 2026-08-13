// ─── LABEL QR / DATAMATRIX — what a decoded code is allowed to mean ──────────
// Lacoste and adidas tongue labels carry a QR or DataMatrix. When one decodes,
// it is deterministic — no confusable-character problem — so it is PREFERRED
// over OCR… but only when its content is actually STABLE for the shoe:
//
//   • a style-code-shaped value (directly, or embedded in a URL) is stable —
//     the same on every pair of that shoe. USED.
//   • GS1 payloads (GTIN + batch/serial — all-digit strings, "01"-prefixed
//     application identifiers, group-separator bytes) identify the SIZE
//     VARIANT and often the individual unit: a per-size GTIN as identity would
//     split one shoe into ten products. IGNORED — the flow falls through to
//     OCR, which reads the article code printed beside it.
//   • anything else is of unknown stability. IGNORED, for the same reason.
//
// Pure and deterministic; the camera glue lives in the reader component.

import { normaliseStyleCode, formatStyleCodeForDisplay, styleCodeFormat } from "./styleCode.js";

// Formats whose printed-label form and web/QR form are the SAME string. The
// Lacoste reference is deliberately NOT here: the tongue label prints
// "7-43SMA0033 1R5" (category prefix + colour suffix) while a QR'd product URL
// carries the bare "43SMA0034" web form — accepting both would give the SAME
// physical shoe two identities depending on whether the QR decoded. For that
// brand the printed reference (OCR path) is the one canonical form.
const QR_STABLE_FORMATS = new Set(["nike-alpha-6-3", "numeric-6-3", "puma-6-2", "new-balance", "adidas-block"]);
const qrUsable = (token) => QR_STABLE_FORMATS.has(styleCodeFormat(token));

export function interpretLabelScan(decodedText) {
  const raw = String(decodedText ?? "").trim();
  if (!raw) return { kind: "ignore", reason: "empty" };

  // GS1 / numeric payloads: per-size, per-unit — never an identity. The group
  // separator byte is the definitive GS1 marker, so it decides first.
  if (raw.includes("\x1d")) return { kind: "ignore", reason: "gs1_separators", raw };
  // KNOWN TRADEOFF: this also drops a QR that encodes a bare all-numeric style
  // code (Nike legacy 9-digit, Puma 8-digit) — a GTIN-8 is 8 digits too, and
  // there is no way to tell them apart from the payload alone. Those labels
  // fall through to OCR, which reads the printed code beside the QR; identity
  // safety wins over the fast path for two of the eight formats.
  const digitsOnly = raw.replace(/\s/g, "");
  // (any "01"+GTIN AI payload is all-digits too, so this one rule covers GS1)
  if (/^\d+$/.test(digitsOnly)) return { kind: "ignore", reason: "gs1_numeric", raw };

  // A URL: hunt its path/query segments for a style-code-shaped token.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const segments = [
        ...u.pathname.split(/[/._\-]+/),
        ...[...u.searchParams.values()].flatMap((v) => v.split(/[/._\-\s]+/)),
      ];
      for (const seg of segments) {
        if (seg && qrUsable(seg)) {
          return { kind: "code", code: formatStyleCodeForDisplay(seg), raw };
        }
      }
    } catch { /* unparseable — fall through to ignore */ }
    return { kind: "ignore", reason: "url_without_code", raw };
  }

  // A bare value that IS a known style-code shape — deterministic, use it
  // (form-varying brands excluded; see QR_STABLE_FORMATS).
  if (qrUsable(raw)) {
    return { kind: "code", code: formatStyleCodeForDisplay(raw), raw };
  }
  // Brand shapes whose printed and QR forms differ are ignored here. The
  // generic label-serial shape is EXCLUDED from this early exit on purpose:
  // a composite payload ("ART:CT8527-016;SZ:9") normalises into a serial-like
  // interleaved run, and bailing on it would skip the token hunt below that
  // finds the real embedded code. A genuinely bare serial still ends at
  // "unknown_stability" — QR serials stay non-authoritative either way.
  const rawFormat = styleCodeFormat(raw);
  if (rawFormat && rawFormat !== "label-serial") return { kind: "ignore", reason: "brand_form_varies", raw };

  // Composite payloads ("ART:CT8527-016;SZ:9"): any embedded shaped token.
  const tokens = raw.toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean);
  for (const t of tokens) {
    if (normaliseStyleCode(t).length >= 6 && qrUsable(t)) {
      return { kind: "code", code: formatStyleCodeForDisplay(t), raw };
    }
  }
  return { kind: "ignore", reason: "unknown_stability", raw };
}
