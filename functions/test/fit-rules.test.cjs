// ─── THE FIT RULEBOOK: ITS TABLE, THE SIZE RULE AND THE ANSWER CHECKS ───────
// No model is called: the stylist's and critic's answers are canned JSON.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fr = require("../lib/fit-rules.cjs");

const T = (over = {}) => ({ dominant: "black", secondary: null, pattern: "solid", silhouette: "regular", family: "streetwear", formality: 3, ...over });
const P = (pid, slot, brand, name, over = {}) => ({ pid, slot, brand, name, displayName: `${brand} ${name}`, price: 500, tags: T(over.tags), sizes: { inStock: 3, sizes: 5 }, fresh: 0.5, ...over });

// Today's Louboutin post (26 Oct), as the stylist would be offered it.
const OFFER = [
  P("tee-sonic", "tee", "Sonic", "Washed black graphic print crew-neck t-shirt", { tags: T({ pattern: "graphic" }), price: 300 }),
  P("tee-white", "tee", "Hugo Boss", "Plain white crew-neck t-shirt", { tags: T({ dominant: "white" }), price: 600 }),
  P("cargo-sage", "bottoms", "G-Star Raw", "Raw jean green", { tags: T({ dominant: "olive" }), price: 750 }),
  P("jean-black", "bottoms", "Diesel", "Slim black jeans", { tags: T({ dominant: "black", silhouette: "slim" }), price: 900 }),
  P("loub", "sneakers", "Christian Louboutin", "Textured nubuck low-top in olive", { tags: T({ dominant: "olive" }), price: 1300 }),
  P("af1", "sneakers", "Nike", "Air Force 1 white", { tags: T({ dominant: "white" }), price: 1800 }),
];
const SLOTS = ["hat", "jacket", "tee", "bottoms", "bag", "sneakers"];
const CTX = { pieces: OFFER, slots: SLOTS, core: [["tee"], ["bottoms"], ["sneakers"]], minPieces: 3, maxPieces: 6, season: "summer", knownBrands: ["Nike", "G-Star Raw", "Diesel", "Hugo Boss", "Christian Louboutin", "Lacoste"] };
const GOOD = {
  formula: "clean-luxe", theme: "Clean Luxe", hero_pid: "loub", pids: ["tee-white", "jean-black", "loub"],
  colours: ["white", "black", "brown"],
  caption: "Brown suede Louboutins, a plain white Hugo Boss tee and slim black Diesel jeans. Clean, quiet, let the shoes talk.\n\n#MarathonClub #Louboutin",
  why: "A quiet base lets the studded suede lead.",
};

describe("the rulebook", () => {
  test("it has ten formulas, each with hero, tops, bottoms and colours", () => {
    const { formulas } = fr.rulebook();
    assert.equal(formulas.length, 10);
    for (const f of formulas) for (const k of ["hero", "tops", "bottoms", "colours"]) assert.ok(f[k].length > 10, `${f.key}.${k}`);
    for (const k of ["clean-luxe", "earth-tone-street", "monochrome-black", "summer-white"]) assert.ok(formulas.some((f) => f.key === k), k);
  });
  test("every luxury brand the code knows is named in the rulebook", () => {
    const flat = fr.rulebook().text.replace(/\s+/g, " ");
    for (const b of fr.LUXURY_BRANDS) assert.ok(flat.includes(b), b);
  });
  test("the rules Junid wrote are in it", () => {
    const t = fr.rulebook().text.replace(/\s+/g, " ");
    for (const s of ["one hero piece", "At most 3 colours", "Never mix a loud graphic or band tee with designer or studded shoes", "One statement per fit", "baggy on baggy", "summer", "NOT earth tones"]) assert.ok(t.toLowerCase().includes(s.toLowerCase()), s);
  });
  test("a malformed table is refused, not half-read", () => {
    assert.throws(() => fr.parseFormulas("no table"), /no <!-- config: formulas -->/);
    assert.throws(() => fr.parseFormulas("<!-- config: formulas -->\n| key | name |\n|---|---|\n| a | A |"), /columns/);
    const row = (k) => `| ${k} | N | any | h | t | b | c |`;
    const head = "<!-- config: formulas -->\n| key | name | season | hero | tops | bottoms | colours |\n|---|---|---|---|---|---|---|\n";
    assert.throws(() => fr.parseFormulas(head + [1, 2, 3].map((i) => row(`f${"abc"[i - 1]}`)).join("\n")), /needs at least 10/);
    assert.throws(() => fr.parseFormulas(head + "| x | N | spring | h | t | b | c |"), /season/);
  });
  test("summer-only formulas are not offered in winter", () => {
    assert.ok(fr.formulasFor("summer").some((f) => f.key === "summer-white"));
    assert.ok(!fr.formulasFor("winter").some((f) => f.key === "summer-white"));
  });
});

