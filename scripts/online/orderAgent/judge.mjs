// ── The order agent's judgement on one open website order (Junid's brief, 14 Nov 2026) ──
// PURE: the order record + the facts run.mjs read for it → its group on the POS card (green / red / incoming),
// one short reason in plain words, and the actions the agent takes. Nothing here reads or writes anything.
//
//   GREEN    every line on the parcel is physically at Marathon PE (handed there, every hub unit confirmed in at the
//            till, or in the basket) and nothing waits on the customer or on money.
//   RED      anything else: the customer must answer, a difference is unpaid, a place could not produce a line, an
//            item is still at another place or on its way, a refund is being processed.
//   INCOMING an exchange whose customer's item is not back yet (Confirm arrival not done) — its own section.
//
// The actions, one rule each (the brief's five steps):
//   1 settled        Shopify shows the line refunded (a refund line naming its Shopify line item, at least
//                    SETTLE_AFTER_MS old so Jamie's own reconcile has had its turn) → close the line through the store
//                    app's own Settings path (escalationOverride "resolved"; the poller cancels its pick and hold).
//   2 customer       Jamie told the customer and they have not answered: follow_up once a SAST day after
//                    FOLLOW_UP_AFTER_MS of silence; no_answer_24h once 24 h have passed (Jamie applies Junid's rules:
//                    alternatives first, never a refund of its own).
//   3 payment        a dearer pick's difference is unpaid → payment_link (Jamie resends once a day).
//   4 not here       a place could not produce it and another place on its route has a free unit → re-pick there
//                    (excluding the place that failed, unless stock reached it since). Still at a place: nudge its
//                    staff after 2 trading hours, Junid after 4. On its way to PE: Junid after 8 trading hours.
//   5 unavailable    nowhere on the route and nothing at Central → alternatives_now (unless Jamie already has it).
// Never: a stock or refill request created, changed or cancelled; a policy value; a stock movement.
import { tradingHoursBetween } from "./hours.mjs";

export const PACKING_STORE = "marathon-pe";
export const PLACE = Object.freeze({ hub1: "Hub 1", hub2: "Hub 2", hub3: "Hub 3", "marathon-pe": "Marathon PE", trophy: "Trophy", concrete: "Concrete", "marathon-pine": "Marathon Pine", central: "Central" });
export const HUBS = new Set(["hub1", "hub2", "hub3"]);
const place = (loc) => PLACE[loc] || loc || "the shop";

export const H = 3600e3;
export const FOLLOW_UP_AFTER_MS = 4 * H;
export const NO_ANSWER_MS = 24 * H;
export const SETTLE_AFTER_MS = 30 * 60e3;
export const JAMIE_GAP_MS = 30 * 60e3; // a failed line is Jamie's own for this long before the agent hands it over
export const NUDGE_AFTER_TH = 2;
export const ESCALATE_AFTER_TH = 4;
export const TRANSIT_ESCALATE_TH = 8;
export const MARK_MAX_AGE_MS = 14 * 24 * H; // the POS's own bound on a customer-wait mark

const OFF_PARCEL = new Set(["resolved", "moved", "cancelled"]);
const FAILED = new Set(["not_found", "no_stock", "needs_attention"]);
const CUSTOMER_STATES = new Set(["waiting_reply", "no_answer", "not_contacted", "unreachable", "told_late"]);
const MONEY_STATES = new Set(["refunded", "refund_pending", "credit_pending"]);
// The order a reason is picked by: what the customer or money must do first, then what the shops must find.
export const PRIORITY = Object.freeze({ payment: 1, customer: 2, refund: 3, finding: 4, wait_stock: 5, nowhere: 6, at_place: 7, transit: 8, other: 9 });

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const rands = (c) => `R${(num(c) / 100).toFixed(2).replace(/\.00$/, "")}`;
const gidTail = (g) => String(g ?? "").split("/").pop();

/** Lines as [index, line], array or object keyed by index (RTDB hands back either). */
export function linesOf(order) {
  const l = order?.lines;
  if (Array.isArray(l)) return l.map((x, i) => [i, x]).filter(([, x]) => x && typeof x === "object");
  if (l && typeof l === "object") return Object.entries(l).map(([k, x]) => [Number(k), x]).filter(([i, x]) => Number.isInteger(i) && x && typeof x === "object");
  return [];
}
const codesOf = (line) => (Array.isArray(line?.source?.orderKeys) ? line.source.orderKeys.filter((k) => typeof k === "string" && /^[A-HJ-NP-Z]{3}$/.test(k)) : []);

