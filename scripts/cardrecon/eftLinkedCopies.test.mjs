// ─── LINKED COPIES OF ONE PAYMENT — held automatically (Junid, 7 Nov 2026) ───
// The double-pay holes left by "the transaction number is the identity":
//   1. a hand entry floated, then the bank's notice of the same money arrives
//      with its own number → the notice is HELD at ingest, not floated;
//   2. a blank-number Absa copy and a numbered copy of the same payment →
//      the second is HELD, in either order;
//   3. a proof approved from one bank's document, a notice from another bank
//      with a different number → MONITORED (flag + log), never held;
//   and a genuine second payment can still be released by the owner.
// Through the poller's own chain (reader → account → immediacy → cutoff →
// record → fingerprint claim → linked-copy decision) and the settle's guards.
// Names, numbers and accounts are stand-ins (public repo).
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import { selectReader } from "./eftBanks.mjs";
import {
  destinationVerdict, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff, parseAccountPolicies,
  eftPoolRecord, applyFingerprintHold, paymentFingerprint, fingerprintClaimStep, linkedIngestDecision,
} from "./eftCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { consumeFingerprintCheck, claimHolderCheck } = require("./lib/eft-fingerprint.cjs");
const { manualTwinSettleCheck, manualEntryRecord, manualEntryKeyOf } = require("./lib/eft-manual.cjs");
const { approvedTwinSettleCheck } = require("./lib/eft-manual-approved.cjs");
const { linkedCopySettleCheck } = require("./lib/eft-linked-copies.cjs");
const { releaseHoldDecision } = require("./lib/eft-settle.cjs");
const { searchEftPool } = require("./lib/eft-pool.cjs");
const { settlementDateVerdict } = require("./lib/eft-text.cjs");

const FNB = "62900006625";
const POLICIES = parseAccountPolicies(`${FNB}, 10100008534:standardbank:immediate`);
const CUTOFF = parsePaymentDateCutoff("2026-10-20");
const sast = (iso) => Date.parse(`${iso}+02:00`);

/** An Absa beneficiary notice. `txn: ""` prints the label blank. */
const absaNotice = ({ txn = "80000000D1-1", day = "2026-11-09", amount = "1 250.00", reference = "Order 77", payer = "MRS A PAYER" } = {}) => [
  "09 November 2026", "Notice of Payment", "Dear Marathon Club",
  `Please be advised that ${payer} made a payment to your account as indicated below.`,
  txn ? `Transaction number: ${txn}` : "Transaction number:",
  "Payment date:", day,
  `Payment made by: ${payer}`,
  "Payment made to:", "Marathon Club",
  "Beneficiary bank name: FIRST NATIONAL BANK",
  `Beneficiary account number: ${FNB}`,
  "Bank branch code: 250655",
  `For the amount of: ${amount}`,
  "Immediate payment:", "Y",
  `Reference on beneficiary statement: ${reference}`,
];

/** The poller's whole decision for one Absa notice. */
function decide(lines, { received = sast("2026-11-09T10:30:00"), fromDomain = "absa.co.za" } = {}) {
  const reader = selectReader({ fromDomain, lines });
  const parsed = reader.parse(lines);
  expect(parsed.ok, parsed.reason).toBe(true);
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: POLICIES, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt: received, immediateOnly: account?.immediateOnly === true });
  const dated = paymentDateVerdict({ parsed, cutoff: CUTOFF });
  return eftPoolRecord({
    message: { messageId: `<${Math.random()}@absa>`, from: `ibreply@${fromDomain}`, subject: "Notice of payment", receivedAt: received },
    verdict: { pass: true, fromDomain, dkimDomain: fromDomain, detail: "dkim=pass" },
    parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at: received + 1000,
  });
}

