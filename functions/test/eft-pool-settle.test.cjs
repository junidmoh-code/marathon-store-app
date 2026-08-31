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
