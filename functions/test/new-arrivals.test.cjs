// New Arrivals queue — trigger + callables against the fake RTDB, which
// reproduces the two behaviours that matter here: the cold-null first
// transaction call, and RTDB deleting empty containers (an empty array or
// object written anywhere simply is not there on read).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const core = require("../newArrivals/core.cjs");
const { _internals: na } = require("../newArrivals/newArrivals.js");

const NOW = 1_790_000_000_000;
const PID = "p1789999990000";
const upload = (over = {}) => ({
  id: PID, name: "Nike Air Force 1 Low Black", categoryKey: "sneakers", photoUrl: "https://x/photo.jpg",
  retailPrice: 650, sizes: ["6", "7", "8"], createdBy: { uid: "u1", deviceId: "d1", at: NOW - 2000 }, ...over,
});

test("enqueueDecision: only fresh uploads from the upload form", () => {
  assert.equal(core.enqueueDecision(PID, upload(), NOW).ok, true);
  assert.match(core.enqueueDecision(PID, upload({ createdBy: undefined }), NOW).why, /upload form/);
  assert.match(core.enqueueDecision(PID, upload({ createdBy: { at: NOW - core.ENQUEUE_WINDOW_MS - 1 } }), NOW).why, /too long ago/);
  assert.match(core.enqueueDecision(PID, upload({ createdBy: { at: NOW + core.ENQUEUE_SKEW_MS + 1 } }), NOW).why, /future/);
  assert.match(core.enqueueDecision(PID, upload({ mergedInto: "p1" }), NOW).why, /merged/);
  assert.match(core.enqueueDecision(PID, upload({ category: "Price Products" }), NOW).why, /price record/);
  assert.match(core.enqueueDecision("-Nabc", upload(), NOW).why, /not an uploaded product id/);
  // The upload form's marker: queued however late the trigger arrives.
  assert.equal(core.enqueueDecision(PID, upload({ newArrivalAt: NOW - 86_400_000, createdBy: { at: NOW - 86_400_000 } }), NOW).ok, true);
  assert.match(core.enqueueDecision(PID, upload({ newArrivalAt: NOW, mergedInto: "p1" }), NOW).why, /merged/);
});

test("enqueue writes the item and the New index, and is idempotent", async () => {
  const db = makeFakeDb({});
  assert.deepEqual(await na.enqueue(db, PID, upload(), NOW), { enqueued: true });
  const item = (await db.ref(`${core.ITEMS}/${PID}`).once()).val();
  assert.equal(item.status, "new");
  assert.equal(item.originalUrl, "https://x/photo.jpg");
  assert.equal((await db.ref(`${core.BY_STATUS}/new/${PID}`).once()).val(), NOW);
  // Redelivery never overwrites (the item may have moved on since).
  await db.ref(`${core.ITEMS}/${PID}/status`).set("ready");
  assert.deepEqual(await na.enqueue(db, PID, upload(), NOW + 1), { enqueued: false, why: "already queued" });
  assert.equal((await db.ref(`${core.ITEMS}/${PID}/status`).once()).val(), "ready");
});

test("enqueue omits absent optional fields instead of writing undefined", async () => {
  const db = makeFakeDb({});
  await na.enqueue(db, PID, upload({ photoUrl: undefined, categoryKey: undefined }), NOW);
  const item = (await db.ref(`${core.ITEMS}/${PID}`).once()).val();
  assert.equal("originalUrl" in item, false);
  assert.equal("categoryKey" in item, false);
});

function seeded(status, extra = {}) {
  return makeFakeDb({
    products: { [PID]: upload() },
    new_arrivals: {
      items: { [PID]: { pid: PID, status, enqueuedAt: NOW, statusAt: NOW, name: "x", attempts: 1, attemptsSinceRetry: 1, ...extra } },
      by_status: { [status]: { [PID]: NOW } },
    },
  });
}

test("approve survives the cold-null first transaction call", async () => {
  const db = seeded("ready", { generatedUrl: "https://x/gen.jpg" });
  const out = await na.approve(db, { pids: [PID] }, "junid", NOW + 5);
  assert.deepEqual(out, { approved: [PID], skipped: [] });
  const item = (await db.ref(`${core.ITEMS}/${PID}`).once()).val();
  assert.equal(item.status, "approved");
  assert.equal(item.approvedBy, "junid");
  // The Ready index entry is gone and, being the only child, so is by_status/ready.
  assert.equal((await db.ref(`${core.BY_STATUS}/ready`).once()).val(), null);
  assert.equal((await db.ref(`${core.BY_STATUS}/approved/${PID}`).once()).val(), NOW);
});

test("approve refuses an item with no generated photo — never an original", async () => {
  const db = seeded("ready");
  const out = await na.approve(db, { pids: [PID] }, "junid", NOW);
  assert.deepEqual(out.approved, []);
  assert.match(out.skipped[0].why, /no generated photo/);
});

test("approve refuses an item that is not Ready, and an unknown pid", async () => {
  const db = seeded("new");
  const out = await na.approve(db, { pids: [PID, "p1000000000001"] }, "junid", NOW);
  assert.deepEqual(out.approved, []);
  assert.match(out.skipped[0].why, /it is new/);
  assert.match(out.skipped[1].why, /not in the New Arrivals queue/);
  // The cold-null path for a truly absent item committed nothing.
  assert.equal((await db.ref(`${core.ITEMS}/p1000000000001`).once()).val(), null);
});

