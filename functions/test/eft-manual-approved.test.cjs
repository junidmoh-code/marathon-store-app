// ─── MANUAL APPROVAL FROM A PROOF OF PAYMENT — Junid's ledger, locked to Junid ─
// Junid, 29 Oct 2026. Pinned here, because every one of these ships silently
// if it regresses:
//   · a non-Junid account is refused ON THE SERVER before the PDF is decoded;
//   · an uploaded Absa proof with NO transaction number is read by the Absa
//     reader (selected by content), given its synthetic identity, and
//     registered as a USED pool record by Junid with the fingerprint claim
//     naming the approval as spender — and a Standard Bank proof (a
//     transaction-id bank) the same way by its bank id;
//   · the bank's notification arriving LATER — Absa synthetic AND
//     transaction-id — is held as the bank's copy and the settle refuses it;
//     it never re-floats;
//   · the same proof twice is one approval; a bank record already in the
//     pool unused is "use that one"; used money is already-used; a REFUSED
//     record's identity is stamped spent;
//   · a proof paid into someone else's account is refused;
//   · MANUAL FLOAT STILL WORKS WITH NO PROOF: eftPoolManualEntry is untouched.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
// The same require.cache stubbing eft-pool-callables.test.cjs uses, plus the
// PDF extractor (no pdfjs here — the LINES are the fixture) and the secret.
const dbState = { reads: {}, pool: {}, tail: {}, fingerprints: {}, sets: {}, logs: {}, removed: [] };
let pdfLines = null;
const fakeAdmin = {
  apps: [1],
  initializeApp() {},
  database: Object.assign(() => ({
    ref: (path) => ({
      once: async () => ({ val: () => {
        if (path.startsWith("eft_pool_fingerprints/")) return dbState.fingerprints[path] ?? null;
        if (path.startsWith("eft_pool/")) return dbState.pool[path] ?? null;
        return dbState.reads[path] ?? null;
      } }),
      orderByChild: () => ({ limitToLast: () => ({ once: async () => ({ val: () => dbState.tail }) }) }),
      orderByKey: () => ({ limitToLast: () => ({ once: async () => ({ val: () => dbState.logs }) }) }),
      transaction: async (fn) => {
        if (path.startsWith("eft_pool_fingerprints/")) {
          const out = fn(dbState.fingerprints[path] ?? null);
          if (out !== undefined) dbState.fingerprints[path] = out;
          return { committed: out !== undefined };
        }
        if (path.startsWith("eft_pool/")) {
          const out = fn(dbState.pool[path] ?? null);
          if (out !== undefined) dbState.pool[path] = out;
          return { committed: out !== undefined };
        }
        const out = fn(dbState.logs[path] ?? null);
        if (out !== undefined) dbState.logs[path] = out;
        return { committed: out !== undefined };
      },
      set: async (v) => { dbState.sets[path] = v; },
      remove: async () => { dbState.removed.push(path); },
      update: async () => {},
    }),
  }), { ServerValue: { TIMESTAMP: { ".sv": "timestamp" } } }),
};
function stub(name, exportsObj) {
  const path = require.resolve(name);
  require.cache[path] = { id: path, filename: path, loaded: true, exports: exportsObj };
}
stub("firebase-functions/v2/https", { onCall: (_opts, handler) => Object.assign(handler, { opts: _opts }), HttpsError });
stub("firebase-functions/v2/scheduler", { onSchedule: (_opts, handler) => handler });
let secretValue = "62900004321";
stub("firebase-functions/params", { defineSecret: (name) => ({ name, value: () => secretValue }) });
stub("firebase-admin", fakeAdmin);
stub("../cardRecon/pdfText.js", { pdfToLines: async () => (pdfLines ? { ok: true, lines: pdfLines, pages: 1 } : { ok: false, reason: "That PDF holds no text — it is probably a scan." }) });
const { eftPoolManualApprove, eftPoolManualEntry } = require("../eftPool/eftPool.js");
test.after(() => { Module._cache = require.cache; });

