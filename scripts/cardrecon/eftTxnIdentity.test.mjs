// ─── 7 NOV 2026 (Junid): THE TRANSACTION NUMBER IS THE IDENTITY; WEEKEND-ONLY
// NEXT-BUSINESS-DAY; SA PUBLIC HOLIDAYS; SAME-REFERENCE HAND ENTRIES ──────────
// Each case runs the poller's own chain (email-poller.mjs): reader → account
// (7a) → immediacy/date (7b) → cutoff (fix 8) → pool record → fingerprint
// claim — and then the settle's guards (eftPool.js checkPaymentFingerprint)
// in the order it runs them.
//
// The Absa fixture is the real R3950 PAYER'S COPY of 7 Nov 2026 (DKIM pass
// for absa.co.za, immediate, into the FNB account), structure verbatim, with
// the payer, the reference, the transaction number's digits and the account
// digits replaced (this repo is public).
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import { selectReader } from "./eftBanks.mjs";
import {
  destinationVerdict, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff, parseAccountPolicies,
  eftPoolRecord, applyFingerprintHold, paymentFingerprint, fingerprintClaimStep, sastDate,
  linkedIngestDecision, linkedCopySettleCheck,
} from "./eftCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { consumeFingerprintCheck, claimHolderCheck } = require("./lib/eft-fingerprint.cjs");
const { manualTwinSettleCheck, manualEntryRecord, manualEntryKeyOf, manualDuplicateOf, manualDoubleSubmitOf } = require("./lib/eft-manual.cjs");
const { approvedTwinSettleCheck } = require("./lib/eft-manual-approved.cjs");
const { searchEftPool } = require("./lib/eft-pool.cjs");
const { settlementDateVerdict, isBusinessDay, isSaPublicHoliday, nextBusinessDay, saPublicHolidays } = require("./lib/eft-text.cjs");

const FNB = "62900006625";
const SB = "10100008534";
const POLICIES = parseAccountPolicies(`${FNB}, ${SB}:standardbank:immediate`);
const CUTOFF = parsePaymentDateCutoff("2026-10-20");
const sast = (iso) => Date.parse(`${iso}+02:00`);
const SATURDAY_1235 = sast("2026-11-07T14:34:18"); // when the R3950 notice arrived

/** The Absa payer's copy — `txn`, `day`, `amount`, `reference`, `immediate` vary. */
const absaPayerCopy = ({ txn = "80000000A0-34", day = "2026-11-07", amount = "3 950.00", reference = "A Payer", immediate = "Y", account = FNB, bank = "FIRSTRAND" } = {}) => [
  "07 November 2026",
  "Notice of Payment",
  "Dear MRS A PAYER",
  "Subject: Notice Of Payment: SHOP NAME",
  "Please be advised that you made a payment to SHOP NAME as indicated below.",
  `Transaction number: ${txn}`,
  "Payment date:",
  day,
  "Payment made from: Ultimate Plus",
  "Payment made to:",
  "SHOP NAME",
  `Beneficiary bank name: ${bank}`,
  `Beneficiary account number: ${account}`,
  "Bank branch code: 250655",
  `For the amount of: ${amount}`,
  "Immediate payment:",
  immediate,
  `Reference on beneficiary statement: ${reference}`,
  "Please remember that the following applies to online banking payments to non-ABSA and Absa Vehicle and Asset",
  "Finance bank accounts.",
  "• Payments made on weekdays before 15:30 will be credited to the receiving bank account by midnight of the same day.",
  "• Payments made on weekdays after 15:30 will be credited by midnight of the following day.",
  "• Payments made on a Saturday, Sunday or Public holiday will be credited to the account by midnight of the 1st",
  "following weekday.",
  "Yours sincerely",
  "General Manager: Digital Channels",
];

