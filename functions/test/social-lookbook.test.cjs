// ─── THE LOOKBOOK PICKER, RESOLVER, ROTATION AND NO-TEXT READING ─────────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const lb = require("../lib/social-lookbook.cjs");
const { loadLookbookCandidates, loadRecentLookbookPids } = require("../lookbook/load.cjs");
const { FakeRtdb } = require("./fixtures/rtdb-fake.cjs");
const { mensTagMap } = require("./fixtures/mens-tags.cjs");
// The picker with every untagged fixture read as a men's piece.
const pick = (list, opts = {}) => lb.pickLookbookOutfit(list, { ...opts, tags: mensTagMap(list, opts.tags) });

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
// Six rows that total R1,850.
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

  test("the product's ONE primary photo wins; a studio photo is flagged as one", () => {
    assert.deepEqual(lb.approvedPhoto({ photoUrl: STUDIO("p") }, { photos: [STAFF("p")] }), { url: STUDIO("p"), studio: true });
    assert.deepEqual(lb.approvedPhoto({ photoUrl: STAFF("p") }, { photos: ["https://lead"] }), { url: STAFF("p"), studio: false });
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
    // A low-top is a sneaker, not a top (19 Oct: 47 of 96 tee reads were sneakers).
    assert.equal(lb.guessSlot("Leather low-top in white on a cup sole with retro, minimal, basketball styling"), "sneakers");
    assert.equal(lb.guessSlot("Quilted nubuck low-top in black"), "sneakers");
    assert.equal(lb.guessSlot("Sleeveless tank top with airbrushed stars"), "tee");
  });
});