test("approve refuses an item with no retail price, in words", async () => {
  const db = seeded("ready", { generatedUrl: "g" });
  await db.ref(`products/${PID}/retailPrice`).set(null);
  const out = await na.approve(db, { pids: [PID] }, "junid", NOW);
  assert.deepEqual(out.approved, []);
  assert.match(out.skipped[0].why, /no retail price yet/);
  assert.equal((await db.ref(`${core.ITEMS}/${PID}/status`).once()).val(), "ready");
});

test("approve all takes exactly the Ready index", async () => {
  const db = seeded("ready", { generatedUrl: "g" });
  const out = await na.approve(db, { all: true }, "junid", NOW);
  assert.deepEqual(out.approved, [PID]);
});

test("retry: Rejected → New with a fresh budget; the rejection becomes history", async () => {
  const db = seeded("rejected", { generatedUrl: "g", rejection: { code: "checker", reason: "box changed", at: NOW }, checker: { pass: false } });
  assert.deepEqual(await na.retry(db, PID, "junid", NOW + 9), { ok: true });
  const item = (await db.ref(`${core.ITEMS}/${PID}`).once()).val();
  assert.equal(item.status, "new");
  assert.equal(item.attemptsSinceRetry, 0);
  assert.equal(item.attempts, 1, "total attempts are kept for the record");
  assert.equal(item.lastRejection.reason, "box changed");
  assert.equal("rejection" in item, false);
  assert.equal("generatedUrl" in item, false, "a retry never reuses the previous generation");
  assert.equal("checker" in item, false);
  assert.equal((await db.ref(`${core.BY_STATUS}/rejected`).once()).val(), null);
});

test("retry after a chain refusal clears the old lap (chain stamps, name, destinations)", async () => {
  const db = seeded("rejected", { generatedUrl: "g-old", suggestedName: "Old", nameProposedAt: 5,
    chain: { photo: { at: 1 }, publish: { at: 2 } }, destinations: { shopify: { at: 3 } }, rejection: { code: "chain", reason: "x", at: 4 } });
  await na.retry(db, PID, "junid", NOW);
  const item = (await db.ref(`${core.ITEMS}/${PID}`).once()).val();
  for (const k of ["chain", "suggestedName", "nameProposedAt", "destinations", "generatedUrl"]) assert.equal(k in item, false, k);
});

test("a redelivered enqueue repairs a missing index entry", async () => {
  const db = makeFakeDb({ new_arrivals: { items: { [PID]: { pid: PID, status: "ready", enqueuedAt: 7 } } } });
  // Even a delivery far outside the window repairs it.
  assert.equal((await na.enqueue(db, PID, upload({ createdBy: { at: 1 } }), NOW)).enqueued, false);
  assert.equal((await db.ref(`${core.BY_STATUS}/ready/${PID}`).once()).val(), 7);
});

test("retry refuses anything not Rejected", async () => {
  const db = seeded("ready", { generatedUrl: "g" });
  await assert.rejects(na.retry(db, PID, "junid", NOW), /it is ready/);
});

test("listTab joins live product price/sizes and repairs a stale index entry", async () => {
  const db = seeded("ready", { generatedUrl: "g" });
  // A stale entry: listed under ready but the item has moved to approved.
  await db.ref(`${core.ITEMS}/p1789999990001`).set({ pid: "p1789999990001", status: "approved", enqueuedAt: NOW, statusAt: NOW });
  await db.ref(`${core.BY_STATUS}/ready/p1789999990001`).set(NOW);
  const out = await na.listTab(db, "ready", 10);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].product.retailPrice, 650);
  assert.deepEqual(out.items[0].product.sizes, ["6", "7", "8"]);
  assert.equal((await db.ref(`${core.BY_STATUS}/ready/p1789999990001`).once()).val(), null);
  assert.equal((await db.ref(`${core.BY_STATUS}/approved/p1789999990001`).once()).val(), NOW);
});

test("an item whose destinations were written as empty arrays reads back without them", async () => {
  // RTDB drops [] — the Done tab must cope with destinations simply absent.
  const db = seeded("done", { destinations: { groups: [], shopify: { at: NOW } } });
  const out = await na.listTab(db, "done", 10);
  assert.equal(out.items.length, 1);
  assert.equal("groups" in out.items[0].destinations, false);
  assert.equal(out.items[0].destinations.shopify.at, NOW);
});

test("listTab rejects an unknown tab; access gate fails closed", async () => {
  await assert.rejects(na.listTab(makeFakeDb({}), "bogus", 10), /Unknown tab/);
  const db = makeFakeDb({ users: { u1: { permFlags: { shopify_publish: true } } } });
  await na.assertNewArrivalsAccess({ auth: { uid: "u1", token: {} } }, db);
  await assert.rejects(na.assertNewArrivalsAccess({ auth: { uid: "u2", token: {} } }, db), /Shopify Publishing permission/);
  await assert.rejects(na.assertNewArrivalsAccess({}, db), /Sign in required/);
  const broken = { ref: () => ({ once: async () => { throw new Error("offline"); } }) };
  await assert.rejects(na.assertNewArrivalsAccess({ auth: { uid: "u1", token: {} } }, broken), /Could not check/);
  await na.assertNewArrivalsAccess({ auth: { uid: "x", token: { email: "gunidmoh@gmail.com" } } }, broken);
});

test("productSummary tolerates RTDB-sparse sizes (index-keyed object)", () => {
  assert.deepEqual(core.productSummary({ sizes: { 0: "6", 2: "8" } }).sizes, ["6", "8"]);
  assert.deepEqual(core.productSummary({ sizes: ["6", null, "8"] }).sizes, ["6", "8"]);
  assert.equal(core.productSummary({ retailPrice: "abc" }).retailPrice, null);
});
