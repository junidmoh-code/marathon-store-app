// ─── A TRANSACTION ID SEEN ONCE IS SEEN FOR GOOD — the R710 resend, replayed ─
// Junid, 25 Oct 2026. The R710 Standard Bank payment (…2085) was refused as
// not immediate, then settled by Junid by hand. Once #795 taught the reader
// the "Immediate Payment Confirmation" heading, a RESENT copy of the same PDF
// (a new email, a new pool key) would have passed every check and found the
// bank id unclaimed. These tests replay that through the confirmer's own
// functions, against an in-memory /eft_pool_fingerprints, exactly as the
// poller's write loop and the settle use them. The fixture is a sanitised
// copy of the real document; the live record is never touched.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { selectReader } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, immediacyVerdict, paymentDateVerdict, parsePaymentDateCutoff,
  parseAllowedAccounts, eftPoolRecord, eftMessageKey, eftPaymentKey, groupEftPayments,
  paymentFingerprint, fingerprintClaimStep, applyFingerprintHold,
  refusalFingerprint, applyRefusalFingerprint, settledFingerprintPlan, settledClaimStep, sweepRefusalClaim,
} from "./eftCore.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { claimHolderCheck, consumeFingerprintCheck } = require("./lib/eft-fingerprint.cjs");
const { manualEntryRecord, manualTwinSettleCheck } = require("./lib/eft-manual.cjs");
const HERE = dirname(fileURLToPath(import.meta.url));

const HEADING = "Immediate Payment Confirmation";
const R710 = [
  "Internet Banking", "Standard Bank Centre", "Website: www.standardbank.co.za",
  "Dear MARATHON CLUB",
  HEADING,
  "We confirm that the following payment has been made into your account from A CUSTOMER:",
  "Reference number 261025SBGRPP00002085C00002085",
  "Beneficiary name MARATHON CLUB",
  "Bank name FIRST NATIONAL BANK",
  "Beneficiary account number XXXXXXXXXXXXX4321",
  "Beneficiary reference REF710",
  "Amount R710.00",
  "Payment date and time 2026-10-25 11h15",
  "Immediate payments may take a few hours.",
  "Non-immediate payments to Standard Bank accounts may take up to 24 hours.",
  "Non-immediate payments to other banks may take up to three business days.",
];
// What the reader saw on 25 Oct BEFORE #795: no heading rule, so 7b refused.
const R710_AS_READ_BEFORE = R710.filter((l) => l !== HEADING);

const AUTH = authenticationVerdict({
  fromAddress: "noreply@standardbank.co.za",
  headerLines: [{ key: "authentication-results", line: "Authentication-Results: mx.google.com; dkim=pass header.i=@standardbank.co.za header.s=s1 header.b=x; dmarc=pass header.from=standardbank.co.za" }],
});
const ALLOWED = parseAllowedAccounts("62900004321");
const ARRIVED = Date.parse("2026-10-25T09:33:12Z");
const RESENT = Date.parse("2026-10-25T14:02:00Z");

/** One message through the poller's chain to the pool key and the candidate record. */
function ingest(lines, { messageId, receivedAt, uid }) {
  const message = { messageId, from: "noreply@standardbank.co.za", subject: "Payment confirmation 3723", receivedAt };
  const reader = selectReader({ fromDomain: "standardbank.co.za", lines });
  const p = reader.parse(lines);
  const record = eftPoolRecord({
    message, verdict: AUTH, parsed: p, reader: reader.id, rawText: lines.join("\n"), at: receivedAt,
    account: destinationVerdict({ accountMask: p.accountMask, destBankName: p.destBankName, allowedAccounts: ALLOWED, configured: true }),
    timing: immediacyVerdict({ parsed: p, reader: reader.id, receivedAt }),
    dated: paymentDateVerdict({ parsed: p, cutoff: parsePaymentDateCutoff(undefined) }),
  });
  const baseKey = eftMessageKey({ messageId, from: message.from, subject: message.subject, date: receivedAt, size: 1000, uid, uidValidity: 7, authPass: true });
  const [group] = groupEftPayments([{ d: { text: lines.join("\n") }, r: reader, p }]);
  return { poolKey: eftPaymentKey(baseKey, group, 1), record };
}

