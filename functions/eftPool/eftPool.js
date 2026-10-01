// ─── EFT POOL CALLABLES — how the till reaches an owner-only node ────────────
// /eft_pool is owner-only by rule, deliberately: a pool record carries the
// payer's name, the notification's own text and Gmail's authentication
// transcript — other customers' payment data. The cashier settling an EFT sale
// still has to find a payment in it, so the POS goes through these callables:
// the Admin SDK reads the pool server-side and returns ONLY the projection the
// search needs (lib/eft-pool.cjs publicEftView). Staff never gain client read
// on the node, and no rule change ships with this build.
//
//   eftPoolSearch   any active POS identity: find THE payment the customer
//                   names by its REFERENCE or the bank's TRANSACTION ID, typed
//                   in full (one typo tolerated on a long reference). At most
//                   ONE result, payer as initials only; an ambiguous query
//                   returns nothing. Never by amount (an amount field is
//                   refused outright), never by name, no listing, no
//                   suggestions. A used payment answers as used — when and
//                   which slip — never whose sale or which cashier (fix 2,
//                   lib/eft-pool.cjs).
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
//                   A fifth, "markUsed", is a payment marked as settled
//                   OUTSIDE the POS (no sale attached; the actor's uid and
//                   NAME and server time on the record, and a REQUIRED
//                   reason — fix 4). The owner, OR a uid the owner has given
//                   the eftReview capability to on an account confirmed as
//                   ONE PERSON'S (posAccess.eftReview + individual on an
//                   ACTIVE account, granted from the POS users screen and
//                   re-read here on every call, so revoking it takes effect on
//                   the next one. The SAME transaction as a till's settle, so
//                   it cannot race a till into a double-settle; undone only by
//                   eftPoolReverse, which stays the OWNER ALONE and keeps both
//                   records.
//                   A sixth, "releaseHold", is the OWNER releasing a payment
//                   the poller HELD for carrying no bank transaction id (fix 1)
//                   — checked on the statement, reason on the record. A held
//                   DUPLICATE is never released.
//   FIX 1 — ONE BANK TRANSACTION, ONE SPENDABLE RECORD. Before a settle, the
//                   payment's fingerprint (lib/eft-fingerprint.cjs: the bank's
//                   own transaction id) is checked against the pool tail and
//                   CLAIMED at /eft_pool_fingerprints — a resent copy, or one
//                   of two copies raced at two tills, is refused; a payment
//                   with no bank id is refused unless the owner released it.
//                   The settle transaction re-derives the fingerprint from the
//                   value it commits.
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
//   firebase deploy --only functions:eftPoolSearch,functions:eftPoolSettle,functions:eftPoolReverse,functions:eftRemainderScan

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

