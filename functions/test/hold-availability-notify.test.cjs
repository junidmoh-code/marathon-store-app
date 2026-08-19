// ─── HOLD AVAILABILITY NOTIFY — the six proofs ───────────────────────────────
// Run: cd functions && node --test test/hold-availability-notify.test.cjs
// Mutation-proven by scripts/mutation-proof-hold-notify.mjs — every guard below
// is deleted in turn and this suite must go red, or the guard proves nothing.
//
// The failure this suite exists to prevent: a previous version of this
// notification sent the same message 2-5 times to real customers and got the
// gateway number banned. So the properties pinned here are not "does it send"
// but "how many, and on what". One customer, one message.

const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { notifyHoldAvailability, TEMPLATE } = require("../lib/hold-availability-notify.cjs");

const NOW = "2026-08-19T09:00:00.000Z";

// ── Fake RTDB ────────────────────────────────────────────────────────────────
// Models exactly what the notifier uses: ref().get(), ref().child().update(),
// and ref().transaction() with CLOUD-FUNCTION COLD-CACHE semantics — the update
// fn is invoked FIRST with null (an empty local cache), and only if that
// returns a value is it re-run against the real server value (the CAS re-run).
// A fake that fed the server value first would never exercise the polarity the
// claim depends on.
// `frozenReads` models two invocations that BOTH read the record before either
// wrote: every get() returns the record as it was at construction. That takes
// the cheap pre-check out of play so the create-once claim is the only thing
// left that can separate them.
function fakeDb(initial, { frozenReads = false, failUpdate = null } = {}) {
  const state = structuredClone(initial);
  const frozen = structuredClone(initial);
  const node = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), state);
  const setNode = (path, value) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    let n = state;
    for (const k of parts) { n[k] = n[k] ?? {}; n = n[k]; }
    if (value === null) delete n[last]; else n[last] = value;
  };

  const api = {
    state,
    transactionAttempts: 0,
    transactionPasses: 0,   // invocations of the UPDATE FN — the cold pass and the CAS re-run
    ref(path) {
      const self = {
        child: (c) => api.ref(`${path}/${c}`),
        async get() {
          const src = frozenReads
            ? path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), frozen)
            : node(path);
          return { val: () => (src === undefined ? null : src) };
        },
        async update(patch) {
          if (failUpdate && failUpdate(path, patch)) throw new Error("update refused");
          for (const [k, v] of Object.entries(patch)) setNode(`${path}/${k}`, v);
        },
        async transaction(fn) {
          api.transactionAttempts++;
          // Pass 1: the COLD local cache — always null in a Cloud Function.
          api.transactionPasses++;
          const cold = fn(null);
          if (cold === undefined) return { committed: false, snapshot: { val: () => node(path) ?? null } };
          // Pass 2: the CAS re-run against the real server value.
          const live = node(path);
          api.transactionPasses++;
          const hot = fn(live === undefined ? null : live);
          if (hot === undefined) return { committed: false, snapshot: { val: () => (live === undefined ? null : live) } };
          setNode(path, hot);
          return { committed: true, snapshot: { val: () => hot } };
        },
      };
      return self;
    },
  };
  return api;
}

function spy(impl) {
  const calls = [];
  const fn = async (arg) => { calls.push(arg); return impl ? impl(arg) : { success: true, outboxId: `ob${calls.length}`, status: "pending" }; };
  fn.calls = calls;
  return fn;
}

// A FULFILLED hold line: the shape onHoldRefillPlan writes, plus the
// fulfilledBy stamp the Fulfil action writes atomically with the status.
const holdRequest = (over = {}) => ({
  productId: "p1778841820730",
  size: "9",
  qty: 1,
  requestingLocation: "hub2",
  status: "fulfilled",
  createdAt: "2026-08-18T14:00:00.000Z",
  createdFrom: { manual: true, source: "central", via: "on_hold", orderId: "042", orderDate: "2026-08-18" },
  fulfilledBy: { movementId: "rrf_onhold_2026-08-18_042", qty: 1 },
  resolvedAt: NOW,
  holdLink: {
    orderId: "042", orderDate: "2026-08-18", customerId: "c0821234567",
    customerName: "Thandi", customerPhone: "0821234567", notifyOnFulfil: true,
  },
  ...over,
});

// An ENGINE / sale-driven line — the overwhelming majority of the queue. Same
// row, same actions, same movement shapes; no customer behind it.
const plainRequest = (over = {}) => ({
  productId: "p1778841820730",
  size: "9",
  qty: 2,
  requestingLocation: "hub2",
  status: "fulfilled",
  createdAt: "2026-08-18T14:00:00.000Z",
  createdFrom: { source: "engine" },
  fulfilledBy: { movementId: "rrf_r777", qty: 2 },
  resolvedAt: NOW,
  ...over,
});

