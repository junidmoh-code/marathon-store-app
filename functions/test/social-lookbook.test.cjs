// ─── THE LOOKBOOK PICKER, RESOLVER, ROTATION AND NO-TEXT READING ─────────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const lb = require("../lib/social-lookbook.cjs");
const { loadLookbookCandidates, loadRecentLookbookPids } = require("../lookbook/load.cjs");
const { FakeRtdb } = require("./fixtures/rtdb-fake.cjs");

const NOW = Date.UTC(2026, 9, 17, 5, 0);
const DAY = 86400000;
const STUDIO = (pid) => `https://firebasestorage.googleapis.com/v0/b/b/o/${encodeURIComponent(`products/${pid}/new_arrivals/a.jpg`)}?alt=media`;
const STAFF = (pid) => `https://firebasestorage.googleapis.com/v0/b/b/o/${encodeURIComponent(`products/${pid}/photo.jpg`)}?alt=media`;

// A buildCandidates-shaped row.
const cand = (pid, categoryKey, over = {}) => ({
  pid, name: `${categoryKey} ${pid}`, displayName: `Nike ${categoryKey} ${pid}`, handle: pid, link: `https://x/${pid}`,
  liveAt: NOW - DAY, newNorm: 1, score: 0.5, slot: null,
  node: { photos: [STAFF(pid)] },
  product: { categoryKey, retailPrice: 1000, photoUrl: STAFF(pid), sizes: ["M"] },
  ...over,
  ...(over.product ? { product: { categoryKey, retailPrice: 1000, photoUrl: STAFF(pid), sizes: ["M"], ...over.product } } : {}),
});
const SIX = () => [
  cand("h1", "fitted-caps", { product: { retailPrice: 499 } }),
  cand("j1", "jackets", { product: { retailPrice: 1899 } }),
  cand("t1", "t-shirts", { product: { retailPrice: 599 } }),
  cand("b1", "shorts", { product: { retailPrice: 799 } }),
  cand("g1", "bags", { product: { retailPrice: 1249 } }),
  cand("s1", "sneakers", { product: { retailPrice: 3598 } }),
];

describe("price and photo resolver", () => {
  test("the price is retailPrice, rounded to whole rand, or nothing", () => {
    assert.equal(lb.priceOf({ retailPrice: 1399 }), 1399);
    assert.equal(lb.priceOf({ retailPrice: "1399" }), 1399);
    assert.equal(lb.priceOf({ retailPrice: 1399.6 }), 1400);
    for (const bad of [0, -5, "", null, undefined, NaN, true, "abc", Infinity]) {
      assert.equal(lb.priceOf({ retailPrice: bad }), null, String(bad));
    }
    assert.equal(lb.priceOf(null), null);
  });

  test('"R1,399": comma thousands, no decimals', () => {
    assert.equal(lb.formatRand(1399), "R1,399");
    assert.equal(lb.formatRand(8643), "R8,643");
    assert.equal(lb.formatRand(999), "R999");
    assert.equal(lb.formatRand(12345), "R12,345");
    assert.equal(lb.formatRand(1234567), "R1,234,567");
    assert.equal(lb.formatRand(0), null);
  });

  test("the New Arrivals studio photo wins where one exists", () => {
    assert.deepEqual(lb.approvedPhoto({ photoUrl: STUDIO("p") }, { photos: [STAFF("p")] }), { url: STUDIO("p"), studio: true });
    assert.deepEqual(lb.approvedPhoto({ photoUrl: STAFF("p") }, { photos: ["https://lead"] }), { url: "https://lead", studio: false });
    // RTDB may hand an array back as an object.
    assert.deepEqual(lb.approvedPhoto({}, { photos: { 1: "https://lead" } }), { url: "https://lead", studio: false });
    // An emptied photos array is DELETED by RTDB, so the key is absent.
    assert.deepEqual(lb.approvedPhoto({ photoUrl: STAFF("p") }, {}), { url: STAFF("p"), studio: false });
    assert.equal(lb.approvedPhoto({}, {}), null);
  });

  test("slots come from categoryKey; the title only orders reads", () => {
    assert.equal(lb.lookbookSlot({ categoryKey: "caps-beanies" }), "hat");
    assert.equal(lb.lookbookSlot({ categoryKey: "hoodies" }), "jacket");
    assert.equal(lb.lookbookSlot({ categoryKey: "golf-t-shirts" }), "tee");
    assert.equal(lb.lookbookSlot({ categoryKey: "jeans" }), "bottoms");
    assert.equal(lb.lookbookSlot({ categoryKey: "bags" }), "bag");
    assert.equal(lb.lookbookSlot({ categoryKey: "sneakers" }), "sneakers");
    assert.equal(lb.lookbookSlot({ categoryKey: "soccer-boots" }), null);
    assert.equal(lb.lookbookSlot({ categoryKey: "perfumes" }), null);
    assert.equal(lb.lookbookSlot({}), null);
    assert.equal(lb.guessSlot("Sneaker Cream Black Grey"), "sneakers");
    assert.equal(lb.guessSlot("Pants raw cargo jean"), "bottoms");
    assert.equal(lb.guessSlot("Beanie ribbed"), "hat");
    assert.equal(lb.guessSlot("Suit jacket brown FF1070"), null);
    assert.equal(lb.guessSlot("Zip-hoodie and joggers tracksuit in warm tan fleece"), null);
    assert.equal(lb.guessSlot("Knit wool-blend raglan sweater"), "jacket");
    assert.equal(lb.guessSlot("Textured knit runner in orange"), "sneakers");
    assert.equal(lb.guessSlot("Ribbed-knit short-sleeve polo with contrast tipping"), "tee");
    assert.equal(lb.guessSlot("Cropped bomber jacket silhouette in washed sand beige"), "jacket");
  });
});