describe("the size rule: in stock in at least two sizes", () => {
  const sizes = ["7", "8", "9", "10"];
  test("counts sizes with a unit at a shipping location", () => {
    assert.deepEqual(fr.sizesInStock({ shopA: { 7: 1, 8: { qty: 2 } }, shopB: { 9: 0 } }, sizes), { inStock: 2, sizes: 4 });
  });
  test("one size left is refused; two pass", () => {
    assert.match(fr.sizeRefusal(fr.sizesInStock({ shopA: { 9: 3 } }, sizes)), /only 1 size in stock/);
    assert.equal(fr.sizeRefusal(fr.sizesInStock({ shopA: { 9: 3, 10: 1 } }, sizes)), null);
  });
  test("a one-size cap qualifies in its one size", () => {
    assert.equal(fr.sizeRefusal(fr.sizesInStock({ shopA: { one_size: 1 } }, ["one size"])), null);
    assert.match(fr.sizeRefusal(fr.sizesInStock({}, ["one size"])), /one size is out of stock/);
  });
});

describe("the stylist's answer, checked by code", () => {
  test("a clean luxe fit around the Louboutins passes", () => {
    const r = fr.readStylistAnswer(GOOD, CTX);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.fit.pieces.map((p) => p.pid), ["tee-white", "jean-black", "loub"]);
    assert.equal(r.fit.hero.pid, "loub");
  });
  test("today's post: Earth Tone Street is not the clean-luxe name, and a fourth colour is refused", () => {
    const r = fr.readStylistAnswer({ ...GOOD, formula: "clean-luxe", theme: "Earth Tone Street", pids: ["tee-sonic", "cargo-sage", "loub"], colours: ["black", "sage", "brown", "white"] }, CTX);
    assert.ok(r.problems.some((p) => /not the clean-luxe formula's name/.test(p)));
    assert.ok(r.problems.some((p) => /4 colours/.test(p)));
  });
  test("shades count as one colour, and a neutral is required", () => {
    assert.deepEqual(fr.readStylistAnswer({ ...GOOD, colours: ["black", "charcoal", "off-white", "white", "brown"] }, CTX).problems, []);
    assert.ok(fr.readStylistAnswer({ ...GOOD, colours: ["red", "orange"] }, CTX).problems.some((p) => /no neutral/.test(p)));
  });
  test("unknown pids, two tees, a missing core slot and a hero outside the fit are each refused", () => {
    const r = fr.readStylistAnswer({ ...GOOD, hero_pid: "af1", pids: ["tee-white", "tee-sonic", "loub", "ghost"] }, CTX);
    const all = r.problems.join(" | ");
    assert.match(all, /not in the catalogue: ghost/);
    assert.match(all, /more than one piece in: tee/);
    assert.match(all, /no bottoms/);
    assert.match(all, /hero piece is not one of the fit's pieces/);
  });
  test("a caption with a price, a shop, a link or a brand that is not in the fit is refused", () => {
    for (const [cap, why] of [
      ["Only R1,300 for the Louboutins, white tee, black jeans. #MarathonClub", /price/],
      ["Louboutins, white tee and black jeans. Pop in to our store to try them. #x", /shop/],
      ["Louboutins, white tee, black jeans. https://marathonclub.co.za #x", /link/],
      ["Louboutins with a Lacoste-clean white tee and black jeans. #x", /not in the fit: Lacoste/],
    ]) assert.ok(fr.readStylistAnswer({ ...GOOD, caption: cap }, CTX).problems.some((p) => why.test(p)), String(why));
  });
  test("honest captions pass: a model name with R1, a colour pop in green, an off-white tee (review of the branch)", () => {
    for (const cap of [
      "Brown suede Louboutins with a plain white Hugo Boss tee, the kind of R1 energy that needs no logo. Black Diesel jeans. #MarathonClub",
      "Brown suede Louboutins: a pop in green would be too much, so a white Hugo Boss tee and black Diesel jeans. #MarathonClub",
      "Brown suede Louboutins, an off-white Hugo Boss tee and black Diesel jeans. #MarathonClub",
    ]) assert.deepEqual(fr.readStylistAnswer({ ...GOOD, caption: cap }, { ...CTX, knownBrands: [...CTX.knownBrands, "Off-White"].filter((b) => b !== "Off-White") }).problems, [], cap);
  });
  test("a stranger brand in a hashtag, 'ZAR' and '% off' are refused", () => {
    assert.ok(fr.readStylistAnswer({ ...GOOD, caption: "Louboutins, white Hugo Boss tee, black Diesel jeans. #Lacoste" }, CTX).problems.some((p) => /not in the fit: Lacoste/.test(p)));
    assert.ok(fr.readStylistAnswer({ ...GOOD, caption: "Louboutins, white tee, black jeans for 1299 ZAR. #x" }, CTX).problems.some((p) => /price/.test(p)));
    assert.ok(fr.readStylistAnswer({ ...GOOD, caption: "Louboutins, white tee, black jeans, 20% off. #x" }, CTX).problems.some((p) => /price/.test(p)));
    assert.ok(fr.readStylistAnswer({ ...GOOD, caption: "Louboutins, white tee, black jeans. Pop in to the store. #x" }, CTX).problems.some((p) => /shop/.test(p)));
  });
  test("the till's Louboutin spelling still counts as the brand in the fit", () => {
    const offer = OFFER.map((p) => (p.pid === "loub" ? { ...p, brand: "Christian Louboutin", displayName: "CHRISTINA LOUBOUTIN LOUIS BROWN" } : p));
    assert.deepEqual(fr.readStylistAnswer({ ...GOOD, caption: "Christian Louboutin in brown suede, white tee, black jeans. #MarathonClub" }, { ...CTX, pieces: offer }).problems, []);
  });
  test("a colour-pop theme is the accent colour plus Pop", () => {
    const f = fr.rulebook().formulas.find((x) => x.key === "colour-pop");
    assert.ok(fr.themeAllowed(f, "Red Pop"));
    assert.ok(!fr.themeAllowed(f, "Colour Pop Street Vibes"));
  });
});

describe("the critic's verdict", () => {
  const S = (c, f, t, cap) => ({ colour: { score: c, reason: "c" }, formality: { score: f, reason: "f" }, theme: { score: t, reason: "t" }, caption: { score: cap, reason: "raw denim is wrong" }, seen: [{ pid: "cargo-sage", colour: "sage green", what: "cargo jeans" }], fix: "call them green cargos" });
  test("every score 8 or more passes", () => {
    const v = fr.readCriticAnswer(S(9, 8, 8, 10));
    assert.equal(v.pass, true);
    assert.equal(v.min, 8);
  });
  test("one score under 8 is a rebuild, and its reason goes back to the stylist", () => {
    const v = fr.readCriticAnswer(S(9, 9, 9, 3));
    assert.equal(v.pass, false);
    const line = fr.feedbackLine({ theme: "Earth Tone Street", pieces: OFFER.slice(0, 1) }, { verdict: v });
    assert.match(line, /caption 3\/10 \(raw denim is wrong\)/);
    assert.match(line, /cargo-sage sage green cargo jeans/);
  });
  test("a missing score is not a pass", () => {
    const v = fr.readCriticAnswer({ colour: { score: 9 } });
    assert.equal(v.ok, false);
    assert.equal(v.pass, false);
  });
});

describe("cost", () => {
  test("usage at opus 5.5 prices, cache reads at $0.20", () => {
    const usd = fr.costOf({ input_tokens: 1000, cache_creation_input_tokens: 4000, cache_read_input_tokens: 10000, output_tokens: 500 });
    assert.equal(+usd.toFixed(6), +((1000 * 4 + 4000 * 5 + 10000 * 0.2 + 500 * 20) / 1e6).toFixed(6));
  });
  test("the worst case of one stylist round and one critic round fits the $0.15 budget", () => {
    const st = fr.stylistRequest({ pieces: OFFER, slots: SLOTS, core: CTX.core, optional: ["jacket", "bag"], minPieces: 3, maxPieces: 6, season: "summer" });
    const fit = fr.readStylistAnswer(GOOD, CTX).fit;
    const cr = fr.criticRequest(fit, fit.pieces.map((p) => ({ pid: p.pid, base64: "x", mediaType: "image/jpeg" })));
    assert.ok(fr.worstCaseUSD(st) + fr.worstCaseUSD(cr) < fr.BUDGET_USD, `${fr.worstCaseUSD(st)} + ${fr.worstCaseUSD(cr)}`);
  });
  test("a rebuild carries the critic's feedback and the same cached catalogue", () => {
    const a = fr.stylistRequest({ pieces: OFFER, slots: SLOTS, core: CTX.core, optional: [], minPieces: 3, maxPieces: 6, season: "summer" });
    const b = fr.stylistRequest({ pieces: OFFER, slots: SLOTS, core: CTX.core, optional: [], minPieces: 3, maxPieces: 6, season: "summer", feedback: ["no"] });
    assert.equal(a.messages[0].content[0].text, b.messages[0].content[0].text);
    assert.match(b.messages[0].content[1].text, /Attempt 1: no/);
  });
});

describe("trimming the offer", () => {
  test("core slots keep every piece; an optional slot keeps its six freshest, and a fixed hero always", () => {
    const bags = Array.from({ length: 10 }, (_, i) => ({ pid: `bag${i}`, slot: "bag", fresh: i / 10 }));
    const out = fr.trimOptional([...OFFER, ...bags], CTX.core, { keep: "bag0" });
    assert.equal(out.filter((p) => p.slot === "tee").length, 2);
    assert.deepEqual(out.filter((p) => p.slot === "bag").map((p) => p.pid).sort(), ["bag0", "bag4", "bag5", "bag6", "bag7", "bag8", "bag9"]);
  });
  test("the critic gets the rules and only the fit's own formula", () => {
    const fit = fr.readStylistAnswer(GOOD, CTX).fit;
    const req = fr.criticRequest(fit, []);
    assert.ok(!req.system[0].text.includes("config: formulas"));
    assert.match(req.messages[0].content.slice(-1)[0].text, /FORMULA: clean-luxe — Clean Luxe\. Hero: a designer/);
  });
});

describe("the poster header", () => {
  test("two lines, the longer half first", () => {
    assert.deepEqual(fr.headerOf("Earth Tone Street"), ["EARTH TONE", "STREET"]);
    assert.deepEqual(fr.headerOf("Clean Luxe"), ["CLEAN", "LUXE"]);
  });
});
