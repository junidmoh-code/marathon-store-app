// ─── EFT CONSUME-ONCE — one payment settles exactly one sale ─────────────────
// THE TEST THAT MATTERS IN THIS BUILD, written before the implementation and
// run to fail first. Two tills find the same unmatched payment and both tap
// COMPLETE in the same instant: exactly one wins, the loser gets a sentence a
// cashier can read out, and a silent double-settle is impossible — enforced by
// an RTDB transaction on /eft_pool/{key} whose entire decision lives in the
// pure functions under test here (lib/eft-settle.cjs).
//
// The concurrency harness below mimics RTDB transaction semantics exactly:
// optimistic read, compute, compare-and-swap, and ON CONTENTION THE UPDATE
// FUNCTION RE-RUNS AGAINST THE NEW VALUE — which is precisely where a naive
// "check then write" would double-settle and where these decisions must abort.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  settleDecision, attachSaleDecision, releaseDecision, reverseDecision, poolTransactionStep,
  eftCreditIdOf, allocateRemainderDecision, remainderStatusDecision,
} = require("../lib/eft-settle.cjs");

// ── an RTDB-transaction stand-in ─────────────────────────────────────────────
// Serialised CAS with re-run-on-contention, like the real database. `stall`
// lets a test interleave: read the snapshot, let the rival commit, then re-run.
function makeNode(initial) {
  let value = initial;
  return {
    get: () => value,
    transaction(update) {
      let tries = 0;
      for (;;) {
        if (++tries > 25) throw new Error("transaction livelock");
        const before = value;
        const next = update(before);
        if (next === undefined) return { committed: false, snapshot: value };
        if (value !== before) continue; // contention: re-run against the new value
        value = next;
        return { committed: true, snapshot: value };
      }
    },
  };
}

// The transaction body the callable runs: decision → write or abort.
function runSettle(node, settlement) {
  let out = null;
  const res = node.transaction((cur) => {
    out = settleDecision(cur, settlement);
    return out.ok && !out.already ? out.value : undefined;
  });
  return { ...out, committed: res.committed, snapshot: node.get() };
}

function recorded(over = {}) {
  return {
    at: 1000, outcome: "recorded", status: "unmatched",
    amountCents: 55000, reference: "JUNID1234", payer: "J SOAP",
    bankTs: 890, bankRef: "4140542552", reader: "standardbank",
    accountTail: "6625", auth: { verdict: "pass" }, rawText: "…",
    ...over,
  };
}

const tillA = {
  attemptId: "P-a1", at: 5000, cashierUid: "uA", cashierName: "Ahmed",
  storeId: "pe", tillId: "till1", customerId: "c1", customerName: "Mr Dlamini",
  appliedCents: 55000,
};
const tillB = {
  attemptId: "P-b1", at: 5001, cashierUid: "uB", cashierName: "Sipho",
  storeId: "cr", tillId: "till2", customerId: null, customerName: null,
  appliedCents: 55000,
};

// ── THE RACE ─────────────────────────────────────────────────────────────────
test("two tills, same payment, same instant: exactly one wins", () => {
  const node = makeNode(recorded());

  // Both tills' callables run their transaction; RTDB serialises them. Model
  // the worst interleaving: B's update function first runs against the
  // pre-settle snapshot (as if it read before A committed), then re-runs
  // against A's committed value — makeNode does exactly that re-run.
  const a = runSettle(node, tillA);
  const b = runSettle(node, tillB);

  assert.equal(a.ok, true);
  assert.equal(a.committed, true);
  assert.equal(b.ok, false);
  assert.equal(b.committed, false);
  assert.equal(b.code, "already-used");
  // The loser's message is for reading out at the counter: who has it.
  assert.match(b.message, /Ahmed/);

  const after = node.get();
  assert.equal(after.status, "used");
  assert.equal(after.used.cashierUid, "uA");
  assert.equal(after.used.attemptId, "P-a1");
  assert.equal(after.used.sale, null); // the sale attaches after it commits
  // Everything the poller wrote is still there — settling never rewrites the
  // payment, it only moves its status.
  assert.equal(after.amountCents, 55000);
  assert.equal(after.reference, "JUNID1234");
  assert.equal(after.rawText, "…");
});

test("the same till retrying its own settle (network blip) is not a loss", () => {
  const node = makeNode(recorded());
  runSettle(node, tillA);
  const retry = runSettle(node, tillA); // same attemptId
  assert.equal(retry.ok, true);
  assert.equal(retry.already, true);
  assert.equal(node.get().used.attemptId, "P-a1");
});

