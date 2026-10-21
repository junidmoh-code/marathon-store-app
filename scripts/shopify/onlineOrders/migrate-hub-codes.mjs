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
import { ONLINE_ORDERS_PATH, HOLDING_STATUSES } from "../../../src/utils/onlineOrders.js";
import { migrateOrder } from "./hubCodeMigration.mjs";
import { serverNowMs } from "../publishNode.mjs";

const COMMIT = process.argv.includes("--commit");
const fnRequire = createRequire(new URL("../../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const now = await serverNowMs(db);
const say = (s) => console.log(`${COMMIT ? "" : "[dry] "}${s}`);

for (const status of HOLDING_STATUSES) {
  const found = (await db.ref(ONLINE_ORDERS_PATH).orderByChild("status").equalTo(status).get()).val() || {};
  for (const [id, order] of Object.entries(found)) await migrateOrder(db, id, order, { nowMs: now, commit: COMMIT, say });
}
process.exit(0);
