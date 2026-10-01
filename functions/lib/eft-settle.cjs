// ─── EFT CONSUME-ONCE — the settle/attach/release/reverse decisions (PURE) ───
// One payment settles exactly one sale. The transition unmatched → used runs
// as an RTDB transaction on /eft_pool/{key} (eftPool/eftPool.js), and the
// ENTIRE decision inside that transaction lives here, away from firebase-admin
// and the clock, so the race that matters — two tills, the same payment, the
// same instant — is testable as data (test/eft-pool-settle.test.cjs, written
// first and run to fail before this file existed).
//
// WHY A TRANSACTION AND NOT A CHECK-THEN-WRITE: RTDB transactions re-run the
// update function on contention, so the loser's decision executes against the
// winner's committed value and ABORTS with a message naming who has the
// payment. A read-check followed by a set() would let both tills pass the
// check and the second write would silently double-settle — the exact failure
// this build exists to prevent.
//
// THE SETTLEMENT'S LIFECYCLE, in the order the till drives it:
//
//   settle   unmatched → used, sale:null. Runs BEFORE the sale is written, so
//            a lost race stops the sale while the cashier can still choose
//            another method — never after money moved. Idempotent per
//            attemptId: the same till retrying its own settle after a network
//            blip is not a loss.
//   attach   the committed sale's identity (saleId, slip number) lands on the
//            settlement. Holder-only (same attemptId), idempotent, and never
//            overwrites a different sale.
//   release  the sale FAILED to commit after settle won — hand the payment
//            back. Holder-only, only while no sale is attached, and NEVER
//            silent: the aborted attempt is appended to `attempts`, keyed by
//            epoch-ms (never ISO/free text in an RTDB key — #269).
//   reverse  the owner unwinds a completed settlement. Both records survive:
//            the pool record keeps the whole settlement under `reversals`,
//            and the sale at /pos/sales is not touched by this module at all.
//
// Nothing here ever rewrites the payment the poller stored — a decision's
// value is always {...current} plus lifecycle fields. The record shape is
// eftCore.mjs's; this module redefines none of it.
"use strict";

const { paymentFingerprint } = require("./eft-fingerprint.cjs");

/** A refusal the callable turns into an HttpsError; `message` is written to be
 *  read out at the counter. */
function refuse(code, message) {
  return { ok: false, code, message };
}

/** What "this payment is already used" should say to the losing till. */
function alreadyUsedMessage(used) {
  const who = used?.cashierName ? ` by ${used.cashierName}` : "";
  const slip = used?.sale?.receiptNumber ? ` for slip ${used.sale.receiptNumber}` : "";
  return `This payment has already been used${slip}${who}. If the customer paid twice there will be a second notification — search again.`;
}

/**
 * unmatched → used. `settlement` carries who/where/what the callable resolved:
 * { attemptId, at, cashierUid, cashierName, storeId, tillId, customerId,
 *   customerName, appliedCents }.
 * @returns {{ok:true, value:object}|{ok:true, already:true}|{ok:false, code, message}}
 */
