// ─── THE CURSOR ADVANCE, AGAINST A DATABASE THAT BEHAVES LIKE RTDB ───────────
//
// The sweep's day nodes are recomputations and can be redone. The cursor and
// the running counter are a FOLD, so they move through a compare-and-set.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// The sweep's own tests inject a fake `advanceCursor`, so they prove the sweep
// CALLS it correctly and nothing about whether it works. It did not: RTDB runs
// a transaction's update function against the client's CACHED value first —
// `null` for a node it has never read whole — and only then retries against the
// server. The callback aborted on that first null, so the transaction reported
// committed: false without a round trip, every time. The cursor would have
// stayed wherever the backfill left it, every run would have re-walked a
// growing backlog, and the counter would never have moved.
//
// So this fake does what the real one does: it calls the update function with
// null first, and only then with the server's value — but only if nothing has
// primed the cache. A fake that handed over the server value straight away
// would make this whole file pass against the broken code.
const test = require("node:test");
const assert = require("node:assert");
const { makeIo } = require("../insightsRollup/io.cjs");

/** A database that reproduces the null-first behaviour and the cure.
 *
 *  The cure is NOT once() — that fetches and keeps nothing, and against
 *  production the transaction still saw null. It is holding a LISTENER open
 *  across the transaction, which is what makes the SDK keep the server's value
 *  in the cache. So that is what this fake models: `on` primes, `once` does
 *  not. A fake where once() primed would have let the broken version pass. */
function fakeDb(initial) {
  let server = initial;
  const primed = new Set();
  const seen = [];
  const refFor = (path) => ({
    on(_evt, _cb) { primed.add(path); },
    off(_evt, _cb) { primed.delete(path); },
    async once() { return { val: () => server }; },
    async transaction(fn) {
      // The cache is cold unless a listener is attached to this path.
      const first = primed.has(path) ? server : null;
      seen.push(first);
      let out = fn(first);
      if (out === undefined) {
        // RTDB aborts without a round trip when the FIRST call aborts.
        return { committed: false, snapshot: { val: () => server } };
      }
      if (first !== server) {                     // it was the cache; retry for real
        seen.push(server);
        out = fn(server);
        if (out === undefined) return { committed: false, snapshot: { val: () => server } };
      }
      server = out;
      return { committed: true, snapshot: { val: () => server } };
    },
    orderByKey() { return this; },
    limitToFirst() { return this; },
    startAt() { return this; },
    endAt() { return this; },
  });
  return {
    calls: seen,
    get server() { return server; },
    ref: (path) => refFor(path || ""),
  };
}

const SEEN = { n: 3, pe: 2, trophy: 1, pine: 0, other: 0 };

test("advances when the cursor is where the run found it", async () => {
  const db = fakeDb({ cursor: "C0", logTotals: { n: 100, pe: 90, trophy: 10, pine: 0, other: 0 } });
  const io = makeIo(db);
  const ok = await io.advanceCursor({ expect: "C0", cursor: "C1", seen: SEEN, at: "T" });

  assert.strictEqual(ok, true);
  assert.strictEqual(db.server.cursor, "C1");
  assert.strictEqual(db.server.logTotals.n, 103);
  assert.strictEqual(db.server.logTotals.pe, 92);
  assert.strictEqual(db.server.logTotals.cursor, "C1");
});

test("primes the node first, so the cache's null cannot abort it", async () => {
  // THE REGRESSION. Without the once("value") the first invocation sees null,
  // the callback aborts, and the advance never happens — silently, for ever.
  const db = fakeDb({ cursor: "C0", logTotals: { n: 5, pe: 5, trophy: 0, pine: 0, other: 0 } });
  const io = makeIo(db);
  const ok = await io.advanceCursor({ expect: "C0", cursor: "C1", seen: SEEN, at: "T" });

  assert.strictEqual(ok, true, "a cold cache must not stop the advance");
  // The update function saw the server's value on its first call, not null.
  assert.notStrictEqual(db.calls[0], null);
});

test("refuses when somebody else moved the cursor", async () => {
  const db = fakeDb({ cursor: "SOMEBODY-ELSE", logTotals: { n: 5, pe: 5, trophy: 0, pine: 0, other: 0 } });
  const io = makeIo(db);
  const ok = await io.advanceCursor({ expect: "C0", cursor: "C1", seen: SEEN, at: "T" });

  assert.strictEqual(ok, false);
  assert.strictEqual(db.server.cursor, "SOMEBODY-ELSE");
  assert.strictEqual(db.server.logTotals.n, 5, "nothing was folded in");
});

test("starts the counter from nothing on an empty node", async () => {
  const db = fakeDb(null);
  const io = makeIo(db);
  const ok = await io.advanceCursor({ expect: null, cursor: "C1", seen: SEEN, at: "T" });

  assert.strictEqual(ok, true);
  assert.strictEqual(db.server.logTotals.n, 3);
  assert.strictEqual(db.server.cursor, "C1");
});

test("does NOT write a counter onto an empty node when it expected a cursor", async () => {
  // The node is genuinely gone and the run thought there was a cursor. Folding
  // this run's counts into nothing would invent a total.
  const db = fakeDb(null);
  const io = makeIo(db);
  const ok = await io.advanceCursor({ expect: "C0", cursor: "C1", seen: SEEN, at: "T" });

  assert.strictEqual(ok, false);
  assert.strictEqual(db.server, null);
});

test("leaves everything else under meta alone", async () => {
  const db = fakeDb({
    cursor: "C0",
    logTotals: { n: 1, pe: 1, trophy: 0, pine: 0, other: 0 },
    built: { "2026-09-18": { n: 1030 } },
    lastBuild: { at: "yesterday" },
  });
  const io = makeIo(db);
  await io.advanceCursor({ expect: "C0", cursor: "C1", seen: SEEN, at: "T" });

  assert.deepStrictEqual(db.server.built, { "2026-09-18": { n: 1030 } });
  assert.deepStrictEqual(db.server.lastBuild, { at: "yesterday" });
});

test("a recount SETS the counter rather than adding to it", async () => {
  // A pass that has walked the whole log from nothing knows the answer; adding
  // it to what is already there would double everything.
  const db = fakeDb({ cursor: "C0", logTotals: { n: 500, pe: 500, trophy: 0, pine: 0, other: 0 } });
  const io = makeIo(db);
  const ok = await io.advanceCursor({
    expect: "C0", cursor: "C9", replace: true,
    seen: { n: 113608, pe: 88653, trophy: 10425, pine: 14530, other: 0 }, at: "T",
  });

  assert.strictEqual(ok, true);
  assert.strictEqual(db.server.logTotals.n, 113608);
  assert.strictEqual(db.server.logTotals.pe, 88653);
});

test("a recount that raced somebody else is refused, not applied", async () => {
  const db = fakeDb({ cursor: "MOVED", logTotals: { n: 500, pe: 500, trophy: 0, pine: 0, other: 0 } });
  const io = makeIo(db);
  const ok = await io.advanceCursor({
    expect: "C0", cursor: "C9", replace: true, seen: { n: 1, pe: 1, trophy: 0, pine: 0, other: 0 }, at: "T",
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(db.server.logTotals.n, 500);
});