const { paymentFingerprint, claimHolderCheck, fingerprintClaimStep } = require("../lib/eft-fingerprint.cjs");
const { approvedKeyOf, approvedInputCheck, approvedClaimDecision, approvedClaimStep, isManualApproved, manualApprovedRecord, proofIdentityOf, approvedLogKeyOf } = require("../lib/eft-manual-approved.cjs");
const { selectReaderByContent, EFT_READERS } = require("../lib/eft-banks.cjs");
const { publicEftView } = require("../lib/eft-pool.cjs");
const { settleDecision } = require("../lib/eft-settle.cjs");

const OWNER = { auth: { uid: "owner-uid", token: { email: "gunidmoh@gmail.com", email_verified: true } } };
const UNVERIFIED_OWNER = { auth: { uid: "owner-uid", token: { email: "gunidmoh@gmail.com", email_verified: false } } };
const MANAGER = { auth: { uid: "manager-uid", token: { email: "ibrahim@marathon.internal" } } };
dbState.reads["users/manager-uid/posAccess"] = { isActive: true, displayName: "ibrahim", role: "manager", eftReview: true, individual: true };

// A real-looking PDF prefix: the input check only needs the magic bytes; the
// extractor is stubbed to return the fixture lines.
const PDF = Buffer.from("%PDF-1.4\n%fixture\n").toString("base64");
const ABSA_NO_TXN = [
  "27 October 2026", "Notice of Payment", "Dear Marathon Club",
  "Please be advised that MRS S SOAP made a payment to your account as indicated below.",
  "Transaction number:", "Payment date:", "2026-10-27", "Payment made by: MRS S SOAP", "Payment made to:", "Marathon Club",
  "Beneficiary bank name: FIRSTRAND", "Beneficiary account number: 62900004321", "Bank branch code: 250655",
  "For the amount of: 1 900.00", "Immediate payment:", "Y", "Reference on beneficiary statement: zanele",
];
const SB = [
  "Dear MARATHON CLUB", "Immediate Payment Confirmation",
  "We confirm that the following payment has been made into your account from J SOAP:",
  "Reference number 4149999999", "Beneficiary name ATUGAR TRADING", "Bank name FIRST NATIONAL BANK",
  "Beneficiary account number XXXXXXXXXXXX4321", "Beneficiary branch number 25065500",
  "Beneficiary reference OM82", "Amount R100.00", "Payment date and time 2026-10-27 09h48",
];

async function rejects(promise, code, detailCode) {
  try { await promise; } catch (e) {
    assert.equal(e.code, code, e.message);
    if (detailCode) assert.equal(e.details?.code, detailCode, e.message);
    return e;
  }
  assert.fail(`expected a ${code} refusal`);
}
function reset() {
  for (const k of ["pool", "fingerprints", "sets", "logs"]) dbState[k] = {};
  dbState.tail = {}; dbState.removed = []; pdfLines = null; secretValue = "62900004321";
}
const upload = (who, extra = {}) => eftPoolManualApprove({ ...who, data: { entryId: "PA-00000001", pdfBase64: PDF, filename: "Proof.pdf", ...extra } });

// ─── THE LOCK ────────────────────────────────────────────────────────────────
test("only Junid: a manager with EFT review, and the owner's email on an unverified token, are refused before the PDF is read", async () => {
  reset(); pdfLines = ABSA_NO_TXN;
  await rejects(upload(MANAGER), "permission-denied", "owner-only");
  await rejects(upload(UNVERIFIED_OWNER), "permission-denied", "owner-only");
  await rejects(eftPoolManualApprove({ auth: null, data: { action: "list" } }), "permission-denied");
  assert.deepEqual(dbState.pool, {}, "nothing was written");
  assert.deepEqual(dbState.fingerprints, {});
});

test("the callable binds the EFT_ALLOWED_ACCOUNTS secret", () => {
  assert.deepEqual(eftPoolManualApprove.opts.secrets.map((s) => s.name), ["EFT_ALLOWED_ACCOUNTS"]);
});

