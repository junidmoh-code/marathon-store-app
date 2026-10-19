// ─── THE STYLIST: DETERMINISTIC SCORING AGAINST THE STYLE GUIDE ──────────────
// Fixture pieces with hand-written tags. The text model is never called here:
// it only breaks ties, and readChoice is tested on canned answers.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const sty = require("../lib/stylist.cjs");

// v2 tags: men's, no women's cut; a hat in these fixtures is a cap.
const T = (over = {}) => ({ dominant: "black", secondary: null, pattern: "solid", silhouette: "regular", family: "streetwear", formality: 3, season: "all", gender: "mens", cut: "none", headwear: "cap", knit: false, ...over });
let n = 0;
const P = (slot, tags = {}, over = {}) => ({ pid: over.pid || `${slot}${++n}`, slot, price: 300, fresh: 0.5, tags: T(tags), categoryKey: over.categoryKey || null, ...over });

// A black/white streetwear outfit: tee, cargo, sneaker.
const MONO = () => [
  P("tee", { dominant: "black", silhouette: "oversized" }, { pid: "tee-black" }),
  P("bottoms", { dominant: "charcoal", silhouette: "slim" }, { pid: "cargo-charcoal" }),
  P("sneakers", { dominant: "white", silhouette: "n/a" }, { pid: "af1-white" }),
];

describe("hard rules", () => {
  test("a clean outfit passes", () => assert.equal(sty.hardRule(MONO()), null));
  test("two accent hues are refused", () => {
    const o = [...MONO(), P("hat", { dominant: "red", family: "athleisure" }), P("bag", { dominant: "green", family: "streetwear" })];
    assert.match(sty.hardRule(o), /2 accent colours \(red, green\)/);
  });
  test("one accent hue on two pieces is fine", () => {
    assert.equal(sty.hardRule([...MONO(), P("hat", { dominant: "burgundy" }), P("bag", { dominant: "burgundy" })]), null);
  });
  test("two loud pieces are refused — a print and a logo-heavy piece, or a loud colour", () => {
    assert.match(sty.hardRule([P("tee", { pattern: "print" }), P("bottoms", { pattern: "logo-heavy" }), P("sneakers")]), /2 loud pieces/);
    assert.match(sty.hardRule([P("tee", { pattern: "print" }), P("bottoms"), P("sneakers", { dominant: "orange" })]), /2 loud pieces/);
  });
  test("formality more than two apart is refused", () => {
    assert.match(sty.hardRule([P("tee", { formality: 1 }), P("bottoms", { formality: 4 }), P("sneakers")]), /formality 1–4/);
    assert.equal(sty.hardRule([P("tee", { formality: 2 }), P("bottoms", { formality: 4 }), P("sneakers")]), null);
  });
  test("never all baggy: every garment oversized is refused, but not as a partial build", () => {
    const baggy = [P("tee", { silhouette: "oversized" }), P("bottoms", { silhouette: "oversized" }), P("sneakers", { silhouette: "n/a" })];
    assert.match(sty.hardRule(baggy), /every garment is oversized/);
    assert.equal(sty.hardRule(baggy, undefined, { partial: true }), null);
  });
  test("families must be one or border each other; accessories are free", () => {
    assert.equal(sty.hardRule([P("tee", { family: "athleisure" }), P("bottoms", { family: "streetwear" }), P("sneakers", { family: "athleisure" })]), null);
    assert.match(sty.hardRule([P("tee", { family: "athleisure" }), P("bottoms", { family: "prep" }), P("sneakers", { family: "athleisure" })]), /athleisure with prep/);
    assert.equal(sty.hardRule([...MONO(), P("hat", { family: "prep" })]), null);
  });
});

