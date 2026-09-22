// ─── THE ONE STRICT SA-NUMBER RULE ───────────────────────────────────────────
// Extracted from functions/index.js on 2026-08-27, when the Meta audience
// builder needed exactly this behaviour and the choice was a second copy or a
// shared module. A second copy of a rule that decides whether a message is SENT
// — and now, whether a customer is uploaded to an ad platform — is how the two
// answers start disagreeing about "+2771845".
//
// Used by: enqueueWhatsApp (gates sending) and scripts/audience/ (gates upload).
"use strict";

// Normalise a South African number to E.164: +27XXXXXXXXX. Returns null when
// the input is not a recognisable SA mobile or a "+"-prefixed international
// number — callers must refuse to send rather than deliver to a mangled
// number (the old fallback happily turned "abc" into "+27" and a truncated
// "81399533" into "+2781399533"). DELIBERATELY stricter than
// src/utils/phone.js normalizeSAPhone: that one preserves malformed digits
// because it feeds display/identity; this one gates SENDING, where a
// malformed number must be a refusal, not a best effort.
function normaliseSAPhone(raw) {
  const s = String(raw || "").trim();
  if (s.startsWith("+")) {
    const d = s.slice(1).replace(/[^\d]/g, "");
    // A "+27" that isn't a complete SA number is exactly the malformed class
    // the census found ("+2771845") — refuse it. Other country codes can't be
    // shape-validated here beyond E.164's envelope: 8–15 digits and no
    // leading 0 (no country code starts with 0).
    if (d.startsWith("27")) return /^27\d{9}$/.test(d) ? "+" + d : null;
    if (d.startsWith("0")) return null;
    return d.length >= 8 && d.length <= 15 ? "+" + d : null;
  }
  let digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^0\d{9}$/.test(digits)) digits = "27" + digits.slice(1);
  else if (/^\d{9}$/.test(digits) && !digits.startsWith("0")) digits = "27" + digits;
  return /^27\d{9}$/.test(digits) ? "+" + digits : null;
}


module.exports = { normaliseSAPhone };