/** In-memory pool + fingerprint claims, ingesting exactly as email-poller.mjs does. */
function pool() {
  const claims = {};
  const records = {};
  return {
    claims, records,
    ingest(key, candidate) {
      const fingerprint = paymentFingerprint(candidate);
      let seen = { holder: null };
      if (fingerprint) {
        const out = fingerprintClaimStep(key, 1, (d) => { seen = d; })(claims[fingerprint] ?? null);
        if (out !== undefined && claims[fingerprint] == null) claims[fingerprint] = out;
      }
      let rec = applyFingerprintHold(candidate, { fingerprint, holder: seen.holder, poolKey: key, manualApproved: seen.manualApproved, spentBy: seen.spentBy });
      const linked = linkedIngestDecision(rec, key, Object.entries(records), 99);
      records[key] = linked.record;
      return linked;
    },
    put(key, record) { records[key] = record; },
    settleGuards(key) {
      const record = records[key];
      if (record?.outcome !== "recorded") return { ok: false, code: "not-a-payment" };
      const siblings = Object.entries(records);
      for (const check of [consumeFingerprintCheck, manualTwinSettleCheck, linkedCopySettleCheck, approvedTwinSettleCheck]) {
        const v = check({ poolKey: key, record, siblings });
        if (!v.ok) return v;
      }
      const fp = paymentFingerprint(record);
      const c = claims[fp];
      return claimHolderCheck({ poolKey: key, holder: c?.poolKey ?? null, spentBy: c?.spentBy ?? null });
    },
    spend(key, slip) {
      records[key] = { ...records[key], status: "used", used: { at: 5, sale: { receiptNumber: slip } } };
      const fp = paymentFingerprint(records[key]);
      if (fp && claims[fp]) claims[fp] = { ...claims[fp], spentBy: key };
    },
  };
}

const handEntry = ({ entryId, typed, reference = "ORDER 77", amountCents = 125000 }) =>
  manualEntryRecord({ entryId, key: manualEntryKeyOf(entryId), reference, amountCents, note: null, actor: { uid: "u", email: "e" }, at: sast(typed) });

// ─── HOLE 1 ──────────────────────────────────────────────────────────────────
describe("hole 1 — a hand entry, then its bank notice with a new transaction number", () => {
  it("the hand entry was USED: the notice is auto-HELD at ingest, not floated", () => {
    const p = pool();
    const mKey = manualEntryKeyOf("ME-hole1-001");
    p.put(mKey, { ...handEntry({ entryId: "ME-hole1-001", typed: "2026-11-09T10:00:00" }), status: "used", used: { at: 1, sale: { receiptNumber: "S-1" } } });
    const { record } = p.ingest("notice", decide(absaNotice({ txn: "80000000E1-1" })));
    expect(record).toMatchObject({ outcome: "held-possible-duplicate", linkedHold: "manual-twin", duplicateOf: mKey });
    expect(record.status).toBeUndefined();
    expect(record.reason).toMatch(/already put in the pool by hand/);
    // Not in the till's search, not spendable.
    expect(searchEftPool(p.records, "order 77").results.map((r) => r.key)).not.toContain("notice");
    expect(p.settleGuards("notice")).toMatchObject({ ok: false });
  });

  it("the hand entry is still WAITING: the notice is held and the hand entry stays the one spendable record", () => {
    const p = pool();
    const mKey = manualEntryKeyOf("ME-hole1-002");
    p.put(mKey, handEntry({ entryId: "ME-hole1-002", typed: "2026-11-09T10:00:00" }));
    p.claims[paymentFingerprint(p.records[mKey])] = { poolKey: mKey, at: 1 }; // claimed at entry, as eftPoolManualEntry does
    expect(p.ingest("notice", decide(absaNotice({ txn: "80000000E2-2" }))).record.linkedHold).toBe("manual-twin");
    expect(searchEftPool(p.records, "order 77").results.map((r) => r.key)).toEqual([mKey]);
    expect(p.settleGuards(mKey)).toEqual({ ok: true });
  });

  it("a pair recorded BEFORE the ingest hold shipped: the settle refuses the notice once the hand entry is used", () => {
    const p = pool();
    const mKey = manualEntryKeyOf("ME-hole1-003");
    p.put(mKey, { ...handEntry({ entryId: "ME-hole1-003", typed: "2026-11-09T10:00:00" }), status: "used", used: { at: 1, sale: { receiptNumber: "S-3" } } });
    p.put("old", { ...decide(absaNotice({ txn: "80000000E3-3" })), fingerprint: "x" });
    expect(p.settleGuards("old")).toMatchObject({ ok: false, code: "twin-used" });
    expect(searchEftPool(p.records, "order 77").results.find((r) => r.key === "old").sameUsed.receiptNumber).toBe("S-3");
  });

  it("a GENUINE second payment can still be released by the owner — then it spends once on its own number", () => {
    const p = pool();
    const mKey = manualEntryKeyOf("ME-hole1-004");
    p.put(mKey, { ...handEntry({ entryId: "ME-hole1-004", typed: "2026-11-09T10:00:00" }), status: "used", used: { at: 1 } });
    const held = p.ingest("second", decide(absaNotice({ txn: "80000000E4-4" }))).record;
    const released = releaseHoldDecision(held, { at: 7000, by: "owner", reason: "two R1,250 credits on the statement" });
    expect(released.ok, released.message).toBe(true);
    expect(released.value).toMatchObject({ outcome: "recorded", status: "unmatched", releasedFromHold: { from: "held-possible-duplicate" } });
    expect(released.value.fingerprint).toBe(paymentFingerprint(held));
    p.put("second", released.value);
    expect(p.settleGuards("second")).toEqual({ ok: true });
    p.spend("second", "S-5");
    // Spent once: a resend of the same number is held as a duplicate.
    expect(p.ingest("resend", decide(absaNotice({ txn: "80000000E4-4" }))).record.outcome).toBe("held-duplicate");
  });

  it("a hand entry from another week is somebody's other payment: the notice floats", () => {
    const p = pool();
    p.put("m", { ...handEntry({ entryId: "ME-hole1-005", typed: "2026-10-29T10:00:00" }), status: "used", used: { at: 1 } });
    expect(p.ingest("notice", decide(absaNotice({ txn: "80000000E5-5" }))).record).toMatchObject({ outcome: "recorded", status: "unmatched" });
  });
});

