// Phone-number normalisation for the order flow. Kept React-free so it can be
// unit-tested directly and reused anywhere a customer phone is captured.
//
// Target: E.164 for South Africa (+27). Staff enter numbers in whatever shape
// is handy, so we accept the common variants instead of forcing one format:
//   "0712345678"        → "+27712345678"   (local, leading 0)
//   "712345678"         → "+27712345678"   (bare 9-digit national, no 0)
//   "71 234 5678"       → "+27712345678"   (separators stripped)
//   "27712345678"       → "+27712345678"   (country code, no +)
//   "+27 71 234 5678"   → "+27712345678"   (already international)
//   "0027712345678"     → "+27712345678"   (00 international prefix)
// Empty input stays empty (phone is optional). A "+"-prefixed non-SA number is
// preserved as-is (separators stripped) rather than force-prefixed with +27.
export function normalizeSAPhone(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  if (s.startsWith("+")) return "+" + s.slice(1).replace(/\D/g, ""); // already international
  const d = s.replace(/\D/g, "");                                    // digits only
  if (!d) return "";
  if (d.startsWith("00")) return "+" + d.slice(2);                   // 00<cc>… → +<cc>…
  if (d.startsWith("27")) return "+" + d;                            // 27XXXXXXXXX
  if (d.startsWith("0"))  return "+27" + d.slice(1);                 // 0XXXXXXXXX (local)
  return "+27" + d;                                                  // bare national (e.g. 9-digit, no 0)
}

// Strict validity for the REQUIRED customer-order phone: exactly 10 digits
// starting with 0 (the standard SA local mobile form, e.g. "0712345678").
// Anything shorter or longer is rejected. Separators are ignored so a value
// like "071 234 5678" still validates on its digit content.
export function isValidLocalSAPhone(raw) {
  return /^0\d{9}$/.test((raw || "").replace(/\D/g, ""));
}

// Convert any stored / normalised SA number to the local 0XXXXXXXXX form so the
// strict input shows it consistently (e.g. when picking an existing customer
// whose number is saved as "+27712345678"). Best-effort: returns the digits
// unchanged if it isn't a recognisable SA mobile.
export function toLocalSA(raw) {
  const d = (raw || "").replace(/\D/g, "");
  if (/^27\d{9}$/.test(d)) return "0" + d.slice(2); // 27XXXXXXXXX → 0XXXXXXXXX
  if (/^\d{9}$/.test(d))   return "0" + d;          // bare 9-digit → add 0
  return d;                                          // already 0XXXXXXXXX or unknown
}

// National significant digits — drops a leading country code (27) or trunk 0 so
// the same subscriber matches regardless of how the number was stored (+27…,
// 27…, 0…, or bare). Used for phone-search prefix matching, where the typed
// query (local 0…) must match stored numbers saved in +27… form.
export function saSignificantDigits(raw) {
  let d = (raw || "").replace(/\D/g, "");
  if (d.startsWith("27")) d = d.slice(2);
  else if (d.startsWith("0")) d = d.slice(1);
  return d;
}

// All key shapes a /customers record for this phone may live under, in probe
// order: the typed digits first, then the local 0-form, then the international
// 27-form. The same phone can already live under a different key shape: order
// phones arrive as "27656996104" while the POS keys staff-created customers as
// "0656996104" (the 2026-07 POS audit found 31 duplicate pairs, 30 from exactly
// this 27↔0 split). Reads must probe every shape so an existing record is found
// and updated in place, never duplicated. Mirrors POS's phoneKeyVariants.
export function phoneKeyVariants(phone) {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return [];
  let local = digits;
  if (digits.length === 11 && digits.startsWith("27")) local = "0" + digits.slice(2);
  else if (digits.length === 9 && !digits.startsWith("0")) local = "0" + digits;
  const out = [digits];
  if (!out.includes(local)) out.push(local);
  if (local.length === 10 && local.startsWith("0")) {
    const intl = "27" + local.slice(1);
    if (!out.includes(intl)) out.push(intl);
  }
  return out;
}

// Key a NEW /customers record is minted at: the canonical local 0XXXXXXXXX
// form — the shape POS staff type at the till — so both apps key the same
// person to one record. Existing records are found via phoneKeyVariants and
// keep their current key; only the mint-on-miss key is canonicalised. Best-
// effort like toLocalSA: a non-SA number keeps its typed digits, and digit-less
// input falls back to "unknown" (callers treat that as "no phone").
export function customerWriteKey(phone) {
  return toLocalSA(phone) || "unknown";
}
