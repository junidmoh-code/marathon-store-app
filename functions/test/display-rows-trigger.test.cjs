// ─── closeDisplayRowOnSale — THE TRIGGER ITSELF, not just its decisions ──────
//
// Every other suite here tests lib.cjs, which is pure. The trigger was the one
// file in this feature with NO coverage at all — and it is where two separate
// review rounds found a settled property had been silently regressed:
//
//   • the CAS retry re-read WITHOUT the movement instant, so it closed a row a
//     wall walk had opened AFTER the sale — verbatim the bug the age filter had
//     just fixed, one line below it;
//   • the retry walked onto the next row whoever beat it, including a HUMAN
//     correction, turning one sale into two closes.
//
// Both survived every test that existed. A final review pass mutation-checked
// the file and found four more surviving mutants in the same few lines. So this
// drives the real handler over a small in-memory RTDB.
//
// HOW THE HANDLER IS REACHED: firebase-admin and firebase-functions are
// replaced in require.cache BEFORE the module is loaded, and the stubbed
// `onValueCreated` returns its handler instead of registering it. Nothing here
// touches a network or a real database.
//
// THE FAKE DB IMPLEMENTS WHAT THE TRIGGER USES, AND THE PARTS THAT BITE:
//   • `transaction(fn)` — undefined ABORTS (committed:false) and hands back the
//     CURRENT value, which is how the CAS and the lease are supposed to behave;
//   • a multi-path `update()` at the root, deepest-write-last;
//   • RTDB's own rule that a node with no children ceases to exist, so a test
//     cannot pass here on a shape RTDB could not hold.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// ── the in-memory tree ──────────────────────────────────────────────────────
// A value the Admin SDK would REFUSE. `undefined` anywhere inside a write is a
// throw from the real SDK, and this fake used to accept it silently — which is
// how `size: keep.size` shipped: `rowIsOpen` never requires a `size`, so an
// open survivor without one produced `size: undefined`, the real SDK would have
// thrown mid-mirror, and every test here passed. A fake that accepts what the
// real thing rejects is not a test, it is a second implementation with laxer
// rules. (Peer review, marathon-store-app-display-f8.)
function assertWritable(v, where) {
  if (v === undefined) throw new Error(`firebase.database: undefined value at ${where}`);
  if (v === null || typeof v !== "object") return;
  for (const [k, x] of Object.entries(v)) assertWritable(x, `${where}/${k}`);
}

function makeDb() {
  let root = {};
  let reads = 0;
  const at = (p) => {
    const parts = String(p).split("/").filter(Boolean);
    let n = root;
    for (const k of parts) { if (n == null || typeof n !== "object") return undefined; n = n[k]; }
    return n;
  };
  const put = (p, v) => {
    const parts = String(p).split("/").filter(Boolean);
    const leaf = parts.pop();
    let n = root;
    for (const k of parts) { if (n[k] == null || typeof n[k] !== "object") n[k] = {}; n = n[k]; }
    if (v === null || v === undefined) delete n[leaf]; else n[leaf] = v;
  };
  // A hook that fires JUST BEFORE a transaction reads, so a test can make the
  // trigger LOSE a race — which is the only way to reach the retry path at all.
  // Without it a "already closed" row is simply not a candidate, and the test
  // that thought it was exercising the retry was exercising the ordinary path.
  const hooks = new Map();
  const ref = (p = "") => ({
    async get() { reads++; const v = at(p); return { val: () => (v === undefined ? null : v) }; },
    async transaction(fn) {
      const h = hooks.get(p);
      if (h) { hooks.delete(p); h(); }
      const cur = at(p);
      const next = fn(cur === undefined ? null : cur);
      if (next === undefined) return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
      assertWritable(next, p);
      put(p, next);
      return { committed: true, snapshot: { val: () => next } };
    },
    async update(obj) {
      // `null` is a legitimate DELETE in a multi-path update; `undefined` is
      // not, and the real SDK throws on it.
      for (const [k, v] of Object.entries(obj)) assertWritable(v === null ? null : v, k);
      if (!p) { for (const [k, v] of Object.entries(obj)) put(k, v); return; }
      for (const [k, v] of Object.entries(obj)) put(`${p}/${k}`, v);
    },
  });
  return { ref, _root: () => root, _set: (p, v) => put(p, v), _get: at,
           _reads: () => reads, _resetReads: () => { reads = 0; },
           _raceOn: (p, fn) => hooks.set(p, fn) };
}

