// BF Candidates (Junid, 23 Nov 2026): candidates, ONE sale price, the ≥-stock-price warning,
// extend, revert at expiry, Not for sale, the alert words, the re-tag list and the caption.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../bfCandidates/core.cjs");
const { _internals: X } = require("../bfCandidates/bfCandidates.js");
const { sendStoreAlerts } = require("../bfCandidates/alerts.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const NOW = Date.parse("2026-11-23T13:00:00+02:00");
const DAY = 86400_000;
const END = core.endOfDayMs("2026-11-30");
const R = core.ROOT;

test("the sale ends Monday 30 Nov 2026 at 23:59 Africa/Johannesburg, and says so", () => {
  assert.equal(new Date(END).toISOString(), "2026-11-30T21:59:59.999Z");
  assert.equal(core.endLabel(END), "Mon 30 Nov");
  assert.equal(core.endLabel(core.endOfDayMs("2026-12-07")), "Mon 7 Dec");
  assert.equal(core.saleEnd(null, NOW), END);
  assert.equal(core.saleEnd("2026-11-22", NOW), null, "an end already past is refused");
  assert.equal(core.saleEnd("30 Nov", NOW), null);
  assert.equal(core.saleEnd("2026-11-31", NOW), null, "31 Nov is not a day: refused, never rolled into 1 Dec");
});

test("a candidate is on hand with nothing sold inside the window; never sold counts", () => {
  assert.equal(core.isCandidate({ qty: 5, lastSold: NOW - 31 * DAY }, 30, NOW), true);
  assert.equal(core.isCandidate({ qty: 5, lastSold: NOW - 29 * DAY }, 30, NOW), false);
  assert.equal(core.isCandidate({ qty: 5, lastSold: NOW - 29 * DAY }, 14, NOW), true, "the window is adjustable");
  assert.equal(core.isCandidate({ qty: 5, lastSold: null }, 30, NOW), true);
  assert.equal(core.isCandidate({ qty: 0, lastSold: null }, 30, NOW), false);
  assert.equal(core.sinceLabel(null, NOW), "never sold");
  assert.equal(core.sinceLabel(NOW - 42.5 * DAY, NOW), "42 days");
  assert.equal(core.windowOf(45), 30, "an unknown window falls back to 30 days");
});

const ITEMS = {
  a: { name: "Tee A", kind: "clothing", qty: 40, lastSold: null, stockPrice: 200, retailPrice: 350, photo: "https://x/a.jpg", locs: { "marathon-pe": 30, central: 10 } },
  b: { name: "Tee B", kind: "clothing", qty: 90, lastSold: NOW - 60 * DAY, stockPrice: 250, retailPrice: 400, photo: "https://x/b.jpg" },
  c: { name: "Shoe C", kind: "sneakers", qty: 12, lastSold: NOW - 35 * DAY, stockPrice: 900, retailPrice: 1500, photo: "https://x/c.jpg" },
  d: { name: "Sold lately", kind: "clothing", qty: 99, lastSold: NOW - 3 * DAY, stockPrice: 100, retailPrice: 150 },
  e: { name: "Cap E", kind: "headwear", qty: 7, lastSold: null, stockPrice: 80, retailPrice: 120 },
};

test("the list: Clothing | Sneakers (others under Clothing), highest quantity first, removed never shown", () => {
  const v = core.viewList({ items: ITEMS, removed: { e: { at: 1 } } }, { tab: "clothing", windowDays: 30, nowMs: NOW });
  assert.deepEqual(v.rows.map((r) => r.pid), ["b", "a"]);
  assert.deepEqual(v.counts, { clothing: 2, sneakers: 1, onSale: 0, removed: 1 });
  assert.equal(v.rows[1].since, "never sold");
  const all = core.viewList({ items: ITEMS }, { tab: "clothing", windowDays: 30, nowMs: NOW });
  assert.deepEqual(all.rows.map((r) => r.pid), ["b", "a", "e"], "a cap is listed under Clothing");
  assert.deepEqual(core.viewList({ items: ITEMS }, { tab: "sneakers", nowMs: NOW }).rows.map((r) => r.pid), ["c"]);
});

test("a product on sale stays on the card with its sale, even once it starts selling", () => {
  const sales = { d: { salePrice: 80, start: NOW - 1000, end: END, setAt: NOW - 1000, name: "Sold lately", kind: "clothing" } };
  const v = core.viewList({ items: ITEMS, sales, posted: { d: { version: NOW - 1000, at: NOW, groups: 15 } } }, { tab: "clothing", nowMs: NOW });
  const d = v.rows.find((r) => r.pid === "d");
  assert.deepEqual({ price: d.sale.price, until: d.sale.until }, { price: 80, until: "Mon 30 Nov" });
  assert.equal(d.posted.groups, 15);
  assert.equal(v.counts.onSale, 1);
});

test("the sale price: rands, more than zero; the warning names every product whose stock price it reaches", () => {
  assert.equal(core.parsePrice("R 249,50"), 249.5);
  assert.equal(core.parsePrice("0"), null);
  assert.equal(core.parsePrice("abc"), null);
  assert.equal(core.parsePrice("0.001"), null, "a price that rounds to nothing");
  assert.equal(core.kindOfCat("soccer-boots"), "sneakers");
  assert.equal(core.kindOfCat("t-shirts"), "clothing");
  const rows = [{ pid: "a", name: "A", stockPrice: 200 }, { pid: "b", name: "B", stockPrice: 250 }, { pid: "n", name: "N", stockPrice: null }];
  assert.deepEqual(core.aboveStock(rows, 200).map((x) => x.pid), ["a"], "equal to the stock price warns too");
  assert.deepEqual(core.aboveStock(rows, 199), []);
  assert.deepEqual(core.aboveStock(rows, 300).map((x) => x.pid), ["a", "b"]);
});

test("a sale charges only between its start and its end; anything malformed is not a sale", () => {
  const s = { salePrice: 150, start: NOW, end: END };
  assert.equal(core.saleActive(s, NOW), true);
  assert.equal(core.saleActive(s, NOW - 1), false);
  assert.equal(core.saleActive(s, END - 1), true);
  assert.equal(core.saleActive(s, END), false, "at the end the normal prices are back");
  assert.equal(core.saleActive({ ...s, salePrice: "x" }, NOW), false);
  assert.equal(core.saleActive({ salePrice: 150, start: NOW }, NOW), false);
});

function world(extra = {}) {
  return makeFakeDb({
    network: null,
    products: {
      a: { name: "Tee A", stockPrice: 200, retailPrice: 350, photoUrl: "https://x/a.jpg", categoryKey: "t-shirts" },
      b: { name: "Tee B", stockPrice: 250, retailPrice: 400, photoUrl: "https://x/b.jpg", categoryKey: "t-shirts" },
      c: { name: "Shoe C", stockPrice: 900, retailPrice: 1500, photoUrl: "https://x/c.jpg", categoryKey: "sneakers" },
    },
    stock: { "marathon-pe": { a: { M: { qty: 3 }, L: 2 } }, hub2: { a: { M: 4 }, c: { "8": 1 } }, concrete: { b: { S: 6 } } },
    [R]: { candidates: { items: ITEMS } },
    ...extra,
  });
}
const get = async (db, p) => (await db.ref(p).once("value")).val();

test("Put on sale: ONE price on its own node + the till's mirror; stock and retail prices untouched", async () => {
  const db = world();
  const r = await X.putOnSale(db, { pids: ["a", "b"], price: 150 }, "junid", NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.done, ["a", "b"]);
  assert.equal(r.until, "Mon 30 Nov");
  const s = await get(db, `${R}/sales/a`);
  assert.deepEqual({ salePrice: s.salePrice, start: s.start, end: s.end, setBy: s.setBy, setAt: s.setAt, kind: s.kind, cat: s.cat, photo: s.photo, baseStock: s.baseStock, baseRetail: s.baseRetail },
    { salePrice: 150, start: NOW, end: END, setBy: "junid", setAt: NOW, kind: "clothing", cat: "t-shirts", photo: "https://x/a.jpg", baseStock: 200, baseRetail: 350 });
  assert.deepEqual(await get(db, "products/a/bfSale"), { price: 150, start: NOW, end: END });
  assert.equal(await get(db, "products/a/stockPrice"), 200);
  assert.equal(await get(db, "products/a/retailPrice"), 350);
});

test("a sale price at or above the stock price saves NOTHING until Junid confirms", async () => {
  const db = world();
  const r = await X.putOnSale(db, { pids: ["a", "b"], price: 220 }, "junid", NOW);
  assert.equal(r.ok, false);
  assert.deepEqual(r.needConfirm, [{ pid: "a", name: "Tee A", stockPrice: 200 }]);
  assert.equal(await get(db, `${R}/sales`), null);
  assert.equal(await get(db, "products/a/bfSale"), null);
  // a confirmation of OTHER products is not a confirmation of this one
  const other = await X.putOnSale(db, { pids: ["a", "b"], price: 220, confirmAbove: ["b"] }, "junid", NOW);
  assert.equal(other.ok, false);
  assert.equal(await get(db, `${R}/sales`), null);
  const ok = await X.putOnSale(db, { pids: ["a", "b"], price: 220, confirmAbove: ["a"] }, "junid", NOW);
  assert.deepEqual(ok.done, ["a", "b"]);
  assert.equal((await get(db, `${R}/sales/a`)).salePrice, 220);
});

test("a product marked Not for sale, or gone from the catalogue, is refused", async () => {
  const db = world({});
  await db.ref(`${R}/removed/b`).set({ at: 1 });
  const r = await X.putOnSale(db, { pids: ["a", "b", "zz"], price: 100 }, "junid", NOW);
  assert.deepEqual(r.done, ["a"]);
  assert.deepEqual(r.refused.map((x) => x.pid).sort(), ["b", "zz"]);
});

test("Extend: a new end date on the sale and the till's mirror; the price stays", async () => {
  const db = world();
  await X.putOnSale(db, { pids: ["a", "c"], price: 150 }, "junid", NOW);
  const r = await X.extend(db, { pids: ["a"], endDay: "2026-12-07" }, "junid", NOW + 5000);
  assert.deepEqual(r.done, ["a"]);
  assert.equal(r.until, "Mon 7 Dec");
  const s = await get(db, `${R}/sales/a`);
  assert.equal(s.end, core.endOfDayMs("2026-12-07"));
  assert.equal(s.extendedAt, NOW + 5000);
  assert.equal(s.prevEnd, END);
  assert.equal(core.saleVersion(s), NOW + 5000, "an extended sale is a new version: it may post again");
  assert.deepEqual(await get(db, "products/a/bfSale"), { price: 150, start: NOW, end: core.endOfDayMs("2026-12-07") });
  assert.equal((await get(db, `${R}/sales/c`)).end, END, "only the chosen product");
  const all = await X.extend(db, { all: true, endDay: "2026-12-07" }, "junid", NOW + 9000);
  assert.deepEqual(all.done, ["c"], "Extend all: every sale not already at that date");
});

test("at expiry the sale is closed: mirror gone, record kept under ended/, base prices as they always were", async () => {
  const db = world();
  await X.putOnSale(db, { pids: ["a"], price: 150 }, "junid", NOW);
  const after = END + 60_000;
  const over = Object.entries(await get(db, `${R}/sales`)).filter(([, s]) => !(Number(s.end) > after));
  const r = await X.closeSales(db, over, { why: "expired", nowMs: after });
  assert.deepEqual(r.done, ["a"]);
  assert.equal(await get(db, `${R}/sales/a`), null);
  assert.equal(await get(db, "products/a/bfSale"), null);
  assert.deepEqual([await get(db, "products/a/stockPrice"), await get(db, "products/a/retailPrice")], [200, 350]);
  const ended = await get(db, `${R}/ended/a/${NOW}`);
  assert.deepEqual({ why: ended.why, salePrice: ended.salePrice, endedAt: ended.endedAt }, { why: "expired", salePrice: 150, endedAt: after });
});

test("Not for sale: off the list, any sale on it closed; Removed undoes it", async () => {
  const db = world();
  await X.putOnSale(db, { pids: ["a"], price: 150 }, "junid", NOW);
  await X.remove(db, { pids: ["a", "b"] }, "junid", NOW + 1);
  assert.equal(await get(db, `${R}/sales/a`), null);
  assert.equal(await get(db, "products/a/bfSale"), null);
  const removed = await get(db, `${R}/removed`);
  assert.deepEqual(Object.keys(removed).sort(), ["a", "b"]);
  const v = core.viewList({ items: ITEMS, removed }, { tab: "clothing", nowMs: NOW });
  assert.deepEqual(v.rows.map((r) => r.pid), ["e"]);
  await X.restore(db, { pids: ["b"] });
  assert.deepEqual(Object.keys(await get(db, `${R}/removed`)), ["a"]);
});

test("the alert words, and one notification per store for a multi-select", () => {
  const s = { salePrice: 150, end: END };
  assert.deepEqual(core.alertText("start", "Tee A", s), { title: "Black Friday sale", body: "Black Friday sale: Tee A now R150, re-tag" });
  assert.equal(core.alertText("extend", "Tee A", { salePrice: 150, end: core.endOfDayMs("2026-12-07") }).body, "Tee A stays R150 until Mon 7 Dec");
  assert.equal(core.alertText("end", "Tee A", s).body, "Tee A is back to its normal price, re-tag");
  assert.equal(core.alertBurst("start", ["Tee A", "Tee B", "Shoe C"], s).body, "Black Friday sale: Tee A, Tee B and Shoe C now R150, re-tag");
  assert.equal(core.alertBurst("end", ["A", "B", "C", "D", "E"], s).body, "A, B, C and 2 more are back to normal price, re-tag");
  assert.equal(core.alertBurst("end", ["A", "B"], s).body, "A and B are back to normal price, re-tag");
});

test("alerts go to the people assigned to a holding location, minus the muted, by their own tokens", async () => {
  const db = makeFakeDb({
    push_hub_audience: { hub2: { u1: { at: 1 }, u2: { at: 1 } } },
    push_mutes: { u2: { muted: true } },
    push_tokens: { u1: { t1: { token: "tok-1" } }, u2: { t2: { token: "tok-2" } } },
  });
  const sent = [];
  const messaging = { sendEachForMulticast: async (m) => { sent.push(m); return { successCount: m.tokens.length, responses: m.tokens.map(() => ({ success: true })) }; } };
  const out = await sendStoreAlerts({ db, messaging, nowMs: NOW }, { hub2: { title: "Black Friday sale", body: "x" }, "marathon-pe": { title: "t", body: "y" } });
  assert.deepEqual(out, { hub2: { tokens: 1, delivered: 1 }, "marathon-pe": { tokens: 0, delivered: 0 } });
  // a payload refusal (generic invalid-argument) never deletes a good token; a dead token is removed
  const bad = { sendEachForMulticast: async (m) => ({ successCount: 0, responses: m.tokens.map(() => ({ success: false, error: { code: "messaging/invalid-argument" } })) }) };
  await sendStoreAlerts({ db, messaging: bad, nowMs: NOW }, { hub2: { title: "t", body: "b" } });
  assert.equal((await db.ref("push_tokens/u1/t1/token").once("value")).val(), "tok-1");
  const dead = { sendEachForMulticast: async (m) => ({ successCount: 0, responses: m.tokens.map(() => ({ success: false, error: { code: "messaging/registration-token-not-registered" } })) }) };
  await sendStoreAlerts({ db, messaging: dead, nowMs: NOW }, { hub2: { title: "t", body: "b" } });
  assert.equal((await db.ref("push_tokens/u1").once("value")).val(), null);
  assert.deepEqual(sent[0].tokens, ["tok-1"]);
  assert.equal(sent[0].data.kind, "bf_sale");
  assert.equal(sent[0].data.link, "/#bf-sale-list/hub2");
});

test("the re-tag list: per store, only what that store holds; stock in transit is on no shelf", () => {
  const sales = { a: { salePrice: 150, start: NOW, end: END, name: "Tee A" }, c: { salePrice: 700, start: NOW, end: END, name: "Shoe C" }, x: { salePrice: 1, start: NOW, end: NOW } };
  const list = core.storeList(sales, { a: { "marathon-pe": 5, hub2: 4, in_transit: 2 }, c: { hub2: 1 }, x: { hub2: 3 } }, { "marathon-pe": "Marathon PE", hub2: "Hub 2" }, NOW);
  assert.deepEqual(list.map((s) => [s.name, s.items.map((i) => `${i.name} ${i.price}`)]), [["Hub 2", ["Shoe C 700", "Tee A 150"]], ["Marathon PE", ["Tee A 150"]]]);
});

test("the caption as it posts: price once, then sizes, where, and the end date", () => {
  assert.equal(core.saleText(250), "🔥 BLACK FRIDAY SALE: R250");
  assert.equal(core.salePhotoCaption(["S", "M", "L"], "both", END), "Sizes: S, M, L\n📍 Sale available at Marathon Club & Concrete\nEnds Mon 30 Nov");
  assert.equal(core.salePhotoCaption(["8", "9"], "marathon", END), "Sizes: 8, 9\n📍 Sale available at Marathon Club only\nEnds Mon 30 Nov");
  assert.equal(core.salePhotoCaption([], "concrete", END), "Sizes: One size\n📍 Sale available at Concrete only\nEnds Mon 30 Nov");
});

test("Extend never shortens a sale, and never brings back one that was ended meanwhile", async () => {
  const db = world();
  await X.putOnSale(db, { pids: ["a"], price: 150, endDay: "2026-12-07" }, "junid", NOW);
  const r = await X.extend(db, { pids: ["a"], endDay: "2026-11-30" }, "junid", NOW + 1);
  assert.deepEqual([r.done, r.notLater], [[], 1]);
  assert.equal((await get(db, `${R}/sales/a`)).end, core.endOfDayMs("2026-12-07"));
  // ended between Extend's read and its write: the sale stays gone, no till mirror comes back
  let cut = false;
  const racing = makeFakeDb(db.state.root, { beforeRead: async (path, state) => { if (!cut && path === `${R}/sales/a` && state.root[R].sales && racing.armed) { cut = true; delete state.root[R].sales; delete state.root.products.a.bfSale; } } });
  racing.armed = false;
  const named = await X.salesFor(racing, { pids: ["a"] }, NOW + 2);
  assert.equal(named.length, 1);
  racing.armed = true;
  const e = await X.extend(racing, { all: true, endDay: "2026-12-14" }, "junid", NOW + 2);
  assert.deepEqual(e.done, []);
  assert.equal(await get(racing, `${R}/sales/a`), null);
  assert.equal(await get(racing, "products/a/bfSale"), null);
});

test("the expiry job never closes a sale Junid set again after it was read", async () => {
  const db = world();
  await X.putOnSale(db, { pids: ["a"], price: 150 }, "junid", NOW);
  const stale = [["a", await get(db, `${R}/sales/a`)]];
  await X.putOnSale(db, { pids: ["a"], price: 120, endDay: "2026-12-07" }, "junid", END + 10);
  const r = await X.closeSales(db, stale, { why: "expired", nowMs: END + 20 });
  assert.deepEqual(r.done, []);
  assert.equal((await get(db, `${R}/sales/a`)).salePrice, 120);
  assert.deepEqual(await get(db, "products/a/bfSale"), { price: 120, start: END + 10, end: core.endOfDayMs("2026-12-07") });
  assert.equal((await get(db, `${R}/ended/a/${NOW}`)).why, "replaced", "the sale it replaced is kept on record");
});

test("the photo that posts: a generated or replaced photo is chosen on this card's own node; Use current photo takes it back", async () => {
  const db = world({ bf_campaign_2026: { photos: { a: { use: "current", gens: { g1795432000000: { url: "https://x/a-ai.jpg" } } } }, picks: { a: { state: "approved", sig: "current", at: 5 } } } });
  const r = await X.choosePhoto(db, { pid: "a", use: "generated", genId: "g1795432000000" }, "junid", NOW);
  assert.deepEqual(r, { ok: true, pid: "a", photo: "https://x/a-ai.jpg", use: "generated" });
  assert.equal((await get(db, `${R}/photos/a`)).url, "https://x/a-ai.jpg");
  assert.equal((await get(db, "bf_campaign_2026/photos/a")).use, "current", "the Black Friday card's own choice (and so its approval) is untouched");
  // the list shows it, and a sale set now posts with it
  const v = core.viewList({ items: ITEMS, photos: await get(db, `${R}/photos`) }, { tab: "clothing", nowMs: NOW });
  assert.equal(v.rows.find((x) => x.pid === "a").photo, "https://x/a-ai.jpg");
  await X.putOnSale(db, { pids: ["a"], price: 150 }, "junid", NOW);
  assert.equal((await get(db, `${R}/sales/a`)).photo, "https://x/a-ai.jpg");
  // Use current photo: the product's own photo again, on the sale too
  const c = await X.choosePhoto(db, { pid: "a", use: "current" }, "junid", NOW + 1);
  assert.equal(c.photo, "https://x/a.jpg");
  assert.equal(await get(db, `${R}/photos/a`), null);
  assert.equal((await get(db, `${R}/sales/a`)).photo, "https://x/a.jpg");
  await assert.rejects(() => X.choosePhoto(db, { pid: "a", use: "generated", genId: "g1795439999999" }, "junid", NOW), /not there any more/);
  await assert.rejects(() => X.choosePhoto(db, { pid: "a", use: "generated", genId: "../x" }, "junid", NOW), /Which photo/);
});