/** Is line i physically at Marathon PE, as far as the till knows? (The POS's lineIsHere.) */
export function lineIsHere(order, i, line) {
  if (order?.basket?.[i] === true) return true;
  const codes = codesOf(line);
  if (codes.length) return codes.every((c) => order?.codesIn?.[c] === true);
  const loc = line?.source?.locationId;
  if (loc && loc !== PACKING_STORE) return false;
  return line?.source?.status === "handed";
}

export const incomingArrivalDone = (order) => {
  const a = order?.incoming?.arrival;
  if (!a || typeof a !== "object") return false;
  if (a.state != null) return a.state === "done";
  return typeof a.returnSaleId === "string" && a.returnSaleId !== "";
};
export const awaitingIncomingReturn = (order) => ((!!order?.incoming && typeof order.incoming === "object") || (!!order?.exchange && typeof order.exchange === "object")) && !incomingArrivalDone(order);

/** Jamie's record for line i when it is about the line as it stands (same product and size, not older than a swap). */
export function jamieRecord(order, i, line) {
  const all = order?.jimmyStatus;
  const r = all && typeof all === "object" ? all[i] ?? all[String(i)] : null;
  if (!r || typeof r !== "object") return null;
  if (r.pid && line?.pid && String(r.pid) !== String(line.pid)) return null;
  if (r.size != null && line?.size != null && String(r.size) !== String(line.size)) return null;
  const swapAt = line?.swappedFrom ? Math.max(num(line.swappedFrom.at), line.resolution?.outcome?.kind === "swap" ? num(line.resolution.outcome.at) : 0) : 0;
  if (swapAt > 0 && num(r.basisAt) < swapAt && num(r.updatedAt) < swapAt) return null;
  return r;
}
const markOf = (line, now) => {
  const a = line?.awaitingCustomer;
  if (!a || typeof a !== "object") return null;
  if (num(a.since) > 0 && now - num(a.since) > MARK_MAX_AGE_MS) return null;
  return a;
};
/** The customer said they will wait for this item (Jamie's "chose" record). */
export const choseToWait = (rec) => rec?.state === "chose" && (/when it arrives|wait/i.test(String(rec.next || "")) || /\bwait\b/i.test(String(rec.customerSaid?.text || "")));

/**
 * Places to skip when re-picking a failed line: the place that said it cannot produce it, unless stock reached it
 * since (an inbound movement on its cell after the failure, e.g. #2085's transfer into Marathon PE at 12:55).
 */
export function excludedPlaces(line, facts, failedAt) {
  const loc = line?.source?.locationId;
  if (!loc) return [];
  const cell = facts?.stockAt?.[loc];
  const restocked = cell && num(cell.qty) > 0 && num(cell.updatedAtMs) > num(failedAt) && /_in$|^arrival|^receive|^return|^adjust/.test(String(cell.lastType || ""));
  return restocked ? [] : [loc];
}
/** When the line's current failure can be dated (0 when unknown). */
export function failedAtOf(line, order) {
  const ts = [line?.source?.at, line?.source?.updatedAt, line?.unavailable?.at, line?.escalationStopped?.at];
  if (line?.source?.status === "needs_attention" && order?.attention?.kind === "walkin_override") ts.push(order.attention.at);
  for (const o of Object.values(order?.overrides || {})) if (o && String(o.productId) === String(line?.pid) && String(o.size) === String(line?.size)) ts.push(o.at);
  return Math.max(0, ...ts.map(num));
}
const firstFree = (free, exclude, isFootwear, qty) => {
  const route = isFootwear ? ["hub1", "hub2", "hub3"] : ["marathon-pe", "trophy", "hub2", "concrete", "marathon-pine"];
  return route.find((loc) => !exclude.includes(loc) && num(free?.[loc]) >= qty) || null;
};

/**
 * One line → { i, kind, prio, why, actions[] } or null when the line is fine (here, or off the parcel).
 *   facts  { free: {loc: n}, central: n, stockAt: {loc: {qty, updatedAtMs, lastType}}, sinceMs, shopifyRefund: {at, cents} | null }
 */
