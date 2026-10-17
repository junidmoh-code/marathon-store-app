// ─── CARD SLIP: THE TILL REGISTRY, READY BEFORE THE TAP ──────────────────────
// Junid, 17 Oct 2026: the Card Slip screen "did load but it was too slow". The
// screen's only read is /config/cardTerminals (≈2 KB), but it was opened at the
// tap, behind everything the home screen streams on the same connection
// (products, the order feed, stock) — seconds on a shop phone. So:
//
//   • ONE shared subscription, opened from the home screen for an account that
//     has a Card Slip scope (usePrefetchSlipTerminals), and kept open: the
//     screen finds the answer already there, and a second visit is instant.
//   • THE LAST ANSWER IS KEPT ON THE DEVICE (localStorage), so even a cold
//     start draws the form at once; the live read replaces it the moment it
//     lands. Safe: the submit sends only the machine id, and cardBatchCapture
//     re-resolves that machine's till and re-checks the account's till scope —
//     a stale copy can only ever be refused, never file a slip to another till.
import { useEffect } from "react";
import { ref as dbRef, onValue } from "firebase/database";
import { database } from "../../firebase";

export const SLIP_TERMINALS_KEY = "cardSlip.terminals.v1";
const PATH = "config/cardTerminals";

export function readCachedTerminals() {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(SLIP_TERMINALS_KEY) ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
function writeCachedTerminals(v) {
  try {
    globalThis.localStorage?.setItem(SLIP_TERMINALS_KEY, JSON.stringify(v || {}));
  } catch {
    /* private mode / full storage: the live read still works */
  }
}

let latest;              // undefined = not heard yet this session
let off = null;          // the live subscription, once opened
const listeners = new Set();

/** The freshest copy this session has, else the device's last one, else null. */
export function peekSlipTerminals() {
  return latest !== undefined ? latest : readCachedTerminals();
}

/** Listen for the registry; opens the one shared subscription on first use. */
export function subscribeSlipTerminals(cb) {
  listeners.add(cb);
  if (latest !== undefined) cb(latest);
  if (!off) {
    off = onValue(
      dbRef(database, PATH),
      (snap) => {
        latest = snap.val() || {};
        writeCachedTerminals(latest);
        for (const l of listeners) l(latest);
      },
      () => {
        // Refused or dropped: let the next subscriber try again, and answer
        // "nothing" only if nothing — live or cached — was ever known.
        off = null;
        if (latest === undefined && readCachedTerminals() === null) for (const l of listeners) l({});
      },
    );
  }
  return () => listeners.delete(cb);
}

/** Home screen: open the subscription early for an account with a Card Slip scope. */
export function usePrefetchSlipTerminals(enabled) {
  useEffect(() => (enabled ? subscribeSlipTerminals(() => {}) : undefined), [enabled]);
}

/** Tests only. */
export function _resetSlipTerminals() {
  if (typeof off === "function") off();
  off = null;
  latest = undefined;
  listeners.clear();
}