describe("colour harmony", () => {
  test("monochrome with white sneakers is a full score", () => {
    const c = sty.colourScore(MONO());
    assert.equal(c.score, 1);
    assert.ok(c.why.includes("monochrome") && c.why.includes("white sneakers anchor it"));
  });
  test("one earth-tone family scores as highly as monochrome", () => {
    const earth = [P("tee", { dominant: "cream" }), P("bottoms", { dominant: "olive" }), P("sneakers", { dominant: "brown" }), P("jacket", { dominant: "khaki" })];
    assert.equal(sty.colourScore(earth).score, 1);
  });
  test("all neutrals that are neither monochrome nor earth score lower", () => {
    const mixed = [P("tee", { dominant: "navy" }), P("bottoms", { dominant: "beige" }), P("sneakers", { dominant: "grey" })];
    assert.equal(sty.colourScore(mixed).score, 0.85);
  });
  test("one accent echoed on two pieces earns the echo; a second accent in the details costs", () => {
    const echo = [P("tee", { dominant: "black" }), P("bottoms", { dominant: "black" }), P("sneakers", { dominant: "black", secondary: "red" }), P("hat", { dominant: "red" })];
    assert.ok(sty.colourScore(echo).why.some((w) => /red echoed/.test(w)));
    const two = [P("tee", { dominant: "black", secondary: "blue" }), P("bottoms", { dominant: "black" }), P("sneakers", { dominant: "grey" }), P("hat", { dominant: "red" })];
    assert.ok(sty.colourScore(two).score < 0.75);
  });
});

describe("silhouette, family, formality, season", () => {
  test("loose over slim is the best balance; baggy over baggy the worst", () => {
    assert.equal(sty.silhouetteScore([P("jacket", { silhouette: "oversized" }), P("bottoms", { silhouette: "slim" })]).score, 1);
    assert.equal(sty.silhouetteScore([P("tee", { silhouette: "oversized" }), P("bottoms", { silhouette: "oversized" })]).score, 0.4);
    assert.equal(sty.silhouetteScore([P("tee", { silhouette: "regular" }), P("bottoms", { silhouette: "regular" })]).score, 0.8);
  });
  test("the outer layer decides the top's volume", () => {
    const s = sty.silhouetteScore([P("tee", { silhouette: "oversized" }), P("jacket", { silhouette: "regular" }), P("bottoms", { silhouette: "oversized" })]);
    assert.equal(s.score, 1);
    assert.match(s.why[0], /straight layer over loose bottoms/);
  });
  test("one family is 1; a bordering piece costs", () => {
    assert.equal(sty.familyScore(MONO()).score, 1);
    assert.ok(sty.familyScore([P("tee", { family: "athleisure" }), P("bottoms"), P("sneakers")]).score < 1);
  });
  test("formality spread", () => {
    assert.equal(sty.formalityScore([P("tee", { formality: 2 }), P("bottoms", { formality: 4 })]).score, 0.6);
  });
  test("Durban: October is summer, a winter piece scores 0.3 in it", () => {
    assert.equal(sty.seasonOf(10), "summer");
    assert.equal(sty.seasonOf(7), "winter");
    assert.equal(sty.seasonOf(4), "shoulder");
    assert.equal(sty.seasonScore([P("jacket", { season: "winter" })], "summer").score, 0.3);
    assert.equal(sty.seasonScore([P("bottoms", { season: "summer" })], "winter").score, 0.5);
  });
});

describe("the named looks", () => {
  const look = (k) => sty.lookByKey(k);
  test("clean monochrome: neutrals of one family, no accent, core slots filled", () => {
    assert.ok(sty.lookMatch(MONO(), look("clean-monochrome"), { season: "summer" }) > 0.9);
    assert.equal(sty.lookMatch([...MONO(), P("hat", { dominant: "red" })], look("clean-monochrome"), { season: "summer" }), null);
    assert.equal(sty.lookMatch(MONO().slice(0, 2), look("clean-monochrome"), { season: "summer" }), null, "no sneakers: the template fails");
  });
  test("earth tone street needs two earth pieces", () => {
    const one = [P("tee", { dominant: "black" }), P("bottoms", { dominant: "olive" }), P("sneakers", { dominant: "white" })];
    assert.equal(sty.lookMatch(one, look("earth-tone-street"), { season: "summer" }), null);
    const two = [P("tee", { dominant: "cream" }), P("bottoms", { dominant: "olive" }), P("sneakers", { dominant: "brown" })];
    assert.ok(sty.lookMatch(two, look("earth-tone-street"), { season: "summer" }) > 0.9);
  });
  test("sport luxe needs exactly one accent; coastal summer needs shorts in summer", () => {
    const sport = [P("tee", { dominant: "black", family: "athleisure" }), P("bottoms", { dominant: "black", family: "athleisure" }), P("sneakers", { dominant: "red", family: "athleisure" })];
    assert.ok(sty.lookMatch(sport, look("sport-luxe"), { season: "summer" }) > 0.9);
    const coast = [P("tee", { dominant: "white", family: "prep" }), P("bottoms", { dominant: "beige", family: "prep" }, { categoryKey: "shorts" }), P("sneakers", { dominant: "white", family: "prep" })];
    assert.ok(sty.lookMatch(coast, look("coastal-summer"), { season: "summer" }) > 0.9);
    assert.equal(sty.lookMatch(coast, look("coastal-summer"), { season: "winter" }), null);
  });
  test("bestLook takes the closest match; a flat-lay ignores the slot template", () => {
    assert.equal(sty.bestLook(MONO(), { season: "summer" }).look.key, "clean-monochrome");
    const pair = [P("tee", { dominant: "black" }), P("sneakers", { dominant: "white" })];
    assert.equal(sty.bestLook(pair, { season: "summer" }), null);
    assert.equal(sty.bestLook(pair, { season: "summer", template: false }).look.key, "clean-monochrome");
  });
});

