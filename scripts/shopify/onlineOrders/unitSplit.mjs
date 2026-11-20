// ── One line = one unit, for orders already open (Junid, 20 Nov 2026) ───────
// New orders arrive one line per unit (orderModel buildItemLines). An order
// pulled in before that may still carry a line of qty N > 1. This splits it
// WITHOUT RE-INDEXING: line indexes are named everywhere (basket/{i},
// leftOut/{i}, packedLines/{i}, jimmyStatus/{i}, request maps' lineIndex, hub
// orders' onlineLineIndex, Jamie's rows), so
//   • line i stays where it is as unit 1, qty 1;
//   • units 2..N are APPENDED at the end of the lines array as qty-1 copies
//     (`splitFrom: i`, `unit`, `units`), same Shopify line item, same place;
//   • each unit takes its own hub order (orderKeys[k-1]); that /orders record
//     is re-pointed at the unit's new line index (onlineLineIndex) so the
//     poller, the re-pick and the swap read it as the unit's own;
//   • an open strip entry stays with unit 1 at qty 1; the other units get no
//     entry yet and the poller gives each its own on its next tick;
//   • money recorded on the line (ledger, resolution outcome, payments in) is
//     shared over the units so the units sum back to the line;
//   • per-line order maps (basket, packedLines, leftOut, jimmyStatus) are
//     copied to the new indexes.
// Holds need nothing: they are summed per pid/size from the lines, and the
// split units sum to the same quantity in the same places.
//
// A line that is mid-flight (an escalation, an open request, a customer being
// offered alternatives, a pack under way) is NOT split here: the plan names it
// and a person splits it once it settles. PURE except migrateOrderUnits.
import { linesOf, allocateCents } from "./orderModel.mjs";
import { ONLINE_ORDERS_PATH, HOLDING_STATUSES, LINE_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";

export const UNIT_SPLIT_VERSION = 1;
const REQUEST_MAPS = ["agentRepicks", "orderNowRequests", "unavailableRequests", "swapRequests"];
const SETTLED_REQUEST = new Set(["ordered", "refused", "committed", "done", "not_in_stock", "cancelled", "failed", "applied"]);
// Per-line maps on the order, keyed by line index.
const LINE_MAPS = ["basket", "packedLines", "leftOut"];

const qtyOf = (l) => Math.max(1, Math.floor(Number(l?.qty) || 1));
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const at = (map, i) => (Array.isArray(map) ? map[i] : map?.[i] ?? map?.[String(i)]);

/** Every `*Cents` number in `obj` (one level) shared over n units → [obj per unit]. */
export function splitCentsFields(obj, n) {
  const out = Array.from({ length: n }, () => ({ ...obj }));
  for (const [k, v] of Object.entries(obj || {})) {
    if (!/Cents$/.test(k) || typeof v !== "number") continue;
    allocateCents(v, n).forEach((c, u) => { out[u][k] = c; });
  }
  return out;
}

/** Why line i cannot be split by the script now, or null. */
export function splitBlocker(order, line, i) {
  if (order?.packClaim || order?.pack) return "a pack is under way";
  if (line?.escalation) return `escalation in progress (${line.escalation.phase || "?"})`;
  if (line?.awaitingCustomer) return `the customer is being asked (${line.awaitingCustomer.what || "a choice"})`;
  if (line?.orderNow) return "an Order-it-now is recorded on the line";
  if (line?.source?.status === LINE_STATUS.REROUTE) return "a re-route is pending (the poller splits it itself)";
  if (line?.source?.status === LINE_STATUS.RESOLVING) return "the line is climbing the escalation chain";
  // Jamie keys his offers by line index: a new unavailable line would start a second conversation.
  if (line?.source?.status === LINE_STATUS.UNAVAILABLE) return "unavailable — Jamie is handling it";
  for (const m of REQUEST_MAPS) {
    for (const [rid, r] of Object.entries(order?.[m] || {})) {
      if (r && Number(r.lineIndex) === i && !SETTLED_REQUEST.has(r.state)) return `${m}/${rid} is ${r.state || "open"}`;
    }
  }
  const keys = line?.source?.orderKeys;
  if (Array.isArray(keys) && keys.length && keys.length !== qtyOf(line)) return `${keys.length} hub order(s) for ${qtyOf(line)} units`;
  return null;
}

/**
 * The split of one order. PURE.
 *   order    the order as read
 *   nowMs    stamped on the marker
 * → { id-less plan }:
 *   { status: "done" | "nothing" | "closed" | "split" | "blocked",
 *     next,            the whole order after the split (status "split" only)
 *     appended: [{ from, index, unit, units }],
 *     hubRepoints: [{ key, from: i, index, unit }]  — /orders/{key} → onlineLineIndex index, onlineUnit 0
 *     stripEntries: [path]                          — open strip entries to set to qty 1
 *     blocked: [{ i, why }] }
 */
export function planUnitSplit(order, { nowMs = 0 } = {}) {
  const empty = { appended: [], hubRepoints: [], stripEntries: [], blocked: [] };
  if (!order) return { status: "nothing", ...empty };
  if (order.unitSplit?.v >= UNIT_SPLIT_VERSION) return { status: "done", ...empty };
  if (!HOLDING_STATUSES.includes(order.status)) return { status: "closed", ...empty };
  const lines = linesOf(order).map(clone);
  const many = lines.map((l, i) => (l && qtyOf(l) > 1 ? i : -1)).filter((i) => i >= 0);
  if (!many.length) return { status: "nothing", ...empty };
  const blocked = many.map((i) => ({ i, why: splitBlocker(order, lines[i], i) })).filter((b) => b.why);
  // All or nothing per order: a half-split order is harder to read than either.
  if (blocked.length) return { status: "blocked", ...empty, blocked };

  const next = clone(order);
  const nextLines = lines;
  const appended = [];
  const hubRepoints = [];
  const stripEntries = [];
  const maps = Object.fromEntries(LINE_MAPS.map((m) => [m, order[m] == null ? null : (Array.isArray(order[m]) ? [...order[m]] : { ...order[m] })]));
  let jimmy = order.jimmyStatus == null ? null : (Array.isArray(order.jimmyStatus) ? [...order.jimmyStatus] : { ...order.jimmyStatus });
  const put = (map, k, v) => { if (Array.isArray(map)) { while (map.length < k) map.push(null); map[k] = v; } else map[k] = v; };

  for (const i of many) {
    const line = lines[i];
    const n = qtyOf(line);
    const src = line.source || {};
    const keys = Array.isArray(src.orderKeys) && src.orderKeys.length === n ? src.orderKeys : null;
    const openStrip = typeof src.entryKey === "string" && src.entryKey.startsWith("displayChecks_active/")
      && (src.status === LINE_STATUS.DISPLAY);
    const ledgers = line.ledger ? splitCentsFields(line.ledger, n) : null;
    const outcomes = line.resolution?.outcome ? splitCentsFields(line.resolution.outcome, n) : null;
    const moneyIn = Object.entries(line.resolution?.moneyIn || {}).map(([k, m]) => [k, splitCentsFields(m, n)]);
    const swapHubs = Array.isArray(line.swappedFrom?.hubOrders) && line.swappedFrom.hubOrders.length === n ? line.swappedFrom.hubOrders : null;

    const unitLine = (u) => {
      const l = clone(line);
      l.qty = 1;
      l.unit = u + 1;
      l.units = n;
      if (ledgers) l.ledger = ledgers[u];
      if (outcomes) l.resolution.outcome = outcomes[u];
      for (const [k, parts] of moneyIn) l.resolution.moneyIn[k] = { ...parts[u], splitOfCents: line.resolution.moneyIn[k].amountCents };
      if (l.swappedFrom) {
        l.swappedFrom.qty = 1;
        if (swapHubs) l.swappedFrom.hubOrders = [swapHubs[u]];
        else if (u > 0) delete l.swappedFrom.hubOrders; // the old units' hub orders stay named on unit 1
      }
      if (keys) {
        l.source = { ...l.source, orderKeys: [keys[u]], entryKey: `orders/${keys[u]}` };
      } else if (openStrip && u > 0) {
        // No entry yet: the poller makes this unit its own (displayKey by its own index).
        const { entryKey, ...rest } = l.source;
        l.source = rest;
      }
      return l;
    };

    nextLines[i] = unitLine(0);
    if (openStrip) stripEntries.push(src.entryKey);
    for (let u = 1; u < n; u++) {
      const index = nextLines.length;
      const l = unitLine(u);
      l.splitFrom = i;
      l.lineId = `${line.lineId || `l${i}`}u${u + 1}`;
      nextLines.push(l);
      appended.push({ from: i, index, unit: u + 1, units: n });
      if (keys) hubRepoints.push({ key: keys[u], from: i, index, unit: u });
      for (const m of LINE_MAPS) if (maps[m] && at(maps[m], i) != null) put(maps[m], index, at(maps[m], i));
      if (jimmy && at(jimmy, i) != null) put(jimmy, index, { ...clone(at(jimmy, i)), ...(at(jimmy, i).line != null ? { line: index } : {}) });
    }
  }
  next.lines = nextLines;
  for (const m of LINE_MAPS) if (maps[m]) next[m] = maps[m];
  if (jimmy) next.jimmyStatus = jimmy;
  next.unitSplit = { v: UNIT_SPLIT_VERSION, at: nowMs, linesBefore: lines.length - appended.length, appended };
  return { status: "split", next, appended, hubRepoints, stripEntries, blocked: [] };
}

/** One line of the dry-run / apply report per change. */
export function describePlan(id, order, plan) {
  const label = `${orderLabel(order)} (${id})`;
  const L = linesOf(order);
  const what = (l) => `${l?.title || l?.pid}${l?.size && l.size !== "_" ? ` ${l.size}` : ""}`;
  switch (plan.status) {
    case "done": return [`${label}: already split (unitSplit v${order.unitSplit.v}) — nothing to do`];
    case "nothing": return [];
    case "closed": return [];
    case "blocked": return [`${label}: NOT SPLIT — ${plan.blocked.map((b) => `line ${b.i + 1} ${what(L[b.i])} ×${L[b.i]?.qty}: ${b.why}`).join("; ")}`];
    default: break;
  }
  const out = [`${label}: ${L.length} → ${plan.next.lines.length} lines`];
  const byFrom = new Map();
  for (const a of plan.appended) (byFrom.get(a.from) || byFrom.set(a.from, []).get(a.from)).push(a);
  for (const [from, list] of byFrom) {
    const l = L[from];
    const u1 = plan.next.lines[from];
    out.push(`  line ${from + 1} ${what(l)} ×${l.qty} [${l.source?.status}${l.source?.locationId ? ` @ ${l.source.locationId}` : ""}] → unit 1 stays line ${from + 1} (qty 1, R${(u1.unitPriceCents / 100).toFixed(2)}${u1.source?.orderKeys ? `, hub ${u1.source.orderKeys.join(",")}` : ""}${u1.ledger ? `, ledger paid ${u1.ledger.paidCents}` : ""})`);
    for (const a of list) {
      const nl = plan.next.lines[a.index];
      out.push(`    + line ${a.index + 1} = unit ${a.unit}/${a.units}: ${nl.source?.status}${nl.source?.locationId ? ` @ ${nl.source.locationId}` : ""}${nl.source?.orderKeys ? `, hub ${nl.source.orderKeys.join(",")}` : ""}${nl.source?.entryKey ? "" : nl.source?.status === LINE_STATUS.DISPLAY ? ", strip entry made by the next poll" : ""}${nl.ledger ? `, ledger paid ${nl.ledger.paidCents}` : ""}${nl.swappedFrom?.hubOrders ? `, swapped-from hub ${nl.swappedFrom.hubOrders.join(",")}` : ""}`);
    }
  }
  for (const r of plan.hubRepoints) out.push(`  orders/${r.key}: onlineLineIndex ${r.from} → ${r.index}, onlineUnit ${r.unit} → 0`);
  for (const p of plan.stripEntries) out.push(`  ${p}: qty → 1`);
  const copied = LINE_MAPS.concat("jimmyStatus").filter((m) => plan.appended.some((a) => at(order[m], a.from) != null));
  if (copied.length) out.push(`  copied to the new lines: ${copied.join(", ")}`);
  return out;
}

/**
 * Split ONE order (IO). The order is rewritten in one transaction that
 * re-plans against the server's copy (anything that moved meanwhile is
 * planned again, or blocks). Then the hub orders are re-pointed and the strip
 * entries set to qty 1 — each guarded, each idempotent, so a re-run finishes
 * a run that stopped half-way (the hub re-points are re-derived from the
 * marker). Transactions return null on the SDK's cold pass, never undefined.
 */
export async function migrateOrderUnits(db, id, order, { nowMs, apply = false, say = () => {} } = {}) {
  const plan = planUnitSplit(order, { nowMs });
  for (const s of describePlan(id, order, plan)) say(s);
  let repoints = plan.hubRepoints;
  let strips = plan.stripEntries;
  if (plan.status === "split" && apply) {
    let landed = null;
    const res = await db.ref(`${ONLINE_ORDERS_PATH}/${id}`).transaction((cur) => {
      if (cur == null) return null;
      const p = planUnitSplit(cur, { nowMs });
      if (p.status !== "split") return undefined;
      landed = p;
      return p.next;
    });
    if (!res.committed || !landed) { say(`  ✗ ${orderLabel(order)}: the order changed under the split — not written; run again`); return { status: "aborted" }; }
    repoints = landed.hubRepoints;
    strips = landed.stripEntries;
    say(`  ✓ order written`);
  } else if (plan.status === "done") {
    // Finish what an interrupted run left: every split unit's hub order points at its line.
    repoints = [];
    const L = linesOf(order);
    for (const a of order.unitSplit.appended || []) {
      const k = L[a.index]?.source?.orderKeys?.[0];
      if (k) repoints.push({ key: k, from: a.from, index: a.index, unit: a.unit - 1 });
    }
    strips = [];
  } else if (plan.status !== "split") {
    return { status: plan.status, blocked: plan.blocked };
  }
  if (!apply) return { status: plan.status, plan };
  for (const r of repoints) {
    const ref = db.ref(`orders/${r.key}`);
    const res = await ref.transaction((cur) => {
      if (cur == null) return null;
      if (cur.channel !== "online" || String(cur.onlineOrderId) !== String(id)) return undefined;
      if (Number(cur.onlineLineIndex) === r.index) return undefined; // already done
      if (Number(cur.onlineLineIndex) !== r.from) return undefined;
      return { ...cur, onlineLineIndex: r.index, onlineUnit: 0, splitFromLine: r.from, splitFromUnit: r.unit };
    });
    if (res.committed && res.snapshot.val()) say(`  ✓ orders/${r.key} → line ${r.index + 1}`);
  }
  for (const path of strips) {
    const res = await db.ref(path).transaction((cur) => {
      if (cur == null) return null;
      if (cur.status !== "open" || Number(cur.qty) === 1) return undefined;
      return { ...cur, qty: 1, saleCount: 1 };
    });
    if (res.committed && res.snapshot.val()) say(`  ✓ ${path} qty 1`);
  }
  return { status: plan.status === "done" ? "done" : "split", plan };
}
