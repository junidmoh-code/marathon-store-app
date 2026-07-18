// ─── DISPLAY CHECKS — wakeHeldChecks SWEEP (PR 3: no UI) ──────────────────────
// Every 5 minutes, walk the flat held index and move held checks through the
// hold→wake lifecycle (§1.3):
//   stock appears (qty>0) + not yet seen  → stockSeenAt = now, start grace clock
//   grace elapsed + stock still present   → status "open", RELOCATE into today's
//                                           day node, assignedTo resolved
//   stock gone again before wake          → clear stockSeenAt, back to held
// The pure decision is lib.cjs wakeTransition/applyWakeTransition; this file is
// the IO around it. Pure logic is unchanged from the day-scoped version; what
// changed is WHERE held checks live and that a waking check is RELOCATED.
//
// FLAT INDEX (PR 2b): held checks live at `displayChecks_held/{store}/{dedupeKey}`
// — NOT day-scoped — so a check held on Monday and restocked Wednesday still
// wakes (the cross-day gap Codex flagged on the day-scoped sweep). The sweep
// reads the whole store index PER RUN (every 5 min; bounded by held SKUs, and
// reading them all is the sweep's whole job — distinct from the trigger, which
// does an O(1) keyed lookup per sale).
//
// WAKE = RELOCATE. When a held check goes open it must move into TODAY's day
// node so PR 5's today-scoped feed shows it: write the open record to
// `displayChecks/{store}/{saDate}/{checkId}` (its checkId field) and delete the
// flat entry, in ONE atomic multi-path update. A crash between the status flip
// (a transaction on the flat record) and the relocate leaves an `open` record
// in the flat index; the next sweep SELF-HEALS it (relocates it). The relocate
// is idempotent (day-node write is keyed by checkId; the activated log key is
// deterministic).
//
// IDEMPOTENCY + ATOMICITY: stock_seen / re_held are single whole-record
// transactions on the flat entry (applyWakeTransition), cold-cache-safe via
// `cur ?? preRead`. Activation is a transaction (held→open in place) then the
// atomic relocate. Two overlapping sweeps are safe: the transaction re-validates
// and the loser aborts. Only audit events are written after a commit (retried
// on transient failure; deterministic key so a retry can't duplicate).
//
// COST: the flat store index + one stock-cell get per held check + config.
// Never a full-node read of /pos/sales, /orders, /stock_movements.
//
// TIMEZONE: schedule declares timeZone "Africa/Johannesburg"; the day key is the
// shared sa-time.cjs helper (design §0.6). No hand-rolled dates.
//
// DEPLOY (Junid only; scoped — NEVER bare --only functions):
//   firebase deploy --only functions:wakeHeldChecks

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
  resolveAssignment,
} = require("./lib.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// One audit event, server-written, under the SA month of the day node (§4.2).
// `key` is deterministic so a double-fire/retry overwrites rather than appends.
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

// Append an audit event, retrying transient RTDB failures. Written AFTER the
// state commit deliberately (logging before would emit a SPURIOUS event if the
// transaction then aborts on a race). Deterministic key → idempotent retry.
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

const heldPath = (store, dedupeKey) => `displayChecks_held/${store}/${dedupeKey}`;

// stock_seen / re_held: one whole-record transaction on the flat entry, then the
// audit event. Returns true iff this run made the transition.
async function applyInPlace(db, store, saDate, dedupeKey, preRead, action, opts) {
  const res = await db.ref(heldPath(store, dedupeKey)).transaction((cur) =>
    applyWakeTransition(cur === null ? preRead : cur, action, opts)
  );
  if (!res.committed) return false;
  const at = opts.nowMs;
  const logType = action; // "stock_seen" | "re_held" (both match the §4.2 type)
  const logKey = action === "stock_seen"
    ? `${preRead.checkId}_stock_seen_${at}`
    : `${preRead.checkId}_re_held_${opts.clearedStockSeenAt}`;
  const payload = action === "stock_seen" ? { wakeAt: at + opts.delayMs } : null;
  const updates = {};
  logEvent(updates, db, store, saDate, { checkId: preRead.checkId, type: logType, at, key: logKey, payload });
  await writeLogWithRetry(db, updates);
  return true;
}

// Relocate an OPEN record out of the flat index into TODAY's day node. ONE
// atomic multi-path update: day-node write (keyed by checkId) + flat delete +
// the `activated` audit event (deterministic key). Idempotent — safe to re-run
// on self-heal. The grace fields don't belong on an open day-node check.
//
// CONCURRENT-BUMP SAFETY (Codex): the record is RE-READ fresh here, not taken
// from the activation transaction's snapshot. A sale that read the record while
// it was still `held` can have its bumpCheck land on the (now open) flat entry
// AFTER the flip; relocating a stale snapshot would drop that bump's
// saleCount/appliedMovements when the flat entry is deleted. Re-reading captures
// it. (`fallback` covers a self-heal where the entry was already re-read.)
async function relocateToDay(db, store, saDate, dedupeKey, fallback) {
  const latest = (await db.ref(heldPath(store, dedupeKey)).get()).val() || fallback;
  if (!latest || !latest.checkId) return;
  const checkId = latest.checkId;
  const dayRecord = { ...latest, status: "open" }; // fold in any post-flip bump; ensure open
  delete dayRecord.stockSeenAt;
  delete dayRecord.wakeAt;
  const updates = {};
  for (const [field, value] of Object.entries(dayRecord)) {
    updates[`displayChecks/${store}/${saDate}/${checkId}/${field}`] = value;
  }
  updates[heldPath(store, dedupeKey)] = null; // remove the flat entry
  logEvent(updates, db, store, saDate, {
    checkId, type: "activated", at: latest.activatedAt || Date.now(),
    key: `${checkId}_activated`, payload: { via: "wake_sweep", relocatedTo: saDate },
  });
  await writeLogWithRetry(db, updates);
}

// Core sweep — injectable db + nowMs so the test can drive it without
// firebase-admin (same shape as lib/hold-reveal-sweep.cjs).
async function runWakeSweep({ db, nowMs }) {
  const now = nowMs ?? Date.now();
  const saDate = saDateStringFromMs(now);
  const stores = Object.keys(TRIGGER_STORE_FLAGS).filter(isTriggerStoreEnabled);
  let stockSeen = 0, activated = 0, reHeld = 0, relocated = 0;

  for (const store of stores) {
    const index = (await db.ref(`displayChecks_held/${store}`).once("value")).val() || {};
    const entries = Object.entries(index);
    if (!entries.length) continue;

    const config = (await db.ref(`displayChecks_settings/${store}/config`).once("value")).val();
    const delayMs = wakeDelayMs(config);

    for (const [dedupeKey, record] of entries) {
      if (!record) continue;

      // SELF-HEAL: an `open` record in the flat index is a relocation that
      // committed the status flip but crashed before the move. Complete it.
      if (record.status === "open") {
        await relocateToDay(db, store, saDate, dedupeKey, record);
        relocated++;
        continue;
      }
      if (record.status !== "held") continue;

      const sizeKey = record.sizeKey || stockSizeKey(record.size);
      const stockPath = `stock/${store}/${record.productId}/${sizeKey}/qty`;
      let t = wakeTransition(record, { qty: Number((await db.ref(stockPath).once("value")).val()), nowMs: now, delayMs });
      if (!t) continue;

      if (t.action === "activate") {
        // Resolve assignment, then RE-READ stock immediately before committing
        // (a sale during the roster reads could empty the shelf; activating a
        // stock-gone check would drop an unfulfillable card into the feed).
        const [coverSnap, rosterSnap] = await Promise.all([
          db.ref(`displayChecks_settings/${store}/cover/${saDate}`).once("value"),
          db.ref(`displayChecks_settings/${store}/roster`).once("value"),
        ]);
        const assignedTo = resolveAssignment({ cover: coverSnap.val(), roster: rosterSnap.val(), saDate });
        t = wakeTransition(record, { qty: Number((await db.ref(stockPath).once("value")).val()), nowMs: now, delayMs });
        if (!t || t.action !== "activate") {
          if (t && t.action === "re_held") {
            if (await applyInPlace(db, store, saDate, dedupeKey, record, "re_held",
              { nowMs: now, delayMs, clearedStockSeenAt: t.clearedStockSeenAt })) reHeld++;
          }
          continue;
        }
        // Transaction: held → open IN PLACE (single winner), then relocate.
        const res = await db.ref(heldPath(store, dedupeKey)).transaction((cur) =>
          applyWakeTransition(cur === null ? record : cur, "activate", { nowMs: now, delayMs, assignedTo })
        );
        if (res.committed) {
          await relocateToDay(db, store, saDate, dedupeKey, res.snapshot.val());
          activated++;
        }
      } else {
        // stock_seen | re_held — in place on the flat entry.
        if (await applyInPlace(db, store, saDate, dedupeKey, record, t.action,
          { nowMs: now, delayMs, clearedStockSeenAt: t.clearedStockSeenAt })) {
          if (t.action === "stock_seen") stockSeen++; else reHeld++;
        }
      }
    }
  }
  console.log(`wakeHeldChecks: stock_seen=${stockSeen} activated=${activated} re_held=${reHeld} self_healed=${relocated}`);
  return { stockSeen, activated, reHeld, relocated };
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