describe("pickLookbookOutfit", () => {
  test("six rows, head to toe, total summed from the rows", () => {
    const r = lb.pickLookbookOutfit(SIX().reverse());
    assert.equal(r.reason, null);
    assert.deepEqual(r.rows.map((x) => x.slot), ["hat", "jacket", "tee", "bottoms", "bag", "sneakers"]);
    assert.equal(r.total, 499 + 1899 + 599 + 799 + 1249 + 3598);
    assert.equal(r.rows[5].priceText, "R3,598");
  });

  test("a product with no price or no photo is skipped and the next in its slot is taken — never stalls", () => {
    const list = SIX();
    list[5] = cand("s0", "sneakers", { score: 0.99, product: { retailPrice: null } });
    list.push(cand("s9", "sneakers", { product: { retailPrice: 2199 } }));
    list.push(cand("t0", "t-shirts", { score: 0.99, node: {}, product: { photoUrl: null } }));
    const r = lb.pickLookbookOutfit(list);
    assert.equal(r.rows.find((x) => x.slot === "sneakers").pid, "s9");
    assert.equal(r.rows.find((x) => x.slot === "tee").pid, "t1");
    assert.ok(r.skipped.some((s) => s.pid === "s0" && s.why === "no retail price"));
    assert.ok(r.skipped.some((s) => s.pid === "t0" && s.why === "no approved photo"));
  });

  test("an empty slot drops its row; four rows is enough", () => {
    const r = lb.pickLookbookOutfit(SIX().filter((c) => !["h1", "g1"].includes(c.pid)));
    assert.equal(r.reason, null);
    assert.deepEqual(r.rows.map((x) => x.slot), ["jacket", "tee", "bottoms", "sneakers"]);
    assert.deepEqual(r.missing, ["hat", "bag"]);
  });

  test("three rows is not a lookbook — refused with the reason", () => {
    const r = lb.pickLookbookOutfit(SIX().slice(0, 3));
    assert.deepEqual(r.rows, []);
    assert.match(r.reason, /only 3 of the six slots/);
  });

  test("bias: not in the last 14 lookbooks beats score; a studio photo beats a staff one", () => {
    const list = [
      ...SIX(),
      cand("t2", "t-shirts", { score: 0.1 }),
      cand("b2", "shorts", { score: 0.1, product: { photoUrl: STUDIO("b2") } }),
    ];
    const r = lb.pickLookbookOutfit(list, { recent: new Set(["t1"]) });
    assert.equal(r.rows.find((x) => x.slot === "tee").pid, "t2");
    assert.equal(r.rows.find((x) => x.slot === "bottoms").pid, "b2");
    assert.equal(r.rows.find((x) => x.slot === "bottoms").studio, true);
  });

  test("today's reel products are never re-used", () => {
    const list = [...SIX(), cand("s2", "sneakers")];
    const r = lb.pickLookbookOutfit(list, { used: new Set(["s1"]) });
    assert.equal(r.rows.find((x) => x.slot === "sneakers").pid, "s2");
  });

  test("is deterministic on ties", () => {
    const a = lb.pickLookbookOutfit([...SIX(), cand("t0", "t-shirts")]);
    const b = lb.pickLookbookOutfit([cand("t0", "t-shirts"), ...SIX()].reverse());
    assert.deepEqual(a.rows.map((x) => x.pid), b.rows.map((x) => x.pid));
  });
});