export function judgeLine(order, i, line, facts = {}, now = Date.now()) {
  const st = line?.source?.status ?? null;
  if (OFF_PARCEL.has(st)) return null;
  if (lineIsHere(order, i, line)) return null;
  const rec = jamieRecord(order, i, line);
  const mark = markOf(line, now);
  const title = line?.title || line?.pid || `Line ${i + 1}`;
  const out = (kind, prio, why, actions = []) => ({ i, kind, prio, why, title, actions });

  // 1 SETTLED — Shopify's own refund record for this line item.
  const refund = facts.shopifyRefund;
  if (refund && num(refund.at) > 0 && now - num(refund.at) >= SETTLE_AFTER_MS && !line.escalationOverride && order?.basket?.[i] !== true && st !== "handed") {
    const swapAt = line?.swappedFrom ? num(line.swappedFrom.at) : 0;
    const mixedHub = num(line.qty) > 1 && codesOf(line).length > 1;
    if (!(swapAt > 0 && num(refund.at) < swapAt) && !mixedHub && line.escalation?.phase !== "done") {
      return out("settled", PRIORITY.refund, "Refunded — closing the line", [{ type: "close_refund", i, evidence: { source: "shopify", lineItemId: gidTail(line.shopifyLineItemId), refundedAt: refund.at, cents: refund.cents } }]);
    }
  }
  if (rec && MONEY_STATES.has(String(rec.state))) return out("refund", PRIORITY.refund, rec.state === "credit_pending" ? "Store credit being processed" : "Refund being processed");

  // 3 MONEY — a dearer pick Jamie holds until its difference is paid.
  if (rec?.state === "awaiting_payment" && num(rec.diffCents) > 0) {
    return out("payment", PRIORITY.payment, `${rands(rec.diffCents)} difference unpaid`, [{ type: "chase", kind: "payment_link", i, evidence: { diffCents: num(rec.diffCents), jamieState: rec.state, linkAt: rec.linkAt || rec.told?.at || null } }]);
  }

  // 2 THE CUSTOMER — Jamie asked, the customer has not answered.
  if (mark || (rec && CUSTOMER_STATES.has(String(rec.state)))) {
    const toldAt = num(rec?.told?.at) || num(mark?.since);
    const saidAt = num(rec?.customerSaid?.at);
    const silent = toldAt > 0 && saidAt < toldAt ? now - toldAt : 0;
    const actions = [];
    const ev = { toldAt: toldAt || null, saidAt: saidAt || null, jamieState: rec?.state || null, what: mark?.what || null };
    if (silent >= NO_ANSWER_MS) actions.push({ type: "chase", kind: "no_answer_24h", i, evidence: ev });
    else if (silent >= FOLLOW_UP_AFTER_MS) actions.push({ type: "chase", kind: "follow_up", i, evidence: ev });
    const offered = Array.isArray(rec?.offered) && rec.offered.length > 0;
    return out("customer", PRIORITY.customer, offered || mark ? "Customer choosing alternative" : "Waiting for the customer's answer", actions);
  }

  const isFootwear = !!line.isFootwear;
  const qty = Math.max(1, num(line.qty) || 1);
  const freeAnywhere = (exclude) => firstFree(facts.free, exclude, isFootwear, qty);

  // The customer chose to wait for this very item: it goes on a pick the moment a place has it.
  if (rec && choseToWait(rec) && (st === "unavailable" || FAILED.has(st))) {
    const exclude = excludedPlaces(line, facts, failedAtOf(line, order));
    const to = line.pid ? freeAnywhere(exclude) : null;
    if (to) return out("finding", PRIORITY.finding, `Customer waiting — found at ${place(to)}, re-picking`, [{ type: "repick", i, exclude, to, evidence: { free: facts.free || {}, exclude, choseAt: rec.customerSaid?.at || null } }]);
    return out("wait_stock", PRIORITY.wait_stock, num(facts.central) > 0 ? "Customer waiting for stock (coming from Central)" : "Customer waiting for stock");
  }

  // 4/5 A PLACE COULD NOT PRODUCE IT.
  if (FAILED.has(st)) {
    const loc = line.source?.locationId || null;
    const failedAt = failedAtOf(line, order);
    const exclude = excludedPlaces(line, facts, failedAt);
    const walkin = st === "needs_attention" && order?.attention?.kind === "walkin_override";
    const head = walkin ? "Held item sold at the till" : st === "no_stock" && HUBS.has(loc) ? `${place(loc)} rejected` : loc ? `Not found at ${place(loc)}` : "Not in stock";
    const to = line.pid ? freeAnywhere(exclude) : null;
    if (to) return out("finding", PRIORITY.finding, `${head} — re-picking at ${place(to)}`, [{ type: "repick", i, exclude, to, evidence: { failed: { status: st, at: loc, since: failedAt || null }, free: facts.free || {}, exclude, restockedAt: exclude.length ? null : facts.stockAt?.[loc]?.updatedAtMs || null } }]);
    if (num(facts.central) > 0) return out("wait_stock", PRIORITY.wait_stock, `${head} — waiting on refill from Central`);
    // Genuinely unavailable: Jamie offers alternatives at once (unless the line is already his).
    const recent = failedAt > 0 && now - failedAt < JAMIE_GAP_MS;
    const actions = rec || recent ? [] : [{ type: "chase", kind: "alternatives_now", i, evidence: { failed: { status: st, at: loc, since: failedAt || null }, free: facts.free || {}, central: num(facts.central) } }];
    return out("nowhere", PRIORITY.nowhere, `${head} — not in stock anywhere, Jamie offering alternatives`, actions);
  }
  if (st === "unavailable") {
    if (num(facts.central) > 0 && !rec) return out("wait_stock", PRIORITY.wait_stock, "Waiting on refill from Central");
    const since = Math.max(num(line.unavailable?.at), num(line.source?.at));
    const actions = rec || (since > 0 && now - since < JAMIE_GAP_MS) ? [] : [{ type: "chase", kind: "alternatives_now", i, evidence: { status: st, free: facts.free || {}, central: num(facts.central) } }];
    return out("nowhere", PRIORITY.nowhere, "Not available — Jamie offering alternatives", actions);
  }
  if (st === "unresolved") return out("other", PRIORITY.other, "Item not linked to a product — Junid to fix", [{ type: "escalate", i, level: "unlinked", evidence: { reason: line.reason || null } }]);
  if (st === "reroute") return out("finding", PRIORITY.finding, "Being re-routed");
  if (st === "resolving") return out("other", PRIORITY.other, "Being sorted out");

  // STILL AT A PLACE (pick / display open there), or ON ITS WAY to PE.
  const loc = line.source?.locationId || null;
  if (st === "pick" || st === "display") {
    const since = num(facts.sinceMs) || num(line.repick?.appliedAt) || num(order?.ingestedAt);
    const th = since > 0 ? tradingHoursBetween(since, now) : 0;
    const actions = [];
    const ev = { at: loc, status: st, since: since || null, tradingHours: Math.round(th * 10) / 10, entry: line.source?.entryKey || null };
    if (th >= ESCALATE_AFTER_TH) actions.push({ type: "escalate", i, level: "4h", evidence: ev });
    else if (th >= NUDGE_AFTER_TH) actions.push({ type: "nudge", i, location: loc, evidence: ev });
    return out("at_place", PRIORITY.at_place, `Waiting for ${place(loc)}`, actions);
  }
  if (st === "handed") {
    const since = num(line.source?.handedAt);
    const th = since > 0 ? tradingHoursBetween(since, now) : 0;
    const actions = th >= TRANSIT_ESCALATE_TH ? [{ type: "escalate", i, level: "transit", evidence: { from: loc, handedAt: since, tradingHours: Math.round(th * 10) / 10 } }] : [];
    return out("transit", PRIORITY.transit, `On its way from ${place(loc)}`, actions);
  }
  return out("other", PRIORITY.other, "Being sorted out");
}

