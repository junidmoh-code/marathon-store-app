// ─── THE ORDER VIEW'S BRAND FILTER (one source for desktop and phone) ────────
//
// The desktop chip row and the phone brand strip read the SAME options and
// apply the SAME filter, from one `brand` value held by AssistantView. Moved
// here unchanged from AssistantDesktop (sky redesign, 5 Nov 2026) so the two
// pickers cannot drift. Presentation only: nothing here reads or writes data.

/**
 * Brand options FROM the data (product.brand), counted, most-stocked first;
 * unbranded/code-only (brand == null) collapse into "Other". Products whose
 * brand was NOT recognised (brandFlag) get their own "Needs brand" entry.
 * First entry is always ["All", total].
 */
export function brandOptions(catalog) {
  const list = catalog || [];
  const m = new Map();
  let needs = 0;
  list.forEach((p) => {
    if (!p.brand && p.brandFlag === "unrecognised") { needs++; return; }
    const k = p.brand || "Other"; m.set(k, (m.get(k) || 0) + 1);
  });
  const other = m.get("Other") || 0; m.delete("Other");
  const ranked = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = [["All", list.length], ...ranked];
  if (needs) out.push(["Needs brand", needs]);
  if (other) out.push(["Other", other]);
  return out;
}

/** The products of `list` that belong to `brand` ("All" = every one). */
export function filterByBrand(list, brand) {
  if (!list || brand === "All") return list;
  return list.filter((p) => (brand === "Needs brand" ? !p.brand && p.brandFlag === "unrecognised"
    : brand === "Other" ? !p.brand && p.brandFlag !== "unrecognised" : p.brand === brand));
}

/** Keep the selection when it is still one of the options, else All. */
export function reconcileBrand(brand, opts) {
  if (brand === "All") return "All";
  return (opts || []).some(([b]) => b === brand) ? brand : "All";
}
