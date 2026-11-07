// ─── MANUAL EFT ENTRY — Junid's escape hatch, locked to Junid ────────────────
// Pinned here, because every one of these ships silently if it regresses:
//   · a non-Junid account — cashier, manager with EFT review, a shared till
//     login — is refused ON THE SERVER before any read;
//   · Junid's entry becomes a recorded, unmatched, spendable pool record
//     stamped { by: "Junid", uid, email, at: server time } with reader
//     "manual", a synthetic fingerprint claimed create-only — and the till's
//     view of it is INDISTINGUISHABLE from a bank-confirmed payment's (Junid,
//     20 Oct 2026), while the record and the log keep the provenance;
//   · it settles ONCE through the ordinary settle; a second attempt loses
//     exactly as a second till loses a bank payment;
//   · the same entryId is an idempotent retry; the same reference + amount
//     again is refused;
//   · the entry and its consumption are logged.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  manualEntryKeyOf, manualEntryInputCheck, manualEntryRecord, isManualEntry, manualDuplicateOf,
  bankTwinOfEntry, manualTwinSettleCheck,
  manualLogKeyOf, manualLogRecord, manualLogEventPatch, manualLogView, MANUAL_READER,
} = require("../lib/eft-manual.cjs");
const { paymentFingerprint, consumeFingerprintCheck, claimHolderCheck } = require("../lib/eft-fingerprint.cjs");
const { settleDecision } = require("../lib/eft-settle.cjs");
const { publicEftView, searchEftPool } = require("../lib/eft-pool.cjs");

const ACTOR = { uid: "owner-uid", email: "gunidmoh@gmail.com", name: "Junid" };
const ENTRY = { entryId: "ME-abc12345", reference: "Thabo 0821", amountCents: 55000, note: "Capitec, no email" };

// ─── PURE ────────────────────────────────────────────────────────────────────
test("the typed entry is validated: reference ≥ 3 letters/digits, R1–R50,000, an entry id", () => {
  const ok = manualEntryInputCheck(ENTRY);
  assert.deepEqual(ok, { ok: true, entryId: "ME-abc12345", reference: "THABO 0821", amountCents: 55000, note: "Capitec, no email" });
  assert.equal(manualEntryInputCheck({ ...ENTRY, reference: " - " }).code, "bad-reference");
  assert.equal(manualEntryInputCheck({ ...ENTRY, amountCents: 50 }).code, "bad-amount");
  assert.equal(manualEntryInputCheck({ ...ENTRY, amountCents: 5_000_001 }).code, "bad-amount");
  assert.equal(manualEntryInputCheck({ ...ENTRY, amountCents: "550" }).code, "bad-amount");
  assert.equal(manualEntryInputCheck({ ...ENTRY, entryId: "x" }).code, "bad-entry-id");
  assert.equal(manualEntryInputCheck({ ...ENTRY, entryId: "../users/x" }).code, "bad-entry-id");
});

test("the record is a recorded, unmatched pool payment, stamped by Junid, with a fingerprint of its own", () => {
  const key = manualEntryKeyOf(ENTRY.entryId);
  assert.match(key, /^[0-9a-f]{40}$/);
  assert.equal(key, manualEntryKeyOf(ENTRY.entryId), "the same entry id is the same key");
  const r = manualEntryRecord({ ...ENTRY, key, actor: ACTOR, at: 1700 });
  assert.equal(r.outcome, "recorded");
  assert.equal(r.status, "unmatched");
  assert.equal(r.reader, MANUAL_READER);
  assert.equal(r.amountCents, 55000);
  assert.equal(r.reference, "Thabo 0821", "stored as the callable hands it over (upper-cased by the input check)");
  assert.equal(r.payer, null, "no payer was read from any bank");
  assert.equal(r.rawText, null);
  assert.deepEqual(r.manualEntry, { by: "Junid", uid: "owner-uid", email: "gunidmoh@gmail.com", at: 1700, note: "Capitec, no email", entryId: "ME-abc12345" });
  assert.ok(isManualEntry(r));
  assert.ok(paymentFingerprint(r), "the synthetic bank ref gives it a fingerprint, so consume-once applies");
  const other = manualEntryRecord({ ...ENTRY, entryId: "ME-other0001", key: manualEntryKeyOf("ME-other0001"), actor: ACTOR, at: 1701 });
  assert.notEqual(paymentFingerprint(other), paymentFingerprint(r), "every entry is its own transaction");
});

