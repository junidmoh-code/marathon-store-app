// ─── PARKED-EFT WATCH → THE ORDINARY SEARCH → CONSUME-ONCE (11 Nov 2026) ─────
// The POS parks a sale with the reference the cashier typed (marathon-pos-app
// src/sale/parkedEft.js watch) and its 2-minute scan turns the tray light
// GREEN when a confirmed, unused payment carrying exactly that reference lands
// (functions/lib/eftParkedMatch.js watchCandidate). Green authorises nothing:
// tapping it resumes the sale into THIS repo's till search with the saved
// reference, and the card completes the sale through eftPoolSettle.
//
// Pinned here, on this repo's own code:
//   1. the watched reference, typed any way the cashier typed it, resolves
//      through searchEftPool to exactly the payment the light turned green for;
//   2. that payment settles ONCE — a second attempt (another till, or the same
//      sale re-tapped with a new attempt) is refused "already-used";
//   3. every record the watch must never light is also one the search/settle
//      will not hand over (held, refused, used, no bank identity);
//   4. PARITY FIXTURE: hasBankIdentity in the POS mirrors needsOwner here —
//      the same table lives in marathon-pos-app's eftParkedWatch test.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { searchEftPool, publicEftView } = require("../lib/eft-pool.cjs");
const { settleDecision } = require("../lib/eft-settle.cjs");
const { paymentFingerprint } = require("../lib/eft-fingerprint.cjs");

function makeNode(initial) {
  let value = initial;
  return {
    get: () => value,
    transaction(update) {
      for (let tries = 0; tries < 25; tries++) {
        const before = value;
        const next = update(before);
        if (next === undefined) return { committed: false };
        if (value !== before) continue;
        value = next;
        return { committed: true };
      }
      throw new Error("livelock");
    },
  };
}
function runSettle(node, settlement) {
  let out = null;
  const res = node.transaction((cur) => {
    out = settleDecision(cur, settlement);
    return out.ok && !out.already ? out.value : undefined;
  });
  return { ...out, committed: res.committed };
}

const payment = (over = {}) => ({
  at: 2000, outcome: "recorded", status: "unmatched",
  amountCents: 65000, reference: "JUNID 123", payer: "J MOHAMMED",
  bankTs: 1990, bankRef: "FNB77712345", reader: "fnb", ...over,
});
const FP = paymentFingerprint({ reader: "fnb", bankRef: "FNB77712345" });
const till = (attemptId, over = {}) => ({
  fingerprint: FP, attemptId, at: 5000, cashierUid: "u1", cashierName: "Amanda",
  storeId: "concrete", tillId: "till-1", customerId: null, customerName: null,
  customerResolved: false, confirmedCustomerId: null,
  // Customer-less whole-payment settle: the server re-resolves the query.
  // (the callable sets wholePaymentMatched only after re-running searchEftPool
  // for the typed query and getting THIS key back — pinned in test 1.)
  wholePaymentMatched: true,
  appliedCents: 65000, ...over,
});

test("the watched reference, as typed, finds exactly the payment the light turned green for", () => {
  const tail = {
    k1: payment(),
    k0: payment({ reference: "OTHER", bankRef: "FNB99900000", amountCents: 100 }),
  };
  for (const typed of ["JUNID 123", "junid-123", "Junid123"]) {
    const r = searchEftPool(tail, typed);
    assert.equal(r.results.length, 1, typed);
    assert.equal(r.results[0].key, "k1");
    assert.equal(r.results[0].needsOwner, false);
    assert.equal(r.results[0].status, "unmatched");
  }
  // The bank's transaction id typed instead also resolves (the watch greens on either).
  assert.equal(searchEftPool(tail, "FNB77712345").results[0].key, "k1");
});

test("tap green → completes ONCE; a second attempt is refused already-used", () => {
  const node = makeNode(payment());
  const first = runSettle(node, till("P-1"));
  assert.equal(first.ok, true, first.message);
  assert.equal(first.committed, true);
  assert.equal(node.get().status, "used");
  const second = runSettle(node, till("P-2", { tillId: "till-2", cashierUid: "u2", cashierName: "Sipho" }));
  assert.equal(second.ok, false);
  assert.equal(second.code, "already-used");
  // And the search now answers it as USED — the POS watch, which requires
  // status "unmatched", goes back to red on its next tick.
  const after = searchEftPool({ k1: node.get() }, "JUNID 123");
  assert.equal(after.results[0].status, "used");
});

test("what the watch never lights, the search never offers as a waiting payment", () => {
  for (const outcome of ["held-duplicate", "held-no-bankref", "held-possible-duplicate", "refused-auth", "refused-account", "refused-stale-date", "refused-not-immediate", "refused-untrusted-sender"]) {
    assert.deepEqual(searchEftPool({ k: payment({ outcome }) }, "JUNID 123").results, [], outcome);
  }
});

// PARITY FIXTURE with marathon-pos-app functions/__tests__/eftParkedWatch.test.js
// (hasBankIdentity): needsOwner === !hasBankIdentity for each row.
const IDENTITY_TABLE = [
  [{ reader: "fnb", bankRef: "FNB77712345" }, true],
  [{ reader: "fnb", bankRef: "12" }, false],
  [{ reader: "fnb", bankRef: "" }, false],
  [{ reader: "absa", bankRef: "", syntheticRef: "ABSA|JSOAP|1234|20261111|65000|JUNID123" }, true],
  [{ reader: "manual", bankRef: "MANUAL-1" }, true],
  [{ reader: "Bad Reader", bankRef: "FNB77712345" }, false],
  [{ reader: "fnb", bankRef: "", releasedFromHold: { at: 1 } }, true],
];
test("parity: needsOwner is exactly !hasBankIdentity on the shared table", () => {
  for (const [over, identified] of IDENTITY_TABLE) {
    const view = publicEftView("k", payment({ syntheticRef: undefined, ...over }));
    assert.equal(view.needsOwner, !identified, JSON.stringify(over));
  }
});
