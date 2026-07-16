// Parity tests for dispatchHoldRevealSweep's core (lib/hold-reveal-sweep.cjs).
// Run: cd functions && node --test
//
// These pin the BEHAVIOUR of the filtered-query sweep (PR #208) so future
// changes can't silently alter when a customer's order_ready message fires:
// due → notified; not due → held; left READY → cleared, never sent; already
// claimed → not double-sent; enqueue failure → re-held and retried; malformed
// notifyReadyAt → fails OPEN (customer still told).
const { test } = require("node:test");
const assert = require("node:assert");
const { runHoldRevealSweep } = require("../lib/hold-reveal-sweep.cjs");

const NOW = Date.parse("2026-07-16T10:00:00.000Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

// ── Fake RTDB ────────────────────────────────────────────────────────────────
// Models exactly what the sweep uses: the filtered orders query, child
// update()/set(), and transaction() with Cloud-Function COLD-CACHE semantics —
// the update fn is invoked FIRST with null (local cache empty after once()
// tears down), and only if that returns a value is it re-run against the real
// server value (the CAS re-run). This is the semantics the null-tolerant claim
// comment in the lib depends on; a fake that fed the server value first would
// not exercise it.
function fakeDb(initialOrders, { failSets = {} } = {}) {
  const state = { orders: structuredClone(initialOrders) };
  const writes = [];

  const getPath = (path) => path.split("/").reduce((n, k) => (n == null ? n : n[k]), state);
  const setPath = (path, value) => {
    const parts = path.split("/");
    const last = parts.pop();
    let node = state;
    for (const k of parts) { node[k] = node[k] ?? {}; node = node[k]; }
    node[last] = value;
  };

  return {
    writes,
    state,
    ref(path) {
      return {
        orderByChild(child) {
          assert.equal(path, "orders", "sweep must query the orders node");
          assert.equal(child, "readyNotifyPending", "sweep must filter on readyNotifyPending");
          return {
            equalTo(v) {
              assert.equal(v, true);
              return {
                async once(evt) {
                  assert.equal(evt, "value");
                  // What the server returns for the indexed equalTo(true) query.
                  const matched = Object.fromEntries(
                    Object.entries(state.orders).filter(([, o]) => o && o.readyNotifyPending === true)
                  );
                  return { val: () => (Object.keys(matched).length ? matched : null) };
                },
              };
            },
          };
        },
        async update(patch) {
          if (failSets[path]) throw new Error(`update failed: ${path}`);
          writes.push({ op: "update", path, patch });
          for (const [k, v] of Object.entries(patch)) setPath(`${path}/${k}`, v);
        },
        async set(value) {
          if (failSets[path]) throw new Error(`set failed: ${path}`);
          writes.push({ op: "set", path, value });
          setPath(path, value);
        },
        async transaction(fn) {
          // COLD-CACHE first run: fn(null). undefined → abort before the
          // server is consulted (this is the branch that must NOT fire for a
          // legitimate claim). Otherwise the CAS re-run against the true
          // server value decides.
          const coldResult = fn(null);
          if (coldResult === undefined) {
            return { committed: false, snapshot: { val: () => getPath(path) ?? null } };
          }
          const serverVal = getPath(path) ?? null;
          const finalResult = fn(serverVal);
          if (finalResult === undefined) {
            return { committed: false, snapshot: { val: () => serverVal } };
          }
          writes.push({ op: "transaction", path, value: finalResult });
          setPath(path, finalResult);
          return { committed: true, snapshot: { val: () => finalResult } };
        },
      };
    },
  };
}

const readyOrder = (over = {}) => ({
  status: "ready",
  readyNotifyPending: true,
  customerPhone: "27840000001",
  customerName: "Thabo",
  notifyReadyAt: iso(-60_000), // due a minute ago
  ...over,
});

function enqueueSpy(impl) {
  const calls = [];
  const fn = async (data) => {
    calls.push(data);
    if (impl) return impl(data);
  };
  fn.calls = calls;
  return fn;
}

// ── The six required parity cases ────────────────────────────────────────────

test("due for reveal → notified once, flag cleared, readyNotifiedAt stamped", async () => {
  const db = fakeDb({ o1: readyOrder() });
  const enqueue = enqueueSpy();
  const res = await runHoldRevealSweep({ db, enqueueWhatsApp: enqueue, nowMs: NOW });

  assert.equal(res.sent, 1);
  assert.equal(res.cleared, 0);
  assert.equal(enqueue.calls.length, 1);
  assert.deepEqual(enqueue.calls[0], {
    templateName: "order_ready",
    recipientPhone: "27840000001",
    templateParams: ["Thabo", "o1"],
  });
  assert.equal(db.state.orders.o1.readyNotifyPending, false);
  assert.ok(db.state.orders.o1.readyNotifiedAt, "readyNotifiedAt stamped");
});

test("not yet due → held: no send, no claim, flag stays true", async () => {
  const db = fakeDb({ o1: readyOrder({ notifyReadyAt: iso(+120_000) }) });
  const enqueue = enqueueSpy();
  const res = await runHoldRevealSweep({ db, enqueueWhatsApp: enqueue, nowMs: NOW });

  assert.equal(res.sent, 0);
  assert.equal(enqueue.calls.length, 0);
  assert.equal(db.state.orders.o1.readyNotifyPending, true, "still held for a later run");
  assert.equal(db.writes.length, 0, "no writes at all for a not-yet-due order");
});

test("reverted out of READY → flag cleared, never notified", async () => {
  const db = fakeDb({ o1: readyOrder({ status: "collected" }) });
  const enqueue = enqueueSpy();
  const res = await runHoldRevealSweep({ db, enqueueWhatsApp: enqueue, nowMs: NOW });

  assert.equal(res.sent, 0);
  assert.equal(res.cleared, 1);
  assert.equal(enqueue.calls.length, 0, "a stale hold must never fire");
  assert.equal(db.state.orders.o1.readyNotifyPending, false);
  assert.equal(db.state.orders.o1.readyNotifiedAt, undefined, "no notified stamp on a cleared hold");
});

test("already claimed by a prior/overlapping sweep → not double-notified", async () => {
  // The query snapshot said pending, but by claim time another run flipped the
  // server flag to false — the CAS re-run sees false and aborts.
  const db = fakeDb({ o1: readyOrder() });
  db.state.orders.o1.readyNotifyPending = true; // in the query result…
  const enqueue = enqueueSpy();

  // Flip the server value between query and claim by pre-claiming it.
  const originalRef = db.ref.bind(db);
  let queried = false;
  db.ref = (path) => {
    const r = originalRef(path);
    if (path === "orders" && !queried) {
      queried = true;
      const q = r.orderByChild.bind(r);
      r.orderByChild = (child) => {
        const chain = q(child);
        const eq = chain.equalTo.bind(chain);
        chain.equalTo = (v) => {
          const leaf = eq(v);
          const once = leaf.once.bind(leaf);
          leaf.once = async (evt) => {
            const snap = await once(evt);
            db.state.orders.o1.readyNotifyPending = false; // another sweep wins AFTER our read
            return snap;
          };
          return leaf;
        };
        return chain;
      };
    }
    return r;
  };

  const res = await runHoldRevealSweep({ db, enqueueWhatsApp: enqueue, nowMs: NOW });
  assert.equal(res.sent, 0);
  assert.equal(enqueue.calls.length, 0, "the losing sweep must not send");
  assert.equal(db.state.orders.o1.readyNotifiedAt, undefined);
});

test("retry path: enqueue fails → re-held; next sweep sends exactly once", async () => {
  const db = fakeDb({ o1: readyOrder() });
  const failing = enqueueSpy(() => { throw new Error("outbox down"); });

  const first = await runHoldRevealSweep({ db, enqueueWhatsApp: failing, nowMs: NOW });
  assert.equal(first.sent, 0);
  assert.equal(failing.calls.length, 1, "send was attempted");
  assert.equal(db.state.orders.o1.readyNotifyPending, true, "re-held after failed enqueue");
  assert.equal(db.state.orders.o1.readyNotifiedAt, undefined, "no notified stamp on failure");

  const working = enqueueSpy();
  const second = await runHoldRevealSweep({ db, enqueueWhatsApp: working, nowMs: NOW + 60_000 });
  assert.equal(second.sent, 1);
  assert.equal(working.calls.length, 1, "retried exactly once");
  assert.equal(db.state.orders.o1.readyNotifyPending, false);
  assert.ok(db.state.orders.o1.readyNotifiedAt);
});

test("malformed notifyReadyAt → fails OPEN: customer is still notified", async () => {
  const db = fakeDb({
    bad: readyOrder({ notifyReadyAt: "not-a-timestamp" }),
    missing: readyOrder({ notifyReadyAt: undefined, customerPhone: "27840000002" }),
  });
  const enqueue = enqueueSpy();
  const res = await runHoldRevealSweep({ db, enqueueWhatsApp: enqueue, nowMs: NOW });

  // Date.parse("not-a-timestamp") is NaN; NaN > now is false → treated as due.
  // A missing notifyReadyAt is falsy → also treated as due. Malformed data
  // must never hold a customer's message forever.
  assert.equal(res.sent, 2);
  assert.equal(enqueue.calls.length, 2);
  assert.equal(db.state.orders.bad.readyNotifyPending, false);
  assert.equal(db.state.orders.missing.readyNotifyPending, false);
});

// ── Additional pinned invariants (beyond the six) ────────────────────────────

test("phoneless order: claimed + stamped, but nothing enqueued (current behaviour)", async () => {
  const db = fakeDb({ o1: readyOrder({ customerPhone: null }) });
  const enqueue = enqueueSpy();
  const res = await runHoldRevealSweep({ db, enqueueWhatsApp: enqueue, nowMs: NOW });
  assert.equal(res.sent, 1, "counted as sent — matches the shipped behaviour");
  assert.equal(enqueue.calls.length, 0);
  assert.equal(db.state.orders.o1.readyNotifyPending, false);
});

test("the legacy 'items' key is skipped even if it somehow matches the query", async () => {
  const db = fakeDb({ items: readyOrder(), o1: readyOrder() });
  const enqueue = enqueueSpy();
  const res = await runHoldRevealSweep({ db, enqueueWhatsApp: enqueue, nowMs: NOW });
  assert.equal(res.sent, 1);
  assert.deepEqual(enqueue.calls.map((c) => c.templateParams[1]), ["o1"]);
});

test("empty query result (nothing pending) → no writes, zero counts", async () => {
  const db = fakeDb({});
  const enqueue = enqueueSpy();
  const res = await runHoldRevealSweep({ db, enqueueWhatsApp: enqueue, nowMs: NOW });
  assert.deepEqual(res, { sent: 0, cleared: 0, matched: 0 });
  assert.equal(db.writes.length, 0);
});

test("customerName fallback: missing name → 'there' as the template param", async () => {
  const db = fakeDb({ o1: readyOrder({ customerName: undefined }) });
  const enqueue = enqueueSpy();
  await runHoldRevealSweep({ db, enqueueWhatsApp: enqueue, nowMs: NOW });
  assert.deepEqual(enqueue.calls[0].templateParams, ["there", "o1"]);
});
