// The Black Friday card's precomputed list (fast open on Junid's iPhone, 21 Nov 2026): the head carries
// the counts and the first page of every tab, pages carry the rest, the rows are exactly list()'s rows,
// and a change in the campaign's data rebuilds it — one rebuild at a time, never missing a change.
const test = require("node:test");
const assert = require("node:assert/strict");
const { _internals: bf } = require("../blackFriday/blackFriday.js");
const ci = require("../blackFriday/cardIndex.js")._internals;
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const it_ = (name, price, qty, kind = "clothing") => ({ name, price, qty, sizes: "M-XL", photo: `https://x/${name}.jpg`, kind });
function seed(n = 60) {
  const main = {};
  for (let i = 0; i < n; i++) main[`p${String(i).padStart(3, "0")}`] = it_(`Item ${i}`, i === 5 ? 0 : 300, 13 + i);
  return makeFakeDb({ bf_campaign_2026: { meta: { builtAt: 1, main: n }, items: { main } } });
}
const get = async (db, p) => (await db.ref(p).once("value")).val();

test("splitView: head = counts + page 0 of each tab; pages hold every row once, in the card's order", () => {
  const rows = (k, f = {}) => Array.from({ length: k }, (_, i) => ({ pid: `r${i}`, name: `R${i}`, big: i < 3, ...f }));
  const v = { review: rows(60), approved: [{ pid: "n1", na: false }, { pid: "a1", na: true }, { pid: "x0", noPrice: true }], newArrivals: [], totals: { review: 60 }, rejected: [], meta: {} };
  const s = ci.splitView(v, 123);
  const h = JSON.parse(s.head);
  assert.equal(h.at, 123);
  assert.equal(h.pageSize, ci.PAGE);
  assert.deepEqual(h.counts, { newArrivals: 0, review: 60, approved: 3, big: 3, mid: 57, apprNoPrice: 1, apprNa: 1, apprNormal: 1 });
  assert.equal(h.first.review.length, ci.PAGE);
  assert.deepEqual(h.first.approved.map((r) => r.pid), ["x0", "a1", "n1"], "Approved in block order: no price, New Arrivals, Normal");
  assert.equal(s.pages.review.length, 3);
  const all = s.pages.review.flatMap((p) => JSON.parse(p).rows.map((r) => r.pid));
  assert.deepEqual(all, v.review.map((r) => r.pid));
  assert.ok(s.pages.review.every((p) => JSON.parse(p).at === 123));
  assert.deepEqual(s.pages.newArrivals, []);
});

test("readHead builds the list the first time; its rows are exactly list()'s rows; pages give the rest", async () => {
  const db = seed(60);
  const h = await ci.readHead(db);
  const v = await bf.list(db, "main", Date.now());
  assert.equal(h.counts.review, v.review.length);
  assert.deepEqual(h.first.review, v.review.slice(0, ci.PAGE));
  assert.deepEqual(h.totals, v.totals);
  assert.equal(h.dirty, false);
  const p = await ci.readPages(db, "review", 1, 8);
  assert.equal(p.at, h.at);
  assert.deepEqual(p.pages.flatMap((x) => x.rows), v.review.slice(ci.PAGE));
  const past = await ci.readPages(db, "review", 50, 2);
  assert.deepEqual(past.pages, []);
  assert.equal(past.at, h.at, "past the end: the list's version");
  await assert.rejects(() => ci.readPages(db, "nope", 0, 1), /tab/);
});

test("a change marks the list dirty and rebuilds it; the row moves to Approved", async () => {
  const db = seed(30);
  const h0 = await ci.readHead(db);
  assert.equal(h0.counts.approved, 0);
  await db.ref("bf_campaign_2026/picks/p010").set({ state: "approved", sig: "current", at: 5, section: "main", name: "Item 10", price: 300, kind: "clothing" });
  let clock = h0.at + 100;
  const r = await ci.changed(db, h0.at + 10, { now: () => (clock += 3000), quietMs: 0 });
  assert.equal(r.built, 1);
  const h1 = await ci.readHead(db);
  assert.equal(h1.counts.approved, 1);
  assert.equal(h1.counts.review, h0.counts.review - 1);
  assert.equal(h1.dirty, false);
  assert.equal(await get(db, "bf_campaign_2026/cardIndex/lease"), null, "the lease is freed");
});

test("a change already inside a rebuild that started after it is not built again", async () => {
  const db = seed(10);
  const h0 = await ci.readHead(db);
  const r = await ci.changed(db, h0.at - ci.SKEW_MS - 1, { quietMs: 0 }); // the write happened well before that build started
  assert.equal(r.built, 0);
});

test("while another rebuild holds the lease, a change only marks dirty — and the holder builds it", async () => {
  const db = seed(10);
  await ci.readHead(db);
  let clock = Date.now() + 1000;
  const lease = await ci.takeLease(db, clock);
  assert.ok(lease);
  const r = await ci.changed(db, clock + 1, { quietMs: 0 });
  assert.equal(r.busy, true);
  assert.equal(r.built, 0);
  await ci.freeLease(db, lease);
  const again = await ci.refresh(db, { now: () => (clock += 3000), quietMs: 0 });
  assert.equal(again.built, 1);
  assert.equal((await ci.readHead(db)).dirty, false);
});

test("a dead rebuild's lease frees itself after LEASE_MS", async () => {
  const db = seed(5);
  const t = Date.now();
  assert.ok(await ci.takeLease(db, t));
  assert.equal(await ci.takeLease(db, t + 1000), null);
  assert.ok(await ci.takeLease(db, t + 121_000));
});

test("eventMs takes the write's own time", () => {
  assert.equal(ci.eventMs({ time: "2026-11-21T08:00:00.000Z" }), Date.parse("2026-11-21T08:00:00.000Z"));
  assert.ok(Math.abs(ci.eventMs({}) - Date.now()) < 1000);
});

test("a burst of changes costs one rebuild: the rebuild waits until the writes stop", async () => {
  const db = seed(10);
  const h0 = await ci.readHead(db);
  let clock = h0.at + 10_000;
  let writes = 0;
  // Writes keep landing for 3 s of the clock (500 ms apart); the rebuild waits for 2.5 s of quiet.
  const sleep = async () => { clock += 500; if (writes < 6) { writes++; await db.ref("bf_campaign_2026/cardIndex/dirtyAt").set(clock); } };
  await db.ref("bf_campaign_2026/cardIndex/dirtyAt").set(clock);
  const r = await ci.refresh(db, { now: () => clock, sleep });
  assert.equal(r.built, 1);
  assert.equal(writes, 6);
  assert.equal((await ci.readHead(db)).dirty, false);
});

test("pages read across a rebuild are never mixed: read again, else 'rebuilt'", async () => {
  const db = seed(80);
  await ci.readHead(db);
  const p1 = JSON.parse((await db.ref("bf_campaign_2026/cardIndex/main/pages/review/1").once("value")).val());
  await db.ref("bf_campaign_2026/cardIndex/main/pages/review/2").set(JSON.stringify({ ...p1, at: p1.at + 1 }));
  const r = await ci.readPages(db, "review", 1, 2);
  assert.equal(r.rebuilt, true);
  assert.deepEqual(r.pages, []);
});

test("a dirty mark within the clock margin of a rebuild still counts", () => {
  assert.equal(ci.isDirty(10_000, 9_000), true);
  assert.equal(ci.isDirty(10_000, 7_000), false);
  assert.equal(ci.isDirty(null, 0), true);
});
