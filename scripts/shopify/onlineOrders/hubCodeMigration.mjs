// ── The pure half of migrate-hub-codes.mjs (tested; the script only does IO) ──
import { linesOf } from "./orderModel.mjs";
import { mintHubCode } from "./orderRefs.mjs";
import { ONLINE_ORDERS_PATH, LINE_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";

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

/**
 * Migrate ONE open order (IO; `db` is the Admin SDK or the fake). Every
 * transaction returns null on the COLD pass (the SDK first runs it against an
 * empty local cache — returning undefined there aborts it before it ever sees
 * the server; CodeRabbit, PR #779). → { moved: [[oldKey, code]], kept: [oldKey], displays }
 */
export async function migrateOrder(db, id, order, { nowMs, commit = false, say = () => {} } = {}) {
  const label = orderLabel(order);
  const { units, displays } = migrationPlan(order);
  const out = { moved: [], kept: [], displays: 0 };
  say(`${order.ref ?? "?"} → ${label} (${id}): ${units.length} hub unit(s), ${displays.length} strip entr${displays.length === 1 ? "y" : "ies"}`);
  const newKeys = {};
  for (const { i, u, gen, oldKey } of units) {
    const rec = (await db.ref(`orders/${oldKey}`).get()).val();
    if (rec && Number.isInteger(rec.onlineUnit)) { say(`  line ${i + 1} unit ${u + 1}: ${oldKey} already a unit code`); continue; }
    if (!rec || rec.channel !== "online" || rec.onlineOrderId !== String(id)) { out.kept.push(oldKey); say(`  line ${i + 1} unit ${u + 1}: ${oldKey} is not this order's hub order — left alone`); continue; }
    const owner = `${id}:${i}:${u}:${gen}`;
    if (!commit) { say(`  line ${i + 1} unit ${u + 1}: ${oldKey} (${rec.status}, ${rec.hub}) → (new code for ${owner})`); continue; }
    const code = await mintHubCode(db, owner, nowMs, { taken: async (c) => { const r = (await db.ref(`orders/${c}`).get()).val(); return !!r && !(r.onlineOrderId === String(id) && Number(r.onlineLineIndex) === i && Number(r.onlineUnit) === u); } });
    say(`  line ${i + 1} unit ${u + 1}: ${oldKey} (${rec.status}, ${rec.hub}) → ${code}`);
    const copy = { ...rec, id: code, onlineOrderNumber: order.orderNumber ?? null, onlineUnit: u, migratedFrom: oldKey, updatedAt: new Date(nowMs).toISOString() };
    const res = await db.ref(`orders/${code}`).transaction((cur) => (cur == null ? copy : (cur.migratedFrom === oldKey ? cur : undefined)));
    const there = res.snapshot.val();
    if (!(there && there.migratedFrom === oldKey)) throw new Error(`orders/${code} is taken`);
    // Removed only if it is STILL what was copied — a hub "sent" / "out of
    // stock" landing meanwhile keeps the old record (and is reported).
    let changed = false;
    await db.ref(`orders/${oldKey}`).transaction((cur) => {
      if (cur == null) return null; // cold pass (or already gone)
      if (oldStillMatches(cur, rec, id)) { changed = false; return null; }
      changed = true;
      return undefined;
    });
    if (changed) {
      await db.ref(`orders/${code}`).set(null);
      out.kept.push(oldKey);
      say(`  ! ${oldKey} changed while being moved — kept as it is; re-run the migration`);
      continue;
    }
    (newKeys[i] ||= [])[u] = code;
    out.moved.push([oldKey, code]);
  }
  if (!commit) return out;
  for (const [i, moved] of Object.entries(newKeys)) {
    const oldKeys = linesOf(order)[i].source.orderKeys;
    await db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines/${i}/source`).transaction((cur) => {
      if (cur == null) return null; // cold pass
      if (JSON.stringify(cur.orderKeys) !== JSON.stringify(oldKeys)) return undefined; // moved meanwhile
      return { ...cur, ...nextPointer(oldKeys, moved) };
    });
  }
  for (const key of displays) {
    await db.ref(key).transaction((cur) => (cur == null ? null : { ...cur, orderNumber: order.orderNumber ?? null, ref: label }));
    out.displays++;
  }
  for (const [i, l] of linesOf(order).entries()) if (l?.source?.status === LINE_STATUS.PICK && !newKeys[i] && !(l.source.orderKeys || []).length) say(`  line ${i + 1}: on a hub list with no hub order yet — the poller raises it with a unit code`);
  return out;
}
