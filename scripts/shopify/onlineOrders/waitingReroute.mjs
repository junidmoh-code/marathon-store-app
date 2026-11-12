// ── A line WAITING ON REFILL routes itself when the stock lands (Junid, 12 Nov 2026) ──
// "If no shop or hub has the line, it waits for the existing refill scan to
// bring stock in, then routes as normal." A line nobody could pick is
// `no_stock` with NO location (routing.mjs's "nowhere"). Each keep tick this
// looks at its live stock with the very reads a new order's routing uses
// (availabilityFor: the routed shops and hubs minus other website orders'
// holds) and, the moment any unit of it is free on the route, sends it back to
// `reroute` — the state Settings → Resolve and "Order it now" use — so the SAME
// keep pass routes it like a fresh Shopify line: a hub order at Hub 1/2/3 or a
// strip entry at PE / Trophy / Concrete / Pine. A part it still cannot place
// is split off and keeps waiting.
//
// IT RAISES NOTHING. No request, no refill row, no card: the hourly refill
// scan alone decides what comes in from Central (CLAUDE.md, Junid's rules).
// Central's count is only READ, to say honestly what the line is waiting on —
// `source.waiting = { on: "refill", centralQty, since, checkedAt }` — so packers and
// Jamie can tell "coming from Central" from "not anywhere".
//
// ONLY THE PLAIN WAIT. A no_stock a hub or shop GAVE (it has a locationId: the
// hub marked its order Out of Stock) is left for a person, as before — routing
// it again would send it straight back to the hub whose cell still says it has
// one. Anything a person or the customer agent is busy with is left alone too
// (the same conditions "Order it now" refuses on).
import { ONLINE_ORDERS_PATH, LINE_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";
import { linesOf } from "./orderModel.mjs";
import { routeLines } from "./routing.mjs";

export const WAITING_ON_REFILL = "refill";

const clean = (v) => JSON.parse(JSON.stringify(v ?? null));

/**
 * Is this line waiting on refill — nowhere on the route had it? PURE.
 * Also the same wait after Jamie (marathon-dm-agent lineStatus.js park) offered
 * the customer alternatives: Jamie rewrites the line to `unavailable` with
 * `source.by: "jamie", was: "no_stock"`. While the customer is still choosing
 * (awaitingCustomer) it is left alone (waitingBlocker); once they said "wait"
 * Jamie drops its mark and the line waits on refill like any other.
 */
export function isWaitingOnRefill(line) {
  const src = line?.source;
  if (!line?.pid || !src || src.locationId) return false;
  if (src.status === LINE_STATUS.NO_STOCK) return true;
  return src.status === LINE_STATUS.UNAVAILABLE && src.by === "jamie" && src.was === LINE_STATUS.NO_STOCK;
}

/** Why the line must be left alone this tick, or null. PURE. */
export function waitingBlocker({ line, order, enabled }) {
  if (!enabled) return "feeds off";
  if (!isWaitingOnRefill(line)) return "not waiting on refill";
  if (order?.packClaim || order?.pack) return "being packed";
  if (line.escalation) return "an escalation chain owns it";
  if (line.swappedFrom) return "replaced line";
  if (line.awaitingCustomer || line.resolution?.conversation) return "with the customer";
  if (line.escalationOverride && !line.escalationOverride.appliedAt) return "Junid's decision pending";
  if (line.resolution?.money || line.resolution?.outcome) return "settled by hand";
  return null;
}

/** The `waiting` stamp for a line still waiting. PURE. Unchanged count → same stamp (no write). */
// `since` is when the line started waiting and survives every re-stamp.
export function waitingStamp(prev, centralQty, nowMs) {
  const qty = Math.max(0, Number(centralQty) || 0);
  const same = prev && prev.on === WAITING_ON_REFILL;
  if (same && Number(prev.centralQty) === qty) return prev;
  return { on: WAITING_ON_REFILL, centralQty: qty, since: same && Number(prev.since) ? Number(prev.since) : nowMs, checkedAt: nowMs };
}

/**
 * Look at every line of one open order that waits on refill.
 *   helpers  { availabilityFor, resolveVariant } — poll.mjs's own
 * → true when a line was sent back to `reroute` (the caller re-reads the order).
 */
export async function applyWaitingReroutes(ctx, id, order, helpers) {
  const lines = linesOf(order);
  let rerouted = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (waitingBlocker({ line, order, enabled: ctx.enabled })) continue;
    const r = await helpers.resolveVariant(ctx, line.variantId, line.productGid, line.title);
    if (!r.pid || r.pid !== line.pid || r.sizeKey !== line.sizeKey) continue; // a person must look (the attention already says so)
    const key = `${r.pid}|${r.sizeKey}`;
    const ownOther = {};
    lines.forEach((l, k) => {
      if (k === i || !l?.pid || !l.source?.locationId || `${l.pid}|${l.sizeKey}` !== key) return;
      (ownOther[key] ||= {})[l.source.locationId] = ((ownOther[key] || {})[l.source.locationId] || 0) + (Number(l.qty) || 0);
    });
    const available = (await helpers.availabilityFor(ctx, id, [r], ownOther))[key] || {};
    const qty = Math.max(1, Number(line.qty) || 1);
    const pieces = routeLines([{ key, qty, isFootwear: r.isFootwear }], { [key]: available })[0] || [];
    const routable = pieces.some((p) => p.locationId);
    const centralQty = Number(await ctx.get(`stock/central/${r.pid}/${r.sizeKey}/qty`)) || 0;
    const res = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines/${i}`).transaction((cur) => {
      if (cur == null) return null; // cold-cache pass: never abort on it
      if (waitingBlocker({ line: cur, order: { ...order, lines: undefined }, enabled: true })) return undefined;
      if ((Number(cur.routeGen) || 0) !== (Number(line.routeGen) || 0)) return undefined;
      if (routable) {
        return clean({ ...cur, source: { ...cur.source, status: LINE_STATUS.REROUTE, waiting: null }, waitingRerouteAt: ctx.now });
      }
      const stamp = waitingStamp(cur.source?.waiting, centralQty, ctx.now);
      if (stamp === cur.source?.waiting) return undefined; // nothing new to say
      return clean({ ...cur, source: { ...cur.source, waiting: stamp } });
    });
    if (!res.committed || !res.snapshot.val()) continue;
    if (routable) {
      rerouted = true;
      ctx.summary.waitingRerouted = (ctx.summary.waitingRerouted || 0) + 1;
      ctx.log(`  ↻ ${orderLabel(order)} line ${i + 1}: stock arrived (${pieces.filter((p) => p.locationId).map((p) => `${p.locationId} ×${p.qty}`).join(", ")}) — routed again`);
    }
  }
  return rerouted;
}
