// ─── ORDER TOMORROW NOTIFY — the proofs ──────────────────────────────────────
// Run: cd functions && node --test test/order-tomorrow-notify.test.cjs
// Mutation-proven by scripts/mutation-proof-order-tomorrow.mjs — every guard
// below is deleted in turn and this suite must go red, or the guard proves
// nothing.
//
// This message was DEAD from 2026-08-08 to 2026-08-19: e115cde deleted the send
// and 892 messages a month went to zero. So the first property here is simply
// "it fires". The rest are the reason it now fires from a server trigger rather
// than the client fire-and-forget it used to be: a previous customer message in
// this codebase went out 2-5 times and got the gateway number banned. One
// order, one message, ever.

const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { notifyOrderTomorrow, TEMPLATE, STATE } = require("../lib/order-tomorrow-notify.cjs");
const { notifyHoldAvailability } = require("../lib/hold-availability-notify.cjs");

const NOW = "2026-08-19T09:00:00.000Z";

// ── Fake RTDB ────────────────────────────────────────────────────────────────
// The harness from hold-availability-notify.test.cjs, unchanged: ref().get(),
// ref().update(), and ref().transaction() with CLOUD-FUNCTION COLD-CACHE
// semantics — the update fn runs FIRST against null (an empty local cache), and
// only if that returns a value is it re-run against the real server value (the
// CAS re-run). A fake that fed the server value first would never exercise the
// polarity the claim depends on.
// `frozenReads` models two invocations that BOTH read the record before either
// wrote, taking the cheap pre-check out of play so the create-once claim is the
// only thing left that can separate them.
function fakeDb(initial, { frozenReads = false, failUpdate = null, failTransaction = null } = {}) {
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
    ref(path) {
      return {
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
          if (failTransaction && failTransaction(path)) throw new Error("claim write refused");
          api.transactionAttempts++;
          const cold = fn(null);                       // pass 1: the COLD local cache
          if (cold === undefined) return { committed: false, snapshot: { val: () => node(path) ?? null } };
          const live = node(path);                     // pass 2: the CAS re-run
          const hot = fn(live === undefined ? null : live);
          if (hot === undefined) return { committed: false, snapshot: { val: () => (live === undefined ? null : live) } };
          setNode(path, hot);
          return { committed: true, snapshot: { val: () => hot } };
        },
      };
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

// An order a picker has just marked COMING TOMORROW: the shape writeOrder
// stores, plus the comingTomorrowAt stamp updateStatus writes with the status.
const order = (over = {}) => ({
  id: "042",
  status: "coming_tomorrow",
  customerName: "Thandi",
  customerPhone: "0821234567",
  productName: "Air Max 90",
  size: "9",
  createdAt: "2026-08-19T08:00:00.000Z",
  comingTomorrowAt: NOW,
  updatedAt: NOW,
  ...over,
});

const drive = (db, enqueue, { orderId = "042", before = "incoming", after = "coming_tomorrow" } = {}) =>
  notifyOrderTomorrow({ db, enqueueWhatsApp: enqueue, orderId, before, after, nowIso: NOW });

// ── 1 · THE MESSAGE FIRES — exactly one, with the order number ───────────────
test("1 · an order marked COMING TOMORROW enqueues exactly one order_tomorrow", async () => {
  const db = fakeDb({ orders: { "042": order() } });
  const enqueue = spy();
  const res = await drive(db, enqueue);

  assert.equal(res.sent, true);
  assert.equal(enqueue.calls.length, 1, "exactly one enqueue");
  assert.deepEqual(enqueue.calls[0], {
    templateName:   "order_tomorrow",
    recipientPhone: "0821234567",
    templateParams: ["042"],            // the order NUMBER — what the deleted call passed
  });
  // The record now says so, durably — this is what stops a second send.
  assert.equal(db.state.orders["042"].tomorrowNotifiedAt, NOW);
  assert.equal(db.state.orders["042"].tomorrowNotifyOutboxId, "ob1");
});

test("1b · the restored call matches the one e115cde deleted — template and arity", () => {
  // The deleted line was:
  //   sendWhatsAppTemplate(order.customerPhone, "order_tomorrow", [order.id])
  // Same template, same single param. renderWhatsAppText refuses a wrong param
  // count outright, so a drifted arity would fail the send loudly rather than
  // ship a customer a broken message — this pins the contract on both sides.
  const src = readFileSync(join(__dirname, "..", "index.js"), "utf8");
  assert.equal(TEMPLATE, "order_tomorrow");
  assert.equal(STATE, "coming_tomorrow");
  assert.match(src, /order_tomorrow:\s*\{\s*params:\s*1,/);
  assert.match(src, /is scheduled for tomorrow/);
});

// ── 2 · INTO THE STATE TWICE ENQUEUES ONE, NOT TWO ──────────────────────────
test("2 · re-entering COMING TOMORROW enqueues ONE, not two", async () => {
  // tomorrow → ready → tomorrow. The second entry is a genuine transition, so
  // guard 1 lets it through; the tomorrowNotifiedAt stamp is what refuses it.
  const db = fakeDb({ orders: { "042": order() } });
  const enqueue = spy();
  const a = await drive(db, enqueue);
  const b = await drive(db, enqueue, { before: "ready" });

  assert.equal(a.sent, true);
  assert.equal(b.sent, false);
  assert.equal(b.skipped, "already_handled");
  assert.equal(enqueue.calls.length, 1, "one message across both entries");
});

test("2b · a double-tap on the SAME button enqueues one, not two", async () => {
  const db = fakeDb({ orders: { "042": order() } });
  const enqueue = spy();
  await drive(db, enqueue);
  const b = await drive(db, enqueue);
  assert.equal(b.skipped, "already_handled");
  assert.equal(enqueue.calls.length, 1);
});

test("2c · two deliveries racing the SAME write: only the claim winner sends", async () => {
  // frozenReads: BOTH invocations read the order before either wrote, so the
  // cheap already-handled pre-check cannot separate them. The create-once claim
  // is the only guard left standing — and it is the one that has to hold, since
  // in production two trigger deliveries can genuinely overlap.
  const db = fakeDb({ orders: { "042": order() } }, { frozenReads: true });
  const enqueue = spy();
  const [a, b] = await Promise.all([
    drive(db, enqueue),
    notifyOrderTomorrow({
      db, enqueueWhatsApp: enqueue, orderId: "042", before: "incoming", after: "coming_tomorrow",
      nowIso: "2026-08-19T09:00:00.001Z",     // a different clock — a different claim value
    }),
  ]);
  assert.equal(enqueue.calls.length, 1, "one message, whichever invocation won");
  assert.equal([a.sent, b.sent].filter(Boolean).length, 1);
  assert.ok([a.skipped, b.skipped].includes("already_claimed"),
    `the CLAIM must be what refuses the loser, got ${JSON.stringify([a.skipped, b.skipped])}`);
});

test("2c-ms · two deliveries in the SAME MILLISECOND: still one message", async () => {
  // CodeRabbit #386 read the claim's identity as the timestamp and argued that
  // two invocations sharing a millisecond would both see
  // `res.snapshot.val() === now` and both send. The value comparison IS true for
  // both — but it is not what decides. `res.committed` is: the loser's update fn
  // returns undefined against a non-null `cur`, the transaction ABORTS, and
  // `committed` is false. The && is what makes the pair safe, so this drives the
  // exact same-millisecond case rather than arguing about it.
  const db = fakeDb({ orders: { "042": order() } }, { frozenReads: true });
  const enqueue = spy();
  const same = "2026-08-19T09:00:00.000Z";
  const [a, b] = await Promise.all([
    notifyOrderTomorrow({ db, enqueueWhatsApp: enqueue, orderId: "042", before: "incoming", after: "coming_tomorrow", nowIso: same }),
    notifyOrderTomorrow({ db, enqueueWhatsApp: enqueue, orderId: "042", before: "incoming", after: "coming_tomorrow", nowIso: same }),
  ]);
  assert.equal(enqueue.calls.length, 1, "IDENTICAL claim values must still yield ONE message");
  assert.equal([a.sent, b.sent].filter(Boolean).length, 1);
  assert.ok([a.skipped, b.skipped].includes("already_claimed"),
    `the CLAIM must refuse the loser even at the same ms, got ${JSON.stringify([a.skipped, b.skipped])}`);
});

test("2d · a redelivered trigger event (tomorrow → tomorrow) is not a transition", async () => {
  const db = fakeDb({ orders: { "042": order() } });
  const enqueue = spy();
  const res = await drive(db, enqueue, { before: "coming_tomorrow" });
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "no_transition");
});

test("2e · an unresolved claim is NEVER taken over — it is stamped for a human", async () => {
  const db = fakeDb({ orders: { "042": order({ tomorrowNotifyClaimedAt: "2026-08-19T08:59:00.000Z" }) } });
  const enqueue = spy();
  const res = await drive(db, enqueue);
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "claim_unresolved");
  assert.equal(db.state.orders["042"].tomorrowNotifyUnresolvedAt, NOW);
});