// ─── HOLE 2 ──────────────────────────────────────────────────────────────────
describe("hole 2 — a blank-number copy and a numbered copy of the same Absa payment", () => {
  it("blank first, then numbered: the numbered copy is auto-HELD", () => {
    const p = pool();
    const blank = p.ingest("blank", decide(absaNotice({ txn: "" }))).record;
    expect(blank).toMatchObject({ outcome: "recorded", status: "unmatched" });
    expect(blank.syntheticRef).toMatch(/^ABSA\|/);
    const numbered = p.ingest("numbered", decide(absaNotice({ txn: "80000000F1-1" }))).record;
    expect(numbered).toMatchObject({ outcome: "held-possible-duplicate", linkedHold: "blank-numbered-twin", duplicateOf: "blank" });
  });

  it("numbered first, then blank: the blank copy is auto-HELD", () => {
    const p = pool();
    p.ingest("numbered", decide(absaNotice({ txn: "80000000F2-2" })));
    expect(p.ingest("blank", decide(absaNotice({ txn: "" }))).record).toMatchObject({ outcome: "held-possible-duplicate", linkedHold: "blank-numbered-twin", duplicateOf: "numbered" });
  });

  it("a blank-number proof Junid already approved: the numbered notice is held", () => {
    const p = pool();
    const approved = { ...decide(absaNotice({ txn: "" })), status: "used", manualApproved: { by: "Junid", at: 1 } };
    p.put("approved", approved);
    expect(p.ingest("notice", decide(absaNotice({ txn: "80000000F3-3" }))).record.linkedHold).toBe("blank-numbered-twin");
  });

  it("recorded before the hold shipped, both waiting: whichever is spent first, the other is refused", () => {
    const p = pool();
    p.put("blank", decide(absaNotice({ txn: "" })));
    p.put("numbered", decide(absaNotice({ txn: "80000000F4-4" })));
    p.claims[paymentFingerprint(p.records.numbered)] = { poolKey: "numbered", at: 1 };
    expect(p.settleGuards("numbered")).toEqual({ ok: true });
    p.spend("numbered", "S-9");
    expect(linkedCopySettleCheck({ poolKey: "blank", record: p.records.blank, siblings: Object.entries(p.records) })).toMatchObject({ ok: false, code: "twin-used", side: "blank-numbered-twin-used" });
  });

  it("two NUMBERED copies with different numbers are two payments; a different day or amount is another payment", () => {
    const p = pool();
    p.ingest("one", decide(absaNotice({ txn: "80000000F5-5" })));
    expect(p.ingest("two", decide(absaNotice({ txn: "80000000F6-6" }))).record.outcome).toBe("recorded");
    p.ingest("blank", decide(absaNotice({ txn: "", day: "2026-11-09", amount: "1 300.00" })));
    expect(p.records.blank.outcome).toBe("recorded");
  });

  it("the held copy, released for a genuine second payment, spends once", () => {
    const p = pool();
    p.ingest("blank", decide(absaNotice({ txn: "" })));
    const held = p.ingest("numbered", decide(absaNotice({ txn: "80000000F7-7" }))).record;
    const released = releaseHoldDecision(held, { at: 8000, by: "owner", reason: "statement shows two" });
    expect(released.ok, released.message).toBe(true);
    p.put("numbered", released.value);
    expect(p.settleGuards("numbered")).toEqual({ ok: true });
  });
});