function settleDecision(current, settlement) {
  if (current === null || current === undefined) {
    return refuse("not-found", "That payment is no longer in the pool — search again.");
  }
  if (current.outcome !== "recorded") {
    return refuse("not-a-payment", "That record is not a verified payment and can never settle a sale.");
  }
  const s = settlement ?? {};
  if (typeof s.attemptId !== "string" || !s.attemptId
    || typeof s.cashierUid !== "string" || !s.cashierUid
    || typeof s.cashierName !== "string" || !s.cashierName) {
    return refuse("bad-settlement", "The settlement does not say which cashier is settling — refused.");
  }
  if (!Number.isInteger(s.appliedCents) || s.appliedCents <= 0
    || !Number.isInteger(current.amountCents) || s.appliedCents > current.amountCents) {
    return refuse("bad-amount", "The amount applied to the sale must be within what the customer actually paid.");
  }
  // WHOSE PAYMENT IS THIS? (fix 3). A till settle consumes a payment only for
  // a customer the cashier EXPLICITLY confirmed as the payer — attached to the
  // sale, resolved server-side against /customers (the callable stamps
  // customerResolved; the till's own name for them is never used), and
  // confirmed by id. A payment is never applied on its amount alone, and never
  // to a sale nobody is named on. The owner's mark-as-used has no customer and
  // pays nothing out, so it is exempt.
  if (s.outsidePos !== true) {
    if (typeof s.customerId !== "string" || !s.customerId || s.customerResolved !== true) {
      return refuse("no-customer", "Attach the customer who made this payment to the sale first — an EFT payment is only applied to a confirmed customer.");
    }
    if (s.confirmedCustomerId !== s.customerId) {
      return refuse("not-confirmed", "Confirm that this payment belongs to the customer on the sale before using it.");
    }
  }
  // THE BANK'S TRANSACTION ID, RE-CHECKED INSIDE THE TRANSACTION (fix 1). The
  // callable verified the fingerprint claim and the siblings against the value
  // it read; this re-derives the fingerprint from the value being COMMITTED
  // and requires it to be the one that was checked. A payment with no bank
  // transaction id cannot settle at all unless the owner released it from the
  // hold by hand. The owner's mark-as-used pays nothing out and is exempt.
  if (s.fingerprintExempt !== true) {
    const fp = paymentFingerprint(current);
    if (!fp && !(current.releasedFromHold && typeof current.releasedFromHold === "object")) {
      return refuse("no-bank-id", "This payment carries no bank transaction id, so it cannot be told apart from a resent copy — it cannot settle a sale. The owner can check it against the bank statement.");
    }
    if ((fp ?? null) !== (s.fingerprint ?? null)) {
      return refuse("fingerprint-unchecked", "This payment's bank transaction id was not checked against the pool — refused. Search again and retry.");
    }
  }
  if (current.status === "used") {
    // The same attempt retrying (a timeout, a resumed request) already holds
    // it — success, nothing to write. Anyone else lost the race.
    if (current.used?.attemptId === s.attemptId) return { ok: true, already: true };
    return refuse("already-used", alreadyUsedMessage(current.used));
  }
  if (current.status !== "unmatched") {
    return refuse("not-settleable", `This payment is "${current.status}" and cannot settle a sale.`);
  }
  return {
    ok: true,
    value: {
      ...current,
      status: "used",
      used: {
        attemptId: s.attemptId,
        at: s.at,
        cashierUid: s.cashierUid,
        cashierName: s.cashierName,
        storeId: s.storeId ?? null,
        tillId: s.tillId ?? null,
        customerId: s.customerId ?? null,
        customerName: s.customerName ?? null,
        // The customer was resolved against /customers AND confirmed at the
        // till (fix 3) — only such a settlement may mint remainder credit.
        ...(s.outsidePos === true ? {} : { customerConfirmed: true }),
        appliedCents: s.appliedCents,
        sale: null, // the sale attaches only after it has committed
      },
    },
  };
}

// ─── SETTLED OUTSIDE THE POS — the owner's mark-as-used ──────────────────────
// A payment that was settled by hand — paid before the pool existed, matched
// on a bank statement, refunded in cash — has no sale to attach and would sit
// "unmatched" for ever, findable and settleable by any till. The owner marks
// it used instead. THE SAME TRANSITION, THE SAME TRANSACTION: this delegates
// to settleDecision, so a till settling the same payment in the same instant
// races it exactly as two tills race each other — one winner, the loser told
// who has it, never a silent double-settle. The whole payment is applied
// (nothing was owed on a sale the POS never saw, so no remainder is stamped)
// and the settlement carries WHO did it and WHEN, for the counter and for the
// record. Reversal is the ordinary owner reversal: the settlement moves whole
// to `reversals`, outsidePos included — both records survive.
//
// THE REASON IS REQUIRED (fix 4). #598 made it optional ("two taps and no
// keyboard"); Junid has decided otherwise: a payment marked used outside the
// POS has no sale, no slip and no customer, so the typed reason is the ONLY
// account of where that money went. Three characters at least.
const OUTSIDE_POS_REASON_MAX = 300;
const OUTSIDE_POS_REASON_MIN = 3;

/**
 * unmatched → used with no sale, by the owner. `mark` carries
 * { at, actorUid, actorName, reason } as the callable resolved them.
 * @returns same shape as settleDecision
 */