/** The poller's write loop for one record (email-poller.mjs), against `claims`. */
function claimAndDecide(claims, { poolKey, record }) {
  const run = (fp) => {
    let holder = null;
    const next = fingerprintClaimStep(poolKey, 1, (d) => { holder = d.holder; })(claims.has(fp) ? claims.get(fp) : null);
    if (next !== undefined) claims.set(fp, next);
    return holder;
  };
  if (record.outcome === "recorded") {
    const fp = paymentFingerprint({ reader: record.reader, bankRef: record.bankRef });
    return applyFingerprintHold(record, { fingerprint: fp, holder: fp ? run(fp) : null, poolKey });
  }
  const fp = refusalFingerprint(record);
  return fp ? applyRefusalFingerprint(record, { fingerprint: fp, holder: run(fp), poolKey }) : record;
}

describe("the R710 resend, after this fix", () => {
  const claims = new Map();
  const original = ingest(R710_AS_READ_BEFORE, { messageId: "<orig@myupdates1.standardbank.co.za>", receivedAt: ARRIVED, uid: 1 });
  const originalWritten = claimAndDecide(claims, original);
  const resend = ingest(R710, { messageId: "<resend@myupdates2.standardbank.co.za>", receivedAt: RESENT, uid: 2 });

  it("the original is still refused not-immediate — and now holds the bank id's claim", () => {
    expect(originalWritten.outcome).toBe("refused-not-immediate");
    expect(originalWritten.status).toBeUndefined();
    const fp = paymentFingerprint({ reader: "standardbank", bankRef: originalWritten.bankRef });
    expect(claims.get(fp)).toMatchObject({ poolKey: original.poolKey });
  });

  it("the resent copy would pass every check on its own — a new email, a new pool key", () => {
    expect(resend.poolKey).not.toBe(original.poolKey);
    expect(resend.record).toMatchObject({ outcome: "recorded", status: "unmatched" });
  });

  it("…but the dedupe holds it: held-duplicate of the original, never spendable", () => {
    const written = claimAndDecide(claims, resend);
    expect(written.outcome).toBe("held-duplicate");
    expect(written.status).toBeUndefined();
    expect(written.duplicateOf).toBe(original.poolKey);
  });

  it("and the settle refuses it: the claim names another record", () => {
    const fp = paymentFingerprint({ reader: "standardbank", bankRef: resend.record.bankRef });
    const c = claims.get(fp);
    expect(claimHolderCheck({ poolKey: resend.poolKey, holder: c.poolKey, spentBy: c.spentBy ?? null })).toMatchObject({ ok: false, code: "duplicate" });
  });

  it("a resent copy that is ITSELF refused is still refused, and names the original it copies", () => {
    const refusedCopy = ingest(R710_AS_READ_BEFORE, { messageId: "<copy2@myupdates2.standardbank.co.za>", receivedAt: RESENT + 60000, uid: 3 });
    const written = claimAndDecide(claims, refusedCopy);
    expect(written).toMatchObject({ outcome: "refused-not-immediate", duplicateOf: original.poolKey });
    expect(written.status).toBeUndefined();
  });

  it("re-reading the ORIGINAL email lands on its own key: same claim, still refused", () => {
    const again = ingest(R710_AS_READ_BEFORE, { messageId: "<orig@myupdates1.standardbank.co.za>", receivedAt: ARRIVED, uid: 1 });
    expect(again.poolKey).toBe(original.poolKey);
    expect(claimAndDecide(claims, again).outcome).toBe("refused-not-immediate");
  });
});

