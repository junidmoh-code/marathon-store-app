// The live New Arrivals card (Junid, 19 Nov 2026): New (20-day window, in
// stock, newest first) / Approved (mixed, not posted) / Done (posted); Use
// current photo; Un-approve; Post all approved (dry run + queued request).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const core = require("../newArrivals/core.cjs");
const { _internals: na, NO_STOCK_PRICE } = require("../newArrivals/newArrivals.js");

const DAY = 86_400_000;
const NOW = 1_795_100_000_000;
const pidAt = (daysAgo, n = 0) => `p${NOW - Math.round(daysAgo * DAY) + n}`;
const photo = (p) => `https://firebasestorage.googleapis.com/v0/b/b/o/products%2F${p}%2Fphoto.jpg?alt=media`;

function world({ items = [], extra = {} } = {}) {
  const tree = { locations: { central: { name: "Central" }, in_transit: { name: "Transit" } }, products: {}, stock: { central: {} }, new_arrivals: { items: {}, by_status: {} } };
  for (const it of items) {
    const { pid, status = "new", product = {}, units = 1, item = {} } = it;
    if (product !== null) tree.products[pid] = { name: `item ${pid}`, categoryKey: "sneakers", stockPrice: 500, sizes: ["7", "8"], photoUrl: photo(pid), ...product };
    if (units > 0) tree.stock.central[pid] = { 7: { qty: units } };
    tree.new_arrivals.items[pid] = { pid, status, enqueuedAt: 1, statusAt: 1, name: "x", ...item };
    (tree.new_arrivals.by_status[status] = tree.new_arrivals.by_status[status] || {})[pid] = 1;
  }
  for (const [k, v] of Object.entries(extra)) tree[k] = { ...(tree[k] || {}), ...v };
  return makeFakeDb(tree);
}
const read = async (db, p) => (await db.ref(p).once()).val();
const ids = (o) => o.items.map((i) => i.pid);

test("New: only the last 20 days, in stock, newest upload first; each card carries its upload date", async () => {
  const db = world({ items: [
    { pid: pidAt(25) },                       // outside the window
    { pid: pidAt(19), product: { newArrivalAt: NOW - 19 * DAY + 5 } },
    { pid: pidAt(3) },
    { pid: pidAt(1), units: 0 },              // sold out
    { pid: pidAt(0.5), product: null },       // product deleted
    { pid: pidAt(0.1), product: { categoryKey: "hoodies" } },
  ] });
  const out = await na.listLive(db, "new", { nowMs: NOW, group: "sneakers" });
  assert.deepEqual(ids(out), [pidAt(3), pidAt(19)]);
  assert.deepEqual(out.groupCounts, { sneakers: 2, clothing: 1 });
  assert.deepEqual(out.hidden, { soldOut: 1, gone: 1 });
  assert.equal(out.tabCounts.new, 3);
  assert.equal(out.items[1].uploadedAt, NOW - 19 * DAY + 5);
  assert.equal(out.items[1].uploadedFrom, "marker");
  assert.equal(out.items[0].uploadedFrom, "id", "no stamp → the creation write (the id's time)");
  assert.equal(out.windowDays, 20);
  // Nothing was moved.
  assert.equal(await read(db, `new_arrivals/items/${pidAt(25)}/status`), "new");
});

test("New pages newest-first by cursor", async () => {
  const items = Array.from({ length: 35 }, (_, i) => ({ pid: pidAt(10, i) }));
  const db = world({ items });
  const p1 = await na.listLive(db, "new", { nowMs: NOW, limit: 30 });
  assert.equal(p1.items[0].pid, pidAt(10, 34));
  const p2 = await na.listLive(db, "new", { nowMs: NOW, limit: 30, cursor: p1.nextCursor });
  assert.equal(p2.items.length, 5);
  assert.equal(p2.nextCursor, null);
  assert.equal(new Set([...ids(p1), ...ids(p2)]).size, 35);
});

