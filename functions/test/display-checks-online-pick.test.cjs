// ─── DISPLAY CHECKS — the WEBSITE ORDER pick (kind "online_pick") ────────────
// A website order line routed to a shop's floor arrives as a display-check-
// shaped record (docs/ONLINE-ORDERS.md). These pin the four claims that make it
// safe to ride the display-check machinery:
//   1. It closes ONLY with "handed" / "not_found"; a display check ONLY with
//      "confirmed" / "no_stock". Neither takes the other's verdict.
//   2. A completion flips the ORDER LINE too — handed, or not_found + the
//      order's attention — and the call is not ok until that write landed.
//   3. A retry of an already-completed pick re-applies the order write
//      (heal), and is a no-op in effect: it never strips the poller's
//      mailedAt, so Junid is never mailed twice for one "Not found".
//   4. The pack sale (channel "online") never raises a display check, through
//      the REAL onClothingSale handler.
// Run: cd functions && npm test

"use strict";
process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || "127.0.0.1:9";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const lib = require("../displayChecks/lib.cjs");
const { runComplete } = require("../displayChecks/completeCheck.js");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const NOW = Date.parse("2026-10-21T09:00:00.000Z");
const STORE = "marathon-pe";
const KEY = "online__5550001__1";
const ACTOR = { uid: "u-nomusa", name: "Nomusa", email: "nomusa@marathon.internal" };

const pickRecord = (over = {}) => ({
  checkId: "online__5550001__1", productId: "p9", productName: "Boss Tee", size: "M", sizeKey: "M",
  photoUrl: "https://x/p9.jpg", status: "open", activatedAt: NOW - 600e3, activatedSaDate: "2026-10-21",
  assignedTo: null, createdAt: NOW - 600e3,
  kind: "online_pick", ref: "WEB-1042", orderId: "5550001", lineIndex: 1, qty: 1, dedupeKey: KEY,
  instruction: "Give to Yasmin at Marathon PE", ...over,
});
const order = (over = {}) => ({
  ref: "WEB-1042", status: "picking",
  customer: { name: "Thandi M" },
  lines: [
    { lineId: "l0", pid: "p1", size: "9", qty: 1, source: { locationId: "hub1", status: "pick", entryKey: "x" } },
    { lineId: "l1", pid: "p9", size: "M", qty: 1, source: { locationId: STORE, status: "display", entryKey: `displayChecks_active/${STORE}/${KEY}` } },
  ],
  ...over,
});
const world = (record = pickRecord(), ord = order()) => makeFakeDb({
  displayChecks_active: { [STORE]: { [KEY]: record } },
  online_orders: { "5550001": ord },
  stock: { [STORE]: { p9: { M: { qty: 3 } } } },
});
const call = (db, over = {}) => runComplete(db, {
  store: STORE, key: KEY, checkId: "online__5550001__1", result: "handed", override: false,
  actor: ACTOR, nowMs: NOW, storeName: "Marathon PE", ...over,
});
const line = (db) => db.state.root.online_orders["5550001"].lines["1"];
const ord = (db) => db.state.root.online_orders["5550001"];

// Make the next N root multi-path updates throw (the order write), leave every
// other write alone.
function failRootUpdates(db, n) {
  const inner = db.ref.bind(db);
  let left = n;
  db.ref = (p = "") => {
    const r = inner(p);
    if (p !== "") return r;
    return { ...r, async update(patch) { if (left > 0) { left--; throw new Error("network"); } return r.update(patch); } };
  };
}

// ── 1. the verdicts fit the kind ─────────────────────────────────────────────
test("the mirrored constants match src/utils/onlineOrders.js (functions cannot import the ES module)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "utils", "onlineOrders.js"), "utf8");
  assert.match(src, new RegExp(`ONLINE_PICK_KIND = "${lib.ONLINE_PICK_KIND}"`));
  assert.match(src, /ONLINE_ORDERS_PATH = "online_orders"/);
  assert.match(src, /HANDED: "handed"/);
  assert.match(src, /NOT_FOUND: "not_found"/);
});

