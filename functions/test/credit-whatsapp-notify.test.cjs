// ─── STORE CREDIT WHATSAPP — the proofs ──────────────────────────────────────
// Run: cd functions && npm test -- test/credit-whatsapp-notify.test.cjs
const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const C = require("../lib/credit-whatsapp-notify.cjs");
const { deliverOutboxDoc } = require("../lib/outbox-deliver.cjs");

const NOW = Date.parse("2026-11-25T10:00:00.000Z");
const tpl = (status) => async () => ({ data: [{ name: "store_credit_issued", language: "en", status, category: "UTILITY" }] });
const APPROVED = tpl("APPROVED");
const PENDING = tpl("PENDING");
const quiet = { log() {}, warn() {}, error() {} };

// ── Fake RTDB ────────────────────────────────────────────────────────────────
// get / update / remove / transaction (Cloud Function cold-cache semantics: the
// fn runs against null first, then the server value) and the one query the
// sweep makes: orderByKey().limitToFirst(n).get(). Like the real thing,
// writing null, an empty object or an EMPTY ARRAY removes the key, and an
// emptied parent goes with it.
function fakeDb(initial, { failTransactionFor = null } = {}) {
  const state = structuredClone(initial);
  const at = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), state);
  const isEmpty = (v) => v && typeof v === "object" && (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
  const setAt = (path, value) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    const chain = [state];
    let n = state;
    for (const k of parts) { n[k] = n[k] ?? {}; n = n[k]; chain.push(n); }
    if (value == null || isEmpty(value)) delete n[last]; else n[last] = structuredClone(value);
    for (let i = chain.length - 1; i > 0; i--) if (Object.keys(chain[i]).length === 0) delete chain[i - 1][parts[i - 1]];
  };
  const reads = [];
  return {
    state, reads,
    ref(path) {
      return {
        async get() { reads.push(path); const v = at(path); return { val: () => (v === undefined ? null : structuredClone(v)) }; },
        async update(patch) { for (const [k, v] of Object.entries(patch)) setAt(`${path}/${k}`, v); },
        async remove() { setAt(path, null); },
        async transaction(fn) {
          if (failTransactionFor && failTransactionFor(path)) throw new Error("transaction refused");
          const cold = fn(null);
          if (cold === undefined) return { committed: false, snapshot: { val: () => at(path) ?? null } };
          const cur = at(path) ?? null;
          const next = fn(cur == null ? null : structuredClone(cur));
          if (next === undefined) return { committed: false, snapshot: { val: () => structuredClone(cur) } };
          setAt(path, next);
          return { committed: true, snapshot: { val: () => structuredClone(at(path)) } };
        },
        orderByKey() {
          return { limitToFirst(n) {
            return { async get() {
              reads.push(`${path}?orderBy=$key&limitToFirst=${n}`);
              const keys = Object.keys(at(path) || {}).sort().slice(0, n);
              return { forEach: (cb) => keys.forEach((key) => cb({ key })) };
            } };
          } };
        },
      };
    },
  };
}

const JAFER = "uidJaferTill";
const users = {
  [JAFER]: { posAccess: { isActive: true, role: "returnsOnly", creditWhatsApp: true, storeIds: ["concrete"] } },
  uidAmanda: { posAccess: { isActive: true, role: "cashier", storeIds: ["concrete"] } },
  uidFlagCashier: { posAccess: { isActive: true, role: "cashier", creditWhatsApp: true } },
  uidOtherDesk: { posAccess: { isActive: true, role: "returnsOnly" } },
  uidOffDesk: { posAccess: { isActive: false, role: "returnsOnly", creditWhatsApp: true } },
};
const entry = (over = {}) => ({
  ledgerId: "LT1", customerId: "0821234567", phone: "+27821234567", firstName: "Thandi",
  amountCents: 125000, storeName: "Concrete", customerCode: "C-2291", createdAt: NOW - 1000, createdByUid: JAFER, ...over,
});
const ledger = (cust, id, over = {}) => ({ [cust]: { txns: { [id]: { txnId: id, amount: 125000, kind: "credit", source: "refund", staffUid: JAFER, ...over } } } });
const world = ({ queue = { q1: entry() }, led = ledger("0821234567", "LT1"), extraUsers = {} } = {}) =>
  fakeDb({ users: { ...users, ...extraUsers }, pos: { credit_whatsapp_queue: queue, creditLedger: led } });