describe("scoreOutfit", () => {
  test("out of 100, the parts add up, and the reasons are words", () => {
    const s = sty.scoreOutfit(MONO(), { season: "summer" });
    assert.equal(s.look, "clean-monochrome");
    assert.equal(Math.round(Object.values(s.parts).reduce((a, b) => a + b, 0) * 100) / 100, s.score);
    // colour 28 + silhouette 14 (loose over slim) + family 18 + formality 10
    // + season 14 × 0.9 + look 10 × 1 + fresh 6 × 0.5
    assert.equal(s.score, 28 + 14 + 18 + 10 + 12.6 + 10 + 3);
    assert.match(s.reasoning, /monochrome; white sneakers anchor it; loose top over slim bottoms; all streetwear/);
  });
  test("an off-season piece costs points of its own", () => {
    const beanie = [...MONO(), P("hat", { dominant: "black", silhouette: "n/a", season: "winter" })];
    const s = sty.scoreOutfit(beanie, { season: "summer" });
    assert.equal(s.parts.offSeason, -6);
    assert.equal(sty.scoreOutfit(beanie, { season: "winter" }).parts.offSeason, 0);
    assert.equal(sty.scoreOutfit(beanie, { season: "shoulder" }).parts.offSeason, 0);
  });
  test("a clash scores below a harmony", () => {
    const clash = [P("tee", { dominant: "navy", silhouette: "regular" }), P("bottoms", { dominant: "beige", silhouette: "regular" }), P("sneakers", { dominant: "grey", secondary: "orange" })];
    assert.ok(sty.scoreOutfit(clash, { season: "summer" }).score < sty.scoreOutfit(MONO(), { season: "summer" }).score - 10);
  });
});

// A small catalogue: the stylist must find the harmonious outfit in it.
const CATALOGUE = () => [
  P("tee", { dominant: "black", silhouette: "oversized" }, { pid: "t-black", price: 400 }),
  P("tee", { dominant: "orange", pattern: "print" }, { pid: "t-orange-print", price: 350, fresh: 1 }),
  P("tee", { dominant: "cream" }, { pid: "t-cream", price: 380 }),
  P("bottoms", { dominant: "charcoal", silhouette: "slim" }, { pid: "b-charcoal", price: 600 }),
  P("bottoms", { dominant: "denim-mid", silhouette: "regular", pattern: "logo-heavy" }, { pid: "b-denim-logo", price: 650, fresh: 1 }),
  P("bottoms", { dominant: "olive", silhouette: "slim" }, { pid: "b-olive", price: 550 }),
  P("sneakers", { dominant: "white", silhouette: "n/a" }, { pid: "s-white", price: 800 }),
  P("sneakers", { dominant: "brown", silhouette: "n/a" }, { pid: "s-brown", price: 700 }),
  P("hat", { dominant: "black", silhouette: "n/a" }, { pid: "h-black", price: 250 }),
  P("hat", { dominant: "green", silhouette: "n/a" }, { pid: "h-green", price: 250, fresh: 1 }),
];