test("Approved is mixed and unposted; Done is what was posted, latest first", async () => {
  const db = world({ items: [
    { pid: pidAt(40), status: "done", item: { approvedAt: 1, generatedUrl: "https://x/a.jpg", destinations: { groups: { at: 50, count: 14 } } } },
    { pid: pidAt(30), status: "chaining", item: { approvedAt: 1, generatedUrl: "https://x/b.jpg" } },
    { pid: pidAt(2), status: "approved", product: { categoryKey: "hoodies" }, item: { approvedAt: 1, generatedUrl: "https://x/c.jpg" } },
    { pid: pidAt(1), status: "done", item: { approvedAt: 1, generatedUrl: "https://x/d.jpg", destinations: { groups: { at: 90, count: 14 } } } },
  ] });
  const a = await na.listLive(db, "approved", { nowMs: NOW });
  assert.deepEqual(ids(a), [pidAt(2), pidAt(30)], "clothing and footwear in one list; older than 20 days still shows");
  assert.equal(a.groupCounts, null);
  const d = await na.listLive(db, "done", { nowMs: NOW });
  assert.deepEqual(ids(d), [pidAt(1), pidAt(40)]);
  assert.deepEqual(a.tabCounts, { new: 0, approved: 2, done: 2 });
});

test("Use current photo approves with the app's photo — no generation, the product untouched; blocked only by no stock price", async () => {
  const P = pidAt(1);
  const db = world({ items: [{ pid: P, status: "ready", item: { currentGen: "g1", generatedUrl: "https://x/gen.jpg", generations: { g1: { url: "https://x/gen.jpg" } } } }] });
  const before = await read(db, `products/${P}`);
  const out = await na.useCurrent(db, { pid: P }, "junid", NOW);
  assert.deepEqual(out.approved, [P]);
  const it = await read(db, `new_arrivals/items/${P}`);
  assert.equal(it.status, "approved");
  assert.equal(it.useCurrentPhoto, true);
  assert.equal(it.generatedUrl, photo(P));
  assert.equal(it.beforeUseCurrent.generatedUrl, "https://x/gen.jpg");
  assert.deepEqual(await read(db, `products/${P}`), before, "the product (and its photo) is never touched");
  assert.equal(await read(db, `new_arrivals/by_status/approved/${P}`), 1);
  assert.deepEqual(ids(await na.listLive(db, "approved", { nowMs: NOW })), [P]);
  // No stock price → refused, in words.
  const Q = pidAt(2);
  const db2 = world({ items: [{ pid: Q, product: { stockPrice: null } }] });
  assert.deepEqual((await na.useCurrent(db2, { pid: Q }, "junid", NOW)).skipped, [{ pid: Q, why: NO_STOCK_PRICE }]);
  // The current photo may itself be a generated studio shot: still fine.
  const R = pidAt(3);
  const db3 = world({ items: [{ pid: R, product: { photoUrl: `https://firebasestorage.googleapis.com/v0/b/b/o/products%2F${R}%2Fnew_arrivals%2Fgen_1.jpg?alt=media` } }] });
  assert.deepEqual((await na.useCurrent(db3, { pid: R }, "junid", NOW)).approved, [R]);
});

test("Un-approve puts it back on New exactly as it was; a posted item cannot go back", async () => {
  const P = pidAt(1);
  const db = world({ items: [{ pid: P, status: "ready", item: { currentGen: "g1", generatedUrl: "https://x/gen.jpg", generations: { g1: { url: "https://x/gen.jpg" } } } }] });
  await na.useCurrent(db, { pid: P }, "junid", NOW);
  const out = await na.unapprove(db, { pid: P }, "junid", NOW + 1);
  assert.equal(out.ok, true);
  const it = await read(db, `new_arrivals/items/${P}`);
  assert.equal(it.status, "ready");
  assert.equal(it.generatedUrl, "https://x/gen.jpg");
  assert.equal("useCurrentPhoto" in it, false);
  assert.equal("approvedAt" in it, false);
  assert.equal(await read(db, `new_arrivals/by_status/ready/${P}`), 1);
  assert.equal(await read(db, `new_arrivals/by_status/approved/${P}`), null);
  // No photo of its own → the plain New lane.
  const Q = pidAt(2);
  const db2 = world({ items: [{ pid: Q }] });
  await na.useCurrent(db2, { pid: Q }, "junid", NOW);
  assert.equal((await na.unapprove(db2, { pid: Q }, "junid", NOW + 1)).status, "new");
  assert.equal(await read(db2, `new_arrivals/by_status/new/${Q}`), 1);
  assert.equal(await read(db2, `new_arrivals/by_status/ready/${Q}`), null);
  // Posted → refused.
  const R = pidAt(3);
  const db3 = world({ items: [{ pid: R, status: "done", item: { approvedAt: 1, generatedUrl: "https://x/r.jpg", destinations: { groups: { at: 5 } } } }] });
  assert.match((await na.unapprove(db3, { pid: R }, "junid", NOW)).why, /already posted/);
});