function markUsedOutsidePosDecision(current, mark) {
  const m = mark ?? {};
  const reason = String(m.reason ?? "").trim();
  // WHO is still mandatory. A mark nobody is named on is worse than no mark:
  // the owner's whole review of settled-by-hand payments is "who did this".
  if (typeof m.actorUid !== "string" || !m.actorUid || typeof m.actorName !== "string" || !m.actorName) {
    return refuse("bad-actor", "The mark does not say who is marking — refused.");
  }
  if (!Number.isInteger(m.at)) return refuse("bad-time", "The mark carries no server time — refused.");
  if (reason.length < OUTSIDE_POS_REASON_MIN) {
    return refuse("bad-reason", "Say how this payment was settled outside the POS — the reason stays on the record.");
  }
  const base = settleDecision(current, {
    // The attempt id is the mark's own moment: nothing else can hold it, so a
    // second tap is a second attempt and loses to the first — exactly one
    // winner, never two marks on one payment.
    attemptId: `outside-pos-${m.at}`,
    at: m.at,
    cashierUid: m.actorUid,
    cashierName: m.actorName,
    storeId: null,
    tillId: null,
    customerId: null,
    customerName: null,
    appliedCents: current?.amountCents,
    // Marking a payment used pays nothing out — no sale, no remainder — so a
    // payment without a bank transaction id may still be closed off this way,
    // and there is no customer to confirm.
    fingerprintExempt: true,
    outsidePos: true,
  });
  if (!base.ok || base.already) return base;
  return {
    ok: true,
    value: {
      ...base.value,
      used: {
        ...base.value.used,
        sale: null,
        outsidePos: {
          reason: reason.slice(0, OUTSIDE_POS_REASON_MAX),
          actorUid: m.actorUid,
          actorName: m.actorName,
          at: m.at,
        },
      },
    },
  };
}

// ─── THE REMAINDER — where the rest of a partially-applied payment goes ──────
// A payment bigger than the sale it settles is STILL consumed whole (consume-
// once is per payment, never per rand), so the difference is money the shop
// owes. It must never end as a bare "overpaid" note nobody owns (the R30-sale/
// R100-payment incident this build exists for): with a customer on the
// settlement it becomes STORE CREDIT through the existing mint machinery
// (lib/eft-credit.cjs — the same records the POS refund path writes, never a
// parallel "EFT credit"); with no customer it is HELD, visibly, at
// /eft_unallocated until the owner assigns one.

/** The credit id an EFT remainder mints under — DETERMINISTIC, so a retried
 *  attach (or the POS sweep finishing a crashed one) can never mint twice:
 *  the /pos/storeCredits create-if-absent transaction collides on this id.
 *  usedAt (epoch ms) is in the id because a payment can be settled, reversed
 *  by the owner and settled again — each settlement is its own credit. */
function eftCreditIdOf(poolKey, usedAt) {
  return `eftsc-${poolKey}-${usedAt}`;
}

/** The remainder plan stamped on used.remainder at attach/allocate time.
 *  status starts "pending"; the callable's follow-up IO moves it to "issued"
 *  (credit minted) or "held" (/eft_unallocated written) — so a crash between
 *  the transaction and the IO leaves a visibly unfinished record, never a
 *  silently swallowed difference. */
function remainderPlanOf(poolKey, used, amountCents, { holdReason = null } = {}) {
  const cents = Number.isInteger(amountCents) && Number.isInteger(used?.appliedCents)
    ? amountCents - used.appliedCents
    : 0;
  if (cents <= 0) return null;
  // FIX 5 — CREDIT ONLY FOR A CONFIRMED CUSTOMER ON A VERIFIED SALE. The
  // remainder used to become store credit for whatever customer id the till
  // sent. Now only a settlement whose customer was resolved and confirmed
  // (customerConfirmed, fix 3) AND whose sale was read back and matched
  // (no holdReason) may mint; anything else is HELD for the owner, visibly.
  if (holdReason || used?.customerConfirmed !== true) {
    return {
      cents, disposition: "unallocated", customerId: null, customerName: null, creditId: null, status: "pending",
      holdReason: holdReason || "the settlement's customer was never confirmed at the till",
    };
  }
  // The customer id came from the till's settle payload and is about to
  // become a credit id and a database PATH SEGMENT (customers/{id}/…,
  // creditLedger/{id}/…). An id that fails the charset check is treated as NO
  // customer — the money stays visible at /eft_unallocated instead of a mint
  // that throws on every retry for ever. (CodeRabbit, this PR.)
  const customerId = typeof used.customerId === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(used.customerId)
    ? used.customerId
    : null;
  return {
    cents,
    disposition: customerId ? "credit" : "unallocated",
    customerId,
    customerName: used.customerName ?? null,
    creditId: customerId ? eftCreditIdOf(poolKey, used.at) : null,
    status: "pending",
  };
}