// ─── THE INPUT ───────────────────────────────────────────────────────────────
test("the upload is validated: an entry id, a PDF (by its magic bytes), under 5 MB", async () => {
  assert.equal(approvedInputCheck({}).code, "bad-entry-id");
  assert.equal(approvedInputCheck({ entryId: "PA-00000001" }).code, "no-proof");
  assert.equal(approvedInputCheck({ entryId: "PA-00000001", pdfBase64: Buffer.from("hello").toString("base64") }).code, "not-a-pdf");
  assert.equal(approvedInputCheck({ entryId: "PA-00000001", pdfBase64: "***" }).code, "bad-proof");
  assert.equal(approvedInputCheck({ entryId: "PA-00000001", pdfBase64: "A".repeat(7 * 1024 * 1024) }).code, "proof-too-big");
  const ok = approvedInputCheck({ entryId: "PA-00000001", pdfBase64: `data:application/pdf;base64,${PDF}`, filename: "Proof.pdf", note: "shown on phone" });
  assert.equal(ok.ok, true);
  assert.equal(ok.pdf.subarray(0, 5).toString(), "%PDF-");
  assert.equal(ok.filename, "Proof.pdf");
  reset();
  await rejects(upload(OWNER, { pdfBase64: Buffer.from("not a pdf").toString("base64") }), "invalid-argument", "not-a-pdf");
  pdfLines = null;
  await rejects(upload(OWNER), "invalid-argument", "unreadable-proof");
  pdfLines = ["Dear customer", "Your statement is attached"];
  await rejects(upload(OWNER), "invalid-argument", "no-reader");
});

// ─── AN ABSA PROOF WITH NO TRANSACTION NUMBER ────────────────────────────────
test("an Absa proof with a blank transaction number is registered by its synthetic identity as USED by Junid, with the claim naming the approval as spender", async () => {
  reset(); pdfLines = ABSA_NO_TXN;
  const out = await upload(OWNER, { note: "customer showed the app" });
  assert.equal(out.ok, true);
  assert.equal(out.already, false);
  assert.equal(out.reader, "absa");
  assert.equal(out.amountCents, 190000);
  assert.equal(out.reference, "zanele");
  assert.equal(out.bankRef, null);
  assert.equal(out.synthetic, true);
  assert.equal(out.status, "used");
  const parse = EFT_READERS.find((r) => r.id === "absa").parse(ABSA_NO_TXN);
  const identity = proofIdentityOf(parse, "absa");
  assert.equal(identity.syntheticRef, "ABSA|MRSSSOAP|4321|2026-10-27|190000|ZANELE");
  const key = approvedKeyOf(identity.fingerprint);
  assert.equal(out.key, key);
  const rec = dbState.pool[`eft_pool/${key}`];
  assert.ok(isManualApproved(rec));
  assert.equal(rec.outcome, "recorded");
  assert.equal(rec.status, "used");
  assert.equal(rec.reader, "absa");
  assert.equal(rec.syntheticRef, identity.syntheticRef);
  assert.equal(rec.fingerprint, identity.fingerprint);
  assert.equal(paymentFingerprint(rec), identity.fingerprint, "the record re-derives its own fingerprint");
  assert.equal(rec.auth.verdict, "manual-approved");
  assert.equal(rec.manualApproved.by, "Junid");
  assert.equal(rec.manualApproved.uid, "owner-uid");
  assert.equal(rec.manualApproved.note, "customer showed the app");
  assert.equal(rec.manualApproved.filename, "Proof.pdf");
  assert.equal(rec.used.outsidePos.actorName, "Junid");
  assert.match(rec.used.outsidePos.reason, /proof of payment/);
  assert.equal(rec.used.sale, null);
  assert.equal(rec.destination.accountMask, "XXXXXXX4321", "the full printed account is masked in storage");
  assert.doesNotMatch(rec.rawText, /62900004321/, "the raw text is struck out");
  // The claim: holder AND spender, flagged for the poller.
  const claim = dbState.fingerprints[`eft_pool_fingerprints/${identity.fingerprint}`];
  assert.deepEqual(claim, { poolKey: key, at: claim.at, spentBy: key, manualApproved: true });
  // The log row.
  const logKey = approvedLogKeyOf(rec.manualApproved.at, key);
  assert.equal(dbState.logs[`eft_manual_approvals/${logKey}`].amountCents, 190000);
  assert.equal(dbState.logs[`eft_manual_approvals/${logKey}`].synthetic, true);
  // The till's view, should anyone search it: used, outside the POS. Not spendable.
  assert.equal(publicEftView(key, rec).status, "used");
  assert.equal(publicEftView(key, rec).used.outsidePos, true);
  assert.equal(settleDecision(rec, { attemptId: "t", at: 1, cashierUid: "u", cashierName: "n", appliedCents: 190000, fingerprint: identity.fingerprint, wholePaymentMatched: true }).code, "already-used");
  // The list.
  const list = await eftPoolManualApprove({ ...OWNER, data: { action: "list" } });
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0].key, key);
});