// A bank-confirmed payment of the same money, arriving at the same moment,
// with no payer read — the closest bank twin a manual entry can have.
const bankLike = (at = 1700, over = {}) => ({
  at, receivedAt: at, bankTs: at, outcome: "recorded", status: "unmatched", amountCents: 55000,
  reference: "THABO 0821", reader: "capitec", bankRef: "ABCD1234", payer: null, ...over,
});
// What the callable stores: the input as manualEntryInputCheck cleaned it.
const typedRecord = (key) => manualEntryRecord({ ...manualEntryInputCheck(ENTRY), key, actor: ACTOR, at: 1700 });

test("the till's view of a manual entry is IDENTICAL to a bank-confirmed payment's — no trace of Junid", () => {
  const key = manualEntryKeyOf(ENTRY.entryId);
  const r = typedRecord(key);
  const v = publicEftView(key, r);
  const b = publicEftView(key, bankLike());
  assert.deepEqual(v, b, "field for field, the cashier sees the same payment");
  assert.equal(v.needsOwner, false, "spendable as it stands");
  assert.equal("manualEntry" in v, false);
  const text = JSON.stringify(v);
  for (const leak of ["gunidmoh", "Junid", "manual", "MANUAL", "hand", "Capitec, no email", ENTRY.entryId]) {
    assert.ok(!text.includes(leak), `"${leak}" never reaches the till`);
  }
  // …and the same through the search, the till's only way to the pool.
  const s = searchEftPool({ [key]: r }, "thabo 0821").results[0];
  assert.deepEqual(s, searchEftPool({ [key]: bankLike() }, "thabo 0821").results[0]);
  for (const leak of ["Junid", "manual", "MANUAL", "hand"]) assert.ok(!JSON.stringify(s).includes(leak));
});

test("the provenance stays with Junid: the pool record, the settled record and the log row say manual", () => {
  const key = manualEntryKeyOf(ENTRY.entryId);
  const r = typedRecord(key);
  assert.equal(r.reader, MANUAL_READER);
  assert.equal(r.auth.verdict, "manual");
  assert.deepEqual({ by: r.manualEntry.by, email: r.manualEntry.email, at: r.manualEntry.at }, { by: "Junid", email: "gunidmoh@gmail.com", at: 1700 });
  const settled = settleDecision(r, { fingerprint: paymentFingerprint(r), customerResolved: true, confirmedCustomerId: "c1", customerId: "c1", customerName: "Thabo", attemptId: "E-1", at: 2000, cashierUid: "u1", cashierName: "Ahmed", storeId: "trophy", tillId: "till-1", appliedCents: 55000 });
  assert.ok(isManualEntry(settled.value), "consumed, still marked manual on the record");
  const row = manualLogRecord(r, key);
  assert.equal(row.by, "Junid");
  assert.equal(row.reference, "THABO 0821");
  const used = manualLogEventPatch("settle", settled.value, 2000);
  assert.deepEqual({ status: used.status, cashierName: used.cashierName, storeId: used.storeId }, { status: "used", cashierName: "Ahmed", storeId: "trophy" }, "the consumption lands in Junid's log");
});

