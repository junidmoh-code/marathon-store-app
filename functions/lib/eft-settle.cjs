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
        appliedCents: s.appliedCents,
        sale: null, // the sale attaches only after it has committed
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
function remainderPlanOf(poolKey, used, amountCents) {
  const cents = Number.isInteger(amountCents) && Number.isInteger(used?.appliedCents)
    ? amountCents - used.appliedCents
    : 0;
  if (cents <= 0) return null;
  const customerId = used.customerId ?? null;
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
function attachSaleDecision(current, { attemptId, saleId, receiptNumber, at, poolKey }) {
  if (!current || current.status !== "used" || !current.used) {
    return refuse("not-held", "No settlement is holding this payment — the sale cannot be attached.");
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
  const used = { ...current.used, sale: { saleId, receiptNumber: receiptNumber ?? null, at } };
  const remainder = remainderPlanOf(poolKey, used, current.amountCents);
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
  eftCreditIdOf, remainderPlanOf, allocateRemainderDecision, remainderStatusDecision,
  pendingRemainderScanAction,
};
