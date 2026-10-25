// ── The POS "Order it now" button, applied on the Mac mini (Junid, 2026-10-25) ──
// A website-order line that went grey (out of stock, being resolved, missing)
// stayed grey even after the item was found and the stock fixed: the chain
// waits on its open request (a Central refill, a Hub 2 card) or has given up.
// One tap on the POS asks this tick to look again:
//
//   /online_orders/{id}/orderNowRequests/{lineIndex}_{routeGen} =
//     { lineIndex, expectPid, expectSizeKey, expectStatus, expectRouteGen,
//       by: {uid, name}, at, state: "pending", previous?: [...] }   ← the POS
//     → state "ordered"      { routedTo, checked, answeredAt }       ← here
//     → state "not_in_stock" { checked, answeredAt }   the line is left as it is
//     → state "refused"      { why, answeredAt }       e.g. a pick is already open
//
// It re-checks LIVE stock with the very reads a new order's routing uses
// (availabilityFor / routeLines: the cells at the routed shops and hubs minus
// what other website orders hold there). When the line can be routed in full
// it is sent back to `reroute` — the state Settings → Resolve uses — so the
// SAME keep pass routes it exactly like a fresh Shopify line and raises its hub
// order (/orders/{code}, a fresh three-letter code) or shop strip entry, its
// hold and its parcel estimate. Nothing else raises anything.
//
// NEVER TWICE. A line already on a pick (status pick / display), already
// being routed, or with a raise in flight is refused and says so. An open
// escalation request (Central refill / Hub 2 Shop Refill card) is withdrawn
// first, and only while nobody has touched it (escalate.mjs withdrawRequest);
// one already being worked on is refused ("already ordered"). Requests are
// keyed per line and route generation, and claimed in a transaction.
//
// NOTHING HERE MOVES STOCK. Stock still deducts only at Pack. No refill
// policy, target or request logic is touched.
import { ONLINE_ORDERS_PATH, LINE_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";
import { linesOf } from "./orderModel.mjs";
import { routeLines, routeFor } from "./routing.mjs";
import { withdrawRequest, ESCALATIONS_PATH } from "./escalate.mjs";

export const ORDER_NOW = Object.freeze({ PENDING: "pending", APPLYING: "applying", ORDERED: "ordered", NOT_IN_STOCK: "not_in_stock", REFUSED: "refused" });
export const STUCK_ORDER_NOW_MS = 5 * 60 * 1000;
// The grey lines: out of stock, being resolved, missing, given up on.
export const ORDER_NOW_LINE = Object.freeze([LINE_STATUS.RESOLVING, LINE_STATUS.UNAVAILABLE, LINE_STATUS.NO_STOCK, LINE_STATUS.NOT_FOUND, LINE_STATUS.NEEDS_ATTENTION]);
export const PLACE = Object.freeze({ hub1: "Hub 1", hub2: "Hub 2", "marathon-pe": "Marathon PE", trophy: "Trophy", central: "Central" });

const clean = (v) => JSON.parse(JSON.stringify(v ?? null));
const place = (loc) => PLACE[loc] || loc;
const sameSpot = (a, b) => (!a && !b) || (a && b && a.phase === b.phase && a.round === b.round && a.idx === b.idx);

/**
 * Why line `line` cannot be ordered now, or null. PURE.
 *   req      the POS request (expectPid, expectSizeKey, expectRouteGen)
 *   enabled  /config/onlineOrders/enabled (no pick can be raised while off)
 */
export function orderNowBlocker({ line, req, enabled }) {
  if (!enabled) return "the website-order feeds are switched off, so no pick can be raised";
  if (!line?.pid) return "the line is gone";
  if (String(line.pid) !== String(req.expectPid ?? "") || String(line.sizeKey ?? "") !== String(req.expectSizeKey ?? "")) return "the line changed since the tap (another item or size); look again";
  if ((Number(line.routeGen) || 0) !== (Number(req.expectRouteGen) || 0)) return "the line was routed again since the tap; look again";
  const st = line.source?.status;
  if (st === LINE_STATUS.PICK || st === LINE_STATUS.DISPLAY) {
    const where = place(line.source?.locationId);
    const codes = Array.isArray(line.source?.orderKeys) ? line.source.orderKeys.join(", ") : "";
    return `a pick is already open for this line${where ? ` at ${where}` : ""}${codes ? ` (${codes})` : ""}; not ordered twice`;
  }
  if (st === LINE_STATUS.REROUTE) return "this line is already being routed; not ordered twice";
  if (st === LINE_STATUS.HANDED) return "this line was already handed over";
  if (!ORDER_NOW_LINE.includes(st)) return `the line is "${st || "unknown"}", not out of stock`;
  // A re-route rebuilds the line from the ORIGINAL Shopify item: on a replaced
  // line that would quietly undo the replacement.
  if (line.swappedFrom) return "this line was replaced with another item; Order it now would undo that. Ask Junid";
  if (line.escalation?.pending) return "an order for this line is being raised right now; not ordered twice";
  // Sent already: the stock moved when it was sent, but the box lands by
  // 11:00 the next working day, when the chain puts the line on the pick.
  if (line.escalation?.phase === "wait") {
    const by = Number(line.escalation.waitUntil) ? ` (by ${new Date(Number(line.escalation.waitUntil) + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " ")})` : "";
    return `already ordered: it was sent to ${place(line.escalation.deliverAt) || "its shop"} and goes on the pick when the box lands${by}; not ordered twice`;
  }
  if (line.awaitingCustomer || line.resolution?.conversation?.state === "offering") return "the customer is being offered alternatives for this line; settle that first";
  return null;
}

/** "Hub 1: 0 free, Hub 2: 0 free · Central has 3 (a refill, not a pick)". PURE. */
export function describeChecked(checked) {
  const free = (checked?.free || []).map((c) => `${place(c.loc)}: ${c.free} free`).join(", ");
  const central = Number(checked?.central) > 0 ? ` · Central has ${checked.central} (Central sends by refill, not a pick)` : "";
  return `${free || "nowhere to check"}${central}`;
}

/**
 * Apply every pending "Order it now" on this order. → true when a line was
 * sent back to `reroute` (the caller re-reads the order before keeping it).
 *   helpers  { availabilityFor, resolveVariant } — poll.mjs's own, the reads a new order's routing uses
 */
export async function applyOrderNowRequests(ctx, id, order, helpers) {
  const reqs = Object.entries(order?.orderNowRequests || {})
    .filter(([, r]) => r && (r.state === ORDER_NOW.PENDING || (r.state === ORDER_NOW.APPLYING && ctx.now - Number(r.claimedAt) >= STUCK_ORDER_NOW_MS)))
    .sort((a, b) => Number(a[1].at) - Number(b[1].at));
  let rerouted = false;
  for (const [rid, req] of reqs) {
    const path = `${ONLINE_ORDERS_PATH}/${id}/orderNowRequests/${rid}`;
    const claim = await ctx.db.ref(path).transaction((cur) => {
      if (cur == null) return null;
      const stuck = cur.state === ORDER_NOW.APPLYING && ctx.now - Number(cur.claimedAt) >= STUCK_ORDER_NOW_MS;
      if (cur.state !== ORDER_NOW.PENDING && !stuck) return undefined;
      return { ...cur, state: ORDER_NOW.APPLYING, claimedAt: ctx.now };
    });
    if (!claim.committed || !claim.snapshot.val()) continue;
    const who = req.by?.name || req.by?.uid || "someone";
    const answer = async (patch) => {
      await ctx.db.ref(path).update(clean({ ...patch, answeredAt: ctx.now }));
      ctx.log(`  ${patch.state === ORDER_NOW.ORDERED ? "✓" : "·"} ${orderLabel(order)} line ${Number(req.lineIndex) + 1}: Order it now (${who}, ${new Date(Number(req.at) || ctx.now).toISOString()}) → ${patch.state}${patch.why ? `: ${patch.why}` : ""}${patch.checked ? ` [${describeChecked(patch.checked)}]` : ""}`);
    };
    try {
      const i = Number(req.lineIndex);
      const fresh = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
      const lines = linesOf(fresh);
      const line = lines[i];
      // RESUME: a crash after the line was sent to reroute but before this
      // request said so — the line carries this request's id.
      if (line?.orderNow?.rid === rid) { await answer({ state: ORDER_NOW.ORDERED, routedTo: line.source?.locationId || null, resumed: true }); rerouted = true; continue; }
      const blocked = orderNowBlocker({ line, req, enabled: ctx.enabled });
      if (blocked) { await answer({ state: ORDER_NOW.REFUSED, why: blocked }); continue; }

      // ── Live stock, exactly as a new order is routed ──
      const r = await helpers.resolveVariant(ctx, line.variantId, line.productGid, line.title);
      if (!r.pid) { await answer({ state: ORDER_NOW.REFUSED, why: r.reason || "the Shopify item is not linked to a product in the app" }); continue; }
      if (r.pid !== line.pid || r.sizeKey !== line.sizeKey) { await answer({ state: ORDER_NOW.REFUSED, why: "the line no longer matches its Shopify item; ask Junid" }); continue; }
      const key = `${r.pid}|${r.sizeKey}`;
      const ownOther = {};
      lines.forEach((l, k) => {
        if (k === i || !l?.pid || !l.source?.locationId || `${l.pid}|${l.sizeKey}` !== key) return;
        (ownOther[key] ||= {})[l.source.locationId] = ((ownOther[key] || {})[l.source.locationId] || 0) + (Number(l.qty) || 0);
      });
      const available = (await helpers.availabilityFor(ctx, id, [r], ownOther))[key] || {};
      const qty = Math.max(1, Number(line.qty) || 1);
      const pieces = routeLines([{ key, qty, isFootwear: r.isFootwear }], { [key]: available })[0] || [];
      const central = Number(await ctx.get(`stock/central/${r.pid}/${r.sizeKey}/qty`)) || 0;
      const checked = { free: routeFor(r.isFootwear).map((s) => ({ loc: s.locationId, free: Math.max(0, Number(available[s.locationId]) || 0) })), central };
      const routedQty = pieces.filter((p) => p.locationId).reduce((s, p) => s + p.qty, 0);
      if (routedQty < qty) { await answer({ state: ORDER_NOW.NOT_IN_STOCK, checked }); continue; }

      // ── Never twice: the open escalation request goes first, untouched only ──
      const esc = line.escalation;
      let withdrew = null;
      if (esc?.phase === "await" && esc.request) {
        const out = await withdrawRequest(ctx, id, i, esc);
        if (!out) {
          const what = esc.request.kind === "refill" ? `a refill from ${place(esc.request.from)}` : `a Shop Refill card at ${place(esc.request.from)}`;
          await answer({ state: ORDER_NOW.REFUSED, why: `already ordered: ${what} (${esc.request.key}) is being worked on; not ordered twice`, checked });
          continue;
        }
        withdrew = `${esc.request.kind} ${esc.request.key} (${place(esc.request.from)}) withdrawn`;
      }
      const landed = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines/${i}`).transaction((cur) => {
        if (cur == null) return null; // the SDK's cold-cache pass: never abort on it
        if (orderNowBlocker({ line: cur, req, enabled: true }) || !sameSpot(cur.escalation, esc)) return undefined;
        return clean({ ...cur, escalation: null, source: { status: LINE_STATUS.REROUTE }, orderNow: { rid, by: req.by || null, at: Number(req.at) || ctx.now, appliedAt: ctx.now } });
      });
      if (!landed.committed || !landed.snapshot.val()) {
        await answer({ state: ORDER_NOW.REFUSED, why: `the line changed while it was being ordered; look again${withdrew ? ` (${withdrew})` : ""}`, checked });
        continue;
      }
      if (esc) await ctx.db.ref(`${ESCALATIONS_PATH}/${id}_${i}`).set(null);
      rerouted = true;
      ctx.summary.orderNow = (ctx.summary.orderNow || 0) + 1;
      await answer({ state: ORDER_NOW.ORDERED, routedTo: pieces[0].locationId, checked, withdrew });
    } catch (e) {
      // Left "applying": a later tick past STUCK_ORDER_NOW_MS decides it again
      // (every step above is guarded, so a repeat finds its own work).
      ctx.log(`  ✗ ${orderLabel(order)} line ${Number(req.lineIndex) + 1}: Order it now failed (${String(e?.message || e)}); retried later`);
    }
  }
  return rerouted;
}
