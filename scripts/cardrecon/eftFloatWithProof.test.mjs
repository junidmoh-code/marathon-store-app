// ─── A FLOAT WITH A PROOF IS USABLE, ONCE (Junid, 9 Nov 2026) ─────────────────
// The proof's approval record is status "used" so the bank's notice is held.
// It must never read as the float having been spent. Through the poller's own
// ingest chain and the settle's guards. Names and numbers are stand-ins.
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import { selectReader } from "./eftBanks.mjs";
import { eftPoolRecord, applyFingerprintHold, paymentFingerprint, fingerprintClaimStep, linkedIngestDecision } from "./eftCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { consumeFingerprintCheck, claimHolderCheck } = require("./lib/eft-fingerprint.cjs");
const { manualTwinSettleCheck, manualEntryRecord, manualEntryKeyOf } = require("./lib/eft-manual.cjs");
const { approvedTwinSettleCheck, manualApprovedRecord, proofIdentityOf, approvedKeyOf, approvedClaimStep } = require("./lib/eft-manual-approved.cjs");
const { linkedCopySettleCheck } = require("./lib/eft-linked-copies.cjs");
const { settleDecision } = require("./lib/eft-settle.cjs");
const { searchEftPool } = require("./lib/eft-pool.cjs");

const sast = (iso) => Date.parse(`${iso}+02:00`);
const lines = (txn = "80000000D1-1") => [
  "09 November 2026", "Notice of Payment", "Dear Marathon Club",
  "Please be advised that MRS A PAYER made a payment to your account as indicated below.",
  `Transaction number: ${txn}`, "Payment date:", "2026-11-09", "Payment made by: MRS A PAYER",
  "Payment made to:", "Marathon Club", "Beneficiary bank name: FIRST NATIONAL BANK",
  "Beneficiary account number: 62900006625", "Bank branch code: 250655",
  "For the amount of: 1 250.00", "Immediate payment:", "Y", "Reference on beneficiary statement: Order 77",
];
const absa = selectReader({ fromDomain: "absa.co.za", lines: lines() });
const actor = { uid: "u", email: "e" };

function notice(txn) {
  const parsed = absa.parse(lines(txn));
  const received = sast("2026-11-09T14:00:00");
  return eftPoolRecord({
    message: { messageId: `<${txn}@absa>`, from: "ibreply@absa.co.za", subject: "Notice", receivedAt: received },
    verdict: { pass: true, fromDomain: "absa.co.za", dkimDomain: "absa.co.za", detail: "dkim=pass" },
    parsed, account: { ok: true, tail: "6625" }, timing: { ok: true }, dated: { ok: true }, reader: "absa", rawText: lines(txn).join("\n"), at: received + 1000,
  });
}