test("completionDecision: an online pick takes handed/not_found only; a display check takes confirmed/no_stock only", () => {
  const pick = pickRecord();
  const disp = { checkId: "c", status: "open" };
  const d = (record, result, stockQty = 0) => lib.completionDecision({ record, expectedCheckId: record.checkId, result, override: false, stockQty });
  assert.deepEqual(d(pick, "handed"), { kind: "complete", overridden: false });
  // No soft-block for an online pick, even with stock on the cell.
  assert.deepEqual(d(pick, "not_found", 5), { kind: "complete", overridden: false });
  assert.deepEqual(d(pick, "confirmed"), { kind: "reject", code: "wrong-kind" });
  assert.deepEqual(d(pick, "no_stock", 5), { kind: "reject", code: "wrong-kind" });
  assert.deepEqual(d(disp, "handed"), { kind: "reject", code: "wrong-kind" });
  assert.deepEqual(d(disp, "not_found"), { kind: "reject", code: "wrong-kind" });
  assert.deepEqual(d(disp, "bogus"), { kind: "reject", code: "bad-result" });
  assert.deepEqual(d(disp, "confirmed"), { kind: "complete", overridden: false });
  assert.equal(d(disp, "no_stock", 2).kind, "needs_override"); // display check unchanged
});

test("a display verdict on an online pick is REFUSED by runComplete — record still open, order untouched, nothing archived", async () => {
  const db = world();
  const before = JSON.stringify(ord(db));
  for (const result of ["confirmed", "no_stock"]) {
    const r = await call(db, { result });
    assert.deepEqual(r, { kind: "reject", code: "wrong-kind" });
  }
  assert.equal(db.state.root.displayChecks_active[STORE][KEY].status, "open");
  assert.equal(JSON.stringify(ord(db)), before);
  assert.equal(db.state.root.displayChecks, undefined);
});

test("an online verdict on a normal display check is refused the same way", async () => {
  const db = makeFakeDb({ displayChecks_active: { [STORE]: { p1__M: { checkId: "cA", productId: "p1", size: "M", status: "open" } } } });
  const r = await runComplete(db, { store: STORE, key: "p1__M", checkId: "cA", result: "handed", actor: ACTOR, nowMs: NOW });
  assert.deepEqual(r, { kind: "reject", code: "wrong-kind" });
  assert.equal(db.state.root.displayChecks_active[STORE].p1__M.status, "open");
});

// ── 2. the order line follows the verdict ────────────────────────────────────
test("handed: tombstone + archive + log type completed_handed, AND the order line is handed (who, when)", async () => {
  const db = world();
  const r = await call(db, { result: "handed" });
  assert.equal(r.kind, "ok");
  const rec = db.state.root.displayChecks_active[STORE][KEY];
  assert.equal(rec.status, "completed");
  assert.equal(rec.result, "handed");
  assert.equal(rec.stockAtClose, undefined);                      // no stock evidence on a pick
  assert.equal(db.state.root.displayChecks[STORE]["2026-10-21"][KEY].result, "handed");
  assert.equal(db.state.root.displayChecks_log[STORE]["2026-10"][`${KEY}_completed`].type, "completed_handed");
  assert.deepEqual(line(db).source, { locationId: STORE, status: "handed", entryKey: `displayChecks_active/${STORE}/${KEY}`, handedAt: NOW, handedBy: "u-nomusa" });
  assert.equal(ord(db).lines["0"].source.status, "pick");        // the other line is not touched
  assert.equal(ord(db).attention, undefined);
  assert.equal(ord(db).status, "picking");                         // the poller recomputes it
});

