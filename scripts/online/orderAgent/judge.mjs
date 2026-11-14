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
//                    staff after 2 trading hours, Junid after 4. On its way to PE: red, no action (the till confirms
//                    a unit only at the Pack today).
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
export const MARK_MAX_AGE_MS = 14 * 24 * H; // the POS's own bound on a customer-wait mark
export const MAX_REPICKS = 3; // re-picks per line before Junid decides

const OFF_PARCEL = new Set(["resolved", "moved", "cancelled"]);
const FAILED = new Set(["not_found", "no_stock", "needs_attention"]);
const CUSTOMER_STATES = new Set(["waiting_reply", "no_answer", "not_contacted", "unreachable", "told_late"]);
const MONEY_STATES = new Set(["refunded", "refund_pending", "credit_pending"]);
// Jamie's states that mean Jamie already has the line in hand (the POS's JAMIE_OWNS): no second hand-off.
const JAMIE_OWNS = new Set(["waiting_reply", "no_answer", "not_contacted", "told_late", "chose", "credit_pending", "refund_pending", "unreachable"]);
const owns = (rec) => !!rec && JAMIE_OWNS.has(String(rec.state));
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
export function excludedPlaces(line, facts, failedAt, { walkin = false } = {}) {
  // Every place that failed this line before (kept across re-picks by agentRepick.mjs: line.failedPlaces), plus the
  // one that failed now, so a re-pick never ping-pongs between two places that both said no (architect review).
  const failed = { ...(line?.failedPlaces && typeof line.failedPlaces === "object" ? line.failedPlaces : {}) };
  const loc = line?.source?.locationId;
  // A walk-in sale that took the held unit is not a place failing to find one: the cell already counts that sale,
  // so whatever it still shows is on the shelf (#2085).
  if (loc && !walkin) failed[loc] = Math.max(num(failed[loc]), num(failedAt));
  const out = [];
  for (const [where, at] of Object.entries(failed)) {
    const cell = facts?.stockAt?.[where];
    // Restocked only by a stock ARRIVAL after that place's own known failure time; an unknown failure time, an
    // adjustment (it can be downward) or a return never counts.
    const restocked = num(at) > 0 && cell && num(cell.qty) > 0 && num(cell.updatedAtMs) > num(at) && /^transfer_in$|^arrival|^receive/.test(String(cell.lastType || ""));
    if (!restocked) out.push(where);
  }
  return out;
}
/** When the line's current failure can be dated (0 when unknown). */
export function failedAtOf(line, order) {
  const ts = [line?.source?.at, line?.source?.updatedAt, line?.unavailable?.at, line?.escalationStopped?.at];
  if (line?.source?.status === "needs_attention" && order?.attention?.kind === "walkin_override") ts.push(order.attention.at);
  for (const o of Object.values(order?.overrides || {})) if (o && String(o.productId) === String(line?.pid) && String(o.size) === String(line?.size)) ts.push(o.at);
  return Math.max(0, ...ts.map(num));
}
/**
 * May the agent ask for a re-pick of this line now? → { ok } | { ok: false, why, escalate? }
 * The poller's last answer for this route generation is read back: refused / not in stock → no "re-picking" claim.
 */