/** The poller's chain for one notice: the pool record it would write. */
function decide(lines, { received = SATURDAY_1235, fromDomain = "absa.co.za", messageId = "<m@absa>" } = {}) {
  const reader = selectReader({ fromDomain, lines });
  expect(reader, "a reader claims the document").toBeTruthy();
  const parsed = reader.parse(lines);
  expect(parsed.ok, parsed.reason).toBe(true);
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: POLICIES, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt: received, immediateOnly: account?.ok === true && account.immediateOnly === true });
  const dated = paymentDateVerdict({ parsed, cutoff: CUTOFF });
  const verdict = { pass: true, fromDomain, dkimDomain: fromDomain, detail: "dkim=pass" };
  const record = eftPoolRecord({
    message: { messageId, from: `ibreply@${fromDomain}`, subject: "Notice of payment: SHOP NAME", receivedAt: received },
    verdict, parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at: received + 1000,
  });
  return { parsed, account, timing, record };
}

/** An in-memory /eft_pool_fingerprints, claimed the way the poller claims. */
function pool() {
  const claims = {};
  const records = {};
  return {
    claims, records,
    ingest(key, record) {
      const fingerprint = paymentFingerprint(record);
      let seen = { holder: null };
      if (fingerprint) {
        const out = fingerprintClaimStep(key, 1, (d) => { seen = d; })(claims[fingerprint] ?? null);
        if (out !== undefined && claims[fingerprint] == null) claims[fingerprint] = out;
      }
      let held = applyFingerprintHold(record, { fingerprint, holder: seen.holder, poolKey: key, manualApproved: seen.manualApproved, spentBy: seen.spentBy });
      // …then the linked-copy check, as email-poller.mjs runs it.
      held = linkedIngestDecision(held, key, Object.entries(records), 7).record;
      records[key] = held;
      return held;
    },
    /** The settle's guards, in eftPoolSettle's order. */
    settleGuards(key) {
      const record = records[key];
      const siblings = Object.entries(records);
      const fp = consumeFingerprintCheck({ poolKey: key, record, siblings });
      if (!fp.ok) return fp;
      const twin = manualTwinSettleCheck({ poolKey: key, record, siblings });
      if (!twin.ok) return twin;
      const linked = linkedCopySettleCheck({ poolKey: key, record, siblings });
      if (!linked.ok) return linked;
      const approved = approvedTwinSettleCheck({ poolKey: key, record, siblings });
      if (!approved.ok) return approved;
      const claim = claims[fp.fingerprint];
      return claimHolderCheck({ poolKey: key, holder: claim?.poolKey ?? null, spentBy: claim?.spentBy ?? null });
    },
    spend(key, slip) {
      records[key] = { ...records[key], status: "used", used: { at: 5, sale: { receiptNumber: slip } } };
      const fp = paymentFingerprint(records[key]);
      if (fp && claims[fp]) claims[fp] = { ...claims[fp], spentBy: key };
    },
  };
}

// ─── THE R3950 OF 7 NOV 2026 ─────────────────────────────────────────────────
describe("the Carmel Delpaul R3950 (Absa payer's copy, immediate, into FNB …6625) confirms", () => {
  it("is claimed by the Absa reader and reads every field — the transaction number is its identity", () => {
    const { parsed } = decide(absaPayerCopy());
    expect(parsed).toMatchObject({
      ok: true, amountCents: 395000, bankRef: "80000000A0-34", payer: "MRS A PAYER", reference: "A Payer",
      accountMask: FNB, destBankName: "FIRSTRAND", beneficiaryName: "SHOP NAME", immediate: true,
    });
    expect(sastDate(parsed.bankTs)).toBe("2026-11-07");
  });

  it("is recorded, spendable, on its own transaction-number fingerprint", () => {
    const p = pool();
    const rec = p.ingest("r3950", decide(absaPayerCopy()).record);
    expect(rec).toMatchObject({ outcome: "recorded", status: "unmatched", amountCents: 395000 });
    expect(rec.syntheticRef ?? null).toBe(null);
    expect(p.settleGuards("r3950")).toEqual({ ok: true });
  });

  it("the payer is read from the greeting ONLY on the payer's copy, and only when one greeting is printed", () => {
    const twoGreetings = absaPayerCopy().flatMap((l) => (l === "Dear MRS A PAYER" ? [l, "Dear MR B OTHER"] : [l]));
    expect(decide(twoGreetings).parsed.payer).toBe(null);
    const generic = absaPayerCopy().map((l) => (l === "Dear MRS A PAYER" ? "Dear Customer" : l));
    expect(decide(generic).parsed.payer).toBe(null);
  });

  it("a resend of the same notice is held as a duplicate, and a spent one never re-floats", () => {
    const p = pool();
    p.ingest("orig", decide(absaPayerCopy()).record);
    p.spend("orig", "S-1");
    const again = p.ingest("resend", decide(absaPayerCopy(), { messageId: "<resend@absa>" }).record);
    expect(again).toMatchObject({ outcome: "held-duplicate", duplicateOf: "orig" });
    expect(again.status).toBeUndefined();
  });
});

