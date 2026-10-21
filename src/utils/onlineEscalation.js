// ── Website-order line escalation — the state machine, PURE ─────────────────
// When the place a website-order line was routed to cannot produce it (a shop
// answers "Not found", a hub answers "Couldn't find it", or routing found no
// stock at all), the line does not stop at "needs attention" any more: it
// climbs a fixed chain of the EXISTING request primitives until it comes good
// or the chain runs out, and only then is the line "unavailable" (the customer
// agent takes it from there). Owner spec 2026-10-21; contract
// docs/ONLINE-ORDERS.md § Escalation.
//
//   NON-FOOTWEAR (home = the shop it was routed to)
//     round 1: Hub 2 → shop (Shop Refill card) → Central → Hub 2 (refill row)
//     round 2: the shop again, "CHECK PROPERLY" → Hub 2 → shop → Central → Hub 2
//     → unavailable
//   NON-FOOTWEAR (home = Hub 2, nothing at either shop)
//     round 1: Central → Hub 2
//     round 2: Hub 2 again, "CHECK PROPERLY" → Central → Hub 2 → unavailable
//   FOOTWEAR (home = the hub that rejected)
//     round 1: Central → that hub
//     round 2: Central sent it but the hub rejected again → Central once more
//              Central rejected → the hub once more, "CHECK PROPERLY"
//     → unavailable
//
// A request that is FULFILLED moves stock on the system at once, but the box
// lands the next morning (~09:30–10:30). So the line waits until 11:00 SAST on
// the next working day (Mon–Sat) and only then goes back to the normal pick /
// display path at the place the stock was sent. A delivery that is handed over
// ends the escalation; one that fails again moves to the next step.
//
// This module decides; scripts/shopify/onlineOrders/escalate.mjs reads and
// writes. Nothing here touches a database, a clock or the network.

export const ESCALATION_VIA = "online_escalation";

export const ESC_PHASE = Object.freeze({
  RAISE: "raise",          // a request is to be raised (intent may be pending)
  AWAIT: "await",          // the request is open; waiting for its answer
  WAIT: "wait",            // the request was fulfilled; waiting for the box
  DELIVER: "deliver",      // back on the pick / display path at `deliverAt`
  UNAVAILABLE: "unavailable",
  DONE: "done",            // handed over after an escalation
  RESOLVED: "resolved",    // Junid: "resolved by hand"
});

export const ESC_TERMINAL = Object.freeze([ESC_PHASE.UNAVAILABLE, ESC_PHASE.DONE, ESC_PHASE.RESOLVED]);

export const STEP = Object.freeze({
  STORE_ORDER: "store_order", // Hub 2 → shop, a manual Shop Refill card on /orders
  REFILL: "refill",           // Central → hub, a /refill_requests row
  RECHECK: "recheck",         // the same place looks again, "CHECK PROPERLY"
});

export const HUB2 = "hub2";
export const CENTRAL = "central";
const SHOPS = new Set(["marathon-pe", "trophy"]);
const HUBS = new Set(["hub1", "hub2"]);

// SAST is UTC+2 all year (no daylight saving).
const SAST_OFFSET_MS = 2 * 3600 * 1000;
export const DELIVERY_HOUR_SAST = 11;

/**
 * 11:00 SAST on the first working day (Mon–Sat) AFTER the SA calendar day of
 * `ms`. A box sent on Saturday lands Monday; sent on Sunday (nobody does,
 * but) also Monday.
 */
export function nextDeliveryAt(ms) {
  const sa = new Date(Number(ms) + SAST_OFFSET_MS);
  let y = sa.getUTCFullYear(), m = sa.getUTCMonth(), d = sa.getUTCDate() + 1;
  let t = Date.UTC(y, m, d);
  if (new Date(t).getUTCDay() === 0) t += 24 * 3600 * 1000; // Sunday → Monday
  return t + DELIVERY_HOUR_SAST * 3600 * 1000 - SAST_OFFSET_MS;
}