describe("styleOutfits", () => {
  const opts = { core: [["tee", "jacket"], ["bottoms"], ["sneakers"]], minPieces: 3, maxPieces: 4, month: 10 };
  test("finds the harmonious outfit, never the loud clash, and shortlists distinct near-ties", () => {
    const r = sty.styleOutfits(CATALOGUE(), opts);
    assert.ok(r.best);
    const ids = r.best.pieces.map((p) => p.pid);
    assert.ok(!(ids.includes("t-orange-print") && ids.includes("b-denim-logo")), "two loud pieces never together");
    assert.ok(r.best.look, "the best outfit matches a named look");
    assert.ok(r.best.score > 90, String(r.best.score));
    assert.ok(r.shortlist.length >= 2 && r.shortlist.length <= 5);
    for (const o of r.shortlist) assert.ok(o.score >= r.best.score - 6);
    for (let i = 0; i < r.shortlist.length; i++) for (let j = i + 1; j < r.shortlist.length; j++) {
      const a = new Set(r.shortlist[i].pieces.map((p) => p.pid));
      const shared = r.shortlist[j].pieces.filter((p) => a.has(p.pid)).length;
      assert.ok(shared <= Math.max(r.shortlist[i].pieces.length, r.shortlist[j].pieces.length) - 2, "differ by two pieces");
    }
    // Pruned while building, so no enumerated outfit holds both loud pieces.
    assert.ok(!r.outfits.some((o) => ["t-orange-print", "b-denim-logo"].every((id) => o.pieces.some((p) => p.pid === id))));
  });
  test("price never refuses: a preferred range nobody fits still dresses every outfit", () => {
    const all = sty.styleOutfits(CATALOGUE(), opts);
    const r = sty.styleOutfits(CATALOGUE(), { ...opts, prefer: { min: 100, max: 200 } });
    assert.equal(r.outfits.length, all.outfits.length);
    assert.ok(r.outfits.every((o) => o.inPrefer === false));
    assert.equal("nearest" in r, false);
  });
  test("a forced look returns only outfits of that look", () => {
    const r = sty.styleOutfits(CATALOGUE(), { ...opts, look: "earth-tone-street" });
    assert.ok(r.outfits.length);
    for (const o of r.outfits) assert.equal(o.look, "earth-tone-street");
  });
  test("deterministic whatever the input order", () => {
    const a = sty.styleOutfits(CATALOGUE(), opts).shortlist.map((o) => o.key);
    const b = sty.styleOutfits(CATALOGUE().reverse(), opts).shortlist.map((o) => o.key);
    assert.deepEqual(a, b);
  });
  test("a full-body piece (tracksuit) is the bottoms; nothing is added beside it", () => {
    const set = [P("tee", { family: "athleisure" }, { pid: "track", fullBody: true }), P("bottoms", {}, { pid: "jeans" }), P("sneakers", { dominant: "white", family: "athleisure" }, { pid: "s" })];
    const r = sty.styleOutfits(set, { ...opts, minPieces: 2 });
    assert.ok(r.outfits.some((o) => o.key === "s,track"));
    assert.ok(!r.outfits.some((o) => o.pieces.some((p) => p.pid === "jeans") && o.pieces.some((p) => p.pid === "track")));
  });
});