function producer({ fail = null } = {}) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    if (fail) { const e = fail(req, calls.length); if (e) throw e; }
    return { success: true, outboxId: `ob${calls.length}` };
  };
  fn.calls = calls;
  return fn;
}
const notify = (db, enq, queueId = "q1", fetchTemplates = APPROVED, nowMs = NOW) =>
  C.notifyOne({ db, enqueueWhatsApp: enq, fetchTemplates, queueId, nowMs, log: quiet });
const sweep = (db, enq, fetchTemplates = APPROVED, nowMs = NOW) =>
  C.runSweep({ db, enqueueWhatsApp: enq, fetchTemplates, nowMs, log: quiet });

// ── Jafer Till sends; nobody else does ──────────────────────────────────────
test("a Jafer Till credit sends ONE store_credit_issued: name, R-amount, store, code, barcode button", async () => {
  const db = world();
  const enq = producer();
  const r = await notify(db, enq);
  assert.equal(r.outcome, "sent");
  assert.deepEqual(enq.calls, [{
    templateName: "store_credit_issued", recipientPhone: "+27821234567",
    templateParams: ["Thandi", "1,250", "Concrete", "C-2291"], buttonUrlParam: "2291",
  }]);
  assert.equal(db.state.pos.credit_whatsapp_queue, undefined, "the settled entry leaves the queue");
  assert.equal(db.state.pos.credit_whatsapp_sent.LT1.notifiedAt, new Date(NOW).toISOString());
  assert.equal(db.state.pos.credit_whatsapp_sent.LT1.outboxId, "ob1");
});

for (const [who, uid] of [
  ["an ordinary cashier", "uidAmanda"],
  ["a cashier record carrying the flag (role is not returns-only)", "uidFlagCashier"],
  ["another returns-only login without the flag", "uidOtherDesk"],
  ["the returns desk, deactivated", "uidOffDesk"],
  ["a uid with no /users record", "uidNobody"],
]) {
  test(`${who}: nothing is sent and the entry is dropped`, async () => {
    const db = world({ queue: { q1: entry({ createdByUid: uid }) }, led: ledger("0821234567", "LT1", { staffUid: uid }) });
    const enq = producer();
    const r = await notify(db, enq);
    assert.equal(r.outcome, "dropped");
    assert.equal(r.reason, "creator_not_allowed");
    assert.equal(enq.calls.length, 0);
    assert.equal(db.state.pos.credit_whatsapp_queue, undefined);
    assert.equal(db.state.pos.credit_whatsapp_sent, undefined, "no claim is ever written for a refused creator");
  });
}

test("the creator check runs before any ledger read or claim", async () => {
  const db = world({ queue: { q1: entry({ createdByUid: "uidAmanda" }) } });
  await notify(db, producer());
  assert.ok(!db.reads.some((p) => p.startsWith("pos/creditLedger") || p.startsWith("pos/credit_whatsapp_sent")), db.reads.join(", "));
});

// ── The credit must be real ──────────────────────────────────────────────────
test("no ledger write → nothing sent, the entry waits (offline till still syncing)", async () => {
  const db = world({ led: {} });
  const enq = producer();
  const r = await notify(db, enq);
  assert.equal(r.outcome, "queued");
  assert.equal(r.reason, "ledger_not_yet_written");
  assert.equal(enq.calls.length, 0);
  assert.ok(db.state.pos.credit_whatsapp_queue.q1);
  assert.equal(db.state.pos.credit_whatsapp_sent, undefined);
});

test("the ledger write lands later → the sweep sends it then, once", async () => {
  const db = world({ led: {} });
  const enq = producer();
  await sweep(db, enq);
  assert.equal(enq.calls.length, 0);
  db.state.pos.creditLedger = ledger("0821234567", "LT1");
  await sweep(db, enq);
  await sweep(db, enq);
  assert.equal(enq.calls.length, 1);
});