test("a cashier finds it by its reference like any payment, and it consumes ONCE", () => {
  const key = manualEntryKeyOf(ENTRY.entryId);
  const r = manualEntryRecord({ ...ENTRY, key, actor: ACTOR, at: 1700 });
  const found = searchEftPool({ [key]: r }, "thabo 0821");
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].key, key);
  // The settle's checks, exactly as for a bank payment.
  const check = consumeFingerprintCheck({ poolKey: key, record: r, siblings: [] });
  assert.equal(check.ok, true);
  assert.equal(claimHolderCheck({ poolKey: key, holder: key }).ok, true);
  const settlement = { fingerprint: check.fingerprint, customerResolved: true, confirmedCustomerId: "c1", customerId: "c1", customerName: "Thabo", attemptId: "E-1", at: 2000, cashierUid: "u1", cashierName: "Ahmed", storeId: "trophy", tillId: "till-1", appliedCents: 55000 };
  const first = settleDecision(r, settlement);
  assert.equal(first.ok, true);
  assert.equal(first.value.status, "used");
  assert.ok(isManualEntry(first.value), "the stamp survives the settle");
  const second = settleDecision(first.value, { ...settlement, attemptId: "E-2", cashierUid: "u2", cashierName: "Sipho" });
  assert.equal(second.ok, false);
  assert.equal(second.code, "already-used", "a second till loses, as for any payment");
  assert.deepEqual(settleDecision(first.value, settlement), { ok: true, already: true }, "the same attempt retrying is not a second spend");
  // No customer on the sale (19 Oct 2026): a manual entry consumed WHOLE may
  // settle only when the callable found it by the typed reference again
  // (wholePaymentMatched); never on its amount, and never with money left over.
  const noCustomer = settleDecision(r, { ...settlement, customerId: null, confirmedCustomerId: null });
  assert.equal(noCustomer.code, "not-matched", "no customer and no re-resolved reference: refused");
  const leftover = settleDecision(r, { ...settlement, customerId: null, confirmedCustomerId: null, wholePaymentMatched: true, appliedCents: 50000 });
  assert.equal(leftover.code, "no-customer", "money left over needs the customer it belongs to");
  const whole = settleDecision(r, { ...settlement, customerId: null, confirmedCustomerId: null, wholePaymentMatched: true });
  assert.equal(whole.ok, true);
  assert.equal(whole.value.used.customerId, null);
  assert.equal(whole.value.used.wholePaymentMatched, true);
  // The same attempt retrying, now without the match flag (the search sees
  // the record as used): still `already`, never a refusal.
  assert.deepEqual(settleDecision(whole.value, { ...settlement, customerId: null, confirmedCustomerId: null }), { ok: true, already: true });
});

