// ── Website orders: the vocabulary every writer and reader shares ────────────
// The contract is docs/ONLINE-ORDERS.md. This module is plain ESM with no
// imports beyond sizeKey, so the Mac mini scripts (scripts/shopify/) and the
// store app import the SAME constants.
import { stockSizeKey } from "./sizeKey.js";

// ── THE ORDER REF: a three-letter code ──────────────────────────────────────
// order.ref is three upper-case letters, no digits, no prefix, no dash (KQZ).
// I and O are never used (they read as 1 and 0 on a handwritten parcel).
// Minted once when the order is pulled in (scripts/shopify/onlineOrders/
// orderRefs.mjs), unique against every order of the last 180 days through the
// registry /online_order_refs/{code} = { orderId, at } — an exact-path lookup,
// never a scan. The Shopify order number stays on the order as `orderNumber`.
export const ORDER_REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 24 letters, no I, no O
export const ORDER_REF_LENGTH = 3;
export const ORDER_REF_REUSE_AFTER_MS = 180 * 24 * 3600 * 1000;
export const ONLINE_ORDER_REFS_PATH = "online_order_refs";

/** Is `s` a well-formed order code (exactly 3 letters from the alphabet)? */
export function isOrderRefCode(s) {
  return typeof s === "string" && s.length === ORDER_REF_LENGTH && [...s].every((c) => ORDER_REF_ALPHABET.includes(c));
}

/** A random code. `rand` returns [0,1) — injected by tests. */
export function randomOrderRef(rand = Math.random) {
  let out = "";
  for (let i = 0; i < ORDER_REF_LENGTH; i++) out += ORDER_REF_ALPHABET[Math.floor(rand() * ORDER_REF_ALPHABET.length) % ORDER_REF_ALPHABET.length];
  return out;
}

/** A scanned or typed value folded for comparison with a ref: letters and digits, upper case ("kqz" → "KQZ"). */
export function foldOrderRef(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Paths. /online_reservations rows are keyed by the stock cell's size key.
export const ONLINE_ORDERS_PATH = "online_orders";
export const ONLINE_RESERVATIONS_PATH = "online_reservations";
export const ONLINE_PICKS_PATH = "online_picks";
export const ONLINE_ORDERS_CONFIG_PATH = "config/onlineOrders";

export const reservationCellPath = (pid, size) =>
  `${ONLINE_RESERVATIONS_PATH}/${pid}/${stockSizeKey(size)}`;

// The one instruction every pick and display entry carries.
export const PACKER_INSTRUCTION = "Give to Yasmin at Marathon PE";
export const PACKING_STORE = "marathon-pe";

// Feed entry kind, on /online_picks rows and on display-check records.
export const ONLINE_PICK_KIND = "online_pick";

export const ORDER_STATUS = Object.freeze({
  NEW: "new",
  PICKING: "picking",
  READY: "ready",
  NEEDS_ATTENTION: "needs_attention",
  PACKED: "packed",
  CANCELLED: "cancelled",
  // Fulfilled in the Shopify admin while the switch was OFF: handled the old
  // way (rung by hand at a till), so the app lets go of it. Terminal.
  FULFILLED_ELSEWHERE: "fulfilled_elsewhere",
  // Junid pressed "Rung by hand at a till" in Settings: the poller closes the
  // order's feed entries and releases its holds, then sets fulfilled_elsewhere.
  RELEASE_REQUESTED: "release_requested",
});

export const TERMINAL_STATUSES = Object.freeze(["packed", "cancelled", "fulfilled_elsewhere"]);

// Orders whose lines still hold stock.
export const HOLDING_STATUSES = Object.freeze(["new", "picking", "ready", "needs_attention"]);

export const LINE_STATUS = Object.freeze({
  PICK: "pick",
  DISPLAY: "display",
  HANDED: "handed",
  NO_STOCK: "no_stock",
  NOT_FOUND: "not_found",
  NEEDS_ATTENTION: "needs_attention",
  UNRESOLVED: "unresolved",
  REROUTE: "reroute",
  CANCELLED: "cancelled",
});

// A line in one of these puts its order in needs_attention.
export const ATTENTION_LINE_STATUSES = Object.freeze(["no_stock", "not_found", "needs_attention", "unresolved"]);

export const ATTENTION_KIND = Object.freeze({
  UNRESOLVED: "unresolved",
  NO_STOCK: "no_stock",
  NOT_FOUND: "not_found",
  WALKIN_OVERRIDE: "walkin_override",
  CANCELLED_AFTER_PACK: "cancelled_after_pack",
  FULFIL_FAILED: "fulfil_failed",
  // Packed, but the live Courier Guy booking did not happen (failed, refused
  // or unconfirmed). The Shopify fulfilment waits for it; the POS Retry
  // re-runs the booking only.
  COURIER_FAILED: "courier_failed",
});

// The carrier name Shopify shows the customer next to the waybill.
export const COURIER_COMPANY = "The Courier Guy";

/**
 * Units of `pid/size` held at `loc` by website orders, from the reservation
 * cell's value ({ [orderId]: { qty, ref, locs } }). With no `loc`, every held
 * unit. Never negative; a malformed row counts as nothing.
 */
export function heldUnits(cell, loc = null) {
  let n = 0;
  for (const row of Object.values(cell || {})) {
    if (!row || typeof row !== "object") continue;
    const q = loc == null ? Number(row.qty) : Number(row.locs?.[loc]);
    if (Number.isFinite(q) && q > 0) n += q;
  }
  return n;
}

/**
 * The status an open order should show, from its lines. Packed, cancelled and
 * fulfilled_elsewhere are terminal. `enabled` is /config/onlineOrders/enabled: while it is off no
 * feed entry exists, so an order cannot be "picking".
 */
export function deriveOrderStatus(order, { enabled = false } = {}) {
  const status = order?.status;
  if (TERMINAL_STATUSES.includes(status) || status === ORDER_STATUS.RELEASE_REQUESTED) return status;
  const lines = Array.isArray(order?.lines) ? order.lines.filter(Boolean) : Object.values(order?.lines || {}).filter(Boolean);
  if (!lines.length) return ORDER_STATUS.NEEDS_ATTENTION;
  const st = (l) => l?.source?.status;
  if (lines.some((l) => ATTENTION_LINE_STATUSES.includes(st(l)))) return ORDER_STATUS.NEEDS_ATTENTION;
  if (lines.every((l) => st(l) === LINE_STATUS.HANDED)) return ORDER_STATUS.READY;
  if (enabled && lines.every((l) => st(l) === LINE_STATUS.HANDED || l?.source?.entryKey)) return ORDER_STATUS.PICKING;
  return ORDER_STATUS.NEW;
}