test("not_found: the line is not_found, the order needs attention with a reason naming the store, product and size", async () => {
  const db = world();
  const r = await call(db, { result: "not_found" });
  assert.equal(r.kind, "ok");
  assert.equal(db.state.root.displayChecks_log[STORE]["2026-10"][`${KEY}_completed`].type, "completed_not_found");
  assert.equal(line(db).source.status, "not_found");
  assert.deepEqual(ord(db).attention, { kind: "not_found", reason: "Not found at Marathon PE (Boss Tee size M)", at: NOW });
  assert.equal(ord(db).attentionOpen, true);
  assert.equal(ord(db).status, "needs_attention");
});

test("the store name falls back to the registry seed when the caller passes none", async () => {
  const db = world(pickRecord({ size: "_" }));
  await call(db, { result: "not_found", storeName: undefined });
  assert.equal(ord(db).attention.reason, "Not found at Marathon PE (Boss Tee)");
});

test("an order that has moved on is NOT touched: packed, cancelled, a cancelled line, a line rerouted elsewhere or sent to reroute", async () => {
  const cases = [
    order({ status: "packed" }),
    order({ status: "cancelled" }),
    order({ lines: [order().lines[0], { ...order().lines[1], source: { locationId: STORE, status: "cancelled" } }] }),
    order({ lines: [order().lines[0], { ...order().lines[1], source: { locationId: "trophy", status: "display" } }] }),
    order({ lines: [order().lines[0], { ...order().lines[1], source: { locationId: STORE, status: "reroute" } }] }),
  ];
  for (const o of cases) {
    const db = world(pickRecord(), o);
    const before = JSON.stringify(ord(db));
    const r = await call(db, { result: "not_found" });
    assert.equal(r.kind, "ok");                                     // the pick itself is answered
    assert.equal(JSON.stringify(ord(db)), before);
  }
});

// ── 3. the heal path ─────────────────────────────────────────────────────────
test("the order write fails → NOT ok (retryable); a retry against the tombstone heals it", async () => {
  const db = world();
  failRootUpdates(db, 3);                                           // all three in-call attempts fail
  const r1 = await call(db, { result: "handed" });
  assert.deepEqual(r1, { kind: "reject", code: "archive-failed" });
  assert.equal(db.state.root.displayChecks_active[STORE][KEY].status, "completed"); // flip committed
  assert.equal(line(db).source.status, "display");                  // order not yet told
  const r2 = await call(db, { result: "handed" });
  assert.deepEqual(r2, { kind: "reject", code: "already-completed" }); // write-once stands…
  assert.equal(line(db).source.status, "handed");                   // …and the order line healed
  assert.equal(line(db).source.handedAt, NOW);                      // stamped from the RECORD, not the retry
});

test("a retry of a completed not_found is idempotent: same values, attention kept, the poller's mailedAt NOT stripped", async () => {
  const db = world();
  await call(db, { result: "not_found" });
  // The poller mails Junid and stamps mailedAt.
  await db.ref(`online_orders/5550001/attention/mailedAt`).set(NOW + 60e3);
  const before = JSON.stringify(ord(db));
  const r = await call(db, { result: "not_found", nowMs: NOW + 120e3 });
  assert.deepEqual(r, { kind: "reject", code: "already-completed" });
  assert.equal(JSON.stringify(ord(db)), before);
  assert.equal(ord(db).attention.mailedAt, NOW + 60e3);
});

test("a retry AFTER Settings → Resolve (line sent to reroute, attention cleared) does not reopen the attention", async () => {
  const db = world();
  await call(db, { result: "not_found" });
  await db.ref().update({
    "online_orders/5550001/lines/1/source/status": "reroute",
    "online_orders/5550001/attention": null, "online_orders/5550001/attentionOpen": null,
    "online_orders/5550001/status": "new",
  });
  await call(db, { result: "not_found" });
  assert.equal(ord(db).attention, undefined);
  assert.equal(ord(db).attentionOpen, undefined);
  assert.equal(line(db).source.status, "reroute");
});

