// ── The order agent: one run (Junid's brief, 14 Nov 2026) ──────────────────
// Every open website order (indexed status queries, never a whole node) is judged (judge.mjs) and each red one is
// pushed one step toward "ready to pack":
//   close_refund  → escalationOverride "resolved" on the line (the store app's own Settings path; the poller cancels
//                   the pick and hold). Only on Shopify's refund record for that line item.
//   repick        → /online_orders/{id}/agentRepicks/{rid} (the poller applies it: agentRepick.mjs)
//   chase         → a row in Jamie's jamie_chase_requests (Jamie follows up / sends the link / offers alternatives
//                   through its own paced paths; the row's id makes it once per order line per SAST day)
//   nudge         → a web push to the hub's assigned staff (push_hub_audience, mute veto); shops have no audience,
//                   which is logged
//   escalate      → one Jamie-app case to Junid (a chase row of kind junid_escalation)
// Every order it checked gets `agent` {at, group, reason, actions, note} (the POS card's "last run" line), every
// action a log row with its evidence under online_order_agent/log/{day}. At the first run from 18:00 the day's summary
// goes to Junid in the Jamie app.
//
// NEVER: a stock or refill request created, changed or cancelled; a policy value read or written; a stock movement.
import { judgeOrder, linesOf, lineIsHere, PLACE } from "./judge.mjs";
import { dayKey, hhmm, sast, SUMMARY_HOUR } from "./hours.mjs";