// ─── THE TRANSACTION NUMBER, NEVER REFERENCE + AMOUNT ────────────────────────
describe("two Absa payments sharing a reference and an amount, with different transaction numbers", () => {
  it("both confirm and are independently usable, each exactly once", () => {
    const p = pool();
    const one = p.ingest("one", decide(absaPayerCopy({ txn: "80000000A1-1" }), { messageId: "<1@absa>" }).record);
    const two = p.ingest("two", decide(absaPayerCopy({ txn: "80000000A2-2" }), { messageId: "<2@absa>" }).record);
    expect(one).toMatchObject({ outcome: "recorded", status: "unmatched" });
    expect(two).toMatchObject({ outcome: "recorded", status: "unmatched" });
    expect(p.settleGuards("one")).toEqual({ ok: true });
    p.spend("one", "S-10");
    // The second is not blocked by the first's reference + amount.
    expect(p.settleGuards("two")).toEqual({ ok: true });
    expect(searchEftPool(p.records, "a payer").results.map((r) => r.key)).toEqual(["two"]);
    p.spend("two", "S-11");
    // …and neither can be used again: the same NUMBER is refused.
    const resend = p.ingest("resend", decide(absaPayerCopy({ txn: "80000000A2-2" }), { messageId: "<3@absa>" }).record);
    expect(resend.outcome).toBe("held-duplicate");
  });
});

describe("a reference + amount collision never blocks a payment that has its own transaction number", () => {
  const typedAt = sast("2026-11-07T14:00:00");
  const usedManual = {
    ...manualEntryRecord({ entryId: "ME-coll-0001", key: manualEntryKeyOf("ME-coll-0001"), reference: "A PAYER", amountCents: 395000, note: null, actor: { uid: "u", email: "e" }, at: typedAt }),
    status: "used", used: { at: typedAt + 60000, sale: { receiptNumber: "S-20" } },
  };
  const usedApprovedNoTxn = {
    outcome: "recorded", status: "used", reader: "absa", amountCents: 395000, reference: "A Payer", payer: "MRS A PAYER",
    bankRef: null, syntheticRef: "ABSA|MRSAPAYER|6625|2026-11-07|395000|APAYER", bankTs: sast("2026-11-07T00:00:00"), accountTail: "6625",
    manualApproved: { by: "Junid", at: typedAt },
  };
  const usedOtherBank = { outcome: "recorded", status: "used", reader: "absa", amountCents: 395000, reference: "A Payer", bankRef: "80000000Z9-9", bankTs: sast("2026-11-07T00:00:00"), used: { at: 1, sale: { receiptNumber: "S-21" } } };

  it("a hand entry from another week, a number-less approved proof from another payer, another numbered bank payment — none of them blocks, holds or warns", () => {
    // (The SAME money — a hand entry inside its twin window, or the blank-
    // number copy of this very payment — IS held: eftLinkedCopies.test.mjs.)
    const p = pool();
    const lastWeek = sast("2026-10-29T10:00:00");
    p.records.m = { ...usedManual, manualEntry: { ...usedManual.manualEntry, at: lastWeek }, at: lastWeek, receivedAt: lastWeek, bankTs: lastWeek };
    p.records.ap = { ...usedApprovedNoTxn, payer: "MR B OTHER", syntheticRef: "ABSA|MRBOTHER|6625|2026-11-07|395000|APAYER" };
    p.records.other = usedOtherBank;
    const rec = p.ingest("fresh", decide(absaPayerCopy({ txn: "80000000B1-1" })).record);
    expect(rec).toMatchObject({ outcome: "recorded", status: "unmatched" });
    expect(p.settleGuards("fresh")).toEqual({ ok: true });
    const row = searchEftPool(p.records, "a payer").results.find((r) => r.key === "fresh");
    expect(row).toBeTruthy();
    expect(row.sameUsed).toBeUndefined();
    expect(manualTwinSettleCheck({ poolKey: "fresh", record: p.records.fresh, siblings: Object.entries(p.records) })).toEqual({ ok: true });
  });

  it("…while a payment with NO number (a hand entry) is still refused when its bank twin was spent", () => {
    const waitingManual = { ...usedManual, status: "unmatched", used: undefined };
    const spentBank = { ...decide(absaPayerCopy({ txn: "80000000B2-2" })).record, status: "used", used: { at: 1, sale: { receiptNumber: "S-22" } } };
    expect(manualTwinSettleCheck({ poolKey: "m", record: waitingManual, siblings: [["b", spentBank]] })).toMatchObject({ ok: false, code: "twin-used" });
  });
});

