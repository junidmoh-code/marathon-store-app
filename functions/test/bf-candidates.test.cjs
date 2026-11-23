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

const JUL = Date.parse("2026-07-10T10:00:00+02:00"), JUN = Date.parse("2026-06-20T10:00:00+02:00"), AUG = Date.parse("2026-08-05T10:00:00+02:00");
test("a candidate: arrived on or before the cut-off, still on hand, sold under 10% of received (Junid 15:44)", () => {
  assert.equal(core.isCandidate({ qty: 5, arrived: JUL, received: 50, sold: 0 }, "july"), true, "zero sold counts");
  assert.equal(core.isCandidate({ qty: 5, arrived: JUL, received: 50, sold: 4 }, "july"), true, "4 of 50 is under 10%");
  assert.equal(core.isCandidate({ qty: 5, arrived: JUL, received: 50, sold: 5 }, "july"), false, "exactly 10% is not under 10%");
  assert.equal(core.isCandidate({ qty: 50, arrived: NOW - DAY, received: 50, sold: 0 }, "july"), false, "new stock is not dead stock");
  assert.equal(core.isCandidate({ qty: 5, arrived: Date.parse("2026-07-31T23:30:00+02:00"), received: 9, sold: 0 }, "july"), true, "31 Jul is inside");
  assert.equal(core.isCandidate({ qty: 5, arrived: Date.parse("2026-08-01T00:10:00+02:00"), received: 9, sold: 0 }, "july"), false);
  assert.equal(core.isCandidate({ qty: 5, arrived: AUG, received: 9, sold: 0 }, "august"), true, "the cut-off is selectable");
  assert.equal(core.isCandidate({ qty: 5, arrived: JUL, received: 9, sold: 0 }, "june"), false);
  assert.equal(core.isCandidate({ qty: 0, arrived: JUL, received: 9, sold: 0 }, "july"), false, "nothing on hand");
  assert.equal(core.isCandidate({ qty: 5, received: 9, sold: 0 }, "july"), false, "no arrival on record is never guessed");
  assert.equal(core.isCandidate({ qty: 5, lastSold: null }, "july"), false, "a row built by the old rule is not a candidate");
  assert.equal(core.cutoffOf("march"), "july", "an unknown cut-off falls back to July");
  assert.equal(core.dayLabel(JUL), "10 Jul 2026");
});

const ITEMS = {
  a: { name: "Tee A", kind: "clothing", qty: 40, arrived: JUL, received: 40, sold: 0, stockPrice: 200, retailPrice: 350, photo: "https://x/a.jpg", locs: { "marathon-pe": 30, central: 10 } },
  b: { name: "Tee B", kind: "clothing", qty: 90, arrived: JUN, received: 100, sold: 6, stockPrice: 250, retailPrice: 400, photo: "https://x/b.jpg" },
  c: { name: "Shoe C", kind: "sneakers", qty: 12, arrived: JUL, received: 12, sold: 0, stockPrice: 900, retailPrice: 1500, photo: "https://x/c.jpg" },
  d: { name: "New arrival", kind: "clothing", qty: 99, arrived: NOW - DAY, received: 99, sold: 0, stockPrice: 100, retailPrice: 150 },
  e: { name: "Cap E", kind: "headwear", qty: 7, arrived: JUN, received: 7, sold: 0, stockPrice: 80, retailPrice: 120 },
};

test("the list: Clothing | Sneakers (others under Clothing); by arrival date, the oldest first; removed never shown", () => {
  const v = core.viewList({ items: ITEMS, removed: { e: { at: 1 } } }, { tab: "clothing", cutoff: "july", nowMs: NOW });
  assert.deepEqual(v.rows.map((r) => r.pid), ["b", "a"], "June before July");
  assert.deepEqual(v.counts, { clothing: 2, sneakers: 1, onSale: 0, removed: 1 });
  assert.deepEqual({ arrivedOn: v.rows[1].arrivedOn, received: v.rows[1].received, sold: v.rows[1].sold }, { arrivedOn: "10 Jul 2026", received: 40, sold: 0 });
  const all = core.viewList({ items: ITEMS }, { tab: "clothing", nowMs: NOW });
  assert.deepEqual(all.rows.map((r) => r.pid), ["e", "b", "a"], "a cap is listed under Clothing; the same June day: the unsold cap before the tee that sold 6");
  assert.deepEqual(core.viewList({ items: ITEMS }, { tab: "sneakers", nowMs: NOW }).rows.map((r) => r.pid), ["c"]);
  assert.deepEqual(core.viewList({ items: ITEMS }, { tab: "clothing", cutoff: "june", nowMs: NOW }).rows.map((r) => r.pid), ["e", "b"]);
  assert.equal(v.saleEnds, null);
});