describe("the R710 as it stands live: refused BEFORE this fix (no claim), settled by Junid by hand", () => {
  const original = ingest(R710_AS_READ_BEFORE, { messageId: "<orig@myupdates1.standardbank.co.za>", receivedAt: ARRIVED, uid: 1 });
  const resend = ingest(R710, { messageId: "<resend@myupdates2.standardbank.co.za>", receivedAt: RESENT, uid: 2 });
  const manualKey = "c63091e121d9466de55db25604a9cfe41620e4d8";
  const typedAt = ARRIVED + 166000;   // typed after the refusal, as Junid did
  const manual = {
    ...manualEntryRecord({ entryId: "ME-test", key: manualKey, reference: "REF710", amountCents: 71000, note: "", actor: { uid: "u", email: "e", name: "Junid" }, at: typedAt }),
    status: "used", used: { at: typedAt + 29000 },
  };

  it("WITHOUT the settled claim, the resend would float — this is the hole", () => {
    const claims = new Map();
    const written = claimAndDecide(claims, resend);
    expect(written).toMatchObject({ outcome: "recorded", status: "unmatched" });
    // …and the settle's other guards would not catch it either:
    expect(consumeFingerprintCheck({ poolKey: resend.poolKey, record: written, siblings: [[original.poolKey, original.record], [manualKey, manual]] }).ok).toBe(true);
    expect(manualTwinSettleCheck({ poolKey: resend.poolKey, record: written, siblings: [[manualKey, manual]] }).ok).toBe(true); // bank dated 11h15, typed later
  });

  it("the manual entry's own fingerprint is MANUAL-…, not the bank's — invisible to the dedupe until claimed", () => {
    expect(paymentFingerprint(manual)).not.toBe(paymentFingerprint(original.record));
  });

  it("settledFingerprintPlan accepts the pair (same money: amount and reference)", () => {
    const plan = settledFingerprintPlan({ refusedKey: original.poolKey, refused: original.record, spenderKey: manualKey, spender: manual });
    expect(plan).toEqual({ ok: true, fingerprint: paymentFingerprint(original.record) });
  });

  it("WITH the settled claim, the resend is held at ingest and refused at the settle as already USED", () => {
    const claims = new Map();
    const fp = paymentFingerprint(original.record);
    claims.set(fp, settledClaimStep({ spenderKey: manualKey, refusedKey: original.poolKey, at: 5 })(null));
    const written = claimAndDecide(claims, resend);
    expect(written).toMatchObject({ outcome: "held-duplicate", duplicateOf: manualKey });
    expect(written.status).toBeUndefined();
    const c = claims.get(fp);
    expect(claimHolderCheck({ poolKey: resend.poolKey, holder: c.poolKey, spentBy: c.spentBy })).toMatchObject({ ok: false, code: "duplicate-used" });
    // The manual entry itself is unaffected: its own fingerprint, its own claim.
    expect(claimHolderCheck({ poolKey: manualKey, holder: c.poolKey, spentBy: c.spentBy }).ok).toBe(true);
  });
});

describe("refusalFingerprint — who claims", () => {
  const original = ingest(R710_AS_READ_BEFORE, { messageId: "<o@x>", receivedAt: ARRIVED, uid: 1 }).record;
  it("a DKIM-verified refusal with a bank id claims it", () => {
    expect(refusalFingerprint(original)).toBe(paymentFingerprint(original));
  });
  it("a forgery (refused-auth) claims nothing — a stranger cannot pre-claim a real id", () => {
    expect(refusalFingerprint({ ...original, outcome: "refused-auth", auth: { verdict: "fail" } })).toBe(null);
  });
  it("an unverified record claims nothing, even carrying a bank id", () => {
    expect(refusalFingerprint({ ...original, auth: { verdict: "not-checked" } })).toBe(null);
  });
  it("recorded and held records are the existing path's, not this one's", () => {
    expect(refusalFingerprint({ ...original, outcome: "recorded" })).toBe(null);
    expect(refusalFingerprint({ ...original, outcome: "held-duplicate" })).toBe(null);
  });
  it("an ACCOUNT refusal now carries the bank id, so it claims it too — allowlisting the account later cannot float a resend", () => {
    const wrongAccount = ingest(R710.map((l) => (l.startsWith("Beneficiary account number") ? "Beneficiary account number XXXXXXXXXXXXX9999" : l)), { messageId: "<acct@x>", receivedAt: ARRIVED, uid: 9 });
    expect(wrongAccount.record.outcome).toBe("refused-account");
    expect(wrongAccount.record.bankRef).toBe("261025SBGRPP00002085C00002085");
    expect(refusalFingerprint(wrongAccount.record)).toBe(paymentFingerprint({ reader: "standardbank", bankRef: wrongAccount.record.bankRef }));
  });
  it("the sweep claims exactly what the poller now claims", () => {
    expect(sweepRefusalClaim(original)).toEqual({ fingerprint: refusalFingerprint(original) });
    expect(sweepRefusalClaim({ ...original, outcome: "recorded" })).toBe(null);
    expect(sweepRefusalClaim({ ...original, auth: { verdict: "fail" } })).toBe(null);
  });
  it("a refusal with no readable bank id claims nothing", () => {
    expect(refusalFingerprint({ ...original, outcome: "refused-parse", bankRef: null })).toBe(null);
  });
});

