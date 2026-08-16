// ─── Storefront search — the matcher, the ranking, and the public shape ──────
// The fixtures are REAL: every document below is a product that was live on
// marathonclub.co.za on 2026-08-16, with its TRUE app name and the compliant
// Shopify title beside it. That pairing IS the problem this search exists to
// solve, so the tests do not invent one.
//
// node:test, like every other suite in functions/ (`npm test` from functions/).

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  normWords, typoBudget, searchContext, tokenQuality, scoreDoc, search, publicResult,
  Q_EXACT, Q_PREFIX, Q_SUBSTR, Q_ACRONYM, Q_FUZZY,
} = require("../lib/storefront-search.cjs");

// A document as the endpoint holds it: search contexts precomputed once at load.
const doc = (d) => ({
  price: 75000, currency: "ZAR", image: "https://img/x.jpg", inStock: true,
  sizes: [{ size: "8", available: true }],
  ...d,
  ctx: {
    name: searchContext(d.name),
    title: searchContext(d.title),
    colour: searchContext(d.colour ?? ""),
    category: searchContext(d.category ?? ""),
    extras: searchContext(d.extras ?? ""),
    aliases: searchContext(d.aliases ?? ""),
  },
});

// ── The live corpus, 2026-08-16 ──────────────────────────────────────────────
const GRIPSHOT = doc({
  handle: "lace-boot-white-navy", title: "Lace Boot White Navy",
  name: "Lacoste Gripshot Lace Boot White Navy",
  colour: "white navy", category: "Footwear Boots", collection: "boots",
});
const SAMBA = doc({
  handle: "sneaker-white-core-black", title: "Sneaker White Core Black",
  name: "Adidas Samba White Core Black",
  colour: "white black", category: "Footwear Sneakers", collection: "sneakers",
});
const AF1 = doc({
  handle: "boots-shell-green", title: "Boots Shell Green",
  name: "Nike Air Force 1  Shell Green",
  colour: "green", category: "Footwear Boots", collection: "boots",
});
const SLIDE = doc({
  handle: "slide-brown", title: "Slide brown",
  name: "Gucci slide brown", colour: "brown",
  category: "Footwear Sandals & Slides", collection: "sandals-slides",
  inStock: false,
});
const CORPUS = [GRIPSHOT, SAMBA, AF1, SLIDE];

const handles = (hits) => hits.map((h) => h.doc.handle);

// ─────────────────────────────────────────────────────────────────────────────
test("normalisation folds case, punctuation and accents into comparable words", () => {
  assert.strictEqual(normWords("Aïr-Force 1"), "air force 1");
  assert.strictEqual(normWords("  Mt. Maddsen/Waterproof  "), "mt maddsen waterproof");
  assert.strictEqual(normWords("Levi's"), "levi s");
  assert.strictEqual(normWords(null), "");
  assert.strictEqual(normWords(undefined), "");
});

test("the typo budget scales with token length", () => {
  // 1-2 characters must be near-exact: a budget there matches almost anything.
  assert.strictEqual(typoBudget(1), 0);
  assert.strictEqual(typoBudget(2), 0);
  assert.strictEqual(typoBudget(3), 1);
  assert.strictEqual(typoBudget(5), 1);
  assert.strictEqual(typoBudget(6), 2);
  assert.strictEqual(typoBudget(20), 2);
});

test("tokenQuality grades the KINDS of match apart, so ranking is possible", () => {
  const ctx = searchContext("Lacoste Gripshot Lace Boot White Navy");
  assert.strictEqual(tokenQuality("gripshot", ctx), Q_EXACT);
  assert.strictEqual(tokenQuality("grip", ctx), Q_PREFIX);
  assert.strictEqual(tokenQuality("ipsho", ctx), Q_SUBSTR);    // inside a word
  assert.strictEqual(tokenQuality("laceboot", ctx), Q_SUBSTR); // across a word join
  assert.strictEqual(tokenQuality("gripshoot", ctx), Q_FUZZY); // one insertion
  assert.strictEqual(tokenQuality("zzzzz", ctx), 0);
  assert.strictEqual(tokenQuality("lglb", searchContext("Lacoste Gripshot Lace Boot")), Q_ACRONYM);
  // A 2-char typo is NOT rescued — that budget would match the whole catalogue.
  assert.strictEqual(tokenQuality("xy", searchContext("Lacoste")), 0);
});