/** The steps of one round. `how` is "rejected" when Central said no in round 1. */
export function planFor({ footwear, home, round, centralRejected = false }) {
  if (footwear) {
    if (round === 1) return [{ step: STEP.REFILL, from: CENTRAL, to: home }];
    return centralRejected
      ? [{ step: STEP.RECHECK, at: home }]
      : [{ step: STEP.REFILL, from: CENTRAL, to: home }];
  }
  if (SHOPS.has(home)) {
    const r1 = [
      { step: STEP.STORE_ORDER, from: HUB2, to: home },
      { step: STEP.REFILL, from: CENTRAL, to: HUB2 },
    ];
    return round === 1 ? r1 : [{ step: STEP.RECHECK, at: home }, ...r1];
  }
  // Home is Hub 2 (or nowhere — a no_stock line starts at Central → Hub 2).
  const r1 = [{ step: STEP.REFILL, from: CENTRAL, to: HUB2 }];
  return round === 1 ? r1 : [{ step: STEP.RECHECK, at: HUB2 }, ...r1];
}

const isFootwearLine = (line) => line?.isFootwear === true;

/**
 * Where a failed line starts. A shop line's home is its shop; a footwear
 * line's home is the hub that failed (no_stock footwear: Hub 1, the first
 * place footwear routes); anything else's home is Hub 2.
 */
export function homeOf(line) {
  const loc = line?.source?.locationId || null;
  if (isFootwearLine(line)) return HUBS.has(loc) ? loc : "hub1";
  if (SHOPS.has(loc)) return loc;
  return HUB2;
}

/** A fresh escalation for a line whose place just failed. */
export function startEscalation(line, { nowMs, reason }) {
  const footwear = isFootwearLine(line);
  const home = homeOf(line);
  return {
    chain: footwear ? "footwear" : "other",
    home,
    round: 1,
    idx: 0,
    phase: ESC_PHASE.RAISE,
    startedAt: nowMs,
    attempts: [{ location: line?.source?.locationId || null, action: "routed", result: reason, at: nowMs }],
  };
}

const plan = (esc) => planFor({ footwear: esc.chain === "footwear", home: esc.home, round: esc.round, centralRejected: !!esc.centralRejected });

export const currentStep = (esc) => (esc && !ESC_TERMINAL.includes(esc.phase) ? plan(esc)[esc.idx] || null : null);

const attempt = (esc, a) => [...(Array.isArray(esc.attempts) ? esc.attempts : Object.values(esc.attempts || {})), a];

/** Move past the current step after it failed: next step, next round, or the end. */
function advance(esc, nowMs, { centralRejected = false } = {}) {
  const steps = plan(esc);
  const base = { ...esc, request: null, pending: null, waitUntil: null, deliverAt: null };
  if (esc.idx + 1 < steps.length) return { ...base, idx: esc.idx + 1, phase: ESC_PHASE.RAISE };
  if (esc.round === 1) {
    return {
      ...base, round: 2, idx: 0, phase: ESC_PHASE.RAISE,
      // Footwear round 2 depends on how round 1 ended (owner spec).
      centralRejected: esc.chain === "footwear" ? centralRejected : false,
    };
  }
  return { ...base, phase: ESC_PHASE.UNAVAILABLE, unavailableAt: nowMs };
}

/**
 * One transition. `event` is what the poller observed:
 *   { type: "raised", request }                    the intent's write landed
 *   { type: "request", outcome: "fulfilled"|"rejected"|"withdrawn", at? }
 *   { type: "tick" }                               time passed
 *   { type: "delivered" }                          the line is back on the path
 *   { type: "line", outcome: "handed"|"failed" }   the delivery's answer
 *   { type: "override", kind: "unavailable"|"resolved", by }
 * → the next escalation object (never mutates). An event that does not fit
 * the phase returns `esc` unchanged — a re-delivered observation is a no-op,
 * which is what makes a re-run after a crash safe.
 */