test("the On sale tab lists EVERYTHING on sale, candidate or not; a non-candidate on sale is not among the candidates", () => {
  const sales = {
    d: { salePrice: 80, start: NOW - 1000, end: END, setAt: NOW - 1000, name: "New arrival", kind: "clothing" },
    a: { salePrice: 150, start: NOW - 1000, end: core.endOfDayMs("2026-12-07"), setAt: NOW - 1000, name: "Tee A", kind: "clothing" },
    gone: { salePrice: 60, start: NOW - 1000, end: END, setAt: NOW - 1000, name: "Sold through", kind: "sneakers", baseStock: 100, baseRetail: 180 },
    over: { salePrice: 60, start: NOW - 9000, end: NOW - 1, setAt: NOW - 9000, name: "Ended" },
  };
  const v = core.viewList({ items: ITEMS, sales, posted: { d: { version: NOW - 1000, at: NOW, groups: 15 } } }, { tab: "onsale", nowMs: NOW });
  assert.deepEqual(v.rows.map((r) => r.pid), ["d", "gone", "a"], "by name");
  const d = v.rows.find((r) => r.pid === "d");
  assert.deepEqual({ price: d.sale.price, until: d.sale.until, qty: d.qty }, { price: 80, until: "Mon 30 Nov", qty: 99 });
  assert.equal(d.posted.groups, 15);
  assert.deepEqual({ qty: v.rows[1].qty, stockPrice: v.rows[1].stockPrice }, { qty: null, stockPrice: 100 }, "no finder row: from the sale itself, and no stock figure is invented");
  assert.equal(v.counts.onSale, 3);
  assert.deepEqual({ same: v.saleEnds.same, first: v.saleEnds.firstLabel, last: v.saleEnds.lastLabel }, { same: false, first: "Mon 30 Nov", last: "Mon 7 Dec" });
  const c = core.viewList({ items: ITEMS, sales }, { tab: "clothing", nowMs: NOW });
  assert.deepEqual(c.rows.map((r) => r.pid), ["e", "b", "a"], "the new arrival on sale is not a candidate");
  assert.equal(c.rows[2].sale.price, 150, "a candidate on sale shows its sale");
  assert.equal(core.defaultEnd(sales, NOW), END, "one product extended on its own does not move the date for new sales");
  assert.equal(core.defaultEnd({ a: sales.a }, NOW), core.endOfDayMs("2026-12-07"), "every running sale extended: a new one ends with them");
  assert.equal(core.defaultEnd({}, NOW), END);
});