// ── THE FAILING CASE THIS SERVICE EXISTS FOR ─────────────────────────────────
test('a stripped sub-label finds the exact product carrying it: "gripshot"', () => {
  // Shopify's own search cannot do this. The product is titled "Lace Boot White
  // Navy" and the string "gripshot" appears NOWHERE on the shop.
  assert.ok(!GRIPSHOT.title.toLowerCase().includes("gripshot"));
  assert.deepStrictEqual(handles(search(CORPUS, "gripshot")), ["lace-boot-white-navy"]);
});

test('"samba" returns the Samba and NOT the other white/black shoes', () => {
  assert.ok(!SAMBA.title.toLowerCase().includes("samba"));
  assert.deepStrictEqual(handles(search(CORPUS, "samba")), ["sneaker-white-core-black"]);
});

test('"air force" returns the AF1 the lexicon rebuilt as "Boots Shell Green"', () => {
  assert.strictEqual(search(CORPUS, "air force")[0].doc.handle, "boots-shell-green");
});

test("and the true brand never appears in the response", () => {
  const json = JSON.stringify(publicResult(search(CORPUS, "gripshot")[0])).toLowerCase();
  for (const term of ["lacoste", "gripshot", "adidas", "nike", "gucci"]) {
    assert.strictEqual(json.includes(term), false, `"${term}" leaked into the response`);
  }
});

test("misspellings and partial words still land on the right product", () => {
  const cases = [
    ["gripshoot", "lace-boot-white-navy"],  // doubled letter
    ["gripshto", "lace-boot-white-navy"],   // transposition
    ["gripsho", "lace-boot-white-navy"],    // still typing
    ["sambe", "sneaker-white-core-black"],  // wrong vowel
    ["lacoste", "lace-boot-white-navy"],    // the parent brand, also stripped
  ];
  for (const [q, handle] of cases) {
    assert.strictEqual(search(CORPUS, q)[0]?.doc.handle, handle, `query "${q}"`);
  }
  // A word that is in no document must find nothing, not a near-miss.
  assert.deepStrictEqual(search(CORPUS, "maddsen"), []);
});

test("every query token must hit something — an AND across tokens, not an OR", () => {
  assert.strictEqual(search(CORPUS, "samba white")[0].doc.handle, "sneaker-white-core-black");
  // Not every brown shoe, and not every Samba.
  assert.deepStrictEqual(search(CORPUS, "samba brown"), []);
  assert.deepStrictEqual(search(CORPUS, "qwertyuiop"), []);
  assert.deepStrictEqual(search(CORPUS, ""), []);
  assert.deepStrictEqual(search(CORPUS, "   "), []);
});

test("an exact NAME hit outranks a category hit", () => {
  // "boot" is in two documents' CATEGORY and in one document's NAME.
  assert.strictEqual(search(CORPUS, "boot")[0].doc.handle, "lace-boot-white-navy");
});

test("in-stock breaks a tie towards something buyable", () => {
  const a = doc({ handle: "aaa", title: "Slide brown", name: "Slide brown", inStock: false });
  const b = doc({ handle: "zzz", title: "Slide brown", name: "Slide brown", inStock: true });
  assert.strictEqual(search([a, b], "slide brown")[0].doc.handle, "zzz");
});

test("ties break on handle, so the same query never shuffles between instances", () => {
  const a = doc({ handle: "zzz", title: "Slide brown", name: "Slide brown", inStock: true });
  const b = doc({ handle: "aaa", title: "Slide brown", name: "Slide brown", inStock: true });
  assert.strictEqual(search([a, b], "slide brown")[0].doc.handle, "aaa");
  assert.strictEqual(search([b, a], "slide brown")[0].doc.handle, "aaa"); // input order irrelevant
});

test("the limit is respected", () => {
  assert.ok(search(CORPUS, "slide", { limit: 1 }).length <= 1);
});

test("scoreDoc returns 0 when ANY token misses, whatever the others scored", () => {
  assert.strictEqual(scoreDoc(GRIPSHOT, ["gripshot", "zzzzzz"]), 0);
  assert.strictEqual(scoreDoc(GRIPSHOT, []), 0);
});

test("scoreDoc averages rather than sums, so query lengths are comparable", () => {
  const one = scoreDoc(GRIPSHOT, ["gripshot"]);
  const two = scoreDoc(GRIPSHOT, ["gripshot", "navy"]);
  assert.ok(Math.abs(one - two) < 0.2, `one=${one} two=${two}`);
});