describe("the genuine double-pay guards stay", () => {
  it("a re-approved proof (the approval claimed the number spent) — the bank's copy is held and refused", () => {
    const p = pool();
    const fp = paymentFingerprint({ reader: "absa", bankRef: "80000000C1-1" });
    p.claims[fp] = { poolKey: "approved", at: 1, spentBy: "approved", manualApproved: true };
    const rec = p.ingest("notice", decide(absaPayerCopy({ txn: "80000000C1-1" })).record);
    expect(rec).toMatchObject({ outcome: "held-duplicate", approvedByHand: "approved" });
    expect(claimHolderCheck({ poolKey: "notice", holder: "approved", spentBy: "approved" })).toMatchObject({ ok: false, code: "duplicate-used" });
  });

  it("an already-used transaction number is refused at the settle even on a pre-claim copy", () => {
    const used = { ...decide(absaPayerCopy({ txn: "80000000C2-2" })).record, status: "used", used: { at: 1 } };
    const copy = decide(absaPayerCopy({ txn: "80000000c2 2" }), { messageId: "<copy@absa>" }).record;
    expect(consumeFingerprintCheck({ poolKey: "copy", record: copy, siblings: [["used", used], ["copy", copy]] })).toMatchObject({ ok: false, code: "duplicate-used" });
  });

  it("a hand entry of money approved from its proof is refused at the settle", () => {
    const approved = { outcome: "recorded", status: "used", reader: "absa", amountCents: 395000, reference: "A PAYER", payer: "MRS A PAYER", bankRef: "80000000C3-3", bankTs: sast("2026-11-07T00:00:00"), manualApproved: { by: "Junid", at: sast("2026-11-07T10:00:00") } };
    const typed = manualEntryRecord({ entryId: "ME-appr-0009", key: manualEntryKeyOf("ME-appr-0009"), reference: "A PAYER", amountCents: 395000, note: null, actor: {}, at: sast("2026-11-07T11:00:00") });
    expect(approvedTwinSettleCheck({ poolKey: "t", record: typed, siblings: [["ap", approved]] })).toMatchObject({ ok: false, code: "twin-used" });
  });
});