const drive = (db, enqueue, { requestId = "onhold_2026-08-18_042", before = "open", after = "fulfilled" } = {}) =>
  notifyHoldAvailability({ db, enqueueWhatsApp: enqueue, requestId, before, after, nowIso: NOW });

// ── 1 · A NON-HOLD LINE FULFILS AND SENDS NOTHING ────────────────────────────
test("1 · an ordinary refill line fulfils and nobody is messaged", async () => {
  const db = fakeDb({ refill_requests: { r777: plainRequest() } });
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "r777" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "not_hold_origin");
});

test("1b · a hold line whose flag was never armed (no phone) sends nothing", async () => {
  const db = fakeDb({ refill_requests: { h: holdRequest({
    holdLink: { orderId: "042", customerName: "Thandi", customerPhone: null, notifyOnFulfil: false },
  }) } });
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "h" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "not_hold_origin");
});

test("1c · an ARMED hold with no phone still sends nothing", async () => {
  // onHoldRefill arms the flag only when a phone exists, but the send must not
  // depend on that staying true — a later edit arming the flag without a number
  // would otherwise hand the producer an empty recipient. (CodeRabbit #385.)
  const db = fakeDb({ refill_requests: { h: holdRequest({
    holdLink: { orderId: "042", customerName: "Thandi", customerPhone: "", notifyOnFulfil: true },
  }) } });
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "h" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "no_phone");
});

// ── 2 · A HOLD-ORIGIN LINE FULFILS AND ENQUEUES EXACTLY ONE ──────────────────
test("2 · a hold line fulfils and enqueues exactly one now-available message", async () => {
  const db = fakeDb({ refill_requests: { "onhold_2026-08-18_042": holdRequest() } });
  const enqueue = spy();
  const res = await drive(db, enqueue);

  assert.equal(res.sent, true);
  assert.equal(enqueue.calls.length, 1, "exactly one enqueue");
  assert.deepEqual(enqueue.calls[0], {
    templateName: "order_ready",              // the now-available variant
    recipientPhone: "0821234567",
    templateParams: ["Thandi", "042"],
  });
  // The record now says so, durably — this is what stops a second send.
  const link = db.state.refill_requests["onhold_2026-08-18_042"].holdLink;
  assert.equal(link.notifiedAt, NOW);
  assert.equal(link.notifyOutboxId, "ob1");
  assert.equal(link.notifyTemplate, "order_ready");
});

test("2b · a nameless customer still gets a message, addressed 'there'", async () => {
  const db = fakeDb({ refill_requests: { h: holdRequest({
    holdLink: { orderId: "042", customerName: null, customerPhone: "0821234567", notifyOnFulfil: true },
  }) } });
  const enqueue = spy();
  await drive(db, enqueue, { requestId: "h" });
  assert.deepEqual(enqueue.calls[0].templateParams, ["there", "042"]);
});