describe("the tie-break", () => {
  const short = () => sty.styleOutfits(CATALOGUE(), { core: [["tee", "jacket"], ["bottoms"], ["sneakers"]], minPieces: 3, maxPieces: 4, month: 10 }).shortlist;
  test("a good answer picks its option, its look and its note", () => {
    const s = short();
    const c = sty.readChoice(JSON.stringify({ choice: 2, look: s[1].look, note: "Tonal base, white sneaker to lift it." }), s);
    assert.deepEqual(c, { index: 1, look: s[1].look, note: "Tonal base, white sneaker to lift it.", source: "model" });
  });
  test("an unreadable or out-of-range answer keeps the top outfit and the scorer's note", () => {
    const s = short();
    for (const bad of ["no idea", JSON.stringify({ choice: 9, note: "x" }), JSON.stringify({ choice: 0 })]) {
      const c = sty.readChoice(bad, s);
      assert.equal(c.index, 0);
      assert.equal(c.source, "score");
      assert.equal(c.look, s[0].look);
      assert.ok(c.note.length > 10);
    }
  });
  test("a look the outfit does not qualify for is not taken", () => {
    const s = short();
    const c = sty.readChoice(JSON.stringify({ choice: 1, look: "coastal-summer", note: "Fresh." }), s);
    assert.equal(c.look, s[0].look);
  });
  test("a note with a price, a hashtag or a link is replaced; a long one is cut at a word", () => {
    assert.equal(sty.cleanNote("Only R1,710 for the lot"), null);
    assert.equal(sty.cleanNote("Clean #fitcheck"), null);
    assert.equal(sty.cleanNote("x"), null);
    const long = sty.cleanNote("A ".repeat(100) + "end");
    assert.ok(long.length <= sty.NOTE_MAX + 1);
  });
  test("a pairing's note never calls it an outfit, a look or a fit", () => {
    assert.equal(sty.cleanNote("A great look for summer", { kind: "pairing" }), null);
    assert.equal(sty.cleanNote("Cream and brown sit together", { kind: "pairing" }), "Cream and brown sit together");
  });
  test("the prompt lists every option and the looks, and asks for JSON", () => {
    const p = sty.buildChoicePrompt(short(), { kind: "lookbook", season: "summer" });
    assert.match(p, /OPTION 1 — score/);
    assert.match(p, /clean-monochrome: Clean Monochrome/);
    assert.match(p, /"choice": <option number>/);
    assert.match(sty.buildChoicePrompt(short(), { kind: "pairing" }), /Never call them an outfit/);
  });
  test("the panel header: the look's two lines, or the house fallback", () => {
    assert.deepEqual(sty.headerFor("earth-tone-street"), ["EARTH TONE", "STREET"]);
    assert.deepEqual(sty.headerFor(null), ["THE EVERYDAY", "LEGACY COLLECTION"]);
  });
});

describe("review fixes (Sonnet architect, #759)", () => {
  test("a forced look keeps an outfit that qualifies even when another look matches it better (Fable review)", () => {
    const set = [
      P("tee", { dominant: "beige", family: "prep" }, { pid: "t" }),
      P("bottoms", { dominant: "khaki", family: "prep", season: "summer" }, { pid: "b", categoryKey: "shorts" }),
      P("sneakers", { dominant: "white", silhouette: "n/a", family: "prep" }, { pid: "s" }),
    ];
    const opts = { core: [["tee"], ["bottoms"], ["sneakers"]], minPieces: 3, maxPieces: 3, month: 10 };
    assert.notEqual(sty.styleOutfits(set, opts).best.look, "coastal-summer");
    const forced = sty.styleOutfits(set, { ...opts, look: "coastal-summer" });
    assert.equal(forced.outfits.length, 1);
    assert.equal(forced.best.look, "coastal-summer");
    assert.throws(() => sty.styleOutfits(set, { ...opts, look: "nope" }), /unknown look/);
  });
  test("refusals made while building are counted under their rule", () => {
    const loud = [P("tee", { pattern: "print" }, { pid: "a" }), P("bottoms", { pattern: "print" }, { pid: "b" }), P("sneakers", {}, { pid: "c" })];
    const r = sty.styleOutfits(loud, { core: [["tee"], ["bottoms"], ["sneakers"]], minPieces: 3, maxPieces: 3, month: 10 });
    assert.equal(r.outfits.length, 0);
    assert.ok(Object.keys(r.refused).some((k) => /loud pieces/.test(k)), JSON.stringify(r.refused));
  });
  test("an out-of-range choice drops the model's note and look with it", () => {
    const s = sty.styleOutfits(CATALOGUE(), { core: [["tee", "jacket"], ["bottoms"], ["sneakers"]], minPieces: 3, maxPieces: 4, month: 10 }).shortlist;
    const c = sty.readChoice(JSON.stringify({ choice: 9, look: "raw-denim", note: "Denim on denim, kept simple and calm." }), s);
    assert.equal(c.source, "score");
    assert.notEqual(c.note, "Denim on denim, kept simple and calm.");
    assert.equal(c.look, s[0].look);
  });
  test("a note that sends people to a shop is not used (CodeRabbit)", () => {
    assert.equal(sty.cleanNote("Grab the whole set in store this weekend"), null);
    assert.equal(sty.cleanNote("Visit us for the full colourway"), null);
    assert.equal(sty.cleanNote("Restored storefront energy, clean lines"), "Restored storefront energy, clean lines");
  });
  test("a word ending in r before a number is not a price", () => {
    assert.equal(sty.cleanNote("Colour 1 is black, colour 2 is white"), "Colour 1 is black, colour 2 is white");
    assert.equal(sty.cleanNote("Under R900 for the set"), null);
  });
  test("two-piece pairings may share one piece in the shortlist", () => {
    const pool = [P("tee", {}, { pid: "t1" }), P("tee", { dominant: "white" }, { pid: "t2" }), P("sneakers", { dominant: "white", silhouette: "n/a" }, { pid: "s1" })];
    const r = sty.styleOutfits(pool, { core: [["tee"], ["sneakers"]], minPieces: 2, maxPieces: 2, month: 10, template: false });
    assert.equal(r.shortlist.length, 2);
  });
});

