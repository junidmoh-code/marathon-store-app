// ─── shelfChecksTick — every ten minutes, the small upkeep the daily checks need ─
// Junid, 24 Nov 2026 evening.
//   1. STOCK ON THE WAY (functions/lib/on-the-way.cjs): the new ledger rows since
//      the last tick are folded into /shelf_on_the_way; what has landed is dropped.
//   2. REJECTIONS THAT ARE NOT WEBSITE ORDERS (functions/lib/shelf-rejects.cjs): a
//      store customer's order Out of Stock, a shop-refill size rejected, Stock
//      Depleted, a refill or transfer request refused — each new one since the
//      last tick holds its shelf off the website until it is checked.
// Each step is wrapped: one failing never stops the other, and the next tick
// picks up from its own cursor. Nothing here reads or writes a policy, a target
// or a request's logic, and no stock moves.
//   firebase deploy --only functions:shelfChecksTick
"use strict";
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const O = require("../lib/on-the-way.cjs");
const R = require("../lib/shelf-rejects.cjs");
const { DIRTY_PATH, CONCRETE_DIRTY_PATH } = require("../lib/shopify-inventory-dirty.cjs");

/** A `ts`-ordered range read of the ledger from `fromIso` (the one index /stock_movements has). */
const ledgerSince = (db) => async (fromIso) => (await db.ref("stock_movements").orderByChild("ts").startAt(fromIso).once("value")).val() || {};

/** The new rows of the insights log from a push key (inclusive): its keys are time-ordered. */
const insightsFrom = (db) => async (startKey) => (await db.ref(R.INSIGHTS_PATH).orderByKey().startAt(startKey).once("value")).val() || {};
/** Requests resolved from `fromIso`, by the request list's resolvedAt index. Read only. */
const requestsResolvedSince = (db) => async (fromIso) => (await db.ref(R.REQUESTS_PATH).orderByChild("resolvedAt").startAt(fromIso).once("value")).val() || {};
const markDirty = (db) => async (pid) => { for (const node of [DIRTY_PATH, CONCRETE_DIRTY_PATH]) await db.ref(`${node}/${pid}`).set(admin.database.ServerValue.increment(1)); };

async function runTick(db, { nowMs = Date.now(), io = {} } = {}) {
  const out = {};
  const log = (l) => console.log(`[shelf-tick] ${l}`);
  // On the way FIRST: the rejections below are judged against it.
  try { out.onTheWay = await O.trackOnTheWay(db, { nowMs, readSince: io.readSince || ledgerSince(db), log }); }
  catch (e) { console.error("[shelf-tick] on the way failed:", e && e.message ? e.message : e); out.onTheWayError = String((e && e.message) || e); }
  // Shelf checks off (Junid, 26 Nov 2026): no list is built and no rejection
  // is held for a check. On the way above keeps running — the website
  // write-down and its self-restore still read it.
  let off = false;
  try { off = (await db.ref("config/onlineOrders/shelfChecks/off").once("value")).val() === true; } catch { off = false; }
  if (off) { log("shelf checks off — rejections not held"); out.rejections = { skipped: "off" }; return out; }
  try {
    out.rejections = await R.scanRejections(db, { nowMs, readInsights: io.readInsights || insightsFrom(db), readRequests: io.readRequests || requestsResolvedSince(db), markDirty: io.markDirty || markDirty(db), log });
    log(`rejections: ${out.rejections.rejections} read (${out.rejections.insights} log rows, ${out.rejections.requests} requests), ${out.rejections.held} shelves held`);
  } catch (e) { console.error("[shelf-tick] rejections failed:", e && e.message ? e.message : e); out.rejectionsError = String((e && e.message) || e); }
  return out;
}

exports.runTick = runTick;
exports.shelfChecksTick = onSchedule(
  { schedule: "every 10 minutes", timeZone: "Africa/Johannesburg", region: "europe-west1", memory: "256MiB", timeoutSeconds: 120 },
  async () => { await runTick(admin.database(), { nowMs: Date.now() }); },
);