// ── load the handler with the SDKs stubbed out ──────────────────────────────
function loadHandler(db) {
  const adminPath = require.resolve("firebase-admin");
  const fnPath = require.resolve("firebase-functions/v2/database");
  const triggerPath = require.resolve("../displayRows/closeDisplayRowOnSale.js");
  for (const p of [adminPath, fnPath, triggerPath]) delete require.cache[p];
  const stub = (filename, exports) => ({ id: filename, filename, path: path.dirname(filename), loaded: true, exports, children: [], paths: [] });
  require.cache[adminPath] = stub(adminPath, { apps: [{}], initializeApp() {}, database: () => db });
  require.cache[fnPath] = stub(fnPath, { onValueCreated: (_opts, handler) => handler });
  const { closeDisplayRowOnSale } = require(triggerPath);
  delete require.cache[adminPath];
  delete require.cache[fnPath];
  delete require.cache[triggerPath];
  return closeDisplayRowOnSale;
}

const SALE = "2026-09-08T10:00:00.000Z";
const NOW = Date.parse(SALE) + 30_000;                 // inside the 2-minute bound

const evt = (m, movementId = "m1") => ({ data: { val: () => m }, params: { movementId } });
const soldAt = (from, over = {}) => ({ type: "sold", from, productId: "p1", size: "9", qty: 1, ts: SALE, ...over });
const openRow = (over = {}) => ({
  rowId: "r", store: "trophy", productId: "p1", status: "open", size: "9", sizeKey: "9",
  bookedHub: "hub1", openedAt: "2026-09-01T00:00:00.000Z", events: {}, ...over,
});
const ROWS = "settings/displayRows";

function withClock(fn) {
  const real = Date.now;
  Date.now = () => NOW;
  try { return fn(); } finally { Date.now = real; }
}
const run = async (db, m, id) => withClock(() => loadHandler(db)(evt(m, id)));

// ── a plain shop sale closes the matching row ───────────────────────────────
test("a shop sale closes the open row at that size, and only that one", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set(`${ROWS}/trophy/p1/b`, openRow({ rowId: "b", size: "10", sizeKey: "10" }));
  await run(db, soldAt("trophy"));
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "closed");
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).closedReason, "sold");
  assert.equal(db._get(`${ROWS}/trophy/p1/b`).status, "open");
  // The mirror follows the ledger: `b` survives, so the slot points at IT.
  assert.equal(db._get("settings/displaySlots/trophy/p1").sizeKey, "10");
});

// ── THE REGRESSION THAT GOT THROUGH TWICE ───────────────────────────────────
test("THE RETRY PASS keeps the age filter — a row opened after the sale is never closed", async () => {
  const db = makeDb();
  // Reaching pass 1 at all takes care, and a first version of this test did
  // NOT: pre-closing `a` left pass 0 with no candidate (the post-sale `b` is
  // already filtered out), so the handler returned early and the mutant that
  // drops `m.ts` from the re-read SURVIVED. The row has to be OPEN when the
  // trigger reads it and lost by the time the CAS runs.
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set(`${ROWS}/trophy/p1/b`, openRow({ rowId: "b", openedAt: "2026-09-08T10:00:30.000Z" }));
  db._raceOn(`${ROWS}/trophy/p1/a`, () => {
    db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a", status: "closed", closedVia: "pos_sale" }));
  });
  await run(db, soldAt("trophy"));
  assert.equal(db._get(`${ROWS}/trophy/p1/b`).status, "open",
    "the retry closed a row registered after the sale");
});

test("an INFERRED hub close never takes a second candidate on the retry", async () => {
  // The inference earned exactly ONE row under a uniqueness test. Re-reading
  // and taking "the next open row of that size" walks straight past that test —
  // here onto a row booked at a different hub, which the inference never
  // considered at all.
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a", bookedHub: "hub1" }));
  db._set(`${ROWS}/trophy/p1/b`, openRow({ rowId: "b", bookedHub: "hub2", openedAt: "2026-09-02T00:00:00.000Z" }));
  db._set("stock/hub1/p1/9/qty", 0);
  db._raceOn(`${ROWS}/trophy/p1/a`, () => {
    db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a", status: "closed", closedVia: "pos_sale" }));
  });
  await run(db, soldAt("hub1"));
  assert.equal(db._get(`${ROWS}/trophy/p1/b`).status, "open",
    "an inferred close retried onto a row its own uniqueness test had excluded");
});