test("2c · BOTH LEGS SAY THE SAME THING — the template is registered with this arity", () => {
  // The gateway leg sends renderedText and the Meta leg sends templateName +
  // variables, and BOTH are produced from the one TEMPLATE_BODIES entry — so
  // they can only diverge if the entry stops existing or changes arity, which
  // is exactly what this pins. renderWhatsAppText refuses a wrong param count
  // outright, so a drifted arity would fail the send loudly rather than ship a
  // broken message.
  const src = readFileSync(join(__dirname, "..", "index.js"), "utf8");
  assert.equal(TEMPLATE, "order_ready");
  assert.match(src, /order_ready:\s*\{\s*params:\s*2,/);
  assert.match(src, /is ready to collect at Marathon Club/);
  // …and the producer's dedupe window is the SAME constant this notifier bets a
  // customer's message on, not a second copy of the number (CodeRabbit #385).
  assert.match(src, /const DEDUPE_WINDOW_MS = WHATSAPP_DEDUPE_WINDOW_MS;/);
  assert.equal(require("../lib/whatsapp-dedupe.cjs").WHATSAPP_DEDUPE_WINDOW_MS, 90 * 1000);
});

// ── 3 · DOUBLE-TAP FULFIL ENQUEUES ONE, NOT TWO ──────────────────────────────
test("3 · a double-tap fulfil enqueues one, not two", async () => {
  const db = fakeDb({ refill_requests: { h: holdRequest() } });
  const enqueue = spy();
  const a = await drive(db, enqueue, { requestId: "h" });
  const b = await drive(db, enqueue, { requestId: "h" });   // the second tap's write
  assert.equal(a.sent, true);
  assert.equal(b.sent, false);
  assert.equal(b.skipped, "already_handled");
  assert.equal(enqueue.calls.length, 1);
});

test("3b · two invocations racing the SAME write: only the claim winner sends", async () => {
  // frozenReads: BOTH invocations read the record before either wrote, so the
  // cheap already-handled pre-check cannot separate them. The create-once claim
  // is the only guard left standing — and it is the one that has to hold, since
  // in production two trigger deliveries can genuinely overlap.
  const db = fakeDb({ refill_requests: { h: holdRequest() } }, { frozenReads: true });
  const enqueue = spy();
  const [a, b] = await Promise.all([
    drive(db, enqueue, { requestId: "h" }),
    notifyHoldAvailability({
      db, enqueueWhatsApp: enqueue, requestId: "h", before: "open", after: "fulfilled",
      nowIso: "2026-08-19T09:00:00.001Z",       // a different clock — a different claim value
    }),
  ]);
  assert.equal(enqueue.calls.length, 1, "one message, whichever invocation won");
  assert.equal([a.sent, b.sent].filter(Boolean).length, 1);
  assert.ok([a.skipped, b.skipped].includes("already_claimed"),
    `the CLAIM must be what refuses the loser, got ${JSON.stringify([a.skipped, b.skipped])}`);
});

test("3c · a redelivered trigger event (fulfilled → fulfilled) is not a fulfil", async () => {
  const db = fakeDb({ refill_requests: { h: holdRequest() } });
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "h", before: "fulfilled", after: "fulfilled" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "no_transition");
});

// ── 4 · OUT OF STOCK SENDS NOTHING ───────────────────────────────────────────
test("4 · Out of Stock on a hold line sends nothing", async () => {
  // rejectRequest writes status "cancelled" with NO cancelReason — the human ✕.
  const db = fakeDb({ refill_requests: { h: holdRequest({
    status: "cancelled", fulfilledBy: undefined, rejectedBy: "store",
  }) } });
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "h", before: "open", after: "cancelled" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "not_fulfilled");
});

test("4b · a withdrawn hold (hold_released) sends nothing", async () => {
  const db = fakeDb({ refill_requests: { h: holdRequest({
    status: "cancelled", fulfilledBy: undefined, cancelReason: "hold_released",
  }) } });
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "h", before: "open", after: "cancelled" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "not_fulfilled");
});

// ── 5 · NOTHING CAN ENQUEUE THIS MESSAGE WITHOUT A FULFIL ────────────────────
test("5 · no status other than a fresh 'fulfilled' can enqueue anything", async () => {
  for (const [before, after] of [
    [null, "open"], ["open", "open"], ["open", "cancelled"], ["cancelled", "open"],
    ["open", null], ["fulfilled", "open"], ["fulfilled", "cancelled"],
  ]) {
    const db = fakeDb({ refill_requests: { h: holdRequest() } });
    const enqueue = spy();
    const res = await drive(db, enqueue, { requestId: "h", before, after });
    assert.equal(enqueue.calls.length, 0, `before=${before} after=${after} must send nothing`);
    assert.equal(res.skipped, "not_fulfilled");
  }
});

test("5b · a status flip with NO fulfilment record behind it messages nobody", async () => {
  // fulfilledBy is written in the SAME multi-path update as the status by both
  // fulfil writers. Its absence means something set the status without moving
  // stock — a hand edit, a migration, a bug. No stock, no message.
  const db = fakeDb({ refill_requests: { h: holdRequest({ fulfilledBy: undefined }) } });
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "h" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "no_fulfilment_record");
});

test("5c · an event whose record moved on before we read it messages nobody", async () => {
  const db = fakeDb({ refill_requests: { h: holdRequest({ status: "cancelled" }) } });
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "h" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "status_moved");
});

test("5d · a deleted request messages nobody", async () => {
  const db = fakeDb({ refill_requests: {} });
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "h" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "request_gone");
});

// ── 6 · THE MERGED-LINE RULE ─────────────────────────────────────────────────
// One line, 2 units, one from a sale and one from a hold. The rule: notify on
// the hold's OWN line reaching `fulfilled`, and only then — never on a tranche,
// never off a neighbouring row.
test("6a · a PARTIAL send does not notify — the line is still open", async () => {
  // The picker sent 1 of 2. fulfilRequest deducts qty and accumulates sentQty;
  // status stays "open", so the status leaf never changes and the trigger never
  // even wakes. Driven here as the trigger would see it, and again with the
  // status forced, to prove neither route notifies a half-kept promise.
  const partial = holdRequest({ qty: 1, sentQty: 1, status: "open", fulfilledBy: undefined, resolvedAt: undefined });
  const db = fakeDb({ refill_requests: { h: partial } });
  const enqueue = spy();
  assert.equal((await drive(db, enqueue, { requestId: "h", before: "open", after: "open" })).skipped, "not_fulfilled");
  assert.equal((await drive(db, enqueue, { requestId: "h" })).skipped, "status_moved");
  assert.equal(enqueue.calls.length, 0);
});

