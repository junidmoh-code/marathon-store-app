// ─── WEBSITE ORDERS — Needs Attention: the rows and the Resolve write ────────
// Pure (no Firebase), so the one write Settings → Online orders makes is
// pinned by tests (attention.test.js). Contract: docs/ONLINE-ORDERS.md
// "Attention and email".
//
// RESOLVE, by attention kind:
//   unresolved / no_stock / not_found / walkin_override
//       → every line whose source.status puts the order in attention goes to
//         "reroute" (the poller routes it again on its next tick), the
//         attention is cleared, the order goes back to "new".
//   fulfil_failed
//       → fulfilState + fulfil/state back to "pending": the poller retries the
//         Shopify fulfilment. The packed order stays packed.
//   cancelled_after_pack
//       → acknowledge only: the attention is cleared, nothing else changes
//         (the contract leaves a packed-then-cancelled order alone, flagged).
// Every branch clears `attention` AND `attentionOpen` together — the Settings
// list is the indexed attentionOpen query, so a cleared attention with the
// flag left true would sit in the list for ever with nothing to show.

import { ATTENTION_KIND, ATTENTION_LINE_STATUSES, LINE_STATUS, ONLINE_ORDERS_PATH, ORDER_STATUS } from "../../utils/onlineOrders";

const REROUTE_KINDS = new Set([
  ATTENTION_KIND.UNRESOLVED, ATTENTION_KIND.NO_STOCK, ATTENTION_KIND.NOT_FOUND, ATTENTION_KIND.WALKIN_OVERRIDE,
]);

// The lines of an order as [index, line] pairs, whichever shape RTDB handed
// back (an array, or an index-keyed object once a hole or a child write
// coerced it). Index keys only — the index IS the line's address.
export function orderLineEntries(order) {
  const lines = order?.lines;
  if (!lines || typeof lines !== "object") return [];
  return Object.entries(lines)
    .filter(([k, l]) => /^\d+$/.test(k) && l && typeof l === "object")
    .map(([k, l]) => [Number(k), l]);
}

/** What the Resolve button does for this order, in words, or null if nothing. */
export function resolveLabel(kind) {
  if (REROUTE_KINDS.has(kind)) return "Re-route";
  if (kind === ATTENTION_KIND.FULFIL_FAILED) return "Retry Shopify";
  if (kind === ATTENTION_KIND.COURIER_FAILED) return "Retry courier";
  if (kind === ATTENTION_KIND.CANCELLED_AFTER_PACK) return "Acknowledge";
  return null;
}

/**
 * The root multi-path update Resolve writes for one order, or null when this
 * order's attention kind has no resolve (unknown kind — never guessed).
 */
export function resolveAttentionUpdates(orderId, order) {
  if (typeof orderId !== "string" || !orderId || /[.#$[\]/]/.test(orderId)) return null;
  const kind = order?.attention?.kind;
  const base = `${ONLINE_ORDERS_PATH}/${orderId}`;
  const clear = { [`${base}/attention`]: null, [`${base}/attentionOpen`]: null };
  if (REROUTE_KINDS.has(kind)) {
    const out = { ...clear, [`${base}/status`]: ORDER_STATUS.NEW };
    for (const [i, line] of orderLineEntries(order)) {
      if (ATTENTION_LINE_STATUSES.includes(line?.source?.status)) {
        out[`${base}/lines/${i}/source/status`] = LINE_STATUS.REROUTE;
      }
    }
    return out;
  }
  // Both hand the order back to the Mac mini: it re-runs the courier booking
  // (only if there is no waybill yet), then the Shopify fulfilment. Never a sale.
  if (kind === ATTENTION_KIND.FULFIL_FAILED || kind === ATTENTION_KIND.COURIER_FAILED) {
    return { ...clear, [`${base}/fulfilState`]: "pending", [`${base}/fulfil/state`]: "pending" };
  }
  if (kind === ATTENTION_KIND.CANCELLED_AFTER_PACK) return clear;
  return null;
}

/** The attentionOpen query's value → list rows, newest attention first. */
export function attentionRows(val) {
  if (!val || typeof val !== "object") return [];
  return Object.entries(val)
    .filter(([, o]) => o && typeof o === "object" && o.attentionOpen === true)
    .map(([orderId, o]) => ({
      orderId,
      ref: o.ref || orderId,
      customer: o.customer?.name || "—",
      kind: o.attention?.kind || "unknown",
      reason: o.attention?.reason || "",
      at: Number(o.attention?.at) || null,
      order: o,
    }))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}

// ── "Rung by hand at a till" ─────────────────────────────────────────────────
// Until the switch goes on, staff still ring web sales by hand. An order pulled
// in during that time and rung by hand must never be packed as well (the pack
// would deduct the same units a second time), so Junid can let any open order
// go from here. The write only ASKS: status release_requested. The Mac mini
// poller closes its feed entries (display entries are server-only) and
// releases its holds on its next tick, then marks it fulfilled_elsewhere. The
// POS refuses to pack a release_requested order, and the rules refuse a pack
// over it.
export const OPEN_STATUSES = Object.freeze(["new", "picking", "ready", "needs_attention"]);

export function rungByHandUpdates(orderId, { by, at }) {
  if (typeof orderId !== "string" || !orderId || /[.#$[\]/]/.test(orderId)) return null;
  const base = `${ONLINE_ORDERS_PATH}/${orderId}`;
  return {
    [`${base}/status`]: ORDER_STATUS.RELEASE_REQUESTED,
    [`${base}/handledByHand`]: { by, at },
    [`${base}/attention`]: null,
    [`${base}/attentionOpen`]: null,
  };
}

/** The open-order queries' values merged → rows, newest order first. */
export function openOrderRows(byStatus) {
  const rows = [];
  for (const val of Object.values(byStatus || {})) {
    for (const [orderId, o] of Object.entries(val || {})) {
      if (!o || typeof o !== "object" || !OPEN_STATUSES.includes(o.status)) continue;
      rows.push({ orderId, ref: o.ref || orderId, customer: o.customer?.name || "—", status: o.status, createdAt: Number(o.createdAt) || 0, lines: orderLineEntries(o).length });
    }
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}
