// ─── DISPLAY CHECKS — wakeHeldChecks SWEEP (PR 3: no UI) ──────────────────────
// Every 5 minutes, walk the held checks in today's node and move them through
// the hold→wake lifecycle (§1.3):
//   stock appears (qty>0) + not yet seen  → stockSeenAt = now, start grace clock
//   grace elapsed + stock still present   → status "open", assignedTo resolved
//   stock gone again before wake          → clear stockSeenAt, back to held
// The pure decision is lib.cjs wakeTransition; this file is the IO around it.
//
// COST: reads ONLY today's day node per ENABLED store (≤~25KB, §4.1), skips a
// store with no held checks, then one stock-cell get per held check. Never a
// full-node read of /pos/sales, /orders, /stock_movements. Runs server-side.
//
// IDEMPOTENCY (a scheduled run can overlap / double-fire): every state change
// is a COLD-CACHE-SAFE leaf CAS or an idempotent write, so a double-fire can't
// double-activate:
//   • stock_seen → CAS on …/stockSeenAt (null → now): only one run claims it.
//   • activate   → CAS on …/status ("held" → "open"): only one run flips it;
//     the flip is terminal, so the `activated` log key is deterministic + once.
//   • re_held    → plain update to null (idempotent) with a deterministic log
//     key derived from the stockSeenAt being cleared, so a concurrent repeat
//     overwrites the same log entry rather than appending a duplicate.
// Both CAS fns return their write value on `cur == null` (the Cloud-Function
// cold-cache first run), so they force the server round-trip instead of
// aborting before the CAS — the null-tolerant claim idiom this repo already
// relies on (see lib/hold-reveal-sweep.cjs).
//
// TIMEZONE: schedule declares timeZone "Africa/Johannesburg" (the runtime is
// UTC); the day key is the shared sa-time.cjs helper (design §0.6). No
// hand-rolled dates.
//
// DEPLOY (Junid only; scoped — NEVER bare --only functions, POS shares this
// project):  firebase deploy --only functions:wakeHeldChecks

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
  resolveAssignment,
} = require("./lib.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// One audit event, server-written, under the SA month of the day node (§4.2).
// `key` is deterministic so a double-fire overwrites rather than appends.
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

// stock appeared: claim stockSeenAt via a cold-safe CAS (null → now). Winner
// then writes wakeAt (display only — activation keys off stockSeenAt+delay) and
// logs. Returns true iff this run made the transition.
async function doStockSeen(db, store, saDate, checkId, nowMs, delayMs) {
  const base = `displayChecks/${store}/${saDate}/${checkId}`;
  const res = await db.ref(`${base}/stockSeenAt`).transaction((cur) => (cur == null ? nowMs : undefined));
  if (!res.committed) return false;
  const updates = {};
  updates[`${base}/wakeAt`] = nowMs + delayMs;
  logEvent(updates, db, store, saDate, {
    checkId, type: "stock_seen", at: nowMs,
    key: `${checkId}_stock_seen_${nowMs}`, payload: { wakeAt: nowMs + delayMs },
  });
  await db.ref().update(updates);
  return true;
}

// grace elapsed, stock still present: flip held → open via a cold-safe CAS.
// Only the winner resolves + freezes assignedTo (cover → locked roster → null;
// both nodes absent until PR 11 → null, which is correct) and stamps
// activatedAt. Returns true iff this run activated it.
async function doActivate(db, store, saDate, checkId, nowMs) {
  const base = `displayChecks/${store}/${saDate}/${checkId}`;
  const res = await db.ref(`${base}/status`).transaction((cur) =>
    cur === "held" || cur == null ? "open" : undefined
  );
  if (!res.committed) return false;
  const [coverSnap, rosterSnap] = await Promise.all([
    db.ref(`displayChecks_settings/${store}/cover/${saDate}`).once("value"),
    db.ref(`displayChecks_settings/${store}/roster`).once("value"),
  ]);
  const assignedTo = resolveAssignment({ cover: coverSnap.val(), roster: rosterSnap.val(), saDate });
  const updates = {};
  updates[`${base}/activatedAt`] = nowMs;
  if (assignedTo) updates[`${base}/assignedTo`] = assignedTo; // null → omit (RTDB drops it)
  logEvent(updates, db, store, saDate, {
    checkId, type: "activated", at: nowMs, key: `${checkId}_activated`, payload: { via: "wake_sweep" },
  });
  await db.ref().update(updates);
  return true;
}

// stock gone before wake: clear the grace clock. Idempotent — the update is
// null-to-null on a repeat and the log key is the cleared stockSeenAt, so a
// concurrent run overwrites the same entry.
async function doReHeld(db, store, saDate, checkId, clearedStockSeenAt, nowMs) {
  const base = `displayChecks/${store}/${saDate}/${checkId}`;
  const updates = {};
  updates[`${base}/stockSeenAt`] = null;
  updates[`${base}/wakeAt`] = null;
  logEvent(updates, db, store, saDate, {
    checkId, type: "re_held", at: nowMs, key: `${checkId}_re_held_${clearedStockSeenAt}`,
  });
  await db.ref().update(updates);
}

// Core sweep — injectable db + nowMs so the parity test can drive it without
// firebase-admin (same shape as lib/hold-reveal-sweep.cjs runHoldRevealSweep).
async function runWakeSweep({ db, nowMs }) {
  const now = nowMs ?? Date.now();
  const saDate = saDateStringFromMs(now);
  const stores = Object.keys(TRIGGER_STORE_FLAGS).filter(isTriggerStoreEnabled);
  let stockSeen = 0, activated = 0, reHeld = 0;

  for (const store of stores) {
    const dayNode = (await db.ref(`displayChecks/${store}/${saDate}`).once("value")).val() || {};
    const held = Object.entries(dayNode).filter(([, c]) => c && c.status === "held");
    if (!held.length) continue; // skip stores holding nothing — no config/stock reads

    const config = (await db.ref(`displayChecks_settings/${store}/config`).once("value")).val();
    const delayMs = wakeDelayMs(config);

    for (const [checkId, check] of held) {
      const sizeKey = check.sizeKey || stockSizeKey(check.size);
      const qtySnap = await db.ref(`stock/${store}/${check.productId}/${sizeKey}/qty`).once("value");
      const t = wakeTransition(check, { qty: Number(qtySnap.val()), nowMs: now, delayMs });
      if (!t) continue;
      if (t.action === "stock_seen") {
        if (await doStockSeen(db, store, saDate, checkId, now, delayMs)) stockSeen++;
      } else if (t.action === "activate") {
        if (await doActivate(db, store, saDate, checkId, now)) activated++;
      } else if (t.action === "re_held") {
        await doReHeld(db, store, saDate, checkId, t.clearedStockSeenAt, now);
        reHeld++;
      }
    }
  }
  console.log(`wakeHeldChecks: stock_seen=${stockSeen} activated=${activated} re_held=${reHeld}`);
  return { stockSeen, activated, reHeld };
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
