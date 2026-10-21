#!/usr/bin/env node
// ── One-off: open website orders → the per-unit hub code model ──────────────
// Owner decision 2026-10-21: an order is named by its Shopify number; every
// unit a hub sends has its OWN three-letter code as its /orders key. Orders
// pulled in before that (LEV, QGZ) have hub orders keyed by the old per-order
// code. For each open order this:
//   • re-keys each hub order unit to a fresh code (mintHubCode, the same
//     deterministic owner the poller uses, so the next tick adopts it): the
//     record is copied WITH its status (incoming / ready / …), then the old key
//     is removed — a website hub order never moved stock (dispatch skips it),
//     so the key is only a name;
//   • points the line at the new codes (one transaction, guarded on the old keys);
//   • stamps the Shopify number on its Website-orders strip entries.
// Holds pick up the new name on the next poll tick by themselves.
//
//   node scripts/shopify/onlineOrders/migrate-hub-codes.mjs            dry run
//   node scripts/shopify/onlineOrders/migrate-hub-codes.mjs --commit
import { createRequire } from "node:module";
import { ONLINE_ORDERS_PATH, HOLDING_STATUSES, LINE_STATUS, orderLabel } from "../../../src/utils/onlineOrders.js";
import { linesOf } from "./orderModel.mjs";
import { mintHubCode } from "./orderRefs.mjs";
import { serverNowMs } from "../publishNode.mjs";

const COMMIT = process.argv.includes("--commit");
const fnRequire = createRequire(new URL("../../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const now = await serverNowMs(db);
const say = (s) => console.log(`${COMMIT ? "" : "[dry] "}${s}`);

/** Pure: the plan for one order → { units: [{ i, u, gen, oldKey }], displays: [entryKey] }. */
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

for (const status of HOLDING_STATUSES) {
  const found = (await db.ref(ONLINE_ORDERS_PATH).orderByChild("status").equalTo(status).get()).val() || {};
  for (const [id, order] of Object.entries(found)) {
    const label = orderLabel(order);
    const { units, displays } = migrationPlan(order);
    say(`${order.ref ?? "?"} → ${label} (${id}): ${units.length} hub unit(s), ${displays.length} strip entr${displays.length === 1 ? "y" : "ies"}`);
    const newKeys = {}; // i → [codes]
    for (const { i, u, gen, oldKey } of units) {
      const rec = (await db.ref(`orders/${oldKey}`).get()).val();
      if (rec && Number.isInteger(rec.onlineUnit)) { (newKeys[i] ||= [])[u] = oldKey; say(`  line ${i + 1} unit ${u + 1}: ${oldKey} already a unit code`); continue; }
      if (!rec || rec.channel !== "online" || rec.onlineOrderId !== String(id)) { say(`  line ${i + 1} unit ${u + 1}: ${oldKey} is not this order's hub order — left alone`); continue; }
      const owner = `${id}:${i}:${u}:${gen}`;
      const code = COMMIT
        ? await mintHubCode(db, owner, now, { taken: async (c) => { const r = (await db.ref(`orders/${c}`).get()).val(); return !!r && !(r.onlineOrderId === String(id) && Number(r.onlineLineIndex) === i && Number(r.onlineUnit) === u); } })
        : `(new code for ${owner})`;
      say(`  line ${i + 1} unit ${u + 1}: ${oldKey} (${rec.status}, ${rec.hub}) → ${code}`);
      (newKeys[i] ||= [])[u] = code;
      if (!COMMIT) continue;
      const copy = { ...rec, id: code, onlineOrderNumber: order.orderNumber ?? null, onlineUnit: u, migratedFrom: oldKey, updatedAt: new Date(now).toISOString() };
      const res = await db.ref(`orders/${code}`).transaction((cur) => (cur == null ? copy : undefined));
      const there = res.snapshot.val();
      if (!res.committed && !(there && there.migratedFrom === oldKey)) throw new Error(`orders/${code} is taken`);
      await db.ref(`orders/${oldKey}`).transaction((cur) => (cur && cur.channel === "online" && cur.onlineOrderId === String(id) ? null : undefined));
    }
    if (COMMIT) {
      for (const [i, codes] of Object.entries(newKeys)) {
        const oldKeys = linesOf(order)[i].source.orderKeys;
        await db.ref(`${ONLINE_ORDERS_PATH}/${id}/lines/${i}/source`).transaction((cur) => {
          if (!cur || JSON.stringify(cur.orderKeys) !== JSON.stringify(oldKeys)) return undefined; // moved meanwhile
          return { ...cur, orderKeys: codes, entryKey: `orders/${codes[0]}` };
        });
      }
      for (const key of displays) {
        await db.ref(key).transaction((cur) => (cur ? { ...cur, orderNumber: order.orderNumber ?? null, ref: label } : undefined));
      }
    }
    for (const [i, l] of linesOf(order).entries()) if (l?.source?.status === LINE_STATUS.PICK && !newKeys[i]) say(`  line ${i + 1}: on a hub list with no hub order yet — the poller raises it with a unit code`);
  }
}
process.exit(0);
