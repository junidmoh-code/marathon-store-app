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
// IDEMPOTENCY + ATOMICITY (a scheduled run can overlap / double-fire): EACH
// transition is ONE whole-check-node transaction (applyWakeTransition), so the
// state change is atomic — a crash can never leave a check `open` without
// activatedAt, or half-cleared. The transaction re-validates the status-based
// invariants against the authoritative current node, so two overlapping sweeps
// are safe: the second sees the first's committed state and aborts. Only the
// append-only audit event is written after the commit (best-effort, with a
// deterministic key so a retry overwrites rather than duplicates).
//
// COLD-CACHE SAFETY: the transaction fn is fed `cur === null ? preRead : cur`,
// so on the Cloud-Function cold-cache first run (cur null) it computes from the
// already-read check and returns a value — forcing the server round-trip and
// the CAS re-run against the true value — instead of aborting before the
// server is consulted. This is the null-tolerant claim idiom this repo already
// relies on (see lib/hold-reveal-sweep.cjs). Checks are never deleted, so a
// truly-absent node never occurs.
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
  applyWakeTransition,
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

// Append the audit event, retrying transient RTDB failures. The log is written
// AFTER the state transaction commits — deliberately: logging BEFORE would emit
// a SPURIOUS event whenever the transaction then aborts on a race (a lie in an
// append-only record is worse than a rare gap). The deterministic key makes the
// write idempotent, so a retry can't duplicate. The retry closes Codex's most
// likely failure (a transient RTDB error between the two ops); the residual — a
// hard crash in the sub-ms window after commit, before this lands — loses one
// audit event whose facts are still reconstructable from the check's own
// timestamps (stockSeenAt / activatedAt). Cross-node atomic write (state node +
// log node in one op) is not available in RTDB, so this is the honest bound.
async function writeLogWithRetry(db, updates, attempts = 3) {
  for (let i = 0; ; i++) {
    try { await db.ref().update(updates); return; }
    catch (err) {
      if (i >= attempts - 1) {
        console.error("wakeHeldChecks: audit log write failed after retries:", err && err.message, Object.keys(updates));
        return; // state is already correct; do not fail the whole sweep over an audit gap
      }
    }
  }
}

// Apply one transition atomically. The whole-check-node transaction (fed
// `cur ?? preRead` for cold-cache safety) is the single write for the state
// change; on commit, the audit event is appended with a deterministic key.
// Returns true iff this run made the transition.
async function applyTransition(db, store, saDate, checkId, preRead, action, opts) {
  const base = `displayChecks/${store}/${saDate}/${checkId}`;
  const res = await db.ref(base).transaction((cur) =>
    applyWakeTransition(cur === null ? preRead : cur, action, opts)
  );
  if (!res.committed) return false;

  const at = opts.nowMs;
  // action verb → §4.2 audit log type ("activate" → "activated").
  const logType = { stock_seen: "stock_seen", activate: "activated", re_held: "re_held" }[action];
  const logKey = {
    stock_seen: `${checkId}_stock_seen_${at}`,
    activate: `${checkId}_activated`,
    re_held: `${checkId}_re_held_${opts.clearedStockSeenAt}`,
  }[action];
  const payload = {
    stock_seen: { wakeAt: at + opts.delayMs },
    activate: { via: "wake_sweep" },
    re_held: null,
  }[action];

  const updates = {};
  logEvent(updates, db, store, saDate, { checkId, type: logType, at, key: logKey, payload });
  await writeLogWithRetry(db, updates);
  return true;
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

      // Resolve + freeze assignment only when activating (cover → LOCKED roster
      // → null; both nodes absent until PR 11 → null, correct). Resolved before
      // the transaction so applyWakeTransition can write it atomically.
      let assignedTo = null;
      if (t.action === "activate") {
        const [coverSnap, rosterSnap] = await Promise.all([
          db.ref(`displayChecks_settings/${store}/cover/${saDate}`).once("value"),
          db.ref(`displayChecks_settings/${store}/roster`).once("value"),
        ]);
        assignedTo = resolveAssignment({ cover: coverSnap.val(), roster: rosterSnap.val(), saDate });
      }

      const committed = await applyTransition(db, store, saDate, checkId, check, t.action, {
        nowMs: now, delayMs, assignedTo, clearedStockSeenAt: t.clearedStockSeenAt,
      });
      if (committed) {
        if (t.action === "stock_seen") stockSeen++;
        else if (t.action === "activate") activated++;
        else if (t.action === "re_held") reHeld++;
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
