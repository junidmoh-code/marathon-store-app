// ─── shelfChecksTick — every ten minutes, the small upkeep the daily checks need ─
// Junid, 24 Nov 2026 evening.
//   1. STOCK ON THE WAY (functions/lib/on-the-way.cjs): the new ledger rows since
//      the last tick are folded into /shelf_on_the_way; what has landed is dropped.
//   2. REJECTIONS THAT ARE NOT WEBSITE ORDERS (functions/lib/shelf-rejects.cjs):
//      added in the same tick, see that file.
// Each step is wrapped: one failing never stops the other, and the next tick
// picks up from its own cursor. Nothing here reads or writes a policy, a target
// or a request's logic, and no stock moves.
//   firebase deploy --only functions:shelfChecksTick
"use strict";
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const O = require("../lib/on-the-way.cjs");

/** A `ts`-ordered range read of the ledger from `fromIso` (the one index /stock_movements has). */
const ledgerSince = (db) => async (fromIso) => (await db.ref("stock_movements").orderByChild("ts").startAt(fromIso).once("value")).val() || {};

async function runTick(db, { nowMs = Date.now(), steps = {} } = {}) {
  const out = {};
  try { out.onTheWay = await O.trackOnTheWay(db, { nowMs, readSince: steps.readSince || ledgerSince(db), log: (l) => console.log(`[shelf-tick] ${l}`) }); }
  catch (e) { console.error("[shelf-tick] on the way failed:", e && e.message ? e.message : e); out.onTheWayError = String((e && e.message) || e); }
  for (const [name, fn] of Object.entries(steps.more || {})) {
    try { out[name] = await fn(db, { nowMs }); }
    catch (e) { console.error(`[shelf-tick] ${name} failed:`, e && e.message ? e.message : e); out[`${name}Error`] = String((e && e.message) || e); }
  }
  return out;
}

exports.runTick = runTick;
exports.shelfChecksTick = onSchedule(
  { schedule: "every 10 minutes", timeZone: "Africa/Johannesburg", region: "europe-west1", memory: "256MiB", timeoutSeconds: 120 },
  async () => { await runTick(admin.database(), { nowMs: Date.now(), steps: { more: exports.moreSteps } }); },
);
exports.moreSteps = {};
