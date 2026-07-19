// ─── DISPLAY CHECKS — completeDisplayCheck CALLABLE (PR 7, the write path) ────
// A staff member closes an OPEN display check from the feed with one of two
// results — "confirmed" (display restocked) or "no_stock" (nothing to put out).
// This is the module's first STAFF-DRIVEN write. Server-authoritative on purpose:
// a compliance record must not trust the client to enforce write-once, the
// no-stock soft-block, or the copy-not-move completion.
//
// ── THE INVARIANT THIS FILE EXISTS TO HONOR ──────────────────────────────────
// Completion NEVER deletes the active record. It COPIES the completed check to
// the day-node archive and FLIPS the active record to a `completed` TOMBSTONE
// in place. That tombstone (never a deletion) is the entire foundation of the
// cold-cache resurrection close: a sale-bump's `cur ?? preRead` transaction can
// only resurrect a record that was DELETED, and no writer — this one included —
// ever deletes an active record. The transaction below returns a completed
// record, never null. See display-checks-complete.test.cjs, the test named
// "completion NEVER deletes the active record" — it fails if this ever deletes.
//
// Order: FLIP first (write-once transaction, the authority), THEN archive the
// COMMITTED tombstone. So two staff racing the same check can't leave the day
// node and the active tombstone disagreeing — the loser's transaction aborts
// before it archives; the winner archives exactly what it committed.
//
// NO PIN: identity is request.auth (uid + verified email) — the logged-in user,
// stamped as completedBy. DEPLOY (scoped): firebase deploy --only functions:completeDisplayCheck

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const {
  isTriggerStoreEnabled,
  stockSizeKey,
  saDateStringFromMs,
  saMonthOfDate,
  completionDecision,
  buildCompletedRecord,
} = require("./lib.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

const ADMIN_EMAIL = "gunidmoh@gmail.com"; // super-admin (mirrors config/displayChecks.js)

// Reject-code → callable error code. Everything else is a failed-precondition.
const ERROR_CODE = {
  "not-found": "not-found",
  "stale-check": "failed-precondition",
  "already-completed": "failed-precondition",
  "not-open": "failed-precondition",
  "bad-result": "invalid-argument",
};

// The completion mutation core — injectable `db` so it is unit-testable without
// admin (mirrors bumpCheck). Does the stock soft-block read, the write-once
// tombstone flip, the day-node archive and the audit log. Returns a discriminated
// result; the onCall wrapper maps it to HttpsError / a return value.
//   { kind:"reject", code }
//   { kind:"needs_override", stockQty }
//   { kind:"ok", result, completedAt, overridden }
async function runComplete(db, { store, key, checkId, result, override, actor, nowMs }) {
  const saDate = saDateStringFromMs(nowMs);
  const activeRef = db.ref(`displayChecks_active/${store}/${key}`);
  const preRead = (await activeRef.get()).val();

  // For a no-stock close, read the live stock cell for the soft-block (the till
  // proving the item exists is what contradicts the claim). Keyed read.
  let stockQty = 0;
  if (result === "no_stock" && preRead && preRead.productId) {
    const sk = preRead.sizeKey || stockSizeKey(preRead.size);
    stockQty = Number((await db.ref(`stock/${store}/${preRead.productId}/${sk}/qty`).get()).val()) || 0;
  }

  const decision = completionDecision({ record: preRead, expectedCheckId: checkId, result, override: override === true, stockQty });
  if (decision.kind === "reject") return decision;
  if (decision.kind === "needs_override") return { kind: "needs_override", stockQty: decision.stockQty };

  // ── FLIP the active record to a completed TOMBSTONE (write-once, NEVER null) ──
  // Cold-safe (`cur ?? preRead` forces the server round-trip). The checkId +
  // open-status guards make it write-once and abort if the slot changed — and it
  // returns a completed RECORD, so it can never delete (the invariant).
  const res = await activeRef.transaction((cur) => {
    const c = cur === null ? preRead : cur;
    if (!c || c.checkId !== checkId) return undefined;   // gone/overwritten — abort, don't resurrect
    if (c.status !== "open" || c.completedAt != null) return undefined; // write-once + concurrent guard
    return buildCompletedRecord(c, { result, nowMs, saDate, actor, overridden: decision.overridden });
  });
  if (!res.committed) {
    // Lost the write-once race (already completed) or the slot moved. No archive
    // was written yet, so nothing to reconcile.
    return { kind: "reject", code: "already-completed" };
  }
  const committed = res.snapshot.val();

  // ── Archive the COMMITTED tombstone to the day node (idempotent, keyed by
  // checkId under the completion SA day — where PR 5's Confirmed feed reads). ──
  await db.ref(`displayChecks/${store}/${committed.completedSaDate}/${checkId}`).set(committed);

  // ── Audit event (deterministic per-check key → idempotent) ──
  await db.ref(`displayChecks_log/${store}/${saMonthOfDate(saDate)}/${checkId}_completed`).set({
    checkId,
    type: result === "no_stock" ? "completed_no_stock" : "completed_confirmed",
    at: nowMs,
    actor,
    payload: {
      result,
      overridden: decision.overridden,
      ...(result === "no_stock" ? { stockQty } : {}),
    },
  });

  return { kind: "ok", result, completedAt: nowMs, overridden: decision.overridden };
}

// Exported for the completion regression tests (write-once, no-stock soft-block,
// and THE hard gate: completion never deletes the active record).
exports.runComplete = runComplete;

exports.completeDisplayCheck = onCall(
  { region: "europe-west1", timeoutSeconds: 30, memory: "256MiB" },
  async (request) => {
    // ── Auth: a real signed-in user (never anonymous) ──
    const provider = request.auth && request.auth.token && request.auth.token.firebase
      && request.auth.token.firebase.sign_in_provider;
    if (!request.auth || provider === "anonymous") {
      throw new HttpsError("unauthenticated", "Sign-in required to complete a display check.");
    }
    const uid = request.auth.uid;
    const email = (request.auth.token && request.auth.token.email) || null;

    // ── Input ──
    const { store, key, checkId, result, override } = request.data || {};
    if (!store || typeof store !== "string" || !key || typeof key !== "string"
        || !checkId || typeof checkId !== "string") {
      throw new HttpsError("invalid-argument", "store, key and checkId are required.");
    }
    if (result !== "confirmed" && result !== "no_stock") {
      throw new HttpsError("invalid-argument", "result must be 'confirmed' or 'no_stock'.");
    }
    if (!isTriggerStoreEnabled(store)) {
      throw new HttpsError("failed-precondition", "Display Checks is not enabled for this store.");
    }

    const db = admin.database();

    // ── Authorize for THIS store: super-admin, or store-scoped display_checks
    // (mirrors config/displayChecks.canUseDisplayChecks server-side). email from
    // the verified token is the only trusted identity signal. ──
    const userRec = (await db.ref(`users/${uid}`).get()).val() || {};
    const perms = Array.isArray(userRec.permissions) ? userRec.permissions : [];
    const allowed = email === ADMIN_EMAIL
      || (perms.includes("display_checks") && userRec.destShop === store);
    if (!allowed) {
      throw new HttpsError("permission-denied", "You can't complete checks for this store.");
    }

    const actor = {
      uid,
      name: userRec.displayName || userRec.username || (email ? email.split("@")[0] : "staff"),
      email,
    };

    const out = await runComplete(db, { store, key, checkId, result, override: override === true, actor, nowMs: Date.now() });
    if (out.kind === "reject") {
      throw new HttpsError(ERROR_CODE[out.code] || "failed-precondition", out.code);
    }
    if (out.kind === "needs_override") {
      // Soft-block: don't complete. The client shows "inventory shows N × size —
      // check the shelf again" and only re-calls with override:true if insisted.
      return { ok: false, needsOverride: true, stockQty: out.stockQty };
    }
    return { ok: true, result: out.result, completedAt: out.completedAt, overridden: out.overridden };
  }
);
