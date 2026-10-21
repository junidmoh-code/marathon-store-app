// ── Minting an order's three-letter ref (KQZ) ────────────────────────────────
// The registry /online_order_refs/{code} = { orderId, at } is the uniqueness
// check: claiming a code is ONE transaction on ONE exact path — never a read of
// /online_orders. A code whose claim is older than 180 days may be reused; a
// code already held by THIS order is returned as-is (a re-run is idempotent).
import { createHash } from "node:crypto";
import {
  ONLINE_ORDER_REFS_PATH, ORDER_REF_REUSE_AFTER_MS, ORDER_REF_ALPHABET, ORDER_REF_LENGTH, randomOrderRef, isOrderRefCode,
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

// ── A hub order unit's code (owner decision 2026-10-21) ─────────────────────
// One code per unit a hub sends (one pair = one code). DETERMINISTIC per
// owner — `${orderId}:${line}:${unit}:${routeGen}` — so a tick that crashes
// after claiming (or after writing the hub order) lands on the SAME code next
// time and adopts its own record: never a second hub order for one unit.
// Attempt k is a hash of (owner, k); a code another owner holds (< 180 days)
// moves to k+1.

/** Pure: the k-th candidate code for `owner`. */
export function candidateCode(owner, k) {
  const h = createHash("sha256").update(`${owner}#${k}`).digest();
  let out = "";
  for (let i = 0; i < ORDER_REF_LENGTH; i++) out += ORDER_REF_ALPHABET[h[i] % ORDER_REF_ALPHABET.length];
  return out;
}

/** Claim `owner`'s code. → "QGZ". `taken(code)` (optional) refuses a code whose /orders key is occupied by something else. */
export async function mintHubCode(db, owner, nowMs, { taken = null } = {}) {
  for (let k = 0; k < MAX_TRIES; k++) {
    const code = candidateCode(owner, k);
    if (taken && (await taken(code))) continue;
    const res = await db.ref(`${ONLINE_ORDER_REFS_PATH}/${code}`).transaction((cur) => {
      if (cur && cur.orderId !== owner && nowMs - Number(cur.at || 0) < ORDER_REF_REUSE_AFTER_MS) return undefined;
      if (cur && cur.orderId === owner) return cur; // ours already — idempotent
      return { orderId: owner, at: nowMs, kind: "hub_unit" };
    });
    if (res.committed && res.snapshot.val()?.orderId === owner) return code;
  }
  throw new Error(`could not mint a free hub code for ${owner} after ${MAX_TRIES} tries`);
}
