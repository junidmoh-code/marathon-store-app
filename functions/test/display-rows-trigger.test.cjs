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
function makeDb() {
  let root = {};
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
    async get() { const v = at(p); return { val: () => (v === undefined ? null : v) }; },
    async transaction(fn) {
      const h = hooks.get(p);
      if (h) { hooks.delete(p); h(); }
      const cur = at(p);
      const next = fn(cur === undefined ? null : cur);
      if (next === undefined) return { committed: false, snapshot: { val: () => (cur === undefined ? null : cur) } };
      put(p, next);
      return { committed: true, snapshot: { val: () => next } };
    },
    async update(obj) {
      if (!p) { for (const [k, v] of Object.entries(obj)) put(k, v); return; }
      for (const [k, v] of Object.entries(obj)) put(`${p}/${k}`, v);
    },
  });
  return { ref, _root: () => root, _set: (p, v) => put(p, v), _get: at,
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

test("a stale hub sale is refused before it spends a single read", async () => {
  const db = makeDb();
  db._set(`${ROWS}/trophy/p1/a`, openRow({ rowId: "a" }));
  db._set("stock/hub1/p1/9/qty", 0);
  await run(db, soldAt("hub1", { ts: "2026-09-08T09:50:00.000Z" }));   // 10 minutes old
  assert.equal(db._get(`${ROWS}/trophy/p1/a`).status, "open");
  assert.match(db._get("settings/displayRows_meta/hub1/processed/m1").refused, /too long to attribute/);
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
