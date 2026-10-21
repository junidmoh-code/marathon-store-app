// ── Minting an order's three-letter ref (KQZ) ────────────────────────────────
// The registry /online_order_refs/{code} = { orderId, at } is the uniqueness
// check: claiming a code is ONE transaction on ONE exact path — never a read of
// /online_orders. A code whose claim is older than 180 days may be reused; a
// code already held by THIS order is returned as-is (a re-run is idempotent).
import {
  ONLINE_ORDER_REFS_PATH, ORDER_REF_REUSE_AFTER_MS, randomOrderRef, isOrderRefCode,
} from "../../../src/utils/onlineOrders.js";

const MAX_TRIES = 64;

/**
 * Claim a free code for `orderId`. → "KQZ". Throws only if 64 random draws all
 * collide (13,824 codes; at a few hundred orders per 180 days that is not a
 * thing that happens — and if it does, the order is retried next tick).
 */
export async function mintOrderRef(db, orderId, nowMs, { rand = Math.random } = {}) {
  const id = String(orderId);
  for (let i = 0; i < MAX_TRIES; i++) {
    const code = randomOrderRef(rand);
    if (!isOrderRefCode(code)) continue;
    const res = await db.ref(`${ONLINE_ORDER_REFS_PATH}/${code}`).transaction((cur) => {
      if (cur && cur.orderId !== id && nowMs - Number(cur.at || 0) < ORDER_REF_REUSE_AFTER_MS) return undefined; // taken
      return { orderId: id, at: nowMs };
    });
    if (res.committed && res.snapshot.val()?.orderId === id) return code;
  }
  throw new Error(`could not mint a free order code for ${id} after ${MAX_TRIES} tries`);
}