describe("settledFingerprintPlan / settledClaimStep — never the wrong money, never overwrite", () => {
  const refused = ingest(R710_AS_READ_BEFORE, { messageId: "<o@x>", receivedAt: ARRIVED, uid: 1 }).record;
  const used = { outcome: "recorded", status: "used", reader: "manual", amountCents: 71000, reference: "ref 710" };
  const plan = (over) => settledFingerprintPlan({ refusedKey: "r", refused, spenderKey: "m", spender: used, ...over });
  it("refuses a different amount, a different reference, an unused spender, or one record twice", () => {
    expect(plan({ spender: { ...used, amountCents: 70000 } }).ok).toBe(false);
    expect(plan({ spender: { ...used, reference: "OTHER" } }).ok).toBe(false);
    expect(plan({ spender: { ...used, status: "unmatched" } }).ok).toBe(false);
    expect(plan({ spenderKey: "r" }).ok).toBe(false);
    expect(plan({ refused: { ...refused, auth: { verdict: "fail" } } }).ok).toBe(false);
  });
  it("only a manual entry may be named as the spender", () => {
    const manual = { ...used, manualEntry: { at: 1 } };
    expect(plan({ spender: manual }).ok).toBe(true);
    expect(plan({ spender: { ...manual, reader: "standardbank" } }).ok).toBe(false);
    expect(plan({ spender: used }).ok).toBe(false);   // reader manual but no manualEntry stamp
  });
  it("adds the spender to an existing claim, and never replaces a spender already there", () => {
    expect(settledClaimStep({ spenderKey: "m", refusedKey: "r", at: 9 })({ poolKey: "r", at: 1 })).toMatchObject({ poolKey: "r", spentBy: "m", settledByHandFor: "r" });
    expect(settledClaimStep({ spenderKey: "m", refusedKey: "r", at: 9 })({ poolKey: "x", at: 1, spentBy: "x" })).toBeUndefined();
    expect(settledClaimStep({ spenderKey: "m", refusedKey: "r", at: 9 })("garbage")).toBeUndefined();
  });
  it("the script writes only the fingerprint node — never a pool record", () => {
    const src = readFileSync(resolve(HERE, "claim-settled-bank-fingerprint.mjs"), "utf8");
    const writes = [...src.matchAll(/\)\.(set|update|remove|transaction|push)\(/g)];   // calls on a ref(…), not on arrays
    expect(writes).toHaveLength(1);
    expect(src).toMatch(/db\.ref\(path\)\.transaction\(settledClaimStep/);
    expect(src).toMatch(/const path = `\$\{EFT_FINGERPRINT_PATH\}\//);
  });
});

it("the sweep writes only fingerprint claims, create-only, and reads the pool in pages", () => {
  const src = readFileSync(resolve(HERE, "claim-refusal-fingerprints.mjs"), "utf8");
  const writes = [...src.matchAll(/\)\.(set|update|remove|transaction|push)\(/g)];   // calls on a ref(…), not on arrays
  expect(writes).toHaveLength(1);
  expect(src).toMatch(/db\.ref\(path\)\.transaction\(fingerprintClaimStep\(key,/);
  expect(src).toMatch(/orderByKey\(\)/);
  expect(src).toMatch(/limitToFirst\(PAGE\)/);
});

it("the poller claims a refusal's id before its pool write", () => {
  const src = readFileSync(resolve(HERE, "email-poller.mjs"), "utf8");
  const claim = src.indexOf("const fingerprint = refusalFingerprint(candidate);");
  const write = src.indexOf("await db.ref(`${EFT_POOL_PATH}/${poolKey}`).transaction(createOnlyStep(record");
  expect(claim).toBeGreaterThan(0);
  expect(write).toBeGreaterThan(claim);
});