test("postPlan: footwear and clothing never share a post; one post per stock price; footwear first; 35 photos max", () => {
  const rows = [
    { pid: "p1790000000001", name: "shirt", price: 350, division: "clothing", sizesText: "M, L" },
    { pid: "p1790000000002", name: "shoe", price: 350, division: "footwear", sizesText: "7-9" },
    { pid: "p1790000000003", name: "shoe2", price: "350", division: "footwear", sizesText: "8" },
    { pid: "p1790000000004", name: "boot", price: 900, division: "footwear", sizesText: "10" },
    { pid: "p1790000000005", name: "no price", price: null, division: "footwear", sizesText: "8" },
  ];
  const { posts, dropped } = core.postPlan(rows);
  assert.deepEqual(posts.map((p) => [p.division, p.price, p.items.length]), [["footwear", 350, 2], ["footwear", 900, 1], ["clothing", 350, 1]]);
  assert.deepEqual(dropped, [{ pid: "p1790000000005", why: "no stock price" }]);
  const many = Array.from({ length: 40 }, (_, i) => ({ pid: `p17900000001${String(i).padStart(2, "0")}`, price: 200, division: "clothing", sizesText: "S" }));
  assert.deepEqual(core.postPlan(many).posts.map((p) => [p.part, p.of, p.items.length]), [[1, 2, 35], [2, 2, 5]]);
});

test("Post all: a dry run plans and sends nothing; a real press is refused while the poster is not ready, with the button's reason", async () => {
  const db = world({ items: [
    { pid: pidAt(1), status: "approved", item: { approvedAt: 1, generatedUrl: "https://x/1.jpg" } },
    { pid: pidAt(2), status: "chaining", product: { categoryKey: "hoodies", stockPrice: 500 }, item: { approvedAt: 1, generatedUrl: "https://x/2.jpg" } },
    { pid: pidAt(3), status: "done", item: { approvedAt: 1, generatedUrl: "https://x/3.jpg", destinations: { groups: { at: 9 } } } },
  ] });
  const dry = await na.postAll(db, { dryRun: true }, "junid", NOW);
  assert.deepEqual(dry.posts.map((p) => [p.division, p.price, p.count]), [["footwear", 500, 1], ["clothing", 500, 1]]);
  assert.equal(await read(db, "new_arrivals/post_requests"), null);
  await assert.rejects(na.postAll(db, { dryRun: false }, "junid", NOW), /has not reported in/);
  await db.ref("new_arrivals/poster/status").set({ at: NOW - 1000, ready: false, missing: ["macOS Accessibility is not on for MarathonPoster"] });
  await assert.rejects(na.postAll(db, { dryRun: false }, "junid", NOW), /Accessibility is not on/);
  await db.ref("new_arrivals/poster/status").set({ at: NOW - 1000, ready: true, missing: null });
  await db.ref("new_arrivals/pause/posting").set({ paused: false, at: 1, by: "x" });
  const real = await na.postAll(db, { dryRun: false }, "junid", NOW);
  const req = await read(db, `new_arrivals/post_requests/${real.queued}`);
  assert.equal(req.status, "queued");
  assert.equal(req.photos, 2);
  assert.equal((await read(db, "new_arrivals/post_request_open")).key, real.queued);
  await assert.rejects(na.postAll(db, { dryRun: false }, "junid", NOW), /already on its way/);
  // Not finished in 2 hours: closed as expired, and a new press goes through.
  const later = NOW + core.REQUEST_EXPIRY_MS + 1;
  await db.ref("new_arrivals/poster/status").set({ at: later - 1000, ready: true, missing: null });
  const again = await na.postAll(db, { dryRun: false }, "junid", later);
  assert.equal(await read(db, `new_arrivals/post_requests/${real.queued}/status`), "expired");
  assert.equal((await read(db, "new_arrivals/post_request_open")).key, again.queued);
});