test("settle refuses a missing record, a refusal record, and bad amounts", () => {
  assert.equal(runSettle(makeNode(null), tillA).code, "not-found");
  assert.equal(runSettle(makeNode(recorded({ outcome: "refused-auth" })), tillA).code, "not-a-payment");
  assert.equal(runSettle(makeNode(recorded({ outcome: "refused-account" })), tillA).code, "not-a-payment");
  // Applied amount must be a positive integer within the payment.
  assert.equal(runSettle(makeNode(recorded()), { ...tillA, appliedCents: 0 }).code, "bad-amount");
  assert.equal(runSettle(makeNode(recorded()), { ...tillA, appliedCents: 55001 }).code, "bad-amount");
  assert.equal(runSettle(makeNode(recorded()), { ...tillA, appliedCents: 1.5 }).code, "bad-amount");
  // And the settlement must name its cashier — an anonymous settle is refused.
  assert.equal(runSettle(makeNode(recorded()), { ...tillA, cashierUid: null }).code, "bad-settlement");
});

// ── ATTACH: the committed sale's identity lands on the settlement ────────────
test("attach records the sale on the settlement, idempotently, holder-only", () => {
  const node = makeNode(recorded());
  runSettle(node, tillA);

  const attach = (args) => {
    let out = null;
    node.transaction((cur) => {
      out = attachSaleDecision(cur, args);
      return out.ok && !out.already ? out.value : undefined;
    });
    return out;
  };

  const ok = attach({ attemptId: "P-a1", saleId: "S-1", receiptNumber: "00042", at: 6000 });
  assert.equal(ok.ok, true);
  assert.deepEqual(node.get().used.sale, { saleId: "S-1", receiptNumber: "00042", at: 6000 });

  // A retried attach of the same sale is a no-op, not an error.
  assert.equal(attach({ attemptId: "P-a1", saleId: "S-1", receiptNumber: "00042", at: 6001 }).already, true);
  // A DIFFERENT sale, or a different attempt, must never overwrite the record.
  assert.equal(attach({ attemptId: "P-a1", saleId: "S-2", receiptNumber: "00043", at: 6002 }).ok, false);
  assert.equal(attach({ attemptId: "P-b1", saleId: "S-9", receiptNumber: "00099", at: 6003 }).ok, false);
  assert.equal(node.get().used.sale.saleId, "S-1");
});

// ── RELEASE: the sale failed to commit — hand the payment back, with a trace ─
test("release returns the payment to the pool and leaves the attempt on record", () => {
  const node = makeNode(recorded());
  runSettle(node, tillA);

  let out = null;
  node.transaction((cur) => {
    out = releaseDecision(cur, { attemptId: "P-a1", at: 7000, reason: "the sale did not complete" });
    return out.ok ? out.value : undefined;
  });
  assert.equal(out.ok, true);
  const after = node.get();
  assert.equal(after.status, "unmatched");
  assert.equal(after.used, null);
  // NEVER a silent unwind: the aborted attempt stays on the record.
  const trace = after.attempts?.[7000];
  assert.equal(trace.cashierName, "Ahmed");
  assert.equal(trace.ended, "released");
  assert.match(trace.reason, /did not complete/);

  // And the payment is settleable again — by anyone.
  assert.equal(runSettle(node, tillB).ok, true);
});

test("release is holder-only and never touches an attached sale", () => {
  const node = makeNode(recorded());
  runSettle(node, tillA);
  let out = null;
  node.transaction((cur) => {
    out = releaseDecision(cur, { attemptId: "P-b1", at: 7000, reason: "x" });
    return out.ok ? out.value : undefined;
  });
  assert.equal(out.ok, false);

  node.transaction((cur) => {
    const a = attachSaleDecision(cur, { attemptId: "P-a1", saleId: "S-1", receiptNumber: "00042", at: 7100 });
    return a.ok ? a.value : undefined;
  });
  node.transaction((cur) => {
    out = releaseDecision(cur, { attemptId: "P-a1", at: 7200, reason: "x" });
    return out.ok ? out.value : undefined;
  });
  // A settlement with a committed sale is not releasable — that is a REVERSAL,
  // an owner's decision, never a till's.
  assert.equal(out.ok, false);
  assert.equal(node.get().status, "used");
});

