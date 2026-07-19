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
  "archive-failed": "unavailable", // RETRYABLE: flip committed but the durable copy didn't land — retry re-heals
};

// Idempotent set with a small retry, so a transient write failure doesn't strand
// the archive/log. Deterministic paths → a retry overwrites the same node.
async function setWithRetry(ref, value, attempts = 3) {
  for (let i = 0; ; i++) {
    try { await ref.set(value); return true; }
    catch (err) {
      if (i >= attempts - 1) { console.error("completeDisplayCheck: write failed after retries:", err && err.message); return false; }
    }
  }
}

// Archive a committed completed record to the day node + write the audit log,
// both idempotent (deterministic keys) and reproducible FROM THE RECORD ALONE —
// so a reconcile/retry re-runs it identically without re-reading stock. This is
// the write that closes the "flip committed but archive lost" gap: it re-runs on
// every completion attempt that finds an already-completed tombstone.
// Returns TRUE only if BOTH the archive and the audit write landed — the caller
// must NOT report a completion as ok when the durable copy didn't persist
// (else a "done" check is invisible in the feed and unaudited; Codex P1).
async function archiveAndLog(db, store, record) {
  const { checkId, completedSaDate: saDate, result } = record;
  const archived = await setWithRetry(db.ref(`displayChecks/${store}/${saDate}/${checkId}`), record);
  const logged = await setWithRetry(db.ref(`displayChecks_log/${store}/${saMonthOfDate(saDate)}/${checkId}_completed`), {
    checkId,
    type: result === "no_stock" ? "completed_no_stock" : "completed_confirmed",
    at: record.completedAt,
    actor: record.completedBy || null,
    payload: {
      result,
      overridden: !!record.resultOverridden,
      ...(result === "no_stock" ? { stockQty: Number(record.stockAtClose) || 0 } : {}),
    },
  });
  return archived && logged;
}

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
  // proving the item exists is what contradicts the claim). Keyed read. NOTE: a
  // soft-block is advisory — the read is a snapshot, not re-checked inside the
  // flip; the qty is recorded as evidence of what the system saw, not a lock.
  let stockQty = 0;
  if (result === "no_stock" && preRead && preRead.productId) {
    const sk = preRead.sizeKey || stockSizeKey(preRead.size);
    stockQty = Number((await db.ref(`stock/${store}/${preRead.productId}/${sk}/qty`).get()).val()) || 0;
  }

  // Report ok for THIS completion only if its durable copy (day node + audit)
  // actually landed; otherwise a RETRYABLE archive-failed — never a false ok
  // (Codex P1: a "done" check that's invisible in the feed and unaudited). The
  // tombstone stays committed, so the client's retry re-heals through the
  // already-completed path below.
  const okOrRetry = (record) => archiveAndLog(db, store, record).then((ok) =>
    ok ? { kind: "ok", result: record.result, completedAt: record.completedAt, overridden: !!record.resultOverridden }
       : { kind: "reject", code: "archive-failed" });
  // Already completed → WRITE-ONCE: reject (the first result stands). But still
  // ENSURE the durable copy exists (a prior flip may have committed then failed
  // to archive); only if that heal can't land do we ask the client to retry.
  const healThenReject = (record) => archiveAndLog(db, store, record).then((ok) =>
    ({ kind: "reject", code: ok ? "already-completed" : "archive-failed" }));

  const decision = completionDecision({ record: preRead, expectedCheckId: checkId, result, override: override === true, stockQty });
  if (decision.kind === "reject") {
    if (decision.code === "already-completed" && preRead && preRead.status === "completed"
        && preRead.checkId === checkId && preRead.completedSaDate) {
      return healThenReject(preRead);
    }
    return decision;
  }
  if (decision.kind === "needs_override") return { kind: "needs_override", stockQty: decision.stockQty };

  // ── FLIP the active record to a completed TOMBSTONE (write-once, NEVER null) ──
  // preRead rescues ONLY the cold-cache FIRST callback: a Cloud Function has no
  // local RTDB cache, so the first run sees null and returning undefined there
  // would abort before the server round-trip. Once we've been re-invoked with an
  // AUTHORITATIVE value, a null means the slot was genuinely DELETED (e.g. a
  // tombstone reaped after an across-midnight completion) — abort, NEVER
  // resurrect it from the stale open preRead (that would recreate the record and
  // overwrite the first closer's archive with a conflicting result → write-once
  // violation). This is the resurrection class the whole module guards against
  // (Codex P1). The result is still a record or undefined — never `null`.
  let firstRun = true;
  const res = await activeRef.transaction((cur) => {
    // preRead substitutes ONLY on the cold-cache first run; every later
    // invocation uses the authoritative `cur` (a null there = deleted → abort).
    const c = (cur === null && firstRun) ? preRead : cur;
    firstRun = false;
    if (!c || c.checkId !== checkId) return undefined;   // gone/overwritten/deleted — abort, don't resurrect
    if (c.status !== "open" || c.completedAt != null) return undefined; // write-once + concurrent guard
    return buildCompletedRecord(c, { result, nowMs, saDate, actor, overridden: decision.overridden, stockQty });
  });

  if (res.committed) {
    // Archive the COMMITTED tombstone (flip-first, so concurrent closers can't
    // diverge the two copies). Only report ok if the durable copy actually landed.
    return okOrRetry(res.snapshot.val());
  }

  // Aborted. Read the authoritative current value to tell the causes apart AND —
  // the important part — SELF-HEAL: if the slot already holds THIS completed
  // check, a prior attempt committed the flip but may have crashed before
  // archiving; ensure the durable copy exists so a completed record can never be
  // stranded in the active tombstone without a day-node copy.
  const cur = res.snapshot.val();
  if (!cur) return { kind: "reject", code: "not-found" };
  if (cur.checkId !== checkId) return { kind: "reject", code: "stale-check" };
  // Heal only a well-formed completed tombstone — the completedSaDate guard keeps
  // a record missing the day key from archiving to a literal `.../undefined/...`
  // node (Kimi P2). buildCompletedRecord always stamps it; belt-and-suspenders.
  if (cur.status === "completed" && cur.completedSaDate) {
    return healThenReject(cur);
  }
  return { kind: "reject", code: "already-completed" };
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
    // (mirrors config/displayChecks.canUseDisplayChecks server-side). ──
    // The super-admin shortcut trusts the email claim, so it MUST be a VERIFIED
    // email — otherwise a self-signed-up account claiming gunidmoh@gmail.com with
    // email_verified:false would inherit super-admin. Google sign-in (the real
    // super-admin's provider) sets email_verified:true, so this is safe. The
    // staff path never trusts email — it authorizes by uid-keyed /users perms.
    const emailVerified = !!(request.auth.token && request.auth.token.email_verified);
    const userRec = (await db.ref(`users/${uid}`).get()).val() || {};
    const perms = Array.isArray(userRec.permissions) ? userRec.permissions : [];
    const isSuper = email === ADMIN_EMAIL && emailVerified;
    const allowed = isSuper
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
