// ── Escalation, the IO half — runs in the orders-poll tick ───────────────────
// src/utils/onlineEscalation.js decides; this reads the line and the request
// records it raised, performs the one action the machine asks for, and
// commits the transition. Contract: docs/ONLINE-ORDERS.md § Escalation.
//
// EVERY STEP IS RESTART-SAFE. A raise is three writes, each idempotent:
//   1. INTENT  the line's escalation.pending = { kind, key, … } (transaction,
//              only from phase "raise" at the same round/step)
//   2. ACT     create-if-absent at the deterministic key (a Shop Refill card's
//              R### number is drawn once and kept in the intent)
//   3. COMMIT  stepEscalation(…, { type: "raised" }) (transaction)
// A crash between any two re-runs from the intent next tick and finds its own
// record already there. Observations (a request's answer, a line's answer)
// are re-read every tick and a repeated one is a no-op in the machine.
//
// NOTHING HERE MOVES STOCK. A Shop Refill card is fulfilled by Hub 2 on its
// Clothing tab; a refill row by Central on its queue — the existing screens,
// the existing stock movements. This only asks.
import {
  ONLINE_ORDERS_PATH, LINE_STATUS, ORDER_STATUS, ATTENTION_KIND, PARKED_LINE_STATUSES,
} from "../../../src/utils/onlineOrders.js";
import { linesOf } from "./orderModel.mjs";
import {
  ESC_PHASE, ESC_TERMINAL, STEP, ESCALATION_VIA, startEscalation, stepEscalation, pendingAction,
  requestKey, requestOutcome, currentStep, describeEscalation,
} from "../../../src/utils/onlineEscalation.js";

export const ESCALATIONS_PATH = "online_escalations";
const MAX_STEPS_PER_TICK = 6;

const FAILED_LINE = new Set([LINE_STATUS.NOT_FOUND, LINE_STATUS.NO_STOCK]);