test("the sale price: rands, more than zero; the warning names every product whose stock price it reaches", () => {
  assert.equal(core.parsePrice("R 249,50"), 249.5);
  assert.equal(core.parsePrice("1,500"), 1500, "a thousands comma is never read as R1.50");
  assert.equal(core.parsePrice("1,500.50"), 1500.5);
  assert.equal(core.parsePrice("99,5"), 99.5);
  assert.equal(core.parsePrice("0"), null);
  assert.equal(core.parsePrice("abc"), null);
  assert.equal(core.parsePrice("0.001"), null, "a price that rounds to nothing");
  assert.equal(core.kindOfCat("soccer-boots"), "sneakers");
  assert.equal(core.kindOfCat("t-shirts"), "clothing");
  const rows = [{ pid: "a", name: "A", stockPrice: 200 }, { pid: "b", name: "B", stockPrice: 250 }, { pid: "n", name: "N", stockPrice: null }];
  assert.deepEqual(core.aboveStock(rows, 200).map((x) => x.pid), ["a"], "equal to the stock price warns too");
  assert.deepEqual(core.aboveStock(rows, 199), []);
  assert.deepEqual(core.aboveStock(rows, 300).map((x) => x.pid), ["a", "b"]);
  assert.deepEqual(core.aboveStock([{ pid: "n", name: "N", stockPrice: null, retailPrice: 150 }], 1500), [{ pid: "n", name: "N", stockPrice: null, retailPrice: 150 }], "no stock price: checked against retail");
  assert.deepEqual(core.aboveStock([{ pid: "n", name: "N", stockPrice: null, retailPrice: 150 }], 99), []);
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

test("a photo chosen after its sale ended never brings the sale back; no photo of its own is refused", async () => {
  const db = world({ bf_campaign_2026: { photos: { a: { gens: { g1795432000000: { url: "https://x/a-ai.jpg" } } } } } });
  await X.choosePhoto(db, { pid: "a", use: "generated", genId: "g1795432000000" }, "junid", NOW);
  assert.equal(await get(db, `${R}/sales/a`), null, "no sale: nothing is made up");
  await db.ref("products/zz").set({ name: "No photo", stockPrice: 10 });
  await assert.rejects(() => X.choosePhoto(db, { pid: "zz", use: "current" }, "junid", NOW), /no photo of its own/);
  await X.choosePhoto(db, { pid: "a", use: "generated", genId: ["g1795432000000"] }, "junid", NOW);
  assert.equal((await get(db, `${R}/photos/a`)).genId, "g1795432000000", "the id is stored as text, whatever was sent");
});

test("Edit price keeps the sale's own end; a new sale ends with the extended ones", async () => {
  const db = world();
  await X.putOnSale(db, { pids: ["a"], price: 150 }, "junid", NOW);
  await X.extend(db, { pids: ["a"], endDay: "2026-12-07" }, "junid", NOW + 1);
  const r = await X.putOnSale(db, { pids: ["a", "b"], price: 120 }, "junid", NOW + 2);
  assert.equal(r.ok, true);
  const DEC7 = core.endOfDayMs("2026-12-07");
  assert.deepEqual([(await get(db, `${R}/sales/a`)).end, (await get(db, `${R}/sales/b`)).end], [DEC7, DEC7]);
  assert.deepEqual(await get(db, "products/a/bfSale"), { price: 120, start: NOW + 2, end: DEC7 });
});

test("Edit price on products with different ends says so; after the default end a new sale needs the date Junid picks (CodeRabbit #969)", async () => {
  const db = world();
  await X.putOnSale(db, { pids: ["a", "b"], price: 150 }, "junid", NOW);
  await X.extend(db, { pids: ["a"], endDay: "2026-12-07" }, "junid", NOW + 1);
  const r = await X.putOnSale(db, { pids: ["a", "b"], price: 120 }, "junid", NOW + 2);
  assert.deepEqual({ until: r.until, untilFrom: r.untilFrom }, { until: "Mon 7 Dec", untilFrom: "Mon 30 Nov" });
  const one = await X.putOnSale(db, { pids: ["b"], price: 110 }, "junid", NOW + 3);
  assert.deepEqual({ until: one.until, untilFrom: one.untilFrom }, { until: "Mon 30 Nov", untilFrom: undefined });
  const later = world();
  const DEC2 = Date.parse("2026-12-02T10:00:00+02:00");
  await assert.rejects(() => X.putOnSale(later, { pids: ["a"], price: 150 }, "junid", DEC2), /Pick a new end date/);
  const ok = await X.putOnSale(later, { pids: ["a"], price: 150, endDay: "2026-12-07" }, "junid", DEC2);
  assert.equal(ok.until, "Mon 7 Dec");
});

test("a close that died half-way is finished by the job: the till's discount never outlives its sale (CodeRabbit #968)", async () => {
  const db = world();
  await X.putOnSale(db, { pids: ["a", "b"], price: 150 }, "junid", NOW);
  const sale = await get(db, `${R}/sales/a`);
  // The instance died right after the sale was taken off its node: the record is gone, the mirror still charges.
  await db.ref(`${R}/closing/a`).set({ at: NOW + 1000, why: "ended_by_junid", by: "junid", sale, taken: true });
  await db.ref(`${R}/sales/a`).remove();
  assert.deepEqual(await get(db, "products/a/bfSale"), { price: 150, start: NOW, end: END }, "the state the fix is for");
  assert.deepEqual(await X.finishClosing(db, NOW + 60_000), [], "a marker younger than two minutes belongs to a tap still running");
  assert.deepEqual(await X.finishClosing(db, NOW + 10 * 60_000), ["a"]);
  assert.equal(await get(db, "products/a/bfSale"), null);
  assert.equal((await get(db, `${R}/ended/a/${NOW}`)).why, "ended_by_junid");
  assert.equal(await get(db, `${R}/closing`), null);
  assert.deepEqual(await get(db, "products/b/bfSale"), { price: 150, start: NOW, end: END }, "the other sale is untouched");
  // Died BEFORE the sale was taken off: the sale stands, only the marker goes.
  await db.ref(`${R}/closing/b`).set({ at: NOW + 1000, why: "ended_by_junid", by: "junid", sale: await get(db, `${R}/sales/b`) });
  assert.deepEqual(await X.finishClosing(db, NOW + 10 * 60_000), []);
  assert.equal((await get(db, `${R}/sales/b`)).salePrice, 150);
  assert.deepEqual(await get(db, "products/b/bfSale"), { price: 150, start: NOW, end: END });
  assert.equal(await get(db, `${R}/closing`), null);
});

test("a normal close leaves no marker; the re-tag list names what goes BACK to the normal price for two days", async () => {
  const db = world();
  await X.putOnSale(db, { pids: ["a", "b"], price: 150 }, "junid", NOW);
  await X.closeSales(db, await X.salesFor(db, { pids: ["a"] }, NOW + 5), { uid: "junid", why: "ended_by_junid", nowMs: NOW + 5 });
  assert.equal(await get(db, `${R}/closing`), null);
  const back = await get(db, `${R}/back`);
  assert.deepEqual({ at: back.a.at, name: back.a.name, was: back.a.was }, { at: NOW + 5, name: "Tee A", was: 150 });
  const stock = { a: { "marathon-pe": 5, hub2: 4 }, b: { concrete: 6 } };
  const list = core.storeList(await get(db, `${R}/sales`), stock, { "marathon-pe": "Marathon PE" }, NOW + 10, { back });
  const pe = list.find((x) => x.loc === "marathon-pe");
  assert.deepEqual([pe.items.length, pe.back.map((x) => [x.pid, x.was, x.qty])], [0, [["a", 150, 5]]]);
  assert.deepEqual(list.find((x) => x.loc === "concrete").back, []);
  // On sale again: it is on the sale list, never on both.
  await X.putOnSale(db, { pids: ["a"], price: 140 }, "junid", NOW + 20);
  const again = core.storeList(await get(db, `${R}/sales`), stock, {}, NOW + 30, { back });
  assert.deepEqual([again.find((x) => x.loc === "hub2").items.map((x) => x.price), again.find((x) => x.loc === "hub2").back], [[140], []]);
  // Forgotten after two days.
  await X.finishClosing(db, NOW + 5 + core.BACK_MS + 1);
  assert.equal(await get(db, `${R}/back`), null);
});

test("the till's mirror is made again when the sale changed while it was being written (CodeRabbit #968)", async () => {
  const db = world();
  await X.putOnSale(db, { pids: ["a"], price: 150 }, "junid", NOW);
  // A price change lands between this sync's read of the sale and its write of the mirror.
  const real = db.ref.bind(db);
  let raced = false;
  const racing = { ...db, ref: (p) => {
    const r = real(p);
    if (p !== "products/a/bfSale" || raced) return r;
    return { ...r, set: async (v) => { raced = true; await real(`${R}/sales/a/salePrice`).set(120); return r.set(v); } };
  } };
  await X.syncMirror(racing, "a");
  assert.equal(raced, true);
  assert.equal((await get(db, "products/a/bfSale")).price, 120, "the stale R150 was replaced by the sale as it is");
});

test("stores RECEIVING a sale item are alerted too, from its OPEN requests only (Junid approved the request read, 23 Nov)", async () => {
  assert.deepEqual(core.receivers({
    r1: { productId: "a", status: "open", requestingLocation: "concrete", qty: 2 }, r2: { productId: "a", status: "open", requestingLocation: "concrete", qty: 1 },
    r3: { productId: "a", status: "fulfilled", requestingLocation: "trophy", qty: 4 }, r4: { productId: "a", status: "cancelled", requestingLocation: "hub1", qty: 1 },
    r5: { productId: "a", status: "open" }, r6: null,
  }), { concrete: 3 });
  assert.deepEqual(core.alertBurst("start", ["Tee A"], { salePrice: 150, end: END }, { arriving: true }), { title: "Black Friday sale", body: "Black Friday sale: Tee A now R150. On its way to you: tag at the sale price on arrival" });
  assert.equal(core.alertBurst("extend", ["Tee A", "Tee B"], { salePrice: 150, end: END }, { arriving: true }).body, "Tee A and Tee B, on their way to you, stay on sale until Mon 30 Nov");
  assert.equal(core.alertBurst("end", ["Tee A"], { salePrice: 150, end: END }, { arriving: true }).body, "Tee A is back to its normal price, re-tag");
  // The re-tag list: Concrete holds none of Tee A but has it on request.
  const sales = { a: { salePrice: 150, start: NOW, end: END, setAt: NOW, name: "Tee A" } };
  const list = core.storeList(sales, { a: { "marathon-pe": 5 } }, { "marathon-pe": "Marathon PE", concrete: "Concrete" }, NOW + 1, { coming: { a: { concrete: 3, "marathon-pe": 2, nowhere: 1 } } });
  assert.deepEqual(list.map((x) => [x.loc, x.items.map((i) => [i.qty, i.arriving || 0])]), [["concrete", [[0, 3]]], ["marathon-pe", [[5, 0]]]], "a holder is listed once, as a holder; an unknown location is not a store");
});

test("the receiving read is one indexed query per product and changes nothing on the requests", async () => {
  const asked = [];
  const rows = { r1: { productId: "a", status: "open", requestingLocation: "concrete", qty: 2 }, r2: { productId: "a", status: "fulfilled", requestingLocation: "trophy", qty: 1 } };
  const db = { ref: (p) => ({ orderByChild: (k) => ({ equalTo: (v) => ({ once: async () => { asked.push([p, k, v]); return { val: () => rows }; } }) }) }) };
  assert.deepEqual(await X.receivingOf(db, "a"), { concrete: 2 });
  assert.deepEqual(asked, [["refill_requests", "productId", "a"]]);
});