test("the same proof uploaded again is the same approval (already), with nothing re-written", async () => {
  reset(); pdfLines = ABSA_NO_TXN;
  const first = await upload(OWNER);
  const before = JSON.stringify(dbState);
  const again = await upload(OWNER, { entryId: "PA-00000002" });
  assert.equal(again.already, true);
  assert.equal(again.key, first.key);
  assert.equal(JSON.stringify(dbState), before);
});

test("THE BANK'S NOTIFICATION ARRIVING LATER is held as the bank's copy of approved money — Absa synthetic — and never re-floats", async () => {
  reset(); pdfLines = ABSA_NO_TXN;
  const out = await upload(OWNER);
  const fp = paymentFingerprint(dbState.pool[`eft_pool/${out.key}`]);
  // What the poller does on the notification: claim the fingerprint…
  let seen = null;
  const path = `eft_pool_fingerprints/${fp}`;
  const step = fingerprintClaimStep("b".repeat(40), 99, (d) => { seen = d; });
  assert.equal(step(dbState.fingerprints[path]), undefined, "the claim is not overwritten");
  assert.deepEqual(seen, { holder: out.key, spentBy: out.key, manualApproved: true });
  // …and file the record (eftCore.applyFingerprintHold, ESM): held-duplicate naming the approval.
  const { applyFingerprintHold, eftRetryPlan } = await import("../../scripts/cardrecon/eftCore.mjs");
  const notification = {
    outcome: "recorded", status: "unmatched", reader: "absa", bankRef: null,
    syntheticRef: "ABSA|MRSSSOAP|4321|2026-10-27|190000|ZANELE", amountCents: 190000, reference: "zanele", payer: "MRS S SOAP",
  };
  const held = applyFingerprintHold(notification, { fingerprint: fp, poolKey: "b".repeat(40), holder: seen.holder, manualApproved: seen.manualApproved });
  assert.equal(held.outcome, "held-duplicate");
  assert.equal(held.approvedByHand, out.key);
  assert.equal(held.status, undefined);
  // Not a possible duplicate the owner could float, not re-runnable, not settleable.
  const { releaseHoldDecision } = require("../lib/eft-settle.cjs");
  assert.equal(releaseHoldDecision(held, { at: 1, by: "o", reason: "try" }).code, "duplicate-never-released");
  assert.equal(eftRetryPlan({ poolKey: "b".repeat(40), record: held, seenRow: {}, at: 1 }).ok, false);
  assert.equal(claimHolderCheck({ poolKey: "b".repeat(40), holder: seen.holder, spentBy: seen.spentBy }).code, "duplicate-used");
});

// ─── A TRANSACTION-ID BANK (Standard Bank) ───────────────────────────────────
test("a Standard Bank proof is registered by its bank transaction id; the bank's later notification is held and the settle refuses it", async () => {
  reset(); pdfLines = SB;
  const out = await upload(OWNER);
  assert.equal(out.reader, "standardbank");
  assert.equal(out.bankRef, "4149999999");
  assert.equal(out.synthetic, false);
  assert.equal(out.amountCents, 10000);
  const fp = paymentFingerprint({ reader: "standardbank", bankRef: "4149999999" });
  assert.equal(out.key, approvedKeyOf(fp));
  const claim = dbState.fingerprints[`eft_pool_fingerprints/${fp}`];
  assert.equal(claim.spentBy, out.key);
  assert.equal(claim.manualApproved, true);
  let seen = null;
  fingerprintClaimStep("b".repeat(40), 99, (d) => { seen = d; })(claim);
  const { applyFingerprintHold } = await import("../../scripts/cardrecon/eftCore.mjs");
  const held = applyFingerprintHold({ outcome: "recorded", status: "unmatched", reader: "standardbank", bankRef: "4149999999", amountCents: 10000 },
    { fingerprint: fp, poolKey: "b".repeat(40), holder: seen.holder, manualApproved: seen.manualApproved });
  assert.equal(held.outcome, "held-duplicate");
  assert.equal(held.approvedByHand, out.key);
  assert.equal(claimHolderCheck({ poolKey: "b".repeat(40), holder: seen.holder, spentBy: seen.spentBy }).code, "duplicate-used");
});