test("the retry STOPS when a HUMAN correction won the first row", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set(`${ROWS}/trophy/p1/b`, openRow({ rowId: "b", openedAt: "2026-09-02T00:00:00.000Z" }));
  // Both are candidates when the trigger reads. `a` is then closed by a person
  // on the Duplicate tab in the instant before the CAS — so the CAS aborts and
  // the loop must NOT walk on to `b`.
  db._raceOn(`${ROWS}/trophy/p1/a`, () => {
    db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a", status: "closed", closedVia: "duplicate_tab" }));
  });
  await run(db, soldAt("trophy"));
  assert.equal(db._get(`${ROWS}/trophy/p1/b`).status, "open",
    "a person said that record was not a pair leaving the wall; one sale must not become two closes");
});

test("but it DOES walk on when another SALE won the row mid-flight", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set(`${ROWS}/trophy/p1/b`, openRow({ rowId: "b", openedAt: "2026-09-02T00:00:00.000Z" }));
  db._raceOn(`${ROWS}/trophy/p1/a`, () => {
    db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a", status: "closed", closedVia: "pos_sale" }));
  });
  await run(db, soldAt("trophy"));
  assert.equal(db._get(`${ROWS}/trophy/p1/b`).status, "closed",
    "two tills sold two pairs off that wall; both records must close");
});

// ── idempotency ─────────────────────────────────────────────────────────────
test("a replayed movement closes nothing a second time", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set(`${ROWS}/trophy/p1/b`, openRow({ rowId: "b", openedAt: "2026-09-02T00:00:00.000Z" }));
  await run(db, soldAt("trophy"), "same");
  await run(db, soldAt("trophy"), "same");
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "closed");
  assert.equal(db._get(`${ROWS}/trophy/p1/b`).status, "open", "the replay closed a second row");
  assert.equal(db._get("settings/displayRows_meta/trophy/processed/same").done, true);
});

// ── the hub inference, end to end ───────────────────────────────────────────
test("a HUB sale closes nothing while the hub still holds one of that size", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set("stock/hub1/p1/9/qty", 2);
  await run(db, soldAt("hub1"));
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "open");
  assert.match(db._get("settings/displayRows_meta/hub1/processed/m1").refused, /still holds 2/);
});

test("a HUB sale closes the one row when the cell is empty, and records the inference", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set("stock/hub1/p1/9/qty", 0);
  await run(db, soldAt("hub1"));
  const row = db._get(`${ROWS}/trophy/p1/a`);
  assert.equal(row.status, "closed");
  assert.equal(row.closedVia, "pos_sale_hub");
  assert.match(Object.values(row.events).find((e) => e.what === "closed").detail.inferred, /empty/);
});

test("a HUB sale refuses when TWO walls claim the size, and says so", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set(`${ROWS}/marathon-pe/p1/b`, openRow({ rowId: "b", store: "marathon-pe" }));
  db._set("stock/hub1/p1/9/qty", 0);
  await run(db, soldAt("hub1"));
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "open");
  assert.equal(db._get(`${ROWS}/marathon-pe/p1/b`).status, "open");
  assert.match(db._get("settings/displayRows_meta/hub1/processed/m1").refused, /not knowable/);
});

test("a HUB sale refuses on a row that names no hub, and blames the right thing", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a", bookedHub: null }));
  db._set("stock/hub1/p1/9/qty", 0);
  await run(db, soldAt("hub1"));
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "open");
  assert.match(db._get("settings/displayRows_meta/hub1/processed/m1").refused, /names no hub/);
});

// THE "BEFORE IT SPENDS A READ" HALF WAS UNVERIFIABLE AS WRITTEN, and deleting
// the early `hubSaleTooOld` gate entirely left this green: `resolveHubSale`
// re-checks the same bound and emits a byte-identical string, which was all the
// test asserted. So the test proved the REFUSAL and claimed the ORDERING. The
// fake now counts reads, and the count is the assertion — the gate exists to
// stop a stale sale walking every display store's rows, and that is a cost, not
// a message. (Peer review, marathon-store-app-display-f8.)
test("a stale hub sale is refused BEFORE it spends a read, not merely refused", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set(`${ROWS}/marathon-pe/p1/a`, openRow({ rowId: "a", store: "marathon-pe" }));
  db._set("stock/hub1/p1/9/qty", 0);
  db._resetReads();
  await run(db, soldAt("hub1", { ts: "2026-09-08T09:50:00.000Z" }));   // 10 minutes old
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "open");
  assert.match(db._get("settings/displayRows_meta/hub1/processed/m1").refused, /too long to attribute/);
  // The age gate runs before the row walk. A fresh hub sale reads both display
  // stores' rows AND the hub cell; a stale one must read none of them.
  assert.equal(db._reads(), 0,
    `a refused stale sale still spent ${db._reads()} read(s) — the age gate has moved after the reads again`);
});

