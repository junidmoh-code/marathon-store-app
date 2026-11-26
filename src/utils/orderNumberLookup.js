// ─── FINDING AN ORDER BY ITS NUMBER (Junid, 26 Nov 2026) ─────────────────────
//
// A shop order number is a DAILY counter ("007" comes round again every day,
// and Pine / Concrete may carry a prefix, "P007"), so a typed number is not an
// identity. Junid tracked 007, placed that morning, and the tracker showed an
// order from three days before. One rule for every screen that turns a typed
// number into an order:
//
//   1. Only CUSTOMER order keys answer to a number. Refill-cart lines
//      ("R007-22") and website codes ("FBQ") never do, whatever they contain.
//   2. The shop the person is working in first. Other shops only when nothing
//      at this shop has the number.
//   3. OPEN orders (incoming, ready, coming tomorrow) first, newest first, so
//      today's comes before an older one. If more than one is open, the screen
//      shows a short picker (date, time, shop, customer) and staff tap one.
//   4. When nothing is open: today's finished orders (collected / out of stock).
//   5. Finished orders from EARLIER days only when nothing above matched, and
//      always marked with their date (`earlier: true` on the option).
//
// /orders keeps one record per key (the next day's order overwrites it), so
// this does not bring back an overwritten order: it separates different keys
// with the same number ("007" / "P007") and dates any record that is not
// today's — including an old copy a device may still hold.
//
// Pure: no Firebase, no clock. `nowMs` is injected (serverNowMs() on screens).
// It only reads the list the screen already holds — it never widens a read.

import { parseOrderKey } from "./orderNumbering";

const SA_OFFSET_MS = 2 * 60 * 60 * 1000;

const OPEN = new Set(["incoming", "ready", "coming_tomorrow"]);

/** "YYYY-MM-DD" in South African time, or null. */
export function saDayOf(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return new Date(ms + SA_OFFSET_MS).toISOString().slice(0, 10);
}

function createdMs(o) {
  const t = Date.parse(o?.createdAt || "");
  return Number.isFinite(t) ? t : NaN;
}

/**
 * What the person typed, as { prefix, number } — or null when it is not an
 * order number. "7", "007", "#007" → { prefix: null, number: 7 } (any shop's
 * sequence); "p7", "P007" → { prefix: "P", number: 7 } (that sequence only).
 * A refill number ("R007") is not a customer order number.
 */
export function parseTypedOrderNumber(typed) {
  const clean = String(typed ?? "").trim().replace(/^#/, "").toUpperCase();
  const m = /^([A-Z]{0,3})0*(\d{1,3})$/.exec(clean);
  if (!m) return null;
  if (m[1].startsWith("R")) return null;
  return { prefix: m[1] || null, number: Number(m[2]) };
}

/** Does this order answer to the typed number? Customer order keys only. */
export function orderMatchesNumber(order, want) {
  if (!order || !want) return false;
  if (order.channel === "online") return false;
  // Soft-deleted orders answer to nothing (same three flags App.jsx treats as gone).
  if (order.deleted || order.removed || order.archived) return false;
  const p = parseOrderKey(order.id);
  if (p.kind !== "order") return false;
  if (p.number !== want.number) return false;
  return want.prefix == null || p.prefix === want.prefix;
}

export const isOpenOrder = (o) => OPEN.has(o?.status) && !o?.deleted && !o?.removed && !o?.archived;

const newestFirst = (a, b) => (createdMs(b) || 0) - (createdMs(a) || 0);

/**
 * Resolve a typed number against the orders a screen already holds.
 *
 * @param orders  the screen's order list (array of order records with `id`)
 * @param typed   what was typed ("7", "007", "P7")
 * @param opts.shop   the shop the person is working in (destShop id), or null
 * @param opts.nowMs  server-anchored now
 * @returns {{
 *   kind: "none" | "one" | "pick",
 *   options: Array<{ order, day, today, earlier, open, otherShop }>,
 *   scope: "shop" | "all" | null,
 * }}
 *   "one"  → options[0] is the order (check `earlier` to show its date);
 *   "pick" → the screen shows every option and staff tap one.
 */
export function lookupOrderByNumber(orders, typed, { shop = null, nowMs } = {}) {
  const want = parseTypedOrderNumber(typed);
  const none = { kind: "none", options: [], scope: null };
  if (!want) return none;
  const all = (Array.isArray(orders) ? orders : []).filter((o) => orderMatchesNumber(o, want));
  if (!all.length) return none;

  const atShop = shop ? all.filter((o) => o.destShop === shop) : [];
  const scope = atShop.length ? "shop" : "all";
  const pool = atShop.length ? atShop : all;

  const today = saDayOf(nowMs);
  const shape = (o) => {
    const day = saDayOf(createdMs(o));
    return {
      order: o,
      day,
      today: !!day && day === today,
      earlier: !day || (!!today && day < today),
      open: isOpenOrder(o),
      otherShop: !!shop && o.destShop !== shop,
    };
  };

  // Tiers, first non-empty wins. A record with no usable date is never
  // "today" — it can only ever show as an earlier, dated (unknown) one.
  // Newest first puts today's open orders before older open ones.
  const open = pool.filter(isOpenOrder).sort(newestFirst).map(shape);
  if (open.length) return { kind: open.length === 1 ? "one" : "pick", options: open, scope };

  const finished = pool.filter((o) => !isOpenOrder(o)).sort(newestFirst).map(shape);
  const todays = finished.filter((x) => x.today);
  if (todays.length) return { kind: todays.length === 1 ? "one" : "pick", options: todays, scope };
  if (finished.length) return { kind: finished.length === 1 ? "one" : "pick", options: finished, scope };
  return none;
}

/**
 * Every order answering to the typed number, in the order a list should show
 * them: this shop's before other shops', open before finished, today's before
 * older, newest first. For search lists (the tracker's rail), where all
 * matches are shown and the person taps one. [] when it is not a number.
 */
export function rankOrdersForNumber(orders, typed, { shop = null, nowMs } = {}) {
  const want = parseTypedOrderNumber(typed);
  if (!want) return [];
  const today = saDayOf(nowMs);
  const key = (o) => [
    shop && o.destShop === shop ? 0 : 1,
    isOpenOrder(o) ? 0 : 1,
    saDayOf(createdMs(o)) === today ? 0 : 1,
  ];
  return (Array.isArray(orders) ? orders : [])
    .filter((o) => orderMatchesNumber(o, want))
    .sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
      return newestFirst(a, b);
    });
}

/** "Thu 26 Nov · 08:42" in South African time, for a picker row or a date mark. */
export function orderWhenLabel(order) {
  const t = createdMs(order);
  if (!Number.isFinite(t)) return "date unknown";
  const d = new Date(t + SA_OFFSET_MS);
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${wd} ${d.getUTCDate()} ${mo} · ${hh}:${mm}`;
}

/** First name and surname initial — enough to tell two customers apart on a picker. */
export function shortCustomerName(name) {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`;
}