// ─── WHEN THE BANK GOT THERE FIRST ───────────────────────────────────────────
test("the bank's record already in the pool UNUSED: refused with its key — use that one; USED: already-used; a REFUSED record's id is stamped spent", async () => {
  reset(); pdfLines = ABSA_NO_TXN;
  const parse = EFT_READERS.find((r) => r.id === "absa").parse(ABSA_NO_TXN);
  const fp = proofIdentityOf(parse, "absa").fingerprint;
  const bankKey = "c".repeat(40);
  dbState.fingerprints[`eft_pool_fingerprints/${fp}`] = { poolKey: bankKey, at: 1 };
  dbState.pool[`eft_pool/${bankKey}`] = { outcome: "recorded", status: "unmatched", reader: "absa", amountCents: 190000, syntheticRef: "ABSA|MRSSSOAP|4321|2026-10-27|190000|ZANELE" };
  const e = await rejects(upload(OWNER), "failed-precondition", "bank-record-waiting");
  assert.equal(e.details.key, bankKey);
  assert.equal(dbState.fingerprints[`eft_pool_fingerprints/${fp}`].spentBy, undefined, "the claim was not touched");

  dbState.pool[`eft_pool/${bankKey}`].status = "used";
  await rejects(upload(OWNER), "failed-precondition", "already-used");

  // A refusal holds the id (refusals claim since 25 Oct): the approval stamps it spent.
  dbState.pool[`eft_pool/${bankKey}`] = { outcome: "refused-stale-date", reader: "absa", amountCents: 190000 };
  const out = await upload(OWNER);
  assert.equal(out.ok, true);
  const claim = dbState.fingerprints[`eft_pool_fingerprints/${fp}`];
  assert.equal(claim.poolKey, bankKey, "the holder stays");
  assert.equal(claim.spentBy, out.key);
  assert.equal(claim.manualApproved, true);
  // Now a later copy is duplicate-used at the settle, and the approval is on record.
  assert.equal(claimHolderCheck({ poolKey: "b".repeat(40), holder: bankKey, spentBy: out.key }).code, "duplicate-used");
  // And a second upload is "already".
  assert.equal((await upload(OWNER)).already, true);
});

test("approvedClaimDecision and approvedClaimStep, as data", () => {
  const K = "a".repeat(40), H = "h".repeat(40);
  assert.deepEqual(approvedClaimDecision({ approvedKey: K, claim: null }), { action: "create" });
  assert.equal(approvedClaimDecision({ approvedKey: K, claim: "junk" }).code, "claim-corrupt");
  assert.deepEqual(approvedClaimDecision({ approvedKey: K, claim: { poolKey: K } }), { action: "own" });
  assert.deepEqual(approvedClaimDecision({ approvedKey: K, claim: { poolKey: H, spentBy: K } }), { action: "own" });
  assert.equal(approvedClaimDecision({ approvedKey: K, claim: { poolKey: H, spentBy: "z".repeat(40) } }).code, "already-used");
  assert.equal(approvedClaimDecision({ approvedKey: K, claim: { poolKey: H }, holderRecord: { outcome: "recorded", status: "unmatched" } }).code, "bank-record-waiting");
  assert.equal(approvedClaimDecision({ approvedKey: K, claim: { poolKey: H }, holderRecord: { outcome: "recorded", status: "used" } }).code, "already-used");
  assert.deepEqual(approvedClaimDecision({ approvedKey: K, claim: { poolKey: H }, holderRecord: { outcome: "refused-not-immediate" } }), { action: "spend", holder: H });
  assert.deepEqual(approvedClaimDecision({ approvedKey: K, claim: { poolKey: H }, holderRecord: null }), { action: "spend", holder: H });
  // The step: create; own; stamp only the judged holder; never over a spender.
  let seen;
  assert.deepEqual(approvedClaimStep({ approvedKey: K, at: 5 }, (d) => { seen = d; })(null), { poolKey: K, at: 5, spentBy: K, manualApproved: true });
  assert.equal(approvedClaimStep({ approvedKey: K, at: 5 }, (d) => { seen = d; })({ poolKey: K, at: 1, spentBy: K, manualApproved: true }), undefined);
  assert.equal(seen.spentBy, K);
  assert.deepEqual(approvedClaimStep({ approvedKey: K, at: 5, stampOver: H }, (d) => { seen = d; })({ poolKey: H, at: 1 }), { poolKey: H, at: 1, spentBy: K, manualApproved: true, approvedAt: 5 });
  assert.equal(approvedClaimStep({ approvedKey: K, at: 5, stampOver: H }, (d) => { seen = d; })({ poolKey: "o".repeat(40), at: 1 }), undefined, "a holder that changed hands is not stamped");
  assert.equal(seen.spentBy, null);
  assert.equal(approvedClaimStep({ approvedKey: K, at: 5, stampOver: H }, (d) => { seen = d; })({ poolKey: H, at: 1, spentBy: "z".repeat(40) }), undefined);
  assert.equal(seen.spentBy, "z".repeat(40));
});