// ── REVERSE: possible, never silent — both records survive ───────────────────
test("reverse returns the payment to the pool and keeps the whole settlement", () => {
  const node = makeNode(recorded());
  runSettle(node, tillA);
  node.transaction((cur) => {
    const a = attachSaleDecision(cur, { attemptId: "P-a1", saleId: "S-1", receiptNumber: "00042", at: 8000 });
    return a.ok ? a.value : undefined;
  });

  let out = null;
  node.transaction((cur) => {
    out = reverseDecision(cur, { at: 9000, by: "gunidmoh@gmail.com", reason: "settled against the wrong sale" });
    return out.ok ? out.value : undefined;
  });
  assert.equal(out.ok, true);
  const after = node.get();
  assert.equal(after.status, "unmatched");
  assert.equal(after.used, null);
  const rev = after.reversals?.[9000];
  assert.equal(rev.cashierName, "Ahmed");
  assert.equal(rev.sale.receiptNumber, "00042");
  assert.equal(rev.reversedBy, "gunidmoh@gmail.com");
  assert.match(rev.reason, /wrong sale/);

  // Reversing an unmatched payment refuses; a second reverse refuses.
  node.transaction((cur) => {
    out = reverseDecision(cur, { at: 9100, by: "gunidmoh@gmail.com", reason: "again" });
    return out.ok ? out.value : undefined;
  });
  assert.equal(out.ok, false);

  // The freed payment can be settled again, and a later reverse of THAT
  // settlement lands beside the first — history accumulates, never overwrites.
  assert.equal(runSettle(node, tillB).ok, true);
  node.transaction((cur) => {
    out = reverseDecision(cur, { at: 9500, by: "gunidmoh@gmail.com", reason: "second" });
    return out.ok ? out.value : undefined;
  });
  assert.equal(out.ok, true);
  assert.equal(Object.keys(node.get().reversals).length, 2);
  assert.equal(node.get().reversals[9000].cashierName, "Ahmed");
  assert.equal(node.get().reversals[9500].cashierName, "Sipho");
});

// ── THE ADMIN SDK'S NULL-FIRST-CALL TRAP, tested rather than reasoned about ──
// admin.database().ref().transaction runs the update function with null when
// its cache is cold; returning undefined THERE aborts without consulting the
// server. This fake reproduces exactly that: fn(null) first, and only a
// non-undefined return earns the re-run against the real server value.
function adminLikeTransaction(serverValue, fn) {
  const first = fn(null);
  if (first === undefined) return { committed: false, ranWithServerValue: false };
  if (serverValue === null) return { committed: true, value: first, ranWithServerValue: false };
  // CAS against the server fails (null !== serverValue) → re-run with truth.
  const second = fn(serverValue);
  if (second === undefined) return { committed: false, ranWithServerValue: true };
  return { committed: true, value: second, ranWithServerValue: true };
}

test("poolTransactionStep: a cold cache still reaches the real record", () => {
  const server = recorded();
  let decision = null;
  const res = adminLikeTransaction(server, poolTransactionStep((cur) => settleDecision(cur, tillA), (d) => { decision = d; }));
  // Without the null→null return, fn(null) would refuse "not-found" and abort
  // blind; with it, the decision that stands was made against the record.
  assert.equal(res.ranWithServerValue, true);
  assert.equal(decision.ok, true);
  assert.equal(res.value.status, "used");
});

test("poolTransactionStep: a genuinely absent record refuses not-found, harmlessly", () => {
  let decision = null;
  const res = adminLikeTransaction(null, poolTransactionStep((cur) => settleDecision(cur, tillA), (d) => { decision = d; }));
  assert.equal(decision.ok, false);
  assert.equal(decision.code, "not-found");
  assert.equal(res.value, null); // the committed null is a no-op delete of nothing
});

test("poolTransactionStep: a refusal against real data leaves the record be", () => {
  const server = recorded({ status: "used", used: { attemptId: "P-other", cashierName: "Sipho", sale: null } });
  let decision = null;
  const res = adminLikeTransaction(server, poolTransactionStep((cur) => settleDecision(cur, tillA), (d) => { decision = d; }));
  assert.equal(res.committed, false);
  assert.equal(res.ranWithServerValue, true);
  assert.equal(decision.code, "already-used");
});

// ── THE REMAINDER — the R30-sale/R100-payment incident, closed ───────────────
// A payment bigger than the sale is consumed whole; the difference must be
// OWED TO SOMEONE, never a bare "overpaid" note. The plan is stamped at
// attach (the sale is real by then; a released payment owes nobody) and the
// callable's follow-up IO turns it into store credit or a visible hold.
const KEY = "a".repeat(40);

function settleAndAttach(node, settlement, saleId = "S-1") {
  runSettle(node, settlement);
  let out = null;
  node.transaction((cur) => {
    out = attachSaleDecision(cur, { attemptId: settlement.attemptId, saleId, receiptNumber: "00042", at: 6000, poolKey: KEY });
    return out.ok && !out.already ? out.value : undefined;
  });
  return out;
}

