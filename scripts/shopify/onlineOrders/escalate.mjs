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
  ONLINE_ORDERS_PATH, LINE_STATUS, ORDER_STATUS, ATTENTION_KIND, PARKED_LINE_STATUSES, orderLabel,
} from "../../../src/utils/onlineOrders.js";
import { linesOf } from "./orderModel.mjs";
import { releaseOnlinePiece, tellJunid, RELEASE } from "./onlinePiece.mjs";
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
    // placedStore: the placing store MODE, as placeRefillRequests writes it
    // (Marathon PE and Trophy are both "central"); destShop is the shop.
    hub: from, placedAtHub: from, placedStore: "central", destShop: to,
    productType: "clothing", requestDisplay: false, requestDisplayPartner: false,
    status: "incoming", createdAt: nowIso, updatedAt: nowIso,
    readyAt: null, outOfStockAt: null, comingTomorrowAt: null, collectedAt: null,
    displayRefillScheduledAt: null, displayRefillHub: null, displayRefillStatus: null,
    displayRefilledAt: null, displayRefillStockDepletedAt: null, displayRefilledBy: null,
    clothingRefillStatus: null, clothingRefilledAt: null, clothingOutOfStockAt: null, clothingRefilledBy: null,
    // The website order this card is for — shown on Hub 2's card.
    onlineRef: orderLabel(order), onlineOrderKey: orderId, onlineLineIndex: lineIndex, onlineEscalationKey: escKey,
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
    createdFrom: { manual: true, source: from, via: ESCALATION_VIA, ref: orderLabel(order), orderKey: orderId, lineIndex },
    // A customer's parcel is waiting: pickable now, not at the next window.
    earlyRelease: { at: nowMs, by: "online-escalation", reason: `Website order ${orderLabel(order)}` },
    onlineRef: orderLabel(order),
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
      ctx.summary.errors.push(`${orderLabel(order)} line ${i + 1} escalation: ${String(e?.message || e)}`);
      ctx.log(`  ✗ ${orderLabel(order)} line ${i + 1}: escalation — ${String(e?.message || e)}`);
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
  // A multi-unit line whose hub orders came back MIXED (some units sent, one
  // Out of Stock) is Junid's: escalating the whole qty would send units twice
  // (Sonnet review, PR #778). Its no_stock attention stands.
  const mixedHub = FAILED_LINE.has(st) && Number(line.qty) > 1 && Array.isArray(line.source?.orderKeys) && line.source.orderKeys.length > 1;
  const startable = !line.escalation && line.pid && !mixedHub && (FAILED_LINE.has(st) || (override && !override.appliedAt));
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
    log(`  ⤴ ${orderLabel(order)} line ${i + 1}: ${line.title}${line.size && line.size !== "_" ? ` ${line.size}` : ""} — ${st} at ${line.source?.locationId ?? "nowhere"}; escalating (${esc.chain}, home ${esc.home})`);
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
      // The request still open at Hub 2 / Central is withdrawn: nobody should
      // move stock toward a line Junid has settled.
      if (before.escalation?.phase === ESC_PHASE.AWAIT && before.escalation.request) await withdrawRequest(ctx, orderId, i, before.escalation);
      log(`  ⤴ ${orderLabel(order)} line ${i + 1}: ${override.kind === "unavailable" ? "marked unavailable" : "resolved by hand"} by Junid`);
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
          log(`  ! ${orderLabel(order)} line ${i + 1}: card ${pending.key} already exists for something else — redrawn next tick`);
          return null;
        }
      }
      // 3. COMMIT
      const request = { kind: pending.kind, key: pending.key, from: pending.from, to: pending.to, at: pending.at };
      const next = await lineTxn(ctx, orderId, i, (cur) => {
        if (!sameSpot(cur.escalation, esc) || cur.escalation.pending?.escKey !== escKey) return undefined;
        return lineForEscalation(cur, stepEscalation(cur.escalation, { type: "raised", request }, { nowMs: now }));
      });
      if (next) log(`  ⤴ ${orderLabel(order)} line ${i + 1}: asked ${pending.from} → ${pending.to} (${pending.kind === STEP.REFILL ? "refill request" : "Shop Refill card"} ${pending.key})`);
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
      if (!seen) {
        await staleAlert(ctx, orderId, order, i, line, esc);
        return null;
      }
      const next = await lineTxn(ctx, orderId, i, (cur) => {
        if (!sameSpot(cur.escalation, esc)) return undefined;
        return lineForEscalation(cur, stepEscalation(cur.escalation, { type: "request", ...seen }, { nowMs: now }));
      });
      if (next) log(`  ⤴ ${orderLabel(order)} line ${i + 1}: ${act.request.from} ${seen.outcome} ${key}${next.escalation.phase === ESC_PHASE.WAIT ? ` — back on the list ${iso(next.escalation.waitUntil)}` : ""}`);
      return next;
    }
    case "tick": {
      return lineTxn(ctx, orderId, i, (cur) => {
        if (!sameSpot(cur.escalation, esc)) return undefined;
        return lineForEscalation(cur, stepEscalation(cur.escalation, { type: "tick" }, { nowMs: now }));
      });
    }
    case "deliver": {
      // A packed order cannot take a line back: it ships in a follow-up. The
      // status is RE-READ — a pack may have landed since this tick began.
      const status = await ctx.get(`${ONLINE_ORDERS_PATH}/${orderId}/status`);
      if (status === ORDER_STATUS.PACKED) return deliverFollowUp(ctx, orderId, { ...order, status }, i, esc);
      const next = await lineTxn(ctx, orderId, i, (cur) => {
        if (!sameSpot(cur.escalation, esc) || cur.escalation.delivered) return undefined;
        return deliveredLine(cur, cur.escalation, now);
      });
      if (next) log(`  ⤴ ${orderLabel(order)} line ${i + 1}: back on the ${next.source.status} list at ${next.source.locationId}${next.source.checkProperly ? " — CHECK PROPERLY" : ""}`);
      return next;
    }
    case "watch_line": {
      // RACE (Sonnet review, PR #778): the line went back on a list, then a
      // pack built from an earlier read landed without it. A packed order
      // never sees a pick again — the line moves to a follow-up.
      if (order.status === ORDER_STATUS.PACKED && !order.packedLines?.[i]
        && (line.source?.status === LINE_STATUS.PICK || line.source?.status === LINE_STATUS.DISPLAY)) {
        if (ctx.cancelLineForFollowUp) await ctx.cancelLineForFollowUp(line);
        return deliverFollowUp(ctx, orderId, order, i, esc);
      }
      const s = line.source?.status;
      const outcome = s === LINE_STATUS.HANDED ? "handed" : FAILED_LINE.has(s) ? "failed" : null;
      if (!outcome) return null;
      // Mixed hub answers on a multi-unit line (some sent, one Out of Stock):
      // never re-request the whole qty — Junid is told once and the chain waits.
      if (outcome === "failed" && Number(line.qty) > 1 && Array.isArray(line.source?.orderKeys) && line.source.orderKeys.length > 1) {
        if (!esc.mixedMailedAt) {
          const marked = await lineTxn(ctx, orderId, i, (cur) => (sameSpot(cur.escalation, esc) && !cur.escalation.mixedMailedAt ? { ...cur, escalation: { ...cur.escalation, mixedMailedAt: now } } : undefined));
          if (marked && ctx.send) {
            try { await ctx.send({ subject: `Website order ${orderLabel(order)}: a hub sent part of a line and marked the rest Out of Stock`, text: `${line.title} ×${line.qty} at ${line.source.locationId}. Not re-requested automatically (units would move twice). Settings → Online orders → Escalations: resolve it by hand or mark it unavailable.` }); }
            catch (e) { log(`  ✗ ${orderLabel(order)}: mixed-hub email not sent (${String(e?.message || e)})`); }
          }
        }
        return null;
      }
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

// ── Withdrawing an open request (Junid's override, a line swap, a cancel) ───
// ONLY the online order's piece (Junid, 25 Oct 09:52 — onlinePiece.mjs): a
// request raised for this order and line is withdrawn, or reduced by exactly
// the line's quantity when it holds more; a genuine refill is never touched;
// one whose online piece cannot be told apart is left as it is (and Junid is
// told when this tick can reach him). Anything already moving is left to the
// people moving it. Every change is logged with before and after quantity.
export async function withdrawRequest(ctx, orderId, i, esc, { piece = null } = {}) {
  // The piece is the quantity the request was raised for. A caller whose line
  // has already changed (a swap) passes the OLD line's quantity.
  let qty = Number(piece);
  if (!(qty >= 1)) {
    const read = ctx.get ? await ctx.get(`${ONLINE_ORDERS_PATH}/${orderId}/lines/${i}/qty`) : (await ctx.db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/lines/${i}/qty`).get()).val();
    qty = Math.max(1, Number(read) || 1);
  }
  const log = ctx.log || (() => {});
  const rel = await releaseOnlinePiece({ ...ctx, log }, {
    orderId, orderRef: `#${orderId}`, lineIndex: i, esc, escKey: requestKey(orderId, i, esc), piece: qty, by: "withdrawn (the line no longer waits on it)",
  });
  if (rel.action === RELEASE.UNCLEAR) {
    const text = `Website order ${orderId}, line ${i + 1}: its open request ${esc.request.key} was due to be withdrawn, but which part is the online order's could not be told (${rel.why}). Nothing was changed — please check it by hand.`;
    log(`  ⚠ ${text}`);
    await tellJunid({ ...ctx, log }, text, { once: `${ONLINE_ORDERS_PATH}/${orderId}/requestAlerts/${esc.request.key}` });
  }
  return rel;
}

// ── A request nobody answers ────────────────────────────────────────────────
// The order's attention was taken over, so silence would be invisible: after
// 24 hours Junid is emailed once (ctx.send — the poll's mail sender).
export const STALE_REQUEST_MS = 24 * 3600 * 1000;
async function staleAlert(ctx, orderId, order, i, line, esc) {
  const at = Number(esc.request?.at) || 0;
  if (!at || ctx.now - at < STALE_REQUEST_MS || esc.staleMailedAt || !ctx.send) return;
  const marked = await lineTxn(ctx, orderId, i, (cur) => (sameSpot(cur.escalation, esc) && !cur.escalation.staleMailedAt ? { ...cur, escalation: { ...cur.escalation, staleMailedAt: ctx.now } } : undefined));
  if (!marked) return;
  try {
    await ctx.send({ subject: `Website order ${orderLabel(order)}: nobody has answered ${esc.request.from === "central" ? "Central" : "Hub 2"} for a day`, text: [
      `${line.title}${line.size && line.size !== "_" ? ` size ${line.size}` : ""} ×${line.qty}: ${esc.request.kind === STEP.REFILL ? "refill request" : "Shop Refill card"} ${esc.request.key} (${esc.request.from} → ${esc.request.to}) has been open since ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      "", "Settings → Online orders → Escalations: mark it unavailable now (the customer is asked), or resolved by hand.",
    ].join("\n") });
  } catch (e) { ctx.log(`  ✗ ${orderLabel(order)}: stale-request email not sent (${String(e?.message || e)})`); }
}

// ── A line that comes good after its order was packed ships on its own ──────
// The follow-up is an ordinary open order (`{orderId}f{i}`): same Shopify
// order, one line, its own hold, pick, pack sale and partial fulfilment of
// that one Shopify line. The parent line becomes "moved" and stops holding.
export const followUpId = (orderId, i) => `${orderId}f${i}`;

/** The follow-up order record carrying `line` (already on its pick / display path). */
export function followUpRecord({ order, orderId, i, line, parentLine, nowMs }) {
  return {
    // No ref: the follow-up is named by the same Shopify number (orderLabel
    // adds "(follow-up)"); its hub units get their own codes.
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
  // The parent names its follow-up FIRST: a crash after this can never leave
  // a follow-up a Shopify cancel would not reach.
  await db.ref(`${ONLINE_ORDERS_PATH}/${orderId}/followUps/${fid}`).set(true);
  const next = await lineTxn(ctx, orderId, i, (cur) => {
    if (!sameSpot(cur.escalation, esc)) return undefined;
    return { ...cur, escalation: { ...cur.escalation, phase: ESC_PHASE.DONE, doneAt: now, movedTo: fid }, source: { status: LINE_STATUS.MOVED, movedTo: fid } };
  });
  if (next) {
    log(`  ⤴ ${orderLabel(order)} line ${i + 1}: came good after the pack — ships as ${orderLabel(follow)}`);
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
    orderId, lineIndex: i, ref: orderLabel(order), title: line.title || null, size: line.size ?? null, qty: Number(line.qty) || 1,
    phase: esc.phase, round: esc.round, where: d.where, next: d.next, nextAt: d.nextAt ?? null,
    updatedAt: ctx.now,
  }));
}

export { PARKED_LINE_STATUSES };