// Same day key as App.jsx getNextRefillNumber / refill-scan drawRefillNumber
// (functions/lib/refill-engine.cjs saTodayKey): SA date, 0-based month.
export function saTodayKey(nowMs) {
  const d = new Date(nowMs + 2 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

async function drawRefillNumber(db, nowMs) {
  const todayKey = saTodayKey(nowMs);
  const res = await db.ref("refillCounter").transaction((current) => {
    if (!current || current.day !== todayKey) return { day: todayKey, counter: 1 };
    return { day: todayKey, counter: current.counter >= 999 ? 1 : current.counter + 1 };
  });
  return "R" + String(res.snapshot.val()?.counter ?? 1).padStart(3, "0");
}

/** The Shop Refill card — the exact shape placeRefillRequests writes (App.jsx), plus the web fields. */
export function storeOrderCard({ key, line, order, orderId, lineIndex, to, from, nowIso, escKey }) {
  return {
    id: key, productId: line.pid, productName: line.title || "Unknown",
    productPhoto: null, productPhotoUrl: line.photoUrl ?? null,
    size: line.size == null ? "_" : String(line.size), sentSize: null, qty: Number(line.qty) || 1,
    customerName: "Shop Refill", customerPhone: null,
    hub: from, placedAtHub: from, placedStore: to, destShop: to,
    productType: "clothing", requestDisplay: false, requestDisplayPartner: false,
    status: "incoming", createdAt: nowIso, updatedAt: nowIso,
    readyAt: null, outOfStockAt: null, comingTomorrowAt: null, collectedAt: null,
    displayRefillScheduledAt: null, displayRefillHub: null, displayRefillStatus: null,
    displayRefilledAt: null, displayRefillStockDepletedAt: null, displayRefilledBy: null,
    clothingRefillStatus: null, clothingRefilledAt: null, clothingOutOfStockAt: null, clothingRefilledBy: null,
    // The website order this card is for — shown on Hub 2's card.
    onlineRef: order.ref, onlineOrderKey: orderId, onlineLineIndex: lineIndex, onlineEscalationKey: escKey,
  };
}

/** The Central → hub row — the on-hold / Missing Sneakers shape, released at once. */
export function refillRow({ line, order, orderId, lineIndex, to, from, nowIso, nowMs }) {
  return {
    productId: line.pid,
    size: line.size == null ? "_" : String(line.size),
    qty: Number(line.qty) || 1,
    requestingLocation: to,
    status: "open",
    createdAt: nowIso,
    createdFrom: { manual: true, source: from, via: ESCALATION_VIA, ref: order.ref, orderKey: orderId, lineIndex },
    // A customer's parcel is waiting: pickable now, not at the next window.
    earlyRelease: { at: nowMs, by: "online-escalation", reason: `Website order ${order.ref}` },
    onlineRef: order.ref,
  };
}

const iso = (ms) => new Date(ms).toISOString();

// The line's place while it climbs: where the units will be (so the hold's
// `locs` point there and the walk-in guard protects them when they land).
function holdLocation(esc) {
  const step = currentStep(esc);
  if (esc.phase === ESC_PHASE.AWAIT || esc.phase === ESC_PHASE.WAIT) return esc.deliverAt || step?.to || null;
  return step?.to || step?.at || esc.deliverAt || null;
}

/** The line as it should read for this escalation (source only). */
export function lineForEscalation(line, esc) {
  if (!esc) return line;
  if (esc.phase === ESC_PHASE.UNAVAILABLE) return { ...line, escalation: esc, source: { status: LINE_STATUS.UNAVAILABLE } };
  if (esc.phase === ESC_PHASE.RESOLVED) return { ...line, escalation: esc, source: { status: LINE_STATUS.RESOLVED } };
  if (esc.phase === ESC_PHASE.DONE) return { ...line, escalation: esc };
  if (esc.phase === ESC_PHASE.DELIVER && esc.delivered) return { ...line, escalation: esc };
  const loc = holdLocation(esc);
  return { ...line, escalation: esc, source: loc ? { status: LINE_STATUS.RESOLVING, locationId: loc } : { status: LINE_STATUS.RESOLVING } };
}

/** The line put back on the pick / display path at `at` (a fresh entry key). */
export function deliveredLine(line, esc, nowMs) {
  const at = esc.deliverAt;
  const hub = at === "hub1" || at === "hub2";
  const next = stepEscalation(esc, { type: "delivered" }, { nowMs });
  return {
    ...line,
    escalation: next,
    routeGen: (Number(line.routeGen) || 0) + 1,
    source: { locationId: at, status: hub ? LINE_STATUS.PICK : LINE_STATUS.DISPLAY, ...(esc.checkProperly ? { checkProperly: true } : {}) },
  };
}

const clean = (v) => JSON.parse(JSON.stringify(v ?? null));

/**
 * One transaction on one line: `fn(line)` returns the new line or undefined
 * (abort). Aborts when the order has closed or the line moved (another writer
 * won) — the next tick decides again.
 */
async function lineTxn(ctx, orderId, i, fn) {
  const res = await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/lines/${i}`).transaction((cur) => {
    if (cur == null) return null;
    const out = fn(cur);
    return out === undefined ? undefined : clean(out);
  });
  return res.committed ? res.snapshot.val() : null;
}

const sameSpot = (a, b) => a && b && a.phase === b.phase && a.round === b.round && a.idx === b.idx;

/**
 * Escalate every line of one order that needs it. `order` is as read this
 * tick. Returns true when anything changed. `helpers.cancelLine(line)`
 * closes what a line had on a list — its hub orders or display entry (poll.mjs).
 */
export async function escalateOrder(ctx, orderId, order, helpers = {}) {
  const { now } = ctx;
  let changed = false;
  const lines = linesOf(order);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.pid && !line?.escalation) continue;
    try {
      if (await escalateLine(ctx, orderId, order, i, line, helpers)) changed = true;
    } catch (e) {
      ctx.summary.errors.push(`${order.ref ?? orderId} line ${i + 1} escalation: ${String(e?.message || e)}`);
      ctx.log(`  ✗ ${order.ref ?? orderId} line ${i + 1}: escalation — ${String(e?.message || e)}`);
    }
  }
  if (changed) await clearEscalatedAttention(ctx, orderId, now);
  return changed;
}

async function escalateLine(ctx, orderId, order, i, line0, helpers) {
  const { now, log } = ctx;
  let line = line0;
  let changed = false;
  const st = line?.source?.status;
  const override = line?.escalationOverride;

  // ── START ──────────────────────────────────────────────────────────────────
  // A place that failed (Not found / Couldn't find it) or a line routing
  // found nowhere: the chain begins. An override on a line with no
  // escalation starts one too, so the escape hatch works on any open line.
  const startable = !line.escalation && line.pid && (FAILED_LINE.has(st) || (override && !override.appliedAt));
  if (startable) {
    const reason = FAILED_LINE.has(st) ? st : "override";
    const esc = startEscalation(line, { nowMs: now, reason });
    const next = await lineTxn(ctx, orderId, i, (cur) => {
      if (cur.escalation) return undefined;
      if (cur.source?.status !== st) return undefined;
      return lineForEscalation(cur, esc);
    });
    if (!next) return false;
    if (helpers.cancelLine && !FAILED_LINE.has(st)) await helpers.cancelLine(line);
    log(`  ⤴ ${order.ref} line ${i + 1}: ${line.title}${line.size && line.size !== "_" ? ` ${line.size}` : ""} — ${st} at ${line.source?.locationId ?? "nowhere"}; escalating (${esc.chain}, home ${esc.home})`);
    ctx.summary.escalated = (ctx.summary.escalated || 0) + 1;
    line = next;
    changed = true;
  }
  if (!line.escalation) return changed;

  // ── OVERRIDE (Junid, Settings) ─────────────────────────────────────────────
  if (override && !override.appliedAt && (override.kind === "unavailable" || override.kind === "resolved")) {
    const before = line;
    const next = await lineTxn(ctx, orderId, i, (cur) => {
      if (!cur.escalation || cur.escalationOverride?.appliedAt) return undefined;
      const esc = stepEscalation(cur.escalation, { type: "override", kind: override.kind, by: override.by }, { nowMs: now });
      return { ...lineForEscalation(cur, esc), escalationOverride: { ...cur.escalationOverride, appliedAt: now } };
    });
    if (next) {
      if (helpers.cancelLine && (before.source?.entryKey || before.source?.orderKeys)) await helpers.cancelLine(before);
      log(`  ⤴ ${order.ref} line ${i + 1}: ${override.kind === "unavailable" ? "marked unavailable" : "resolved by hand"} by Junid`);
      line = next;
      changed = true;
    }
  }

  // ── RUN the machine until it waits ─────────────────────────────────────────
  for (let n = 0; n < MAX_STEPS_PER_TICK; n++) {
    const esc = line.escalation;
    if (!esc || ESC_TERMINAL.includes(esc.phase)) break;
    const act = pendingAction(esc, { nowMs: now });
    if (!act) break;
    const next = await perform(ctx, orderId, order, i, line, esc, act);
    if (!next) break;
    line = next;
    changed = true;
  }
  if (changed) await mirror(ctx, orderId, order, i, line);
  return changed;
}

async function perform(ctx, orderId, order, i, line, esc, act) {
  const { db, now, log } = ctx;
  switch (act.kind) {
    case STEP.STORE_ORDER:
    case STEP.REFILL: {
      const escKey = requestKey(orderId, i, esc);
      // 1. INTENT
      let pending = esc.pending && esc.pending.escKey === escKey ? esc.pending : null;
      if (!pending) {
        const key = act.kind === STEP.REFILL ? escKey : `${await drawRefillNumber(db, now)}-1`;
        const intent = { kind: act.kind, from: act.from, to: act.to, key, escKey, at: now };
        const after = await lineTxn(ctx, orderId, i, (cur) => {
          if (!sameSpot(cur.escalation, esc) || cur.escalation.phase !== ESC_PHASE.RAISE) return undefined;
          if (cur.escalation.pending?.escKey === escKey) return cur; // another run's intent stands
          return { ...cur, escalation: { ...cur.escalation, pending: intent } };
        });
        if (!after) return null;
        pending = after.escalation.pending;
      }
      // 2. ACT — create if absent; ours already there is fine.
      const nowIso = iso(now);
      if (pending.kind === STEP.REFILL) {
        const rec = refillRow({ line, order, orderId, lineIndex: i, to: pending.to, from: pending.from, nowIso, nowMs: now });
        const res = await db.ref(`refill_requests/${pending.key}`).transaction((cur) => (cur == null ? rec : undefined));
        if (!res.committed && !res.snapshot.val()) return null;
      } else {
        const card = storeOrderCard({ key: pending.key, line, order, orderId, lineIndex: i, to: pending.to, from: pending.from, nowIso, escKey });
        const res = await db.ref(`orders/${pending.key}`).transaction((cur) => (cur == null ? card : undefined));
        const there = res.snapshot.val();
        if (!res.committed && there?.onlineEscalationKey !== escKey) {
          // R-numbers recycle daily: an old card holds this number. Forget the
          // intent; the next tick draws a fresh number.
          await lineTxn(ctx, orderId, i, (cur) => (cur.escalation?.pending?.key === pending.key ? { ...cur, escalation: { ...cur.escalation, pending: null } } : undefined));
          log(`  ! ${order.ref} line ${i + 1}: card ${pending.key} already exists for something else — redrawn next tick`);
          return null;
        }
      }
      // 3. COMMIT
      const request = { kind: pending.kind, key: pending.key, from: pending.from, to: pending.to, at: pending.at };
      const next = await lineTxn(ctx, orderId, i, (cur) => {
        if (!sameSpot(cur.escalation, esc) || cur.escalation.pending?.escKey !== escKey) return undefined;
        return lineForEscalation(cur, stepEscalation(cur.escalation, { type: "raised", request }, { nowMs: now }));
      });
      if (next) log(`  ⤴ ${order.ref} line ${i + 1}: asked ${pending.from} → ${pending.to} (${pending.kind === STEP.REFILL ? "refill request" : "Shop Refill card"} ${pending.key})`);
      return next;
    }
    case "recheck": {
      return lineTxn(ctx, orderId, i, (cur) => {
        if (!sameSpot(cur.escalation, esc)) return undefined;
        return lineForEscalation(cur, stepEscalation(cur.escalation, { type: "raised" }, { nowMs: now }));
      });
    }
    case "observe": {
      const { kind, key } = act.request;
      const record = await ctx.get(kind === STEP.REFILL ? `refill_requests/${key}` : `orders/${key}`);
      // A card that names another order is not ours any more (recycled
      // number): it says nothing about this line.
      if (kind === STEP.STORE_ORDER && record && record.onlineEscalationKey && record.onlineEscalationKey !== requestKey(orderId, i, esc)) return null;
      const seen = requestOutcome(kind, record);
      if (!seen) return null;
      const next = await lineTxn(ctx, orderId, i, (cur) => {
        if (!sameSpot(cur.escalation, esc)) return undefined;
        return lineForEscalation(cur, stepEscalation(cur.escalation, { type: "request", ...seen }, { nowMs: now }));
      });
      if (next) log(`  ⤴ ${order.ref} line ${i + 1}: ${act.request.from} ${seen.outcome} ${key}${next.escalation.phase === ESC_PHASE.WAIT ? ` — back on the list ${iso(next.escalation.waitUntil)}` : ""}`);
      return next;
    }
    case "tick": {
      return lineTxn(ctx, orderId, i, (cur) => {
        if (!sameSpot(cur.escalation, esc)) return undefined;
        return lineForEscalation(cur, stepEscalation(cur.escalation, { type: "tick" }, { nowMs: now }));
      });
    }
    case "deliver": {
      // A packed order cannot take a line back: it ships in a follow-up.
      if (order.status === ORDER_STATUS.PACKED) return deliverFollowUp(ctx, orderId, order, i, esc);
      const next = await lineTxn(ctx, orderId, i, (cur) => {
        if (!sameSpot(cur.escalation, esc) || cur.escalation.delivered) return undefined;
        return deliveredLine(cur, cur.escalation, now);
      });
      if (next) log(`  ⤴ ${order.ref} line ${i + 1}: back on the ${next.source.status} list at ${next.source.locationId}${next.source.checkProperly ? " — CHECK PROPERLY" : ""}`);
      return next;
    }
    case "watch_line": {
      const s = line.source?.status;
      const outcome = s === LINE_STATUS.HANDED ? "handed" : FAILED_LINE.has(s) ? "failed" : null;
      if (!outcome) return null;
      return lineTxn(ctx, orderId, i, (cur) => {
        if (!sameSpot(cur.escalation, esc) || cur.source?.status !== s) return undefined;
        const nextEsc = stepEscalation(cur.escalation, { type: "line", outcome }, { nowMs: now });
        return outcome === "handed" ? { ...cur, escalation: nextEsc } : lineForEscalation(cur, nextEsc);
      });
    }
    default:
      return null;
  }
}

// ── A line that comes good after its order was packed ships on its own ──────
// The follow-up is an ordinary open order (`{orderId}f{i}`): same Shopify
// order, one line, its own hold, pick, pack sale and partial fulfilment of
// that one Shopify line. The parent line becomes "moved" and stops holding.
export const followUpId = (orderId, i) => `${orderId}f${i}`;

/** The follow-up order record carrying `line` (already on its pick / display path). */
export function followUpRecord({ order, orderId, i, line, parentLine, nowMs }) {
  return {
    // Key-safe: the ref becomes the follow-up's hub order keys (hubOrderKeys).
    ref: `${order.ref}-F${i + 1}`,
    orderNumber: order.orderNumber, shopifyGid: order.shopifyGid, shopifyName: order.shopifyName,
    followUpOf: orderId, followUpLine: i,
    createdAt: nowMs, ingestedAt: nowMs, updatedAt: nowMs,
    ...(order.customer ? { customer: order.customer } : {}),
    ...(order.shipping?.address ? { shipping: { address: order.shipping.address } } : {}),
    totals: { subtotalCents: (Number(line.unitPriceCents) || 0) * (Number(line.qty) || 1), currency: order.totals?.currency || "ZAR" },
    lines: [{ ...line, lineId: `${parentLine.lineId || `l${i}`}f` }],
    status: ORDER_STATUS.NEW,
  };
}

async function deliverFollowUp(ctx, orderId, order, i, esc) {
  const { db, now, log } = ctx;
  const fid = followUpId(orderId, i);
  const parentLine = linesOf(order)[i];
  const line = deliveredLine({ ...parentLine, escalation: esc }, esc, now);
  const follow = followUpRecord({ order, orderId, i, line, parentLine, nowMs: now });
  const res = await db.ref(`${ONLINE_ORDERS_PATH}/${fid}`).transaction((cur) => (cur == null ? clean(follow) : undefined));
  if (!res.committed && !res.snapshot.val()) return null;
  const next = await lineTxn(ctx, orderId, i, (cur) => {
    if (!sameSpot(cur.escalation, esc)) return undefined;
    return { ...cur, escalation: { ...cur.escalation, phase: ESC_PHASE.DONE, doneAt: now, movedTo: fid }, source: { status: LINE_STATUS.MOVED, movedTo: fid } };
  });
  if (next) {
    await db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/followUps/${fid}`).set(true);
    log(`  ⤴ ${order.ref} line ${i + 1}: came good after the pack — ships as ${follow.ref}`);
  }
  return next;
}

