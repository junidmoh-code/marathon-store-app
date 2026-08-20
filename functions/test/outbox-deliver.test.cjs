// Duplicate-safety tests for the shared outbox delivery path
// (lib/outbox-deliver.cjs). Run: cd functions && node --test
//
// These pin the ONE invariant the instant-send trigger (outboxInstantSend)
// leans on: no matter how many claimers race one outbox doc — the instant
// trigger, a trigger RE-FIRE (Firestore create events are at-least-once), the
// every-minute sweep, an overlapping sweep run — the claim transaction lets
// exactly ONE of them send. Speeding delivery up must never mint a duplicate,
// so any change that makes these fail is a regression in the dedupe, not in
// the tests.
//
// Also pinned: the failure ladder (revert-to-pending below maxAttempts, then
// ONE retry send, terminal "failed" at the cap) and the quiet no-op on a
// deleted doc — both unchanged semantics inherited verbatim from the sweep-era
// processFallbackDoc.
const { test } = require("node:test");
const assert = require("node:assert");
const { deliverOutboxDoc } = require("../lib/outbox-deliver.cjs");

const SERVER_TS = { __serverTimestamp: true };
const maskPhone = (raw) => `***${String(raw).slice(-4)}`;
const quietLog = { log: () => {}, warn: () => {}, error: () => {} };

// ── Fake Firestore ───────────────────────────────────────────────────────────
// Models exactly what deliverOutboxDoc uses: runTransaction with tx.get/
// tx.update against a single doc, plus docRef.update. Transactions are
// serialised the way Firestore serialises writers on one doc: the update
// COMMITS atomically with the read (no interleaving inside a transaction),
// which is precisely the property the claim mutex depends on.
function fakeDoc(initialData) {
  const state = { data: initialData ? structuredClone(initialData) : null };
  const writes = [];
  const applyUpdate = (fields) => {
    assert.ok(state.data, "update on a missing doc should never happen");
    Object.assign(state.data, fields);
    writes.push(structuredClone(fields));
  };
  const docRef = { update: async (fields) => applyUpdate(fields) };
  const db = {
    runTransaction: async (fn) => fn({
      get: async (ref) => {
        assert.strictEqual(ref, docRef, "transaction must read the doc it claims");
        return { exists: !!state.data, data: () => structuredClone(state.data) };
      },
      update: (ref, fields) => { assert.strictEqual(ref, docRef); applyUpdate(fields); },
    }),
  };
  return { db, docRef, state, writes };
}

const pendingDoc = () => ({
  to: "+27821234567", templateName: "order_ready",
  variables: ["Amina", "017"], status: "pending", provider: null,
  attempts: 0, lastError: null,
});

const deliver = (fake, sendTemplate, overrides = {}) => deliverOutboxDoc({
  db: fake.db, docRef: fake.docRef, docId: "doc1",
  sendTemplate, maxAttempts: 2, serverTimestamp: () => SERVER_TS, maskPhone,
  log: quietLog, ...overrides,
});

test("pending doc → exactly one send, recorded as sent", async () => {
  const fake = fakeDoc(pendingDoc());
  const sends = [];
  await deliver(fake, async (to, name, params) => {
    sends.push({ to, name, params });
    return { ok: true, messageId: "wamid.1" };
  });
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0], { to: "+27821234567", name: "order_ready", params: ["Amina", "017"] });
  assert.equal(fake.state.data.status, "sent");
  assert.equal(fake.state.data.provider, "meta");
  assert.equal(fake.state.data.attempts, 1);
  assert.equal(fake.state.data.messageId, "wamid.1");
});

test("re-fire after a successful send does NOT send again", async () => {
  // Firestore delivers create events at-least-once: the trigger can run twice
  // for one enqueue. The second run must find "sent" and walk away.
  const fake = fakeDoc(pendingDoc());
  let sends = 0;
  const sender = async () => { sends++; return { ok: true, messageId: "wamid.1" }; };
  await deliver(fake, sender);
  const writesAfterFirst = fake.writes.length;
  await deliver(fake, sender);
  assert.equal(sends, 1, "the re-fire must not produce a second send");
  assert.equal(fake.writes.length, writesAfterFirst, "the re-fire must not write anything");
  assert.equal(fake.state.data.status, "sent");
});

