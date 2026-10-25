// ── Stock that LANDS at Marathon PE for a waiting line (Junid, 25 Oct 16:37) ──
// "Fix the watcher: also watch Marathon PE itself. If stock for a waiting
//  online-order line lands at Marathon PE (manual transfer or anything), mark
//  the line ready to pack straight away, no pick needed."
//
// Marathon PE is the packing store: a unit there is already where Yasmin packs,
// so nobody has to pick it. Every tick (switch on), each WAITING line — one
// routing found nowhere (no_stock, no escalation yet) or one climbing the chain
// with its request not answered yet (resolving, phase raise / await) — has its
// FREE units at Marathon PE looked at: the live cell minus what other website
// orders hold there minus what this order's other lines hold there (the
// routing's own availableAt).
//
// "LANDS" means the count ROSE while the line waited, never that it was
// already there: the first look records a low-water mark on the line
// (lines/{i}/peWatch = { key, low, since }), a sale lowers it, and only free
// units ABOVE the mark are an arrival. So a unit a shop already said "Not
// found" for, or a display pair that was there all along, never makes a line
// ready by itself. When the whole line's quantity has landed:
//
//   1. the line's open request, if any, is planned FIRST with the same rule as
//      Order it now (onlinePiece.mjs, Junid 25 Oct 09:52): only this order's
//      piece is taken back; one being worked on (Central picking, answered,
//      fulfilled) is left to the chain and the line is not touched; one whose
//      online piece cannot be told apart is left exactly as it is and Junid is
//      told (once);
//   2. ONE transaction on the line: handed at Marathon PE (source
//      { locationId: "marathon-pe", status: "handed", handedBy: "pe_stock" }),
//      the escalation DONE (no request, no stale email, no re-raise), a
//      resolution log entry;
//   3. the request's piece released, the Escalations row removed, the order's
//      out-of-stock attention cleared when nothing else needs a person.
// The keep step that follows re-derives the status (Ready to pack when every
// other line is here) and moves the hold's `locs` to Marathon PE, so the
// walk-in guard protects the unit the same tick.
//
// Left alone: a line whose request was FULFILLED (the chain's own delivery
// keeps its next-morning rule: the system moves stock before the box lands),
// one in wait / deliver, not_found (that place already failed), unavailable /
// with the customer, Junid's override pending, a multi-unit line a hub half
// sent, a packed order or one being packed, a part arrival (qty 2, one landed).
//
// NOTHING HERE MOVES STOCK. The Pack deducts the unit from Marathon PE
// (the line's locationId) as it does for every handed line.
import { ONLINE_ORDERS_PATH, ONLINE_RESERVATIONS_PATH, PACKING_STORE, LINE_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";
import { ESC_PHASE, requestKey } from "../../../src/utils/onlineEscalation.js";
import { linesOf } from "./orderModel.mjs";
import { availableAt } from "./routing.mjs";
import { ESCALATIONS_PATH } from "./escalate.mjs";
import { planRelease, releaseOnlinePiece, unclearMessage, tellJunid, RELEASE } from "./onlinePiece.mjs";
import { clearAttentionIfSettled } from "./orderNowRequests.mjs";

export const PE = PACKING_STORE;
export const PE_HANDED_BY = "pe_stock";
const clean = (v) => JSON.parse(JSON.stringify(v ?? null));
const qtyOf = (l) => Math.max(1, Number(l?.qty) || 1);
// Lines that hold nothing (holdRowsFor): their units are not this order's any more.
const SETTLED = new Set([LINE_STATUS.CANCELLED, LINE_STATUS.UNAVAILABLE, LINE_STATUS.RESOLVED, LINE_STATUS.MOVED]);
const sameSpot = (a, b) => (!a && !b) || (a && b && a.phase === b.phase && a.round === b.round && a.idx === b.idx);

/** Is this line waiting for stock in a way an arrival at Marathon PE may settle? PURE. */
export function peWaiting(line) {
  if (!line?.pid || !line.sizeKey) return false;
  if (line.awaitingCustomer) return false;
  const conv = line.resolution?.conversation;
  if (conv && conv.state !== "closed") return false;
  if (line.escalationOverride && !line.escalationOverride.appliedAt) return false;
  const st = line.source?.status;
  const keys = Array.isArray(line.source?.orderKeys) ? line.source.orderKeys : [];
  // Some units of a multi-unit hub line were sent, one came back out of stock: Junid's (escalate.mjs).
  if (qtyOf(line) > 1 && keys.length > 1) return false;
  if (st === LINE_STATUS.NO_STOCK) return !line.escalation;
  if (st !== LINE_STATUS.RESOLVING) return false;
  const esc = line.escalation;
  if (!esc || esc.pending) return false;
  return esc.phase === ESC_PHASE.RAISE || esc.phase === ESC_PHASE.AWAIT;
}

/**
 * The low-water mark step. PURE.
 *   free  free units at Marathon PE for this line now
 * → { action: "baseline" | "lower" | "arrived" | "none", watch?, landed? }
 */
export function peWatchStep(line, free, nowMs) {
  const key = `${line.pid}/${line.sizeKey}`;
  const f = Math.max(0, Number(free) || 0);
  const w = line.peWatch && line.peWatch.key === key ? line.peWatch : null;
  if (!w) return { action: "baseline", watch: { key, low: f, since: nowMs } };
  const low = Math.max(0, Number(w.low) || 0);
  if (f - low >= qtyOf(line)) return { action: "arrived", landed: f - low };
  if (f < low) return { action: "lower", watch: { ...w, low: f } };
  return { action: "none" };
}

/** The line as it reads once its stock has landed at Marathon PE. PURE. */
export function arrivedLine(cur, { nowMs, landed }) {
  const esc = cur.escalation;
  const open = esc?.phase === ESC_PHASE.AWAIT && esc.request ? esc.request : null;
  const { peWatch: _w, ...rest } = cur;
  const attempts = Array.isArray(esc?.attempts) ? esc.attempts : Object.values(esc?.attempts || {});
  const note = `${landed === 1 ? "1 unit" : `${landed} units`} landed at Marathon PE — here, ready to pack (no pick needed; stock deducts at the pack)`;
  return clean({
    ...rest,
    ...(esc ? {
      escalation: {
        ...esc, phase: ESC_PHASE.DONE, doneAt: nowMs, arrivedAtPe: nowMs, request: null, pending: null, waitUntil: null,
        attempts: [...attempts, { location: PE, action: "arrived", result: "handed", ...(open ? { key: open.key } : {}), at: nowMs }],
      },
    } : {}),
    // A later chain on this line raises NEW request keys, never adopts this one (requestKey's gen).
    ...(open ? { escalationGen: (Number(cur.escalationGen) || 0) + 1 } : {}),
    source: { locationId: PE, status: LINE_STATUS.HANDED, handedAt: nowMs, handedBy: PE_HANDED_BY },
    resolution: {
      ...(cur.resolution || {}),
      log: { ...(cur.resolution?.log || {}), [`pe_arrival_${nowMs}`]: { at: nowMs, action: "arrived_at_pe", note, by: "orders-poll", via: "pe_watch" } },
    },
  });
}

async function lineTxn(ctx, id, i, fn) {
  const res = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines/${i}`).transaction((cur) => {
    if (cur == null) return null; // the SDK's cold-cache pass: never abort on it
    const out = fn(cur);
    return out === undefined ? undefined : clean(out);
  });
  return res.committed && res.snapshot.val() ? res.snapshot.val() : null;
}

/**
 * Watch Marathon PE for every waiting line of one open order. → true when a
 * line was marked here (the caller re-reads the order before keeping it).
 */
export async function applyPeArrivals(ctx, id, order) {
  if (!order || order.packClaim || order.pack) return false;
  const lines = linesOf(order);
  if (!lines.some(peWaiting)) return false;
  const { now, log } = ctx;
  const ref = orderLabel(order);
  const claimed = {}; // units this pass gave to an earlier line of this order: { "pid/sizeKey": n }
  let marked = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!peWaiting(line)) continue;
    const key = `${line.pid}/${line.sizeKey}`;
    const stockQty = { [PE]: Number(await ctx.get(`stock/${PE}/${line.pid}/${line.sizeKey}/qty`)) || 0 };
    const holdsCell = await ctx.get(`${ONLINE_RESERVATIONS_PATH}/${line.pid}/${line.sizeKey}`);
    let free = availableAt({ stockQty, holdsCell, orderId: String(id) })[PE] || 0;
    lines.forEach((l, k) => {
      if (k === i || !l?.pid || `${l.pid}/${l.sizeKey}` !== key || SETTLED.has(l.source?.status)) return;
      if (l.source?.locationId === PE) free -= qtyOf(l);
    });
    free = Math.max(0, free - (claimed[key] || 0));
    const step = peWatchStep(line, free, now);
    const esc = line.escalation || null;
    const st = line.source.status;
    const still = (cur) => cur.pid === line.pid && cur.sizeKey === line.sizeKey && cur.source?.status === st && sameSpot(cur.escalation, esc) && !cur.escalation?.pending;
    if (step.action === "baseline" || step.action === "lower") {
      await lineTxn(ctx, id, i, (cur) => (still(cur) ? { ...cur, peWatch: step.watch } : undefined));
      if (step.action === "baseline" && free > 0) log(`  · ${ref} line ${i + 1}: Marathon PE already shows ${free} free of ${line.title} ${line.size} — watched from now; only units that land from here on make it ready`);
      continue;
    }
    if (step.action !== "arrived") continue;

    // ── 1. The open request: only this order's piece, planned before the line moves ──
    const open = esc?.phase === ESC_PHASE.AWAIT && esc.request ? esc : null;
    const escKey = open ? requestKey(id, i, open) : null;
    const piece = qtyOf(line);
    if (open) {
      const { kind, key: rkey } = open.request;
      const record = await ctx.get(kind === "refill" ? `refill_requests/${rkey}` : `orders/${rkey}`);
      const plan = planRelease({ kind, record, orderId: id, lineIndex: i, escKey, piece });
      if (plan.action === RELEASE.BUSY) {
        log(`  · ${ref} line ${i + 1}: stock landed at Marathon PE, but ${rkey} is already being worked on or answered (${plan.why}) — left to the chain`);
        continue;
      }
      if (plan.action === RELEASE.UNCLEAR) {
        await tellJunid(ctx, unclearMessage({ orderRef: ref, lineIndex: i, line, esc: open, why: `${plan.why}. The item is at Marathon PE; the line was NOT marked ready` }), { once: `${ONLINE_ORDERS_PATH}/${id}/requestAlerts/${rkey}` });
        continue;
      }
    }
    // ── 2. The line: handed at Marathon PE ──
    const next = await lineTxn(ctx, id, i, (cur) => (still(cur) ? arrivedLine(cur, { nowMs: now, landed: step.landed }) : undefined));
    if (!next) continue;
    claimed[key] = (claimed[key] || 0) + piece;
    marked = true;
    ctx.summary.peArrivals = (ctx.summary.peArrivals || 0) + 1;
    log(`  ✓ ${ref} line ${i + 1}: ${line.title} ${line.size} landed at Marathon PE — here, ready to pack (no pick)`);
    // ── 3. The request's piece, the registry row, the attention ──
    if (open) {
      const rel = await releaseOnlinePiece(ctx, { orderId: id, orderRef: ref, lineIndex: i, esc: open, escKey, piece, by: "arrived at Marathon PE (the line no longer waits on it)" });
      if (!rel.changed && rel.action !== RELEASE.GONE) {
        await tellJunid(ctx, unclearMessage({ orderRef: ref, lineIndex: i, line, esc: open, why: `it changed while the line was being marked here (${rel.why || rel.action})` }), { once: `${ONLINE_ORDERS_PATH}/${id}/requestAlerts/${open.request.key}` });
      }
    }
    if (esc) await ctx.db.ref(`${ESCALATIONS_PATH}/${id}_${i}`).set(null);
  }
  if (marked) await clearAttentionIfSettled(ctx, id);
  return marked;
}