export function stepEscalation(esc, event, { nowMs }) {
  if (!esc || !event) return esc;
  // "Resolved by hand" also closes an unavailable line (it stops the customer
  // agent); nothing else moves a finished escalation.
  if (esc.phase === ESC_PHASE.UNAVAILABLE && event.type === "override" && event.kind === "resolved") {
    return { ...esc, phase: ESC_PHASE.RESOLVED, resolvedAt: nowMs, attempts: attempt(esc, { location: null, action: "override", result: "resolved_by_hand", by: event.by || null, at: nowMs }) };
  }
  if (ESC_TERMINAL.includes(esc.phase)) return esc;
  if (event.type === "override") {
    if (event.kind === "unavailable") {
      return { ...esc, phase: ESC_PHASE.UNAVAILABLE, unavailableAt: nowMs, request: null, pending: null, waitUntil: null, attempts: attempt(esc, { location: null, action: "override", result: "marked_unavailable", by: event.by || null, at: nowMs }) };
    }
    if (event.kind === "resolved") {
      return { ...esc, phase: ESC_PHASE.RESOLVED, resolvedAt: nowMs, request: null, pending: null, waitUntil: null, attempts: attempt(esc, { location: null, action: "override", result: "resolved_by_hand", by: event.by || null, at: nowMs }) };
    }
    return esc;
  }
  const step = currentStep(esc);
  switch (esc.phase) {
    case ESC_PHASE.RAISE: {
      if (event.type !== "raised" || !step) return esc;
      if (step.step === STEP.RECHECK) {
        // No request: the same place looks again. Straight to delivery.
        return { ...esc, phase: ESC_PHASE.DELIVER, deliverAt: step.at, checkProperly: true, pending: null, delivered: false,
          attempts: attempt(esc, { location: step.at, action: "recheck", result: "raised", at: nowMs }) };
      }
      return { ...esc, phase: ESC_PHASE.AWAIT, request: event.request, pending: null,
        attempts: attempt(esc, { location: step.from, action: `${step.step}:${step.from}->${step.to}`, result: "raised", key: event.request?.key || null, at: nowMs }) };
    }
    case ESC_PHASE.AWAIT: {
      if (event.type !== "request" || !step) return esc;
      const a = (result) => attempt(esc, { location: step.from, action: `${step.step}:${step.from}->${step.to}`, result, key: esc.request?.key || null, at: nowMs });
      if (event.outcome === "fulfilled") {
        const sentAt = Number(event.at) || nowMs;
        return { ...esc, phase: ESC_PHASE.WAIT, waitUntil: nextDeliveryAt(sentAt), deliverAt: step.to, checkProperly: false, attempts: a("fulfilled") };
      }
      if (event.outcome === "rejected" || event.outcome === "withdrawn") {
        const next = advance({ ...esc, attempts: a(event.outcome) }, nowMs, { centralRejected: step.from === CENTRAL });
        return next;
      }
      return esc;
    }
    case ESC_PHASE.WAIT: {
      if (event.type !== "tick" || !(nowMs >= Number(esc.waitUntil))) return esc;
      return { ...esc, phase: ESC_PHASE.DELIVER, waitUntil: null, delivered: false };
    }
    case ESC_PHASE.DELIVER: {
      if (event.type === "delivered") {
        if (esc.delivered) return esc;
        return { ...esc, delivered: true, attempts: attempt(esc, { location: esc.deliverAt, action: esc.checkProperly ? "recheck" : "deliver", result: "on_path", at: nowMs }) };
      }
      if (event.type !== "line" || !esc.delivered) return esc;
      if (event.outcome === "handed") {
        return { ...esc, phase: ESC_PHASE.DONE, doneAt: nowMs, attempts: attempt(esc, { location: esc.deliverAt, action: "deliver", result: "handed", at: nowMs }) };
      }
      if (event.outcome === "failed") {
        const failed = { ...esc, attempts: attempt(esc, { location: esc.deliverAt, action: esc.checkProperly ? "recheck" : "deliver", result: "not_found", at: nowMs }) };
        // A delivery after Central's fulfilment failing is "the hub rejected
        // again" (footwear round 2 → Central once more), never a Central no.
        return advance({ ...failed, checkProperly: false, delivered: false }, nowMs, { centralRejected: false });
      }
      return esc;
    }
    default:
      return esc;
  }
}

