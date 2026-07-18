// ─── DISPLAY CHECKS — wakeHeldChecks SWEEP (no UI) ────────────────────────────
// Every 5 minutes, walk the active index and move held checks through the
// hold→wake lifecycle (§1.3), all IN PLACE — the never-null model means a check
// never changes address, so there is no relocation and no relocation race:
//   stock appears (qty>0) + not seen  → stockSeenAt = now, grace clock started
//   grace elapsed + stock still there → status flips held → OPEN in place
//                                       (activatedSaDate stamped, §PR-12)
//   stock gone again before wake      → clear stockSeenAt, back to held
// Pure decision in lib.cjs (wakeTransition/applyWakeTransition).
//
// The sweep also REAPS completed tombstones from a PRIOR SA day (window #2), so
// the active index doesn't grow one dead record per SKU-that-didn't-resell —
// no new job, folded into the pass that already reads the index. Proven safe by
// lib.cjs isStaleTombstone: a prior-day tombstone has no in-flight bump, and a
// late bump aborts anyway (bumpTxn rejects completed + the checkId fence).
//
// Reads /displayChecks_active/{store} (bounded by active SKUs) + one stock-cell
// get per held check + config. Never a full-node read of /pos/sales, /orders,
// /stock_movements.
//
// TIMEZONE: schedule declares timeZone "Africa/Johannesburg"; the day key is the
// shared sa-time.cjs helper. Deploy: firebase deploy --only functions:wakeHeldChecks

