// ── The order agent's RE-PICK, applied on the Mac mini (Junid, 14 Nov 2026) ──
// A website line a place could not produce — Not found at a shop, Out of stock
// at a hub, or a held unit a walk-in sale took (needs_attention) — waits at that
// status until a person taps "Order it now" (Junid's 1 Nov rule: the scan is the
// only requester, so nothing is raised for it). The order agent
// (scripts/online/order-agent.mjs) looks at those lines every 15 minutes; when
// another place on the line's EXISTING route has a free unit it asks this tick
// to put the line on that place's pick:
//
//   /online_orders/{id}/agentRepicks/{lineIndex}_{routeGen}_{hourSlot} =
//     { lineIndex, expectPid, expectSizeKey, expectStatus, expectRouteGen,
//       exclude: [locationId…], by: "order-agent", at, state: "pending", evidence }
//     → "ordered"      { routedTo, checked, answeredAt }
//     → "not_in_stock" { checked, answeredAt }   the line is left as it is
//     → "refused"      { why, answeredAt }
//
// HOW IT DIFFERS FROM "Order it now". Order it now sends the line to `reroute`,
// which rebuilds it from the ORIGINAL Shopify item — on a line the customer
// swapped that would quietly undo the swap, so Order it now refuses swapped
// lines and they stayed red for good (#2085, 12 Nov: the G-Star tee XXL the
// customer chose was sold to a walk-in; a fresh XXL landed at Marathon PE at
// 12:55 and the line still waited). A re-pick KEEPS THE LINE'S ITEM (pid and
// size as they stand) and only moves its `source` to the first place on the
// route with a free unit — the very availability a new order's routing reads
// (availabilityFor: the cells minus what OTHER website orders hold there),
// minus the places in `exclude` (the place that just said it cannot find it,
// unless stock reached it since — the agent decides that and says why in
// `evidence`). The keep pass that follows raises the pick exactly as for a new
// line: a hub order per unit at a hub, a strip entry at a shop, and the hold.
//
// NEVER TWICE, NEVER A REQUEST. A line with an escalation, an open customer
// conversation, money on it, a pick already open, or any part in the basket is
// refused. Nothing here raises, changes or cancels a stock or refill request;
// nothing moves stock (stock deducts only at the Pack); no policy is read or
// written. The routing order is routing.mjs's, unchanged.
import { ONLINE_ORDERS_PATH, LINE_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";
import { linesOf } from "./orderModel.mjs";
import { routeLines, routeFor } from "./routing.mjs";
import { clearAttentionIfSettled, PLACE } from "./orderNowRequests.mjs";

export const REPICK = Object.freeze({ PENDING: "pending", APPLYING: "applying", ORDERED: "ordered", NOT_IN_STOCK: "not_in_stock", REFUSED: "refused" });
export const REPICK_PATH = "agentRepicks";
export const STUCK_REPICK_MS = 5 * 60 * 1000;
// The statuses a place gave when it could not produce the line. Only these are re-picked.
export const REPICK_LINE = Object.freeze([LINE_STATUS.NOT_FOUND, LINE_STATUS.NO_STOCK, LINE_STATUS.NEEDS_ATTENTION]);

const clean = (v) => JSON.parse(JSON.stringify(v ?? null));
const place = (loc) => PLACE[loc] || loc;
const CUSTOMER_STATES = new Set(["waiting_reply", "no_answer", "not_contacted", "unreachable"]);

/**
 * The customer told Jamie they will wait for THIS item (jimmyStatus state "chose" about the line's own product and
 * size): an `unavailable` line parked for that wait may go on a pick the moment a place has it. PURE.
 */
export function customerChoseToWait(order, i, line) {
  const all = order?.jimmyStatus;
  const rec = all && typeof all === "object" ? all[i] ?? all[String(i)] : null;
  if (!rec || typeof rec !== "object" || rec.state !== "chose") return false;
  if (!rec.pid || String(rec.pid) !== String(line?.pid)) return false;
  if (rec.size != null && line?.size != null && String(rec.size) !== String(line.size)) return false;
  return /\bwhen it arrives\b|\bwait/i.test(String(rec.next || "")) || /\bwait\b/i.test(String(rec.customerSaid?.text || ""));
}

/** Why line `line` cannot be re-picked, or null. PURE. */
export function repickBlocker({ line, req, enabled, order = null, i = Number(req?.lineIndex) }) {
  if (!enabled) return "the website-order feeds are switched off, so no pick can be raised";
  if (order?.packClaim || order?.pack) return "the order is being packed";
  if (!line?.pid) return "the line is gone or not linked to a product";
  if (line.reship) return "the line is a re-sent item already sold (a second parcel)";
  if (String(line.pid) !== String(req?.expectPid ?? "") || String(line.sizeKey ?? "") !== String(req?.expectSizeKey ?? "")) return "the line changed since the agent looked (another item or size)";
  if ((Number(line.routeGen) || 0) !== (Number(req?.expectRouteGen) || 0)) return "the line was routed again since the agent looked";
  const st = line.source?.status;
  if (req?.expectStatus && st !== req.expectStatus) return `the line is "${st || "unknown"}" now, not "${req.expectStatus}"`;
  if (!REPICK_LINE.includes(st) && !(st === LINE_STATUS.UNAVAILABLE && customerChoseToWait(order, i, line))) return `the line is "${st || "unknown"}", not one a place failed`;
  if (line.escalation) return "the line has an escalation under way";
  if (line.awaitingCustomer || line.resolution?.conversation) return "the customer is being asked about this line";
  if (line.escalationOverride && !line.escalationOverride.appliedAt) return "Junid's decision on this line is still being applied";
  if (["unavailable", "resolved"].includes(line.escalationOverride?.kind)) return `Junid decided this line (${line.escalationOverride.kind})`;
  const rec = order?.jimmyStatus && typeof order.jimmyStatus === "object" ? order.jimmyStatus[i] ?? order.jimmyStatus[String(i)] : null;
  if (rec && CUSTOMER_STATES.has(String(rec.state)) && (!rec.pid || String(rec.pid) === String(line.pid))) return "Jamie is waiting on the customer about this line";
  if (line.resolution?.money) return "money is recorded on this line";
  const outcome = line.resolution?.outcome?.kind;
  if (outcome && outcome !== "swap") return `the line was settled (${outcome})`;
  const codes = Array.isArray(line.source?.orderKeys) ? line.source.orderKeys : [];
  if (order?.basket?.[i] || codes.some((c) => order?.codesIn?.[c] === true)) return "part of this line is already in the basket";
  return null;
}

/**
 * The place a re-pick goes to, from the free units and the exclusions. PURE.
 * → { pieces, routedQty, checked }  (pieces in route order; one place for the whole line or nothing)
 */
export function planRepick({ line, available, exclude = [] }) {
  const qty = Math.max(1, Number(line?.qty) || 1);
  const key = `${line.pid}|${line.sizeKey}`;
  const free = { ...(available || {}) };
  for (const loc of exclude || []) free[loc] = 0;
  const isFootwear = !!line.isFootwear;
  const checked = { free: routeFor(isFootwear).map((s) => ({ loc: s.locationId, free: Math.max(0, Number(free[s.locationId]) || 0), excluded: (exclude || []).includes(s.locationId) || undefined })) };
  // ONE place for the whole line: a split would turn one line into several and a
  // half-sent line reads as handed one unit short. A split needs a person.
  const step = routeFor(isFootwear).find((s) => (Number(free[s.locationId]) || 0) >= qty);
  if (!step) {
    const pieces = routeLines([{ key, qty, isFootwear }], { [key]: free })[0] || [];
    return { pieces: [], routedQty: pieces.filter((p) => p.locationId).reduce((s, p) => s + p.qty, 0), checked };
  }
  return { pieces: [{ qty, locationId: step.locationId, status: step.status }], routedQty: qty, checked };
}

export function describeRepickChecked(checked) {
  return (checked?.free || []).map((c) => `${place(c.loc)}: ${c.excluded ? "skipped" : `${c.free} free`}`).join(", ") || "nowhere to check";
}

/**
 * Apply every pending re-pick on this order. → true when a line moved (the
 * caller re-reads before keeping the order).
 *   helpers  { availabilityFor, cancelLine } — poll.mjs's own
 */
export async function applyAgentRepicks(ctx, id, order, helpers) {
  const reqs = Object.entries(order?.[REPICK_PATH] || {})
    .filter(([, r]) => r && (r.state === REPICK.PENDING || (r.state === REPICK.APPLYING && ctx.now - Number(r.claimedAt) >= STUCK_REPICK_MS)))
    .sort((a, b) => Number(a[1].at) - Number(b[1].at));
  let moved = false;
  for (const [rid, req] of reqs) {
    const path = `${ONLINE_ORDERS_PATH}/${id}/${REPICK_PATH}/${rid}`;
    const claim = await ctx.db.ref(path).transaction((cur) => {
      if (cur == null) return null;
      const stuck = cur.state === REPICK.APPLYING && ctx.now - Number(cur.claimedAt) >= STUCK_REPICK_MS;
      if (cur.state !== REPICK.PENDING && !stuck) return undefined;
      return { ...cur, state: REPICK.APPLYING, claimedAt: ctx.now };
    });
    if (!claim.committed || !claim.snapshot.val()) continue;
    const answer = async (patch) => {
      await ctx.db.ref(path).update(clean({ ...patch, answeredAt: ctx.now }));
      ctx.log(`  ${patch.state === REPICK.ORDERED ? "✓" : "·"} ${orderLabel(order)} line ${Number(req.lineIndex) + 1}: agent re-pick → ${patch.state}${patch.routedTo ? ` at ${place(patch.routedTo)}` : ""}${patch.why ? `: ${patch.why}` : ""}${patch.checked ? ` [${describeRepickChecked(patch.checked)}]` : ""}`);
    };
    try {
      const i = Number(req.lineIndex);
      const fresh = await ctx.get(`${ONLINE_ORDERS_PATH}/${id}`);
      const line = linesOf(fresh)[i];
      // RESUME: the line already moved for THIS request; finish the cancel of the old entry.
      if (line?.repick?.rid === rid) {
        if (!line.repick.cancelledAt && line.repick.old) {
          await helpers.cancelLine({ source: line.repick.old });
          await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines/${i}/repick/cancelledAt`).set(ctx.now);
        }
        await clearAttentionIfSettled(ctx, id);
        await answer({ state: REPICK.ORDERED, routedTo: line.source?.locationId || null, resumed: true });
        moved = true; continue;
      }
      const blocked = repickBlocker({ line, req, enabled: ctx.enabled, order: fresh, i });
      if (blocked) { await answer({ state: REPICK.REFUSED, why: blocked }); continue; }
      // A hub already SENT a unit of this line: a fresh pick would bring it twice.
      for (const k of Array.isArray(line.source?.orderKeys) ? line.source.orderKeys : []) {
        const rec = await ctx.get(`orders/${k}`);
        if (rec && rec.channel === "online" && String(rec.onlineOrderId) === String(id) && Number(rec.onlineLineIndex) === i && (rec.status === "ready" || rec.status === "collected" || rec.sentSize != null)) {
          await answer({ state: REPICK.REFUSED, why: `${place(rec.hub) || "a hub"} already sent a unit of this line (${k})` });
          throw Object.assign(new Error("sent"), { answered: true });
        }
      }
      const key = `${line.pid}|${line.sizeKey}`;
      const ownOther = {};
      linesOf(fresh).forEach((l, k) => {
        if (k === i || !l?.pid || !l.source?.locationId || `${l.pid}|${l.sizeKey}` !== key) return;
        if (![LINE_STATUS.PICK, LINE_STATUS.DISPLAY, LINE_STATUS.HANDED].includes(l.source.status)) return;
        (ownOther[key] ||= {})[l.source.locationId] = ((ownOther[key] || {})[l.source.locationId] || 0) + (Number(l.qty) || 0);
      });
      const available = (await helpers.availabilityFor(ctx, id, [{ pid: line.pid, sizeKey: line.sizeKey }], ownOther))[key] || {};
      const exclude = Array.isArray(req.exclude) ? req.exclude.map(String) : [];
      const plan = planRepick({ line, available, exclude });
      if (!plan.pieces.length) {
        await answer({ state: REPICK.NOT_IN_STOCK, checked: plan.checked, ...(plan.routedQty > 0 ? { why: "only part of the line is free in one place; a split needs a person" } : {}) });
        continue;
      }
      const to = plan.pieces[0];
      // The basket and the till's code confirmations, read again just before the line moves (a packer may have
      // scanned it in since the order was read).
      const [basketNow, codesNow] = await Promise.all([ctx.get(`${ONLINE_ORDERS_PATH}/${id}/basket/${i}`), ctx.get(`${ONLINE_ORDERS_PATH}/${id}/codesIn`)]);
      if (basketNow === true || (Array.isArray(line.source?.orderKeys) && line.source.orderKeys.some((c) => codesNow?.[c] === true))) {
        await answer({ state: REPICK.REFUSED, why: "part of this line is already in the basket" });
        continue;
      }
      const old = clean({ status: line.source?.status ?? null, locationId: line.source?.locationId ?? null, entryKey: line.source?.entryKey ?? null, orderKeys: line.source?.orderKeys ?? null });
      const landed = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines/${i}`).transaction((cur) => {
        if (cur == null) return null; // the SDK's cold-cache pass: never abort on it
        if (repickBlocker({ line: cur, req, enabled: true, order: { ...fresh, lines: undefined }, i })) return undefined;
        // routeGen + 1: the new strip entry / hub codes are this generation's own,
        // never a completed entry or a used code of the old one.
        return clean({
          ...cur,
          routeGen: (Number(cur.routeGen) || 0) + 1,
          repickCount: (Number(cur.repickCount) || 0) + 1,
          // Every place that failed this line, kept across re-picks (the agent skips them unless stock arrives there
          // after their failure). A walk-in sale is not a place failing.
          failedPlaces: { ...(cur.failedPlaces || {}), ...(old.locationId && old.status !== LINE_STATUS.NEEDS_ATTENTION ? { [old.locationId]: Number(req.evidence?.failed?.since) || ctx.now } : {}) },
          source: { status: to.status, locationId: to.locationId },
          repick: { rid, at: Number(req.at) || ctx.now, appliedAt: ctx.now, by: req.by || "order-agent", from: { status: old.status, locationId: old.locationId }, to: to.locationId, old, exclude },
        });
      });
      if (!landed.committed || !landed.snapshot.val()) { await answer({ state: REPICK.REFUSED, why: "the line changed while it was being re-picked", checked: plan.checked }); continue; }
      // The old place's entry (a walk-in override leaves one open; a not-found strip entry is already closed).
      if (old.entryKey || old.orderKeys) await helpers.cancelLine({ source: old });
      await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines/${i}/repick/cancelledAt`).set(ctx.now);
      await clearAttentionIfSettled(ctx, id);
      await answer({ state: REPICK.ORDERED, routedTo: to.locationId, checked: plan.checked });
      moved = true;
    } catch (e) {
      if (e?.answered) continue;
      ctx.summary?.errors?.push(`${id} agent re-pick ${rid}: ${String(e?.message || e)}`);
      await answer({ state: REPICK.REFUSED, why: `failed: ${String(e?.message || e).slice(0, 200)}` }).catch(() => {});
    }
  }
  return moved;
}
