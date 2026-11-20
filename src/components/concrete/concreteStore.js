// ─── Browser writes for the Concrete marking ─────────────────────────────────
// The ONE place the browser writes concreteProduct (and its one-release
// listOnConcrete mirror) / brandVerified*. Everything
// goes through src/utils/concreteListing.js (pure builders) and lands as ONE
// root multi-path update, so a bulk mark is all-or-nothing. The offline mirror
// is told about the write the same way productSave.js tells it (notePendingUpdate),
// so the list re-renders at once instead of waiting for the next mirror pull.
import { useEffect, useState } from "react";
import { ref, update, get, query, orderByChild, equalTo } from "firebase/database";
import { database, auth } from "../../firebase";
import { notePendingUpdate } from "../../offline/pendingWrites";
import { serverNowMs } from "../../utils/serverTime";
import { isSuperAdmin } from "../../config/superAdmins";
import { setConcreteProduct, buildBrandConfirmUpdate, isConcreteProduct, CONCRETE_PUBLISH_PATH } from "../../utils/concreteListing";

// Bulk writes are chunked: one RTDB update carries every path in a chunk, and
// 150 products × 5 paths keeps each request well under the payload limits.
export const BULK_CHUNK = 150;

async function applyRootUpdate(updates) {
  await update(ref(database), updates);
  try { notePendingUpdate(updates); } catch { /* the echo is a courtesy */ }
}

/** The owners or a stockRole admin — the identities Brand Check and verify belong to. */
export function canVerifyBrand(user, permRecord) {
  return isSuperAdmin(user?.email) || permRecord?.stockRole === "admin";
}

/**
 * Mark / unmark many products. `verify` stamps the brand check too (only for
 * Junid/admin). `liveOnConcrete` = pids live on Concrete now (unmarking those
 * turns their Concrete listing off). Returns { ok, count, message? }.
 */
export async function markProducts(productIds, on, { verify = false, liveOnConcrete = null, onProgress = null } = {}) {
  const uid = auth.currentUser?.uid;
  if (!uid) return { ok: false, count: 0, message: "Not signed in." };
  let done = 0;
  for (let i = 0; i < productIds.length; i += BULK_CHUNK) {
    const chunk = productIds.slice(i, i + BULK_CHUNK);
    const r = await setConcreteProduct(applyRootUpdate, { productIds: chunk, on, uid, nowMs: serverNowMs(), verify, liveOnConcrete });
    if (!r.ok) return { ok: false, count: done, message: r.message };
    done += r.count;
    onProgress?.(done);
  }
  return { ok: true, count: done };
}

/**
 * ONE product, Concrete-only on/off — the Concrete Products card and Missing
 * Products' Concrete button. Junid/admin only (the callers gate), so the flip
 * IS the brand check (verify:true). Returns { ok, message? }; a failure is
 * always a visible message, never silent.
 */
export async function markConcreteProduct(productId, on, { liveOnConcrete = null } = {}) {
  const uid = auth.currentUser?.uid;
  if (!uid) return { ok: false, message: "Not signed in — nothing was saved." };
  const r = await setConcreteProduct(applyRootUpdate, { productIds: [productId], on, uid, nowMs: serverNowMs(), verify: true, liveOnConcrete });
  return r.ok ? { ok: true } : { ok: false, message: r.message || "Couldn't save — nothing changed." };
}

/**
 * Undoing a Concrete mark: if the Marathon reconciler already switched the
 * Marathon listing off BECAUSE of that mark (lastOff.reasonCode
 * "concrete_only"), put its intent back to "on". Any other off — a person's,
 * a refusal — is left alone. Returns { ok, restored, message? }.
 */
export async function restoreMarathonListing(productId) {
  const uid = auth.currentUser?.uid;
  if (!uid) return { ok: false, restored: false, message: "Not signed in." };
  try {
    const node = (await get(ref(database, `shopify_publish/${productId}`))).val();
    if (!node || node.desiredState !== "off" || node.lastOff?.reasonCode !== "concrete_only") return { ok: true, restored: false };
    await applyRootUpdate({
      [`shopify_publish/${productId}/desiredState`]: "on",
      [`shopify_publish/${productId}/updatedAt`]: serverNowMs(),
      [`shopify_publish/${productId}/updatedBy`]: uid,
    });
    return { ok: true, restored: true };
  } catch (err) {
    return { ok: false, restored: false, message: String(err?.message || err) };
  }
}

/** Brand Check's one tap. `on` is the state being confirmed. */
export async function confirmBrand(product, on, { liveOnConcrete = null } = {}) {
  const uid = auth.currentUser?.uid;
  if (!uid) return { ok: false, message: "Not signed in." };
  try {
    // The mark as the SERVER holds it now, not the list's snapshot: another
    // admin may have flipped it since this row rendered, and a confirm must
    // never stamp a mark nobody looked at (CodeRabbit, #911).
    const [cp, legacy] = await Promise.all([
      get(ref(database, `products/${product.id}/concreteProduct`)),
      get(ref(database, `products/${product.id}/listOnConcrete`)),
    ]);
    const wasOn = isConcreteProduct({ concreteProduct: cp.val() ?? undefined, listOnConcrete: legacy.val() });
    await applyRootUpdate(buildBrandConfirmUpdate({
      productId: product.id, on, wasOn, uid, nowMs: serverNowMs(), liveOnConcrete,
    }));
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

// ── Which products are live on Concrete right now ───────────────────────────
// One indexed query (state == "live"), the same shape the Marathon publishing
// store uses. Used so unmarking a live product also turns it off there. A read
// that fails (rules not pasted yet) yields an empty set — the reconciler is
// the backstop: it turns off any Concrete listing whose product is unmarked.

export function useConcreteLiveSet(enabled = true) {
  const [live, setLive] = useState(() => new Set());
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    get(query(ref(database, CONCRETE_PUBLISH_PATH), orderByChild("state"), equalTo("live")))
      .then((snap) => { if (!cancelled) setLive(new Set(Object.keys(snap.val() || {}))); })
      .catch(() => { /* rules not pasted yet — see comment above */ });
    return () => { cancelled = true; };
  }, [enabled]);
  return live;
}
