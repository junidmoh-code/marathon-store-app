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