test("a re-routed line (fresh entry key, same shop) is never flipped by the entry it had before", () => {
  const done = { ...pickRecord(), status: "completed", result: "not_found", completedAt: NOW, completedBy: { uid: "u" } };
  const rerouted = order({ lines: [
    order().lines[0],
    { lineId: "l1", pid: "p9", size: "M", qty: 1, routeGen: 1, source: { locationId: STORE, status: "display", entryKey: `displayChecks_active/${STORE}/${KEY}_r1` } },
  ] });
  assert.deepEqual(lib.onlineOrderOutcomeUpdates({ record: done, store: STORE, order: rerouted }), { skip: "stale-entry" });
  // …while the line's own current entry still lands.
  const current = { ...done, dedupeKey: `${KEY}_r1` };
  assert.ok(lib.onlineOrderOutcomeUpdates({ record: current, store: STORE, order: rerouted }).updates);
});

test("onlineOrderOutcomeUpdates is pure and refuses a malformed record or a non-pick", () => {
  const done = { ...pickRecord(), status: "completed", result: "handed", completedAt: NOW, completedBy: ACTOR };
  assert.deepEqual(lib.onlineOrderOutcomeUpdates({ record: { ...done, kind: undefined }, store: STORE, order: order() }), { skip: "not-online-pick" });
  assert.deepEqual(lib.onlineOrderOutcomeUpdates({ record: { ...done, status: "open" }, store: STORE, order: order() }), { skip: "not-completed" });
  assert.deepEqual(lib.onlineOrderOutcomeUpdates({ record: { ...done, orderId: "a/b" }, store: STORE, order: order() }), { skip: "bad-record" });
  assert.deepEqual(lib.onlineOrderOutcomeUpdates({ record: { ...done, lineIndex: "x" }, store: STORE, order: order() }), { skip: "bad-record" });
  assert.deepEqual(lib.onlineOrderOutcomeUpdates({ record: done, store: STORE, order: null }), { skip: "no-order" });
  assert.deepEqual(lib.onlineOrderOutcomeUpdates({ record: { ...done, lineIndex: 7 }, store: STORE, order: order() }), { skip: "no-line" });
  // A record with no completedBy writes handedBy null (a delete), never undefined (an SDK throw).
  const u = lib.onlineOrderOutcomeUpdates({ record: { ...done, completedBy: null }, store: STORE, order: order() }).updates;
  assert.equal(u["online_orders/5550001/lines/1/source/handedBy"], null);
  assert.ok(Object.values(u).every((v) => v !== undefined));
});

test("wakeHeldChecks re-applies a stranded order write before it reaps a prior-day online_pick tombstone", async () => {
  const { runWakeSweep } = require("../displayChecks/wakeHeldChecks.js");
  const { __resetNetworkCacheForTests } = require("../lib/network-load.cjs");
  const { __resetDisplaySettingsCacheForTests } = require("../displayChecks/settings.cjs");
  __resetNetworkCacheForTests(); __resetDisplaySettingsCacheForTests();
  const tomb = { ...pickRecord(), status: "completed", result: "handed", completedAt: NOW, completedSaDate: "2026-10-21", completedBy: ACTOR };
  const db = world(tomb);                                           // flip landed, order write never did
  const r = await runWakeSweep({ db, nowMs: NOW + 24 * 3600e3 });
  assert.equal(r.reaped, 1);
  assert.equal(line(db).source.status, "handed");
  assert.equal(line(db).source.handedAt, NOW);
  assert.equal(db.state.root.displayChecks[STORE]["2026-10-21"][KEY].result, "handed");
});

// ── 4. the pack sale raises no display check (the real trigger) ──────────────
test("isOnlineSaleChannel / saleChannelPath: exact string, key-safe ids only", () => {
  assert.equal(lib.isOnlineSaleChannel("online"), true);
  for (const c of [null, undefined, "", "Online", "till", "pos"]) assert.equal(lib.isOnlineSaleChannel(c), false);
  assert.equal(lib.saleChannelPath("-OabC1"), "pos/sales/-OabC1/channel");
  for (const id of [null, undefined, "", 42, "a/b", "a.b", "a#b", "a$b", "a[b"]) assert.equal(lib.saleChannelPath(id), null);
  // the onDisplaySale path (sale object in hand) skips the pack sale too
  const sale = { type: "sale", status: "completed", storeId: "concrete", channel: "online",
                 lineItems: { L1: { productId: "tee", size: "M", qty: 1 } } };
  assert.deepEqual(lib.saleLinesForDisplay({ sale, network: null }), []);
  assert.equal(lib.saleLinesForDisplay({ sale: { ...sale, channel: undefined }, network: null }).length, 1);
});

