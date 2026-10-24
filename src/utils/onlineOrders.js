// ── Website orders: the vocabulary every writer and reader shares ────────────
// The contract is docs/ONLINE-ORDERS.md. This module is plain ESM with no
// imports beyond sizeKey, so the Mac mini scripts (scripts/shopify/) and the
// store app import the SAME constants.
import { stockSizeKey } from "./sizeKey.js";

// ── WHAT AN ORDER IS CALLED: its Shopify order number ("#1768") ────────────
// Owner decision 2026-10-21: the website order is named by its Shopify order
// number everywhere a person reads it (POS, Display Checks, Settings, courier
// reference, sale, emails). `orderLabel` is the one spelling. `order.ref` (the
// old per-order three-letter code) survives only on orders pulled in before
// this change, as a fallback.
//
// ── THE THREE-LETTER CODE: one per HUB ORDER UNIT ───────────────────────────
// Every unit a hub sends for a website order (one pair of sneakers = one
// code) is its own /orders record keyed by a fresh code: three upper-case
// letters, never I or O, never a digit. Letters = website, digits = walk-in —
// staff seeing letters know it goes to Yasmin. Claimed in the registry
// /online_order_refs/{code} = { orderId: owner, at } (unique for 180 days,
// one exact-path transaction, never a scan). scripts/shopify/onlineOrders/
// orderRefs.mjs mintHubCode.
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

/** "#1768" — the name a person reads for a website order (a follow-up says so). */
export function orderLabel(order) {
  const n = order?.orderNumber;
  const base = n != null && String(n) !== "" ? `#${n}` : (order?.shopifyName || order?.ref || "#?");
  return order?.followUpOf != null ? `${base} (follow-up)` : base;
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
// A swapped line's old item, already handed over, going back to a shop's floor
// (scripts/lib/swap-line.mjs). One verdict: "put_back". Moves no stock.
export const ONLINE_RETURN_KIND = "online_return";

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
  // Nothing left to ship and nothing left to resolve: every line was
  // credited, refunded, resolved by hand or moved to a follow-up. Terminal.
  CLOSED: "closed",
});

export const TERMINAL_STATUSES = Object.freeze(["packed", "cancelled", "fulfilled_elsewhere", "closed"]);

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
  // Escalation (src/utils/onlineEscalation.js, docs/ONLINE-ORDERS.md § Escalation):
  RESOLVING: "resolving",     // climbing the chain; held where the units are going
  UNAVAILABLE: "unavailable", // the chain ran out; the customer agent has it
  RESOLVED: "resolved",       // credited / refunded / resolved by hand — ships nothing
  MOVED: "moved",             // came good after the pack; ships in a follow-up order
});

// Lines Pack does not wait for: they are not in the parcel and need no basket
// tick. A `resolving` line can still come good — after a pack it ships in a
// follow-up order of its own.
export const PARKED_LINE_STATUSES = Object.freeze(["resolving", "unavailable", "resolved", "moved"]);

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
  // Parked lines (escalating, unavailable, resolved off) are not waited for.
  const live = lines.filter((l) => !PARKED_LINE_STATUSES.includes(st(l)) && st(l) !== LINE_STATUS.CANCELLED);
  if (!live.length) {
    // Nothing to pack. Still waiting while a line climbs or the customer has
    // not chosen; closed once every line is settled.
    const open = lines.some((l) => st(l) === LINE_STATUS.RESOLVING || st(l) === LINE_STATUS.UNAVAILABLE);
    if (!open) return ORDER_STATUS.CLOSED;
    return enabled ? ORDER_STATUS.PICKING : ORDER_STATUS.NEW;
  }
  if (live.every((l) => st(l) === LINE_STATUS.HANDED)) return ORDER_STATUS.READY;
  if (enabled && live.every((l) => st(l) === LINE_STATUS.HANDED || l?.source?.entryKey)) return ORDER_STATUS.PICKING;
  return ORDER_STATUS.NEW;
}