// ─── THE DESTINATION ─────────────────────────────────────────────────────────
test("a proof paid into someone else's account, or with no allowlist configured, is refused — nothing registered", async () => {
  reset(); pdfLines = ABSA_NO_TXN.map((l) => (l.startsWith("Beneficiary account number:") ? "Beneficiary account number: 62900009999" : l));
  await rejects(upload(OWNER), "failed-precondition", "wrong-destination");
  pdfLines = ABSA_NO_TXN.map((l) => (l.startsWith("Beneficiary bank name:") ? "Beneficiary bank name: CAPITEC" : l));
  await rejects(upload(OWNER), "failed-precondition", "wrong-destination");
  pdfLines = ABSA_NO_TXN; secretValue = "";
  const e = await rejects(upload(OWNER), "failed-precondition", "wrong-destination");
  assert.match(e.message, /EFT_ALLOWED_ACCOUNTS/);
  assert.deepEqual(dbState.pool, {});
  assert.deepEqual(dbState.fingerprints, {});
});

test("a proof whose reader reads it but which identifies nothing is refused (no-identity)", () => {
  // A Capitec parse with no notification number and no synthetic identity
  // (synthetic identity is Absa-only): nothing to register.
  const r = proofIdentityOf({ ok: true, amountCents: 100, bankRef: null, payer: "X", accountMask: "62900004321", bankTs: 1, reference: "r" }, "capitec");
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-identity");
  assert.equal(proofIdentityOf({ ok: false, reason: "garbled" }, "absa").code, "unreadable-proof");
});

test("manualApprovedRecord is the mark-as-used shape, in the poller's record shape", () => {
  const parse = EFT_READERS.find((r) => r.id === "absa").parse(ABSA_NO_TXN);
  const identity = proofIdentityOf(parse, "absa");
  const r = manualApprovedRecord({ key: "k".repeat(40), readerId: "absa", parse, lines: ABSA_NO_TXN, identity, destination: { accountMask: "XXXXXXX4321", accountTail: "4321" }, actor: { uid: "u", email: "e" }, at: 10, note: null, filename: null, entryId: "PA-00000001" });
  assert.equal(r.ok, true);
  assert.equal(r.value.status, "used");
  assert.equal(r.value.used.attemptId, "outside-pos-10");
  assert.equal(r.value.used.appliedCents, 190000);
  assert.equal(r.value.used.outsidePos.actorName, "Junid");
  assert.equal(r.value.approvedKey, "k".repeat(40));
  assert.ok(isManualApproved(r.value));
  assert.equal(isManualApproved({ ...r.value, status: "unmatched" }), false);
});

