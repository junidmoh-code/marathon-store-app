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
// being routed, or with a raise in flight is refused and says so. Requests
// are keyed per line and route generation, and claimed in a transaction.
//
// AN OPEN REQUEST FOR THE LINE (Junid, 25 Oct 09:52 — onlinePiece.mjs): when
// the stock is found, ONLY the online order's piece of it is released — a
// request raised for this order and line is withdrawn (or, if it holds more,
// reduced by exactly the line's quantity); a genuine refill is never
// cancelled or reduced. It is planned BEFORE the line moves: one being worked
// on is refused ("already ordered"), and one whose online piece cannot be
// told apart is left exactly as it is and Junid is told on WhatsApp. Every
// change is logged with its before and after quantity. The re-route then
// pulls exactly the line's quantity, never more.
//
// NOTHING HERE MOVES STOCK. Stock still deducts only at Pack. No refill
// policy or target is touched.
import { ONLINE_ORDERS_PATH, LINE_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";
import { linesOf } from "./orderModel.mjs";
import { routeLines, routeFor } from "./routing.mjs";
import { ESCALATIONS_PATH } from "./escalate.mjs";
import { planRelease, releaseOnlinePiece, unclearMessage, tellJunid, RELEASE } from "./onlinePiece.mjs";
import { requestKey } from "../../../src/utils/onlineEscalation.js";

export const ORDER_NOW = Object.freeze({ PENDING: "pending", APPLYING: "applying", ORDERED: "ordered", NOT_IN_STOCK: "not_in_stock", REFUSED: "refused" });
export const STUCK_ORDER_NOW_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
// Line statuses that hold an order in "needs attention" (orderModel deriveOrderStatus).
const ATTENTION_LINE = new Set([LINE_STATUS.NO_STOCK, LINE_STATUS.NOT_FOUND, LINE_STATUS.NEEDS_ATTENTION, LINE_STATUS.UNRESOLVED]);
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
export function orderNowBlocker({ line, req, enabled, order = null, i = Number(req?.lineIndex) }) {
  if (!enabled) return "the website-order feeds are switched off, so no pick can be raised";
  if (order?.packClaim || order?.pack) return "the order is being packed; nothing can be ordered on it now";
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
  // An open request (await) is NOT a blocker here: its online piece is
  // released when the stock is found (applyOrderNowRequests, onlinePiece.mjs).
  // Sent already: the stock moved when it was sent, but the box lands by
  // 11:00 the next working day, when the chain puts the line on the pick.
  if (line.escalation?.phase === "wait") {
    const by = Number(line.escalation.waitUntil) ? ` (by ${new Date(Number(line.escalation.waitUntil) + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " ")})` : "";
    return `already ordered: it was sent to ${place(line.escalation.deliverAt) || "its shop"} and goes on the pick when the box lands${by}; not ordered twice`;
  }
  if (line.awaitingCustomer || line.resolution?.conversation) return "the customer is being offered alternatives for this line; settle that first";
  // A re-route rebuilds the line: Junid's pending decision or a money action on it would be lost.
  if (line.escalationOverride && !line.escalationOverride.appliedAt) return "Junid's decision on this line (Settings) is still being applied";
  if (line.resolution?.money || line.resolution?.outcome) return "a refund, credit or settlement is recorded on this line; ask Junid";
  // Part of it is already here: a fresh pick would bring it a second time.
  const codes = Array.isArray(line.source?.orderKeys) ? line.source.orderKeys : [];
  if (order?.basket?.[i] || codes.some((c) => order?.codesIn?.[c] === true)) return "part of this line is already in the basket; not ordered twice";
  return null;
}

/** This line's hub orders that a hub already sent (ready / collected / a size sent). Exact reads. */
async function sentHubUnits(ctx, id, i, line) {
  const out = [];
  for (const key of Array.isArray(line.source?.orderKeys) ? line.source.orderKeys : []) {
    const rec = await ctx.get(`orders/${key}`);
    if (!rec || rec.channel !== "online" || String(rec.onlineOrderId) !== String(id) || Number(rec.onlineLineIndex) !== i) continue;
    if (rec.status === "ready" || rec.status === "collected" || rec.sentSize != null) out.push({ key, hub: rec.hub || null });
  }
  return out;
}

/**
 * The order's no_stock / not_found / walk-in attention, cleared once no line
 * needs a person any more (as Settings → Resolve clears it), so Junid is not
 * emailed about a line that was just ordered. The keep step sets it again if
 * the re-route comes out no_stock.
 */
export async function clearAttentionIfSettled(ctx, id) {
  await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}`).transaction((cur) => {
    if (cur == null) return null;
    if (!cur.attention || !["no_stock", "not_found", "walkin_override"].includes(cur.attention.kind)) return undefined;
    if (linesOf(cur).some((l) => ATTENTION_LINE.has(l?.source?.status))) return undefined;
    return { ...cur, attention: null, attentionOpen: null };
  });
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
      if (line?.orderNow?.rid === rid) {
        // The release the line recorded (if any) is finished here — idempotent:
        // a piece already taken back reads as "gone".
        const rel = line.orderNow.release;
        let released = null;
        if (rel?.key) {
          const out = await releaseOnlinePiece(ctx, { orderId: id, orderRef: orderLabel(order), lineIndex: i, esc: { request: { kind: rel.kind, key: rel.key } }, escKey: rel.escKey, piece: rel.piece, by: `Order it now (${who}, resumed)` });
          released = { key: rel.key, kind: rel.kind, action: out.action, before: out.before ?? null, after: out.after ?? null };
          if (!out.changed && out.action !== RELEASE.GONE) {
            await tellJunid(ctx, unclearMessage({ orderRef: orderLabel(order), lineIndex: i, line, esc: { request: { kind: rel.kind, key: rel.key, from: rel.from, to: rel.to } }, why: `it changed while the line was being re-ordered (${out.why || out.action})` }), { once: `${ONLINE_ORDERS_PATH}/${id}/requestAlerts/${rel.key}` });
          }
        }
        // The rest of the step a crash may have cut short (all idempotent).
        if (rel?.key) await ctx.db.ref(`${ESCALATIONS_PATH}/${id}_${i}`).set(null);
        await clearAttentionIfSettled(ctx, id);
        await answer({ state: ORDER_NOW.ORDERED, routedTo: line.source?.locationId || null, resumed: true, ...(released ? { released } : {}) });
        rerouted = true; continue;
      }
      const blocked = orderNowBlocker({ line, req, enabled: ctx.enabled, order: fresh, i });
      if (blocked) { await answer({ state: ORDER_NOW.REFUSED, why: blocked }); continue; }
      // A hub already sent a unit of this line (the wrong size, or some units of
      // a qty > 1 line before another said out of stock): that unit is on its way;
      // a fresh pick of the full line would send it twice. Junid decides.
      const sent = await sentHubUnits(ctx, id, i, line);
      if (sent.length) { await answer({ state: ORDER_NOW.REFUSED, why: `${place(sent[0].hub) || "a hub"} already sent ${sent.length === 1 ? "a unit" : `${sent.length} units`} of this line (${sent.map((x) => x.key).join(", ")}); not ordered twice. Ask Junid` }); continue; }

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

      const esc = line.escalation;
      // ── The line's open request: only the online order's piece, planned first ──
      const open = esc?.phase === "await" && esc.request ? esc : null;
      const piece = qty;
      const escKey = open ? requestKey(id, i, open) : null;
      if (open) {
        const record = await ctx.get(open.request.kind === "refill" ? `refill_requests/${open.request.key}` : `orders/${open.request.key}`);
        const plan = planRelease({ kind: open.request.kind, record, orderId: id, lineIndex: i, escKey, piece });
        const what = open.request.kind === "refill" ? `a refill from ${place(open.request.from)}` : `a Shop Refill card at ${place(open.request.from)}`;
        if (plan.action === RELEASE.BUSY) { await answer({ state: ORDER_NOW.REFUSED, why: `already ordered: ${what} for this line (${open.request.key}) is being worked on or answered (${plan.why}); not ordered twice`, checked }); continue; }
        if (plan.action === RELEASE.UNCLEAR) {
          await tellJunid(ctx, unclearMessage({ orderRef: orderLabel(order), lineIndex: i, line, esc: open, why: plan.why }), { once: `${ONLINE_ORDERS_PATH}/${id}/requestAlerts/${open.request.key}` });
          await answer({ state: ORDER_NOW.REFUSED, why: `the stock is back, but which part of ${what} (${open.request.key}) is this order's could not be told (${plan.why}); nothing was changed and Junid has been told`, checked });
          continue;
        }
      }
      const landed = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines/${i}`).transaction((cur) => {
        if (cur == null) return null; // the SDK's cold-cache pass: never abort on it
        if (orderNowBlocker({ line: cur, req, enabled: true, order: { ...fresh, lines: undefined }, i }) || !sameSpot(cur.escalation, esc)) return undefined;
        // Only the status changes on `source`: its entryKey / orderKeys stay, so
        // the re-route cancels the line's old hub orders / strip entry (as Resolve does).
        // escalationGen + 1: a later chain on this line raises NEW keys and can
        // never adopt the request this one leaves behind (requestKey's gen).
        // `release` records what still has to come off, so a crash before it
        // does is finished by the RESUME branch above.
        return clean({ ...cur, escalation: null, ...(open ? { escalationGen: (Number(cur.escalationGen) || 0) + 1 } : {}),
          source: { ...cur.source, status: LINE_STATUS.REROUTE },
          orderNow: { rid, by: req.by || null, at: Number(req.at) || ctx.now, appliedAt: ctx.now,
            ...(open ? { release: { kind: open.request.kind, key: open.request.key, from: open.request.from || null, to: open.request.to || null, escKey, piece } } : {}) } });
      });
      if (!landed.committed || !landed.snapshot.val()) {
        await answer({ state: ORDER_NOW.REFUSED, why: "the line changed while it was being ordered; look again", checked });
        continue;
      }
      // The line no longer waits on its request: release the online piece of it.
      let released = null;
      if (open) {
        const rel = await releaseOnlinePiece(ctx, { orderId: id, orderRef: orderLabel(order), lineIndex: i, esc: open, escKey, piece, by: `Order it now (${who})` });
        released = { key: open.request.key, kind: open.request.kind, action: rel.action, before: rel.before ?? null, after: rel.after ?? null };
        // It changed between the plan and the write (picked up, or re-tagged):
        // the line is already re-routed, so Junid must look at the request.
        if (!rel.changed && rel.action !== RELEASE.GONE) {
          await tellJunid(ctx, unclearMessage({ orderRef: orderLabel(order), lineIndex: i, line, esc: open, why: `it changed while the line was being re-ordered (${rel.why || rel.action})` }), { once: `${ONLINE_ORDERS_PATH}/${id}/requestAlerts/${open.request.key}` });
        }
      }
      if (esc) await ctx.db.ref(`${ESCALATIONS_PATH}/${id}_${i}`).set(null);
      await clearAttentionIfSettled(ctx, id);
      rerouted = true;
      ctx.summary.orderNow = (ctx.summary.orderNow || 0) + 1;
      await answer({ state: ORDER_NOW.ORDERED, routedTo: pieces[0].locationId, checked, ...(released ? { released } : {}) });
    } catch (e) {
      // Left "applying": a later tick past STUCK_ORDER_NOW_MS decides it again
      // (every step above is guarded, so a repeat finds its own work). After
      // MAX_ATTEMPTS it is answered, so a failing check never blocks Pack forever.
      const attempts = (Number(claim.snapshot.val()?.attempts) || 0) + 1;
      ctx.log(`  ✗ ${orderLabel(order)} line ${Number(req.lineIndex) + 1}: Order it now failed (${String(e?.message || e)}); attempt ${attempts}`);
      if (attempts >= MAX_ATTEMPTS) await answer({ state: ORDER_NOW.REFUSED, why: `stock could not be checked (${String(e?.message || e).slice(0, 120)}); tap Order it now again` }).catch(() => {});
      else await ctx.db.ref(path).update({ attempts }).catch(() => {});
    }
  }
  return rerouted;
}