// ─── SAME-REFERENCE HAND ENTRIES: WARNED, NOT REFUSED ────────────────────────
describe("a second same-reference MANUAL entry", () => {
  const first = manualEntryRecord({ entryId: "ME-first-001", key: manualEntryKeyOf("ME-first-001"), reference: "SOCCER T SHIRT", amountCents: 87000, note: null, actor: {}, at: sast("2026-11-07T10:00:00") });
  it("is found as SIMILAR (the server's warning) but is not a double tap — it goes in as its own record", () => {
    const at = sast("2026-11-07T10:05:00");
    expect(manualDuplicateOf({ reference: "Soccer T shirt", amountCents: 87000, entryId: "ME-second-01", at }, [["f", first]])?.key).toBe("f");
    expect(manualDoubleSubmitOf({ reference: "Soccer T shirt", amountCents: 87000, note: null, entryId: "ME-second-01", at }, [["f", first]])).toBe(null);
    const second = manualEntryRecord({ entryId: "ME-second-01", key: manualEntryKeyOf("ME-second-01"), reference: "SOCCER T SHIRT", amountCents: 87000, note: null, actor: {}, at });
    expect(paymentFingerprint(second)).not.toBe(paymentFingerprint(first));
  });
  it("the EXACT same entry within seconds is an accidental double tap", () => {
    const at = sast("2026-11-07T10:00:04");
    expect(manualDoubleSubmitOf({ reference: "soccer t-shirt", amountCents: 87000, note: null, entryId: "ME-second-02", at }, [["f", first]])?.key).toBe("f");
    expect(manualDoubleSubmitOf({ reference: "soccer t-shirt", amountCents: 87000, note: "second", entryId: "ME-second-03", at }, [["f", first]])).toBe(null);
    expect(manualDoubleSubmitOf({ reference: "soccer t-shirt", amountCents: 87000, note: null, entryId: "ME-second-04", at: at + 10000 }, [["f", first]])).toBe(null);
  });
});

// ─── NEXT BUSINESS DAY: WEEKENDS AND PUBLIC HOLIDAYS ONLY ────────────────────
describe("a later-dated payment is accepted only when its notice arrives on a non-business day", () => {
  const nonImmediate = (o) => absaPayerCopy({ immediate: "N", ...o });

  it("weekday: dated tomorrow is refused as scheduled; same day and earlier accepted", () => {
    const tuesday = sast("2026-11-10T16:00:00");
    const tomorrow = decide(nonImmediate({ day: "2026-11-11" }), { received: tuesday }).record;
    expect(tomorrow.outcome).toBe("refused-not-immediate");
    expect(tomorrow.reason).toBe("Payment dated 2026-11-11 — a later day than 2026-11-10, a business day: a scheduled payment, not treated as settled.");
    expect(decide(nonImmediate({ day: "2026-11-10" }), { received: tuesday }).record.outcome).toBe("recorded");
    expect(decide(nonImmediate({ day: "2026-11-09" }), { received: tuesday }).record.outcome).toBe("recorded");
  });

  it("weekend: a Saturday or Sunday notice dated Monday is accepted; Tuesday is beyond", () => {
    expect(decide(nonImmediate({ day: "2026-11-09" }), { received: sast("2026-11-07T11:00:00") }).record.outcome).toBe("recorded");
    expect(decide(nonImmediate({ day: "2026-11-09" }), { received: sast("2026-11-08T11:00:00") }).record.outcome).toBe("recorded");
    const tue = decide(nonImmediate({ day: "2026-11-10" }), { received: sast("2026-11-07T11:00:00") }).record;
    expect(tue.outcome).toBe("refused-not-immediate");
    expect(tue.reason).toMatch(/beyond the next business day/);
  });

  it("Thursday 24 Dec dated Monday 28 Dec is accepted (Christmas and the Day of Goodwill between); dated Tuesday 29 is not", () => {
    const christmasEve = sast("2026-12-24T16:30:00");
    expect(decide(nonImmediate({ day: "2026-12-28" }), { received: christmasEve }).record.outcome).toBe("recorded");
    expect(decide(nonImmediate({ day: "2026-12-29" }), { received: christmasEve }).record.outcome).toBe("refused-not-immediate");
    // On Christmas Day itself, too.
    expect(decide(nonImmediate({ day: "2026-12-28" }), { received: sast("2026-12-25T10:00:00") }).record.outcome).toBe("recorded");
  });

  it("a Friday opens the window up to Monday (not Tuesday); so does a Friday before a Saturday holiday", () => {
    expect(settlementDateVerdict(sast("2026-11-09T00:00:00"), sast("2026-11-06T17:00:00")).ok).toBe(true);
    expect(settlementDateVerdict(sast("2026-11-10T00:00:00"), sast("2026-11-06T17:00:00")).ok).toBe(false);
    // Fri 24 Dec 2027: Christmas Sat, Goodwill Sun → Mon 27 a holiday; next business day Tue 28.
    expect(settlementDateVerdict(sast("2027-12-28T00:00:00"), sast("2027-12-24T17:00:00")).ok).toBe(true);
    expect(settlementDateVerdict(sast("2027-12-29T00:00:00"), sast("2027-12-24T17:00:00")).ok).toBe(false);
  });

  it("Concrete's immediate-only account: a same-day NON-immediate payment still refuses, weekend or weekday", () => {
    const toConcrete = (o) => nonImmediate({ account: SB, bank: "STANDARD BANK OF SOUTH AFRICA", ...o });
    for (const [day, received] of [["2026-11-07", sast("2026-11-07T11:00:00")], ["2026-11-10", sast("2026-11-10T11:00:00")]]) {
      const { account, record } = decide(toConcrete({ day }), { received });
      expect(account).toMatchObject({ ok: true, immediateOnly: true });
      expect(record.outcome).toBe("refused-not-immediate");
      expect(record.reason).toMatch(/IMMEDIATE payments only/);
    }
    // …and a weekend notice dated Monday is the next-business-day settlement it accepts.
    expect(decide(toConcrete({ day: "2026-11-09" }), { received: sast("2026-11-07T11:00:00") }).record.outcome).toBe("recorded");
  });
});