test("doc already claimed by another worker (status sending) → no send, no writes", async () => {
  const fake = fakeDoc({ ...pendingDoc(), status: "sending", provider: "meta", attempts: 1 });
  let sends = 0;
  await deliver(fake, async () => { sends++; return { ok: true, messageId: "x" }; });
  assert.equal(sends, 0);
  assert.equal(fake.writes.length, 0);
});

test("trigger and sweep racing the same doc → one send total", async () => {
  // The instant trigger and the sweep both call this path. Firestore
  // serialises the two claim transactions; whichever commits second reads the
  // non-pending status the winner wrote. Interleave them the worst way the
  // serialisation allows: loser's transaction starts only after the winner's
  // claim committed, but BEFORE the winner's send finished.
  const fake = fakeDoc(pendingDoc());
  const sends = [];
  let releaseWinnerSend;
  const winnerGate = new Promise((r) => { releaseWinnerSend = r; });
  const winner = deliver(fake, async (to) => {
    await winnerGate;                      // hold mid-send: doc is "sending"
    sends.push(to);
    return { ok: true, messageId: "wamid.win" };
  });
  await new Promise((r) => setImmediate(r)); // let the winner claim
  assert.equal(fake.state.data.status, "sending", "winner must have claimed before the loser runs");
  await deliver(fake, async (to) => { sends.push(to); return { ok: true, messageId: "wamid.lose" }; });
  releaseWinnerSend();
  await winner;
  assert.equal(sends.length, 1, "two racing claimers must produce exactly one send");
  assert.equal(fake.state.data.messageId, "wamid.win");
  assert.equal(fake.state.data.status, "sent");
});

test("send failure below maxAttempts → reverted to pending for the sweep, never failed", async () => {
  const fake = fakeDoc(pendingDoc());
  await deliver(fake, async () => ({ ok: false, error: "network blip" }));
  assert.equal(fake.state.data.status, "pending");
  assert.equal(fake.state.data.provider, null);
  assert.equal(fake.state.data.attempts, 1);
  assert.equal(fake.state.data.lastError, "network blip");
});

test("reverted doc retried once by the sweep, then terminal failed at maxAttempts", async () => {
  const fake = fakeDoc(pendingDoc());
  let sends = 0;
  const failing = async () => { sends++; return { ok: false, error: "template paused" }; };
  await deliver(fake, failing);            // attempt 1 → revert
  await deliver(fake, failing);            // attempt 2 = maxAttempts → failed
  assert.equal(sends, 2);
  assert.equal(fake.state.data.status, "failed");
  assert.equal(fake.state.data.lastError, "template paused");
  // and a further claimer (late sweep, anything) must now be a no-op
  await deliver(fake, async () => { sends++; return { ok: true, messageId: "x" }; });
  assert.equal(sends, 2, "a failed doc must never be sent");
});

test("doc deleted before delivery → quiet no-op", async () => {
  const fake = fakeDoc(null);
  let sends = 0;
  await deliver(fake, async () => { sends++; return { ok: true, messageId: "x" }; });
  assert.equal(sends, 0);
  assert.equal(fake.writes.length, 0);
});

test("claim transaction throwing → no send, resolves quietly", async () => {
  const fake = fakeDoc(pendingDoc());
  const db = { runTransaction: async () => { throw new Error("firestore unavailable"); } };
  let sends = 0;
  await deliver({ ...fake, db }, async () => { sends++; return { ok: true, messageId: "x" }; });
  assert.equal(sends, 0);
  assert.equal(fake.state.data.status, "pending", "a failed claim must leave the doc for the sweep");
});

test("legacy templateParams field still honoured when variables is absent", async () => {
  const doc = pendingDoc();
  delete doc.variables;
  doc.templateParams = ["Sipho", "021"];
  const fake = fakeDoc(doc);
  const sends = [];
  await deliver(fake, async (to, name, params) => { sends.push(params); return { ok: true, messageId: "x" }; });
  assert.deepEqual(sends, [["Sipho", "021"]]);
});