/**
 * The committed sale's identity lands on the settlement this attempt holds —
 * and, now that the sale is real, the remainder plan is decided and stamped
 * (a remainder must not exist before the sale commits: a released payment
 * owes nobody anything).
 * @returns same shape as settleDecision
 */
// ─── FIX 5: THE SALE MUST TAKE EXACTLY WHAT WAS SETTLED ─────────────────────
// The till writes the sale itself, so nothing used to compare the sale's EFT
// leg with what the settle actually applied: settle R50, record a sale with an
// R500 EFT leg against the same payment, and the books said R500 was paid. The
// attach now READS THE COMMITTED SALE BACK (the callable does the read; this
// decides) and requires its EFT legs for this payment to add up to exactly
// `appliedCents`, and its customer to be the settlement's customer.
//   verified  → attach normally.
//   absent    → the sale is not on the server yet (a till that queued it
//               offline): attach, but HOLD any remainder for the owner — no
//               credit is minted against a sale nobody has seen.
//   mismatch  → REFUSE the attach. The callable stamps used.saleMismatch on
//               the payment and logs EFT_SALE_MISMATCH; it shows on the
//               owner's tab as a used payment with no sale attached.
function saleCheckOf({ poolKey, used, sale }) {
  if (!sale || typeof sale !== "object") return { state: "absent" };
  const legs = Object.values(sale.payments ?? {})
    .filter((p) => p && typeof p === "object" && p.method === "eft" && p.eftPoolKey === poolKey);
  if (!legs.length) {
    return { state: "mismatch", legCents: 0, why: "the sale carries no EFT payment for this pool record" };
  }
  const legCents = legs.reduce((sum, p) => sum + (Number.isInteger(p.amount) ? p.amount : Number.NaN), 0);
  if (!Number.isInteger(legCents) || legCents !== used?.appliedCents) {
    return {
      state: "mismatch", legCents: Number.isInteger(legCents) ? legCents : null,
      why: `the sale's EFT for this payment is ${Number.isInteger(legCents) ? legCents : "unreadable"}c but ${used?.appliedCents}c was settled`,
    };
  }
  if (used?.customerId && sale.customerId !== used.customerId) {
    return { state: "mismatch", legCents, why: "the sale names a different customer from the one confirmed when the payment was settled" };
  }
  return { state: "verified", legCents };
}

/** Stamp a refused attach's evidence on the payment, without changing its state. */
function flagSaleMismatchDecision(current, { saleId, legCents, why, at }) {
  if (!current?.used || current.status !== "used") return refuse("not-held", "No settlement is holding this payment.");
  return {
    ok: true,
    value: { ...current, used: { ...current.used, saleMismatch: { saleId: String(saleId ?? ""), legCents: legCents ?? null, why: String(why ?? ""), at } } },
  };
}

function attachSaleDecision(current, { attemptId, saleId, receiptNumber, at, poolKey, saleCheck }) {
  if (!current || current.status !== "used" || !current.used) {
    return refuse("not-held", "No settlement is holding this payment — the sale cannot be attached.");
  }
  // A payment the owner marked as settled OUTSIDE the POS has no sale and can
  // never acquire one — that is a reversal conversation, not an attach.
  if (current.used.outsidePos) {
    return refuse("settled-outside", "This payment was marked as settled outside the POS — no sale can be attached to it. The owner can reverse the mark.");
  }
  if (current.used.attemptId !== attemptId) {
    return refuse("not-holder", "A different settlement holds this payment.");
  }
  if (typeof saleId !== "string" || !saleId) {
    return refuse("bad-sale", "The attach names no sale.");
  }
  if (current.used.sale) {
    if (current.used.sale.saleId === saleId) return { ok: true, already: true };
    return refuse("sale-mismatch", "This settlement already records a different sale — nothing was changed.");
  }
  if (saleCheck?.state === "mismatch") {
    return refuse("sale-mismatch", `The sale does not match what was settled against this payment (${saleCheck.why}) — nothing was attached. The owner has been shown it.`);
  }
  const verified = saleCheck?.state === "verified";
  const used = { ...current.used, sale: { saleId, receiptNumber: receiptNumber ?? null, at, verified } };
  const remainder = remainderPlanOf(poolKey, used, current.amountCents, {
    holdReason: verified ? null : "the sale was not on the server when the payment was attached, so it could not be checked",
  });
  if (remainder) used.remainder = remainder;
  return { ok: true, value: { ...current, used } };
}

