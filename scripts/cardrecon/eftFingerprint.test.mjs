// ─── THE PAYMENT'S IDENTITY, AND THE TWO COPIES OF IT ───────────────────────
// Two things are pinned here, and the second is the one that would fail
// silently:
//
//   1. WHAT THE FINGERPRINT IS. Above all, that the real incident is caught:
//      one proof of payment re-sent from a banking app arrives as a different
//      email carrying the same bank reference, and must read as the same money.
//
//   2. THAT THE TWO IMPLEMENTATIONS AGREE. The poller is ESM and the settle
//      callable is CommonJS, so the logic exists twice. A fingerprint computed
//      at ingestion and one computed at consume time that disagreed would let a
//      duplicate through the exact guard built to catch it — and nothing would
//      look wrong. Both files are run against the same table, here.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import * as esm from "./eftFingerprint.mjs";

const require = createRequire(import.meta.url);
const cjs = require("../../functions/lib/eft-fingerprint.cjs");

// The two Standard Bank notifications from the live incident, 2026-09-09.
// Same payment, same bank reference, DIFFERENT emails ten days apart.
const ORIGINAL = {
  reader: "standardbank", bankRef: "4141078732", amountCents: 10000,
  reference: "OM82", payer: "OUSMANE THIAM", bankTs: Date.parse("2026-08-31T08:10:00+02:00"),
};
const RESENT = { ...ORIGINAL };   // a re-send carries the identical payment fields

test("THE INCIDENT: a proof of payment re-sent as a new email is the same payment", () => {
  const a = esm.paymentFingerprint(ORIGINAL);
  const b = esm.paymentFingerprint(RESENT);
  assert.equal(a.hash, b.hash);
  assert.equal(a.kind, "bank");
  assert.equal(a.basis, "bank:standardbank:4141078732");

  // …and the decision on the second arrival is a HARD refusal, not a hold.
  const d = esm.admissionDecision({
    fingerprint: b, existing: { poolKey: "c348a2c05f", kind: "bank" }, incomingPoolKey: "1af37b122d",
  });
  assert.equal(d.action, "reject");
  assert.match(d.reason, /already been received/);
  assert.match(d.reason, /c348a2c05f/);
});

test("the bank's own reference is the identity — the envelope is not part of it", () => {
  // Nothing about the message may enter the fingerprint, or the bug returns.
  const withEnvelope = esm.paymentFingerprint({ ...ORIGINAL, messageId: "<different@bank>", receivedAt: 999 });
  assert.equal(withEnvelope.hash, esm.paymentFingerprint(ORIGINAL).hash);
});

test("two banks' numbering spaces cannot collide into a false duplicate", () => {
  const sb = esm.paymentFingerprint({ ...ORIGINAL, reader: "standardbank" });
  const fnb = esm.paymentFingerprint({ ...ORIGINAL, reader: "fnb" });
  assert.notEqual(sb.hash, fnb.hash);
});

test("a genuinely different payment from the same payer is NOT a duplicate", () => {
  const other = esm.paymentFingerprint({ ...ORIGINAL, bankRef: "4141078733" });
  assert.notEqual(other.hash, esm.paymentFingerprint(ORIGINAL).hash);
});

// ─── THE COMPOSITE TIER ──────────────────────────────────────────────────────
const NO_BANKREF = {
  reader: "fnb", bankRef: "", amountCents: 3000,
  reference: "MR M", payer: "MARA-THONE TRADING", bankTs: Date.parse("2026-08-31T08:00:00+02:00"),
};

test("with no bank reference it falls back to a composite, and says so", () => {
  const f = esm.paymentFingerprint(NO_BANKREF);
  assert.equal(f.kind, "composite");
  assert.equal(f.basis, "composite:fnb:3000:mrm:marathonetrading:2026-08-31");
  // null and undefined are the same absence as ""
  assert.equal(esm.paymentFingerprint({ ...NO_BANKREF, bankRef: null }).hash, f.hash);
  assert.equal(esm.paymentFingerprint({ ...NO_BANKREF, bankRef: undefined }).hash, f.hash);
});

test("a composite match is HELD, never refused — two real payments can look identical", () => {
  const f = esm.paymentFingerprint(NO_BANKREF);
  const d = esm.admissionDecision({
    fingerprint: f, existing: { poolKey: "aaa", kind: "composite" }, incomingPoolKey: "bbb",
  });
  assert.equal(d.action, "quarantine");
  assert.match(d.reason, /HELD, not refused/);
});