// ─── MANUAL FLOAT STILL WORKS WITH NO PROOF ──────────────────────────────────
test("eftPoolManualEntry floats a typed reference and amount with NO proof — untouched", async () => {
  reset();
  const out = await eftPoolManualEntry({ ...OWNER, data: { entryId: "ME-00000001", reference: "Thabo 0821", amountCents: 55000 } });
  assert.equal(out.ok, true);
  assert.equal(out.status, "unmatched");
  const rec = dbState.pool[`eft_pool/${out.key}`];
  assert.equal(rec.reader, "manual");
  assert.equal(rec.status, "unmatched", "spendable at once");
  assert.ok(!("pdfBase64" in rec) && !rec.manualApproved);
  assert.equal(publicEftView(out.key, rec).needsOwner, false, "offered at the till");
  // Approval is separate and optional: the float carried no proof, and the
  // approval callable would have refused that very request as having none.
  assert.equal(approvedInputCheck({ entryId: "ME-00000001", reference: "Thabo 0821", amountCents: 55000 }).code, "no-proof");
});

// ─── ARCHITECT REVIEW (Sonnet, PR #810) — the gaps it found, pinned ──────────
test("an approval is NEVER reversed: eftPoolReverse would otherwise mint ungated spendable money", async () => {
  reset(); pdfLines = ABSA_NO_TXN;
  const out = await upload(OWNER);
  const rec = dbState.pool[`eft_pool/${out.key}`];
  const { reverseDecision } = require("../lib/eft-settle.cjs");
  const d = reverseDecision(rec, { at: 99, by: "gunidmoh@gmail.com", reason: "undo" });
  assert.equal(d.ok, false);
  assert.equal(d.code, "approval-not-reversible");
  const { eftPoolReverse } = require("../eftPool/eftPool.js");
  dbState.txCurrent = rec;
  await rejects(eftPoolReverse({ ...OWNER, data: { poolKey: out.key, reason: "undo the ledger entry" } }), "failed-precondition", "approval-not-reversible");
  assert.equal(dbState.pool[`eft_pool/${out.key}`].status, "used", "still used");
});

test("the poller's claim-then-write gap: a fresh claim with no record behind it is 'claim-settling', never stamped spent", async () => {
  reset(); pdfLines = ABSA_NO_TXN;
  const parse = EFT_READERS.find((r) => r.id === "absa").parse(ABSA_NO_TXN);
  const fp = proofIdentityOf(parse, "absa").fingerprint;
  dbState.fingerprints[`eft_pool_fingerprints/${fp}`] = { poolKey: "c".repeat(40), at: Date.now() - 1000 };
  await rejects(upload(OWNER), "failed-precondition", "claim-settling");
  assert.equal(dbState.fingerprints[`eft_pool_fingerprints/${fp}`].spentBy, undefined);
  // A stale claim with no record is a refusal long gone: stamped.
  dbState.fingerprints[`eft_pool_fingerprints/${fp}`] = { poolKey: "c".repeat(40), at: Date.now() - 60 * 60 * 1000 };
  assert.equal((await upload(OWNER)).ok, true);
  assert.equal(approvedClaimDecision({ approvedKey: "a".repeat(40), claim: { poolKey: "h".repeat(40), at: 1000 }, holderRecord: null, now: 2000 }).code, "claim-settling");
  assert.deepEqual(approvedClaimDecision({ approvedKey: "a".repeat(40), claim: { poolKey: "h".repeat(40), at: 1000 }, holderRecord: null, now: 10 * 60 * 1000 }), { action: "spend", holder: "h".repeat(40) });
});