/**
 * The owner assigns a customer to a HELD remainder — the unallocated money
 * becomes that customer's store credit through the same mint. Idempotent for
 * the same customer; refuses to move a remainder that is already someone's
 * credit (that is a reversal conversation, not an allocate).
 */
function allocateRemainderDecision(current, { poolKey, at, customerId, customerName }) {
  if (typeof customerId !== "string" || !customerId) {
    return refuse("bad-customer", "The allocation names no customer.");
  }
  if (!current || current.status !== "used" || !current.used?.remainder) {
    return refuse("no-remainder", "This payment has no held remainder to allocate.");
  }
  const r = current.used.remainder;
  if (r.disposition === "credit") {
    if (r.customerId === customerId) return { ok: true, already: true };
    return refuse("already-credited",
      `This remainder is already ${r.status === "issued" ? "issued as" : "becoming"} store credit for ${r.customerName || "another customer"}.`);
  }
  return {
    ok: true,
    value: {
      ...current,
      used: {
        ...current.used,
        remainder: {
          ...r,
          disposition: "credit",
          customerId,
          customerName: customerName ?? null,
          creditId: eftCreditIdOf(poolKey, current.used.at),
          status: "pending",
          allocatedAt: at,
          allocatedBy: "owner",
        },
      },
    },
  };
}

/**
 * The follow-up IO reports what it did: "pending" → "issued" (credit minted)
 * or "held" (/eft_unallocated written). A transaction, not a set — a reverse
 * racing this must not find a stray child re-created under a used that is gone.
 */
function remainderStatusDecision(current, { status, at }) {
  if (!current?.used?.remainder) {
    return refuse("no-remainder", "No remainder on this settlement.");
  }
  if (current.used.remainder.status === status) return { ok: true, already: true };
  return {
    ok: true,
    value: {
      ...current,
      used: { ...current.used, remainder: { ...current.used.remainder, status, statusAt: at } },
    },
  };
}

/**
 * used → unmatched because the sale never committed. Holder-only, no attached
 * sale, and the attempt goes on record — a payment that silently un-used
 * itself would be undiagnosable at the counter.
 */
function releaseDecision(current, { attemptId, at, reason }) {
  if (!current || current.status !== "used" || !current.used) {
    // A RETRIED release (the till timed out after the first one landed) finds
    // the payment already back in the pool — the appended attempt is the
    // proof, and the retry is a success, not a "not-held" error the cashier
    // has to puzzle over. (CodeRabbit, this PR.)
    const alreadyReleased = Object.values(current?.attempts ?? {})
      .some((a) => a?.attemptId === attemptId && a?.ended === "released");
    if (alreadyReleased) return { ok: true, already: true };
    return refuse("not-held", "No settlement is holding this payment.");
  }
  // The owner's mark-as-used is not a till's hold: it is undone by a reversal
  // (both records kept), never by a release.
  if (current.used.outsidePos) {
    return refuse("settled-outside", "This payment was marked as settled outside the POS — only the owner's reversal undoes that.");
  }
  if (current.used.attemptId !== attemptId) {
    return refuse("not-holder", "A different settlement holds this payment — it cannot be released from this till.");
  }
  if (current.used.sale) {
    return refuse("sale-attached", "A completed sale is recorded against this payment — releasing it is a reversal, which only the owner can do.");
  }
  const { used, ...rest } = current;
  return {
    ok: true,
    value: {
      ...rest,
      status: "unmatched",
      used: null,
      attempts: {
        ...(current.attempts ?? {}),
        // epoch-ms key: sortable, never ISO/free text in an RTDB key (#269).
        [at]: { ...used, sale: null, ended: "released", endedAt: at, reason: String(reason ?? "released") },
      },
    },
  };
}

/**
 * The owner unwinds a settlement. Never silent: the whole settlement —
 * cashier, customer, sale, times — survives under `reversals`, and later
 * settlements' reversals accumulate beside it. The sale record is not this
 * module's to touch.
 */
function reverseDecision(current, { at, by, reason }) {
  if (!current || current.status !== "used" || !current.used) {
    return refuse("not-used", "This payment is not settled against anything — there is nothing to reverse.");
  }
  const { used, ...rest } = current;
  return {
    ok: true,
    value: {
      ...rest,
      status: "unmatched",
      used: null,
      reversals: {
        ...(current.reversals ?? {}),
        [at]: { ...used, reversedAt: at, reversedBy: String(by ?? ""), reason: String(reason ?? "") },
      },
    },
  };
}