test("a ledger write that never lands is dropped after 7 days, unsent", async () => {
  const db = world({ led: {} });
  const enq = producer();
  const r = await notify(db, enq, "q1", APPROVED, NOW + C.MAX_AGE_MS + 5000);
  assert.equal(r.reason, "ledger_never_landed");
  assert.equal(enq.calls.length, 0);
  assert.equal(db.state.pos.credit_whatsapp_queue, undefined);
});

for (const [why, over] of [
  ["a different amount", { amount: 5000 }],
  ["a redemption, not a credit", { kind: "redeem", amount: 125000 }],
  ["written by another login", { staffUid: "uidAmanda" }],
]) {
  test(`a ledger txn with ${why} → refused, never sent`, async () => {
    const db = world({ led: ledger("0821234567", "LT1", over) });
    const enq = producer();
    const r = await notify(db, enq);
    assert.equal(r.reason, "ledger_mismatch");
    assert.equal(enq.calls.length, 0);
  });
}

// ── One credit, one message ──────────────────────────────────────────────────
test("two entries for the same ledgerId (a retried push) → one message", async () => {
  const db = world({ queue: { q1: entry(), q2: entry() } });
  const enq = producer();
  await notify(db, enq, "q1");
  await notify(db, enq, "q2");
  await sweep(db, enq);
  assert.equal(enq.calls.length, 1);
  assert.equal(db.state.pos.credit_whatsapp_queue, undefined, "the duplicate is cleared against the settled claim");
});

test("the trigger and the sweep on the same entry → one message", async () => {
  const db = world();
  const enq = producer();
  await Promise.all([notify(db, enq), sweep(db, enq)]);
  await sweep(db, enq);
  assert.equal(enq.calls.length, 1);
});

test("a claim in flight is never taken over and its entry is left for the owner", async () => {
  const db = world();
  db.state.pos.credit_whatsapp_sent = { LT1: { ledgerId: "LT1", queueId: "q0", claimedAt: "2026-11-24T00:00:00.000Z" } };
  const enq = producer();
  const r = await notify(db, enq);
  assert.equal(r.reason, "claimed_in_flight");
  assert.equal(enq.calls.length, 0);
  assert.ok(db.state.pos.credit_whatsapp_queue.q1);
});

test("a transient enqueue failure releases the claim, keeps the entry, and the next sweep sends once", async () => {
  const db = world();
  let first = true;
  const enq = producer({ fail: () => { if (first) { first = false; return new Error("firestore down"); } return null; } });
  const r = await notify(db, enq);
  assert.equal(r.outcome, "failed");
  assert.equal(db.state.pos.credit_whatsapp_sent, undefined, "claim released");
  assert.ok(db.state.pos.credit_whatsapp_queue.q1, "entry kept");
  await sweep(db, enq);
  await sweep(db, enq);
  assert.equal(enq.calls.length, 2, "one failed attempt + one send");
  assert.ok(db.state.pos.credit_whatsapp_sent.LT1.notifiedAt);
});

test("the sweep throws after the run when an entry failed transiently (red in logs), others still go", async () => {
  const db = world({ queue: { q1: entry(), q2: entry({ ledgerId: "LT2" }) }, led: { "0821234567": { txns: { ...ledger("0821234567", "LT1")["0821234567"].txns, ...ledger("0821234567", "LT2")["0821234567"].txns } } } });
  const enq = producer({ fail: (req, n) => (n === 1 ? new Error("blip") : null) });
  await assert.rejects(sweep(db, enq), /1 entry failed/);
  assert.equal(enq.calls.length, 2);
  assert.ok(db.state.pos.credit_whatsapp_sent.LT2.notifiedAt);
});

