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
  stockPrice: 550, retailPrice: 650, sizes: ["6", "7", "8"], createdBy: { uid: "u1", deviceId: "d1", at: NOW - 2000 }, ...over,
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

test("approve refuses an item with no stock price, in words", async () => {
  for (const stockPrice of [null, 0, "abc"]) {
    const db = seeded("ready", { generatedUrl: "g" });
    await db.ref(`products/${PID}/stockPrice`).set(stockPrice);
    const out = await na.approve(db, { pids: [PID] }, "junid", NOW);
    assert.deepEqual(out.approved, []);
    assert.deepEqual(out.skipped, [{ pid: PID, why: "no stock price yet — enter it on the card, then approve" }]);
    assert.equal((await db.ref(`${core.ITEMS}/${PID}/status`).once()).val(), "ready");
  }
});

test("approve does not need a retail price — the groups are priced at the stock price", async () => {
  const db = seeded("ready", { generatedUrl: "g" });
  await db.ref(`products/${PID}/retailPrice`).set(null);
  const out = await na.approve(db, { pids: [PID] }, "junid", NOW);
  assert.deepEqual(out.approved, [PID]);
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
  const out = await na.listTab(db, "ready", { limit: 10 });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].product.retailPrice, 650);
  assert.deepEqual(out.items[0].product.sizes, ["6", "7", "8"]);
  assert.equal((await db.ref(`${core.BY_STATUS}/ready/p1789999990001`).once()).val(), null);
  assert.equal((await db.ref(`${core.BY_STATUS}/approved/p1789999990001`).once()).val(), NOW);
});

test("an item whose destinations were written as empty arrays reads back without them", async () => {
  // RTDB drops [] — the Done tab must cope with destinations simply absent.
  const db = seeded("done", { destinations: { groups: [], shopify: { at: NOW } } });
  const out = await na.listTab(db, "done", { limit: 10 });
  assert.equal(out.items.length, 1);
  assert.equal("groups" in out.items[0].destinations, false);
  assert.equal(out.items[0].destinations.shopify.at, NOW);
});

