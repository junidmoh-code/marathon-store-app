// ─── THE OPTIONAL CONSOLE RULE THAT MAKES A TYPE CHANGE SERVER-ONLY ──────────
// setProductType (functions/productType/) is how the APP changes a product's
// Type: manager-only once it has stock or sales, and logged. The database
// itself still accepts a direct productType write from any signed-in device,
// because /products' .write is "any signed-in, non-anonymous user". This adds
// two .validate rules under /products/$pid — nothing else changes:
//
//   productType  a new product may set it; an existing one may not change it,
//                except from Junid's own account. setProductType writes with
//                the Admin SDK, which rules never see, so it is unaffected.
//   typeLog/$key an entry that already exists may be carried through a
//                whole-product write; a NEW entry can only come from the
//                server. (A delete skips .validate — rules cannot stop that.)
//
// PRINTED, NEVER PASTED: database.rules.json is stale and console-managed.
// Proven by prove-product-type-rule.mjs on the emulator against the live
// document. Composes with the device-enrolment patch (that one only wraps
// .read/.write; these are .validate).
export const OWNER_EMAIL = "gunidmoh@gmail.com";
export const PRODUCT_TYPE_VALIDATE = `!data.exists() || newData.val() === data.val() || auth.token.email === '${OWNER_EMAIL}'`;
export const TYPE_LOG_ENTRY_VALIDATE = "data.exists()";

export function patchProductTypeRule(live) {
  if (!live?.rules?.products?.$pid) throw new Error("the live rules have no /products/$pid — refusing to guess");
  const doc = JSON.parse(JSON.stringify(live));
  const pid = doc.rules.products.$pid;
  for (const k of ["productType", "typeLog"]) {
    if (pid[k] !== undefined && JSON.stringify(pid[k]) !== JSON.stringify(k === "productType"
      ? { ".validate": PRODUCT_TYPE_VALIDATE } : { $key: { ".validate": TYPE_LOG_ENTRY_VALIDATE } })) {
      throw new Error(`the live rules already hold a different /products/$pid/${k} — refusing to guess`);
    }
  }
  pid.productType = { ".validate": PRODUCT_TYPE_VALIDATE };
  pid.typeLog = { $key: { ".validate": TYPE_LOG_ENTRY_VALIDATE } };
  return doc;
}