test("...and the same sale, fresh, DOES spend those reads — so the count above means something", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set(`${ROWS}/marathon-pe/p1/a`, openRow({ rowId: "a", store: "marathon-pe" }));
  db._set("stock/hub1/p1/9/qty", 0);
  db._resetReads();
  await run(db, soldAt("hub1"));
  assert.ok(db._reads() > 0, "a fresh hub sale read nothing — the control proves nothing");
});

// ── the mirror follows the ledger, never leads it ───────────────────────────
test("the slot is tombstoned only when the LAST open row goes", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set(`${ROWS}/trophy/p1/b`, openRow({ rowId: "b", size: "10", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z" }));
  db._set("settings/displaySlots/trophy/p1", { productId: "p1", size: "9", sizeKey: "9", bookedHub: "hub1", at: "2026-09-01T00:00:00.000Z" });
  await run(db, soldAt("trophy"));
  const slot = db._get("settings/displaySlots/trophy/p1");
  assert.equal(slot.sizeKey, "10", "a row survived, so the slot must point at it — not be cleared");
  assert.equal(db._get(`${ROWS}/trophy/p1/b`).status, "open");
});

test("and IS tombstoned, keeping its history, when nothing is left", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set("settings/displaySlots/trophy/p1", { productId: "p1", size: "9", sizeKey: "9", bookedHub: "hub1", at: "2026-09-01T00:00:00.000Z" });
  await run(db, soldAt("trophy"));
  const slot = db._get("settings/displaySlots/trophy/p1");
  assert.equal(slot.sizeKey, null);
  assert.equal(slot.prevSize, "9", "a tombstone keeps what it removed");
  assert.equal(slot.source, "display_sold");
});

// ── the cheap early returns ─────────────────────────────────────────────────
test("an unrelated movement touches nothing at all", async () => {
  for (const m of [
    soldAt("hub3"),                                   // Pine's hub — out of scope
    soldAt("central"),
    soldAt("trophy", { type: "received" }),
    soldAt("trophy", { type: "transfer_out", to: "hub1" }),   // never a display return
    soldAt("trophy", { size: "_" }),
    soldAt("trophy", { productId: null }),
  ]) {
    const db = makeDb();
    db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
    // eslint-disable-next-line no-await-in-loop
    await run(db, m);
    assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "open", JSON.stringify(m));
    assert.equal(db._get("settings/displayRows_meta"), undefined, "it should not even claim a lease");
  }
});

test("a movement with no readable instant refuses out loud instead of closing nothing quietly", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  await run(db, soldAt("trophy", { ts: 1788864000000 }));    // epoch millis, not ISO
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "open");
  assert.match(db._get("settings/displayRows_meta/trophy/processed/m1").refused, /no readable instant/);
});

// ─── THE MIRROR'S SURVIVOR BRANCH — four properties nothing asserted ─────────
//
// A mutation pass over the shipped harness found that two of the three
// production fixes it was written for were not actually covered by it: the
// survivor branch could be reverted to `source: "registration", orderId: null`
// and the refusal-reason branch could be turned to `if (false)`, and every test
// stayed green. Only the TOMBSTONE branch asserted provenance, and only the
// pure helper was tested for the refusal sentence — which is exactly how the
// original defects slipped through in the first place.
// (Peer review, marathon-store-app-display-f8.)

test("the survivor's OWN provenance is mirrored — not a blanket 'registration'", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));                       // sells
  db._set(`${ROWS}/trophy/p1/b`, openRow({                                       // survives
    rowId: "b", size: "10", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z",
    openedVia: "send", requestOrderId: "417",
  }));
  await run(db, soldAt("trophy"));
  const slot = db._get("settings/displaySlots/trophy/p1");
  assert.equal(slot.sizeKey, "10");
  // A till sale must not rewrite which order put the surviving pair on the wall.
  assert.equal(slot.source, "display_refill", "the survivor's send provenance was overwritten");
  assert.equal(slot.orderId, "417", "the survivor's originating order was dropped");
});