// ─── ARCHITECT REVIEW: A RELEASE NEVER STRANDS THE OTHER COPY ────────────────
describe("an owner release is final both ways", () => {
  it("numbered copy released and spent first: its blank twin is still spendable", () => {
    const p = pool();
    p.ingest("blank", decide(absaNotice({ txn: "" })));
    const held = p.ingest("numbered", decide(absaNotice({ txn: "80000000J1-1" }))).record;
    p.put("numbered", releaseHoldDecision(held, { at: 9000, by: "owner", reason: "two on the statement" }).value);
    p.spend("numbered", "S-30");
    expect(p.settleGuards("blank")).toEqual({ ok: true });
  });

  it("notice released and spent first: the waiting hand entry is still spendable, and the till is not warned", () => {
    const p = pool();
    const mKey = manualEntryKeyOf("ME-rel-0001");
    p.put(mKey, handEntry({ entryId: "ME-rel-0001", typed: "2026-11-09T10:00:00" }));
    p.claims[paymentFingerprint(p.records[mKey])] = { poolKey: mKey, at: 1 };
    const held = p.ingest("notice", decide(absaNotice({ txn: "80000000J2-2" }))).record;
    p.put("notice", releaseHoldDecision(held, { at: 9000, by: "owner", reason: "two on the statement" }).value);
    p.spend("notice", "S-31");
    expect(p.settleGuards(mKey)).toEqual({ ok: true });
    expect(searchEftPool(p.records, "order 77").results.find((r) => r.key === mKey)?.sameUsed).toBeUndefined();
  });

  it("a released blank copy matching a blank-number APPROVED proof settles", () => {
    const p = pool();
    p.put("approved", { ...decide(absaNotice({ txn: "" })), status: "used", manualApproved: { by: "Junid", at: 1 } });
    const held = p.ingest("blank", decide(absaNotice({ txn: "80000000J3-3" }))).record;
    expect(held.linkedHold).toBe("blank-numbered-twin");
    p.put("blank", releaseHoldDecision(held, { at: 9000, by: "owner", reason: "two on the statement" }).value);
    expect(p.settleGuards("blank")).toEqual({ ok: true });
  });

  it("a blank Absa record whose hand-entry twin was used is warned about at the till (and refused at the settle)", () => {
    const p = pool();
    const mKey = manualEntryKeyOf("ME-rel-0002");
    p.put(mKey, { ...handEntry({ entryId: "ME-rel-0002", typed: "2026-11-09T10:00:00" }), status: "used", used: { at: 1, sale: { receiptNumber: "S-32" } } });
    p.put("blank", decide(absaNotice({ txn: "" })));
    expect(searchEftPool(p.records, "order 77").results.find((r) => r.key === "blank").sameUsed.receiptNumber).toBe("S-32");
    expect(manualTwinSettleCheck({ poolKey: "blank", record: p.records.blank, siblings: Object.entries(p.records) })).toMatchObject({ ok: false, code: "twin-used" });
  });
});

