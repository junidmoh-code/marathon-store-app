// ─── EFT POOL CALLABLES — how the till reaches an owner-only node ────────────
// /eft_pool is owner-only by rule, deliberately: a pool record carries the
// payer's name, the notification's own text and Gmail's authentication
// transcript — other customers' payment data. The cashier settling an EFT sale
// still has to find a payment in it, so the POS goes through these callables:
// the Admin SDK reads the pool server-side and returns ONLY the projection the
// search needs (lib/eft-pool.cjs publicEftView). Staff never gain client read
// on the node, and no rule change ships with this build.
//
//   eftPoolSearch   any active POS identity: the forgiving search — partial
//                   reference, payer name, standalone amount. Used payments
//                   come back too, marked used with slip/cashier/customer,
//                   because "it says used, slip 00123, Tuesday, Ahmed" ends a
//                   counter argument in five seconds.
//   eftPoolSettle   the consume-once lifecycle: settle (unmatched → used,
//                   BEFORE the sale is written — a lost race must stop the
//                   sale, not follow it), attach (the committed sale's slip
//                   lands on the settlement), release (the sale failed —
//                   hand the payment back, attempt kept on record). All three
//                   are one RTDB transaction each; the decisions are pure in
//                   lib/eft-settle.cjs, where the two-tills race is pinned by
//                   a test written before the implementation.
//   eftPoolReverse  owner-only: unwind a completed settlement. Both records
//                   survive — the settlement moves to `reversals` on the pool
//                   record; the sale at /pos/sales is not touched.
//
// AUTH MODEL: settle/search callers must be an ACTIVE POS identity —
// /users/{uid}/posAccess/isActive === true (the POS app's own access record,
// maintained by createPosUser/updatePosUser in marathon-pos-app) — or the
// owner. Fail closed: no record, no read. Reverse is the owner alone.
//
// Server time is Date.now() here on purpose — serverNowMs() is the CLIENT's
// corrected clock and does not exist server-side; the function's own clock IS
// the server clock.
//
// DEPLOY BY NAME (functions/ is shared with marathon-pos-app — a bare
// --only functions would redeploy every function in the project):
//   firebase deploy --only functions:eftPoolSearch,functions:eftPoolSettle,functions:eftPoolReverse

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const { EFT_POOL_PATH, EFT_SEARCH_WINDOW, searchEftPool } = require("../lib/eft-pool.cjs");
const {
  settleDecision, attachSaleDecision, releaseDecision, reverseDecision,
} = require("../lib/eft-settle.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// Same constant as the POS app's PermissionsContext and posUsers.js.
const ADMIN_EMAIL = "gunidmoh@gmail.com";

const RUNTIME = { region: "europe-west1", memory: "256MiB", timeoutSeconds: 30 };

// Pool keys are eftMessageKey's sha256 prefix — 40 hex chars, nothing else.
// Anything shaped differently is refused before it can become a path.
function poolKeyOf(data) {
  const k = String(data?.poolKey ?? "");
  if (!/^[0-9a-f]{40}$/.test(k)) throw new HttpsError("invalid-argument", "That is not a payment key.");
  return k;
}

/** Owner, or an active POS identity — the same gate the POS login enforces,
 *  re-checked server-side because the callable, not the client, is the wall. */
async function assertPosIdentity(request) {
  if (request.auth?.token?.email === ADMIN_EMAIL) return;
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("permission-denied", "Sign in required.");
  let active = false;
  try {
    const snap = await admin.database().ref(`users/${uid}/posAccess/isActive`).once("value");
    active = snap.val() === true;
  } catch (err) {
    console.error("eftPool: posAccess check failed:", err.message);
    throw new HttpsError("unavailable", "Could not check access. Try again.");
  }
  if (!active) throw new HttpsError("permission-denied", "POS access required.");
}

/** The cashier's display name as the POS access record knows it — resolved
 *  server-side so a settlement always names a person the owner recognises. */
async function cashierNameOf(request) {
  if (request.auth?.token?.email === ADMIN_EMAIL) return "owner";
  try {
    const snap = await admin.database().ref(`users/${request.auth.uid}/posAccess/displayName`).once("value");
    const name = snap.val();
    if (typeof name === "string" && name.trim()) return name.trim().slice(0, 80);
  } catch { /* fall through to the token */ }
  return String(request.auth?.token?.name || request.auth?.token?.email || request.auth?.uid).slice(0, 80);
}

/**
 * Run one decision as an RTDB transaction on the payment's node.
 *
 * THE NULL-FIRST-CALL TRAP, handled: the Admin SDK calls the update function
 * with null when its cache is cold, and returning undefined THERE aborts
 * without ever consulting the server. So a null current returns null instead —
 * the compare-and-swap then fails against the real server value (unless the
 * record is truly absent, where writing null is a no-op) and the function
 * re-runs with the actual record. The DECISION, not `committed`, is the
 * outcome that matters.
 */
async function runPoolTransaction(key, decide) {
  const ref = admin.database().ref(`${EFT_POOL_PATH}/${key}`);
  let decision = null;
  await ref.transaction((current) => {
    decision = decide(current);
    if (decision.ok && !decision.already) return decision.value;
    if (current === null) return null; // force the server round-trip
    return undefined; // genuine refusal or idempotent no-op: leave the record be
  });
  return decision;
}

function refusalToError(decision) {
  // failed-precondition: the till should refresh its search and tell the
  // cashier the sentence — these are states of the payment, not bugs.
  return new HttpsError("failed-precondition", decision.message, { code: decision.code });
}

// ─── SEARCH ──────────────────────────────────────────────────────────────────
exports.eftPoolSearch = onCall(RUNTIME, async (request) => {
  await assertPosIdentity(request);
  const query = String(request.data?.query ?? "").slice(0, 120);
  // The TAIL, never the node — the pool grows by a record per payment for
  // ever, and a till search is about this week's customers.
  const snap = await admin.database()
    .ref(EFT_POOL_PATH)
    .orderByChild("at")
    .limitToLast(EFT_SEARCH_WINDOW)
    .once("value");
  return searchEftPool(snap.val(), query);
});

// ─── SETTLE / ATTACH / RELEASE ───────────────────────────────────────────────
exports.eftPoolSettle = onCall(RUNTIME, async (request) => {
  await assertPosIdentity(request);
  const data = request.data ?? {};
  const key = poolKeyOf(data);
  const action = String(data.action ?? "");
  const attemptId = String(data.attemptId ?? "").slice(0, 60);
  if (!attemptId) throw new HttpsError("invalid-argument", "The request carries no attempt id.");
  const uid = request.auth.uid;
  const now = Date.now();

  let decision;
  if (action === "settle") {
    const appliedCents = data.appliedCents;
    const cashierName = await cashierNameOf(request);
    decision = await runPoolTransaction(key, (current) => settleDecision(current, {
      attemptId,
      at: now,
      cashierUid: uid,
      cashierName,
      storeId: typeof data.storeId === "string" ? data.storeId.slice(0, 40) : null,
      tillId: typeof data.tillId === "string" ? data.tillId.slice(0, 40) : null,
      customerId: typeof data.customerId === "string" ? data.customerId.slice(0, 60) : null,
      customerName: typeof data.customerName === "string" ? data.customerName.slice(0, 80) : null,
      appliedCents,
    }));
  } else if (action === "attach") {
    decision = await runPoolTransaction(key, (current) => {
      // Holder-only twice over: the attempt id must match AND the settlement
      // must have been made by this very account — an attempt id is not a
      // bearer token another till can replay.
      if (current?.used && current.used.cashierUid !== uid && request.auth?.token?.email !== ADMIN_EMAIL) {
        return { ok: false, code: "not-holder", message: "A different till holds this payment." };
      }
      return attachSaleDecision(current, {
        attemptId,
        saleId: String(data.saleId ?? "").slice(0, 60),
        receiptNumber: data.receiptNumber == null ? null : String(data.receiptNumber).slice(0, 30),
        at: now,
      });
    });
  } else if (action === "release") {
    decision = await runPoolTransaction(key, (current) => {
      if (current?.used && current.used.cashierUid !== uid && request.auth?.token?.email !== ADMIN_EMAIL) {
        return { ok: false, code: "not-holder", message: "A different till holds this payment." };
      }
      return releaseDecision(current, {
        attemptId,
        at: now,
        reason: String(data.reason ?? "the sale did not complete").slice(0, 200),
      });
    });
  } else {
    throw new HttpsError("invalid-argument", `Unknown action "${action}".`);
  }

  if (!decision.ok) throw refusalToError(decision);
  // Access changes on money records should be findable in the function log.
  console.log(`eftPoolSettle: ${action} ${key} by ${uid} (${attemptId})${decision.already ? " [already]" : ""}`);
  return { ok: true, already: decision.already === true };
});

// ─── REVERSE — the owner alone ───────────────────────────────────────────────
exports.eftPoolReverse = onCall(RUNTIME, async (request) => {
  if (request.auth?.token?.email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Only the owner can reverse a settlement.");
  }
  const key = poolKeyOf(request.data);
  const reason = String(request.data?.reason ?? "").trim().slice(0, 300);
  if (!reason) throw new HttpsError("invalid-argument", "A reversal needs a reason — it stays on the record.");
  const decision = await runPoolTransaction(key, (current) => reverseDecision(current, {
    at: Date.now(),
    by: ADMIN_EMAIL,
    reason,
  }));
  if (!decision.ok) throw refusalToError(decision);
  console.log(`eftPoolReverse: ${key} reversed by owner — ${reason}`);
  return { ok: true };
});