export function repickAllowed(line, facts) {
  if (num(line?.repickCount) >= MAX_REPICKS) return { ok: false, why: `re-picked ${num(line.repickCount)} times`, escalate: "repicks" };
  const last = facts?.lastRepick;
  if (last && num(last.expectRouteGen) === num(line?.routeGen)) {
    if (last.state === "refused") return { ok: false, why: last.why || "refused", escalate: "refused" };
    if (last.state === "not_in_stock") return { ok: false, why: "no free unit after all" };
  }
  return { ok: true };
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
  const rec = jamieRecord(order, i, line);
  // Money the customer owes holds the parcel even when the item is in hand (the POS's red rule too).
  if (rec?.state === "awaiting_payment" && num(rec.diffCents) > 0 && lineIsHere(order, i, line)) {
    return { i, kind: "payment", prio: PRIORITY.payment, why: `${rands(rec.diffCents)} difference unpaid`, title: line?.title || line?.pid || `Line ${i + 1}`, status: st, central: 0, actions: [{ type: "chase", kind: "payment_link", i, evidence: { diffCents: num(rec.diffCents), jamieState: rec.state } }] };
  }
  if (lineIsHere(order, i, line)) return null;
  const mark = markOf(line, now);
  const title = line?.title || line?.pid || `Line ${i + 1}`;
  const out = (kind, prio, why, actions = []) => ({ i, kind, prio, why, title, actions, status: st, central: num(facts.central) });

  // 1 SETTLED — Shopify's own refund record for this line item.
  const refund = facts.shopifyRefund;
  if (refund && num(refund.at) > 0 && now - num(refund.at) >= SETTLE_AFTER_MS && !line.escalationOverride && !line.escalation?.request && !line.escalation?.pending && order?.basket?.[i] !== true && st !== "handed") {
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
    const gate = repickAllowed(line, facts);
    const to = line.pid && gate.ok ? freeAnywhere(exclude) : null;
    if (to) return out("finding", PRIORITY.finding, `Customer waiting — found at ${place(to)}, re-picking`, [{ type: "repick", i, exclude, to, evidence: { free: facts.free || {}, exclude, choseAt: rec.customerSaid?.at || null } }]);
    return out("wait_stock", PRIORITY.wait_stock, num(facts.central) > 0 ? "Customer waiting for stock (coming from Central)" : "Customer waiting for stock");
  }

  // 4/5 A PLACE COULD NOT PRODUCE IT.
  if (FAILED.has(st)) {
    const loc = line.source?.locationId || null;
    const failedAt = failedAtOf(line, order);
    const walkin = st === "needs_attention" && order?.attention?.kind === "walkin_override";
    const exclude = excludedPlaces(line, facts, failedAt, { walkin });
    const head = walkin ? "Held item sold at the till" : st === "no_stock" && HUBS.has(loc) ? `${place(loc)} rejected` : loc ? `Not found at ${place(loc)}` : "Not in stock";
    const gate = repickAllowed(line, facts);
    const to = line.pid && gate.ok ? freeAnywhere(exclude) : null;
    if (!gate.ok && gate.escalate && line.pid && freeAnywhere(exclude)) {
      return out("finding", PRIORITY.finding, `${head} — Junid deciding (${gate.why})`, [{ type: "escalate", i, level: gate.escalate, evidence: { at: loc, why: gate.why, free: facts.free || {}, exclude } }]);
    }
    if (to) return out("finding", PRIORITY.finding, `${head} — re-picking at ${place(to)}`, [{ type: "repick", i, exclude, to, evidence: { failed: { status: st, at: loc, since: failedAt || null }, free: facts.free || {}, exclude, restockedAt: exclude.length ? null : facts.stockAt?.[loc]?.updatedAtMs || null } }]);
    if (num(facts.central) > 0) return out("wait_stock", PRIORITY.wait_stock, `${head} — waiting on refill from Central`);
    // Genuinely unavailable: Jamie offers alternatives at once (unless the line is already his).
    const recent = failedAt > 0 && now - failedAt < JAMIE_GAP_MS;
    const actions = owns(rec) || recent ? [] : [{ type: "chase", kind: "alternatives_now", i, evidence: { failed: { status: st, at: loc, since: failedAt || null }, free: facts.free || {}, central: num(facts.central) } }];
    return out("nowhere", PRIORITY.nowhere, `${head} — not in stock anywhere, Jamie offering alternatives`, actions);
  }
  if (st === "unavailable") {
    if (num(facts.central) > 0 && !owns(rec)) return out("wait_stock", PRIORITY.wait_stock, "Waiting on refill from Central");
    const since = Math.max(num(line.unavailable?.at), num(line.source?.at));
    const actions = owns(rec) || (since > 0 && now - since < JAMIE_GAP_MS) ? [] : [{ type: "chase", kind: "alternatives_now", i, evidence: { status: st, free: facts.free || {}, central: num(facts.central) } }];
    return out("nowhere", PRIORITY.nowhere, "Not available — Jamie offering alternatives", actions);
  }
  if (st === "unresolved") return out("other", PRIORITY.other, "Item not linked to a product — Junid to fix", [{ type: "escalate", i, level: "unlinked", evidence: { reason: line.reason || null } }]);
  if (st === "reroute") return out("finding", PRIORITY.finding, "Being re-routed");
  if (st === "resolving") return out("other", PRIORITY.other, "Being sorted out");

  // STILL AT A PLACE (pick / display open there), or ON ITS WAY to PE.
  const loc = line.source?.locationId || null;
  if (st === "pick" || st === "display") {
    const since = num(facts.sinceMs) || num(line.repick?.appliedAt) || num(order?.ingestedAt);
    const th = since > 0 ? tradingHoursBetween(since, now, loc) : 0;
    const actions = [];
    const ev = { at: loc, status: st, since: since || null, tradingHours: Math.round(th * 10) / 10, entry: line.source?.entryKey || null };
    if (th >= ESCALATE_AFTER_TH) actions.push({ type: "escalate", i, level: "4h", evidence: ev });
    else if (th >= NUDGE_AFTER_TH) actions.push({ type: "nudge", i, location: loc, evidence: ev });
    return out("at_place", PRIORITY.at_place, `Waiting for ${place(loc)}`, actions);
  }
  // Released by the place, not confirmed in at Marathon PE yet. Today the till confirms a unit only when the packer
  // scans it at the Pack, so this is not a fault on its own: no action; the day's summary lists the ones waiting.
  if (st === "handed") return out("transit", PRIORITY.transit, `On its way from ${place(loc)}`);
  return out("other", PRIORITY.other, "Being sorted out");
}

