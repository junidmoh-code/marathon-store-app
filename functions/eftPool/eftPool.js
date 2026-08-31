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
//                   The attach also FINISHES THE REMAINDER of a partially
//                   applied payment (finishRemainder): with a customer on the
//                   settlement the difference becomes store credit through the
//                   existing POS mint records (lib/eft-credit.cjs — claim,
//                   canonical credit, mirror, audit, ledger); with none it is
//                   held visibly at /eft_unallocated. Never silently swallowed.
//                   A fourth action, "allocate", is the OWNER assigning a held
//                   remainder to a customer — same mint, same records.
//   eftPoolReverse  owner-only: unwind a completed settlement. Both records
//                   survive — the settlement moves to `reversals` on the pool
//                   record; the sale at /pos/sales is not touched. An issued
//                   remainder credit is NOT clawed back (it may be spent);
//                   the response names it so the owner can remove it.
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
  settleDecision, attachSaleDecision, releaseDecision, reverseDecision, poolTransactionStep,
  allocateRemainderDecision, remainderStatusDecision,
} = require("../lib/eft-settle.cjs");
const {
  buildEftCreditClaim, buildEftCreditRecord, eftCreditSideWrites, buildUnallocatedRecord,
} = require("../lib/eft-credit.cjs");

if (!admin.apps.length) {
  admin.initializeApp({
    databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// Same constant as the POS app's PermissionsContext and posUsers.js.
const ADMIN_EMAIL = "gunidmoh@gmail.com";

// Owner = the admin email AND a VERIFIED one. The owner signs in with Google
// (always verified); requiring the flag closes the theoretical seam where an
// unverified credential claiming the address would inherit owner rights on
// pool projections and reversals. (CodeRabbit, this PR.)
function isOwner(request) {
  return request.auth?.token?.email === ADMIN_EMAIL && request.auth?.token?.email_verified === true;
}

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
  if (isOwner(request)) return;
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
  if (isOwner(request)) return "owner";
  try {
    const snap = await admin.database().ref(`users/${request.auth.uid}/posAccess/displayName`).once("value");
    const name = snap.val();
    if (typeof name === "string" && name.trim()) return name.trim().slice(0, 80);
  } catch { /* fall through to the token */ }
  return String(request.auth?.token?.name || request.auth?.token?.email || request.auth?.uid).slice(0, 80);
}

/**
 * Run one decision as an RTDB transaction on the payment's node. The whole
 * update function — including the Admin SDK's null-first-call handling — is
 * poolTransactionStep (lib/eft-settle.cjs), pure and under test there; this
 * wrapper only owns the ref and the await.
 */
async function runPoolTransaction(key, decide) {
  const ref = admin.database().ref(`${EFT_POOL_PATH}/${key}`);
  let decision = null;
  await ref.transaction(poolTransactionStep(decide, (d) => { decision = d; }));
  return decision;
}

function refusalToError(decision) {
  // failed-precondition: the till should refresh its search and tell the
  // cashier the sentence — these are states of the payment, not bugs.
  return new HttpsError("failed-precondition", decision.message, { code: decision.code });
}

// ─── THE REMAINDER'S FOLLOW-UP IO ────────────────────────────────────────────
// The attach/allocate transaction only STAMPS the remainder plan (pure,
// lib/eft-settle.cjs); this finishes it: mint the store credit, or write the
// visible unallocated hold. Re-entrant on purpose — it acts only while the
// plan says "pending", and a RETRIED attach (idempotent `already`) runs it
// again, so a crash between the transaction and this IO is repaired by the
// till's own retry, by the owner's allocate, or by the POS sweep (the queue
// claim below is durable and sweepStoreCreditQueue verifies it against this
// very pool record).
async function finishRemainder(key) {
  const db = admin.database();
  const record = (await db.ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
  const r = record?.used?.remainder;
  if (!r) return null;
  const summary = { cents: r.cents, disposition: r.disposition, creditId: r.creditId ?? null, status: r.status };
  if (r.status !== "pending") return summary;
  const now = Date.now();

  if (r.disposition === "credit") {
    // The claim FIRST — durable, so the POS sweep can finish a crashed mint.
    const claim = buildEftCreditClaim(key, record, now);
    await db.ref(`pos/storeCreditQueue/${claim.creditId}`).set(claim);
    // Create-if-absent on the DETERMINISTIC credit id: this mint and the POS
    // sweep can both run; exactly one creates the credit. Same pattern —
    // sentinel inside the transaction value included — as the POS mintCredit.
    const { ServerValue } = admin.database;
    const res = await db.ref(`pos/storeCredits/${claim.creditId}`)
      .transaction((cur) => (cur === null ? buildEftCreditRecord(claim, ServerValue.TIMESTAMP) : undefined));
    if (res.committed) {
      const eventKey = db.ref(`pos/audit/store_credit_issued/${claim.customerId}`).push().key;
      const updates = eftCreditSideWrites(claim, {
        eventKey,
        serverTs: ServerValue.TIMESTAMP,
        increment: (n) => ServerValue.increment(n),
      });
      updates[`pos/storeCreditQueue/${claim.creditId}`] = null; // consume the claim
      await db.ref().update(updates);
    } else {
      // Already minted (a retry, or the sweep won) — just clear the claim.
      await db.ref(`pos/storeCreditQueue/${claim.creditId}`).remove();
    }
    await runPoolTransaction(key, (cur) => remainderStatusDecision(cur, { status: "issued", at: Date.now() }));
    console.log(`eftPool: remainder of ${r.cents}c on ${key} issued as store credit ${claim.creditId} to ${claim.customerId}`);
    return { ...summary, status: "issued" };
  }

  // No customer to credit: the difference is HELD, visibly, never swallowed.
  await db.ref(`eft_unallocated/${key}`).set(buildUnallocatedRecord(key, record, now));
  await runPoolTransaction(key, (cur) => remainderStatusDecision(cur, { status: "held", at: Date.now() }));
  console.log(`eftPool: remainder of ${r.cents}c on ${key} HELD unallocated (no customer on the sale)`);
  return { ...summary, status: "held" };
}

/** The owner's allocate names a customer by id or by phone; resolve it
 *  server-side against /customers (records are keyed by a phone-derived id;
 *  both the 0- and 27- shapes are tried, and a merge tombstone is followed to
 *  its survivor — new money must never land on a merged-away record). */
async function resolveCustomer(data) {
  const db = admin.database();
  const tryIds = [];
  if (typeof data.customerId === "string" && data.customerId.trim()) {
    tryIds.push(data.customerId.trim().slice(0, 60));
  }
  const digits = String(data.customerPhone ?? "").replace(/\D/g, "").slice(0, 15);
  if (digits.length >= 9) {
    tryIds.push(digits);
    if (digits.startsWith("0")) tryIds.push(`27${digits.slice(1)}`);
    if (digits.startsWith("27")) tryIds.push(`0${digits.slice(2)}`);
  }
  for (const id of tryIds) {
    let cur = id;
    for (let hops = 0; hops < 3; hops++) {
      const rec = (await db.ref(`customers/${cur}`).once("value")).val();
      if (!rec) break;
      if (rec.mergedInto && typeof rec.mergedInto === "string") { cur = rec.mergedInto; continue; }
      return { id: cur, name: typeof rec.name === "string" ? rec.name.slice(0, 80) : null };
    }
  }
  throw new HttpsError("not-found",
    "No customer record matches that. Create the customer at a till first, then allocate.");
}

// ─── SEARCH ──────────────────────────────────────────────────────────────────
exports.eftPoolSearch = onCall(RUNTIME, async (request) => {
  await assertPosIdentity(request);
  const query = String(request.data?.query ?? "").slice(0, 120);
  // A QUERY IS REQUIRED. An empty search would return the newest payments
  // wholesale — payer names and amounts of customers who have nothing to do
  // with this sale — turning the search into a browsable directory of the
  // pool. The till's modal pre-fills the amount due, so a real sale always
  // arrives here with a query; refusing short ones costs nothing but the
  // enumeration. (Independent architect review, this PR.) The refused call
  // skips the database read entirely.
  if (query.trim().length < 2) return { results: [], searched: 0, needQuery: true };
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
  // The lifecycle actions are holder-scoped and need the attempt id; the
  // owner's allocate acts on a finished settlement and has none.
  if (!attemptId && action !== "allocate") {
    throw new HttpsError("invalid-argument", "The request carries no attempt id.");
  }
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
      if (current?.used && current.used.cashierUid !== uid && !isOwner(request)) {
        return { ok: false, code: "not-holder", message: "A different till holds this payment." };
      }
      return attachSaleDecision(current, {
        attemptId,
        saleId: String(data.saleId ?? "").slice(0, 60),
        receiptNumber: data.receiptNumber == null ? null : String(data.receiptNumber).slice(0, 30),
        at: now,
        poolKey: key,
      });
    });
  } else if (action === "allocate") {
    // The OWNER assigns a held remainder to a customer — the money becomes
    // that customer's store credit through the same mint as everything else.
    if (!isOwner(request)) {
      throw new HttpsError("permission-denied", "Only the owner can allocate a held remainder.");
    }
    const customer = await resolveCustomer(data);
    decision = await runPoolTransaction(key, (current) => allocateRemainderDecision(current, {
      poolKey: key, at: now, customerId: customer.id, customerName: customer.name,
    }));
    if (!decision.ok) throw refusalToError(decision);
    const remainder = await finishRemainder(key);
    // The hold is resolved — take it off the owner's list. (Idempotent; a
    // re-run of an already-credited allocation cleans a leftover hold too.)
    await admin.database().ref(`eft_unallocated/${key}`).remove();
    console.log(`eftPoolSettle: allocate ${key} → customer ${customer.id} by owner`);
    return { ok: true, already: decision.already === true, remainder, customer };
  } else if (action === "release") {
    decision = await runPoolTransaction(key, (current) => {
      if (current?.used && current.used.cashierUid !== uid && !isOwner(request)) {
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
  // An attach finishes its remainder — mint the customer's store credit, or
  // hold the difference visibly. Re-run on a RETRIED attach too (`already`),
  // which is exactly what repairs a crash between the stamp and the IO.
  let remainder = null;
  if (action === "attach") {
    try {
      remainder = await finishRemainder(key);
    } catch (e) {
      // The sale is recorded and the plan is stamped on the pool record; the
      // durable claim/hold may be missing until a retry, the owner's panel, or
      // the POS sweep finishes it. Never fail the attach over it.
      console.error(`eftPool: remainder follow-up failed on ${key} — the plan stays "pending" and is visible:`, e);
    }
  }
  return { ok: true, already: decision.already === true, remainder };
});

// ─── REVERSE — the owner alone ───────────────────────────────────────────────
exports.eftPoolReverse = onCall(RUNTIME, async (request) => {
  if (!isOwner(request)) {
    throw new HttpsError("permission-denied", "Only the owner can reverse a settlement.");
  }
  const key = poolKeyOf(request.data);
  const reason = String(request.data?.reason ?? "").trim().slice(0, 300);
  if (!reason) throw new HttpsError("invalid-argument", "A reversal needs a reason — it stays on the record.");
  const at = Date.now();
  const decision = await runPoolTransaction(key, (current) => reverseDecision(current, {
    at,
    by: ADMIN_EMAIL,
    reason,
  }));
  if (!decision.ok) throw refusalToError(decision);
  // The payment returns whole, so a held remainder is no longer held — take it
  // off the owner's list. A remainder ALREADY ISSUED as store credit is NOT
  // clawed back (the customer may have spent it); the reversal record keeps
  // its creditId, and the response says so, so the owner can remove the credit
  // through the existing remove-credit flow if that is the right call.
  await admin.database().ref(`eft_unallocated/${key}`).remove();
  const reversedRemainder = decision.value?.reversals?.[at]?.remainder ?? null;
  const creditStands = reversedRemainder?.status === "issued" ? reversedRemainder.creditId : null;
  console.log(`eftPoolReverse: ${key} reversed by owner — ${reason}${creditStands ? ` (store credit ${creditStands} STANDS — remove it separately if wrong)` : ""}`);
  return { ok: true, creditStands };
});
