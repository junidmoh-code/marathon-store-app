#!/usr/bin/env node
// ── One-off: open website orders → one line per unit (Junid, 20 Nov 2026) ───
// Every open order (new / picking / ready / needs_attention) with a line of
// qty > 1 gets that line split into qty-1 lines WITHOUT re-indexing: unit 1
// stays line i, units 2..N are appended (unitSplit.mjs says exactly what moves
// and what is refused). Idempotent: a split order carries `unitSplit`, and a
// re-run only finishes the hub-order re-points an interrupted run left.
//
//   node scripts/shopify/onlineOrders/migrate-split-units.mjs                 dry run (default)
//   node scripts/shopify/onlineOrders/migrate-split-units.mjs --apply         write
//   … --order=<key>                                                          one order only
//
// Firebase Admin through Application Default Credentials, as migrate-hub-codes.mjs.
import { createRequire } from "node:module";
import { ONLINE_ORDERS_PATH, HOLDING_STATUSES } from "../../../src/utils/onlineOrders.js";
import { migrateOrderUnits } from "./unitSplit.mjs";
import { serverNowMs } from "../publishNode.mjs";

const APPLY = process.argv.includes("--apply");
const only = process.argv.find((a) => a.startsWith("--order="))?.split("=")[1] || null;
const fnRequire = createRequire(new URL("../../../functions/package.json", import.meta.url));
const admin = fnRequire("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
const db = admin.database();
const now = await serverNowMs(db);
const say = (s) => console.log(`${APPLY ? "" : "[dry] "}${s}`);

const tally = {};
const orders = {};
if (only) orders[only] = (await db.ref(`${ONLINE_ORDERS_PATH}/${only}`).get()).val();
else for (const status of HOLDING_STATUSES) Object.assign(orders, (await db.ref(ONLINE_ORDERS_PATH).orderByChild("status").equalTo(status).get()).val() || {});
for (const [id, order] of Object.entries(orders)) {
  const out = await migrateOrderUnits(db, id, order, { nowMs: now, apply: APPLY, say });
  tally[out.status] = (tally[out.status] || 0) + 1;
}
say(`${Object.keys(orders).length} open order(s): ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", ")}${APPLY ? "" : " — dry run, nothing written (--apply to write)"}`);
process.exit(0);