describe("history — written and read back through a real-shaped RTDB", () => {
  test("an empty pid list is DELETED by RTDB and reads back as nothing, not a crash", async () => {
    const db = new FakeRtdb();
    await db.ref("social_lookbook/history/2026-10-10").set({ pids: [], at: 1 });
    await db.ref("social_lookbook/history/2026-10-12").set(lb.historyEntry([{ pid: "a" }, { pid: "b" }], 2));
    const raw = (await db.ref("social_lookbook/history").once("value")).val();
    assert.equal(raw["2026-10-10"].pids, undefined, "the fake must delete the empty array like RTDB does");
    assert.deepEqual([...await loadRecentLookbookPids(db)].sort(), ["a", "b"]);
  });

  test("a sparse array comes back as an object and is still read", () => {
    const s = lb.recentLookbookPids({ d1: { pids: { 0: "a", 7: "z" } } });
    assert.deepEqual([...s].sort(), ["a", "z"]);
  });

  test("only the last 14 lookbooks count", async () => {
    const db = new FakeRtdb();
    for (let i = 1; i <= 20; i++) {
      await db.ref(`social_lookbook/history/2026-09-${String(i).padStart(2, "0")}`).set({ pids: [`p${i}`], at: i });
    }
    const s = await loadRecentLookbookPids(db);
    assert.equal(s.size, 14);
    assert.ok(!s.has("p6") && s.has("p7") && s.has("p20"));
    // bounded: a key-ordered limitToLast, never the whole namespace
    const r = db.reads.find((x) => x.path === "social_lookbook/history");
    assert.equal(r.query.last, 14);
  });
});

describe("rotation", () => {
  test("STILL_FORMATS: default, weighted, unknown dropped, LOOKBOOK_ENABLED off, explicit []", () => {
    assert.deepEqual(lb.parseStillFormats(undefined), ["current", "lookbook"]);
    assert.deepEqual(lb.parseStillFormats('["current","lookbook","lookbook"]'), ["current", "lookbook", "lookbook"]);
    assert.deepEqual(lb.parseStillFormats('["Current","video","lookbook"]'), ["current", "lookbook"]);
    assert.deepEqual(lb.parseStillFormats("not json"), ["current", "lookbook"]);
    assert.deepEqual(lb.parseStillFormats(undefined, { lookbookEnabled: false }), ["current"]);
    assert.deepEqual(lb.parseStillFormats("[]"), []);
  });

  test("strictly alternates, advances once per date, survives a cold-cache transaction", async () => {
    const db = new FakeRtdb();   // coldTransactions on: first call sees null
    const F = ["current", "lookbook"];
    const got = [];
    for (const d of ["2026-10-18", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]) {
      await db.ref("social_lookbook/rotation").transaction((cur) => lb.advanceRotation(cur, d, F));
      got.push((await db.ref("social_lookbook/rotation").once("value")).val().format);
    }
    assert.deepEqual(got, ["current", "current", "lookbook", "current", "lookbook"]);
  });

  test("the calendar follows the stored sequence", () => {
    const cal = lb.stillCalendar({ seq: 0, lastDate: "2026-10-18", format: "current" }, "2026-10-18", ["current", "lookbook"], 4);
    assert.deepEqual(cal.map((c) => `${c.date}:${c.format}`), [
      "2026-10-18:current", "2026-10-19:lookbook", "2026-10-20:current", "2026-10-21:lookbook"]);
    const fresh = lb.stillCalendar(null, "2026-10-18", ["current", "lookbook"], 2);
    assert.deepEqual(fresh.map((c) => c.format), ["current", "lookbook"]);
  });
});