test("the same reference and amount twice is a duplicate; the same entryId is a retry; a bank twin is flagged", () => {
  const key = manualEntryKeyOf(ENTRY.entryId);
  const r = manualEntryRecord({ ...ENTRY, key, actor: ACTOR, at: 1700 });
  assert.equal(manualDuplicateOf({ reference: "THABO-0821", amountCents: 55000, entryId: "ME-second001" }, [[key, r]])?.key, key);
  assert.equal(manualDuplicateOf({ reference: "Thabo 0821", amountCents: 55000, entryId: ENTRY.entryId }, [[key, r]]), null, "a retry of the same entry");
  assert.equal(manualDuplicateOf({ reference: "Thabo 0821", amountCents: 56000, entryId: "ME-second001" }, [[key, r]]), null, "a different amount is a different payment");
  const bankRec = { outcome: "recorded", status: "unmatched", amountCents: 100, reference: "X", reader: "fnb", bankRef: "5TG59DVQ", at: 1 };
  assert.equal(manualDuplicateOf({ reference: "X", amountCents: 100, entryId: "ME-second001" }, [["b", bankRec]]), null, "a bank payment is never a manual duplicate");
  // The real notification lands AFTER the manual entry was spent. It carries
  // its OWN bank transaction number, so since 7 Nov 2026 (Junid) it is judged
  // on that number alone: no "already used" warning at the till and no
  // refusal at the settle on the shared reference + amount — the settle only
  // reports the used hand entry for the server's log line.
  const spent = { ...r, status: "used", used: { at: 2000, sale: { receiptNumber: "S-9" } } };
  const bankTwin = { outcome: "recorded", status: "unmatched", amountCents: 55000, reference: "THABO 0821", reader: "capitec", bankRef: "ABCD1234", at: 3000 };
  const out = searchEftPool({ [key]: spent, b: bankTwin }, "thabo 0821");
  assert.equal(out.results[0].key, "b");
  assert.equal(out.results[0].sameUsed, undefined);
  const settleTwin = manualTwinSettleCheck({ poolKey: "b", record: bankTwin, siblings: [[key, spent], ["b", bankTwin]] });
  assert.equal(settleTwin.ok, true);
  assert.equal(settleTwin.txnOverManualTwin, key);
  assert.equal(manualTwinSettleCheck({ poolKey: "b", record: bankTwin, siblings: [[key, r]] }).ok, true, "a WAITING manual twin does not block");
  const both = searchEftPool({ [key]: r, b: bankTwin }, "thabo 0821").results[0];
  assert.equal(both.key, "b", "both waiting: the bank's record is the answer");
  assert.equal(both.sameUsed, undefined, "and the cashier is told nothing about the hand entry");
  // THE REVERSE ORDER (CodeRabbit): the bank twin arrived AFTER the entry and
  // was used while the manual one still waits — the manual entry is refused.
  const bankUsed = { ...bankTwin, status: "used", used: { at: 4000, sale: { receiptNumber: "S-10" } } };
  const rev = manualTwinSettleCheck({ poolKey: key, record: r, siblings: [[key, r], ["b", bankUsed]] });
  assert.equal(rev.ok, false);
  assert.equal(rev.code, "twin-used");
  assert.equal(rev.side, "bank-twin-used");
  assert.match(rev.message, /slip S-10/);
  assert.deepEqual(searchEftPool({ [key]: r, b: bankUsed }, "thabo 0821").results[0].sameUsed, { at: 4000, receiptNumber: "S-10" });
  // The sentence never says a side was typed by hand: the cashier cannot tell.
  assert.doesNotMatch(rev.message, /manual|hand|Junid typed/i);
  assert.doesNotMatch(rev.message, /by hand|manual|bank's/i);
  // …but a bank payment from ANOTHER DAY (last week's) is a different payment, never a twin.
  // (7 Nov 2026: the twin is the same SAST day, not merely "arrived before" —
  // a same-day bank payment with the same reference and amount is the twin.)
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const earlier = { ...bankUsed, at: 1700 - WEEK, receivedAt: 1700 - WEEK, bankTs: 1700 - WEEK };
  assert.equal(manualTwinSettleCheck({ poolKey: key, record: r, siblings: [["b", earlier]] }).ok, true);
  assert.equal(searchEftPool({ [key]: r, b: earlier }, "thabo 0821").results[0].sameUsed, undefined);
  // ENTRY-TIME: the bank's own unmatched record is already there → no manual entry.
  assert.equal(bankTwinOfEntry({ reference: "thabo-0821", amountCents: 55000 }, [["b", bankTwin]])?.key, "b");
  assert.equal(bankTwinOfEntry({ reference: "thabo-0821", amountCents: 55000 }, [["b", { ...bankTwin, status: "used" }]]), null, "a used bank record is not a reason to refuse — it may be an earlier payment");
});

test("the log row follows the entry: entered → used (who, where, for whom) → sale attached → reversed", () => {
  const key = manualEntryKeyOf(ENTRY.entryId);
  const r = manualEntryRecord({ ...ENTRY, key, actor: ACTOR, at: 1700 });
  assert.equal(manualLogKeyOf(1700, key), `0000000001700_${key}`, "zero-padded time first — key order is time order, no index");
  const row = manualLogRecord(r, key);
  assert.deepEqual(row, { key, entryId: "ME-abc12345", at: 1700, by: "Junid", uid: "owner-uid", email: "gunidmoh@gmail.com", reference: "Thabo 0821", amountCents: 55000, note: "Capitec, no email", status: "unmatched" });
  const used = { ...r, status: "used", used: { at: 2000, cashierUid: "u1", cashierName: "Ahmed", storeId: "trophy", tillId: "till-1", customerId: "c1", customerName: "Thabo", appliedCents: 55000, sale: null } };
  assert.deepEqual(manualLogEventPatch("settle", used, 2001), { status: "used", usedAt: 2000, cashierUid: "u1", cashierName: "Ahmed", storeId: "trophy", tillId: "till-1", customerId: "c1", customerName: "Thabo", appliedCents: 55000, saleId: null, receiptNumber: null });
  const attached = { ...used, used: { ...used.used, sale: { saleId: "S1", receiptNumber: "S-42" } } };
  assert.deepEqual(manualLogEventPatch("attach", attached, 2002), { saleId: "S1", receiptNumber: "S-42", attachedAt: 2002 });
  assert.equal(manualLogEventPatch("release", { ...r }, 2003).status, "unmatched");
  assert.equal(manualLogEventPatch("reverse", { ...r, reversals: { 2004: {} } }, 2004).reversals, 1);
  assert.equal(manualLogEventPatch("settle", { outcome: "recorded", status: "used", reader: "fnb" }, 1), null, "a bank payment writes no manual log");
  const view = manualLogView({ [manualLogKeyOf(1700, key)]: { ...row, status: "used" }, [manualLogKeyOf(1800, "b".repeat(40))]: { ...row, at: 1800, status: "unmatched" } });
  assert.deepEqual(view.counts, { entered: 2, used: 1, waiting: 1, outsidePos: 0 });
  assert.equal(view.entries[0].at, 1800, "newest first");
});

// ─── THE CALLABLES, through a stubbed Admin SDK ──────────────────────────────
class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
const db = { reads: {}, sets: {}, updates: {}, tx: {}, tail: {}, queries: [], readLog: [] };
const fakeAdmin = {
  apps: [1], initializeApp() {},
  database: Object.assign(() => ({
    ref: (path) => {
      const q = { cs: [] };
      const chain = {
        orderByChild: (k) => { q.cs.push(["orderByChild", k]); return chain; },
        orderByKey: () => { q.cs.push(["orderByKey"]); return chain; },
        startAt: (v) => { q.cs.push(["startAt", v]); return chain; },
        startAfter: (v) => { q.cs.push(["startAfter", v]); return chain; },
        limitToFirst: (n) => { q.cs.push(["limitToFirst", n]); return chain; },
        limitToLast: (n) => { q.cs.push(["limitToLast", n]); return chain; },
        once: async () => {
          db.queries.push({ path, cs: q.cs }); db.readLog.push(path);
          // A queried node answers with its children, as RTDB does.
          const children = () => Object.fromEntries(Object.entries(db.reads).filter(([k]) => k.startsWith(`${path}/`)).map(([k, v]) => [k.slice(path.length + 1), v]));
          const v = path === "eft_pool" && q.cs.length ? db.tail : q.cs.length ? children() : (db.reads[path] ?? null);
          return { val: () => v, forEach: (fn) => { for (const key of Object.keys(v ?? {})) fn({ key }); } };
        },
        set: async (v) => { db.sets[path] = v; db.reads[path] = v; },
        remove: async () => { delete db.reads[path]; },
        update: async (v) => { db.updates[path] = { ...(db.updates[path] ?? {}), ...v }; db.reads[path] = { ...(db.reads[path] ?? {}), ...v }; },
        transaction: async (fn) => {
          const out = fn(db.reads[path] ?? null);
          if (out !== undefined) { db.reads[path] = out; db.tx[path] = out; }
          return { committed: out !== undefined, snapshot: { val: () => db.reads[path] ?? null } };
        },
      };
      return chain;
    },
  }), { ServerValue: { TIMESTAMP: { ".sv": "timestamp" } } }),
};
function stub(name, exportsObj) {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}
stub("firebase-functions/v2/https", { onCall: (_o, h) => h, HttpsError });
stub("firebase-functions/v2/scheduler", { onSchedule: (_o, h) => h });
stub("firebase-admin", fakeAdmin);
const { eftPoolManualEntry, eftPoolSettle, eftPoolReverse } = require("../eftPool/eftPool.js");

const OWNER = { auth: { uid: "owner-uid", token: { email: "gunidmoh@gmail.com", email_verified: true } } };
const UNVERIFIED_OWNER = { auth: { uid: "x", token: { email: "gunidmoh@gmail.com", email_verified: false } } };
const CASHIER = { auth: { uid: "cashier-uid", token: { email: "ahmed@marathon.internal" } } };
const REVIEWER = { auth: { uid: "reviewer-uid", token: { email: "ibrahim@marathon.internal" } } };
const SHARED = { auth: { uid: "shared-uid", token: { email: "pe-till@marathon.internal", name: "PE Till" } } };
db.reads["users/cashier-uid/posAccess/isActive"] = true;
db.reads["users/cashier-uid/posAccess/displayName"] = "Ahmed";
db.reads["users/reviewer-uid/posAccess/isActive"] = true;
db.reads["users/reviewer-uid/posAccess"] = { isActive: true, displayName: "ibrahim", role: "manager", eftReview: true, individual: true };
db.reads["users/shared-uid/posAccess/isActive"] = true;
db.reads["users/shared-uid/posAccess"] = { isActive: true, displayName: "PE Till", role: "cashier", eftReview: true };
db.reads["customers/0821234567"] = { name: "Thabo" };

async function rejects(promise, code) {
  try { await promise; } catch (e) { assert.equal(e.code, code, e.message); return e; }
  assert.fail(`expected a ${code} refusal`);
}

test("HARD LOCK: anyone but Junid is refused ON THE SERVER, before anything is read", async () => {
  for (const who of [CASHIER, REVIEWER, SHARED, UNVERIFIED_OWNER, { auth: null }]) {
    db.readLog = [];
    const e = await rejects(eftPoolManualEntry({ ...who, data: ENTRY }), "permission-denied");
    assert.match(e.message, /Only Junid/);
    assert.equal(e.details.code, "owner-only");
    assert.deepEqual(db.readLog, [], "no read, no transaction, nothing");
    await rejects(eftPoolManualEntry({ ...who, data: { action: "list" } }), "permission-denied");
  }
});

test("Junid's entry lands in the pool: recorded, unmatched, stamped, fingerprint claimed, logged", async () => {
  db.sets = {}; db.tx = {}; db.tail = {};
  const before = Date.now();
  const out = await eftPoolManualEntry({ ...OWNER, data: ENTRY });
  assert.equal(out.ok, true);
  assert.equal(out.already, false);
  assert.equal(out.by, "Junid");
  assert.ok(out.at >= before, "stamped with the server's own time");
  const key = out.key;
  assert.equal(key, manualEntryKeyOf(ENTRY.entryId));
  const rec = db.reads[`eft_pool/${key}`];
  assert.equal(rec.outcome, "recorded");
  assert.equal(rec.status, "unmatched");
  assert.equal(rec.reader, "manual");
  assert.deepEqual({ by: rec.manualEntry.by, uid: rec.manualEntry.uid, email: rec.manualEntry.email }, { by: "Junid", uid: "owner-uid", email: "gunidmoh@gmail.com" });
  const fp = paymentFingerprint(rec);
  assert.equal(db.reads[`eft_pool_fingerprints/${fp}`].poolKey, key, "the claim names this record — one entry, one spend");
  const logKey = manualLogKeyOf(rec.manualEntry.at, key);
  assert.equal(db.reads[`eft_manual_entries/${logKey}`].status, "unmatched");
  assert.equal(db.reads[`eft_manual_entries/${logKey}`].reference, "THABO 0821");
  // The bank's own unmatched record for the same money in the tail: refused.
  // (Dated today: since 7 Nov 2026 only a bank payment within a day of the
  // entry is "the same money" — see the identity tests below.)
  db.tail = { bank1: { outcome: "recorded", status: "unmatched", amountCents: 60000, reference: "OTHER 1", reader: "fnb", bankRef: "ABCD9999", at: Date.now(), receivedAt: Date.now(), bankTs: Date.now() } };
  const bt = await rejects(eftPoolManualEntry({ ...OWNER, data: { ...ENTRY, entryId: "ME-twin00001", reference: "other 1", amountCents: 60000 } }), "failed-precondition");
  assert.equal(bt.details.code, "bank-twin-waiting");
  db.tail = {};
  // The same form submit again: the same record, nothing new written.
  const again = await eftPoolManualEntry({ ...OWNER, data: ENTRY });
  assert.equal(again.already, true);
  assert.equal(again.key, key);
  // THE EXACT SAME ENTRY under a new entry id within seconds: an accidental
  // double tap — answered with the first record, nothing new written.
  db.tail = { [key]: rec };
  const tap = await eftPoolManualEntry({ ...OWNER, data: { ...ENTRY, entryId: "ME-second001" } });
  assert.deepEqual({ ok: tap.ok, already: tap.already, doubleSubmit: tap.doubleSubmit, key: tap.key }, { ok: true, already: true, doubleSubmit: true, key });
  assert.equal(db.reads[`eft_pool/${manualEntryKeyOf("ME-second001")}`], undefined);
  // The same reference and amount as a SEPARATE entry (Junid, 7 Nov 2026):
  // accepted, with a warning — its own record, its own fingerprint.
  const earlier = { ...rec, manualEntry: { ...rec.manualEntry, at: rec.manualEntry.at - 60 * 1000 } };
  db.tail = { [key]: earlier };
  // (That first entry's short submit lock has long expired in this story.)
  for (const k of Object.keys(db.reads)) if (k.startsWith("eft_manual_submit_locks/")) db.reads[k] = { ...db.reads[k], at: db.reads[k].at - 60 * 1000 };
  const second = await eftPoolManualEntry({ ...OWNER, data: { ...ENTRY, entryId: "ME-second002" } });
  assert.equal(second.ok, true);
  assert.equal(second.already, false);
  assert.notEqual(second.key, key);
  assert.equal(second.reference, "THABO 0821", "the same reference — no renaming to \"… 2\"");
  assert.equal(second.warning.code, "similar-entry");
  assert.equal(second.warning.key, key);
  assert.match(second.warning.message, /SEPARATE payment/);
  const secondRec = db.reads[`eft_pool/${second.key}`];
  assert.equal(secondRec.status, "unmatched");
  assert.notEqual(paymentFingerprint(secondRec), paymentFingerprint(rec), "each hand entry is its own record");
  // A different note seconds later is a deliberate entry, not a double tap.
  db.tail = { [key]: rec };
  const noted = await eftPoolManualEntry({ ...OWNER, data: { ...ENTRY, entryId: "ME-second003", note: "second payment" } });
  assert.equal(noted.already, false);
  assert.equal(noted.warning.code, "similar-entry");
  // TWO TAPS IN FLIGHT AT ONCE: the tail does not yet show the first, but its
  // submit lock does — the second is answered with the first.
  db.tail = {};
  const inFlight = await eftPoolManualEntry({ ...OWNER, data: { ...ENTRY, entryId: "ME-second004", note: "second payment" } });
  assert.deepEqual({ already: inFlight.already, doubleSubmit: inFlight.doubleSubmit, key: inFlight.key }, { already: true, doubleSubmit: true, key: noted.key });
  assert.equal(db.reads[`eft_pool/${manualEntryKeyOf("ME-second004")}`], undefined);
  // A lock whose holder has NO record (still writing, or its write failed):
  // the tap is refused, never written beside it (CodeRabbit).
  const lockKey = Object.keys(db.reads).find((k) => k.startsWith("eft_manual_submit_locks/") && db.reads[k].key === noted.key);
  db.reads[lockKey] = { key: "f".repeat(40), at: Date.now() };
  const busy = await rejects(eftPoolManualEntry({ ...OWNER, data: { ...ENTRY, entryId: "ME-second005", note: "second payment" } }), "aborted");
  assert.equal(busy.details.code, "submit-in-progress");
  assert.equal(db.reads[`eft_pool/${manualEntryKeyOf("ME-second005")}`], undefined);
});

test("a cashier consumes it through the ORDINARY settle, once; the log says who, where, for whom", async () => {
  const key = manualEntryKeyOf(ENTRY.entryId);
  const rec = db.reads[`eft_pool/${key}`];
  assert.ok(rec, "entered above");
  db.tail = { [key]: rec };
  const settle = (attemptId, who = CASHIER) => eftPoolSettle({ ...who, data: { action: "settle", poolKey: key, attemptId, appliedCents: 55000, storeId: "trophy", tillId: "till-1", customerId: "0821234567", confirmedCustomerId: "0821234567" } });
  const first = await settle("E-1");
  assert.equal(first.ok, true);
  const used = db.reads[`eft_pool/${key}`];
  assert.equal(used.status, "used");
  assert.equal(used.used.cashierName, "Ahmed");
  assert.ok(isManualEntry(used), "still marked as Junid's entry after the spend");
  const logKey = manualLogKeyOf(rec.manualEntry.at, key);
  const row = db.reads[`eft_manual_entries/${logKey}`];
  assert.equal(row.status, "used");
  assert.deepEqual({ cashierName: row.cashierName, storeId: row.storeId, tillId: row.tillId, customerName: row.customerName, appliedCents: row.appliedCents }, { cashierName: "Ahmed", storeId: "trophy", tillId: "till-1", customerName: "Thabo", appliedCents: 55000 });
  // A second attempt — another till — cannot spend it again.
  const e = await rejects(settle("E-2"), "failed-precondition");
  assert.equal(e.details.code, "already-used");
  assert.equal(db.reads[`eft_pool/${key}`].used.attemptId, "E-1", "the first settlement stands");
  // The sale attaches, and the log carries the slip.
  db.reads["pos/sales/S-manual"] = { customerId: "0821234567", payments: { p: { method: "eft", amount: 55000, eftPoolKey: key } } };
  db.reads[`eft_pool/${key}/used`] = db.reads[`eft_pool/${key}`].used;
  await eftPoolSettle({ ...CASHIER, data: { action: "attach", poolKey: key, attemptId: "E-1", saleId: "S-manual", receiptNumber: "S-42" } });
  assert.equal(db.reads[`eft_manual_entries/${logKey}`].receiptNumber, "S-42");
  assert.equal(db.reads[`eft_manual_entries/${logKey}`].saleId, "S-manual");
  // The owner's reversal returns it to waiting, and the log says so.
  await eftPoolReverse({ ...OWNER, data: { poolKey: key, reason: "wrong customer" } });
  assert.equal(db.reads[`eft_pool/${key}`].status, "unmatched");
  assert.equal(db.reads[`eft_manual_entries/${logKey}`].status, "unmatched");
  assert.equal(db.reads[`eft_manual_entries/${logKey}`].reversals, 1);
});

test("the review list is Junid's alone and reads one bounded page by key order", async () => {
  db.queries = [];
  const out = await eftPoolManualEntry({ ...OWNER, data: { action: "list" } });
  assert.equal(out.ok, true);
  assert.equal(out.counts.entered, 3, "the first entry and the two separate same-reference entries above");
  const q = db.queries.find((x) => x.path === "eft_manual_entries");
  assert.deepEqual(q.cs.map((c) => c[0]), ["orderByKey", "limitToLast"], "no index needed, never the node");
});

// ─── CONCRETE ENFORCED (2 Nov 2026): THE OWNER'S ESCAPE HATCH IS UNCHANGED ───
// At an enforced store the till offers no "EFT without matching"; the
// cashier matches, parks, or asks Junid to enter the payment by hand. That
// hand entry is still Junid's alone, and a cashier AT CONCRETE consumes it
// through the ordinary consume-once settle like any matched payment.
test("CONCRETE: Junid's hand entry is the escape hatch — owner-only, and spent once by a Concrete till", async () => {
  db.reads["eft_enforcement"] = { stores: { concrete: true, pe: true, trophy: true }, updatedAt: 1, updatedBy: "gunidmoh@gmail.com" };
  const entry = { entryId: "ME-concrt01", reference: "Concrete 0831", amountCents: 32000, note: "Concrete, no email yet" };
  for (const who of [CASHIER, REVIEWER, SHARED]) {
    await rejects(eftPoolManualEntry({ ...who, data: entry }), "permission-denied");
  }
  db.tail = {};
  const out = await eftPoolManualEntry({ ...OWNER, data: entry });
  assert.equal(out.ok, true);
  const key = out.key;
  db.tail = { [key]: db.reads[`eft_pool/${key}`] };
  const settle = (attemptId) => eftPoolSettle({ ...CASHIER, data: { action: "settle", poolKey: key, attemptId, appliedCents: 32000, storeId: "concrete", tillId: "till-1", customerId: "0821234567", confirmedCustomerId: "0821234567" } });
  assert.equal((await settle("C-1")).ok, true);
  assert.equal(db.reads[`eft_pool/${key}`].status, "used");
  assert.equal(db.reads[`eft_pool/${key}`].used.storeId, "concrete");
  assert.equal((await rejects(settle("C-2"), "failed-precondition")).details.code, "already-used");
});
