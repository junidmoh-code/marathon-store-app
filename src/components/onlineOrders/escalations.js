// ─── SETTINGS → ONLINE ORDERS: the escalations list (pure) ───────────────────
// /online_escalations/{orderId}_{i} is the Mac mini's mirror of every line
// climbing the escalation chain or waiting on the customer agent
// (docs/ONLINE-ORDERS.md § Escalation, docs/ONLINE-CUSTOMER-AGENT.md). The
// list reads it; Junid's two escape hatches write ONE field on the order line,
// which the poller applies on its next tick (escalate.mjs):
//   "Mark unavailable now"  → the chain stops; the customer agent takes over
//   "Resolved by hand"      → the chain AND the agent stop; nothing more is sent
import { ONLINE_ORDERS_PATH } from "../../utils/onlineOrders";

const keySafe = (s) => typeof s === "string" && s.length > 0 && !/[.#$[\]/]/.test(s);

const AGENT_WORDS = {
  offering: "Customer offered alternatives — waiting for a reply",
  credited_window: "Store credit given — refund still possible",
  closed: "Closed",
};

/** Registry → rows, oldest-first by their next action time, then by ref. */
export function escalationRows(reg) {
  const rows = [];
  for (const [key, r] of Object.entries(reg || {})) {
    if (!r || typeof r !== "object" || !keySafe(r.orderId) || !Number.isInteger(Number(r.lineIndex))) continue;
    rows.push({
      key, orderId: r.orderId, lineIndex: Number(r.lineIndex), ref: r.ref || r.orderId,
      title: r.title || "Item", size: r.size && r.size !== "_" ? String(r.size) : null, qty: Number(r.qty) || 1,
      phase: r.phase || null, round: Number(r.round) || null,
      where: r.where || "—", next: r.next || "—", nextAt: Number.isFinite(Number(r.nextAt)) ? Number(r.nextAt) : null,
      agent: r.agent?.state ? (AGENT_WORDS[r.agent.state] || r.agent.state) : (r.phase === "unavailable" ? "Customer agent: starting" : null),
      canMarkUnavailable: r.phase !== "unavailable" && !r.agent?.state,
    });
  }
  return rows.sort((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || String(a.ref).localeCompare(String(b.ref)));
}

/** The ONE write of an escape hatch. kind: "unavailable" | "resolved". */
export function overrideUpdates(row, kind, uid, nowMs) {
  if (kind !== "unavailable" && kind !== "resolved") throw new Error("overrideUpdates: unknown kind");
  if (!keySafe(row?.orderId) || !Number.isInteger(row?.lineIndex) || row.lineIndex < 0) throw new Error("overrideUpdates: the row does not name its line");
  if (!keySafe(uid)) throw new Error("overrideUpdates: sign in first");
  if (!Number.isFinite(nowMs)) throw new Error("overrideUpdates: no time");
  return { [`${ONLINE_ORDERS_PATH}/${row.orderId}/lines/${row.lineIndex}/escalationOverride`]: { kind, by: uid, at: nowMs } };
}
