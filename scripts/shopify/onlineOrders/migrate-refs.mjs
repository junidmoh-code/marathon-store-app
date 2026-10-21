// ── One-off: give every OPEN order still carrying a WEB-#### ref its code ─────
// Orders pulled in before the three-letter codes (e.g. WEB-1768) get a code
// from the registry (orderRefs.mjs) and every place that copied the old ref is
// rewritten: the order's `ref`, its hold rows' `ref`, its display entries' `ref`.
// The Shopify number stays as `orderNumber`. Reads by indexed status query and
// exact paths only. Dry run unless --commit; idempotent (a coded order is skipped).
//
//   node scripts/shopify/onlineOrders/migrate-refs.mjs            (prints the plan)
//   node scripts/shopify/onlineOrders/migrate-refs.mjs --commit
import { fileURLToPath } from "node:url";
import { mintOrderRef } from "./orderRefs.mjs";
import { isOrderRefCode, ONLINE_ORDERS_PATH, ONLINE_RESERVATIONS_PATH } from "../../../src/utils/onlineOrders.js";
import { linesOf } from "./orderModel.mjs";

const OPEN = ["new", "picking", "ready", "needs_attention"];

export async function migrateRefs(db, { commit = false, now = Date.now(), log = console.log, rand } = {}) {
  const done = [];
  for (const status of OPEN) {
    const snap = await db.ref(ONLINE_ORDERS_PATH).orderByChild("status").equalTo(status).get();
    for (const [id, order] of Object.entries(snap.val() || {})) {
      if (!order || isOrderRefCode(order.ref)) continue;
      if (!commit) { log(`would recode ${order.ref} (order ${id})`); done.push({ id, from: order.ref, to: null }); continue; }
      const code = await mintOrderRef(db, id, now, rand ? { rand } : {});
      const updates = { [`${ONLINE_ORDERS_PATH}/${id}/ref`]: code, [`${ONLINE_ORDERS_PATH}/${id}/refMigratedFrom`]: order.ref };
      linesOf(order).forEach((l, i) => {
        // A hub line made before hub orders points at the retired /online_picks
        // feed: unlink it so the poller mints its /orders record (Fable review).
        if (typeof l?.source?.entryKey === "string" && l.source.entryKey.startsWith("online_picks/")) {
          updates[`${ONLINE_ORDERS_PATH}/${id}/lines/${i}/source/entryKey`] = null;
        }
      });
      for (const l of linesOf(order)) {
        if (l?.pid && l.sizeKey) {
          const hold = (await db.ref(`${ONLINE_RESERVATIONS_PATH}/${l.pid}/${l.sizeKey}/${id}`).get()).val();
          if (hold) updates[`${ONLINE_RESERVATIONS_PATH}/${l.pid}/${l.sizeKey}/${id}/ref`] = code;
        }
        const key = l?.source?.entryKey;
        if (key && key.startsWith("displayChecks_active/") && (await db.ref(key).get()).exists()) updates[`${key}/ref`] = code;
      }
      await db.ref().update(updates);
      log(`recoded ${order.ref} → ${code} (order ${id}, ${Object.keys(updates).length} paths)`);
      done.push({ id, from: order.ref, to: code });
    }
  }
  return done;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { adminDb } = await import("../../shipping/adminDb.mjs");
  const out = await migrateRefs(adminDb(), { commit: process.argv.includes("--commit") });
  console.log(`${out.length} order(s) ${process.argv.includes("--commit") ? "recoded" : "to recode (dry run)"}`);
  process.exit(0);
}