"use strict";

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const {
  TRIGGER_STORE_FLAGS,
  isTriggerStoreEnabled,
  stockSizeKey,
  saDateStringFromMs,
  saMonthOfDate,
  wakeDelayMs,
  wakeTransition,
  applyWakeTransition,
  isStaleTombstone,
  resolveAssignment,
} = require("./lib.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const activePath = (store, key) => `displayChecks_active/${store}/${key}`;

function logEvent(updates, db, store, saDate, { checkId, type, at, key, payload }) {
  const eventId = key || db.ref(`displayChecks_log/${store}`).push().key;
  updates[`displayChecks_log/${store}/${saMonthOfDate(saDate)}/${eventId}`] = {
    checkId: checkId || null,
    type,
    at,
    actor: { uid: "system:wakeHeldChecks", name: "wakeHeldChecks" },
    ...(payload && Object.keys(payload).length ? { payload } : {}),
  };
}

// Append an audit event AFTER the state commit (logging before would emit a
// spurious event if the transaction then aborts on a race), retrying transient
// failures. Deterministic key → idempotent retry.
async function writeLogWithRetry(db, updates, attempts = 3) {
  for (let i = 0; ; i++) {
    try { await db.ref().update(updates); return; }
    catch (err) {
      if (i >= attempts - 1) {
        console.error("wakeHeldChecks: audit write failed after retries:", err && err.message, Object.keys(updates));
        return; // state is correct; don't fail the sweep over an audit gap
      }
    }
  }
}

// Apply one held-record transition IN PLACE (stock_seen | re_held | activate),
// then the audit event. `preRead` feeds the cold-cache null run. Returns true
// iff this run committed the transition.
async function applyInPlace(db, store, saDate, key, preRead, action, opts) {
  const res = await db.ref(activePath(store, key)).transaction((cur) =>
    applyWakeTransition(cur === null ? preRead : cur, action, opts)
  );
  if (!res.committed) return false;
  const at = opts.nowMs;
  const checkId = preRead.checkId;
  const logType = action === "activate" ? "activated" : action; // stock_seen | re_held | activated
  const logKey = action === "stock_seen" ? `${checkId}_stock_seen_${at}`
    : action === "re_held" ? `${checkId}_re_held_${opts.clearedStockSeenAt}`
    : `${checkId}_activated`;
  const payload = action === "stock_seen" ? { wakeAt: at + opts.delayMs }
    : action === "activate" ? { via: "wake_sweep" } : null;
  const updates = {};
  logEvent(updates, db, store, saDate, { checkId, type: logType, at, key: logKey, payload });
  await writeLogWithRetry(db, updates);
  return true;
}

// Reap a completed tombstone from a prior SA day (window #2). The transaction
// re-checks staleness against the authoritative value, so a slot overwritten by
// a fresh active check since the read is NOT deleted (it's held/open → abort).
async function reapTombstone(db, store, saDate, key, preRead) {
  const res = await db.ref(activePath(store, key)).transaction((cur) => {
    const c = cur === null ? preRead : cur;
    return isStaleTombstone(c, saDate) ? null : undefined; // null = delete
  });
  if (!res.committed) return false;
  const updates = {};
  logEvent(updates, db, store, saDate, {
    checkId: preRead.checkId, type: "tombstone_reaped", at: Date.parse(`${saDate}T00:00:00.000Z`) || 0,
    key: `${preRead.checkId}_reaped`, payload: { completedAt: preRead.completedAt || null },
  });
  await writeLogWithRetry(db, updates);
  return true;
}

// Core sweep — injectable db + nowMs so the test can drive it without admin.
async function runWakeSweep({ db, nowMs }) {
  const now = nowMs ?? Date.now();
  const saDate = saDateStringFromMs(now);
  const stores = Object.keys(TRIGGER_STORE_FLAGS).filter(isTriggerStoreEnabled);
  let stockSeen = 0, activated = 0, reHeld = 0, reaped = 0;

  for (const store of stores) {
    const index = (await db.ref(`displayChecks_active/${store}`).once("value")).val() || {};
    const entries = Object.entries(index);
    if (!entries.length) continue;

    const config = (await db.ref(`displayChecks_settings/${store}/config`).once("value")).val();
    const delayMs = wakeDelayMs(config);

    for (const [key, record] of entries) {
      if (!record) continue;

      if (record.status === "completed") {
        if (isStaleTombstone(record, saDate) && await reapTombstone(db, store, saDate, key, record)) reaped++;
        continue;
      }
      if (record.status !== "held") continue; // open → nothing to do (staff's now)

      const sizeKey = record.sizeKey || stockSizeKey(record.size);
      const stockPath = `stock/${store}/${record.productId}/${sizeKey}/qty`;
      let t = wakeTransition(record, { qty: Number((await db.ref(stockPath).once("value")).val()), nowMs: now, delayMs });
      if (!t) continue;

      if (t.action === "activate") {
        // Resolve assignment, then RE-READ stock immediately before committing
        // (a sale during the roster reads could empty the shelf; activating a
        // stock-gone check drops an unfulfillable card into the feed).
        const [coverSnap, rosterSnap] = await Promise.all([
          db.ref(`displayChecks_settings/${store}/cover/${saDate}`).once("value"),
          db.ref(`displayChecks_settings/${store}/roster`).once("value"),
        ]);
        const assignedTo = resolveAssignment({ cover: coverSnap.val(), roster: rosterSnap.val(), saDate });
        t = wakeTransition(record, { qty: Number((await db.ref(stockPath).once("value")).val()), nowMs: now, delayMs });
        if (!t || t.action !== "activate") {
          if (t && t.action === "re_held") {
            if (await applyInPlace(db, store, saDate, key, record, "re_held",
              { nowMs: now, delayMs, clearedStockSeenAt: t.clearedStockSeenAt })) reHeld++;
          }
          continue;
        }
        if (await applyInPlace(db, store, saDate, key, record, "activate",
          { nowMs: now, delayMs, assignedTo, activatedSaDate: saDate })) activated++;
      } else {
        if (await applyInPlace(db, store, saDate, key, record, t.action,
          { nowMs: now, delayMs, clearedStockSeenAt: t.clearedStockSeenAt })) {
          if (t.action === "stock_seen") stockSeen++; else reHeld++;
        }
      }
    }
  }
  console.log(`wakeHeldChecks: stock_seen=${stockSeen} activated=${activated} re_held=${reHeld} reaped=${reaped}`);
  return { stockSeen, activated, reHeld, reaped };
}

exports.runWakeSweep = runWakeSweep;

exports.wakeHeldChecks = onSchedule(
  {
    schedule: "every 5 minutes",
    region: "europe-west1",
    timeZone: "Africa/Johannesburg",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    await runWakeSweep({ db: admin.database() });
  }
);
