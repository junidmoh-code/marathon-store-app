// ─── DISPLAY CHECKS — wakeHeldChecks SWEEP (no UI) ────────────────────────────
// Five times a day in trading hours (09:00, 11:00, 13:00, 15:00, 16:00 SAST;
// owner decision 2026-09-19), walk the active index and move held checks
// through the hold→wake lifecycle (§1.3), all IN PLACE — the never-null model
// means a check never changes address, so there is no relocation race:
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
// shared sa-time.cjs helper. With the schedule now expressed in hours rather
// than as a bare interval, the timeZone is load-bearing: left to the UTC
// default the "09:00" run would fire at 11:00 SAST and the last at 18:00.
//
// NO HELD CHECK IS EVER LOST. A held check lives in /displayChecks_active until
// something wakes it; it has no expiry, nothing here ages one out, and the
// sweep's decision (lib.cjs wakeTransition) is a pure function of the record
// and the current stock cell, not of how many sweeps preceded it. A check held
// at 16:30, overnight, or over a weekend is picked up by the next 09:00 run.
// The per-sale trigger (onClothingSale) is an onValueCreated RTDB trigger and
// fires on its own, independently of this schedule — sales still raise and bump
// checks at 20:00 and on a Sunday; only the hold→wake transition waits.
//
// WHAT DOES CHANGE — three things, stated plainly rather than waved past as
// "only deferred", because two of them are not deferral (adversarial review,
// PR #616):
//
// 1. TRANSIENT STOCK NO LONGER WAKES A CHECK. Waking needs stock present at TWO
//    sweeps: one to stamp stockSeenAt, a later one to activate. Stock therefore
//    had to survive ~25 minutes; it must now survive ~2 hours. Stock that
//    arrives at 09:10 and sells out by 10:40 is invisible to this sweep — the
//    11:00 pass reads qty 0 and does nothing. The CHECK is not lost (it stays
//    held and wakes whenever stock next lasts a gap), but that particular
//    opportunity to put the item on display is gone, not postponed. That is the
//    honest cost of the cadence, and it is pinned by a test.
//
// 2. wakeDelayMinutes IS EFFECTIVELY DEAD. With a minimum two-hour gap between
//    sweeps, every value from 0 to 119 minutes behaves identically: the check
//    activates at the sweep AFTER the one that saw stock. The settings screen
//    still presents it as a real dial. Only a value above the sweep gap does
//    anything now.
//
// 3. THE PRIOR-DAY TOMBSTONE REAP MOVES PAST THE 08:30 OPEN. It used to happen
//    within five minutes of midnight; the first sweep is now 09:00. A sale
//    between 08:30 and 09:00 against a slot completed YESTERDAY therefore still
//    finds the tombstone, and resolveSale classifies it as repeat_detected — or
//    contradiction_detected if yesterday's result was no_stock — with
//    repeatWithinMinutes around a thousand. A cross-day "contradiction" is a
//    FALSE alarm; anyone reading that log line should check repeatWithinMinutes
//    before believing it.
//
//    The compliance record is not lost: resolveSale returns archiveCheckId, and
//    onClothingSale archives the tombstone to the day node before overwriting
//    the slot. Scope that claim honestly — the REAP path here is the resilient
//    one (its archive is wrapped, and a failed archive skips the delete and
//    retries next sweep). onClothingSale's archive write is NOT wrapped, so a
//    throw there aborts the invocation before the create. That is pre-existing
//    and unchanged by the cadence, but this window is where it would now be
//    reached more often, so it is named rather than covered by a blanket
//    "archiving is idempotent".
//
// Deploy: firebase deploy --only functions:wakeHeldChecks

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
const { guardedMutate } = require("./guardedTransaction.cjs");

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
  // guardedMutate: cold-cache latch + authoritative-null abort. THIS is the site
  // finding A caught — previously a bare `cur === null ? preRead` with NO latch,
  // an unlatched resurrection site missed by every prior PR because it was never
  // in-diff. Routing it here closes it permanently (behaviour identical on every
  // reachable path — applyWakeTransition only ever sees a held record).
  const res = await guardedMutate(db.ref(activePath(store, key)), preRead, (c) =>
    applyWakeTransition(c, action, opts)
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
//
// ARCHIVE-BEFORE-REAP: a completed check is normally archived to the day node at
// completion (completeCheck.js). But if that completion committed the tombstone
// flip and then crashed before its archive, reaping would be the LAST chance to
// save the compliance record — otherwise it vanishes with no trace. So preserve
// it (idempotent, keyed by checkId) FIRST, and only reap once it's safely
// archived; if the archive can't be written, skip the reap and retry next sweep.
async function reapTombstone(db, store, saDate, key, preRead) {
  const checkId = preRead.checkId;
  const arcDate = preRead.completedSaDate
    || (Number.isFinite(Number(preRead.completedAt)) ? saDateStringFromMs(Number(preRead.completedAt)) : null);
  if (checkId && arcDate) {
    try {
      await db.ref(`displayChecks/${store}/${arcDate}/${checkId}`).set(preRead);
    } catch (err) {
      console.error("wakeHeldChecks: archive-before-reap failed, skipping reap this pass:", err && err.message);
      return false; // don't delete a record we couldn't preserve
    }
  }
  // guardedMutate: cold-cache latch + authoritative-null abort. The mutation
  // returns null to DELETE a stale tombstone (undefined = not stale → abort). A
  // reap can't resurrect (it never returns a record), but it routes through the
  // one primitive for a single, provably-guarded null-handling path.
  const res = await guardedMutate(db.ref(activePath(store, key)), preRead, (c) =>
    isStaleTombstone(c, saDate) ? null : undefined // null = delete
  );
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
    // FIVE runs a day, trading hours only — owner decision 2026-09-19.
    // 09:00, 11:00, 13:00, 15:00, 16:00 SAST. Nothing outside that window: the
    // sweep used to run 288 times a day, 200-odd of them against an index that
    // could not have changed because the shop was shut.
    schedule: "0 9,11,13,15,16 * * *",
    region: "europe-west1",
    timeZone: "Africa/Johannesburg",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    await runWakeSweep({ db: admin.database() });
  }
);