// ── THE PUBLIC SHAPE — assume the response is public, because it is ──────────
test("publicResult carries exactly the fields a result card needs, and no others", () => {
  const result = publicResult({ doc: GRIPSHOT, score: 0.9 });
  assert.deepStrictEqual(
    Object.keys(result).sort(),
    ["collection", "currency", "handle", "image", "inStock", "price", "score", "sizes", "title"]
  );
});

test("publicResult is an ALLOW-LIST: a field added to the index later cannot leak", () => {
  // This is the whole reason it constructs a fresh object instead of deleting
  // fields from the stored one. A delete-list silently ships whatever is added
  // — and `extras` and `aliases` were added later, which is the point.
  const decorated = {
    ...GRIPSHOT,
    brand: "Lacoste", stockPrice: 650, sku: "0388",
    productId: "p1777982149507", supplier: "SomeSupplier", secret: "x",
    extras: "Lacoste Gripshot White Navy", aliases: "lacoste t clip",
  };
  const json = JSON.stringify(publicResult({ doc: decorated, score: 1 }));
  for (const leak of ["Lacoste", "lacoste", "650", "0388", "p1777982149507", "SomeSupplier", "secret", "Gripshot", "t clip"]) {
    assert.strictEqual(json.includes(leak), false, `"${leak}" leaked into the response`);
  }
});

test("availability is a BOOLEAN per size — never a quantity, never a location", () => {
  const withQty = { ...GRIPSHOT, sizes: [{ size: "8", available: true, quantity: 3, location: "hub2" }] };
  const out = publicResult({ doc: withQty, score: 1 });
  assert.deepStrictEqual(out.sizes, [{ size: "8", available: true }]);
  const json = JSON.stringify(out);
  assert.strictEqual(json.includes("hub2"), false);
  assert.strictEqual(json.includes("quantity"), false);
});

test("publicResult tolerates a bare document without throwing", () => {
  const bare = publicResult({ doc: { handle: "h", title: "t", price: 1, currency: "ZAR" }, score: 0 });
  assert.deepStrictEqual(bare.sizes, []);
  assert.strictEqual(bare.image, null);
  assert.strictEqual(bare.inStock, false);
  assert.strictEqual(bare.collection, null);
});

// ── ALIASES: how a correct spelling finds a misspelt record ──────────────────
// The trigger lexicon was built from a census of how this catalogue actually
// misspells brands, so it folds "Timbalend" onto the label "timberland". The
// index stores that label, because "timberland" vs "Timbalend motion creem" is
// three edits apart — beyond any typo budget worth having, and a REAL live
// record (p-…, storefront 2026-08-17).
test("a canonical spelling finds a record that carries the misspelling", () => {
  const misspelt = doc({
    handle: "boots-motion-cream", title: "Boots motion cream",
    name: "Timbalend motion creem", aliases: "timberland",
    category: "Footwear Boots", collection: "boots",
  });
  // Without the alias the matcher cannot reach it: three edits on a 10-char
  // token is outside the budget.
  assert.strictEqual(tokenQuality("timberland", searchContext("Timbalend motion creem")), 0);
  // With it, the shopper's correct spelling lands.
  assert.strictEqual(search([misspelt], "timberland")[0]?.doc.handle, "boots-motion-cream");
});

test("aliases never reach the response", () => {
  const misspelt = doc({
    handle: "boots-motion-cream", title: "Boots motion cream",
    name: "Timbalend motion creem", aliases: "timberland",
  });
  const json = JSON.stringify(publicResult({ doc: misspelt, score: 1 })).toLowerCase();
  assert.strictEqual(json.includes("timberland"), false);
  assert.strictEqual(json.includes("timbalend"), false);
});

test("the identity field outranks the Shopify title when both match", () => {
  // A shopper typing a brand should get the product whose IDENTITY says it,
  // not one whose compliant title happens to contain the same word.
  const byIdentity = doc({ handle: "a-identity", title: "Low-top sneaker Black", name: "Adidas Samba Black" });
  const byTitle = doc({ handle: "z-title", title: "Samba style sneaker", name: "Generic sneaker black" });
  assert.strictEqual(search([byTitle, byIdentity], "samba")[0].doc.handle, "a-identity");
});