test("a failed claim transaction sends nothing and keeps the entry", async () => {
  const db = fakeDb({ users, pos: { credit_whatsapp_queue: { q1: entry() }, creditLedger: ledger("0821234567", "LT1") } }, { failTransactionFor: (p) => p.includes("credit_whatsapp_sent") });
  const enq = producer();
  const r = await notify(db, enq);
  assert.equal(r.outcome, "failed");
  assert.equal(enq.calls.length, 0);
  assert.ok(db.state.pos.credit_whatsapp_queue.q1);
});

test("an unusable recipient at the producer is terminal: claim stamped failed, entry cleared, never retried", async () => {
  const db = world();
  const err = Object.assign(new Error("recipientPhone is not a usable phone number"), { code: "invalid-argument", details: { unusableRecipient: true } });
  const enq = producer({ fail: () => err });
  const r = await notify(db, enq);
  assert.equal(r.reason, "unusable_recipient");
  assert.ok(db.state.pos.credit_whatsapp_sent.LT1.failedAt);
  assert.equal(db.state.pos.credit_whatsapp_queue, undefined);
  await sweep(db, enq);
  assert.equal(enq.calls.length, 1);
});

// ── Template approval ────────────────────────────────────────────────────────
test("template still PENDING → the entry stays queued; the run after approval sends it, once", async () => {
  const db = world();
  const enq = producer();
  assert.equal((await notify(db, enq, "q1", PENDING)).outcome, "queued");
  const s1 = await sweep(db, enq, PENDING);
  assert.equal(s1.approved, false);
  assert.equal(enq.calls.length, 0);
  assert.equal(db.state.pos.credit_whatsapp_sent, undefined, "nothing claimed while unapproved");
  assert.ok(db.state.pos.credit_whatsapp_queue.q1);
  const s2 = await sweep(db, enq, APPROVED);
  assert.equal(s2.counts.sent, 1);
  await sweep(db, enq, APPROVED);
  assert.equal(enq.calls.length, 1);
});

test("an unapproved sweep reads nothing past the template status", async () => {
  const db = world();
  await sweep(db, producer(), PENDING);
  assert.deepEqual(db.reads, []);
});

for (const [label, fetchTemplates] of [
  ["REJECTED", tpl("REJECTED")],
  ["missing", async () => ({ data: [] })],
  ["a Graph error", async () => ({ error: { message: "(#100) Missing Permission" } })],
  ["a thrown fetch", async () => { throw new Error("ETIMEDOUT"); }],
]) {
  test(`template ${label} → nothing sent`, async () => {
    const db = world();
    const enq = producer();
    await sweep(db, enq, fetchTemplates);
    await notify(db, enq, "q1", fetchTemplates);
    assert.equal(enq.calls.length, 0);
  });
}

test("the sweep reads the queue key-ordered and bounded, never the whole node", async () => {
  const db = world();
  await sweep(db, producer());
  assert.ok(db.reads.includes(`pos/credit_whatsapp_queue?orderBy=$key&limitToFirst=${C.SWEEP_LIMIT}`));
  assert.ok(!db.reads.includes("pos/credit_whatsapp_queue"));
  assert.ok(!db.reads.some((p) => p === "pos/creditLedger" || p === "users" || p === "pos/credit_whatsapp_sent"));
});

// ── Shapes ───────────────────────────────────────────────────────────────────
test("formatRand: R1,250 style, cents only when present", () => {
  assert.equal(C.formatRand(125000), "1,250");
  assert.equal(C.formatRand(125050), "1,250.50");
  assert.equal(C.formatRand(99), "0.99");
  assert.equal(C.formatRand(123456789), "1,234,567.89");
  assert.equal(C.formatRand(0), null);
  assert.equal(C.formatRand(-500), null);
  assert.equal(C.formatRand(12.5), null);
});

for (const [why, over, reason] of [
  ["a landline", { phone: "+27215551234" }, "unusable_recipient"],
  ["a local-format phone", { phone: "0821234567" }, "unusable_recipient"],
  ["no customer code", { customerCode: null }, "bad_customer_code"],
  ["a zero amount", { amountCents: 0 }, "bad_amount"],
  ["no ledger id", { ledgerId: "" }, "bad_ledger_id"],
  ["a path in the customer id", { customerId: "a/b" }, "bad_customer"],
]) {
  test(`an entry with ${why} is dropped unsent (${reason})`, async () => {
    const db = world({ queue: { q1: entry(over) } });
    const enq = producer();
    const r = await notify(db, enq);
    assert.equal(r.reason, reason);
    assert.equal(enq.calls.length, 0);
  });
}