test("6b · the WHOLE line landing notifies exactly once — not once per unit", async () => {
  const merged = holdRequest({ qty: 2, fulfilledBy: { movementId: "rrf_h", qty: 2, totalQty: 2 } });
  const db = fakeDb({ refill_requests: { h: merged } });
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "h" });
  assert.equal(res.sent, true);
  assert.equal(enqueue.calls.length, 1, "one line, one customer, one message");
});

test("6c · a NEIGHBOURING line for the same product+size notifies nobody", async () => {
  // The hold's promise lives on its own row. A sale cell or engine request for
  // the same (product, size) is a DIFFERENT row: fulfilling it moves stock and
  // messages no one, and it leaves the hold's row untouched and still open.
  const db = fakeDb({ refill_requests: {
    "onhold_2026-08-18_042": holdRequest({ status: "open", fulfilledBy: undefined, resolvedAt: undefined }),
    r777: plainRequest(),
  } });
  const enqueue = spy();
  await drive(db, enqueue, { requestId: "r777" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(db.state.refill_requests["onhold_2026-08-18_042"].status, "open");
  assert.ok(!db.state.refill_requests["onhold_2026-08-18_042"].holdLink.notifiedAt);

  // …and when the hold's OWN line is fulfilled later, it still notifies.
  db.state.refill_requests["onhold_2026-08-18_042"].status = "fulfilled";
  db.state.refill_requests["onhold_2026-08-18_042"].fulfilledBy = { movementId: "rrf_x", qty: 1 };
  const res = await drive(db, enqueue);
  assert.equal(res.sent, true);
  assert.equal(enqueue.calls.length, 1);
});

// ── FAILURE HANDLING ─────────────────────────────────────────────────────────
test("a refused phone number is TERMINAL — stamped, claim kept, never retried", async () => {
  const err = Object.assign(new Error("recipientPhone is not a usable phone number"), {
    code: "invalid-argument", details: { unusableRecipient: true },
  });
  const db = fakeDb({ refill_requests: { h: holdRequest() } });
  const enqueue = spy(() => { throw err; });
  const res = await drive(db, enqueue, { requestId: "h" });
  assert.equal(res.skipped, "unusable_recipient");
  const link = db.state.refill_requests.h.holdLink;
  assert.equal(link.notifyFailedAt, NOW);
  assert.equal(link.notifyClaimedAt, NOW, "the claim is KEPT so it can never loop");
  assert.ok(!link.notifiedAt);

  // A redelivery must not try again.
  const enqueue2 = spy();
  assert.equal((await drive(db, enqueue2, { requestId: "h" })).skipped, "already_handled");
  assert.equal(enqueue2.calls.length, 0);
});

test("a TRANSIENT failure releases the claim, rethrows, and retries to exactly one send", async () => {
  const db = fakeDb({ refill_requests: { h: holdRequest() } });
  let fail = true;
  const enqueue = spy(() => {
    if (fail) throw Object.assign(new Error("Could not enqueue WhatsApp message"), { code: "internal" });
    return { success: true, outboxId: "ob-retry", status: "pending" };
  });
  await assert.rejects(() => drive(db, enqueue, { requestId: "h" }), /Could not enqueue/);
  const link = db.state.refill_requests.h.holdLink;
  assert.ok(!link.notifyClaimedAt, "the claim is RELEASED so a retry can take it");
  assert.ok(!link.notifiedAt);
  assert.match(link.notifyError, /Could not enqueue/);

  fail = false;
  const res = await drive(db, enqueue, { requestId: "h" });
  assert.equal(res.sent, true);
  assert.equal(db.state.refill_requests.h.holdLink.notifiedAt, NOW);
  assert.equal(enqueue.calls.length, 2, "one refused attempt, one that landed — one message");
});

test("a template-contract failure is NOT terminal — one bad deploy must not drop every hold", async () => {
  // invalid-argument WITHOUT details.unusableRecipient (e.g. a deploy changing
  // the template's param count). Broad matching here would silently retire
  // every hold notification on a single bad release.
  const err = Object.assign(new Error('Template "order_ready" expects 1 param(s) but got 2'), {
    code: "invalid-argument", details: undefined,
  });
  const db = fakeDb({ refill_requests: { h: holdRequest() } });
  const enqueue = spy(() => { throw err; });
  await assert.rejects(() => drive(db, enqueue, { requestId: "h" }));
  assert.ok(!db.state.refill_requests.h.holdLink.notifyFailedAt, "retryable, not retired");
  assert.ok(!db.state.refill_requests.h.holdLink.notifyClaimedAt);
});

// ── THE CLAIM'S COLD-CACHE POLARITY ──────────────────────────────────────────
test("the claim survives the cold local cache a Cloud Function starts with", async () => {
  const db = fakeDb({ refill_requests: { h: holdRequest() } });
  const enqueue = spy();
  await drive(db, enqueue, { requestId: "h" });
  // The fake runs the body against null FIRST and only then against the server
  // value; a body that aborted on the cold null would never reach the server
  // and no message would ever send. Two passes is the proof it did.
  assert.equal(db.transactionPasses, 2,
    "the body survived the cold null and re-ran against the server value");
  assert.equal(db.state.refill_requests.h.holdLink.notifyClaimedAt, NOW);
  assert.equal(enqueue.calls.length, 1);
});

// ── AN INVOCATION THAT DIED MID-FLIGHT (CodeRabbit #385) ─────────────────────
// notifyClaimedAt set, nothing resolved: an earlier run claimed and was killed
// without recording whether the enqueue landed. Nothing on the record can say
// which, so the age of the claim decides — and only because the producer's own
// 90s dedupe makes one of the two answers provably harmless.
const LATER = (ms) => new Date(Date.parse(NOW) + ms).toISOString();

test("a claim younger than the producer's dedupe window RESUMES — the producer collapses the double", async () => {
  const db = fakeDb({ refill_requests: { h: holdRequest({
    holdLink: { orderId: "042", customerName: "Thandi", customerPhone: "0821234567",
                notifyOnFulfil: true, notifyClaimedAt: NOW },
  }) } });
  const enqueue = spy();
  const res = await notifyHoldAvailability({
    db, enqueueWhatsApp: enqueue, requestId: "h", before: "open", after: "fulfilled",
    nowIso: LATER(30 * 1000),
  });
  assert.equal(res.sent, true, "inside the window a resend is safe — the producer dedupes it");
  assert.equal(enqueue.calls.length, 1);
});

test("a claim PAST the dedupe window refuses to send, and says so on the record", async () => {
  // Past 90s the producer can no longer collapse a duplicate, so a resend could
  // be the SECOND message to a real customer. A missed notification is
  // recoverable by a human; a banned gateway number is not. Bias to silence.
  const db = fakeDb({ refill_requests: { h: holdRequest({
    holdLink: { orderId: "042", customerName: "Thandi", customerPhone: "0821234567",
                notifyOnFulfil: true, notifyClaimedAt: NOW },
  }) } });
  const enqueue = spy();
  const res = await notifyHoldAvailability({
    db, enqueueWhatsApp: enqueue, requestId: "h", before: "open", after: "fulfilled",
    nowIso: LATER(10 * 60 * 1000),
  });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "claim_unresolved");
  assert.equal(db.state.refill_requests.h.holdLink.notifyUnresolvedAt, LATER(10 * 60 * 1000));
});

test("ENQUEUED-but-unstamped never releases the claim, so a later retry cannot resend", async () => {
  // The 2-5 copies incident in miniature: the enqueue lands, the bookkeeping
  // write fails, and a compensating claim release would let the retry send a
  // second message once the dedupe window lapsed.
  const db = fakeDb(
    { refill_requests: { h: holdRequest() } },
    { failUpdate: (path, patch) => path.endsWith("holdLink") && "notifiedAt" in patch },
  );
  const enqueue = spy();
  const res = await drive(db, enqueue, { requestId: "h" });
  assert.equal(res.sent, true);
  assert.equal(enqueue.calls.length, 1);
  const link = db.state.refill_requests.h.holdLink;
  assert.equal(link.notifyClaimedAt, NOW, "the claim is KEPT — a message was enqueued");
  assert.ok(!link.notifiedAt, "and the stamp genuinely did not land");

  // A retry well past the dedupe window must not send a second copy.
  const res2 = await notifyHoldAvailability({
    db, enqueueWhatsApp: enqueue, requestId: "h", before: "open", after: "fulfilled",
    nowIso: LATER(10 * 60 * 1000),
  });
  assert.equal(res2.skipped, "claim_unresolved");
  assert.equal(enqueue.calls.length, 1, "still one message");
});