describe("pickLookbookOutfit", () => {
  test("six rows, head to toe, total summed from the rows", () => {
    // May: a shoulder month, so the jacket is not an off-season piece.
    const r = pick(SIX().reverse(), { month: 5 });
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
    const r = pick(list);
    assert.equal(r.rows.find((x) => x.slot === "sneakers").pid, "s9");
    assert.equal(r.rows.find((x) => x.slot === "tee").pid, "t1");
    assert.ok(r.skipped.some((s) => s.pid === "s0" && s.why === "no retail price"));
    assert.ok(r.skipped.some((s) => s.pid === "t0" && s.why === "no approved photo"));
  });

  test("three rows is a lookbook: a tee, bottoms and sneakers; an October jacket stays home", () => {
    const r = pick(SIX().filter((c) => !["h1", "g1"].includes(c.pid)));
    assert.equal(r.reason, null);
    assert.deepEqual(r.rows.map((x) => x.slot), ["tee", "bottoms", "sneakers"]);
    assert.deepEqual(r.missing, ["hat", "jacket", "bag"]);
    // In May (a shoulder month) the outer layer pays nothing and can be worn.
    assert.ok(pick(SIX().filter((c) => !["h1", "g1"].includes(c.pid)), { month: 5 }).shortlist.some((o) => o.rows.some((x) => x.slot === "jacket")));
  });

  test("no tee, bottoms or sneakers is not a lookbook — refused with the reason", () => {
    const r = pick(SIX().slice(0, 3));
    assert.deepEqual(r.rows, []);
    assert.match(r.reason, /only 3 of the six slots .*nothing for: bottoms, bag, sneakers/);
  });

  test("price never refuses: R900 a piece, R100 a piece and a R1,650 sneaker are all dressed", () => {
    for (const price of [900, 100]) {
      const r = pick(SIX().map((c) => ({ ...c, product: { ...c.product, retailPrice: price } })));
      assert.equal(r.reason, null, String(price));
      assert.equal(r.total, price * r.rows.length);
    }
    const list = [...SIX().filter((c) => c.pid !== "s1"), cand("s0", "sneakers", { product: { retailPrice: 1650 } })];
    const r = pick(list);
    assert.equal(r.rows.find((x) => x.slot === "sneakers").price, 1650);
    assert.equal("PRICE_BAND" in lb, false);
    assert.deepEqual(lb.PRICE_PREFER, { min: 1200, max: 3500 });
  });

  test("price is a tie-breaker only: an exact tie goes to the total inside R1,200–R3,500", () => {
    // Two sneakers identical in every tag and score, one at R5,000.
    const list = [...SIX().filter((c) => c.pid !== "s1"),
      cand("s2", "sneakers", { product: { retailPrice: 5000 } }), cand("s3", "sneakers", { product: { retailPrice: 600 } })];
    const tags = mensTagMap(list);
    tags.set("s2", tags.get("s3"));
    const r = pick(list, { tags });
    assert.equal(r.rows.find((x) => x.slot === "sneakers").pid, "s3");
    // Turn the preference round and the tie goes the other way: it is the
    // only thing deciding it.
    const r2 = pick(list, { tags, prefer: { min: 5000, max: 9000 } });
    assert.equal(r2.rows.find((x) => x.slot === "sneakers").pid, "s2");
  });

  test("names: no brand, a till placeholder brand, or no usable website name is not eligible", () => {
    const list = [
      ...SIX(),
      cand("s7", "sneakers", { score: 0.99, product: { retailPrice: 450, brand: "" } }),
      cand("s8", "sneakers", { score: 0.99, product: { retailPrice: 450, brand: "Jacket" } }),
      cand("s9", "sneakers", { score: 0.99, name: "Sneaker black", product: { retailPrice: 450 } }),
      cand("s6", "sneakers", { score: 0.99, name: "Sneaker runner tonal", product: { retailPrice: 450, name: "Nike flyknit runner tonal #12" } }),
    ];
    const r = pick(list);
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
    const r = pick(list, { recent: new Set(["t1"]) });
    assert.equal(r.rows.find((x) => x.slot === "tee").pid, "t2");
    assert.equal(r.rows.find((x) => x.slot === "bottoms").pid, "b2");
    assert.equal(r.rows.find((x) => x.slot === "bottoms").studio, true);
  });

  test("today's reel products are never re-used", () => {
    const list = [...SIX(), cand("s2", "sneakers")];
    const r = pick(list, { used: new Set(["s1"]) });
    assert.equal(r.rows.find((x) => x.slot === "sneakers").pid, "s2");
  });

  test("is deterministic on ties", () => {
    const a = pick([...SIX(), cand("t0", "t-shirts")]);
    const b = pick([cand("t0", "t-shirts"), ...SIX()].reverse());
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

const HM = require("../lookbook/house-models.cjs");
const BLACK = HM.MODELS.black;

describe("hero prompt and the no-text check", () => {
  const rows = pick(SIX(), { month: 5 }).rows;

  test("the prompt lists every garment against its reference and forbids text", () => {
    const p = lb.buildHeroPrompt(rows, { model: BLACK });
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
    assert.doesNotMatch(lb.buildHeroCheckPrompt(BLACK), /grid/i);
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
    const r = pick(candidates);
    // October: the puffer stays home, the fitted cap is a cap.
    assert.deepEqual(r.rows.map((x) => x.slot), ["hat", "tee", "bottoms", "sneakers"]);
  });

  test("a beanie title costs no read when the season removes beanies", async () => {
    const db = seed();
    db.root.shopify_publish.h9 = { state: "live", liveState: "on", cleanName: "Ribbed knit beanie with logo", liveAt: NOW, photos: [STAFF("h9")] };
    db.root.products.h9 = { name: "Nike beanie h9", brand: "Nike", categoryKey: "caps-beanies", retailPrice: 200, sizes: ["M"], photoUrl: STAFF("h9") };
    await loadLookbookCandidates(db, { nowMs: NOW, skipHeadwear: ["beanie"] });
    assert.ok(!db.reads.some((r) => r.path === "products/h9"));
    assert.ok(db.reads.some((r) => r.path === "products/h1"), "the cap is still read");
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

  test("LOOKBOOK_SCENES: real SA outdoor locations by default; config order, dedup, unknowns dropped", () => {
    // Court, street, concrete wall since 26 Oct (Junid: "not studio fake");
    // concrete and garden are still valid keys.
    const OUT = ["court", "street", "wall"];
    assert.deepEqual(lb.parseLookbookScenes(undefined), OUT);
    assert.deepEqual(lb.parseLookbookScenes('["garden","concrete","garden"]'), ["garden", "concrete"]);
    assert.deepEqual(lb.parseLookbookScenes('["beach"]'), OUT);
    assert.deepEqual(lb.parseLookbookScenes("garden"), OUT);
    assert.deepEqual(lb.parseLookbookScenes('["GARDEN"]'), ["garden"]);
  });

  test("sceneFor: alternates per LOOKBOOK day, concrete on the first (Mon 19 Oct)", () => {
    const S = lb.parseLookbookScenes('["concrete","garden"]'), D = ["mon", "wed", "fri"];
    const at = (d) => lb.sceneFor(d, S, D).key;
    // the default rotates court, street, wall per lookbook day
    assert.deepEqual(["2026-10-19", "2026-10-21", "2026-10-23", "2026-10-26"].map((d) => lb.sceneFor(d, lb.parseLookbookScenes(), D).key), ["court", "street", "wall", "court"]);
    assert.deepEqual(["2026-10-19", "2026-10-21", "2026-10-23", "2026-10-26", "2026-10-28"].map(at),
      ["concrete", "garden", "concrete", "garden", "concrete"]);
    // a non-lookbook day reads as the next lookbook day; days before the epoch keep alternating
    assert.equal(at("2026-10-20"), "garden");
    assert.equal(at("2026-10-16"), "garden");
    assert.equal(at("2026-10-14"), "concrete");
    // one scene configured: always that one
    assert.equal(lb.sceneFor("2026-10-21", ["garden"], D).key, "garden");
  });

  test("the casting re-shoot of a picked face: the same man from his FACE REFERENCE, taller, a low camera", () => {
    const p = lb.buildModelRefPrompt(HM.MODELS.black, { fromFace: true });
    assert.match(p, /FACE REFERENCE photo: exactly the same face/);
    assert.match(p, /taller and longer-legged than in the reference/);
    // Junid, 31 Oct: "give them a proper wide sholders as well".
    assert.match(p, /proper wide, broad, square shoulders over a slim waist/);
    assert.match(p, /camera low/);
    assert.doesNotMatch(lb.buildModelRefPrompt(HM.MODELS.black), /FACE REFERENCE/);
  });
  test("the hero prompt: his model's requirement every time, a professional shoot, his reference, the scene's floor", () => {
    const rows = [{ slot: "tee", displayName: "Nike Tee White" }];
    const c = lb.buildHeroPrompt(rows, { scene: "concrete", model: BLACK });
    assert.match(c, /The model MUST be a young Black South African man in his early-to-mid 20s, very tall \(about 1\.90 m/);
    // Junid, 30 Oct: "still short in height": a low camera, nothing beside him for scale.
    assert.match(c, /camera low, at about his hip height/);
    assert.match(c, /professional fashion photographer on a full-frame camera with an 85mm prime lens/);
    assert.match(c, /Not a phone snapshot/);
    assert.match(c, /confident professional model pose/);
    assert.match(c, /MODEL REFERENCE photo/);
    assert.match(c, /shoes rest on the concrete floor/);
    assert.match(c, /no plants/i);
    const w = lb.buildHeroPrompt(rows, { scene: "court", model: HM.MODELS.white });
    assert.match(w, /MUST be a young white South African man/);
    assert.match(lb.buildHeroPrompt(rows, { scene: lb.LOOKBOOK_SCENE_DEFS.garden, model: HM.MODELS.coloured }), /Coloured South African man \(Cape mixed heritage\)[\s\S]*palm trees/);
    assert.throws(() => lb.buildHeroPrompt(rows, { scene: "concrete" }), /a house model is required/);
    for (const k of ["court", "street", "wall"]) {
      const p = lb.buildHeroPrompt(rows, { scene: k, model: BLACK });
      assert.match(p, /Not a studio, no studio lighting/);
      assert.match(p, /professional location fashion shoot/);
      assert.doesNotMatch(p, /35mm street photograph/);
    }
  });

  test("the candidate prompt: invented, full length, a professional shoot, one model's brief", () => {
    for (const s of HM.ORDER) {
      const p = lb.buildModelRefPrompt(HM.MODELS[s]);
      assert.ok(p.includes(HM.MODELS[s].description));
      assert.match(p, /invented person: not a celebrity, athlete, influencer, model or any real individual, and not a likeness of one/);
      assert.match(p, /Full length, head to toe in frame/);
      assert.match(p, /professional fashion photographer/);
    }
    assert.throws(() => lb.buildModelRefPrompt(), /a house model is required/);
  });

  test("readModelCheck: only an explicit model_match true passes; the check asks for his brief", () => {
    assert.equal(lb.readModelCheck('{"text_found":false,"model_match":true,"model_seen":"young Black man"}').ok, true);
    const no = lb.readModelCheck('{"text_found":false,"model_match":false,"model_seen":"long hair"}');
    assert.equal(no.ok, false);
    assert.match(no.reason, /not visibly the house model \(long hair\)/);
    assert.equal(lb.readModelCheck('{"text_found":false,"model_match":"yes"}').ok, false);
    assert.equal(lb.readModelCheck('{"text_found":false,"model_black":true}').ok, false);
    assert.equal(lb.readModelCheck('{"text_found":false}').ok, false);
    assert.equal(lb.readModelCheck("he looks fine").ok, false);
    assert.match(lb.buildHeroCheckPrompt(BLACK), /"model_match": true\|false/);
    assert.match(lb.buildHeroCheckPrompt(HM.MODELS.coloured), /visibly a young Coloured South African man/);
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
    assert.equal(lb.readModelCheck('{"text_found":false,"model_match":false}').unreadable, undefined);
  });
});

describe("go-live review fixes", () => {
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
  test("outfits that all break the guide are the style gate", () => {
    // Every tee is a print and every pair of shorts is logo-heavy: two loud pieces.
    const list = SIX().filter((c) => !["h1", "j1"].includes(c.pid));
    const V2 = { gender: "mens", cut: "none", headwear: "n/a", knit: false };
    const tags = new Map([
      ["t1", { dominant: "black", secondary: null, pattern: "print", silhouette: "regular", family: "athleisure", formality: 3, season: "all", ...V2 }],
      ["b1", { dominant: "black", secondary: null, pattern: "logo-heavy", silhouette: "regular", family: "athleisure", formality: 3, season: "all", ...V2 }],
      ["s1", { dominant: "white", secondary: null, pattern: "solid", silhouette: "n/a", family: "athleisure", formality: 3, season: "all", ...V2 }],
    ]);
    const extra = cand("s2", "sneakers", { product: { retailPrice: 900 } });
    tags.set("s2", tags.get("s1"));
    tags.set("g1", { ...tags.get("s1"), dominant: "black" });
    const r = pick([...list, extra, cand("s3", "sneakers", { product: { retailPrice: 600 } })], { tags: new Map([...tags, ["s3", tags.get("s1")]]) });
    assert.equal(r.style, true, r.reason);
    assert.match(r.reason, /passes the style guide/);
  });
});

// ── JUNID'S REVIEW OF SAMPLES 06–08 (19 Oct) ─────────────────────────────────
describe("menswear only (sample 08: women's Alo bike shorts on the male model)", () => {
  // The real record is p1784653439034: till name "Alo short cream white"
  // (which the display name gate also refuses), website name "High-waisted
  // compression bike shorts with side pockets". Here its till name is a good
  // one, so only the gender rule stands between it and the poster.
  const alo = () => cand("alo", "shorts", {
    name: "High-waisted compression bike shorts with side pockets", displayName: "Alo Airlift high-rise short",
    score: 0.99, product: { brand: "Alo", name: "Alo Airlift high-rise short", retailPrice: 350 },
  });
  const ALO_V2 = { dominant: "cream", secondary: null, pattern: "solid", silhouette: "slim", family: "athleisure", formality: 2, season: "summer", gender: "womens", cut: "bike-short", headwear: "n/a", knit: false, source: "vision" };

  test("tagged womens, the Alo bike shorts are removed before scoring, whatever they would score", () => {
    const list = [...SIX(), alo()];
    const r = pick(list, { tags: new Map([["alo", ALO_V2]]) });
    assert.equal(r.reason, null);
    assert.ok(!r.shortlist.some((o) => o.rows.some((x) => x.pid === "alo")));
  });

  test("a misread unisex tag does not save them: the cut, or the website name, removes them", () => {
    for (const t of [{ ...ALO_V2, gender: "unisex" }, { ...ALO_V2, gender: "unisex", cut: "none" }]) {
      const r = pick([...SIX(), alo()], { tags: new Map([["alo", t]]) });
      assert.ok(!r.shortlist.some((o) => o.rows.some((x) => x.pid === "alo")), JSON.stringify(t));
    }
    const sty = require("../lib/stylist.cjs");
    assert.match(sty.menswearRefusal({ tags: { ...ALO_V2, gender: "unisex", cut: "none" }, websiteName: "High-waisted compression bike shorts with side pockets" }), /bike-short/);
  });

  test("no gender tag is never assumed unisex; mens and unisex pieces are kept", () => {
    const sty = require("../lib/stylist.cjs");
    assert.equal(sty.menswearRefusal({ tags: { gender: null } }), "no gender tag");
    assert.equal(sty.menswearRefusal({ tags: { gender: "mens", cut: "none" }, displayName: "Nike tee" }), null);
    assert.equal(sty.menswearRefusal({ tags: { gender: "unisex", cut: "none" }, displayName: "Nike cap" }), null);
    assert.match(sty.menswearRefusal({ tags: { gender: "unisex", cut: "none" }, displayName: "Nike Wmns Dunk Low" }), /womenswear by its name/);
    assert.match(sty.menswearRefusal({ tags: { gender: "mens", cut: "legging" } }), /legging/);
  });

  test("the report says what was removed; the real till name is refused even earlier", () => {
    const r = pick([...SIX(), alo()], { tags: new Map([["alo", ALO_V2]]) });
    assert.equal(r.excluded.womenswear, 1);
    assert.match(lb.displayNameRefusal("Alo short cream white", { brand: "Alo" }), /category and colour only/);
  });
});

describe("the display name gate (Junid, 19 Oct)", () => {
  const no = (name, brand) => lb.displayNameRefusal(name, { brand });
  test('"Jacket Brown" and "Bag Green" are a category and colour only', () => {
    assert.match(no("Jacket Brown", "Jacket"), /category and colour only/);
    assert.match(no("Jacket brown", ""), /category and colour only/);
    assert.match(no("Bag Green", ""), /category and colour only/);
    // A real brand in front changes nothing: LACOSTE over BAG GREEN.
    assert.match(no("Lacoste bag green", "Lacoste"), /category and colour only/);
    assert.match(no("Jacket", "Jacket"), /category and colour only/);
  });
  test('"Wanchao Wear 6925" has a bare model number and no brand', () => {
    assert.match(no("Wanchao Wear 6925", "Wanchao"), /bare stock or model number and no brand/);
    assert.match(no("PATTABON 3908 white", "PATTABON"), /bare stock/);
    assert.match(no("Bs-8022 black", "Bs-8022"), /bare stock/);
    assert.match(no("Giavceye Jean Jacket cream white WT0061-2", "Giavceye"), /bare stock/);
  });
  test("real names pass: a known brand's model number, a described piece, a fragrance volume", () => {
    for (const [n, b] of [["Nike Air Force 1 White Blue Laces", "Nike"], ["New Balance 550 White Green", "New balance"], ["Nike Air Max 90", "Nike"],
      ["Lacoste L12 100ML", "Lacoste"], ["Sonic Youth Graphic T-Shirt Black", "Sonic Youth"], ["G star raw cargo jeans", "G star raw"],
      ["Gallery Dept. White Distressed T-Shirt", "Gallery Dept"], ["Nike bag lite green", "Nike"],
      // The brand is taken off by its own spelling: "G-Star" is one word here.
      ["G-Star Raw GS-5222 Dark Navy", "G-Star"], ["Dr. Martens 1460 black", "Dr"]]) {
      assert.equal(no(n, b), null, n);
    }
  });
  test("on the lookbook a raw display name is skipped with its reason, the website name notwithstanding", () => {
    const list = [...SIX(),
      cand("jb", "hoodies", { score: 0.99, name: "Henley-collar knit sweater in heathered taupe", displayName: "Jacket brown", product: { brand: "Jacket", name: "Jacket brown #1513" } }),
      cand("ww", "t-shirts", { score: 0.99, name: "Boxy heavyweight tee", displayName: "Wanchao Wear 6925", product: { brand: "Wanchao", name: "Wanchao Wear 6925" } }),
      cand("bg", "bags", { score: 0.99, name: "Coated canvas shoulder pouch in dark green", displayName: "Lacoste bag green", product: { brand: "Lacoste", name: "Lacoste bag green" } })];
    const r = pick(list, { month: 5 });
    const why = Object.fromEntries(r.skipped.map((x) => [x.pid, x.why]));
    assert.match(why.jb, /no brand|category and colour/);
    assert.match(why.ww, /bare stock or model number/);
    assert.match(why.bg, /category and colour only/);
    assert.ok(!r.shortlist.some((o) => o.rows.some((x) => ["jb", "ww", "bg"].includes(x.pid))));
  });
});

describe("optional slots and headwear (Junid, 19 Oct)", () => {
  test("a beanie is never worn October to March; a cap can be", () => {
    const list = [...SIX().filter((c) => c.pid !== "h1"),
      cand("bn", "caps-beanies", { score: 0.99, name: "Ribbed turn-up knit beanie", product: { name: "Nike beanie ribbed", retailPrice: 180 } })];
    const r = pick(list);
    assert.equal(r.reason, null);
    assert.ok(!r.shortlist.some((o) => o.rows.some((x) => x.pid === "bn")));
    assert.ok(Object.keys(r.excluded).some((k) => /beanie in a Durban summer/.test(k)), JSON.stringify(r.excluded));
    // A cap tagged as such is allowed; a beanie named "cap" by the tag is still a beanie by its name.
    assert.ok(pick(SIX()).shortlist.some((o) => o.rows.some((x) => x.slot === "hat")));
    const tags = mensTagMap(list);
    tags.set("bn", { ...tags.get("bn"), headwear: "cap" });
    assert.ok(!pick(list, { tags }).shortlist.some((o) => o.rows.some((x) => x.pid === "bn")));
    // In July the beanie may be worn.
    assert.ok(pick(list, { month: 7 }).shortlist.some((o) => o.rows.some((x) => x.pid === "bn")));
  });

  test("headwear rests in two lookbooks of three", () => {
    assert.equal(lb.headwearRests({ "2026-10-16": ["tee", "bottoms", "sneakers"], "2026-10-19": ["hat", "tee", "bottoms", "sneakers"] }, "2026-10-21"), true);
    assert.equal(lb.headwearRests({ "2026-10-14": ["hat", "tee"], "2026-10-16": ["tee"], "2026-10-19": ["tee"] }, "2026-10-21"), false);
    // Today's own entry does not count.
    assert.equal(lb.headwearRests({ "2026-10-21": ["hat"] }, "2026-10-21"), false);
    const r = pick(SIX(), { noHeadwear: true });
    assert.ok(!r.shortlist.some((o) => o.rows.some((x) => x.slot === "hat")));
    assert.equal(lb.historyEntry([{ pid: "a", slot: "hat" }, { pid: "b", slot: "tee" }], 5).slots.join(), "hat,tee");
  });

  test("a look wears only the optional pieces it declares; a hat only in a look that wears one", () => {
    const sty = require("../lib/stylist.cjs");
    const hatLooks = sty.GUIDE.looks.filter((l) => l.extras.includes("hat")).map((l) => l.key);
    assert.ok(hatLooks.length <= sty.GUIDE.looks.length / 3);
    assert.ok(!hatLooks.includes("coastal-summer"));
    for (const o of pick(SIX()).shortlist) {
      if (o.rows.some((x) => x.slot === "hat")) assert.ok(hatLooks.includes(o.styled.look), o.styled.look);
    }
    const coastal = pick(SIX(), { look: "coastal-summer" });
    for (const o of coastal.shortlist) assert.ok(!o.rows.some((x) => x.slot === "hat" || x.slot === "jacket"));
  });

  test("rows and required slots for the samples: exactly N rows, with the slot asked for", () => {
    const r3 = pick(SIX(), { rows: 3 });
    assert.ok(r3.shortlist.every((o) => o.rows.length === 3));
    const r5 = pick(SIX(), { rows: 5, requireSlots: ["bag"], month: 5 });
    assert.equal(r5.reason, null);
    assert.ok(r5.shortlist.every((o) => o.rows.length === 5 && o.rows.some((x) => x.slot === "bag")));
  });

  test("knitwear and outer layers pay the season's penalty Oct–Mar: no cardigan over a sweater vest", () => {
    const list = [...SIX().filter((c) => !["h1", "g1", "j1"].includes(c.pid)),
      cand("cd", "jackets", { score: 0.99, name: "Chunky knit cardigan", product: { name: "Nike cardigan knit", retailPrice: 500 } }),
      cand("sv", "t-shirts", { score: 0.99, name: "Cable knit sweater vest", product: { name: "Nike sweater vest", retailPrice: 400 } })];
    const r = pick(list);
    assert.equal(r.reason, null);
    assert.ok(!r.rows.some((x) => x.pid === "cd" || x.pid === "sv"), r.rows.map((x) => x.pid).join());
    const sty = require("../lib/stylist.cjs");
    const piece = { slot: "jacket", tags: { knit: true } };
    assert.equal(sty.layerPenalty(piece, "summer"), 20);
    assert.equal(sty.layerPenalty(piece, "winter"), 0);
    // A knit polo is summer wear; a "knit runner" is a sneaker.
    assert.equal(sty.isKnitwear({ slot: "tee", tags: {}, displayName: "Lacoste knit polo" }), false);
    assert.equal(sty.isKnitwear({ slot: "sneakers", tags: {}, displayName: "Textured knit runner" }), false);
  });
});

test("historySlots: today's own entry (a rerun) is not one of the two days before; old entries are read by pid", async () => {
  const { historySlots } = require("../lookbook/lookbook.cjs");
  const db = new FakeRtdb({ products: { p1: { categoryKey: "fitted-caps" }, p2: { categoryKey: "t-shirts" } } });
  const history = { "2026-10-14": { pids: ["p1"] }, "2026-10-16": { pids: ["p2"], slots: ["tee"] }, "2026-10-19": { pids: ["p2"], slots: ["tee"] }, "2026-10-21": { pids: ["p1"], slots: ["hat"] } };
  const s = await historySlots(db, history, "2026-10-21");
  assert.deepEqual(Object.keys(s), ["2026-10-16", "2026-10-19"]);
  assert.equal(lb.headwearRests(s, "2026-10-21"), false);
  const s2 = await historySlots(db, history, "2026-10-17");
  assert.deepEqual(s2["2026-10-14"], ["hat"]);
  assert.equal(lb.headwearRests(s2, "2026-10-17"), true);
});