test("attach on a partial application stamps a store-credit remainder for the customer", () => {
  // R100 payment, R30 applied — tillA carries a customer.
  const node = makeNode(recorded({ amountCents: 10000 }));
  settleAndAttach(node, { ...tillA, appliedCents: 3000 });
  const r = node.get().used.remainder;
  assert.equal(r.cents, 7000);
  assert.equal(r.disposition, "credit");
  assert.equal(r.customerId, "c1");
  assert.equal(r.customerName, "Mr Dlamini");
  assert.equal(r.creditId, eftCreditIdOf(KEY, 5000)); // deterministic: pool key + settle time
  assert.equal(r.status, "pending"); // the follow-up IO moves it to "issued"
});

test("attach with no customer stamps an UNALLOCATED remainder — held, never swallowed", () => {
  const node = makeNode(recorded({ amountCents: 10000 }));
  settleAndAttach(node, { ...tillB, appliedCents: 3000 }); // tillB has no customer
  const r = node.get().used.remainder;
  assert.equal(r.cents, 7000);
  assert.equal(r.disposition, "unallocated");
  assert.equal(r.customerId, null);
  assert.equal(r.creditId, null);
  assert.equal(r.status, "pending"); // the follow-up IO moves it to "held"
});

test("an exact payment stamps NO remainder", () => {
  const node = makeNode(recorded({ amountCents: 55000 }));
  settleAndAttach(node, tillA); // appliedCents 55000
  assert.equal(node.get().used.remainder, undefined);
});

test("a released payment carries no remainder — nothing was owed on a sale that never happened", () => {
  const node = makeNode(recorded({ amountCents: 10000 }));
  runSettle(node, { ...tillA, appliedCents: 3000 });
  let out = null;
  node.transaction((cur) => {
    out = releaseDecision(cur, { attemptId: "P-a1", at: 7000, reason: "the sale did not complete" });
    return out.ok ? out.value : undefined;
  });
  assert.equal(out.ok, true);
  assert.equal(node.get().attempts[7000].remainder, undefined);
  assert.equal(node.get().used, null);
});

test("the owner allocates a held remainder to a customer; already-credited refuses", () => {
  const node = makeNode(recorded({ amountCents: 10000 }));
  settleAndAttach(node, { ...tillB, appliedCents: 3000 });
  const allocate = (args) => {
    let out = null;
    node.transaction((cur) => {
      out = allocateRemainderDecision(cur, { poolKey: KEY, at: 9000, ...args });
      return out.ok && !out.already ? out.value : undefined;
    });
    return out;
  };
  assert.equal(allocate({ customerId: null }).code, "bad-customer");
  assert.equal(allocate({ customerId: "c9", customerName: "Mrs Naidoo" }).ok, true);
  const r = node.get().used.remainder;
  assert.equal(r.disposition, "credit");
  assert.equal(r.customerId, "c9");
  assert.equal(r.creditId, eftCreditIdOf(KEY, 5001)); // tillB settled at 5001
  assert.equal(r.status, "pending");
  // The same customer again: idempotent. A different one: a refusal, not a move.
  assert.equal(allocate({ customerId: "c9", customerName: "Mrs Naidoo" }).already, true);
  assert.equal(allocate({ customerId: "c8", customerName: "Someone Else" }).code, "already-credited");
  // A remainder on a payment that was never partially applied: nothing to allocate.
  const exact = makeNode(recorded({ amountCents: 55000 }));
  settleAndAttach(exact, tillA);
  let out = null;
  exact.transaction((cur) => {
    out = allocateRemainderDecision(cur, { poolKey: KEY, at: 9000, customerId: "c9", customerName: "x" });
    return out.ok && !out.already ? out.value : undefined;
  });
  assert.equal(out.code, "no-remainder");
});

test("remainderStatusDecision moves pending → issued/held, idempotently, and refuses with no remainder", () => {
  const node = makeNode(recorded({ amountCents: 10000 }));
  settleAndAttach(node, { ...tillA, appliedCents: 3000 });
  const flip = (status) => {
    let out = null;
    node.transaction((cur) => {
      out = remainderStatusDecision(cur, { status, at: 9500 });
      return out.ok && !out.already ? out.value : undefined;
    });
    return out;
  };
  assert.equal(flip("issued").ok, true);
  assert.equal(node.get().used.remainder.status, "issued");
  assert.equal(flip("issued").already, true);
  const bare = makeNode(recorded());
  let out = null;
  bare.transaction((cur) => {
    out = remainderStatusDecision(cur, { status: "issued", at: 9500 });
    return out.ok && !out.already ? out.value : undefined;
  });
  assert.equal(out.code, "no-remainder");
});