test("a bank record for approved money that carries a DIFFERENT fingerprint (the proof printed an id, the notice did not) is refused at the settle as a twin", async () => {
  reset(); pdfLines = ABSA_NO_TXN.map((l) => (l === "Transaction number:" ? "Transaction number: 80D2F2AB5A-7" : l));
  const out = await upload(OWNER);
  assert.equal(out.synthetic, false);
  const approval = dbState.pool[`eft_pool/${out.key}`];
  const { approvedTwinSettleCheck } = require("../lib/eft-manual-approved.cjs");
  // The emailed notice: same money, blank transaction number → synthetic identity, a different fingerprint, recorded live by the poller.
  const notice = { outcome: "recorded", status: "unmatched", reader: "absa", bankRef: null, syntheticRef: "ABSA|MRSSSOAP|4321|2026-10-27|190000|ZANELE", amountCents: 190000, reference: "zanele", payer: "MRS S SOAP", bankTs: approval.bankTs, at: approval.at + 5000 };
  assert.notEqual(paymentFingerprint(notice), paymentFingerprint(approval));
  const check = approvedTwinSettleCheck({ poolKey: "9".repeat(40), record: notice, siblings: [[out.key, approval]] });
  assert.equal(check.ok, false);
  assert.equal(check.code, "twin-used");
  assert.doesNotMatch(check.message, /approv|proof|Junid approved/i, "the till learns nothing about provenance");
  // A payment from a week EARLIER with the same reference and amount is a different payment.
  const earlier = { ...notice, bankTs: approval.bankTs - 7 * 24 * 3600 * 1000 };
  assert.equal(approvedTwinSettleCheck({ poolKey: "9".repeat(40), record: earlier, siblings: [[out.key, approval]] }).ok, true);
  // A different amount or reference is not a twin.
  assert.equal(approvedTwinSettleCheck({ poolKey: "9".repeat(40), record: { ...notice, amountCents: 100000 }, siblings: [[out.key, approval]] }).ok, true);
  assert.equal(approvedTwinSettleCheck({ poolKey: "9".repeat(40), record: { ...notice, reference: "other" }, siblings: [[out.key, approval]] }).ok, true);
  // …and the settle callable runs it: the till is refused before any transaction.
  const { eftPoolSettle } = require("../eftPool/eftPool.js");
  dbState.pool[`eft_pool/${"9".repeat(40)}`] = notice;
  dbState.tail = { [out.key]: approval, ["9".repeat(40)]: notice };
  dbState.reads["users/cashier-uid/posAccess/isActive"] = true;
  dbState.reads["users/cashier-uid/posAccess/displayName"] = "Ahmed";
  const CASHIER = { auth: { uid: "cashier-uid", token: { email: "ahmed@marathon.internal" } } };
  await rejects(eftPoolSettle({ ...CASHIER, data: { action: "settle", poolKey: "9".repeat(40), attemptId: "att-1", appliedCents: 190000, storeId: "trophy", tillId: "t1", matchQuery: "zanele" } }), "failed-precondition", "twin-used");
});

test("a later copy of approved money names the APPROVAL as approvedByHand even when a refusal holds the claim", async () => {
  reset(); pdfLines = ABSA_NO_TXN;
  const parse = EFT_READERS.find((r) => r.id === "absa").parse(ABSA_NO_TXN);
  const fp = proofIdentityOf(parse, "absa").fingerprint;
  const refusedKey = "c".repeat(40);
  dbState.fingerprints[`eft_pool_fingerprints/${fp}`] = { poolKey: refusedKey, at: 1 };
  dbState.pool[`eft_pool/${refusedKey}`] = { outcome: "refused-stale-date", reader: "absa", amountCents: 190000 };
  const out = await upload(OWNER);
  let seen = null;
  fingerprintClaimStep("b".repeat(40), 99, (d) => { seen = d; })(dbState.fingerprints[`eft_pool_fingerprints/${fp}`]);
  assert.deepEqual(seen, { holder: refusedKey, spentBy: out.key, manualApproved: true });
  const { applyFingerprintHold } = await import("../../scripts/cardrecon/eftCore.mjs");
  const held = applyFingerprintHold({ outcome: "recorded", status: "unmatched", reader: "absa", bankRef: null, syntheticRef: "ABSA|MRSSSOAP|4321|2026-10-27|190000|ZANELE" },
    { fingerprint: fp, poolKey: "b".repeat(40), holder: seen.holder, manualApproved: seen.manualApproved, spentBy: seen.spentBy });
  assert.equal(held.outcome, "held-duplicate");
  assert.equal(held.approvedByHand, out.key);
  assert.equal(held.duplicateOf, refusedKey);
});

test("no allowlist configured for Cloud Functions names the SECRET, not the mini's .env", async () => {
  reset(); pdfLines = ABSA_NO_TXN; secretValue = "";
  const e = await rejects(upload(OWNER), "failed-precondition", "wrong-destination");
  assert.match(e.message, /secret/);
  assert.doesNotMatch(e.message, /\.env on the mini/);
});