test("listTab rejects an unknown tab; access gate fails closed", async () => {
  await assert.rejects(na.listTab(makeFakeDb({}), "bogus", { limit: 10 }), /Unknown tab/);
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

// ─── CALIBRATION: paging, filters, skip/restore, generate, reject, ledger ────
const pid = (i) => `p17899999${String(i).padStart(5, "0")}`;
function lane(n, { status = "new", product = () => ({}), item = () => ({}), extra = {} } = {}) {
  const items = {}, idx = {}, products = {};
  for (let i = 0; i < n; i++) {
    const k = pid(i);
    items[k] = { pid: k, status, enqueuedAt: NOW + i, statusAt: NOW + i, name: `item ${i}`, categoryKey: "sneakers", ...item(i) };
    idx[k] = NOW + i;
    products[k] = { name: `item ${i}`, categoryKey: "sneakers", stockPrice: 500, sizes: ["7", "8"], ...product(i) };
  }
  return makeFakeDb({
    locations: { central: { name: "Central" }, hub1: { name: "Hub 1" }, hub3: { name: "Hub 3" }, in_transit: { name: "Transit" } },
    products, ...extra,
    new_arrivals: { items, by_status: { [status]: idx }, ...(extra.new_arrivals || {}) },
  });
}
const decisions = async (db) => Object.values((await db.ref(core.DECISIONS).once()).val() || {});

test("list pages 30 at a time by key with a cursor, and reports the total", async () => {
  const db = lane(75);
  const p1 = await na.listTab(db, "new", {});
  assert.equal(p1.items.length, 30);
  assert.equal(p1.total, 75);
  assert.equal(p1.tabCounts.new, 75);
  assert.equal(p1.items[0].pid, pid(0));
  assert.equal(p1.nextCursor, pid(29));
  const p2 = await na.listTab(db, "new", { cursor: p1.nextCursor });
  assert.equal(p2.items[0].pid, pid(30));
  const p3 = await na.listTab(db, "new", { cursor: p2.nextCursor });
  assert.equal(p3.items.length, 15);
  assert.equal(p3.nextCursor, null);
  const all = [...p1.items, ...p2.items, ...p3.items].map((i) => i.pid);
  assert.equal(new Set(all).size, 75, "no item twice, none missed");
  assert.equal(p1.matchingPids.length, 75, "select-all covers the whole lane, not the page");
});

test("the New tab merges new + generating; generating is never select-all'd", async () => {
  const db = lane(3);
  await db.ref(`${core.ITEMS}/${pid(1)}/status`).set("generating");
  await db.ref(`${core.BY_STATUS}/new/${pid(1)}`).set(null);
  await db.ref(`${core.BY_STATUS}/generating/${pid(1)}`).set(NOW);
  const out = await na.listTab(db, "new", { limit: 2 });
  assert.deepEqual(out.items.map((i) => i.pid), [pid(0), pid(1)]);
  assert.equal(out.total, 3);
  assert.equal(out.nextCursor, pid(1));
  assert.deepEqual(out.matchingPids, [pid(0), pid(2)]);
});

test("each item carries sizes in stock and units, keyed per location; excluded locations never count", async () => {
  const db = lane(1, { extra: { stock: {
    central: { [pid(0)]: { 7: { qty: 2 }, 9: { qty: 5 } } },   // 9 is not a catalogue size
    hub1: { [pid(0)]: { 7: 1, 8: { qty: 0 } } },
    hub3: { [pid(0)]: { 8: { qty: 4 } } },                       // untrusted — not counted
  } } });
  const [it] = (await na.listTab(db, "new", {})).items;
  assert.deepEqual(it.availableSizes, ["7"]);
  assert.equal(it.totalUnits, 3);
  assert.equal(it.stockKnown, true);
  assert.deepEqual(it.product.sizes, ["7", "8"]);
});

test("stockSummary's total is exactly social-select availableUnits", () => {
  const { availableUnits } = require("../lib/social-select.cjs");
  const tree = { central: { "Free_Size": { qty: 3 }, _: { qty: 2 } }, in_transit: { _: 9 } };
  const s = core.stockSummary(["Free Size"], tree);
  assert.equal(s.totalUnits, availableUnits(tree, ["Free Size"]));
  assert.deepEqual(s.availableSizes, ["Free Size"]);
  assert.deepEqual(core.stockSummary(["6"], {}), { availableSizes: [], totalUnits: 0, stockKnown: false });
});

test("filters: one size, category chip, no stock price — total is the filtered count", async () => {
  const keys = ["sneakers", "slides", "t-shirts", "tracksuits", "sandals", "boots", "mystery"];
  const db = lane(7, {
    product: (i) => ({ categoryKey: keys[i], stockPrice: i % 2 ? null : 400, sizes: i === 0 ? ["9"] : ["7", "8"] }),
    extra: { stock: { central: { [pid(1)]: { 7: { qty: 1 } }, [pid(2)]: { 7: 1, 8: 2 } } } },
  });
  const ids = (o) => o.items.map((i) => i.pid);
  // oneSize: pid0 has one catalogue size and no stock known; pid1 has stock in one size only.
  const one = await na.listTab(db, "new", { filter: { oneSize: true } });
  assert.deepEqual(ids(one), [pid(0), pid(1)]);
  assert.equal(one.total, 2);
  assert.deepEqual(one.matchingPids, [pid(0), pid(1)]);
  assert.deepEqual(ids(await na.listTab(db, "new", { filter: { cls: "sneakers" } })), [pid(0), pid(5)]);
  assert.deepEqual(ids(await na.listTab(db, "new", { filter: { cls: "slides" } })), [pid(1), pid(4)]);
  assert.deepEqual(ids(await na.listTab(db, "new", { filter: { cls: "clothing" } })), [pid(2)]);
  assert.deepEqual(ids(await na.listTab(db, "new", { filter: { cls: "twopiece" } })), [pid(3)]);
  assert.deepEqual(ids(await na.listTab(db, "new", { filter: { noStockPrice: true } })), [pid(1), pid(3), pid(5)]);
  assert.deepEqual(ids(await na.listTab(db, "new", { filter: { noStockPrice: true, cls: "slides" } })), [pid(1)]);
  // A filtered page still pages.
  const pg = await na.listTab(db, "new", { filter: { noStockPrice: true }, limit: 2 });
  assert.equal(pg.nextCursor, pid(3));
  assert.deepEqual(ids(await na.listTab(db, "new", { filter: { noStockPrice: true }, limit: 2, cursor: pg.nextCursor })), [pid(5)]);
});

test("class + filter mapping", () => {
  assert.equal(core.CLASS_OF("slides"), "footwear");
  assert.equal(core.CLASS_OF("tracksuits"), "twopiece");
  assert.equal(core.CLASS_OF("hoodies"), "single");
  assert.equal(core.CLASS_OF("caps"), null);
  assert.equal(core.filterClassOf("running-shoes"), "sneakers");
  assert.equal(core.filterClassOf("sandals"), "slides");
  assert.equal(core.normalizeFilter({ cls: "bogus" }), null);
});

test("list returns stats and modes for the header", async () => {
  const stats = { updatedAt: 1, agreement: { footwear: { pct: 83, n: 30, window: 30 } } };
  const db = lane(1, { extra: { new_arrivals: { stats, config: { mode: { footwear: "auto" } } } } });
  const out = await na.listTab(db, "new", {});
  assert.equal(out.stats.agreement.footwear.pct, 83);
  assert.deepEqual(out.modes, { footwear: "auto" });
});

test("skip: New/Rejected → Skipped with a decision; restore brings it back; enqueue never does", async () => {
  const db = lane(3, { item: (i) => (i === 0 ? { generateRequest: { at: 1, by: "x" } } : {}) });
  const out = await na.skip(db, { pids: [pid(0), pid(1)] }, "junid", NOW + 50);
  assert.deepEqual(out.skippedPids.sort(), [pid(0), pid(1)]);
  const it = (await db.ref(`${core.ITEMS}/${pid(0)}`).once()).val();
  assert.equal(it.status, "skipped");
  assert.equal(it.skippedBy, "junid");
  assert.equal("generateRequest" in it, false, "a skipped item is never generated");
  assert.equal((await db.ref(`${core.BY_STATUS}/skipped/${pid(0)}`).once()).val(), NOW);
  assert.equal((await db.ref(`${core.BY_STATUS}/new/${pid(0)}`).once()).val(), null);
  const sk = await na.listTab(db, "skipped", {});
  assert.equal(sk.total, 2);
  assert.equal(sk.tabCounts.new, 1);
  // A redelivered upload trigger only repairs the index — it stays skipped.
  await na.enqueue(db, pid(0), upload({ newArrivalAt: NOW }), NOW);
  assert.equal((await db.ref(`${core.ITEMS}/${pid(0)}/status`).once()).val(), "skipped");
  const r = await na.restore(db, { pids: [pid(0), pid(2)] }, "junid", NOW + 60);
  assert.deepEqual(r.restored, [pid(0)]);
  assert.match(r.skipped[0].why, /it is new/);
  const back = (await db.ref(`${core.ITEMS}/${pid(0)}`).once()).val();
  assert.equal(back.status, "new");
  assert.equal("skippedAt" in back, false);
  const d = await decisions(db);
  assert.deepEqual(d.map((x) => x.action).sort(), ["restore", "skip", "skip"]);
  assert.equal(d[0].class, "footwear");
  assert.equal(d[0].categoryKey, "sneakers");
  assert.equal(d[0].gen, undefined, "no generation → no snapshot (null is dropped)");
});

test("skip refuses Ready and Generating", async () => {
  const db = seeded("ready", { generatedUrl: "g" });
  const out = await na.skip(db, { pids: [PID] }, "junid", NOW);
  assert.deepEqual(out.skippedPids, []);
  assert.match(out.skipped[0].why, /it is ready/);
  await assert.rejects(na.skip(db, { pids: [] }, "junid", NOW), /No items/);
});

const GEN = { url: "https://x/g1.jpg", path: "na/g1.jpg", at: NOW, model: "m", promptVersion: "v3", plate: "footwear-plate.png", kind: "footwear",
  costUsd: 0.04, costZar: 0.75, verdict: { pass: false, failed: ["fidelity:colour"], label: "colour off" }, layout: { deviations: [], tol: 0.02, corrected: null }, reason: "requested" };

test("generate: New → generateRequest set, once; a decision is logged", async () => {
  const db = lane(2);
  const out = await na.generate(db, { pids: [pid(0), pid(1)] }, "junid", NOW + 7);
  assert.equal(out.requested.length, 2);
  const it = (await db.ref(`${core.ITEMS}/${pid(0)}`).once()).val();
  assert.deepEqual(it.generateRequest, { at: NOW + 7, by: "junid" });
  assert.equal(it.status, "new");
  const again = await na.generate(db, { pids: [pid(0)] }, "junid", NOW + 8);
  assert.match(again.skipped[0].why, /already requested/);
  assert.deepEqual((await decisions(db)).map((d) => d.action), ["generate", "generate"]);
  // The poster's small index: one entry per request; Skip removes it.
  assert.equal((await db.ref(`${core.ROOT}/requests/${pid(0)}`).once()).val(), NOW + 7);
  await na.skip(db, { pids: [pid(0)] }, "junid", NOW + 9);
  assert.equal((await db.ref(`${core.ROOT}/requests/${pid(0)}`).once()).val(), null);
});

test("regenerate marks its request as a regeneration (logged with its reason and cost by the generator)", async () => {
  const db = lane(1);
  await db.ref(`${core.ITEMS}/${pid(0)}`).update({ status: "ready", generatedUrl: "https://x/g.jpg" });
  await db.ref(`${core.BY_STATUS}/new/${pid(0)}`).set(null);
  await db.ref(`${core.BY_STATUS}/ready/${pid(0)}`).set(1);
  await na.generate(db, { pids: [pid(0)], regenerate: true }, "junid", NOW + 7);
  const it = (await db.ref(`${core.ITEMS}/${pid(0)}`).once()).val();
  assert.equal(it.generateRequest.regenerate, true);
});

test("regenerate: Ready/Rejected → New with a request; earlier generations kept; Ready refused without the flag", async () => {
  const db = seeded("ready", { generatedUrl: GEN.url, currentGen: "g1", generations: { g1: GEN }, verdict: GEN.verdict, suggestedName: "Old" });
  const no = await na.generate(db, { pids: [PID] }, "junid", NOW);
  assert.match(no.skipped[0].why, /it is ready, not new/);
  const out = await na.generate(db, { pids: [PID], regenerate: true }, "junid", NOW + 3);
  assert.deepEqual(out.requested, [PID]);
  const it = (await db.ref(`${core.ITEMS}/${PID}`).once()).val();
  assert.equal(it.status, "new");
  assert.equal(it.generations.g1.url, GEN.url, "every generation is kept");
  for (const k of ["generatedUrl", "currentGen", "verdict", "suggestedName"]) assert.equal(k in it, false, k);
  assert.equal((await db.ref(`${core.BY_STATUS}/new/${PID}`).once()).val(), NOW);
  const [d] = await decisions(db);
  assert.equal(d.action, "regenerate");
  assert.equal(d.genId, "g1");
  // As stored (RTDB drops the empty deviations list and the null).
  assert.deepEqual(d.gen, it.generations.g1, "the snapshot is the generation Junid looked at");
  assert.equal(d.gen.costZar, 0.75);
});

test("reject takes exactly one chip; logs reason + snapshot", async () => {
  const db = seeded("ready", { generatedUrl: GEN.url, currentGen: "g1", generations: { g1: GEN } });
  await assert.rejects(na.reject(db, { pid: PID, reason: "meh" }, "junid", NOW), /Pick one/);
  assert.deepEqual(await na.reject(db, { pid: PID, reason: "looks fake/CGI" }, "junid", NOW + 1), { ok: true });
  const it = (await db.ref(`${core.ITEMS}/${PID}`).once()).val();
  assert.equal(it.status, "rejected");
  assert.deepEqual(it.rejection, { code: "junid", reason: "looks fake/CGI", at: NOW + 1 });
  assert.equal(it.generations.g1.costZar, 0.75);
  const [d] = await decisions(db);
  assert.equal(d.action, "reject");
  assert.equal(d.reason, "looks fake/CGI");
  assert.equal(d.gen.verdict.failed[0], "fidelity:colour");
  assert.equal(d.by, "junid");
  assert.equal(d.at, NOW + 1);
  await assert.rejects(na.reject(db, { pid: PID, reason: "blurry" }, "junid", NOW), /it is rejected/);
  for (const c of ["background wrong", "colour off", "detail changed", "looks fake/CGI", "framing", "box wrong", "blurry"]) assert.ok(core.REJECT_CHIPS.includes(c));
});

test("approve anyway: Rejected → approved (only with the flag), logged as approve-anyway; plain approve logged", async () => {
  const db = seeded("rejected", { generatedUrl: GEN.url, currentGen: "g1", generations: { g1: GEN }, rejection: { code: "junid", reason: "framing", at: 1 } });
  const no = await na.approve(db, { pids: [PID] }, "junid", NOW);
  assert.match(no.skipped[0].why, /it is rejected, not ready/);
  const out = await na.approve(db, { pids: [PID], anyway: true }, "junid", NOW + 2);
  assert.deepEqual(out.approved, [PID]);
  const it = (await db.ref(`${core.ITEMS}/${PID}`).once()).val();
  assert.equal(it.status, "approved");
  assert.equal(it.lastRejection.reason, "framing");
  assert.equal("rejection" in it, false);
  assert.equal((await db.ref(`${core.BY_STATUS}/approved/${PID}`).once()).val(), NOW);
  const [d] = await decisions(db);
  assert.equal(d.action, "approve-anyway");
  assert.equal(d.gen.url, GEN.url);
  const db2 = seeded("ready", { generatedUrl: "g", currentGen: "g1", generations: { g1: GEN } });
  await na.approve(db2, { pids: [PID] }, "junid", NOW);
  assert.equal((await decisions(db2))[0].action, "approve");
});

test("approve anyway still needs a stock price and a generated photo", async () => {
  const db = seeded("rejected", { rejection: { code: "junid", reason: "framing", at: 1 } });
  const out = await na.approve(db, { pids: [PID], anyway: true }, "junid", NOW);
  assert.match(out.skipped[0].why, /no generated photo/);
  await db.ref(`products/${PID}/stockPrice`).set(null);
  const out2 = await na.approve(db, { pids: [PID], anyway: true }, "junid", NOW);
  assert.match(out2.skipped[0].why, /no stock price/);
  assert.deepEqual(await decisions(db), []);
});

test("decisionRecord never carries undefined and tolerates absent generations", () => {
  const r = core.decisionRecord({ pid: PID, at: 1, by: null, action: "skip", item: { categoryKey: "hoodies" } });
  assert.deepEqual(r, { pid: PID, at: 1, by: "unknown", action: "skip", reason: null, class: "single", categoryKey: "hoodies", genId: null, gen: null });
  assert.throws(() => core.decisionRecord({ pid: PID, at: 1, action: "nope" }), /unknown decision/);
});
