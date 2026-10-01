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
// `deactivated` defaults to the product's own flag, which is what every strict
// store wants. An EXEMPT store (the Pine exemption — src/config/
// assistantVisibility.js) passes `false`: at Pine a deactivated line is shown
// AND orderable, because Hub 3 is uncounted and the shoe may be on the shelf.
// Overriding here rather than at three call sites keeps the size rule single.
export function orderSizeOut(product, { clothingOrder, hubQty, deactivated }) {
  if (deactivated === undefined ? isDeactivated(product) : !!deactivated) return true;
  return !!clothingOrder && hubQty <= 0;
}

// ── THE BROWSE FILTER (owner spec 2026-08-31, BUG 1) ─────────────────────────
// The flag was being WRITTEN and not READ: "Air foce 1" sat in the Deactivated
// list AND still rendered as an orderable Tap-to-add card in the product grid.
// orderSizeOut above only greys the SIZES — the card was still there, and staff
// tapped whichever copy they saw first, found no sizes, and lost the sale.
//
// So every list a product is BROWSED from drops deactivated records here. The
// places a deactivated product must still be findable are deliberately NOT
// browse lists and must NOT call this:
//   • the merge picker (mergeSearch.js — already marks them "· deactivated"),
//   • the Deactivated list on the Leftovers tab, where it is reactivated,
//   • the ADMIN / Stock section's own searches (Adjust, Set Qty, Count,
//     Transfer, Locator, Movement History, Network Totals, Barcode catalogue,
//     Seating, Label print) — a deactivated product keeps every detail, its
//     stock and its history there, which is the whole point of a flag.
//
// AMENDED 2026-09-05 (owner spec, BUG 1). SEARCH used to be on that list: a
// typed query searched the FULL universe and marked the hits. That is still
// true in the admin section — and is now FALSE in the assistant view, the one
// screen facing a customer, where a marked hit was read as "no stock" and cost
// the sale. AssistantView therefore gates its whole pool (`base`) instead, so
// browse AND search are covered by one filter, with Marathon Pine exempt by
// config. See src/config/assistantVisibility.js.
export function browsableProducts(list) {
  return (list || []).filter((p) => !isDeactivated(p));
}

/** Short "who and when" line for a card. */
export function deactivationLine(p) {
  const d = p && p.deactivated;
  if (!d) return "";
  const when = d.at ? new Date(d.at).toLocaleDateString("en-ZA", { day: "numeric", month: "short" }) : "";
  const who = d.byName || "";
  return ["Deactivated", when, who && `by ${who}`].filter(Boolean).join(" ");
}