// ── THE COLOURS (Junid's final decision, 14 Nov 2026) ─────────────────────────────────────────────────────────
// RED only when (a) an item is genuinely unavailable (a place rejected it / could not find it, or it is unavailable
// everywhere) or (b) the customer owes us money (a dearer pick's difference unpaid). Everything else is GREEN —
// waiting for items, released or on its way from a hub or shop, a balance WE owe the customer — with "X of Y here".
const UNAVAILABLE_STATUS = new Set(["not_found", "no_stock", "needs_attention", "unavailable", "resolving", "unresolved"]);
// Stock at Central that the refill scan brings is WAITING FOR ITEMS (green), not unavailable (architect review).
export const isRedLine = (j) => j.kind === "payment" || (UNAVAILABLE_STATUS.has(String(j.status)) && !(j.kind === "wait_stock" && j.central > 0));
/** A red line's few plain words: "R100 difference unpaid", "Item unavailable — Jamie offering alternatives". */
export function redWords(j) {
  if (j.kind === "payment") return j.why;
  const tail = {
    customer: "Jamie offering alternatives",
    nowhere: "Jamie offering alternatives",
    refund: "refund being closed",
    settled: "refund being closed",
  }[j.kind];
  if (tail) return `Item unavailable — ${tail}`;
  if (j.kind === "finding") {
    const m = String(j.why).match(/re-picking at (.+)$/);
    if (m) return `Item unavailable — re-picking at ${m[1]}`;
    if (/Junid deciding/.test(j.why)) return "Item unavailable — Junid deciding";
    return "Item unavailable — finding stock";
  }
  if (j.kind === "wait_stock") return /Customer waiting/.test(j.why) ? "Item unavailable — customer waiting for stock" : "Item unavailable — waiting on refill";
  if (String(j.status) === "unresolved") return "Item unavailable — not linked to a product";
  return "Item unavailable — being sorted out";
}

/**
 * The whole order → { group, reason, detail, lines: [judged…], actions: [...], here, total }.
 *   facts  { lines: { [i]: lineFacts } }
 */
export function judgeOrder(order, facts = {}, now = Date.now()) {
  const entries = linesOf(order).filter(([, l]) => !OFF_PARCEL.has(l?.source?.status ?? null));
  const total = entries.length;
  const judged = entries.map(([i, l]) => judgeLine(order, i, l, facts.lines?.[i] || {}, now)).filter(Boolean);
  const here = total - judged.length;
  const actions = judged.flatMap((j) => j.actions);
  const detail = total > 0 && here < total ? `${here} of ${total} here` : null;
  if (awaitingIncomingReturn(order)) return { group: "incoming", reason: "Waiting for the customer's return", detail, lines: judged, actions: actions.filter((a) => a.type === "close_refund"), here, total };
  if (total === 0) return { group: "green", reason: null, detail: "Nothing left to ship — closing", lines: [], actions: [], here: 0, total: 0 };
  const red = judged.filter(isRedLine).sort((a, b) => a.prio - b.prio || a.i - b.i);
  if (!red.length) {
    // Green, still with what is not here yet in the agent's own words for the log (the card shows "X of Y here").
    const sorted = [...judged].sort((a, b) => a.prio - b.prio || a.i - b.i);
    return { group: "green", reason: null, detail, lines: sorted, actions, here, total };
  }
  const reason = `${redWords(red[0])}${red.length > 1 ? ` (+${red.length - 1} more)` : ""}`;
  const others = judged.filter((j) => !isRedLine(j)).sort((a, b) => a.prio - b.prio || a.i - b.i);
  return { group: "red", reason, detail, lines: [...red, ...others], actions, here, total };
}