test("a slot of fresh prints keeps two quiet pieces in reach (19 Oct: no cap look could form)", () => {
  const prints = Array.from({ length: 8 }, (_, i) => P("tee", { pattern: "print" }, { pid: `print${i}`, fresh: 1 - i * 0.01 }));
  const set = [...prints, P("tee", {}, { pid: "solid-tee", fresh: 0 }),
    P("bottoms", { dominant: "charcoal" }, { pid: "b" }), P("sneakers", { dominant: "white", silhouette: "n/a" }, { pid: "s" }),
    P("hat", { dominant: "red", pattern: "logo-heavy", silhouette: "n/a", family: "athleisure" }, { pid: "loud-cap" })];
  const r = sty.styleOutfits(set, { core: [["tee"], ["bottoms"], ["sneakers"]], requireSlots: ["hat"], minPieces: 4, maxPieces: 4, month: 10 });
  assert.ok(r.best, JSON.stringify(r.refused));
  assert.ok(r.best.pieces.some((p) => p.pid === "solid-tee"));
});

test("lookbook: a cap look with one off-palette piece (olive jeans) is still found, and named for a look that wears a hat", () => {
  const set = [P("tee", { dominant: "charcoal" }, { pid: "t" }), P("bottoms", { dominant: "olive", silhouette: "slim" }, { pid: "b" }),
    P("sneakers", { dominant: "off-white", silhouette: "n/a" }, { pid: "s" }), P("hat", { dominant: "green", pattern: "print", silhouette: "n/a", family: "prep" }, { pid: "cap" })];
  const r = sty.styleOutfits(set, { core: [["tee"], ["bottoms"], ["sneakers"]], requireSlots: ["hat"], minPieces: 4, maxPieces: 4, month: 10, lookSlots: true });
  assert.ok(r.best, JSON.stringify(r.refused));
  assert.ok(sty.GUIDE.looks.find((l) => l.key === r.best.look).extras.includes("hat"));
});

test("lookbook: a hat with no look that wears one is refused; a narrow slot never grows past perSlot", () => {
  // Earth tones: earth-tone-street does not wear a hat, and no hat look fits.
  const set = [P("tee", { dominant: "cream" }, { pid: "t" }), P("bottoms", { dominant: "olive" }, { pid: "b" }),
    P("sneakers", { dominant: "brown", silhouette: "n/a" }, { pid: "s" }), P("hat", { dominant: "khaki", silhouette: "n/a" }, { pid: "cap" })];
  const r = sty.styleOutfits(set, { core: [["tee"], ["bottoms"], ["sneakers"]], minPieces: 3, maxPieces: 4, month: 10, lookSlots: true });
  assert.ok(r.best);
  assert.ok(!r.outfits.some((o) => o.pieces.some((p) => p.pid === "cap")), JSON.stringify(r.refused));
  const many = Array.from({ length: 6 }, (_, i) => P("tee", {}, { pid: `t${i}`, fresh: i / 10 }));
  const n = sty.styleOutfits([...many, P("bottoms", {}, { pid: "b2" }), P("sneakers", { silhouette: "n/a", dominant: "white" }, { pid: "s2" })],
    { core: [["tee"], ["bottoms"], ["sneakers"]], minPieces: 3, maxPieces: 3, month: 10, perSlot: 1, template: false });
  assert.equal(new Set(n.outfits.map((o) => o.pieces.find((p) => p.slot === "tee").pid)).size, 1);
});