function world({ proof = true } = {}) {
  const records = {}, claims = {};
  const floatKey = manualEntryKeyOf("ME-float-0001");
  const fp = manualEntryRecord({ entryId: "ME-float-0001", key: floatKey, reference: "ORDER 77", amountCents: 125000, note: null, actor, at: sast("2026-11-09T10:00:00") });
  records[floatKey] = fp;
  claims[paymentFingerprint(fp)] = { poolKey: floatKey, at: 1 };
  if (proof) {
    const parse = absa.parse(lines());
    const identity = proofIdentityOf(parse, "absa");
    const key = approvedKeyOf(identity.fingerprint);
    claims[identity.fingerprint] = approvedClaimStep({ approvedKey: key, at: 2 })(null);
    const built = manualApprovedRecord({ key, readerId: "absa", parse, lines: lines(), identity, destination: null, actor, at: sast("2026-11-09T10:05:00"), note: null, filename: "p.pdf", entryId: "PA-00000001" });
    expect(built.ok).toBe(true);
    records[key] = built.value;
  }
  const guards = (key) => {
    const siblings = Object.entries(records), record = records[key];
    for (const check of [consumeFingerprintCheck, manualTwinSettleCheck, linkedCopySettleCheck, approvedTwinSettleCheck]) {
      const v = check({ poolKey: key, record, siblings });
      if (!v.ok) return v;
    }
    const c = claims[paymentFingerprint(record)];
    return claimHolderCheck({ poolKey: key, holder: c?.poolKey ?? null, spentBy: c?.spentBy ?? null });
  };
  const settle = (key, attemptId, cashierUid = "till") => settleDecision(records[key], {
    fingerprint: paymentFingerprint(records[key]), attemptId, at: 7, cashierUid, cashierName: "Amanda", storeId: "concrete", tillId: "t1",
    customerId: "c1", confirmedCustomerId: "c1", customerResolved: true, customerName: "C", appliedCents: records[key].amountCents,
  });
  const ingest = (key, candidate) => {
    const fingerprint = paymentFingerprint(candidate);
    let seen = { holder: null };
    const out = fingerprintClaimStep(key, 1, (d) => { seen = d; })(claims[fingerprint] ?? null);
    if (out !== undefined && claims[fingerprint] == null) claims[fingerprint] = out;
    const rec = applyFingerprintHold(candidate, { fingerprint, holder: seen.holder, poolKey: key, manualApproved: seen.manualApproved, spentBy: seen.spentBy });
    records[key] = linkedIngestDecision(rec, key, Object.entries(records), 99).record;
    return records[key];
  };
  return { records, floatKey, guards, settle, ingest };
}

describe("Junid's float at Concrete, with proof", () => {
  it("reads UNUSED, completes a slip once, a second use is blocked, and the notice is auto-HELD", () => {
    const w = world();
    const row = searchEftPool(w.records, "order 77").results.find((r) => r.key === w.floatKey);
    expect(row.status).toBe("unmatched");
    expect(row.sameUsed).toBeUndefined();
    expect(w.guards(w.floatKey).ok).toBe(true);

    const first = w.settle(w.floatKey, "attempt-1");
    expect(first.ok && first.value.status).toBe("used");
    w.records[w.floatKey] = first.value;
    expect(w.settle(w.floatKey, "attempt-2")).toMatchObject({ ok: false, code: "already-used" });

    expect(w.ingest("n".repeat(40), notice("80000000D1-1")).outcome).toBe("held-duplicate");
  });

  it("the notice is held while the float still waits, and the float stays usable", () => {
    const w = world();
    expect(w.ingest("n".repeat(40), notice("80000000D1-1")).outcome).toBe("held-duplicate");
    expect(w.guards(w.floatKey).ok).toBe(true);
  });

  it("a second float of the same proof is refused once the first has spent it", () => {
    const w = world();
    const k2 = manualEntryKeyOf("ME-float-0002");
    w.records[k2] = manualEntryRecord({ entryId: "ME-float-0002", key: k2, reference: "ORDER 77", amountCents: 125000, note: "again", actor, at: sast("2026-11-09T11:00:00") });
    w.records[w.floatKey] = w.settle(w.floatKey, "attempt-1").value;
    expect(w.guards(k2)).toMatchObject({ ok: false, code: "twin-used" });
    expect(searchEftPool(w.records, "order 77").results.find((r) => r.key === k2).sameUsed).toBeDefined();
  });

  it("a real slip on the bank's record still refuses the float", () => {
    const w = world({ proof: false });
    w.records["b".repeat(40)] = { ...notice("80000000D1-1"), status: "used", bankTs: sast("2026-11-09T09:00:00"), used: { at: 5, sale: { receiptNumber: "S-9" } } };
    expect(w.guards(w.floatKey)).toMatchObject({ ok: false, code: "twin-used" });
  });

  it("no proof: the float still completes once and its notice gets the fallback hold", () => {
    const w = world({ proof: false });
    expect(w.guards(w.floatKey).ok).toBe(true);
    w.records[w.floatKey] = w.settle(w.floatKey, "attempt-1").value;
    expect(w.ingest("n".repeat(40), notice("80000000D1-1"))).toMatchObject({ outcome: "held-possible-duplicate", linkedHold: "manual-twin" });
  });
});