/**
 * The whole order → { group, reason, lines: [judged…], actions: [...], here, total }.
 *   facts  { lines: { [i]: lineFacts } }
 */
export function judgeOrder(order, facts = {}, now = Date.now()) {
  const entries = linesOf(order).filter(([, l]) => !OFF_PARCEL.has(l?.source?.status ?? null));
  const total = entries.length;
  const judged = entries.map(([i, l]) => judgeLine(order, i, l, facts.lines?.[i] || {}, now)).filter(Boolean);
  const here = total - judged.length;
  const actions = judged.flatMap((j) => j.actions);
  if (awaitingIncomingReturn(order)) return { group: "incoming", reason: "Waiting for the customer's return", lines: judged, actions: actions.filter((a) => a.type === "close_refund"), here, total };
  if (total === 0) return { group: "red", reason: "Nothing left to ship — closing", lines: [], actions: [], here: 0, total: 0 };
  if (!judged.length) return { group: "green", reason: null, lines: [], actions: [], here, total };
  const sorted = [...judged].sort((a, b) => a.prio - b.prio || a.i - b.i);
  const top = sorted[0];
  const reason = `${top.why}${judged.length > 1 ? ` (+${judged.length - 1} more)` : ""}`;
  return { group: "red", reason, lines: sorted, actions, here, total };
}