// ── 3 · NO PHONE — nothing enqueued, nothing thrown ─────────────────────────
test("3 · an order with no customer phone enqueues nothing and does not throw", async () => {
  for (const phone of [undefined, null, ""]) {
    const db = fakeDb({ orders: { "042": order({ customerPhone: phone }) } });
    const enqueue = spy();
    let res;
    await assert.doesNotReject(async () => { res = await drive(db, enqueue); });
    assert.equal(enqueue.calls.length, 0, `phone ${JSON.stringify(phone)} must enqueue nothing`);
    assert.equal(res.skipped, "no_phone");
    // and it must not have claimed anything on the way out
    assert.equal(db.state.orders["042"].tomorrowNotifyClaimedAt, undefined);
  }
});

test("3b · an order that vanished (daily reset) enqueues nothing and does not throw", async () => {
  const db = fakeDb({ orders: {} });
  const enqueue = spy();
  const res = await drive(db, enqueue);
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "order_gone");
});

test("3c · a flip-and-revert messages nobody — the LIVE record is what counts", async () => {
  // The event says coming_tomorrow, but by the time we read, staff had already
  // moved it on. Nothing is promised to a customer whose order is not held.
  const db = fakeDb({ orders: { "042": order({ status: "ready" }) } });
  const enqueue = spy();
  const res = await drive(db, enqueue);
  assert.equal(enqueue.calls.length, 0);
  assert.equal(res.skipped, "status_moved");
});

