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
//                   in full (one typo tolerated on a long reference). One
//                   result — or one row per payment when separate payments
//                   share the reference — payer as initials only; an
//                   ambiguous query returns nothing. Never by amount (an amount field is
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
//   eftEnforcementStatus  ENFORCEMENT (Junid, 17 Oct 2026). At an ENFORCED
//                   store — Trophy and Marathon PE by default — the till closes
//                   its "EFT without matching" path: an EFT sale must consume a
//                   confirmed pool payment through the settle above. The set is
//                   the /eft_enforcement node (lib/eft-enforce.cjs), read here
//                   for the till (any active POS identity) and WRITTEN here by
//                   the owner alone ("set") — no deploy to add or remove a
//                   store. eftRemainderScan walks new sales and flags any EFT
//                   leg with no pool key at an enforced store
//                   (/eft_enforcement_breaches, EFT_ENFORCEMENT_BREACH).
//   eftPoolManualEntry  JUNID'S ESCAPE HATCH (lib/eft-manual.cjs). The owner
//                   account ALONE — not managers, not eftReview holders;
//                   isOwner() checked here, never the UI — types a customer
//                   reference and an amount, and a SPENDABLE pool record is
//                   created: reader "manual", stamped manualEntry {by:
//                   "Junid", uid, email, at: server time}, a synthetic
//                   fingerprint claimed create-only at entry. A cashier finds
//                   and consumes it through the ordinary search/settle above
//                   — single-use by the same transaction — and the till shows
//                   it exactly like a bank-confirmed payment (no manual mark
//                   reaches it); the pool record, the log and Junid's review
//                   carry the provenance. Idempotent per
//                   entryId; a second entry of the same reference and amount
//                   is refused.
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
//   eftPoolManualApprove  JUNID ALONE (29 Oct 2026): the phone uploads a proof
//                   of payment PDF; it is read by the same per-bank reader the
//                   poller uses, its identity (bank transaction id, or Absa's
//                   synthetic identity) is registered as APPROVED BY HAND —
//                   a used pool record plus a fingerprint claim naming it as
//                   spender — so the bank's later notification is filed as
//                   already settled, never floated again. Floats nothing;
//                   manual entry (above) stays instant and proof-free.
//                   A PHOTO (jpg/png/heic) is accepted too: Junid types the
//                   identity from it (no OCR) and the image is kept in
//                   Storage at eftProofs/{key}/{entryId}.{ext}.
//   firebase deploy --only functions:eftPoolSearch,functions:eftPoolSettle,functions:eftPoolReverse,functions:eftRemainderScan,functions:eftEnforcementStatus,functions:eftPoolManualEntry,functions:eftPoolManualApprove

"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const { EFT_POOL_PATH, EFT_SEARCH_WINDOW, EFT_MIN_QUERY, normaliseText, searchEftPool } = require("../lib/eft-pool.cjs");
const {
  settleDecision, attachSaleDecision, releaseDecision, reverseDecision, poolTransactionStep,
  allocateRemainderDecision, remainderStatusDecision, pendingRemainderScanAction,
  markUsedOutsidePosDecision, OUTSIDE_POS_REASON_MAX, OUTSIDE_POS_REASON_MIN, releaseHoldDecision,
  saleCheckOf, flagSaleMismatchDecision, laterSaleCheckDecision, formatRand, promotableHoldOf, awaitingSaleHoldOf,
} = require("../lib/eft-settle.cjs");
const {
  EFT_FINGERPRINT_PATH, fingerprintClaimStep, consumeFingerprintCheck, claimHolderCheck, paymentFingerprint,
  EFT_FP_BACKFILL_PATH, EFT_FP_BACKFILL_PAGE, backfillSpentStep,
} = require("../lib/eft-fingerprint.cjs");
const {
  buildEftCreditClaim, buildEftCreditRecord, eftCreditMirrorRecord, eftCreditAuditRecord,
  ledgerApplyDecision, buildUnallocatedRecord,
} = require("../lib/eft-credit.cjs");
const {
  EFT_ENFORCEMENT_PATH, EFT_BREACH_PATH, EFT_ENFORCEMENT_SCAN_PATH, BREACH_SCAN_PAGE, BREACH_SCAN_WINDOW_MS,
  enforcedStoresOf, enforcementUpdateOf, enforcementStatusOf, enforcementBreachOf, breachScanNext,
} = require("../lib/eft-enforce.cjs");
const {
  MANUAL_ENTRY_BY, MANUAL_LOG_PATH, MANUAL_LIST_LIMIT,
  manualEntryKeyOf, manualEntryInputCheck, manualEntryRecord, isManualEntry, manualDuplicateOf,
  bankTwinOfEntry, manualTwinSettleCheck,
  manualLogKeyOf, manualLogRecord, manualLogEventPatch, manualLogView,
} = require("../lib/eft-manual.cjs");
const {
  MANUAL_APPROVED_LOG_PATH, MANUAL_APPROVED_LIST_LIMIT, MANUAL_APPROVED_BY,
  approvedKeyOf, approvedInputCheck, keyedIdentityCheck, proofStoragePathOf, proofIdentityOf, manualApprovedRecord, isManualApproved,
  approvedClaimDecision, approvedClaimStep, approvedTwinSettleCheck, approvedLogKeyOf, approvedLogRecord, approvedListView, approvedResponse,
} = require("../lib/eft-manual-approved.cjs");
const { selectReaderByContent } = require("../lib/eft-banks.cjs");
const { parseAllowedAccounts, destinationVerdict, EFT_ACCOUNTS_ENV_VAR } = require("../lib/eft-destination.cjs");
const { maskAccountValue } = require("../lib/eft-text.cjs");
const { pdfToLines } = require("../cardRecon/pdfText.js");
const { STORAGE_BUCKET } = require("../lib/photo-scope.cjs");
const { createHash } = require("node:crypto");
const { issuingStamp } = require("../lib/network-registry.cjs");
const { loadNetwork } = require("../lib/network-load.cjs");

