// ─── PRODUCT DEACTIVATION — finished lines, reversibly retired ───────────────
// (Owner spec 2026-08-25, built for the Leftovers tab.)
//
// A DEACTIVATED product is a finished line: it will never be restocked, so the
// refill engine must not raise requests for it and ordering must show its
// sizes as unavailable. Deactivation is a FLAG, never a delete — the record,
// its stock cells, its barcodes and its movement history are untouched, and
// one tap reverses it.
//
//   products/{pid}/deactivated  = { at, by, byName }          — who and when
//   products/{pid}/reactivated  = { at, by, byName, reason }  — the reverse,
//       reason "manual" (a tap) or "stock_received" (see below)
//
// Exactly ONE of the two nodes exists at a time: each write sets one and
// deletes the other in the same atomic multi-path update, so the predicate is
// a single truthy check and no record can be both.
//
// THE TRAP THIS FILE GUARDS: a deactivated product that RECEIVES stock would
// be invisible — the engine ignores it, nobody refills it, the units sit
// unnoticed. So any stock ARRIVAL (received / return / transfer_in / positive
// adjustment / opening — never `sold`, never the in-transit leg of a
// transfer_out) auto-reactivates the product inside applyMovement's own atomic
// update, and the UI announces it (REACTIVATED_EVENT). Deliberately NOT a
// field on some settings node: the engine already reads /products whole, so a
// product-record flag costs the scan zero extra I/O.
//
// The engine's copy of the predicate lives in functions/lib/refill-engine.cjs
// (isDeactivated) — one truthy check, kept in lockstep by
// functions/test/refill-deactivated.test.cjs.

export const REACTIVATED_EVENT = "marathon:product-reactivated";

/** Is this product record deactivated? One truthy check, same as the engine's. */
export function isDeactivated(p) {
  return !!(p && p.deactivated);
}

// Payload builders are PURE (multi-path fragments for update(ref(db)), …) so
// tests can pin the exact shape and callers can fold them into larger atomic
// writes (applyMovement does). `null` deletes in RTDB — that is the reversal.

/** Multi-path fragment that deactivates a product. */
export function deactivateUpdates(pid, { uid, byName, nowMs }) {
  return {
    [`products/${pid}/deactivated`]: {
      at: nowMs,
      by: uid,
      ...(byName ? { byName } : {}),   // omit-don't-copy: never write undefined
    },
    [`products/${pid}/reactivated`]: null,
  };
}

/** Multi-path fragment that reactivates a product. reason: "manual" | "stock_received". */
export function reactivateUpdates(pid, { uid, byName, nowMs, reason }) {
  return {
    [`products/${pid}/deactivated`]: null,
    [`products/${pid}/reactivated`]: {
      at: nowMs,
      by: uid,
      ...(byName ? { byName } : {}),
      reason: reason || "manual",
    },
  };
}

// THE ordering predicate, shared by every size chip the assistant order flow
// renders (phone sheet, desktop hover quick-add, desktop quick-view): a
// deactivated product's sizes are unavailable for ANY product type; otherwise
// the existing clothing rule (zero at the serving CR hub) applies unchanged.
// Pure so the contract is pinned by src/utils/deactivation.test.js.
export function orderSizeOut(product, { clothingOrder, hubQty }) {
  if (isDeactivated(product)) return true;
  return !!clothingOrder && hubQty <= 0;
}

/** Short "who and when" line for a card. */
export function deactivationLine(p) {
  const d = p && p.deactivated;
  if (!d) return "";
  const when = d.at ? new Date(d.at).toLocaleDateString("en-ZA", { day: "numeric", month: "short" }) : "";
  const who = d.byName || "";
  return ["Deactivated", when, who && `by ${who}`].filter(Boolean).join(" ");
}