// ── The template contract stays in one piece ────────────────────────────────
test("the docs template JSON, the producer's TEMPLATE_BODIES entry and the module agree", () => {
  const json = JSON.parse(readFileSync(join(__dirname, "../../docs/meta-templates/store_credit_issued.json"), "utf8"));
  assert.equal(json.name, C.TEMPLATE);
  assert.equal(json.language, C.TEMPLATE_LANGUAGE);
  assert.equal(json.category, "UTILITY");
  const body = json.components.find((c) => c.type === "BODY");
  const index = readFileSync(join(__dirname, "../index.js"), "utf8");
  const m = /store_credit_issued:\s*\{\s*params:\s*4,\s*button:\s*true,\s*render:\s*\(p\)\s*=>\s*`([^`]*)`/.exec(index);
  assert.ok(m, "TEMPLATE_BODIES.store_credit_issued (4 params + button) is in functions/index.js");
  const rendered = m[1].replace(/\$\{p\[(\d)\]\}/g, (_x, i) => `{{${+i + 1}}}`);
  assert.equal(rendered, body.text);
  assert.equal(body.example.body_text[0].length, 4);
  assert.doesNotMatch(body.text, /refund/i, "no mention of refunds");
  assert.doesNotMatch(body.text, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emojis");
  const btn = json.components.find((c) => c.type === "BUTTONS").buttons[0];
  assert.equal(btn.type, "URL");
  assert.equal(btn.url, "https://marathon-pos.web.app/code/{{1}}");
  assert.deepEqual(C.templateRequest(entry()).buttonUrlParam, "2291");
});

test("the sendWhatsApp callable refuses store_credit_issued (only the notify functions send it)", () => {
  const index = readFileSync(join(__dirname, "../index.js"), "utf8");
  const callable = index.slice(index.indexOf("exports.sendWhatsApp = onCall("), index.indexOf("async function processFallbackDoc"));
  assert.match(callable, /request\.data\.templateName === CREDIT_WHATSAPP_TEMPLATE[\s\S]*permission-denied/);
  assert.ok(callable.indexOf("CREDIT_WHATSAPP_TEMPLATE") < callable.indexOf("return enqueueWhatsApp(request.data)"));
});

// ── The deliverer passes the button only for a button doc ───────────────────
function outboxDoc(data) {
  const doc = { data: { status: "pending", attempts: 0, ...data } };
  const docRef = { async update(f) { Object.assign(doc.data, f); } };
  const db = { async runTransaction(fn) { return fn({ get: async () => ({ exists: true, data: () => ({ ...doc.data }) }), update: (_r, f) => Object.assign(doc.data, f) }); } };
  return { doc, docRef, db };
}
for (const [label, data, expectArgs] of [
  ["a button template", { to: "+27821234567", templateName: "store_credit_issued", variables: ["A", "1", "B", "C-1"], buttonUrlParam: "1" }, 4],
  ["any other template", { to: "+27821234567", templateName: "order_ready", variables: ["A", "12"] }, 3],
]) {
  test(`deliverOutboxDoc: ${label} reaches the sender with ${expectArgs} arguments`, async () => {
    const { db, docRef } = outboxDoc(data);
    const seen = [];
    await deliverOutboxDoc({
      db, docRef, docId: "d1", maxAttempts: 2, maxInfraAttempts: 2, serverTimestamp: () => 0, maskPhone: () => "***", logPrefix: "t", log: quiet,
      sendTemplate: async (...args) => { seen.push(args); return { ok: true, messageId: "m1" }; },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].length, expectArgs);
    if (expectArgs === 4) assert.deepEqual(seen[0][3], { buttonUrlParam: "1" });
  });
}