// ─── THE OWNER'S RELEASE FROM QUARANTINE (fix 1) ────────────────────────────
// A payment the poller HELD because its notification carries no bank
// transaction id can never become spendable on its own. The owner — and only
// the owner, checked by the callable — can release it after checking it on the
// bank statement: it becomes an ordinary unmatched payment, with the release
// (who, when, why) on the record for ever. A HELD DUPLICATE is never released:
// the original record already holds that money, and releasing a copy is
// exactly the double-spend the hold exists to stop.
const RELEASE_REASON_MIN = 3;
const RELEASE_REASON_MAX = 300;

function releaseHoldDecision(current, { at, by, reason }) {
  if (!current || typeof current !== "object") return refuse("not-found", "That record is no longer in the pool.");
  if (current.outcome === "held-duplicate") {
    return refuse("duplicate-never-released", "This is a second copy of a payment the pool already holds under another record. A copy is never released — use the original.");
  }
  if (current.outcome !== "held-no-bankref") {
    return refuse("not-held", "Only a payment held for having no bank transaction id can be released.");
  }
  const why = String(reason ?? "").trim();
  if (why.length < RELEASE_REASON_MIN) return refuse("bad-reason", "Say how you checked it — the reason stays on the record.");
  if (!Number.isInteger(at)) return refuse("bad-time", "The release carries no server time — refused.");
  return {
    ok: true,
    value: {
      ...current,
      outcome: "recorded",
      status: "unmatched",
      releasedFromHold: { at, by: String(by ?? ""), reason: why.slice(0, RELEASE_REASON_MAX), from: "held-no-bankref" },
    },
  };
}

/**
 * What eftRemainderScan does with one /eft_pending_remainders breadcrumb.
 * Breadcrumbs are written BEFORE the attach/allocate transaction, so their
 * existence proves nothing by itself — the pool record decides:
 *   "wait"    the breadcrumb is fresh; the callable that wrote it is probably
 *             still finishing. Touch nothing.
 *   "finish"  a stamped remainder is still pending — the follow-up IO crashed;
 *             re-run finishRemainder.
 *   "clear"   there is nothing to finish (no remainder was stamped, the plan
 *             already reached a terminal state, or the settlement was reversed
 *             — the reverse cleans its own claim). Remove the breadcrumb.
 */
function pendingRemainderScanAction(breadcrumb, record, nowMs, minAgeMs) {
  const at = Number.isInteger(breadcrumb?.at) ? breadcrumb.at : 0;
  if (nowMs - at < minAgeMs) return "wait";
  if (record?.status === "used" && record.used?.remainder?.status === "pending") return "finish";
  return "clear";
}

/**
 * The transaction update function the callable hands to the Admin SDK,
 * wrapping one decision — PURE and here so the null-first-call handling is
 * itself under test (test/eft-pool-settle.test.cjs), not just reasoned about:
 *
 * THE NULL-FIRST-CALL TRAP. The Admin SDK runs the update function with null
 * when its cache is cold, and returning undefined THERE aborts without ever
 * consulting the server — a "not found" verdict on a record that exists. So a
 * null current returns null instead: the compare-and-swap then fails against
 * the real server value (a true no-op when the record is genuinely absent)
 * and the function re-runs with the actual record. The DECISION captured via
 * `capture`, not the transaction's `committed`, is the outcome that matters.
 *
 * @param {(current:any)=>object} decide   one of the decision functions above
 * @param {(d:object)=>void} capture       receives every run's decision; the
 *                                         last one is authoritative
 */
function poolTransactionStep(decide, capture) {
  return (current) => {
    const decision = decide(current);
    capture(decision);
    if (decision.ok && !decision.already) return decision.value;
    if (current === null) return null; // force the server round-trip
    return undefined; // genuine refusal or idempotent no-op: leave the record be
  };
}

module.exports = {
  settleDecision, attachSaleDecision, releaseDecision, reverseDecision, poolTransactionStep,
  markUsedOutsidePosDecision, OUTSIDE_POS_REASON_MAX, OUTSIDE_POS_REASON_MIN,
  eftCreditIdOf, remainderPlanOf, allocateRemainderDecision, remainderStatusDecision,
  pendingRemainderScanAction,
  releaseHoldDecision, RELEASE_REASON_MIN,
  saleCheckOf, flagSaleMismatchDecision,
};
