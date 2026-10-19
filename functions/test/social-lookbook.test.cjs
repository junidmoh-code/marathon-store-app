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
  // `name` is the website title (shopify_publish cleanName); the till name and
  // the brand are on the product record.
  pid, name: `Washed ${categoryKey} with tonal detail ${pid}`, displayName: `Nike ${categoryKey} ${pid}`, handle: pid, link: `https://x/${pid}`,
  liveAt: NOW - DAY, newNorm: 1, score: 0.5, slot: null,
  node: { photos: [STAFF(pid)] },
  product: { categoryKey, brand: "Nike", name: `Nike ${categoryKey} ${pid}`, retailPrice: 300, photoUrl: STAFF(pid), sizes: ["M"] },
  ...over,
  ...(over.product ? { product: { categoryKey, brand: "Nike", name: `Nike ${categoryKey} ${pid}`, retailPrice: 300, photoUrl: STAFF(pid), sizes: ["M"], ...over.product } } : {}),
});
// Six rows that total R1,850, inside the R1,400–R1,900 band.
const SIX = () => [
  cand("h1", "fitted-caps", { product: { retailPrice: 150 } }),
  cand("j1", "jackets", { product: { retailPrice: 350 } }),
  cand("t1", "t-shirts", { product: { retailPrice: 250 } }),
  cand("b1", "shorts", { product: { retailPrice: 300 } }),
  cand("g1", "bags", { product: { retailPrice: 300 } }),
  cand("s1", "sneakers", { product: { retailPrice: 500 } }),
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
    // May: a shoulder month, so the jacket is not an off-season piece.
    const r = lb.pickLookbookOutfit(SIX().reverse(), { month: 5 });
    assert.equal(r.reason, null);
    assert.deepEqual(r.rows.map((x) => x.slot), ["hat", "jacket", "tee", "bottoms", "bag", "sneakers"]);
    assert.equal(r.total, 1850);
    assert.equal(r.rows[5].priceText, "R500");
  });

  test("a product with no price or no photo is skipped and the next in its slot is taken — never stalls", () => {
    const list = SIX();
    list[5] = cand("s0", "sneakers", { score: 0.99, product: { retailPrice: null } });
    list.push(cand("s9", "sneakers", { product: { retailPrice: 450 } }));
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

  test("the band: products are chosen to land the total in R1,400–R1,900, prices never touched", () => {
    // The best-ranked sneaker (s0, R1,650) would take every look over R1,900.
    const list = [...SIX(), cand("s0", "sneakers", { score: 0.99, product: { retailPrice: 1650 } })];
    const r = lb.pickLookbookOutfit(list);
    assert.equal(r.reason, null);
    assert.ok(r.total >= 1400 && r.total <= 1900, String(r.total));
    assert.equal(r.rows.find((x) => x.slot === "sneakers").pid, "s1");
    assert.equal(r.rows.find((x) => x.slot === "sneakers").price, 500);
  });

  test("the band: six rows that cannot fit drop to fewer, down to four", () => {
    // Six rows total R2,450; only the four-row core (+ nothing) fits.
    const list = [
      cand("h1", "fitted-caps", { product: { retailPrice: 300 } }),
      cand("j1", "jackets", { product: { retailPrice: 500 } }),
      cand("t1", "t-shirts", { product: { retailPrice: 350 } }),
      cand("b1", "shorts", { product: { retailPrice: 450 } }),
      cand("g1", "bags", { product: { retailPrice: 250 } }),
      cand("s1", "sneakers", { product: { retailPrice: 600 } }),
    ];
    const r = lb.pickLookbookOutfit(list);
    assert.equal(r.reason, null);
    assert.ok(r.total >= 1400 && r.total <= 1900, String(r.total));
    assert.ok(r.rows.length >= 4 && r.rows.length < 6);
    for (const k of ["bottoms", "sneakers"]) assert.ok(r.rows.some((x) => x.slot === k), k);
  });

  test("the band: nothing fits even at four rows — refused (the day posts the current style)", () => {
    const list = SIX().map((c) => ({ ...c, product: { ...c.product, retailPrice: 900 } }));
    const r = lb.pickLookbookOutfit(list);
    assert.deepEqual(r.rows, []);
    assert.equal(r.band, true);
    assert.match(r.reason, /R1,400–R1,900/);
    const cheap = SIX().map((c) => ({ ...c, product: { ...c.product, retailPrice: 100 } }));
    const r2 = lb.pickLookbookOutfit(cheap);
    assert.equal(r2.band, true);
    assert.match(r2.reason, /closest: R600 with 6 rows/);
  });

  test("names: no brand, a till placeholder brand, or no usable website name is not eligible", () => {
    const list = [
      ...SIX(),
      cand("s7", "sneakers", { score: 0.99, product: { retailPrice: 450, brand: "" } }),
      cand("s8", "sneakers", { score: 0.99, product: { retailPrice: 450, brand: "Jacket" } }),
      cand("s9", "sneakers", { score: 0.99, name: "Sneaker black", product: { retailPrice: 450 } }),
      cand("s6", "sneakers", { score: 0.99, name: "Sneaker runner tonal", product: { retailPrice: 450, name: "Nike flyknit runner tonal #12" } }),
    ];
    const r = lb.pickLookbookOutfit(list);
    assert.equal(r.rows.find((x) => x.slot === "sneakers").pid, "s1");
    const why = Object.fromEntries(r.skipped.map((x) => [x.pid, x.why]));
    assert.equal(why.s7, "no brand");
    assert.equal(why.s8, "no brand");
    assert.match(why.s9, /colour-only/);
    assert.match(why.s6, /inventory string/);
    const t = r.rows.find((x) => x.slot === "tee");
    assert.equal(t.brandLine, "NIKE");
    assert.equal(t.nameLine, "WASHED T-SHIRTS WITH TONAL DETAIL T1");
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

  test("lookbook on Mon/Wed/Fri by default, current the other four", () => {
    const F = ["current", "lookbook"];
    const days = lb.parseLookbookDays(undefined);
    assert.deepEqual(days, ["mon", "wed", "fri"]);
    const cal = lb.stillCalendar("2026-10-18", F, days, 7);
    assert.deepEqual(cal.map((c) => `${c.date}:${c.day}:${c.format}`), [
      "2026-10-18:sun:current", "2026-10-19:mon:lookbook", "2026-10-20:tue:current",
      "2026-10-21:wed:lookbook", "2026-10-22:thu:current", "2026-10-23:fri:lookbook",
      "2026-10-24:sat:current"]);
    assert.equal(cal.filter((c) => c.format === "lookbook").length, 3);
  });

  test("LOOKBOOK_DAYS is config: names, case, order, junk, [] and a typo", () => {
    assert.deepEqual(lb.parseLookbookDays('["Friday","TUE","mon","mon","xyz"]'), ["mon", "tue", "fri"]);
    assert.deepEqual(lb.parseLookbookDays("[]"), []);
    assert.deepEqual(lb.parseLookbookDays("mon,wed"), ["mon", "wed", "fri"]);   // unreadable -> default
    assert.equal(lb.plannedStillFormat("2026-10-19", ["current", "lookbook"], []), "current");
  });

  test("STILL_FORMATS still decides what may run on any day", () => {
    const days = ["mon", "wed", "fri"];
    assert.equal(lb.plannedStillFormat("2026-10-19", ["current"], days), "current");   // lookbook switched off
    assert.equal(lb.plannedStillFormat("2026-10-20", ["lookbook"], days), "lookbook"); // only lookbook left
    assert.equal(lb.plannedStillFormat("2026-10-19", [], days), null);
  });
});

describe("hero prompt and the no-text check", () => {
  const rows = lb.pickLookbookOutfit(SIX(), { month: 5 }).rows;

  test("the prompt lists every garment against its reference and forbids text", () => {
    const p = lb.buildHeroPrompt(rows);
    assert.match(p, /no text, no logos other than those on the garments, no captions, no watermark/i);
    rows.forEach((r, i) => assert.ok(p.includes(`REFERENCE ${i + 1}`)));
    assert.doesNotMatch(p, /R\d/);   // never a price in the prompt
  });

  test("text found fails; unreadable fails; clean passes", () => {
    assert.equal(lb.readHeroCheck('{"text_found": true, "text_seen": "VOGUE"}').ok, false);
    assert.equal(lb.readHeroCheck("I think it is fine").ok, false);
    assert.equal(lb.readHeroCheck('{"text_found": "no"}').ok, false);
    assert.equal(lb.readHeroCheck('```json\n{"text_found": false, "text_seen": ""}\n```').ok, true);
  });

  test("the text check never sees the grid; the locate prompt names every row", () => {
    assert.doesNotMatch(lb.buildHeroCheckPrompt(), /grid/i);
    const p = lb.buildLocatePrompt(rows);
    for (const r of rows) assert.ok(p.includes(`"${r.slot}"`));
  });

  test("grid cells read back as cell centres; nonsense is absent, not a guess", () => {
    const l = lb.readLocate('{"head": "F3", "items": {"hat": "f2", "tee": "Z9", "bag": null, "sneakers": "G21"}}', rows);
    assert.deepEqual(l.head, { x: 5.5 / 12, y: 2.5 / 20 });
    assert.deepEqual(Object.keys(l.anchors), ["hat"]);
    assert.deepEqual(lb.readLocate("no idea", rows), { anchors: {}, head: null });
  });

  test("dots: vision where plausible, the category spot otherwise", () => {
    const a = lb.anchorsFor(rows, { hat: { x: 0.52, y: 0.08 }, sneakers: { x: 0.5, y: 0.2 } });
    assert.equal(a.hat.source, "vision");
    assert.equal(a.sneakers.source, "category");
    assert.equal(a.sneakers.y, 0.855);
  });

  test("with a known head, the category spots follow the real body", () => {
    const a = lb.anchorsFor(rows, { hat: { x: 0.46, y: 0.21 }, sneakers: { x: 0.47, y: 0.93 } }, { x: 0.46, y: 0.27 });
    assert.equal(a.jacket.source, "body");
    // jacket template 0.24 on a 0.09..0.855 body, stretched onto 0.27..0.93
    assert.ok(Math.abs(a.jacket.y - (0.27 + 0.15 * (0.66 / 0.765))) < 1e-9);
    assert.ok(Math.abs(a.jacket.x - 0.41) < 1e-9);
    assert.ok(a.bottoms.y > 0.6 && a.bottoms.y < 0.7);
  });

  test("a hat reported far from the head snaps to just above the head", () => {
    const a = lb.anchorsFor(rows, { hat: { x: 0.5, y: 0.12 } }, { x: 0.52, y: 0.24 });
    assert.equal(a.hat.x, 0.52);
    assert.ok(Math.abs(a.hat.y - 0.20) < 1e-9);
  });
});

describe("loadLookbookCandidates — reads only what it needs, by pid", () => {
  const seed = () => {
    const live = {}, products = {}, stock = { shop1: {}, hub3: {} };
    const add = (pid, title, categoryKey, over = {}) => {
      live[pid] = { state: "live", liveState: "on", cleanName: title, liveAt: NOW - DAY, photos: [STAFF(pid)] };
      products[pid] = { name: `Nike ${categoryKey} ${pid}`, brand: "Nike", categoryKey, retailPrice: 300, sizes: ["M"], photoUrl: STAFF(pid), ...over };
      stock.shop1[pid] = { M: { qty: 2 } };
    };
    add("h1", "Cap fitted with curved brim", "fitted-caps");
    add("j1", "Jacket puffer quilted", "jackets");
    add("t1", "T shirt boxy heavyweight", "t-shirts");
    add("b1", "Shorts mesh with drawcord", "shorts");
    add("g1", "Bag sling ripstop", "bags", { retailPrice: 0 });     // no price → skipped
    add("s1", "Sneaker low suede", "sneakers");
    add("s2", "Sneaker high leather", "sneakers");
    add("s3", "Sneaker black", "sneakers");                          // colour-only website name → skipped, no stock read
    add("s4", "Sneaker runner mesh", "sneakers", { brand: "" });     // no brand → skipped
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

describe("lookbook v2 (owner review of sample 01, 2026-10-18)", () => {
  const sd = require("../lib/social-design.cjs");
  const name = (n) => lb.posterName(n, { fallbackSplit: sd.splitName, isCategory: (w) => Boolean(lb.guessSlot(w)) });

  test("posterName: the catalogue's spellings of multi-word brands, in proper form", () => {
    assert.deepEqual(name("G star raw cargo jeans FG3546#"), { brand: "G-STAR RAW", rest: "CARGO JEANS" });
    assert.deepEqual(name("G-Star Raw Cargo Jean GS-5211"), { brand: "G-STAR RAW", rest: "CARGO JEAN GS-5211" });
    assert.deepEqual(name("Gstar jeans"), { brand: "G-STAR RAW", rest: "JEANS" });
    assert.deepEqual(name("Hugo boss beanie red"), { brand: "HUGO BOSS", rest: "BEANIE RED" });
    assert.deepEqual(name("Alexander McQueen Oversized Beige White"), { brand: "ALEXANDER MCQUEEN", rest: "OVERSIZED BEIGE WHITE" });
    assert.deepEqual(name("The North Face Glenclyffe Low Green"), { brand: "THE NORTH FACE", rest: "GLENCLYFFE LOW GREEN" });
    assert.deepEqual(name("Karl Lagerfeld beanie brown"), { brand: "KARL LAGERFELD", rest: "BEANIE BROWN" });
  });

  test("posterName: single-word brands, unbranded names and bare brands", () => {
    assert.deepEqual(name("Lacoste bag green"), { brand: "LACOSTE", rest: "BAG GREEN" });
    assert.deepEqual(name("Diesel jean FD1299#"), { brand: "DIESEL", rest: "JEAN" });
    assert.deepEqual(name("Jacket black white stripes"), { brand: "", rest: "JACKET BLACK WHITE STRIPES" });
    assert.deepEqual(name("Hugo Boss"), { brand: "", rest: "HUGO BOSS" });
    assert.deepEqual(name(""), { brand: "", rest: "" });
    // "Gold chain" starts with G but is not G-Star.
    assert.equal(name("Gold chain").brand, "GOLD");
  });

  test("stripStyleCodes: '#' at either end of a token; real model numbers stay", () => {
    assert.equal(lb.stripStyleCodes("Adidas Tracksuit Grey #2506"), "Adidas Tracksuit Grey");
    assert.equal(lb.stripStyleCodes("DIESEL JEAN BLUE  #Y8161-1 slim"), "DIESEL JEAN BLUE slim");
    assert.equal(lb.stripStyleCodes("G star raw cargo jeans FG3546#"), "G star raw cargo jeans");
    assert.equal(lb.stripStyleCodes("Replay jeans B1113-3"), "Replay jeans B1113-3");
    assert.equal(lb.stripStyleCodes("Nike Air Force 1"), "Nike Air Force 1");
  });

  test("LOOKBOOK_SCENES: concrete first by default; config order, dedup, unknowns dropped", () => {
    // Concrete only since go-live (19 Oct); the garden is still a valid key.
    assert.deepEqual(lb.parseLookbookScenes(undefined), ["concrete"]);
    assert.deepEqual(lb.parseLookbookScenes('["garden","concrete","garden"]'), ["garden", "concrete"]);
    assert.deepEqual(lb.parseLookbookScenes('["beach"]'), ["concrete"]);
    assert.deepEqual(lb.parseLookbookScenes("garden"), ["concrete"]);
    assert.deepEqual(lb.parseLookbookScenes('["GARDEN"]'), ["garden"]);
  });

  test("sceneFor: alternates per LOOKBOOK day, concrete on the first (Mon 19 Oct)", () => {
    const S = lb.parseLookbookScenes('["concrete","garden"]'), D = ["mon", "wed", "fri"];
    const at = (d) => lb.sceneFor(d, S, D).key;
    // the default is concrete every lookbook day
    assert.deepEqual(["2026-10-19", "2026-10-21", "2026-10-23"].map((d) => lb.sceneFor(d, lb.parseLookbookScenes(), D).key), ["concrete", "concrete", "concrete"]);
    assert.deepEqual(["2026-10-19", "2026-10-21", "2026-10-23", "2026-10-26", "2026-10-28"].map(at),
      ["concrete", "garden", "concrete", "garden", "concrete"]);
    // a non-lookbook day reads as the next lookbook day; days before the epoch keep alternating
    assert.equal(at("2026-10-20"), "garden");
    assert.equal(at("2026-10-16"), "garden");
    assert.equal(at("2026-10-14"), "concrete");
    // one scene configured: always that one
    assert.equal(lb.sceneFor("2026-10-21", ["garden"], D).key, "garden");
  });

  test("the hero prompt: the model requirement every time, the scene's floor in the composition", () => {
    const rows = [{ slot: "tee", displayName: "Nike Tee White" }];
    const c = lb.buildHeroPrompt(rows, { scene: "concrete" });
    assert.match(c, /The model MUST be a Black man with dark skin, athletic build, in his mid-20s to early 30s/);
    assert.match(c, /shoes rest on the concrete floor/);
    assert.match(c, /poured concrete floor/);
    assert.match(c, /no plants/i);
    assert.doesNotMatch(c, /MODEL REFERENCE/);
    const g = lb.buildHeroPrompt(rows, { scene: lb.LOOKBOOK_SCENE_DEFS.garden, modelRef: true });
    assert.match(g, /palm trees/);
    assert.match(g, /shoes rest on the paving/);
    assert.match(g, /MODEL REFERENCE photo/);
    assert.match(lb.buildModelRefPrompt(), /MUST be a Black man/);
  });

  test("readModelCheck: only an explicit true passes", () => {
    assert.equal(lb.readModelCheck('{"text_found":false,"model_black":true,"model_seen":"Black man"}').ok, true);
    const no = lb.readModelCheck('{"text_found":false,"model_black":false,"model_seen":"pale skin"}');
    assert.equal(no.ok, false);
    assert.match(no.reason, /not visibly a Black man \(pale skin\)/);
    assert.equal(lb.readModelCheck('{"text_found":false,"model_black":"yes"}').ok, false);
    assert.equal(lb.readModelCheck('{"text_found":false}').ok, false);
    assert.equal(lb.readModelCheck("he looks fine").ok, false);
    assert.match(lb.buildHeroCheckPrompt(), /"model_black": true\|false/);
  });

  test("the thumbnail prompt: the product alone on pure white, faithful to the reference", () => {
    const p = lb.buildThumbPrompt({ slot: "sneakers", displayName: "Alexander McQueen Oversized" });
    assert.match(p, /Alexander McQueen Oversized/);
    assert.match(p, /no hand, no person, no hanger, no hook, no box, no packaging, no tag/);
    assert.match(p, /Pure white seamless background \(#FFFFFF\)/);
    assert.match(p, /pair of shoes/);
    assert.match(lb.buildThumbPrompt({ slot: "hat", displayName: "x" }), /front-on/);
  });
});

describe("lookbook v2 — architect review of #750", () => {
  const sd = require("../lib/social-design.cjs");
  const name = (n) => lb.posterName(n, { fallbackSplit: sd.splitName, isCategory: (w) => Boolean(lb.guessSlot(w)) });
  test("a bare first word takes the long brand only when no other house follows it", () => {
    assert.equal(name("Karl Kani tee").brand, "KARL");
    assert.equal(name("Alexander Wang hoodie").brand, "ALEXANDER");
    assert.equal(name("Tommy Bahama shirt").brand, "TOMMY");
    assert.equal(name("Karl beanie brown").brand, "KARL LAGERFELD");
    assert.equal(name("Alexander Oversized White").brand, "ALEXANDER MCQUEEN");
  });
  test("a stray '#' on a model number is not a style code", () => {
    assert.equal(lb.stripStyleCodes("Nike Air Max 90#"), "Nike Air Max 90#");
    assert.equal(lb.stripStyleCodes("Diesel jean FD1299#"), "Diesel jean");
  });
  test("an unanswered model check is marked unreadable; an explicit false is not", () => {
    assert.equal(lb.readModelCheck('{"text_found":false}').unreadable, true);
    assert.equal(lb.readModelCheck('{"text_found":false,"model_black":false}').unreadable, undefined);
  });
});

describe("go-live review fixes", () => {
  test("a slot of expensive favourites cannot price the day out of the band: the cheapest are always searched", () => {
    const pricey = Array.from({ length: 8 }, (_, i) => cand(`s${i}`, "sneakers", { score: 0.9 - i * 0.01, product: { retailPrice: 1600 } }));
    const list = [...SIX().filter((c) => c.pid !== "s1"), ...pricey, cand("sz", "sneakers", { score: 0, product: { retailPrice: 500 } })];
    const r = lb.pickLookbookOutfit(list);
    assert.equal(r.reason, null);
    assert.equal(r.rows.find((x) => x.slot === "sneakers").pid, "sz");
  });

  test("brands: Polo is a house; a category word on its own record is a placeholder", () => {
    assert.equal(lb.posterBrand({ brand: "Polo", name: "Polo Ralph Lauren pony tee" }), "POLO RALPH LAUREN");
    assert.equal(lb.posterBrand({ brand: "Polo", name: "Polo classic tee" }), "POLO");
    assert.equal(lb.posterBrand({ brand: "Golf", categoryKey: "golf-t-shirts", name: "Golf t-shirt black" }), null);
    assert.equal(lb.posterBrand({ brand: "Jacket", name: "Jacket brown #1611" }), null);
    assert.equal(lb.posterBrand({ brand: "Boss", name: "Hugo boss beanie red #4" }), "HUGO BOSS");
    assert.equal(lb.posterBrand({ brand: "Under", name: "Under Amour black and blue bag" }), "UNDER ARMOUR");
  });

  test("website names: the till string is refused, a good name sharing its words is not", () => {
    const n = (web, inv) => lb.panelName(web, { name: inv });
    assert.equal(n("Dunk Low Panda", "Nike dunk low panda #5521").name, "Dunk Low Panda");
    assert.equal(n("Air Max 90", "Air max 90 white #1").name, "Air Max 90");
    assert.equal(n("Tech Fleece Joggers", "Nike tech fleece joggers").name, "Tech Fleece Joggers");
    assert.equal(n("Beanie Grey with white logo", "Karl Lagerfeld beanie Grey 2").name, "Beanie Grey with white logo");
    assert.match(n("Jacket black white stripes #1552", "Jacket black white stripes #1552").why, /colour-only/);
    assert.match(n("Raw cargo jeans FD3554", "G star raw cargo jeans FD3554#").why, /stock code/);
    assert.match(n("Sneaker xl black end white", "Puma suede xl black end white").why, /garment word for the brand/);
    assert.match(n("Sneaker 1fontanka cream white brown", "Nike airforce 1fontanka cream white, brown").why, /garment word for the brand/);
    assert.match(n("Puma suede classic", "Puma suede classic").why, /inventory string/);
  });

  test("website names: codes stripped, models kept", () => {
    assert.match(lb.panelName("Pants raw cargo jeanFG3551 tapered", { name: "x" }).why, /stock code/);
    assert.equal(lb.panelName("Retro runner P6000 in silver mesh", { name: "x" }).name, "Retro runner P6000 in silver mesh");
  });
});

describe("stylist gates (review of #759)", () => {
  test("looks in the band that all break the guide are the style gate, not price", () => {
    // Every tee is a print and every pair of shorts is logo-heavy: two loud pieces.
    const list = SIX().filter((c) => !["h1", "j1"].includes(c.pid));
    const tags = new Map([
      ["t1", { dominant: "black", secondary: null, pattern: "print", silhouette: "regular", family: "athleisure", formality: 3, season: "all" }],
      ["b1", { dominant: "black", secondary: null, pattern: "logo-heavy", silhouette: "regular", family: "athleisure", formality: 3, season: "all" }],
      ["s1", { dominant: "white", secondary: null, pattern: "solid", silhouette: "n/a", family: "athleisure", formality: 3, season: "all" }],
    ]);
    const extra = cand("s2", "sneakers", { product: { retailPrice: 900 } });
    tags.set("s2", tags.get("s1"));
    tags.set("g1", { ...tags.get("s1"), dominant: "black" });
    const r = lb.pickLookbookOutfit([...list, extra, cand("s3", "sneakers", { product: { retailPrice: 600 } })], { tags: new Map([...tags, ["s3", tags.get("s1")]]), band: { min: 100, max: 5000 } });
    assert.equal(r.style, true, r.reason);
    assert.match(r.reason, /passes the style guide/);
  });
});