test("postAllBlock: the exact words on the button", () => {
  const ok = { at: NOW, ready: true };
  assert.equal(core.postAllBlock({ poster: ok, pause: { posting: false }, approvedCount: 0 }, NOW), "Nothing approved to post");
  assert.match(core.postAllBlock({ poster: { at: NOW - 3_600_000, ready: true }, approvedCount: 1 }, NOW), /not reported for 60 min/);
  assert.match(core.postAllBlock({ poster: ok, pause: { posting: true }, approvedCount: 1 }, NOW), /Paused/);
  assert.equal(core.postAllBlock({ poster: ok, pause: { posting: false }, approvedCount: 1 }, NOW), null);
});

test("uploadedAt: marker, then the attribution stamp, then the creation write (the id)", () => {
  assert.deepEqual(core.uploadedAt("p1790000000000", { newArrivalAt: 5 }), { at: 5, from: "marker" });
  assert.deepEqual(core.uploadedAt("p1790000000000", { createdBy: { at: 6 } }), { at: 6, from: "created" });
  assert.deepEqual(core.uploadedAt("p1790000000000", {}), { at: 1790000000000, from: "id" });
  assert.deepEqual(core.uploadedAt("-Nabc", {}), { at: null, from: null });
});

test("postPlan keeps the exact stock price: R350.10 and R350.40 are two posts", () => {
  const { posts } = core.postPlan([
    { pid: "p1790000000001", price: 350.1, division: "clothing", sizesText: "M" },
    { pid: "p1790000000002", price: 350.4, division: "clothing", sizesText: "L" },
  ]);
  assert.deepEqual(posts.map((p) => p.price), [350.1, 350.4]);
});

test("Post all: a refused claim leaves no orphan — the request is marked refused", async () => {
  const db = world({ items: [{ pid: pidAt(1), status: "approved", item: { approvedAt: 1, generatedUrl: "https://x/1.jpg" } }] });
  await db.ref("new_arrivals/poster/status").set({ at: NOW, ready: true });
  await db.ref("new_arrivals/pause/posting").set({ paused: false, at: 1, by: "x" });
  await db.ref("new_arrivals/post_request_open").set({ key: "-held", at: NOW - 1000 });
  await assert.rejects(na.postAll(db, { dryRun: false }, "junid", NOW), /already on its way/);
  const reqs = Object.values(await read(db, "new_arrivals/post_requests"));
  assert.deepEqual(reqs.map((r) => r.status), ["refused"]);
  assert.equal((await read(db, "new_arrivals/post_request_open")).key, "-held");
});

test("New: an item with a generated photo waiting for Junid stays on New past the 20-day window", async () => {
  const db = world({ items: [
    { pid: pidAt(40), status: "ready", item: { currentGen: "g1", generatedUrl: "https://x/g.jpg", generations: { g1: { url: "https://x/g.jpg" } } } },
    { pid: pidAt(45), status: "rejected", item: { generatedUrl: "https://x/r.jpg" } },
    { pid: pidAt(50), status: "ready", units: 0, item: { generatedUrl: "https://x/s.jpg" } },   // sold out: still hidden
    { pid: pidAt(41) },                                                                       // old, no photo: outside the window
    { pid: pidAt(2) },
  ] });
  const out = await na.listLive(db, "new", { nowMs: NOW });
  assert.deepEqual(ids(out), [pidAt(2), pidAt(40), pidAt(45)]);
  assert.equal(out.hidden.soldOut, 1);
});