test("a survivor that was NOT sent reads as a registration, not a refill", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set(`${ROWS}/trophy/p1/b`, openRow({
    rowId: "b", size: "10", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z",
    openedVia: "wall_walk", requestOrderId: null,
  }));
  await run(db, soldAt("trophy"));
  const slot = db._get("settings/displaySlots/trophy/p1");
  assert.equal(slot.source, "registration");
  assert.equal(slot.orderId, null);
});

test("TWO survivors: the newest is mirrored, and the tiebreak matches the client's", async () => {
  // Every earlier fixture had exactly one survivor, so `stillOpen[length - 1]`
  // could be flipped to `[0]` and nothing noticed — while WHICH row the slot
  // mirrors is precisely the thing that drifts between the two writers.
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));                       // sells (size 9)
  db._set(`${ROWS}/trophy/p1/b`, openRow({ rowId: "b", size: "10", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z" }));
  db._set(`${ROWS}/trophy/p1/c`, openRow({ rowId: "c", size: "11", sizeKey: "11", openedAt: "2026-09-03T00:00:00.000Z" }));
  await run(db, soldAt("trophy"));
  assert.equal(db._get("settings/displaySlots/trophy/p1").sizeKey, "11",
    "the slot mirrored the OLDEST survivor; the wall shows the newest");
});

test("two survivors sharing an openedAt break on rowId — the SAME tiebreak openRowsFor uses", async () => {
  // Without the rowId tiebreak the order here is RTDB key order, and the client
  // and the trigger would mirror different survivors into the same slot. Two
  // rows can share an instant easily: a seed run, or two sends inside one tick.
  const SAME = "2026-09-02T00:00:00.000Z";
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));                       // sells
  db._set(`${ROWS}/trophy/p1/seedZ`, openRow({ rowId: "seedZ", size: "10", sizeKey: "10", openedAt: SAME }));
  db._set(`${ROWS}/trophy/p1/r001`, openRow({ rowId: "r001", size: "11", sizeKey: "11", openedAt: SAME }));
  await run(db, soldAt("trophy"));
  // "seedZ" > "r001" by localeCompare, so seedZ is last and is the survivor.
  assert.equal(db._get("settings/displaySlots/trophy/p1").sizeKey, "10",
    "the equal-instant tiebreak is not rowId, so the two writers can disagree");
});

test("an open survivor with NO `size` mirrors its sizeKey instead of throwing mid-write", async () => {
  // rowIsOpen requires a good sizeKey and says nothing about `size`, so a
  // hand-fixed or older-shape row can be open, be the survivor, and carry no
  // size. `size: keep.size` then handed the Admin SDK an undefined — a THROW,
  // landing AFTER the rows were closed with the lease still done:false on a
  // fresh `at`. A redelivery inside LEASE_MS aborts on that lease, so the slot
  // is never mirrored at all and no retry can fix it.
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));                       // sells
  const noSize = openRow({ rowId: "b", sizeKey: "10", openedAt: "2026-09-02T00:00:00.000Z" });
  delete noSize.size;
  db._set(`${ROWS}/trophy/p1/b`, noSize);
  await run(db, soldAt("trophy"));                                               // must not throw
  const slot = db._get("settings/displaySlots/trophy/p1");
  assert.equal(slot.sizeKey, "10");
  assert.equal(slot.size, "10", "size fell through as undefined — the real SDK rejects that");
  // and the movement is finished, so no redelivery is left wedged behind a lease
  assert.equal(db._get("settings/displayRows_meta/trophy/processed/m1").done, true);
});

test("THE REFUSAL SENTENCE IS WIRED, not just implemented — an undatable row is not called post-sale", async () => {
  // The branch that produces it could be turned to `if (false)` and every test
  // stayed green, because only the pure helper was covered. This drives the
  // trigger and reads what it actually wrote onto the lease.
  const db = makeDb();
  const undatable = openRow({ rowId: "a" });
  delete undatable.openedAt;
  db._set(`${ROWS}/trophy/p1/a`, undatable);
  await run(db, soldAt("trophy"));
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "open", "an undatable row was closed by a sale");
  const lease = db._get("settings/displayRows_meta/trophy/processed/m1");
  assert.match(lease.refused, /no readable registration time/);
  assert.doesNotMatch(lease.refused, /registered after this sale/,
    "the lease records a claim about this row that is false");
});

test("a genuinely post-sale row IS called post-sale, through the trigger", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a", openedAt: "2026-09-08T10:00:30.000Z" }));
  await run(db, soldAt("trophy"));
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "open");
  assert.match(db._get("settings/displayRows_meta/trophy/processed/m1").refused, /registered after this sale/);
});