/** The action the poller must perform for this escalation now, or null. */
export function pendingAction(esc, { nowMs }) {
  if (!esc || ESC_TERMINAL.includes(esc.phase)) return null;
  const step = currentStep(esc);
  if (esc.phase === ESC_PHASE.RAISE && step) {
    if (step.step === STEP.RECHECK) return { kind: "recheck", at: step.at };
    return { kind: step.step, from: step.from, to: step.to };
  }
  if (esc.phase === ESC_PHASE.AWAIT && esc.request) return { kind: "observe", request: esc.request };
  if (esc.phase === ESC_PHASE.WAIT) return nowMs >= Number(esc.waitUntil) ? { kind: "tick" } : null;
  if (esc.phase === ESC_PHASE.DELIVER) return esc.delivered ? { kind: "watch_line" } : { kind: "deliver", at: esc.deliverAt, checkProperly: !!esc.checkProperly };
  return null;
}

/** Deterministic key of the n-th request this line raises (restart-safe). */
export function requestKey(orderId, lineIndex, esc) {
  return `web_${orderId}_${lineIndex}_r${esc.round}s${esc.idx}`;
}

/**
 * What a request record says, from the record as read:
 *   store_order (/orders/{key}): clothingRefillStatus available → fulfilled;
 *     rejected / outOfStock → rejected; card gone → withdrawn.
 *   refill (/refill_requests/{key}): fulfilled → fulfilled; cancelled with no
 *     reason (a person's Out of Stock) or Central's first-batch decline →
 *     rejected; cancelled with any other reason → withdrawn; open → null.
 */
export function requestOutcome(kind, record) {
  if (record == null) return { outcome: "withdrawn" };
  if (kind === STEP.STORE_ORDER) {
    const s = record.clothingRefillStatus;
    if (s === "available") return { outcome: "fulfilled", at: Date.parse(record.clothingRefilledAt) || Number(record.clothingRefilledAt) || null };
    if (s === "rejected" || s === "outOfStock") return { outcome: "rejected" };
    return null;
  }
  if (record.status === "fulfilled") return { outcome: "fulfilled", at: Date.parse(record.resolvedAt) || Number(record.resolvedAt) || null };
  if (record.status === "cancelled") {
    const r = record.cancelReason;
    if (r == null || r === "first_batch_central_declined") return { outcome: "rejected" };
    return { outcome: "withdrawn" };
  }
  return null;
}

const PLACE = { hub1: "Hub 1", hub2: "Hub 2", central: "Central", "marathon-pe": "Marathon PE", trophy: "Trophy" };
const place = (loc) => PLACE[loc] || loc || "?";

/** "Where it is" and "what happens next", for Settings → Online orders. */
export function describeEscalation(esc, { nowMs } = {}) {
  if (!esc) return { where: "—", next: "—", nextAt: null };
  const step = currentStep(esc);
  const round = `round ${esc.round}`;
  switch (esc.phase) {
    case ESC_PHASE.RAISE:
      if (!step) return { where: round, next: "—", nextAt: null };
      return step.step === STEP.RECHECK
        ? { where: `${round}: ${place(step.at)} to check properly`, next: "Raise the re-check", nextAt: nowMs ?? null }
        : { where: `${round}: ${place(step.from)} → ${place(step.to)}`, next: "Raise the request", nextAt: nowMs ?? null };
    case ESC_PHASE.AWAIT:
      return { where: `${round}: ${place(step?.from)} → ${place(step?.to)} requested`, next: `Waiting for ${place(step?.from)} to send or reject`, nextAt: null };
    case ESC_PHASE.WAIT:
      return { where: `${round}: sent to ${place(esc.deliverAt)}`, next: `Back on the ${HUBS.has(esc.deliverAt) ? "pick" : "display"} list at ${place(esc.deliverAt)}`, nextAt: esc.waitUntil ?? null };
    case ESC_PHASE.DELIVER:
      return { where: `${round}: ${place(esc.deliverAt)}${esc.checkProperly ? " — CHECK PROPERLY" : ""}`, next: esc.delivered ? `Waiting for ${place(esc.deliverAt)} to hand it over` : "Put it back on the list", nextAt: null };
    case ESC_PHASE.UNAVAILABLE:
      return { where: "Unavailable", next: "Customer agent", nextAt: null };
    case ESC_PHASE.DONE:
      return { where: "Found", next: "—", nextAt: null };
    case ESC_PHASE.RESOLVED:
      return { where: "Resolved by hand", next: "—", nextAt: null };
    default:
      return { where: esc.phase, next: "—", nextAt: null };
  }
}