test("the composite uses the BANK'S stated payment day, not the day we read the mail", () => {
  // Read a week late (the live pool has a record whose pooling time is seven
  // days after it arrived), the payment is still the same payment.
  const a = esm.paymentFingerprint(NO_BANKREF);
  const b = esm.paymentFingerprint({ ...NO_BANKREF, receivedAt: Date.parse("2026-09-08T00:00:00Z"), at: 1 });
  assert.equal(a.hash, b.hash);
  // A different PAYMENT day is a different payment.
  const nextDay = esm.paymentFingerprint({ ...NO_BANKREF, bankTs: Date.parse("2026-09-01T08:00:00+02:00") });
  assert.notEqual(nextDay.hash, a.hash);
});

test("the SAST day is what counts — 22:30 UTC is already tomorrow in Johannesburg", () => {
  assert.equal(esm.paymentDay(Date.parse("2026-08-31T22:30:00Z")), "2026-09-01");
  assert.equal(esm.paymentDay(Date.parse("2026-08-31T21:30:00Z")), "2026-08-31");
  assert.equal(esm.paymentDay(null), "nodate");
  assert.equal(esm.paymentDay(0), "nodate");
});

test("an undated payment still fingerprints, and can only ever be HELD", () => {
  const f = esm.paymentFingerprint({ ...NO_BANKREF, bankTs: null });
  assert.equal(f.kind, "composite");
  assert.match(f.basis, /:nodate$/);
});

// ─── WHAT IS NOT MONEY HAS NO PAYMENT IDENTITY ───────────────────────────────
test("refusals and unknown-bank notices are not fingerprinted", () => {
  for (const outcome of ["refused-auth", "refused-parse", "refused-account", "unknown-bank"]) {
    assert.equal(esm.recordFingerprint({ outcome, bankRef: "x" }), null);
  }
  assert.equal(esm.recordFingerprint(null), null);
  assert.equal(esm.recordFingerprint({ outcome: "recorded", ...ORIGINAL }).kind, "bank");
});

test("a replay of the SAME message lands on its own record and is admitted", () => {
  // The old key already made this structural; the new one must not break it.
  const f = esm.paymentFingerprint(ORIGINAL);
  const d = esm.admissionDecision({
    fingerprint: f, existing: { poolKey: "same", kind: "bank" }, incomingPoolKey: "same",
  });
  assert.equal(d.action, "admit");
});

test("a first arrival is always admitted", () => {
  assert.equal(esm.admissionDecision({ fingerprint: esm.paymentFingerprint(ORIGINAL), existing: null, incomingPoolKey: "k" }).action, "admit");
});

// ─── THE TWO IMPLEMENTATIONS MUST NOT DRIFT ──────────────────────────────────
test("the ESM poller copy and the CommonJS callable copy agree, field for field", () => {
  const table = [
    ORIGINAL, RESENT, NO_BANKREF,
    { ...ORIGINAL, reader: "capitec", bankRef: "NOT-1234" },
    { ...ORIGINAL, reader: "absa", bankRef: "80D2F2AB5A-1" },
    { ...NO_BANKREF, bankTs: null },
    { ...NO_BANKREF, reference: null, payer: null },
    { ...NO_BANKREF, amountCents: null },
    { reader: null, bankRef: null, amountCents: 1, reference: "  ", payer: "  ", bankTs: 0 },
    { reader: "fnb", bankRef: "  5tg 59-dvq  ", amountCents: 1, reference: "a", payer: "b", bankTs: 1 },
  ];
  for (const row of table) {
    const a = esm.paymentFingerprint(row);
    const b = cjs.paymentFingerprint(row);
    assert.deepEqual(a, b, `drift on ${JSON.stringify(row)}`);
  }
  for (const helper of ["normaliseIdentityText", "paymentDay"]) {
    for (const v of ["MR M", "  ", null, 0, "Ousmane-Thiam", 1788163899952]) {
      assert.deepEqual(esm[helper](v), cjs[helper](v), `${helper} drift on ${JSON.stringify(v)}`);
    }
  }
  const rec = { outcome: "recorded", ...ORIGINAL };
  assert.deepEqual(esm.recordFingerprint(rec), cjs.recordFingerprint(rec));
  const args = { fingerprint: esm.paymentFingerprint(ORIGINAL), existing: { poolKey: "x" }, incomingPoolKey: "y" };
  assert.deepEqual(esm.admissionDecision(args), cjs.admissionDecision(args));
});

test("a whitespace-only bank reference is an ABSENT one, not a bank-tier identity", () => {
  // Otherwise every bank that prints an empty label shares one fingerprint and
  // the second such payment anywhere gets hard-refused as a duplicate.
  const blank = esm.paymentFingerprint({ ...ORIGINAL, bankRef: "   " });
  assert.equal(blank.kind, "composite");
});
