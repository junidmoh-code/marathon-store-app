// ─── PRODUCT EDIT — ONE WAY TO SAVE, AND IT NEVER FAILS SILENTLY ─────────────
//
// 26 Sep 2026: on Junid's iPhone the Air Force 1 White's edit page "would not
// save anything". Every tap DID save — the server has each write — but the
// page was drawing the product from the device's offline copy, which was
// frozen (src/offline/bootstrap.js, handOverToPassLoop), and the writes had no
// .catch, so a real refusal would have looked exactly the same: nothing.
//
// So every field on the edit page now saves through saveProductPatch:
//   · the write is awaited, and a failure comes back as a message the page
//     SHOWS (never a console line);
//   · a success is echoed into the offline copy at once (notePendingUpdate), so
//     a mirrored screen shows it without waiting for the change feed.
// The page itself reads the product live (useLiveProduct), so what it shows is
// what the server holds, whatever state the device's copy is in.

import { useEffect, useState } from "react";
import { onValue, ref, update } from "firebase/database";
import { database } from "../../firebase";
import { notePendingUpdate } from "../../offline/pendingWrites";
import { sameName } from "../../utils/productNameKey";

/** The flat multi-path form of a product patch, as notePendingUpdate takes it. */
export function productPatchPaths(id, patch) {
  return Object.fromEntries(Object.entries(patch || {}).map(([k, v]) => [`products/${id}/${k}`, v]));
}

function plainMessage(err) {
  const m = String(err?.message || err || "unknown error");
  if (/permission[_ ]denied/i.test(m)) return "the database refused it (permission denied)";
  if (/network|offline|disconnected/i.test(m)) return "no connection";
  return m;
}

/**
 * Save one patch to /products/{id}.
 * @returns {Promise<{ok:true} | {ok:false, message:string}>} never throws.
 */
export async function saveProductPatch({ id, patch, label = "that change", write, echo = notePendingUpdate }) {
  if (!id || !patch || !Object.keys(patch).length) return { ok: true };
  const doWrite = write || ((p) => update(ref(database, `products/${id}`), p));
  try {
    await doWrite(patch);
  } catch (err) {
    console.error(`product ${id}: saving ${label} failed:`, err);
    return { ok: false, message: `Could not save ${label}: ${plainMessage(err)}. Nothing was changed — try again.` };
  }
  try { echo(productPatchPaths(id, patch)); } catch { /* the echo is a courtesy */ }
  return { ok: true };
}

/**
 * The product as the SERVER holds it, subscribed while the edit page is open
 * (one record, a couple of KB). Until the first answer — or if the read fails —
 * the list's copy is shown, which is what the page did before.
 */
export function useLiveProduct(listProduct, { subscribe } = {}) {
  const id = listProduct?.id || null;
  const [live, setLive] = useState(null);
  useEffect(() => {
    setLive(null);
    if (!id) return undefined;
    const sub = subscribe || ((path, cb, onErr) => onValue(ref(database, path), (s) => cb(s.val()), onErr));
    return sub(`products/${id}`, (v) => setLive(v && typeof v === "object" ? { ...v, id: v.id || id } : null),
      () => setLive(null));
  }, [id, subscribe]);
  return live && live.id === id ? live : listProduct;
}

// ── TYPE: THROUGH THE SERVER, NEVER A DIRECT WRITE FROM THIS PAGE ────────────
// Sneaker ↔ Clothing goes through the setProductType callable: manager-only
// once the product has stock or sales, refused if it would strand Hub 1 units,
// and logged on the product with the person, the device and the time
// (functions/lib/product-type.cjs). Its refusal message is shown as it is.
export async function changeProductType({ id, productType, deviceId = null, call, echo = notePendingUpdate }) {
  try {
    const res = await call({ productId: id, productType, deviceId });
    const data = res?.data ?? res;
    if (data?.patch && Object.keys(data.patch).length) {
      try { echo(productPatchPaths(id, data.patch)); } catch { /* courtesy */ }
    }
    return { ok: true, data };
  } catch (err) {
    const m = String(err?.message || err || "unknown error").replace(/^.*?:\s*(?=[A-Z])/, "");
    return { ok: false, message: `Could not change the Type: ${m}` };
  }
}

// ── NAME: EDIT → SAVE, THROUGH THE SERVER (Junid, 27 Nov 2026) ───────────────
// The Name field used to save on blur, straight to /products/{id}/name — no
// permission check, no record of who, and an edit was easily lost on a phone.
// A rename now goes through the setProductName callable: the same rule as
// Type, one multi-path write, logged under product_name_log
// (functions/lib/product-rename.cjs).
//
// The twin check runs HERE, against the catalogue the page already holds
// (/products has no name index, and the server must not read it whole). The
// comparison is the server's own sameName (utils/productNameKey.js, pinned
// equal to functions/lib/product-rename.cjs by test).

/** Pure: what stops this rename before it is sent, or null. */
export function renameRefusal({ product, draft, allProducts = [] }) {
  const next = String(draft ?? "").trim();
  if (!next) return "A product needs a name.";
  if (next === (product?.name ?? "")) return null;
  // No catalogue, no twin check — never send a rename that skipped it.
  if (!Array.isArray(allProducts) || allProducts.length === 0) return "The product list is still loading, so the name cannot be checked yet. Try again in a moment.";
  const twin = (allProducts || []).find((p) => p && p.id && p.id !== product?.id && sameName(p.name, next));
  if (twin) return `“${twin.name}” is already the name of another product (${twin.styleCode || twin.id}). Two products with the same name get mixed up in the Source queue — choose a different name.`;
  return null;
}

export async function renameProduct({ product, draft, from = undefined, allProducts = [], extras = null, deviceId = null, call, echo = notePendingUpdate }) {
  const refused = renameRefusal({ product, draft, allProducts });
  if (refused) return { ok: false, message: refused };
  const name = String(draft).trim();
  if (name === product.name) return { ok: true, noop: true };
  try {
    const res = await call({ productId: product.id, name, from: from ?? product.name ?? "", extras, deviceId });
    const data = res?.data ?? res;
    if (data?.patch && Object.keys(data.patch).length) {
      try { echo(productPatchPaths(product.id, data.patch)); } catch { /* courtesy */ }
    }
    return { ok: true, data };
  } catch (err) {
    const m = String(err?.message || err || "unknown error").replace(/^.*?:\s*(?=[A-Z“])/, "");
    return { ok: false, message: `Could not rename: ${m}` };
  }
}