const { EFT_POOL_PATH, EFT_SEARCH_WINDOW, EFT_MIN_QUERY, normaliseText, searchEftPool } = require("../lib/eft-pool.cjs");
const {
  settleDecision, attachSaleDecision, releaseDecision, reverseDecision, poolTransactionStep,
  allocateRemainderDecision, remainderStatusDecision, pendingRemainderScanAction,
  markUsedOutsidePosDecision, OUTSIDE_POS_REASON_MAX, OUTSIDE_POS_REASON_MIN, releaseHoldDecision,
  saleCheckOf, flagSaleMismatchDecision, laterSaleCheckDecision,
} = require("../lib/eft-settle.cjs");
const {
  EFT_FINGERPRINT_PATH, fingerprintClaimStep, consumeFingerprintCheck, claimHolderCheck, paymentFingerprint,
  EFT_FP_BACKFILL_PATH, EFT_FP_BACKFILL_PAGE, backfillSpentStep,
} = require("../lib/eft-fingerprint.cjs");
const {
  buildEftCreditClaim, buildEftCreditRecord, eftCreditMirrorRecord, eftCreditAuditRecord,
  ledgerApplyDecision, buildUnallocatedRecord,
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

/**
 * Owner, or a uid the OWNER has given the eftReview capability to — an ACTIVE
 * POS account with posAccess.eftReview === true AND posAccess.individual ===
 * true. Returns the ACTOR'S NAME as the access record knows it.
 *
 * FIX 4 — ONE PERSON, NOT A SHARED LOGIN. A mark-as-used has no sale, no slip
 * and no customer; the actor is its only accountability. posAccess had no
 * notion of a login being one person's, so eftReview on a shared till login
 * let anyone at that till mark money as settled. `individual` is the owner's
 * attestation, given in the SAME step as granting eftReview on the POS users
 * screen ("this login is one named person's own"), and both are re-read here
 * on every call — revoking either takes effect on the next one. The name must
 * come off that record: no display name, no mark (never a token fallback).
 *
 * WHAT IT GRANTS HERE IS EXACTLY ONE ACTION — marking a payment as settled
 * outside the POS. Reversing stays the owner alone (eftPoolReverse).
 */
async function assertEftReviewer(request) {
  if (isOwner(request)) return "owner";
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("permission-denied", "Sign in required.");
  let access = null;
  try {
    const snap = await admin.database().ref(`users/${uid}/posAccess`).once("value");
    access = snap.val();
  } catch (err) {
    // A read that FAILED is not an absent grant. "unavailable" says try again;
    // "permission-denied" would teach a holder their access had been taken.
    console.error("eftPool: eftReview check failed:", err.message);
    throw new HttpsError("unavailable", "Could not check access. Try again.");
  }
  if (access?.isActive !== true || access?.eftReview !== true) {
    throw new HttpsError("permission-denied", "Only the owner, or someone given EFT review, can mark a payment as settled outside the POS.");
  }
  if (access?.individual !== true) {
    throw new HttpsError("permission-denied", "This login is not confirmed as one person's own. Marking a payment as settled needs a personal login — Junid can confirm it on the POS users screen.", { code: "not-individual" });
  }
  const name = typeof access.displayName === "string" ? access.displayName.trim() : "";
  if (!name) {
    throw new HttpsError("permission-denied", "This login has no name on its POS record, so a mark could not say who made it.", { code: "no-actor-name" });
  }
  return name.slice(0, 80);
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

/** The pool's TAIL, never the node — the same bounded read the search makes. */
async function readPoolTail() {
  const snap = await admin.database()
    .ref(EFT_POOL_PATH)
    .orderByChild("at")
    .limitToLast(EFT_SEARCH_WINDOW)
    .once("value");
  return snap.val() || {};
}

/**
 * FIX 1 — the bank's transaction id, checked before a payment is spent.
 * Read the record and the pool tail; refuse a payment with no bank id (unless
 * the owner released it), and a copy of one already used; then CLAIM the
 * fingerprint for this record — create-only, so of two copies racing at two
 * tills exactly one holds it — and refuse unless the claim names this record.
 * Returns the fingerprint the settle transaction must see again. A record
 * that is missing or not a payment is left to settleDecision's own refusal.
 */
async function checkPaymentFingerprint(key, now) {
  const db = admin.database();
  const record = (await db.ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
  if (!record || record.outcome !== "recorded") return null;
  const tail = await readPoolTail();
  const check = consumeFingerprintCheck({ poolKey: key, record, siblings: Object.entries(tail) });
  if (!check.ok) {
    console.warn(`eftPoolSettle: ${check.code} on ${key} — refused before settle`);
    throw refusalToError(check);
  }
  if (!check.fingerprint) return null; // owner-released no-bank-id payment
  let claim = null;
  await db.ref(`${EFT_FINGERPRINT_PATH}/${check.fingerprint}`)
    .transaction(fingerprintClaimStep(key, now, (d) => { claim = d; }));
  const holder = claimHolderCheck({ poolKey: key, holder: claim?.holder ?? null, spentBy: claim?.spentBy ?? null });
  if (!holder.ok) {
    console.warn(`eftPoolSettle: ${holder.code} on ${key} — fingerprint held by ${claim?.holder ?? "nothing usable"}`);
    throw refusalToError(holder);
  }
  return check.fingerprint;
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
// The durable breadcrumb that makes a mid-flight remainder FINDABLE: written
// BEFORE the transaction that stamps (or re-enters) a remainder plan, cleared
// when the plan reaches a terminal state. Without it, a crash between the
// attach transaction and the follow-up IO leaves a "pending" plan whose only
// window is the owner panel's bounded tail — which 25 newer payments scroll
// it off of. eftRemainderScan walks this node and re-runs finishRemainder.
// (Independent architect review, this PR — the same failure class as #332's
// "requests with no engine lock are invisible".)
const PENDING_PATH = "eft_pending_remainders";

async function finishRemainder(key) {
  const db = admin.database();
  const record = (await db.ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
  const r = record?.used?.remainder;
  if (!r) {
    await db.ref(`${PENDING_PATH}/${key}`).remove(); // nothing to finish — no breadcrumb either
    return null;
  }
  const summary = { cents: r.cents, disposition: r.disposition, creditId: r.creditId ?? null, status: r.status };
  if (r.status !== "pending") {
    await db.ref(`${PENDING_PATH}/${key}`).remove(); // already terminal — clear a stale breadcrumb
    return summary;
  }
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
    if (!res.committed) {
      // Already minted (a retry, or the sweep won). Paranoia that costs one
      // read: the standing record must be THIS remainder's. A mismatch means
      // two settlements produced the same deterministic id, which the id's
      // construction is meant to preclude — if it ever logs, money is wrong
      // and a human must look (the sides below are then NOT applied).
      const standing = (await db.ref(`pos/storeCredits/${claim.creditId}`).once("value")).val();
      if (standing && (standing.customerId !== claim.customerId || standing.issuedAmount !== claim.amount)) {
        console.error(`eftPool: CREDIT ID COLLISION on ${claim.creditId} — standing record differs from this remainder (${standing.customerId}/${standing.issuedAmount} vs ${claim.customerId}/${claim.amount}). Investigate before trusting either.`);
        await db.ref(`pos/storeCreditQueue/${claim.creditId}`).remove();
        return { ...summary, status: "pending" };
      }
    }
    // The side writes run on EVERY pass — fresh mint and repair alike — and
    // each is create-only, so a crash after any step is healed by the next
    // retry and nothing double-applies. The ledger transaction records the
    // txn and moves the balance atomically; the mirror is create-only because
    // redemptions decrement it. (CodeRabbit, this PR.)
    await db.ref(`customers/${claim.customerId}/storeCredit/${claim.creditId}`)
      .transaction((cur) => (cur === null ? eftCreditMirrorRecord(claim, ServerValue.TIMESTAMP) : undefined));
    await db.ref(`pos/audit/store_credit_issued/${claim.customerId}/sc_${claim.creditId}`)
      .transaction((cur) => (cur === null ? eftCreditAuditRecord(claim, ServerValue.TIMESTAMP) : undefined));
    await db.ref(`pos/creditLedger/${claim.customerId}`)
      .transaction((cur) => ledgerApplyDecision(cur, claim, ServerValue.TIMESTAMP));
    await db.ref(`pos/storeCreditQueue/${claim.creditId}`).remove(); // sides landed — consume the claim
    const flip = await runPoolTransaction(key, (cur) => remainderStatusDecision(cur, { status: "issued", at: Date.now() }));
    if (!flip.ok) {
      // The one way this refuses: the owner REVERSED the settlement while the
      // mint was in flight, so `used` is gone. The credit is real and
      // spendable but the reversal record still says "pending" — say so
      // loudly, or the discrepancy is only visible on the customer's balance.
      console.error(`eftPool: credit ${claim.creditId} minted but the settlement on ${key} was reversed mid-flight — the credit STANDS; remove it from the customer if the reversal meant to void it.`);
    }
    await db.ref(`${PENDING_PATH}/${key}`).remove(); // terminal — breadcrumb done
    console.log(`eftPool: remainder of ${r.cents}c on ${key} issued as store credit ${claim.creditId} to ${claim.customerId}`);
    return { ...summary, status: "issued" };
  }

  // No customer to credit: the difference is HELD, visibly, never swallowed.
  await db.ref(`eft_unallocated/${key}`).set(buildUnallocatedRecord(key, record, now));
  await runPoolTransaction(key, (cur) => remainderStatusDecision(cur, { status: "held", at: Date.now() }));
  await db.ref(`${PENDING_PATH}/${key}`).remove(); // terminal — /eft_unallocated is the record now
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
  // A customer id becomes an RTDB path segment — charset-validate it like
  // every other path input here (poolKeyOf's regex is the model), not just
  // length-cap it. Real ids are phone digits or push keys: [-\w] covers both.
  if (typeof data.customerId === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(data.customerId.trim())) {
    tryIds.push(data.customerId.trim());
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
      if (typeof rec.mergedInto === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(rec.mergedInto)) { cur = rec.mergedInto; continue; }
      return { id: cur, name: typeof rec.name === "string" ? rec.name.slice(0, 80) : null };
    }
  }
  throw new HttpsError("not-found",
    "No customer record matches that. Create the customer at a till first, then allocate.");
}

/** A customer id followed through merge tombstones to its survivor — the same
 *  walk resolveCustomer does, without throwing. Null in, null out. */
async function followMerges(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(id)) return id ?? null;
  let cur = id;
  for (let hops = 0; hops < 3; hops++) {
    const merged = (await admin.database().ref(`customers/${cur}/mergedInto`).once("value")).val();
    if (typeof merged !== "string" || !/^[A-Za-z0-9_-]{1,60}$/.test(merged)) return cur;
    cur = merged;
  }
  return cur;
}

// FIX 5, LATER HALF — an attach made while the sale was not on the server is
// verified by eftRemainderScan from this breadcrumb (key → {at, saleId}).
const SALE_CHECK_PATH = "eft_pending_sale_checks";
const SALE_CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ─── SEARCH ──────────────────────────────────────────────────────────────────
exports.eftPoolSearch = onCall(RUNTIME, async (request) => {
  await assertPosIdentity(request);
  const data = request.data ?? {};
  // AMOUNT IS NOT A SEARCH KEY — not hidden in the UI, refused at the door.
  // "550" finds ANY R550 payment, which is how one customer's sale gets
  // settled against another customer's money with neither of them able to
  // tell. A till build that still sends an amount field is refused loudly
  // rather than quietly answered with nothing.
  if (data.amount != null || data.amountCents != null) {
    throw new HttpsError("invalid-argument", "Amount is not a search key — search by the payment reference or the bank's transaction id.");
  }
  const query = String(data.query ?? "").slice(0, 120);
  // A QUERY IS REQUIRED — three characters of letters and digits at least. An
  // empty or short search would return the newest payments wholesale — payer
  // names and amounts of customers who have nothing to do with this sale —
  // turning the search into a browsable directory of the pool. The refused
  // call skips the database read entirely. (searchEftPool applies the same
  // floor after normalisation, so a query of punctuation is refused too.)
  if (normaliseText(query).length < EFT_MIN_QUERY) return { results: [], searched: 0, needQuery: true };
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
  // owner's allocate acts on a finished settlement and has none, and the
  // owner's markUsed mints its own (the mark's moment) inside the decision.
  if (!attemptId && action !== "allocate" && action !== "markUsed" && action !== "releaseHold") {
    throw new HttpsError("invalid-argument", "The request carries no attempt id.");
  }
  const uid = request.auth.uid;
  const now = Date.now();

  let decision;
  if (action === "settle") {
    const appliedCents = data.appliedCents;
    const cashierName = await cashierNameOf(request);
    // FIX 3 — THE CUSTOMER IS RESOLVED HERE, NOT TAKEN FROM THE TILL. The
    // sale's attached customer must exist in /customers (a merge followed to
    // its survivor), and the till must send the SAME id back as the one the
    // cashier explicitly confirmed as the payer. The name on the settlement is
    // the record's, never the till's.
    const sentId = typeof data.customerId === "string" ? data.customerId.trim() : "";
    if (!sentId) {
      throw new HttpsError("failed-precondition", "Attach the customer who made this payment to the sale first — an EFT payment is only applied to a confirmed customer.", { code: "no-customer" });
    }
    if (data.confirmedCustomerId !== sentId) {
      throw new HttpsError("failed-precondition", "Confirm that this payment belongs to the customer on the sale before using it.", { code: "not-confirmed" });
    }
    const customer = await resolveCustomer({ customerId: sentId });
    const fingerprint = await checkPaymentFingerprint(key, now);
    decision = await runPoolTransaction(key, (current) => settleDecision(current, {
      fingerprint,
      customerResolved: true,
      confirmedCustomerId: customer.id,
      attemptId,
      at: now,
      cashierUid: uid,
      cashierName,
      storeId: typeof data.storeId === "string" ? data.storeId.slice(0, 40) : null,
      tillId: typeof data.tillId === "string" ? data.tillId.slice(0, 40) : null,
      customerId: customer.id,
      customerName: customer.name,
      appliedCents,
    }));
  } else if (action === "attach") {
    // THE BREADCRUMB GOES FIRST. If this attach will stamp a remainder (or a
    // stamped one is still pending from a crashed earlier attempt), a durable
    // marker must exist BEFORE the transaction — a crash anywhere after it
    // leaves something eftRemainderScan can find, instead of a "pending" plan
    // whose only window is a bounded tail. A refused attach cleans it up; a
    // stale one is cleared by the scan.
    try {
      const pre = (await admin.database().ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
      const willRemainder = pre?.used
        && Number.isInteger(pre.amountCents) && Number.isInteger(pre.used.appliedCents)
        && pre.amountCents > pre.used.appliedCents;
      const stillPending = pre?.used?.remainder?.status === "pending";
      if (willRemainder || stillPending) {
        await admin.database().ref(`${PENDING_PATH}/${key}`).set({ at: now });
      }
    } catch (e) {
      // The attach itself must not fail over the breadcrumb — the scan and the
      // panel are layers, not the mechanism.
      console.error(`eftPool: breadcrumb write failed for ${key}:`, e);
    }
    // FIX 5 — READ THE COMMITTED SALE BACK. Its EFT legs for this payment
    // must add up to exactly what was settled, and it must name the confirmed
    // customer (saleCheckOf). A sale id is a push key — charset-checked before
    // it becomes a path. One record read, never the node.
    const saleId = String(data.saleId ?? "").slice(0, 60);
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(saleId)) throw new HttpsError("invalid-argument", "That is not a sale id.");
    const [saleSnap, heldSnap] = await Promise.all([
      admin.database().ref(`pos/sales/${saleId}`).once("value"),
      admin.database().ref(`${EFT_POOL_PATH}/${key}/used`).once("value"),
    ]);
    const sale = saleSnap.val();
    const saleCheck = saleCheckOf({
      poolKey: key, used: heldSnap.val(), sale,
      saleCustomerId: sale ? await followMerges(sale.customerId ?? null) : undefined,
    });
    if (saleCheck.state === "absent") {
      // Durable BEFORE the attach transaction: the scan verifies this sale
      // when it reaches the server, and flags it if it never does.
      await admin.database().ref(`${SALE_CHECK_PATH}/${key}`).set({ at: now, saleId });
    }
    if (saleCheck.state === "mismatch") {
      // Evidence first, on the payment itself, where the owner's tab shows it.
      // Only the holder's own attach may leave that evidence.
      await runPoolTransaction(key, (current) => (
        current?.used && (current.used.cashierUid === uid || isOwner(request)) && current.used.attemptId === attemptId
          ? flagSaleMismatchDecision(current, { saleId, legCents: saleCheck.legCents, why: saleCheck.why, at: now })
          : { ok: false, code: "not-holder", message: "not the holder" }));
      console.error(`EFT_SALE_MISMATCH: ${key} sale ${saleId} by ${uid} — ${saleCheck.why}`);
    }
    decision = await runPoolTransaction(key, (current) => {
      // Holder-only twice over: the attempt id must match AND the settlement
      // must have been made by this very account — an attempt id is not a
      // bearer token another till can replay.
      if (current?.used && current.used.cashierUid !== uid && !isOwner(request)) {
        return { ok: false, code: "not-holder", message: "A different till holds this payment." };
      }
      return attachSaleDecision(current, {
        attemptId,
        saleId,
        receiptNumber: data.receiptNumber == null ? null : String(data.receiptNumber).slice(0, 30),
        at: now,
        poolKey: key,
        saleCheck,
      });
    });
  } else if (action === "allocate") {
    // The OWNER assigns a held remainder to a customer — the money becomes
    // that customer's store credit through the same mint as everything else.
    if (!isOwner(request)) {
      throw new HttpsError("permission-denied", "Only the owner can allocate a held remainder.");
    }
    const customer = await resolveCustomer(data);
    // Same breadcrumb discipline as attach: durable BEFORE the transaction,
    // cleared when finishRemainder reaches a terminal state.
    await admin.database().ref(`${PENDING_PATH}/${key}`).set({ at: now });
    decision = await runPoolTransaction(key, (current) => allocateRemainderDecision(current, {
      poolKey: key, at: now, customerId: customer.id, customerName: customer.name,
    }));
    if (!decision.ok) throw refusalToError(decision);
    // The allocation is COMMITTED at this point — a follow-up failure must not
    // read as "allocation failed" (the owner would retry with a different
    // customer and hit already-credited). Report the pending state instead;
    // the remainder scan finishes it within minutes. (CodeRabbit, this PR.)
    let remainder = null;
    try {
      remainder = await finishRemainder(key);
      // The hold is resolved — take it off the owner's list. (Idempotent; a
      // re-run of an already-credited allocation cleans a leftover hold too.)
      await admin.database().ref(`eft_unallocated/${key}`).remove();
    } catch (e) {
      console.error(`eftPool: allocate committed on ${key} but the mint follow-up failed (the scan will finish it):`, e);
    }
    console.log(`eftPoolSettle: allocate ${key} → customer ${customer.id} by owner`);
    return { ok: true, already: decision.already === true, remainder, customer };
  } else if (action === "markUsed") {
    // MARK-AS-USED: a payment settled outside the POS (paid before the pool
    // existed, matched on a statement, refunded in cash) is marked used with NO
    // sale attached. The OWNER, or someone the owner has given eftReview —
    // enforced HERE, because a hidden button is not the control. It runs through
    // the very same transaction as a till's settle (markUsedOutsidePosDecision
    // delegates to settleDecision), so a till settling the same payment in the
    // same instant still gets exactly one winner. Undone only by eftPoolReverse,
    // which is the owner ALONE and keeps both records.
    const actorName = await assertEftReviewer(request);
    // REQUIRED (fix 4): the typed reason is the only account of where money
    // with no sale went. Refused here before any transaction, and again inside
    // markUsedOutsidePosDecision.
    const reason = String(data.reason ?? "").trim().slice(0, OUTSIDE_POS_REASON_MAX);
    if (reason.length < OUTSIDE_POS_REASON_MIN) {
      throw new HttpsError("invalid-argument", "Say how this payment was settled outside the POS — the reason stays on the record.", { code: "bad-reason" });
    }
    decision = await runPoolTransaction(key, (current) => markUsedOutsidePosDecision(current, {
      at: now, actorUid: uid, actorName, reason,
    }));
    if (!decision.ok) throw refusalToError(decision);
    // A marked payment's fingerprint is claimed too (create-only, best
    // effort): a pre-fix copy of it can then never be spent later, even once
    // the marked record has scrolled out of the settle's sibling window.
    try {
      const marked = (await admin.database().ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
      const fp = paymentFingerprint(marked ?? {});
      if (fp) await admin.database().ref(`${EFT_FINGERPRINT_PATH}/${fp}`).transaction(fingerprintClaimStep(key, now));
    } catch (e) {
      console.error(`eftPoolSettle: markUsed ${key} — fingerprint claim failed (the sibling check still covers the tail):`, e?.message || e);
    }
    console.log(`eftPoolSettle: markUsed ${key} by ${actorName} (${uid}) — ${reason}`);
    // WHAT WAS ACTUALLY STAMPED travels back, so a caller repainting a card in
    // place shows the record rather than its own guess at it. Without this the
    // phone screen had to invent a name and a moment, and they could differ
    // from the ones on the record until the next full reload.
    return { ok: true, already: decision.already === true, remainder: null, actorName, at: now, reason };
  } else if (action === "releaseHold") {
    // FIX 1 — THE OWNER ALONE releases a payment held for having no bank
    // transaction id, after checking it on the statement. A held duplicate is
    // never released (releaseHoldDecision refuses it).
    if (!isOwner(request)) {
      throw new HttpsError("permission-denied", "Only the owner can release a held payment.");
    }
    const reason = String(data.reason ?? "").trim().slice(0, 300);
    decision = await runPoolTransaction(key, (current) => releaseHoldDecision(current, { at: now, by: ADMIN_EMAIL, reason }));
    if (!decision.ok) throw refusalToError(decision);
    console.log(`eftPoolSettle: releaseHold ${key} by owner — ${reason}`);
    return { ok: true };
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
  await admin.database().ref(`${PENDING_PATH}/${key}`).remove();
  const reversedRemainder = decision.value?.reversals?.[at]?.remainder ?? null;
  // A claim that never minted anchors on a settlement that no longer exists —
  // the POS sweep would refuse it on every run for ever. It is the reversal's
  // mess; the reversal cleans it. (Independent architect review, this PR.)
  if (reversedRemainder?.creditId && reversedRemainder.status !== "issued") {
    await admin.database().ref(`pos/storeCreditQueue/${reversedRemainder.creditId}`).remove();
  }
  const creditStands = reversedRemainder?.status === "issued" ? reversedRemainder.creditId : null;
  console.log(`eftPoolReverse: ${key} reversed by owner — ${reason}${creditStands ? ` (store credit ${creditStands} STANDS — remove it separately if wrong)` : ""}`);
  return { ok: true, creditStands };
});

// ─── THE REMAINDER SCAN — nothing pending stays pending ──────────────────────
// Walks /eft_pending_remainders (small by construction: breadcrumbs are
// written per in-flight remainder and cleared at terminal state) and finishes
// any remainder whose follow-up IO crashed — the mint or the unallocated hold
// runs at most a few minutes late instead of never. Fresh breadcrumbs are the
// live callable's business; stale ones with nothing to finish (a refused
// attach, a reversal) are cleared. A breadcrumb that keeps failing logs the
// EFT_REMAINDER_STUCK marker for the log-based alerting to pick up.
//   firebase deploy --only functions:eftRemainderScan
const SCAN_MIN_AGE_MS = 2 * 60 * 1000;
exports.eftRemainderScan = onSchedule(
  { schedule: "every 5 minutes", region: "europe-west1", timeoutSeconds: 120, memory: "256MiB" },
  async () => {
    const db = admin.database();
    const pending = (await db.ref(PENDING_PATH).once("value")).val() || {};
    const now = Date.now();
    let finished = 0, cleared = 0, waited = 0, stuck = 0;
    for (const [key, crumb] of Object.entries(pending)) {
      if (!/^[0-9a-f]{40}$/.test(key)) { // never let a stray child become a path
        await db.ref(`${PENDING_PATH}/${key}`).remove(); cleared++; continue;
      }
      try {
        const record = (await db.ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
        const action = pendingRemainderScanAction(crumb, record, now, SCAN_MIN_AGE_MS);
        if (action === "wait") { waited++; continue; }
        if (action === "clear") { await db.ref(`${PENDING_PATH}/${key}`).remove(); cleared++; continue; }
        await finishRemainder(key); // clears the breadcrumb itself at terminal state
        finished++;
      } catch (err) {
        stuck++;
        console.error(`EFT_REMAINDER_STUCK: ${key} could not be finished —`, err?.message || err);
      }
    }
    // FIX 1, ONE-TIME BACKFILL: spent pre-fix payments stamp their claims.
    // One bounded page per run (orderByKey + startAfter cursor), never the
    // node; a sentinel says when it is done and it never runs again.
    let backfilled = 0;
    try {
      const state = (await db.ref(EFT_FP_BACKFILL_PATH).once("value")).val() || {};
      if (state.done !== true) {
        let q = db.ref(EFT_POOL_PATH).orderByKey();
        if (typeof state.cursor === "string") q = q.startAfter(state.cursor);
        const snap = await q.limitToFirst(EFT_FP_BACKFILL_PAGE).once("value");
        // The cursor follows the DATABASE's key order (forEach), never a JS
        // sort, so startAfter can neither skip nor repeat a record.
        const keys = [];
        snap.forEach((child) => { keys.push(child.key); });
        const page = snap.val() || {};
        for (const k of keys) {
          const rec = page[k];
          if (rec?.outcome !== "recorded" || rec.status !== "used") continue;
          const fp = paymentFingerprint(rec);
          if (!fp) continue;
          // One bad record must not stall every page after it: logged, then
          // the walk moves on.
          try {
            await db.ref(`${EFT_FINGERPRINT_PATH}/${fp}`).transaction(backfillSpentStep(k, now));
            backfilled++;
          } catch (err) {
            console.error(`EFT_FP_BACKFILL_RECORD_FAILED: ${k} —`, err?.message || err);
          }
        }
        await db.ref(EFT_FP_BACKFILL_PATH).set(keys.length < EFT_FP_BACKFILL_PAGE
          ? { done: true, at: now, cursor: keys[keys.length - 1] ?? state.cursor ?? null }
          : { done: false, at: now, cursor: keys[keys.length - 1] });
      }
    } catch (err) {
      console.error("EFT_FP_BACKFILL_STUCK:", err?.message || err);
    }

    // FIX 5, LATER HALF: attaches made before their sale reached the server.
    const checks = (await db.ref(SALE_CHECK_PATH).once("value")).val() || {};
    let verified = 0, flagged = 0;
    for (const [key, crumb] of Object.entries(checks)) {
      const saleId = typeof crumb?.saleId === "string" ? crumb.saleId : "";
      if (!/^[0-9a-f]{40}$/.test(key) || !/^[A-Za-z0-9_-]{1,60}$/.test(saleId)) {
        await db.ref(`${SALE_CHECK_PATH}/${key}`).remove(); cleared++; continue;
      }
      try {
        const [saleSnap, usedSnap] = await Promise.all([
          db.ref(`pos/sales/${saleId}`).once("value"),
          db.ref(`${EFT_POOL_PATH}/${key}/used`).once("value"),
        ]);
        const sale = saleSnap.val();
        const saleCheck = saleCheckOf({
          poolKey: key, used: usedSnap.val(), sale,
          saleCustomerId: sale ? await followMerges(sale.customerId ?? null) : undefined,
        });
        const ageMs = now - (Number.isInteger(crumb.at) ? crumb.at : 0);
        const d = await runPoolTransaction(key, (cur) => laterSaleCheckDecision(cur, {
          saleId, saleCheck, at: Date.now(), ageMs, maxAgeMs: SALE_CHECK_MAX_AGE_MS,
        }));
        if (d.outcome === "wait") { waited++; continue; }
        if (d.outcome === "flagged") {
          flagged++;
          console.error(`EFT_SALE_MISMATCH: ${key} sale ${saleId} — ${saleCheck.state === "mismatch" ? saleCheck.why : "never reached the server"}`);
        } else if (d.outcome === "done") verified++;
        await db.ref(`${SALE_CHECK_PATH}/${key}`).remove();
      } catch (err) {
        stuck++;
        console.error(`EFT_SALE_CHECK_STUCK: ${key} could not be checked —`, err?.message || err);
      }
    }
    console.log("eftRemainderScan done", JSON.stringify({ finished, cleared, waited, stuck, verified, flagged, backfilled }));
  },
);