function loadOnClothingSale(db) {
  const adminPath = require.resolve("firebase-admin");
  const fnPath = require.resolve("firebase-functions/v2/database");
  const triggerPath = require.resolve("../displayChecks/onClothingSale.js");
  const stub = (filename, exports) => ({ id: filename, filename, path: path.dirname(filename), loaded: true, exports, children: [], paths: [] });
  const saved = { admin: require.cache[adminPath], fn: require.cache[fnPath] };
  delete require.cache[triggerPath];
  require.cache[adminPath] = stub(adminPath, { apps: [{}], initializeApp() {}, database: () => db });
  require.cache[fnPath] = stub(fnPath, { onValueCreated: (_opts, handler) => handler });
  try { return require(triggerPath).onClothingSale; }
  finally {
    delete require.cache[triggerPath];
    if (saved.admin) require.cache[adminPath] = saved.admin; else delete require.cache[adminPath];
    if (saved.fn) require.cache[fnPath] = saved.fn; else delete require.cache[fnPath];
  }
}

function saleWorld(channel) {
  require("../lib/network-load.cjs").__resetNetworkCacheForTests();
  require("../displayChecks/settings.cjs").__resetDisplaySettingsCacheForTests();
  const reads = [];
  const db = makeFakeDb({
    products: { tee: { id: "tee", name: "Tee", productType: "clothing", category: "Clothing", sizes: ["M"] } },
    stock: { [STORE]: { tee: { M: { qty: 2 } } } },
    pos: { sales: { S1: { storeId: "pe", ...(channel ? { channel } : {}) } } },
  }, { beforeRead: (p) => { reads.push(p); } });
  return { db, reads };
}
const soldEvt = (over = {}) => ({
  data: { val: () => ({ type: "sold", from: STORE, productId: "tee", size: "M", qty: 1, ts: "2026-10-21T09:00:00.000Z", link: { saleId: "S1" }, ...over }) },
  params: { movementId: "mv1" },
});

test("onClothingSale (the real handler): the pack sale's sold movement raises NO display check", async () => {
  const { db, reads } = saleWorld("online");
  await loadOnClothingSale(db)(soldEvt());
  assert.equal(db.state.root.displayChecks_active, undefined);
  assert.ok(reads.includes("pos/sales/S1/channel"));               // one exact read…
  assert.ok(!reads.includes("pos/sales/S1") && !reads.includes("pos/sales")); // …never the sale or the node
});

test("onClothingSale: a till sale (no channel) still raises its check, and a movement with no sale link reads no channel", async () => {
  {
    const { db } = saleWorld(null);
    await loadOnClothingSale(db)(soldEvt());
    assert.equal(db.state.root.displayChecks_active[STORE]["tee__M"].status, "open");
  }
  {
    const { db, reads } = saleWorld("online");
    await loadOnClothingSale(db)(soldEvt({ link: undefined }));
    assert.ok(!reads.some((p) => p.startsWith("pos/")));
    assert.equal(db.state.root.displayChecks_active[STORE]["tee__M"].status, "open");
  }
});

test("onClothingSale: a sneaker sale never even reads the channel (the existing skips come first)", async () => {
  const { db, reads } = saleWorld("online");
  await db.ref("products/shoe").set({ id: "shoe", productType: "sneaker", category: "Footwear" });
  await loadOnClothingSale(db)(soldEvt({ productId: "shoe", size: "9" }));
  assert.ok(!reads.some((p) => p.startsWith("pos/")));
});