test("a reversal keeps the remainder (creditId included) on the reversal record", () => {
  const node = makeNode(recorded({ amountCents: 10000 }));
  settleAndAttach(node, { ...tillA, appliedCents: 3000 });
  node.transaction((cur) => {
    const s = remainderStatusDecision(cur, { status: "issued", at: 9500 });
    return s.ok && !s.already ? s.value : undefined;
  });
  let out = null;
  node.transaction((cur) => {
    out = reverseDecision(cur, { at: 9900, by: "gunidmoh@gmail.com", reason: "wrong sale" });
    return out.ok ? out.value : undefined;
  });
  const rev = node.get().reversals[9900];
  assert.equal(rev.remainder.creditId, eftCreditIdOf(KEY, 5000));
  assert.equal(rev.remainder.status, "issued"); // the credit STANDS; the owner removes it separately
});

// ── UNDERPAYMENT + MULTIPLE PAYMENTS, ONE SALE ───────────────────────────────
// A R700 payment against a R750 sale settles R700 (appliedCents = the whole
// payment, no remainder) and the R50 is another tender's business. A customer
// who paid in two transfers: each payment is its OWN consume-once transaction
// on its OWN node — the guarantee is per payment, and a rival till loses on
// exactly the payment it raced for, never on the other.
test("underpayment: the whole payment applies, no remainder, the balance is another tender's", () => {
  const node = makeNode(recorded({ amountCents: 70000 }));
  settleAndAttach(node, { ...tillA, appliedCents: 70000 }); // R700 of a R750 sale
  const after = node.get();
  assert.equal(after.status, "used");
  assert.equal(after.used.appliedCents, 70000);
  assert.equal(after.used.remainder, undefined);
});

test("two pool payments settle one sale; a rival till loses only the payment it raced for", () => {
  const p1 = makeNode(recorded({ amountCents: 40000 }));
  const p2 = makeNode(recorded({ amountCents: 40000, reference: "JUNID5678" }));

  // The same till settles both legs of a R750 sale: R400 + R350 (the second
  // payment overpays by R50 — ITS remainder, not the first's).
  const legA1 = { ...tillA, attemptId: "P-a1", appliedCents: 40000 };
  const legA2 = { ...tillA, attemptId: "P-a2", appliedCents: 35000 };
  assert.equal(runSettle(p1, legA1).ok, true);
  // A rival till grabs payment 2 at the same instant — and wins it.
  assert.equal(runSettle(p2, { ...tillB, appliedCents: 40000 }).ok, true);
  const lost = runSettle(p2, legA2);
  assert.equal(lost.ok, false);
  assert.equal(lost.code, "already-used");
  // Payment 1 is untouched by that loss — the first till still holds it, and
  // releases it exactly as a single-payment sale failure would.
  assert.equal(p1.get().used.attemptId, "P-a1");
  let out = null;
  p1.transaction((cur) => {
    out = releaseDecision(cur, { attemptId: "P-a1", at: 7000, reason: "another EFT leg on the same sale could not be settled" });
    return out.ok ? out.value : undefined;
  });
  assert.equal(out.ok, true);
  assert.equal(p1.get().status, "unmatched");

  // Undisturbed run: both settle, both attach to the same sale, and only the
  // overpaying leg carries a remainder.
  const q1 = makeNode(recorded({ amountCents: 40000 }));
  const q2 = makeNode(recorded({ amountCents: 40000 }));
  settleAndAttach(q1, legA1, "S-7");
  settleAndAttach(q2, legA2, "S-7");
  assert.equal(q1.get().used.sale.saleId, "S-7");
  assert.equal(q2.get().used.sale.saleId, "S-7");
  assert.equal(q1.get().used.remainder, undefined);
  assert.equal(q2.get().used.remainder.cents, 5000);
});

test("a retried release (till timed out after the first landed) is a success, not an error", () => {
  const node = makeNode(recorded());
  runSettle(node, tillA);
  const release = (args) => {
    let out = null;
    node.transaction((cur) => {
      out = releaseDecision(cur, args);
      return out.ok && !out.already ? out.value : undefined;
    });
    return out;
  };
  assert.equal(release({ attemptId: "P-a1", at: 7000, reason: "x" }).ok, true);
  const retry = release({ attemptId: "P-a1", at: 7001, reason: "x" });
  assert.equal(retry.ok, true);
  assert.equal(retry.already, true);
  // A DIFFERENT attempt still gets the honest refusal.
  assert.equal(release({ attemptId: "P-zz", at: 7002, reason: "x" }).ok, false);
});
