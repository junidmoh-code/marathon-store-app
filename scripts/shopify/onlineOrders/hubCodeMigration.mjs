// ── The pure half of migrate-hub-codes.mjs (tested; the script only does IO) ──
import { linesOf } from "./orderModel.mjs";

/** Every hub unit and strip entry an open order has → { units: [{ i, u, gen, oldKey }], displays: [entryKey] }. */
export function migrationPlan(order) {
  const units = [];
  const displays = [];
  linesOf(order).forEach((l, i) => {
    const keys = Array.isArray(l?.source?.orderKeys) ? l.source.orderKeys : [];
    keys.forEach((k, u) => units.push({ i, u, gen: Number(l.routeGen) || 0, oldKey: k }));
    if (typeof l?.source?.entryKey === "string" && l.source.entryKey.startsWith("displayChecks_active/")) displays.push(l.source.entryKey);
  });
  return { units, displays };
}

/**
 * The line's new pointer: every unit keeps its OLD key unless it was moved
 * (a unit the migration skipped stays reachable). → { orderKeys, entryKey }.
 */
export function nextPointer(oldKeys, moved) {
  const orderKeys = (oldKeys || []).map((k, u) => moved?.[u] || k);
  return { orderKeys, entryKey: `orders/${orderKeys[0]}` };
}

/** Pure: may the old hub order be removed? Only if it still is what was copied (status unchanged, still ours). */
export function oldStillMatches(cur, copied, orderId) {
  return !!cur && cur.channel === "online" && cur.onlineOrderId === String(orderId) && cur.status === copied.status && (cur.sentSize ?? null) === (copied.sentSize ?? null);
}
