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
