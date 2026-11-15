// ─── Browser writes for the Concrete marking ─────────────────────────────────
// The ONE place the browser writes listOnConcrete / brandVerified*. Everything
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
import { setOnConcrete, buildBrandConfirmUpdate, isOnConcrete, CONCRETE_PUBLISH_PATH } from "../../utils/concreteListing";

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
    const r = await setOnConcrete(applyRootUpdate, { productIds: chunk, on, uid, nowMs: serverNowMs(), verify, liveOnConcrete });
    if (!r.ok) return { ok: false, count: done, message: r.message };
    done += r.count;
    onProgress?.(done);
  }
  return { ok: true, count: done };
}

/** Brand Check's one tap. `on` is the state being confirmed. */
export async function confirmBrand(product, on, { liveOnConcrete = null } = {}) {
  const uid = auth.currentUser?.uid;
  if (!uid) return { ok: false, message: "Not signed in." };
  try {
    await applyRootUpdate(buildBrandConfirmUpdate({
      productId: product.id, on, wasOn: isOnConcrete(product), uid, nowMs: serverNowMs(), liveOnConcrete,
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