// The shop's own receiving account(s), for eftPoolManualApprove's destination
// check — the SAME value the poller reads from EFT_ALLOWED_ACCOUNTS in the
// mini's .env, held for Cloud Functions in the Secret Manager secret of the
// same name (never in this public repo, never hard-coded).
const eftAllowedAccounts = defineSecret(EFT_ACCOUNTS_ENV_VAR);

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
async function checkPaymentFingerprint(key, now, { record = undefined, tail = undefined } = {}) {
  const db = admin.database();
  // THE READS ARE THE CALLER'S WHEN IT HAS THEM (speed, 19 Oct 2026): the
  // settle fetches the record and the tail alongside its other lookups in one
  // round trip and hands them in, instead of this function making two more
  // sequential ones. Read here only when not supplied.
  if (record === undefined) record = (await db.ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
  if (!record || record.outcome !== "recorded") return null;
  if (tail === undefined) tail = await readPoolTail();
  const check = consumeFingerprintCheck({ poolKey: key, record, siblings: Object.entries(tail) });
  if (!check.ok) {
    console.warn(`eftPoolSettle: ${check.code} on ${key} — refused before settle`);
    throw refusalToError(check);
  }
  // A bank record whose MANUAL twin (Junid's hand entry of the same money)
  // was already spent: a different fingerprint, the same payment. Refused.
  const twin = manualTwinSettleCheck({ poolKey: key, record, siblings: Object.entries(tail) });
  if (!twin.ok) {
    console.warn(`eftPoolSettle: ${twin.side} on ${key} — refused before settle`);
    throw refusalToError(twin);
  }
  // …or whose PROOF Junid approved (29 Oct 2026): a different document can
  // carry a different fingerprint for the same money; the twin rule catches
  // what the identity cannot.
  const approvedTwin = approvedTwinSettleCheck({ poolKey: key, record, siblings: Object.entries(tail) });
  if (!approvedTwin.ok) {
    console.warn(`eftPoolSettle: approved-twin-used on ${key} — refused before settle`);
    throw refusalToError(approvedTwin);
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

/**
 * THE MANUAL-ENTRY LOG follows the pool record. After a lifecycle transaction
 * commits on a record Junid typed by hand, its /eft_manual_entries row is
 * patched with what happened (lib/eft-manual.cjs manualLogEventPatch) and a
 * marker is logged, so Junid can review how often the hatch is used and
 * whether every entry was spent. Best effort, never a reason to fail the
 * settle: the pool record is the truth; the log is the review.
 */
async function logManualLifecycle(event, key, decision, now, { record: known = null } = {}) {
  // A retried attach (`already`) carries no value — the record is read so
  // a row left without its sale by a crash between the transaction and the
  // first patch still gets it (the patch is an idempotent update).
  const record = decision?.value ?? (decision?.already && event === "attach" ? known : null);
  if (!decision?.ok || !isManualEntry(record)) return;
  const patch = manualLogEventPatch(event, record, now);
  if (!patch) return;
  try {
    await admin.database().ref(`${MANUAL_LOG_PATH}/${manualLogKeyOf(record.manualEntry.at, key)}`).update(patch);
    const u = record.used ?? {};
    console.log(`EFT_MANUAL_${event.toUpperCase()}: ${key} ${record.reference ?? ""} ${record.amountCents}c${event === "settle" ? ` by ${u.cashierName ?? u.cashierUid} at ${u.storeId ?? "?"}/${u.tillId ?? "?"} for ${u.customerName ?? u.customerId ?? "?"}` : ""}${event === "attach" ? ` sale ${u.sale?.saleId} slip ${u.sale?.receiptNumber ?? "—"}` : ""}`);
  } catch (e) {
    console.error(`EFT_MANUAL_LOG_FAILED: ${event} on ${key} —`, e?.message || e);
  }
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
    // Which store (and so which section) issued this credit. Best effort: a
    // registry that cannot be read must never hold up a customer's money, and
    // an unstamped credit is simply spendable everywhere, as all were before.
    let stamp = null;
    try { stamp = issuingStamp(await loadNetwork(db), claim.storeId); } catch (e) { console.warn(`eftPool: no section stamp for ${claim.creditId}: ${e?.message ?? e}`); }
    await db.ref(`customers/${claim.customerId}/storeCredit/${claim.creditId}`)
      .transaction((cur) => (cur === null ? eftCreditMirrorRecord(claim, ServerValue.TIMESTAMP, stamp) : undefined));
    await db.ref(`pos/audit/store_credit_issued/${claim.customerId}/sc_${claim.creditId}`)
      .transaction((cur) => (cur === null ? eftCreditAuditRecord(claim, ServerValue.TIMESTAMP) : undefined));
    await db.ref(`pos/creditLedger/${claim.customerId}`)
      .transaction((cur) => ledgerApplyDecision(cur, claim, ServerValue.TIMESTAMP, stamp));
    await db.ref(`pos/storeCreditQueue/${claim.creditId}`).remove(); // sides landed — consume the claim
    // A remainder that was HELD before it became credit (an owner allocate, or
    // a hold the later sale check promoted) leaves the owner's list here, on
    // every pass — idempotent, so a crash before it is healed by the retry.
    await db.ref(`eft_unallocated/${key}`).remove();
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
  const heldFlip = await runPoolTransaction(key, (cur) => remainderStatusDecision(cur, { status: "held", at: Date.now() }));
  if (!heldFlip.ok && heldFlip.code === "not-unallocated") {
    // Promoted or allocated to credit while this ran: the credit path owns it
    // now — take back the list entry just written, and leave the breadcrumb.
    await db.ref(`eft_unallocated/${key}`).remove();
    return { ...summary, status: "pending" };
  }
  await db.ref(`${PENDING_PATH}/${key}`).remove(); // terminal — /eft_unallocated is the record now
  console.log(`eftPool: remainder of ${r.cents}c on ${key} HELD unallocated (${r.holdReason || "no customer on the sale"})`);
  // creditOnVerify: held only until the sale reads back — the scan will make
  // it the confirmed customer's credit (the till's slip says so).
  return { ...summary, status: "held", creditOnVerify: awaitingSaleHoldOf(record) };
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

/** The customer attached to a till's sale. Resolved like the owner's
 *  allocate (merges followed, the record's own name) — but a customer the till
 *  has attached and the server cannot find YET (created on a till whose outbox
 *  has not landed the record) never stops the sale: the settlement stands for
 *  that id, flagged `unresolved` for the log, and its credit lands on that id,
 *  where the record arrives. Only a malformed id is no customer at all. */
async function resolveSaleCustomer(id) {
  // A malformed id is NO customer (never a path segment): a whole payment
  // still settles, a leftover is refused as needing a customer.
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) return null;
  try {
    return await resolveCustomer({ customerId: id });
  } catch (e) {
    if (e?.code !== "not-found") throw e;
    console.warn(`eftPoolSettle: customer ${id} is not on the server yet — settling for the attached id`);
    return { id, name: null, unresolved: true };
  }
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
  const action = String(data.action ?? "");
  // WARM (speed, 19 Oct 2026). A settle happens a few times a day, so this
  // service had scaled to zero before nearly every one of them: the live logs
  // showed 2.4–3.7 s of cold start in front of 0.1–0.3 s of work. The till
  // calls this when its payment screen opens (eftPoolApi.warmEftPool, throttled
  // on the till), so the instance — and the browser's CORS preflight cache for
  // this URL — are ready by the time the cashier confirms. Nothing is read
  // past the identity check; nothing is written.
  if (action === "warm") return { ok: true, warm: true, at: Date.now() };
  const key = poolKeyOf(data);
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
    // FIX 3 — THE CUSTOMER IS RESOLVED HERE, NOT TAKEN FROM THE TILL. The
    // sale's attached customer must exist in /customers (a merge followed to
    // its survivor), and the till must send the SAME id back as the one the
    // cashier explicitly confirmed as the payer. The name on the settlement is
    // the record's, never the till's.
    // THE CUSTOMER ON THE SALE IS ENOUGH (Junid, 21 Oct 2026): whoever the
    // till has attached at completion is whose leftover credit it is — their
    // name and the payment's reference need not match, and no separate "is
    // this their payment?" confirmation is asked for. (A till that still sends
    // a different confirmedCustomerId is not refused for it any more.)
    const sentId = typeof data.customerId === "string" ? data.customerId.trim() : "";
    // NO CUSTOMER ON THE SALE (Junid, 19 Oct 2026): allowed only for a payment
    // consumed WHOLE — nothing left over that would need an owner — and only
    // when the query the cashier typed re-resolves, through the very search
    // they used (lib/eft-pool.cjs searchEftPool over the same tail), to THIS
    // payment. Decided below once the record and the tail are in hand; the
    // amount is never what authorises the consume. Refused before any claim.
    const matchQuery = typeof data.matchQuery === "string" ? data.matchQuery.slice(0, 120) : "";
    // ONE ROUND TRIP FOR EVERYTHING THE CHECKS NEED (speed, 19 Oct 2026). The
    // cashier's name, the customer record, the payment and the pool tail do
    // not depend on each other, so they are fetched together; they used to be
    // four sequential awaits in front of the two transactions. The checks
    // themselves run in the same order as before, on the same values: nothing
    // is claimed until the customer has resolved and the fingerprint is clean.
    const db = admin.database();
    const [cashierName, customer, record, tail] = await Promise.all([
      cashierNameOf(request),
      sentId ? resolveSaleCustomer(sentId) : null,
      db.ref(`${EFT_POOL_PATH}/${key}`).once("value").then((s) => s.val()),
      readPoolTail(),
    ]);
    let wholePaymentMatched = false;
    if (!customer && record && record.outcome === "recorded") {
      // A malformed amount is settleDecision's "bad-amount", not a leftover.
      if (!Number.isInteger(appliedCents) || appliedCents <= 0 || !Number.isInteger(record.amountCents) || appliedCents > record.amountCents) {
        throw new HttpsError("failed-precondition", "The amount applied to the sale must be within what the customer actually paid.", { code: "bad-amount" });
      }
      if (appliedCents !== record.amountCents) {
        throw new HttpsError("failed-precondition", `${formatRand(record.amountCents - appliedCents)} of this payment is left over after the sale — attach the customer it belongs to before using it.`, { code: "no-customer" });
      }
      if (record.status === "used" && record.used?.attemptId === attemptId) {
        // THIS attempt already holds it (a retry after a lost response): the
        // search would now answer "used", so the match is not re-asked — the
        // transaction answers `already`. (Architect review, 19 Oct 2026.)
        wholePaymentMatched = record.used.wholePaymentMatched === true;
      } else {
        const found = searchEftPool(tail, matchQuery);
        // The query must still find THIS payment — one of several rows when
        // separate payments share its reference (29 Oct 2026).
        wholePaymentMatched = found.results.some((r) => r.key === key && r.status === "unmatched");
        if (!wholePaymentMatched) {
          console.warn(`eftPoolSettle: customer-less settle on ${key} refused — query ${JSON.stringify(matchQuery)} resolved to ${found.results.map((r) => r.key).join(",") || (found.ambiguous ? "ambiguous" : "nothing")}`);
          throw new HttpsError("failed-precondition", "Find the payment by its reference again before using it — a payment is never used on its amount.", { code: "not-matched" });
        }
      }
    }
    const fingerprint = await checkPaymentFingerprint(key, now, { record, tail });
    decision = await runPoolTransaction(key, (current) => settleDecision(current, {
      fingerprint,
      wholePaymentMatched,
      customerResolved: !!customer,
      confirmedCustomerId: customer?.id ?? null,
      attemptId,
      at: now,
      cashierUid: uid,
      cashierName,
      storeId: typeof data.storeId === "string" ? data.storeId.slice(0, 40) : null,
      tillId: typeof data.tillId === "string" ? data.tillId.slice(0, 40) : null,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? (customer?.unresolved && typeof data.customerName === "string" ? data.customerName.slice(0, 80) : null),
      customerUnresolved: customer?.unresolved === true,
      appliedCents,
    }));
  } else if (action === "attach") {
    // THE BREADCRUMB GOES FIRST. If this attach will stamp a remainder (or a
    // stamped one is still pending from a crashed earlier attempt), a durable
    // marker must exist BEFORE the transaction — a crash anywhere after it
    // leaves something eftRemainderScan can find, instead of a "pending" plan
    // whose only window is a bounded tail. A refused attach cleans it up; a
    // stale one is cleared by the scan.
    // FIX 5 — READ THE COMMITTED SALE BACK. Its EFT legs for this payment
    // must add up to exactly what was settled, and it must name the confirmed
    // customer (saleCheckOf). A sale id is a push key — charset-checked before
    // it becomes a path. One record read, never the node.
    const saleId = String(data.saleId ?? "").slice(0, 60);
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(saleId)) throw new HttpsError("invalid-argument", "That is not a sale id.");
    // The payment and the sale in ONE round trip (speed, 19 Oct 2026): the
    // breadcrumb decision and the sale check both read the pool record, which
    // used to be fetched twice, sequentially, before the sale was. The merge
    // walk runs only when the sale actually names a customer.
    const [pre, sale] = await Promise.all([
      admin.database().ref(`${EFT_POOL_PATH}/${key}`).once("value").then((s) => s.val()),
      admin.database().ref(`pos/sales/${saleId}`).once("value").then((s) => s.val()),
    ]);
    try {
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
    const saleCheck = saleCheckOf({
      poolKey: key, used: pre?.used ?? null, sale,
      saleCustomerId: !sale ? undefined : sale.customerId == null ? null : await followMerges(sale.customerId),
    });
    // A customer that was not on the server at settle: one read now (the
    // till landed its outbox first). Found → the leftover mints as usual;
    // still missing → it is HELD for the owner, never minted onto an id with
    // no record behind it.
    const customerNowResolved = pre?.used?.customerUnresolved === true && /^[A-Za-z0-9_-]{1,60}$/.test(pre.used.customerId ?? "")
      ? (await admin.database().ref(`customers/${pre.used.customerId}`).once("value")).exists()
      : false;
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
        customerNowResolved,
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
    await logManualLifecycle("markUsed", key, decision, now);
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
  // A record Junid typed by hand: its log row follows (never fails the call).
  await logManualLifecycle(action, key, decision, now, {
    record: action === "attach" && decision.already ? (await admin.database().ref(`${EFT_POOL_PATH}/${key}`).once("value")).val() : null,
  });
  // An attach finishes its remainder — mint the customer's store credit, or
  // hold the difference visibly. Re-run on a RETRIED attach too (`already`),
  // which is exactly what repairs a crash between the stamp and the IO.
  // An attach that stamped NO remainder (the payment covered the sale exactly —
  // the common case) has nothing to finish: finishRemainder's read of the
  // record is skipped (speed, 19 Oct 2026). A retried attach still runs it,
  // because that is what repairs a crash between the stamp and the IO.
  let remainder = null;
  if (action === "attach" && (decision.already === true || decision.value?.used?.remainder)) {
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

// ─── ENFORCEMENT — which stores must match every EFT sale ────────────────────
// Read: any active POS identity (the till asks on the payment screen and
// caches the answer; with no answer it falls back to the built-in default,
// never to "not enforced"). Write ("set"): the OWNER ALONE — a cashier must
// not be able to take their own store off the list.
exports.eftEnforcementStatus = onCall(RUNTIME, async (request) => {
  await assertPosIdentity(request);
  const data = request.data ?? {};
  const db = admin.database();
  if (data.action === "set") {
    if (!isOwner(request)) throw new HttpsError("permission-denied", "Only Junid can change which stores enforce EFT matching.");
    const update = enforcementUpdateOf(data, { at: Date.now(), by: ADMIN_EMAIL });
    if (!update.ok) throw new HttpsError("invalid-argument", update.message, { code: update.code });
    // MERGE, never replace: switching Pine on must not silently switch Trophy
    // off. A node that does not exist yet starts from the DEFAULT set, so the
    // first edit does not wipe it either. (Spec review, this PR.)
    const before = (await db.ref(EFT_ENFORCEMENT_PATH).once("value")).val();
    const base = before?.stores && typeof before.stores === "object" ? before.stores
      : Object.fromEntries(enforcedStoresOf(null).map((id) => [id, true]));
    const merged = { stores: { ...base, ...update.value.stores }, updatedAt: update.value.updatedAt, updatedBy: update.value.updatedBy };
    await db.ref(EFT_ENFORCEMENT_PATH).set(merged);
    console.log(`EFT_ENFORCEMENT_SET: ${JSON.stringify(merged.stores)} by owner (was ${JSON.stringify(base)})`);
    return { ok: true, ...enforcementStatusOf(merged, null) };
  }
  if (data.action === "listBreaches") {
    // JUNID'S VIEW OF THE SCAN'S FINDINGS — the newest breach records by key
    // order (sale ids are push keys: chronological), one bounded page.
    if (!isOwner(request)) throw new HttpsError("permission-denied", "Only Junid can list enforcement breaches.");
    const snap = await db.ref(EFT_BREACH_PATH).orderByKey().limitToLast(50).once("value");
    const breaches = Object.entries(snap.val() ?? {}).map(([saleId, b]) => ({ saleId, ...b })).sort((a, b) => (b.flaggedAt ?? 0) - (a.flaggedAt ?? 0));
    return { ok: true, breaches, limit: 50 };
  }
  const node = (await db.ref(EFT_ENFORCEMENT_PATH).once("value")).val();
  const storeId = typeof data.storeId === "string" ? data.storeId.slice(0, 40) : null;
  return { ok: true, ...enforcementStatusOf(node, storeId) };
});

// ─── MANUAL ENTRY — Junid alone ──────────────────────────────────────────────
// THE LOCK IS HERE. isOwner() is the admin email AND a verified Google
// sign-in; nothing on the POS access record (role, eftReview, individual)
// grants this, so a manager, an EFT reviewer or a shared till login is refused
// before anything is read. The record it creates is consumed ONLY through
// eftPoolSettle's ordinary settle (customer confirmed, consume-once).
exports.eftPoolManualEntry = onCall(RUNTIME, async (request) => {
  if (!isOwner(request)) {
    throw new HttpsError("permission-denied", "Only Junid can enter an EFT payment by hand.", { code: "owner-only" });
  }
  const data = request.data ?? {};
  const db = admin.database();
  const now = Date.now();
  const actor = { uid: request.auth.uid, email: request.auth.token.email, name: MANUAL_ENTRY_BY };

  // THE REVIEW LIST: the newest entries and what became of each — by key
  // order (no index needed), one bounded page, never the node.
  if (data.action === "list") {
    const snap = await db.ref(MANUAL_LOG_PATH).orderByKey().limitToLast(MANUAL_LIST_LIMIT).once("value");
    return { ok: true, ...manualLogView(snap.val()) };
  }

  const input = manualEntryInputCheck(data);
  if (!input.ok) throw new HttpsError("invalid-argument", input.message, { code: input.code });
  const key = manualEntryKeyOf(input.entryId);

  // A RETRY of the same form submit finds its own record: answer it as done
  // — and make sure its log row exists (a retry after a crash between the
  // row and the record, or the reverse, must leave both standing).
  const existing = (await db.ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
  if (existing) {
    if (isManualEntry(existing) && existing.manualEntry.entryId === input.entryId) {
      await db.ref(`${MANUAL_LOG_PATH}/${manualLogKeyOf(existing.manualEntry.at, key)}`)
        .transaction((cur) => (cur === null ? manualLogRecord(existing, key) : undefined));
      return { ok: true, already: true, key, reference: existing.reference, amountCents: existing.amountCents, at: existing.manualEntry.at, by: MANUAL_ENTRY_BY, status: existing.status };
    }
    throw new HttpsError("already-exists", "That entry id is taken by another record — reload and try again.", { code: "key-taken" });
  }
  // The SAME money typed twice would be two spendable records: refused while
  // the earlier entry is in the pool tail (used or waiting).
  const tail = await readPoolTail();
  const bankTwin = bankTwinOfEntry(input, Object.entries(tail));
  if (bankTwin) {
    throw new HttpsError("failed-precondition", `The bank's own notification for ${input.reference} of R${(input.amountCents / 100).toFixed(2)} is already in the pool, unused — the cashier can use that one. No manual entry is needed.`, { code: "bank-twin-waiting", key: bankTwin.key });
  }
  const dup = manualDuplicateOf(input, Object.entries(tail));
  if (dup) {
    const state = dup.record.status === "used" ? "has already been used" : "is already in the pool, waiting";
    throw new HttpsError("failed-precondition", `A manual entry for ${input.reference} of R${(input.amountCents / 100).toFixed(2)} ${state}. If this is a second, separate payment, give it a different reference.`, { code: "already-entered", key: dup.key });
  }

  const record = manualEntryRecord({ ...input, key, actor, at: now });
  // The fingerprint claim FIRST, create-only — the same order the poller
  // keeps, so the settle's claimHolderCheck finds this very record holding it.
  const fp = paymentFingerprint(record);
  let claim = null;
  await db.ref(`${EFT_FINGERPRINT_PATH}/${fp}`).transaction(fingerprintClaimStep(key, now, (d) => { claim = d; }));
  if (claim?.holder !== key) {
    throw new HttpsError("aborted", "The entry's fingerprint is held by another record — try again.", { code: "fingerprint-held" });
  }
  // THE LOG ROW FIRST, create-only, keyed by this entry's moment. Before the
  // record, so a cashier settling the instant the record lands patches a row
  // that exists (an update() on an absent row would create a partial one the
  // review list cannot show). A racing submit of the same entryId that loses
  // the record transaction below leaves a row the retry branch tolerates.
  await db.ref(`${MANUAL_LOG_PATH}/${manualLogKeyOf(now, key)}`).transaction((cur) => (cur === null ? manualLogRecord(record, key) : undefined));
  // Create-if-absent: two racing submits of one entryId write exactly one.
  const res = await db.ref(`${EFT_POOL_PATH}/${key}`).transaction((cur) => (cur === null ? record : undefined));
  const already = res && res.committed === false;
  if (already) {
    // The other submit's record stands, with ITS moment; this attempt's
    // row (if it won the row race with a different `now`) is removed.
    const winner = (await db.ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
    if (winner?.manualEntry?.at !== now) await db.ref(`${MANUAL_LOG_PATH}/${manualLogKeyOf(now, key)}`).remove();
  }
  console.log(`EFT_MANUAL_ENTRY: ${key} ${input.reference} ${input.amountCents}c by ${MANUAL_ENTRY_BY} (${actor.uid})${input.note ? ` — ${input.note}` : ""}${already ? " [already]" : ""}`);
  return { ok: true, already, key, reference: input.reference, amountCents: input.amountCents, at: now, by: MANUAL_ENTRY_BY, status: "unmatched" };
});

// ─── MANUAL APPROVAL FROM A PROOF OF PAYMENT — Junid alone ──────────────────
// THE LOCK IS THE SAME AS THE MANUAL ENTRY'S: isOwner() — the admin email on
// a verified Google sign-in — before anything is read or decoded. Nothing on
// the POS access record grants this.
//
// WHAT IT DOES, AND DOES NOT DO (lib/eft-manual-approved.cjs has the why):
//   · reads the uploaded PDF with cardRecon/pdfText.js (bucket grouping, as
//     the poller reads EFT PDFs) and the per-bank reader its CONTENT selects
//     — no sending domain, no DKIM: Junid is vouching for the document;
//   · checks the destination the way the poller does (lib/eft-destination.cjs,
//     the same code) against the EFT_ALLOWED_ACCOUNTS secret;
//   · takes the payment's identity — the bank's transaction id, or Absa's
//     synthetic identity for a notice that prints none — and writes ONE
//     approval record per identity (status "used", outsidePos by Junid) plus
//     the fingerprint claim naming it as holder and spender, manualApproved.
//     A bank notification that arrives later is held as the bank's copy of
//     settled money (eftCore applyFingerprintHold) and the settle refuses it
//     (claimHolderCheck: duplicate-used);
//   · FLOATS NOTHING. It never creates a spendable record. eftPoolManualEntry
//     is untouched: floating stays instant and never needs a proof.
// The immediacy and cutoff gates are deliberately NOT applied: they decide
// whether the POOL may float money on the bank's word; here nothing floats,
// and Junid is attesting receipt on the statement.
const APPROVE_RUNTIME = { ...RUNTIME, memory: "512MiB", timeoutSeconds: 60, secrets: [eftAllowedAccounts] };
exports.eftPoolManualApprove = onCall(APPROVE_RUNTIME, async (request) => {
  if (!isOwner(request)) {
    throw new HttpsError("permission-denied", "Only Junid can approve an EFT payment from its proof.", { code: "owner-only" });
  }
  const data = request.data ?? {};
  const db = admin.database();
  const now = Date.now();
  const actor = { uid: request.auth.uid, email: request.auth.token.email, name: MANUAL_APPROVED_BY };

  if (data.action === "list") {
    const snap = await db.ref(MANUAL_APPROVED_LOG_PATH).orderByKey().limitToLast(MANUAL_APPROVED_LIST_LIMIT).once("value");
    return { ok: true, ...approvedListView(snap.val()) };
  }

  const input = approvedInputCheck(data);
  if (!input.ok) throw new HttpsError("invalid-argument", input.message, { code: input.code });

  const configured = String(eftAllowedAccounts.value() ?? "").trim();
  let reader, parse, lines, alsoSyntheticRef = null;
  if (input.kind === "image") {
    // A PHOTO: nothing to parse, and no OCR. Junid typed the identity from
    // it; keyedIdentityCheck shapes those fields as the bank's reader would
    // have parsed them, so the identity below is the poller's own.
    if (!configured) {
      throw new HttpsError("failed-precondition", `No account allowlist is configured for Cloud Functions — set the ${EFT_ACCOUNTS_ENV_VAR} secret (firebase functions:secrets:set). Until then every proof refuses here, deliberately.`, { code: "wrong-destination" });
    }
    const keyed = keyedIdentityCheck(data, { allowedAccounts: parseAllowedAccounts(configured), now });
    if (!keyed.ok) throw new HttpsError("invalid-argument", keyed.message, { code: keyed.code });
    reader = { id: keyed.readerId };
    parse = keyed.parse;
    lines = keyed.lines;
    alsoSyntheticRef = keyed.alsoSyntheticRef;
  } else {
    // THE DOCUMENT → LINES → READER → PARSE, exactly the poller's path.
    const extracted = await pdfToLines(input.pdf, { grouping: "bucket" });
    if (!extracted.ok) throw new HttpsError("invalid-argument", extracted.reason, { code: "unreadable-proof" });
    reader = selectReaderByContent(extracted.lines);
    if (!reader) {
      throw new HttpsError("invalid-argument", "That PDF is not a payment notification this pool has a reader for (Standard Bank, FNB, Capitec, Absa, Nedbank). Float the payment by hand instead.", { code: "no-reader" });
    }
    parse = reader.parse(extracted.lines);
    lines = extracted.lines;
  }
  const identity = proofIdentityOf(parse, reader.id);
  if (!identity.ok) throw new HttpsError("failed-precondition", identity.message, { code: identity.code, reader: reader.id });

  // PAID INTO THE SHOP'S OWN ACCOUNT — the poller's own check, same code.
  const account = destinationVerdict({
    accountMask: parse.accountMask, destBankName: parse.destBankName,
    allowedAccounts: parseAllowedAccounts(configured), configured: !!configured,
  });
  if (!account.ok) {
    // The shared verdict names the mini's .env; here the value is the Secret
    // Manager secret of the same name.
    const reason = configured ? account.reason : `No account allowlist is configured for Cloud Functions — set the ${EFT_ACCOUNTS_ENV_VAR} secret (firebase functions:secrets:set). Until then every proof refuses here, deliberately.`;
    throw new HttpsError("failed-precondition", reason, { code: "wrong-destination", reader: reader.id });
  }
  const destination = {
    accountMask: maskAccountValue(parse.accountMask),
    beneficiaryName: parse.beneficiaryName ?? null,
    destBankName: parse.destBankName ?? null,
    accountTail: account.tail,
  };

  const key = approvedKeyOf(identity.fingerprint);
  // A RETRY (or the same proof uploaded twice) finds its own approval.
  const existing = (await db.ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
  if (existing) {
    if (isManualApproved(existing)) return approvedResponse({ ...existing, approvedKey: key }, { already: true });
    throw new HttpsError("already-exists", "That identity's key is taken by another record — ask for it to be looked at.", { code: "key-taken", key });
  }

  // THE CLAIM DECIDES. Who holds this identity today, and what is that record?
  const claimPath = `${EFT_FINGERPRINT_PATH}/${identity.fingerprint}`;
  const claim = (await db.ref(claimPath).once("value")).val();
  const holderRecord = claim && typeof claim === "object" && typeof claim.poolKey === "string" && claim.poolKey !== key
    ? (await db.ref(`${EFT_POOL_PATH}/${claim.poolKey}`).once("value")).val()
    : null;
  const decision = approvedClaimDecision({ approvedKey: key, claim, holderRecord, now });
  if (decision.action === "refuse") {
    throw new HttpsError("failed-precondition", decision.message, { code: decision.code, key: decision.key ?? null });
  }
  // A PHOTO OF AN ABSA PROOF with both a transaction number and a payer also
  // claims the synthetic identity (lib: keyedIdentityCheck) — judged by the
  // same decision, so a bank record waiting under it refuses here too.
  const also = alsoSyntheticRef ? { fingerprint: paymentFingerprint({ reader: reader.id, syntheticRef: alsoSyntheticRef }) } : null;
  if (also?.fingerprint && also.fingerprint !== identity.fingerprint) {
    also.path = `${EFT_FINGERPRINT_PATH}/${also.fingerprint}`;
    const alsoClaim = (await db.ref(also.path).once("value")).val();
    const alsoHolder = alsoClaim && typeof alsoClaim === "object" && typeof alsoClaim.poolKey === "string" && alsoClaim.poolKey !== key
      ? (await db.ref(`${EFT_POOL_PATH}/${alsoClaim.poolKey}`).once("value")).val()
      : null;
    also.decision = approvedClaimDecision({ approvedKey: key, claim: alsoClaim, holderRecord: alsoHolder, now });
    if (also.decision.action === "refuse") {
      throw new HttpsError("failed-precondition", also.decision.message, { code: also.decision.code, key: also.decision.key ?? null });
    }
  }
  // THE PHOTO IS THE EVIDENCE: stored before anything is claimed or
  // recorded (the slip photos' order), with the Admin SDK — no client writes
  // eftProofs/. A refused claim below takes the file back out.
  let proof = null;
  if (input.kind === "image") {
    const sha256 = createHash("sha256").update(input.image).digest("hex");
    proof = {
      kind: "image",
      path: proofStoragePathOf(key, input.entryId, sha256, input.imageType.ext),
      contentType: input.imageType.contentType,
      bytes: input.image.length,
      sha256,
      alsoFingerprint: also?.path ? also.fingerprint : null,
    };
    try {
      // Create-only: the path names the bytes, so an existing file IS this
      // image (a retry) — never overwritten.
      await admin.storage().bucket(STORAGE_BUCKET).file(proof.path).save(input.image, {
        resumable: false,
        contentType: proof.contentType,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { cacheControl: "private, max-age=31536000, immutable" },
      });
    } catch (err) {
      if (err?.code !== 412) throw err;
    }
  }
  const dropProof = async () => {
    if (proof) { try { await admin.storage().bucket(STORAGE_BUCKET).file(proof.path).delete(); } catch { /* best effort */ } }
  };
  let claimed = null;
  await db.ref(claimPath).transaction(approvedClaimStep({ approvedKey: key, at: now, stampOver: decision.holder ?? null }, (d) => { claimed = d; }));
  if (claimed?.spentBy !== key) {
    await dropProof();
    throw new HttpsError("aborted", "The payment's identity changed hands while this was being registered — check the pool and try again.", { code: "claim-moved", holder: claimed?.holder ?? null });
  }
  if (also?.path) {
    let alsoClaimed = null;
    await db.ref(also.path).transaction(approvedClaimStep({ approvedKey: key, at: now, stampOver: also.decision.holder ?? null }, (d) => { alsoClaimed = d; }));
    if (alsoClaimed?.spentBy !== key) {
      // The primary claim stays this approval's; a retry finds it "own" and
      // tries the synthetic identity again.
      await dropProof();
      throw new HttpsError("aborted", "The payment's identity changed hands while this was being registered — check the pool and try again.", { code: "claim-moved", holder: alsoClaimed?.holder ?? null });
    }
  }

  const built = manualApprovedRecord({
    key, readerId: reader.id, parse, lines, identity, destination, actor, at: now,
    note: input.note, filename: input.filename, entryId: input.entryId, proof,
  });
  if (!built.ok) throw new HttpsError("internal", built.message, { code: built.code });
  const record = built.value;
  // THE LOG ROW FIRST, create-only, then the record create-if-absent — the
  // manual entry's order, for the manual entry's reasons.
  await db.ref(`${MANUAL_APPROVED_LOG_PATH}/${approvedLogKeyOf(now, key)}`).transaction((cur) => (cur === null ? approvedLogRecord(record, key) : undefined));
  const res = await db.ref(`${EFT_POOL_PATH}/${key}`).transaction((cur) => (cur === null ? record : undefined));
  const already = res && res.committed === false;
  if (already) {
    const winner = (await db.ref(`${EFT_POOL_PATH}/${key}`).once("value")).val();
    if (winner?.manualApproved?.at !== now) await db.ref(`${MANUAL_APPROVED_LOG_PATH}/${approvedLogKeyOf(now, key)}`).remove();
    if (winner && isManualApproved(winner)) return approvedResponse({ ...winner, approvedKey: key }, { already: true });
  }
  // The key, the bank and the amount only: the reference is the payer's
  // (often a phone number) and the note is free text — neither belongs in a log.
  console.log(`EFT_MANUAL_APPROVED: ${key} ${reader.id} ${record.amountCents}c ${identity.synthetic ? "synthetic identity" : "bank id"}${proof ? " keyed from a photo" : ""}${decision.action === "spend" ? ` (spent the id held by refused ${decision.holder})` : ""} by ${MANUAL_APPROVED_BY} (${actor.uid})`);
  return approvedResponse(record, { already: false });
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
  await logManualLifecycle("reverse", key, decision, at);
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
    let verified = 0, flagged = 0, promoted = 0;
    for (const [key, crumb] of Object.entries(checks)) {
      const saleId = typeof crumb?.saleId === "string" ? crumb.saleId : "";
      if (!/^[0-9a-f]{40}$/.test(key) || !/^[A-Za-z0-9_-]{1,60}$/.test(saleId)) {
        await db.ref(`${SALE_CHECK_PATH}/${key}`).remove(); cleared++; continue;
      }
      try {
        const [saleSnap, recordSnap] = await Promise.all([
          db.ref(`pos/sales/${saleId}`).once("value"),
          db.ref(`${EFT_POOL_PATH}/${key}`).once("value"),
        ]);
        const sale = saleSnap.val();
        const record = recordSnap.val();
        const saleCheck = saleCheckOf({
          poolKey: key, used: record?.used ?? null, sale,
          saleCustomerId: sale ? await followMerges(sale.customerId ?? null) : undefined,
        });
        // A hold that may be PROMOTED to credit below: the remainder breadcrumb
        // goes down FIRST, like every other mint, so a crash between the
        // transaction and the mint leaves a pending plan the scan finishes.
        if (promotableHoldOf(record)) {
          await db.ref(`${PENDING_PATH}/${key}`).set({ at: now });
        }
        const ageMs = now - (Number.isInteger(crumb.at) ? crumb.at : 0);
        const d = await runPoolTransaction(key, (cur) => laterSaleCheckDecision(cur, {
          saleId, saleCheck, at: Date.now(), ageMs, maxAgeMs: SALE_CHECK_MAX_AGE_MS, poolKey: key,
        }));
        if (d.outcome === "wait") { waited++; continue; }
        if (d.outcome === "flagged") {
          flagged++;
          console.error(`EFT_SALE_MISMATCH: ${key} sale ${saleId} — ${saleCheck.state === "mismatch" ? saleCheck.why : "never reached the server"}`);
        } else if (d.outcome === "done") verified++;
        if (d.outcome === "done" && !d.promoted && awaitingSaleHoldOf(record) && record.used.remainder.status === "pending") {
          // Verified, but the hold's own follow-up has not parked it as held
          // yet: keep the sale check, so a later pass promotes it (re-reading
          // the sale) instead of stranding it (architect re-check, this PR).
          waited++; continue;
        }
        if (d.promoted) {
          // The sale is verified and the hold's only reason is gone: the
          // confirmed customer's credit is minted now (clears the hold too).
          const r = await finishRemainder(key);
          promoted++;
          console.log(`EFT_REMAINDER_PROMOTED: ${key} sale ${saleId} — ${r?.cents}c → store credit ${r?.creditId} (${r?.status})`);
        }
        await db.ref(`${SALE_CHECK_PATH}/${key}`).remove();
      } catch (err) {
        stuck++;
        console.error(`EFT_SALE_CHECK_STUCK: ${key} could not be checked —`, err?.message || err);
      }
    }
    // ENFORCEMENT BREACHES: new regular sales at an enforced store whose EFT
    // leg names no pool payment — a till that let the plain path through. A
    // bounded indexed page (createdAt is indexed on /pos/sales), a sliding
    // two-hour window, an idempotent record per sale; never the node.
    let breaches = 0;
    try {
      const [enfSnap, stateSnap] = await Promise.all([
        db.ref(EFT_ENFORCEMENT_PATH).once("value"),
        db.ref(EFT_ENFORCEMENT_SCAN_PATH).once("value"),
      ]);
      const enforced = enforcedStoresOf(enfSnap.val());
      const state = stateSnap.val() || {};
      const from = Number.isInteger(state.sinceMs) ? state.sinceMs : now - BREACH_SCAN_WINDOW_MS;
      const snap = await db.ref("pos/sales").orderByChild("createdAt").startAt(from).limitToFirst(BREACH_SCAN_PAGE).once("value");
      const page = snap.val() || {};
      let maxSeen = null, count = 0;
      for (const [saleId, sale] of Object.entries(page)) {
        count++;
        if (Number.isInteger(sale?.createdAt) && (maxSeen === null || sale.createdAt > maxSeen)) maxSeen = sale.createdAt;
        if (!/^[A-Za-z0-9_-]{1,60}$/.test(saleId)) continue;
        const breach = enforcementBreachOf(saleId, sale, enforced);
        if (!breach) continue;
        // CREATE-ONLY: the window slides, so the same sale is read again on
        // later runs — the first sighting's record and its one log line
        // stand; a re-read neither rewrites flaggedAt nor re-alerts.
        const res = await db.ref(`${EFT_BREACH_PATH}/${saleId}`).transaction((cur) => (cur === null ? { ...breach, flaggedAt: now } : undefined));
        if (!res?.committed) continue;
        breaches++;
        console.error(`EFT_ENFORCEMENT_BREACH: sale ${saleId} (${breach.receiptNumber ?? "no slip"}) at ${breach.storeId}/${breach.tillId ?? "?"} by ${breach.cashierName ?? "?"} — ${breach.eftCents}c of EFT with no pool payment`);
      }
      await db.ref(EFT_ENFORCEMENT_SCAN_PATH).set(breachScanNext({ state: { sinceMs: from }, now, maxSeen, full: count >= BREACH_SCAN_PAGE }));
    } catch (err) {
      console.error("EFT_ENFORCEMENT_SCAN_STUCK:", err?.message || err);
    }
    console.log("eftRemainderScan done", JSON.stringify({ finished, cleared, waited, stuck, verified, flagged, promoted, backfilled, breaches }));
  },
);
