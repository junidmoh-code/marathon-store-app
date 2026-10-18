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
  const rows = lb.pickLookbookOutfit(SIX()).rows;

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
    assert.equal(a.sneakers.y, 0.82);
  });

  test("with a known head, the category spots follow the real body", () => {
    const a = lb.anchorsFor(rows, { hat: { x: 0.46, y: 0.21 }, sneakers: { x: 0.47, y: 0.93 } }, { x: 0.46, y: 0.27 });
    assert.equal(a.jacket.source, "body");
    // jacket template 0.29 on a 0.16..0.82 body → 0.27 + (0.13 / 0.66) × 0.66
    assert.ok(Math.abs(a.jacket.y - 0.40) < 1e-9);
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
    assert.deepEqual(lb.parseLookbookScenes(undefined), ["concrete", "garden"]);
    assert.deepEqual(lb.parseLookbookScenes('["garden","concrete","garden"]'), ["garden", "concrete"]);
    assert.deepEqual(lb.parseLookbookScenes('["beach"]'), ["concrete", "garden"]);
    assert.deepEqual(lb.parseLookbookScenes("garden"), ["concrete", "garden"]);
    assert.deepEqual(lb.parseLookbookScenes('["GARDEN"]'), ["garden"]);
  });

  test("sceneFor: alternates per LOOKBOOK day, concrete on the first (Mon 19 Oct)", () => {
    const S = lb.parseLookbookScenes(), D = ["mon", "wed", "fri"];
    const at = (d) => lb.sceneFor(d, S, D).key;
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