describe("hero prompt and the no-text check", () => {
  const rows = lb.pickLookbookOutfit(SIX()).rows;

  test("the prompt lists every garment against its reference and forbids text", () => {
    const p = lb.buildHeroPrompt(rows);
    assert.match(p, /no text, no logos other than those on the garments, no captions, no watermark/i);
    rows.forEach((r, i) => assert.ok(p.includes(`REFERENCE ${i + 1}`)));
    assert.doesNotMatch(p, /R\d/);   // never a price in the prompt
  });

  test("text found fails; unreadable fails; clean passes with anchors", () => {
    assert.equal(lb.readHeroCheck('{"text_found": true, "text_seen": "VOGUE", "items": {}}', rows).ok, false);
    assert.equal(lb.readHeroCheck("I think it is fine", rows).ok, false);
    assert.equal(lb.readHeroCheck('{"text_found": "no"}', rows).ok, false);
    const ok = lb.readHeroCheck('```json\n{"text_found": false, "text_seen": "", "items": {"hat": {"x": 0.5, "y": 0.07}, "sneakers": {"x": 2, "y": 0.9}}}\n```', rows);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.anchors, { hat: { x: 0.5, y: 0.07 } });
  });

  test("dots: vision where plausible, the category spot otherwise", () => {
    const a = lb.anchorsFor(rows, { hat: { x: 0.52, y: 0.08 }, sneakers: { x: 0.5, y: 0.2 } });
    assert.equal(a.hat.source, "vision");
    assert.equal(a.sneakers.source, "category");
    assert.equal(a.sneakers.y, 0.82);
  });
});

describe("loadLookbookCandidates — reads only what it needs, by pid", () => {
  const seed = () => {
    const live = {}, products = {}, stock = { shop1: {}, hub3: {} };
    const add = (pid, title, categoryKey, over = {}) => {
      live[pid] = { state: "live", liveState: "on", cleanName: title, liveAt: NOW - DAY, photos: [STAFF(pid)] };
      products[pid] = { name: `Nike ${title}`, categoryKey, retailPrice: 900, sizes: ["M"], photoUrl: STAFF(pid), ...over };
      stock.shop1[pid] = { M: { qty: 2 } };
    };
    add("h1", "Cap fitted", "fitted-caps");
    add("j1", "Jacket puffer", "jackets");
    add("t1", "T shirt box", "t-shirts");
    add("b1", "Shorts mesh", "shorts");
    add("g1", "Bag sling", "bags", { retailPrice: 0 });     // no price → skipped
    add("s1", "Sneaker low", "sneakers");
    add("s2", "Sneaker high", "sneakers");
    stock.shop1.s2 = { M: { qty: 0 } };                    // out of stock
    stock.hub3.s2 = { M: { qty: 9 } };                     // untrusted: does not count
    live.x1 = { state: "live", liveState: "on", cleanName: "Fragrance 100ML", liveAt: NOW };
    products.x1 = { categoryKey: "perfumes", retailPrice: 900, sizes: ["_"] };
    return new FakeRtdb({ shopify_publish: live, products, stock, locations: { shop1: { name: "S" }, hub3: { name: "H" } } });
  };

  test("candidates are live, in stock, priced and photographed", async () => {
    const db = seed();
    const { candidates } = await loadLookbookCandidates(db, { nowMs: NOW });
    assert.deepEqual(candidates.map((c) => c.pid).sort(), ["b1", "h1", "j1", "s1", "t1"]);
    const r = lb.pickLookbookOutfit(candidates);
    assert.deepEqual(r.rows.map((x) => x.slot), ["hat", "jacket", "tee", "bottoms", "sneakers"]);
  });

  test("a slot whose newest reads are all out of stock gets a second round", async () => {
    const db = seed();
    // s2 is the newest sneaker and is out of stock; with one read per slot the
    // first round finds no sneaker and the second must read s1.
    db.root.shopify_publish.s2.liveAt = NOW;
    const { candidates } = await loadLookbookCandidates(db, { nowMs: NOW, readsPerSlot: 1 });
    assert.ok(candidates.some((c) => c.pid === "s1"));
  });

  test("no whole-node read of /products or /stock, and the live read is the indexed query", async () => {
    const db = seed();
    await loadLookbookCandidates(db, { nowMs: NOW });
    for (const r of db.reads) {
      assert.notEqual(r.path, "products");
      assert.notEqual(r.path, "stock");
      assert.ok(!/^stock\/[^/]+$/.test(r.path), r.path);
    }
    const live = db.reads.find((r) => r.path === "shopify_publish");
    assert.deepEqual(live.query, { by: "state", eq: "live" });
    // the unguessable perfume was never read, and the unpriced bag cost no stock reads
    assert.ok(!db.reads.some((r) => r.path === "products/x1"));
    assert.ok(!db.reads.some((r) => r.path.startsWith("stock/") && r.path.endsWith("/g1")));
  });
});