describe("the South African public-holiday calendar", () => {
  it("has the Act's fixed days, Easter's two, and the Sunday-to-Monday rule", () => {
    expect([...saPublicHolidays(2026)].sort()).toEqual([
      "2026-01-01", "2026-03-21", "2026-04-03", "2026-04-06", "2026-04-27", "2026-05-01", "2026-06-16",
      "2026-08-09", "2026-08-10", "2026-09-24", "2026-11-04", "2026-12-16", "2026-12-25", "2026-12-26",
    ]);
    // 2027: Easter is 28 March; Human Rights Day falls on a Sunday → Monday 22 March.
    expect(saPublicHolidays(2027).has("2027-03-26")).toBe(true);
    expect(saPublicHolidays(2027).has("2027-03-29")).toBe(true);
    expect(saPublicHolidays(2027).has("2027-03-22")).toBe(true);
    // A Saturday holiday is not moved: Day of Goodwill 2026 is a Saturday, Monday 28 Dec is a business day.
    expect(isBusinessDay("2026-12-28")).toBe(true);
    expect(isSaPublicHoliday("2024-05-29")).toBe(true); // a declared election day
    expect(isSaPublicHoliday("2026-11-04")).toBe(true); // local government elections, declared
    // Christmas on a Sunday, Goodwill on the Monday → Tuesday 27 Dec 2022 (architect review).
    expect(isSaPublicHoliday("2022-12-27")).toBe(true);
    expect(isSaPublicHoliday("2027-12-27")).toBe(true); // Goodwill on a Sunday 2027
  });
  it("the next business day skips weekends and holidays", () => {
    expect(nextBusinessDay("2026-12-24")).toBe("2026-12-28");
    expect(nextBusinessDay("2026-12-31")).toBe("2027-01-04");
    expect(nextBusinessDay("2026-04-02")).toBe("2026-04-07"); // Good Friday, the weekend, Family Day
    expect(nextBusinessDay("2026-02-31")).toBe(null);
  });
});