// ─── HOLE 3 ──────────────────────────────────────────────────────────────────
describe("hole 3 — cross-bank: monitored, never auto-blocked", () => {
  const approvedFromFnbDoc = { outcome: "recorded", status: "used", reader: "fnb", amountCents: 125000, reference: "ORDER 77", payer: "MR B OTHER", bankRef: "TRACE001", bankTs: sast("2026-11-09T09:00:00"), manualApproved: { by: "Junid", at: 1 } };

  it("two DIFFERENT customers paying the same amount the same day across banks: NOT held — recorded, flagged for review", () => {
    const p = pool();
    p.put("approved", approvedFromFnbDoc);
    const { record, crossBank } = p.ingest("absa", decide(absaNotice({ txn: "80000000G1-1", payer: "MRS A PAYER", reference: "Order 77" })));
    expect(record).toMatchObject({ outcome: "recorded", status: "unmatched" });
    expect(record.reviewFlag).toMatchObject({ code: "possible-cross-bank-duplicate", approvedKey: "approved", approvedReader: "fnb", samePayer: false, sameReference: true, at: 99 });
    expect(crossBank.approvedKey).toBe("approved");
    expect(p.settleGuards("absa")).toEqual({ ok: true });
    expect(searchEftPool(p.records, "order 77").results.map((r) => r.key)).toContain("absa");
  });

  it("no approval, or a different amount, or days apart: no flag at all", () => {
    const p = pool();
    expect(p.ingest("a", decide(absaNotice({ txn: "80000000G2-2" }))).record.reviewFlag).toBeUndefined();
    p.put("approved", { ...approvedFromFnbDoc, amountCents: 125100 });
    expect(p.ingest("b", decide(absaNotice({ txn: "80000000G3-3" }))).record.reviewFlag).toBeUndefined();
    p.put("approved", { ...approvedFromFnbDoc, bankTs: sast("2026-11-02T09:00:00") });
    expect(p.ingest("c", decide(absaNotice({ txn: "80000000G4-4" }))).record.reviewFlag).toBeUndefined();
  });

  it("the SAME bank's proof with the same number is still the fingerprint's job (held as the bank's copy)", () => {
    const p = pool();
    const fp = paymentFingerprint({ reader: "absa", bankRef: "80000000G5-5" });
    p.claims[fp] = { poolKey: "approved", at: 1, spentBy: "approved", manualApproved: true };
    expect(p.ingest("n", decide(absaNotice({ txn: "80000000G5-5" }))).record).toMatchObject({ outcome: "held-duplicate", approvedByHand: "approved" });
  });
});

// ─── FRIDAYS ─────────────────────────────────────────────────────────────────
describe("the next-business-day window: weekends, holidays — and Fridays", () => {
  it("Friday dated Monday is accepted; Friday dated Tuesday is not", () => {
    const friday = sast("2026-11-06T16:00:00");
    expect(settlementDateVerdict(sast("2026-11-09T00:00:00"), friday)).toEqual({ ok: true });
    expect(settlementDateVerdict(sast("2026-11-10T00:00:00"), friday).ok).toBe(false);
    // Through the poller: a non-immediate Absa notice of a Friday, dated Monday.
    const lines = absaNotice({ txn: "80000000H1-1", day: "2026-11-09" }).map((l) => (l === "Y" ? "N" : l));
    expect(decide(lines, { received: friday })).toMatchObject({ outcome: "recorded" });
  });

  it("Tuesday dated Wednesday (and Monday–Thursday generally) is still refused", () => {
    expect(settlementDateVerdict(sast("2026-11-11T00:00:00"), sast("2026-11-10T16:00:00")).reason)
      .toBe("Payment dated 2026-11-11 — a later day than 2026-11-10, a business day: a scheduled payment, not treated as settled.");
    for (const [paid, on] of [["2026-11-10", "2026-11-09"], ["2026-11-12", "2026-11-11"], ["2026-11-13", "2026-11-12"]]) {
      expect(settlementDateVerdict(sast(`${paid}T00:00:00`), sast(`${on}T16:00:00`)).ok, `${on} → ${paid}`).toBe(false);
    }
    // Same day and earlier still accepted.
    expect(settlementDateVerdict(sast("2026-11-10T00:00:00"), sast("2026-11-10T16:00:00")).ok).toBe(true);
  });
});
