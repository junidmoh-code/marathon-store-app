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

import { normaliseStyleCode, isKnownStyleCodeFormat, formatStyleCodeForDisplay } from "./styleCode.js";

export function interpretLabelScan(decodedText) {
  const raw = String(decodedText ?? "").trim();
  if (!raw) return { kind: "ignore", reason: "empty" };

  // GS1 / numeric payloads: per-size, per-unit — never an identity. The group
  // separator byte is the definitive GS1 marker, so it decides first.
  if (raw.includes("\x1d")) return { kind: "ignore", reason: "gs1_separators", raw };
  const digitsOnly = raw.replace(/\s/g, "");
  if (/^\d+$/.test(digitsOnly)) return { kind: "ignore", reason: "gs1_numeric", raw };
  if (/^01\d{14}/.test(digitsOnly)) return { kind: "ignore", reason: "gs1_ai", raw };

  // A URL: hunt its path/query segments for a style-code-shaped token.
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const segments = [
        ...u.pathname.split(/[/._\-]+/),
        ...[...u.searchParams.values()].flatMap((v) => v.split(/[/._\-\s]+/)),
      ];
      for (const seg of segments) {
        if (seg && isKnownStyleCodeFormat(seg)) {
          return { kind: "code", code: formatStyleCodeForDisplay(seg), raw };
        }
      }
    } catch { /* unparseable — fall through to ignore */ }
    return { kind: "ignore", reason: "url_without_code", raw };
  }

  // A bare value that IS a known style-code shape — deterministic, use it.
  if (isKnownStyleCodeFormat(raw)) {
    return { kind: "code", code: formatStyleCodeForDisplay(raw), raw };
  }

  // Composite payloads ("ART:CT8527-016;SZ:9"): any embedded shaped token.
  const tokens = raw.toUpperCase().split(/[^A-Z0-9-]+/).filter(Boolean);
  for (const t of tokens) {
    if (normaliseStyleCode(t).length >= 6 && isKnownStyleCodeFormat(t)) {
      return { kind: "code", code: formatStyleCodeForDisplay(t), raw };
    }
  }
  return { kind: "ignore", reason: "unknown_stability", raw };
}