export const AGENT_ROOT = "online_order_agent";
export const OPEN_STATUSES = Object.freeze(["new", "picking", "ready", "needs_attention"]);
export const ROUTED = Object.freeze(["hub1", "hub2", "hub3", "marathon-pe", "trophy", "concrete", "marathon-pine"]);
const OFF_PARCEL = new Set(["resolved", "moved", "cancelled"]);
const place = (loc) => PLACE[loc] || loc;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clean = (v) => JSON.parse(JSON.stringify(v ?? null));
const labelOf = (o, id) => o?.shopifyName || (o?.orderNumber ? `#${o.orderNumber}` : String(id));
const safeKey = (s) => String(s).replace(/[.#$/[\]]/g, "_");

async function get(db, path) { const s = await db.ref(path).get(); return s.val(); }

/** Open orders through the status index, one query per status. */
export async function readOpenOrders(db) {
  const out = {};
  for (const st of OPEN_STATUSES) {
    const snap = await db.ref("online_orders").orderByChild("status").equalTo(st).get();
    for (const [k, v] of Object.entries(snap.val() || {})) if (v && typeof v === "object") out[k] = v;
  }
  return out;
}

const stockKey = (line) => (line?.sizeKey != null ? String(line.sizeKey) : null);

/** Free units at each routed place for one line (cells minus OTHER website orders' holds minus this order's other lines). */
async function lineFacts(db, id, order, i, line) {
  const facts = { free: {}, stockAt: {}, central: 0, sinceMs: 0 };
  const sk = stockKey(line);
  if (line?.pid && sk != null) {
    const holds = (await get(db, `online_reservations/${line.pid}/${sk}`)) || {};
    for (const loc of ROUTED) {
      const cell = await get(db, `stock/${loc}/${line.pid}/${sk}`);
      const qty = num(cell?.qty);
      let held = 0;
      for (const [oid, row] of Object.entries(holds)) if (oid !== String(id) && row && typeof row === "object") held += num(row.locs?.[loc]);
      facts.free[loc] = Math.max(0, qty - held);
      if (cell) facts.stockAt[loc] = { qty, updatedAtMs: Date.parse(cell.updatedAt) || num(cell.updatedAt), lastType: cell.lastType || null };
    }
    // This order's other lines of the same item already take units where they are routed.
    for (const [k, l] of linesOf(order)) {
      if (k === i || l?.pid !== line.pid || String(l?.sizeKey) !== sk || !l.source?.locationId) continue;
      if (!["pick", "display", "handed"].includes(l.source.status)) continue;
      facts.free[l.source.locationId] = Math.max(0, num(facts.free[l.source.locationId]) - num(l.qty || 1));
    }
    facts.central = num(await get(db, `stock/central/${line.pid}/${sk}/qty`));
  }
  const st = line?.source?.status;
  if ((st === "pick" || st === "display") && line.source?.entryKey) {
    if (String(line.source.entryKey).startsWith("displayChecks_active/")) facts.sinceMs = num(await get(db, `${line.source.entryKey}/createdAt`));
    else if (String(line.source.entryKey).startsWith("orders/")) facts.sinceMs = Date.parse(await get(db, `${line.source.entryKey}/createdAt`)) || 0;
  }
  return facts;
}

const REFUNDS_Q = `query($id: ID!) { order(id: $id) { id cancelledAt displayFinancialStatus refunds { createdAt refundLineItems(first: 100) { nodes { quantity lineItem { id } subtotalSet { shopMoney { amount } } } } } } }`;
/** Shopify's refund records per line item: { [lineItemTail]: { at, cents, qty } }, plus cancelledAt. */
export async function shopifyRefunds(graphql, gid) {
  if (!graphql || !gid) return null;
  const data = await graphql(REFUNDS_Q, { id: gid });
  const o = data?.order;
  if (!o) return { missing: true, byLine: {} };
  const byLine = {};
  for (const r of o.refunds || []) {
    const at = Date.parse(r.createdAt) || 0;
    for (const n of r.refundLineItems?.nodes || []) {
      const k = String(n.lineItem?.id || "").split("/").pop();
      if (!k) continue;
      const prev = byLine[k] || { at: 0, cents: 0, qty: 0 };
      byLine[k] = { at: Math.max(prev.at, at), cents: prev.cents + Math.round(num(n.subtotalSet?.shopMoney?.amount) * 100), qty: prev.qty + num(n.quantity) };
    }
  }
  return { cancelledAt: o.cancelledAt || null, financial: o.displayFinancialStatus || null, byLine };
}

/** The note for the card: what the agent did this run, short. */
const actionWords = (a, res) => {
  if (a.type === "repick") return `re-pick at ${place(a.to)} asked`;
  if (a.type === "close_refund") return "refunded line closed";
  if (a.type === "nudge") return res?.sent ? `${place(a.location)} staff nudged` : `${place(a.location)} nudge not delivered (${res?.why || "no audience"})`;
  if (a.type === "escalate") return "Junid told";
  if (a.type === "chase") return { follow_up: "Jamie following up", no_answer_24h: "Jamie applying the 24 h rule", payment_link: "Jamie sending the payment link", alternatives_now: "Jamie offering alternatives" }[a.kind] || `Jamie: ${a.kind}`;
  return a.type;
};

/**
 * One run. deps: { db, graphql?, chase: { insert(row) → bool, todayCounts(day) → {...} }, push?: async ({hub, title, body, tag}) → {sent, why},
 *   now: number, commit: boolean, log }
 * → { runId, checked, green, red, incoming, actions: [...], summary? }
 */
export async function runOrderAgent(deps) {
  const { db, graphql = null, chase, push = null, now, commit = false, log = () => {} } = deps;
  const day = dayKey(now);
  const runId = `${day}T${hhmm(now).replace(":", "")}`;
  const orders = await readOpenOrders(db);
  const result = { runId, at: now, checked: 0, green: 0, red: 0, incoming: 0, actions: [], outcomes: [] };
  const logRows = [];
  const dayOrders = (await get(db, `${AGENT_ROOT}/days/${day}/orders`)) || {};

  for (const [id, order] of Object.entries(orders)) {
    result.checked++;
    const label = labelOf(order, id);
    const facts = { lines: {} };
    try {
      let refunds = null;
      const needy = linesOf(order).filter(([i, l]) => !OFF_PARCEL.has(l?.source?.status) && !lineIsHere(order, i, l));
      if (needy.length && graphql && order.shopifyGid) {
        try { refunds = await shopifyRefunds(graphql, order.shopifyGid); } catch (e) { log(`  ! ${label}: Shopify read failed — ${String(e?.message || e).slice(0, 120)}`); }
      }
      for (const [i, l] of needy) {
        facts.lines[i] = await lineFacts(db, id, order, i, l);
        const tail = String(l.shopifyLineItemId || "").split("/").pop();
        const r = refunds?.byLine?.[tail];
        if (r && r.qty >= num(l.qty || 1)) facts.lines[i].shopifyRefund = { at: r.at, cents: r.cents };
      }
      const verdict = judgeOrder(order, facts, now);
      result[verdict.group] = (result[verdict.group] || 0) + 1;
      if (refunds?.cancelledAt) verdict.lines.push({ i: -1, why: "Cancelled on Shopify — the poller closes it" });

      const marks = (await get(db, `${AGENT_ROOT}/marks/${id}`)) || {};
      const done = [];
      for (const a of bundle(verdict.actions, order)) {
        const line = linesOf(order).find(([k]) => k === a.i)?.[1];
        const rg = num(line?.routeGen);
        const res = await act({ db, chase, push, commit, now, day, id, order, label, line, a, rg, marks, log });
        if (!res || res.skipped) continue;
        done.push(actionWords(a, res));
        result.actions.push({ order: label, id, ...a, result: res });
        logRows.push(clean({ at: now, run: runId, order: label, id, line: a.i, type: a.type, kind: a.kind || null, to: a.to || a.location || null, result: res, evidence: a.evidence || null }));
      }
      const note = done.length ? done.join(" · ") : null;
      const stamp = clean({ at: now, run: runId, group: verdict.group, reason: verdict.reason, actions: done, note, here: verdict.here, total: verdict.total });
      const prev = dayOrders[id] || {};
      const dayRow = clean({
        label, firstSeenAt: prev.firstSeenAt || now, firstGroup: prev.firstGroup || verdict.group, group: verdict.group, reason: verdict.reason,
        greenAt: verdict.group === "green" ? prev.greenAt || (prev.group && prev.group !== "green" ? now : null) : null,
        wasRed: prev.wasRed || verdict.group === "red",
      });
      if (commit) {
        await db.ref(`online_orders/${id}/agent`).set(stamp);
        await db.ref(`${AGENT_ROOT}/days/${day}/orders/${id}`).set(dayRow);
      }
      dayOrders[id] = dayRow;
      result.outcomes.push({ id, label, group: verdict.group, reason: verdict.reason, did: done, lines: verdict.lines.map((j) => ({ i: j.i, why: j.why })) });
      log(`  ${verdict.group === "green" ? "✓" : verdict.group === "incoming" ? "⏱" : "✗"} ${label}: ${verdict.reason || `all ${verdict.total} here`}${note ? ` → ${note}` : ""}`);
    } catch (e) {
      log(`  ! ${label}: ${String(e?.message || e)}`);
      result.outcomes.push({ id, label, group: "error", reason: String(e?.message || e).slice(0, 200), did: [] });
    }
  }

  // Orders seen earlier today that are no longer open: packed (shipped), cancelled or closed.
  for (const [id, row] of Object.entries(dayOrders)) {
    if (orders[id] || row.endedAs) continue;
    const st = await get(db, `online_orders/${id}/status`);
    const endedAs = st === "packed" ? "shipped" : st || "gone";
    row.endedAs = endedAs;
    if (commit) await db.ref(`${AGENT_ROOT}/days/${day}/orders/${id}/endedAs`).set(endedAs);
  }

  if (commit) {
    for (const row of logRows) await db.ref(`${AGENT_ROOT}/log/${day}`).push().set(row);
    await db.ref(`${AGENT_ROOT}/lastRun`).set(clean({ at: now, run: runId, checked: result.checked, green: result.green, red: result.red, incoming: result.incoming, actions: result.actions.length }));
  }

  // The day's summary to Junid, once, at the first run from 18:00.
  if (sast(now).hour >= SUMMARY_HOUR) {
    const sent = await get(db, `${AGENT_ROOT}/days/${day}/summarySentAt`);
    if (!sent) {
      const text = summaryText({ day, dayOrders, orders, outcomes: result.outcomes, counts: chase?.todayCounts ? chase.todayCounts(day) : null, logToday: await get(db, `${AGENT_ROOT}/counts/${day}`) });
      result.summary = text;
      if (commit) {
        const ok = chase.insert({ id: `daily_summary:-:-:${day}`, at: now, kind: "daily_summary", order_key: "-", order_number: null, line_index: null, reason: text, evidence: JSON.stringify({ day }) });
        if (ok) await db.ref(`${AGENT_ROOT}/days/${day}/summarySentAt`).set(now);
      }
    }
  }
  if (commit && result.actions.length) {
    const tally = {};
    for (const a of result.actions) { const k = a.type === "chase" ? `chase_${a.kind}` : a.type; tally[k] = (tally[k] || 0) + 1; }
    const upd = {};
    for (const [k, n] of Object.entries(tally)) upd[`${AGENT_ROOT}/counts/${day}/${k}`] = { ".sv": { increment: n } };
    await db.ref().update(upd);
  }
  return result;
}

/** Nudges grouped per place, escalations into one per order; every other action as it is. PURE. */
export function bundle(actions, order) {
  const lineOf = (i) => linesOf(order).find(([k]) => k === i)?.[1];
  const item = (a) => ({ i: a.i, rg: num(lineOf(a.i)?.routeGen), line: lineOf(a.i), level: a.level || "4h", evidence: a.evidence || {} });
  const out = [];
  const nudges = new Map();
  let esc = null;
  for (const a of actions) {
    if (a.type === "nudge") {
      if (!nudges.has(a.location)) { const n = { type: "nudge", location: a.location, i: a.i, items: [] }; nudges.set(a.location, n); out.push(n); }
      nudges.get(a.location).items.push(item(a));
    } else if (a.type === "escalate") {
      if (!esc) { esc = { type: "escalate", i: a.i, items: [] }; out.push(esc); }
      esc.items.push(item(a));
    } else out.push(a);
  }
  for (const n of out) if (n.items) n.evidence = n.items.map((it) => ({ line: it.i, ...it.evidence }));
  return out;
}

/** Perform one action (or, on a dry run, say what would be done). → { ...outcome } | { skipped } */
async function act({ db, chase, push, commit, now, day, id, order, label, line, a, rg, marks, log }) {
  const markKey = (k) => safeKey(`${k}_${a.i}_${rg}`);
  const mark = async (k) => { if (commit) await db.ref(`${AGENT_ROOT}/marks/${id}/${markKey(k)}`).set({ at: now, day }); };
  if (a.type === "repick") {
    const open = Object.values(order.agentRepicks || {}).some((r) => r && Number(r.lineIndex) === a.i && (r.state === "pending" || r.state === "applying"));
    if (open) return { skipped: true };
    // One try an hour per line and route generation: a refused / not-in-stock answer is asked again next hour.
    const rid = safeKey(`${a.i}_${rg}_${Math.floor(now / 3600e3)}`);
    if (order.agentRepicks?.[rid]) return { skipped: true };
    const req = clean({ lineIndex: a.i, expectPid: line?.pid, expectSizeKey: line?.sizeKey, expectStatus: line?.source?.status, expectRouteGen: rg, exclude: a.exclude || [], by: "order-agent", at: now, state: "pending", evidence: a.evidence });
    if (commit) {
      const res = await db.ref(`online_orders/${id}/agentRepicks/${rid}`).transaction((cur) => (cur == null ? req : undefined));
      if (!res.committed) return { skipped: true };
    }
    return { asked: rid, to: a.to };
  }
  if (a.type === "close_refund") {
    if (line?.escalationOverride) return { skipped: true };
    const path = `online_orders/${id}/lines/${a.i}`;
    if (commit) {
      const res = await db.ref(path).transaction((cur) => {
        if (cur == null) return null;
        if (cur.escalationOverride || OFF_PARCEL.has(cur.source?.status) || cur.source?.status === "handed") return undefined;
        return { ...cur, escalationOverride: { kind: "resolved", by: "order-agent", at: now, why: `refunded R${Math.round(num(a.evidence?.cents) / 100)} (Shopify refund ${new Date(num(a.evidence?.refundedAt)).toISOString()})` }, resolution: { ...(cur.resolution || {}), outcome: { kind: "refund", amountCents: num(a.evidence?.cents), at: num(a.evidence?.refundedAt) || now, via: "order-agent", source: "shopify" } }, awaitingCustomer: null };
      });
      if (!res.committed) return { skipped: true };
    }
    return { closed: true };
  }
  if (a.type === "chase") {
    if (a.kind === "no_answer_24h" && marks[markKey("no_answer_24h")]) return { skipped: true };
    const row = { id: `${a.kind}:${id}:${a.i}:${day}`, at: now, kind: a.kind, order_key: String(id), order_number: String(order.orderNumber ?? label), line_index: a.i, reason: `${label} line ${a.i + 1} (${line?.title || line?.pid || "item"}${line?.size && line.size !== "_" ? ` ${line.size}` : ""})`, evidence: JSON.stringify(a.evidence || {}) };
    if (!commit) return { would: row.id };
    const inserted = chase.insert(row);
    if (!inserted) return { skipped: true };
    if (a.kind === "no_answer_24h") await mark("no_answer_24h");
    return { queued: row.id };
  }
  if (a.type === "nudge") {
    // One push per place per order: every line still waiting there, each nudged once per route generation.
    const due = (a.items || []).filter((it) => !marks[safeKey(`nudge_${it.i}_${it.rg}`)]);
    if (!due.length) return { skipped: true };
    const what = due.map((it) => `${it.line?.title || "an item"}${it.line?.size && it.line.size !== "_" ? ` (${it.line.size})` : ""}`).join(", ");
    const title = `${label}: ${due.length === 1 ? "an item" : `${due.length} items`} still to pick`;
    const body = `${place(a.location)} — website order ${label}: ${what}, waiting ${Math.max(...due.map((it) => num(it.evidence?.tradingHours)))} trading hours. Please pick and send to Marathon PE.`;
    let res = { sent: false, why: "dry run" };
    if (commit) {
      res = push ? await push({ hub: a.location, title, body, tag: `online-${id}-${a.location}` }).catch((e) => ({ sent: false, why: String(e?.message || e).slice(0, 120) })) : { sent: false, why: "no push sender" };
      for (const it of due) await db.ref(`${AGENT_ROOT}/marks/${id}/${safeKey(`nudge_${it.i}_${it.rg}`)}`).set({ at: now, day });
    }
    return { ...res, title, lines: due.map((it) => it.i) };
  }
  if (a.type === "escalate") {
    // One Jamie-app case per order per day, naming every line that needs Junid.
    const due = (a.items || []).filter((it) => !marks[safeKey(`escalate_${it.level}_${it.i}_${it.rg}`)]);
    if (!due.length) return { skipped: true };
    const part = (it) => {
      const where = place(it.evidence?.at);
      const item = `${it.line?.title || "an item"}${it.line?.size && it.line.size !== "_" ? ` size ${it.line.size}` : ""}`;
      return it.level === "unlinked" ? `a line is not linked to a product in the app (${it.evidence?.reason || "unknown"}); it cannot be picked until it is linked`
        : `${item} has waited ${it.evidence?.tradingHours} trading hours at ${where} (staff nudged at 2 h)`;
    };
    const words = `${label}: ${due.map(part).join("; ")}. Please chase it.`;
    const row = { id: `junid_escalation:${id}:-:${day}`, at: now, kind: "junid_escalation", order_key: String(id), order_number: String(order.orderNumber ?? label), line_index: null, reason: words, evidence: JSON.stringify(due.map((it) => ({ line: it.i, level: it.level, ...it.evidence }))) };
    if (!commit) return { would: row.id, words };
    const inserted = chase.insert(row);
    for (const it of due) await db.ref(`${AGENT_ROOT}/marks/${id}/${safeKey(`escalate_${it.level}_${it.i}_${it.rg}`)}`).set({ at: now, day });
    return inserted ? { queued: row.id, words, lines: due.map((it) => it.i) } : { skipped: true };
  }
  return { skipped: true };
}

/** The day's summary for Junid: turned green, shipped, chased, still red and why. */
export function summaryText({ day, dayOrders, orders, outcomes, counts, logToday }) {
  const rows = Object.values(dayOrders || {});
  const green = rows.filter((r) => r.greenAt || (r.wasRed && r.group === "green")).map((r) => r.label);
  const shipped = rows.filter((r) => r.endedAs === "shipped").map((r) => r.label);
  const reds = (outcomes || []).filter((o) => o.group === "red");
  const c = logToday || {};
  const n = (k) => num(c[k]);
  const chased = [
    n("chase_follow_up") && `${n("chase_follow_up")} customer follow-ups`,
    n("chase_no_answer_24h") && `${n("chase_no_answer_24h")} 24-hour rule`,
    n("chase_payment_link") && `${n("chase_payment_link")} payment links`,
    n("chase_alternatives_now") && `${n("chase_alternatives_now")} alternatives offered`,
    n("repick") && `${n("repick")} re-picks`,
    n("nudge") && `${n("nudge")} staff nudges`,
    n("escalate") && `${n("escalate")} sent to you`,
    n("close_refund") && `${n("close_refund")} refunded lines closed`,
  ].filter(Boolean);
  const lines = [`Website orders, ${day} (order agent)`];
  lines.push(`Turned green: ${green.length ? green.join(", ") : "none"}`);
  lines.push(`Shipped: ${shipped.length ? shipped.join(", ") : "none"}`);
  lines.push(`Chased: ${chased.length ? chased.join(", ") : "nothing needed"}`);
  if (counts && typeof counts === "object") {
    const parts = Object.entries(counts).filter(([, v]) => num(v) > 0).map(([k, v]) => `${v} ${k}`);
    if (parts.length) lines.push(`Jamie's hand-offs today: ${parts.join(", ")}`);
  }
  lines.push(`Still red (${reds.length}):${reds.length ? "" : " none"}`);
  for (const r of reds.slice(0, 25)) lines.push(`- ${r.label}: ${r.reason}`);
  if (reds.length > 25) lines.push(`- …and ${reds.length - 25} more`);
  return lines.join("\n");
}