// ── Attention the escalation has taken over ─────────────────────────────────
// completeDisplayCheck raises "not_found" attention on the order the moment a
// shop answers Not found. The chain is now answering it, so the attention
// (and Junid's email) goes — unless another line still needs a person.
async function clearEscalatedAttention(ctx, orderId, nowMs) {
  await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${orderId}`).transaction((cur) => {
    if (cur == null) return null;
    const a = cur.attention;
    if (!a || (a.kind !== ATTENTION_KIND.NOT_FOUND && a.kind !== ATTENTION_KIND.NO_STOCK)) return undefined;
    const stillBad = linesOf(cur).some((l) => FAILED_LINE.has(l?.source?.status) && !l?.escalation);
    if (stillBad) return undefined;
    return { ...cur, attention: null, attentionOpen: null, updatedAt: nowMs, ...(cur.status === ORDER_STATUS.NEEDS_ATTENTION ? { status: ORDER_STATUS.NEW } : {}) };
  });
}

// ── The registry: Settings' list and the tick's index of open escalations ──
// /online_escalations/{orderId}_{i} mirrors each escalated line. The line is
// the truth; this is what can be listed without reading /online_orders.
// A finished one (found, resolved) is removed; an unavailable one stays until
// the customer agent closes it.
export async function mirror(ctx, orderId, order, i, line) {
  const esc = line.escalation;
  const key = `${orderId}_${i}`;
  if (!esc || esc.phase === ESC_PHASE.DONE || esc.phase === ESC_PHASE.RESOLVED) {
    await ctx.db.ref(`${ESCALATIONS_PATH}/${key}`).set(null);
    return;
  }
  const d = describeEscalation(esc, { nowMs: ctx.now });
  await ctx.db.ref(`${ESCALATIONS_PATH}/${key}`).update(clean({
    orderId, lineIndex: i, ref: order.ref, title: line.title || null, size: line.size ?? null, qty: Number(line.qty) || 1,
    phase: esc.phase, round: esc.round, where: d.where, next: d.next, nextAt: d.nextAt ?? null,
    updatedAt: ctx.now,
  }));
}

export { PARKED_LINE_STATUSES };