// ── 4 · THE OTHER THREE ORDER MESSAGES ARE UNAFFECTED ───────────────────────
test("4 · no other order transition wakes this trigger", async () => {
  // order_placed / order_ready / rder_out_of_stock still fire from the client on
  // their own transitions. This trigger is scoped to ONE state, so every other
  // transition must fall out at the first guard having touched nothing.
  for (const after of ["incoming", "ready", "out_of_stock", "collected", null]) {
    const db = fakeDb({ orders: { "042": order({ status: after }) } });
    const enqueue = spy();
    const res = await drive(db, enqueue, { after });
    assert.equal(enqueue.calls.length, 0, `after=${after} must enqueue nothing`);
    assert.equal(res.skipped, "not_coming_tomorrow");
    assert.equal(db.state.orders["042"].tomorrowNotifyClaimedAt, undefined);
  }
});

test("4b · the other three sends are still the CLIENT's, on their own transitions", () => {
  // Restoring the fourth message must neither move nor duplicate the three that
  // never broke. They stay exactly where they have always been, in updateStatus.
  const app = readFileSync(join(__dirname, "..", "..", "src", "App.jsx"), "utf8");
  const calls = app.match(/sendWhatsAppTemplate\(/g) || [];
  assert.equal(calls.length, 4, "1 declaration + 3 client call sites — no more, no fewer");
  assert.match(app, /sendWhatsAppTemplate\(normalizedPhone, "order_placed"/);
  assert.match(app, /sendWhatsAppTemplate\(order\.customerPhone, "order_ready"/);
  assert.match(app, /sendWhatsAppTemplate\(order\.customerPhone, "rder_out_of_stock"/);
  // and the fourth is NOT among them — it is the server's now.
  assert.doesNotMatch(app, /sendWhatsAppTemplate\([^)]*order_tomorrow/);
});

// ── 5 · PR #385's FULFIL MESSAGE IS INDEPENDENT AND NOT DOUBLED ─────────────
test("5 · this trigger never touches a refill request, so #385 cannot be disturbed", async () => {
  const db = fakeDb({
    orders: { "042": order() },
    refill_requests: { "onhold_2026-08-19_042": { status: "open", holdLink: { orderId: "042", notifyOnFulfil: true, customerPhone: "0821234567", customerName: "Thandi" } } },
  });
  const enqueue = spy();
  await drive(db, enqueue);
  // #385's record is byte-identical afterwards.
  assert.deepEqual(db.state.refill_requests["onhold_2026-08-19_042"], {
    status: "open",
    holdLink: { orderId: "042", notifyOnFulfil: true, customerPhone: "0821234567", customerName: "Thandi" },
  });
});

test("5b · the full held journey sends TWO DIFFERENT messages, one each, in order", async () => {
  // This is the duplicate question, pinned. A held customer hears twice:
  //   at hold-placed  order_tomorrow  "scheduled for tomorrow"
  //   at fulfil       order_ready     "ready to collect"          (PR #385)
  // Two messages, two different templates, one of each. Not a duplicate pair,
  // and neither one doubled.
  const db = fakeDb({
    orders: { "042": order() },
    refill_requests: {
      "onhold_2026-08-19_042": {
        status: "fulfilled",
        fulfilledBy: { movementId: "rrf_onhold_2026-08-19_042", qty: 1 },
        holdLink: { orderId: "042", customerName: "Thandi", customerPhone: "0821234567", notifyOnFulfil: true },
      },
    },
  });
  const enqueue = spy();

  await drive(db, enqueue);                                     // staff: coming tomorrow
  await notifyHoldAvailability({                                // later: the stock lands
    db, enqueueWhatsApp: enqueue, requestId: "onhold_2026-08-19_042",
    before: "open", after: "fulfilled", nowIso: "2026-08-19T14:00:00.000Z",
  });

  assert.equal(enqueue.calls.length, 2, "two messages across the whole journey");
  assert.deepEqual(enqueue.calls.map(c => c.templateName), ["order_tomorrow", "order_ready"]);
  // Same customer, different words — nothing said twice.
  assert.equal(new Set(enqueue.calls.map(c => c.recipientPhone)).size, 1);
  assert.equal(new Set(enqueue.calls.map(c => c.templateName)).size, 2);
});

test("5c · re-driving BOTH triggers after the journey adds nothing", async () => {
  const db = fakeDb({
    orders: { "042": order() },
    refill_requests: {
      "onhold_2026-08-19_042": {
        status: "fulfilled",
        fulfilledBy: { movementId: "rrf_onhold_2026-08-19_042", qty: 1 },
        holdLink: { orderId: "042", customerName: "Thandi", customerPhone: "0821234567", notifyOnFulfil: true },
      },
    },
  });
  const enqueue = spy();
  const hold = () => notifyHoldAvailability({
    db, enqueueWhatsApp: enqueue, requestId: "onhold_2026-08-19_042",
    before: "open", after: "fulfilled", nowIso: "2026-08-19T14:00:00.000Z",
  });

  await drive(db, enqueue); await hold();
  await drive(db, enqueue); await hold();       // both redelivered
  await drive(db, enqueue); await hold();

  assert.equal(enqueue.calls.length, 2, "still two — every redelivery is refused");
});

// ── 6 · FAILURE HANDLING ────────────────────────────────────────────────────
test("6 · an unusable number is TERMINAL — stamped, claim kept, never retried", async () => {
  const db = fakeDb({ orders: { "042": order() } });
  const err = new Error("recipientPhone is not a usable phone number");
  err.code = "invalid-argument"; err.details = { unusableRecipient: true };
  const enqueue = spy(() => { throw err; });

  const res = await drive(db, enqueue);
  assert.equal(res.sent, false);
  assert.equal(res.skipped, "unusable_recipient");
  const o = db.state.orders["042"];
  assert.equal(o.tomorrowNotifyFailedAt, NOW);
  assert.equal(o.tomorrowNotifyClaimedAt, NOW, "the claim is KEPT — a retry can never succeed");

  // A redelivery finds it handled and does not try again.
  const again = await drive(db, enqueue, { before: "ready" });
  assert.equal(again.skipped, "already_handled");
  assert.equal(enqueue.calls.length, 1);
});

test("6e · a failing claim transaction enqueues nothing and RETHROWS for the retry", async () => {
  // The claim is the only door to the producer. If the transaction itself is
  // refused — rules, a network fault — the answer is to send nothing AND to be
  // loud, so the trigger re-drives it. Swallowing the error would read as
  // success, no retry would follow, and the customer would be silently never
  // told: the exact failure class this module exists to end. (CodeRabbit #386 —
  // the branch had no test and no mutation guard, and it was returning.)
  const db = fakeDb({ orders: { "042": order() } },
    { failTransaction: (path) => path.endsWith("tomorrowNotifyClaimedAt") });
  const enqueue = spy();
  await assert.rejects(() => drive(db, enqueue), /claim write refused/);
  assert.equal(enqueue.calls.length, 0, "a refused claim must never reach the producer");
  // and nothing is left stamped on the order that would suppress a later retry
  const o = db.state.orders["042"];
  assert.equal(o.tomorrowNotifiedAt, undefined);
  assert.equal(o.tomorrowNotifyClaimedAt, undefined);
  assert.equal(o.tomorrowNotifyFailedAt, undefined);
});

test("6b · a TRANSIENT failure releases the claim and rethrows, so the retry re-sends", async () => {
  const db = fakeDb({ orders: { "042": order() } });
  let fail = true;
  const enqueue = spy(() => { if (fail) throw new Error("outbox unavailable"); return { success: true, outboxId: "ob9" }; });

  await assert.rejects(() => drive(db, enqueue), /outbox unavailable/);
  assert.equal(db.state.orders["042"].tomorrowNotifyClaimedAt, undefined, "claim released — nothing was enqueued");
  assert.match(db.state.orders["042"].tomorrowNotifyError, /outbox unavailable/);

  fail = false;
  const res = await drive(db, enqueue);            // the trigger's retry
  assert.equal(res.sent, true);
  assert.equal(enqueue.calls.length, 2, "one refused attempt, then one real send");
});

test("6c · a template-contract failure stays RETRYABLE, not terminal", async () => {
  // invalid-argument WITHOUT unusableRecipient is a deploy bug (arity drift),
  // not a bad number. Treating it as terminal would silently drop every
  // tomorrow notification behind one bad deploy.
  const db = fakeDb({ orders: { "042": order() } });
  const err = new Error('Template "order_tomorrow" expects 1 param(s), got 2');
  err.code = "invalid-argument";
  const enqueue = spy(() => { throw err; });

  await assert.rejects(() => drive(db, enqueue), /expects 1 param/);
  assert.equal(db.state.orders["042"].tomorrowNotifyFailedAt, undefined, "NOT terminal");
  assert.equal(db.state.orders["042"].tomorrowNotifyClaimedAt, undefined, "claim released for the retry");
});

test("6d · ENQUEUED but the stamp failed: the claim is KEPT, so nothing re-sends", async () => {
  // The enqueue and the bookkeeping are separate awaits. A failure of the
  // SECOND must never release the claim — that is the exact 2-5 copies incident.
  const db = fakeDb({ orders: { "042": order() } },
    { failUpdate: (path, patch) => "tomorrowNotifiedAt" in patch });
  const enqueue = spy();

  const res = await drive(db, enqueue);
  assert.equal(res.sent, true);
  assert.equal(enqueue.calls.length, 1);
  assert.equal(db.state.orders["042"].tomorrowNotifyClaimedAt, NOW, "claim KEPT despite the failed stamp");

  const again = await drive(db, enqueue, { before: "ready" });
  assert.equal(again.skipped, "claim_unresolved", "the kept claim is what refuses it");
  assert.equal(enqueue.calls.length, 1, "still one message");
});