// ─── IDENTITY IS THE KEY, NOT A STORED FIELD ────────────────────────────────
//
// Adding the rowId tiebreak was not enough. `Object.values` discarded the keys,
// so the trigger tiebroke on `row.rowId` — a stored field — while openRowsFor
// maps `Object.entries` and spreads `rowId` LAST, deliberately overriding the
// field with the key. They agreed only while field === key for every row, which
// nothing enforces and no close repairs (closeFields never rewrites it, so a
// wrong one is permanent once written).
//
// Every other fixture in this file writes openRow({ rowId: "a" }) to path
// .../a, so field and key are equal in all of them and the property is
// invisible by construction. These two are the only shapes that can fail.
// (Peer review, marathon-store-app-display-f8.)

test("a survivor whose rowId FIELD disagrees with its key is sorted by the KEY", async () => {
  const SAME = "2026-09-02T00:00:00.000Z";
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));                       // sells
  // Key "r001" carries a stale field "zzz"; key "seedZ" carries "aaa".
  // By KEY, seedZ sorts last and survives. By FIELD, r001 ("zzz") would.
  db._set(`${ROWS}/trophy/p1/r001`, openRow({ rowId: "zzz", size: "11", sizeKey: "11", openedAt: SAME }));
  db._set(`${ROWS}/trophy/p1/seedZ`, openRow({ rowId: "aaa", size: "10", sizeKey: "10", openedAt: SAME }));
  await run(db, soldAt("trophy"));
  assert.equal(db._get("settings/displaySlots/trophy/p1").sizeKey, "10",
    "the tiebreak used the stored rowId field; the client uses the key, so the two writers disagree");
});

test("a survivor with NO rowId field still sorts on its key, not on empty string", async () => {
  const SAME = "2026-09-02T00:00:00.000Z";
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));                       // sells
  const noField = openRow({ size: "10", sizeKey: "10", openedAt: SAME });
  delete noField.rowId;
  db._set(`${ROWS}/trophy/p1/zzz`, noField);                                     // key sorts LAST
  db._set(`${ROWS}/trophy/p1/bbb`, openRow({ rowId: "bbb", size: "11", sizeKey: "11", openedAt: SAME }));
  await run(db, soldAt("trophy"));
  // On the key, "zzz" > "bbb" so the fieldless row survives. Tiebreaking on the
  // field would make it "" — first, not last — and pick the other one.
  assert.equal(db._get("settings/displaySlots/trophy/p1").sizeKey, "10",
    "a row with no rowId field collapsed to empty string in the tiebreak");
});

// The differential against the CLIENT's openRowsFor lives on the src side
// (src/components/stock/displayRowFuzz.test.js): functions/ cannot import src/,
// and src/ is ESM with extensionless specifiers that require() cannot resolve.
// The shared rule it compares is lib.cjs's openRowsInOrder.

test("a sizeless HALF-size survivor mirrors 9.5, not the raw key 9_5", async () => {
  // The fallback added for the sizeless survivor wrote the RTDB-safe KEY into
  // the slot's HUMAN `size` field, so a 9.5 display became a slot reading
  // "9_5" — permanently, and on every screen that shows a slot size. Swapping
  // the word "undefined" for the string "9_5" is a better bug, not a fixed one.
  // (Adversarial review of PR #585.)
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));                       // sells
  const half = openRow({ rowId: "b", sizeKey: "9_5", openedAt: "2026-09-02T00:00:00.000Z" });
  delete half.size;
  db._set(`${ROWS}/trophy/p1/b`, half);
  await run(db, soldAt("trophy"));
  const slot = db._get("settings/displaySlots/trophy/p1");
  assert.equal(slot.size, "9.5");
  assert.equal(slot.sizeKey, "9_5");        // the KEY stays encoded, as it must
});

test("rowSizeText leaves letters and the one-size sentinel alone", () => {
  const { rowSizeText: f } = require("../displayRows/lib.cjs");
  assert.equal(f({ size: "9.5", sizeKey: "9_5" }), "9.5");   // its own size wins
  assert.equal(f({ sizeKey: "9_5" }), "9.5");
  assert.equal(f({ sizeKey: "M" }), "M");
  assert.equal(f({ sizeKey: "_" }), "_");
  assert.equal(f({ sizeKey: "ONE_SIZE" }), "ONE_SIZE");      // not a digit pair
  assert.equal(f({}), undefined);
});
