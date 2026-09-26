// ─── THE OPTIONAL CONSOLE RULE THAT MAKES A TYPE CHANGE SERVER-ONLY ──────────
// setProductType (functions/productType/) is how the APP changes a product's
// Type: manager-only once it has stock or sales, and logged. The database
// itself still accepts a direct productType write from any signed-in device,
// because /products' .write is "any signed-in, non-anonymous user". This adds
// ONE .validate, at /products/$pid, so it sees the product as a whole:
//
//   a NEW product may carry any Type; an EXISTING product's Type may not be
//   changed, removed, or added (an untyped legacy record is a sneaker by
//   default — typing it Clothing IS a Type change) — except from Junid's own
//   account. Deleting the whole product is not a Type change and is left to
//   the existing rules. setProductType writes with the Admin SDK, which rules
//   never see, so it is unaffected.
//
// At $pid rather than on the productType leaf because a delete skips
// .validate: on the leaf, "delete it, then write a new one" walked straight
// past it. (CodeRabbit, PR #651.) The audit log needs no rule: it lives at
// /product_type_log, which has none, so no client can touch it.
//
// PRINTED, NEVER PASTED: database.rules.json is stale and console-managed.
// Proven by prove-product-type-rule.mjs on the emulator against the live
// document. Composes with the device-enrolment patch (that one only wraps
// .read/.write; this is a .validate).
export const OWNER_EMAIL = "gunidmoh@gmail.com";
export const PRODUCT_VALIDATE =
  "!data.exists() || !newData.exists() || newData.child('productType').val() === data.child('productType').val() "
  + `|| auth.token.email === '${OWNER_EMAIL}'`;

export function patchProductTypeRule(live) {
  const pid = live?.rules?.products?.$pid;
  if (!pid) throw new Error("the live rules have no /products/$pid — refusing to guess");
  if (pid[".validate"] !== undefined && pid[".validate"] !== PRODUCT_VALIDATE) {
    throw new Error("the live rules already hold a different /products/$pid .validate — refusing to guess");
  }
  const doc = JSON.parse(JSON.stringify(live));
  doc.rules.products.$pid[".validate"] = PRODUCT_VALIDATE;
  return doc;
}
