"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ls = require("../lib/local-stylist.cjs");
const { localFitAgentFor } = require("../lookbook/engines.cjs");

// ── the ledger ─────────────────────────────────────────────────────────────
const L = { entries: [
  { date: "2026-10-15", kind: "lookbook", status: "posted", pids: ["old"], families: ["f-old"], pair: "t0+b0" },
  { date: "2026-10-25", kind: "outfit", status: "posted", pids: ["t1", "b1", "s1"], families: ["f-t1"], pair: "t1+b1" },
  { date: "2026-10-31", kind: "lookbook", status: "planned", pids: ["t2"], families: [], pair: null },
] };

test("ledgerBlocks: 14 days for pieces and colourways, 30 for pairings", () => {
  const b = ls.ledgerBlocks(L, "2026-11-02");
  assert.ok(b.pids.has("t1") && b.pids.has("t2") && !b.pids.has("old"));
  assert.ok(b.families.has("f-t1") && !b.families.has("f-old"));
  assert.ok(b.pairs.has("t0+b0") && b.pairs.has("t1+b1"));
  assert.equal(b.lastUsed.get("t1"), "2026-10-25");
});

test("ledgerWith replaces the same day and kind and drops entries older than 60 days", () => {
  const e = ls.ledgerEntry("2026-10-25", "outfit", [{ pid: "x", slot: "tee", price: 350, family: "fx" }, { pid: "y", slot: "bottoms", price: 500 }]);
  const out = ls.ledgerWith(L, e);
  assert.equal(out.entries.filter((x) => x.date === "2026-10-25").length, 1);
  assert.equal(out.entries.find((x) => x.date === "2026-10-25").pair, "x+y");
  assert.equal(ls.ledgerWith(L, ls.ledgerEntry("2027-01-01", "outfit", [])).entries.some((x) => x.date === "2026-10-15"), false);
  assert.match(ls.ledgerLines(out, "2026-11-02").join("\n"), /2026-10-25 outfit/);
});

// ── pool, palette, shortlist ───────────────────────────────────────────────
const emb = (colour, style = "streetwear", statement = 0.1, vec = [1, 0, 0]) => ({ colour, statement, vec, style: { streetwear: style === "streetwear" ? 0.8 : 0.05, "smart casual": style === "smart casual" ? 0.8 : 0.05, sportswear: 0.05, "luxury designer": 0.05, preppy: 0.05 } });
const P = (pid, slot, price, colour, extra = {}) => ({ pid, slot, price, brand: "NIKE", name: `${slot} ${pid}`, displayName: `Nike ${slot} ${pid}`, family: `f-${pid}`, emb: emb(colour, extra.style, extra.statement, extra.vec), ...extra });

test("poolOf: the ledger keeps pieces, colourways and near-duplicate photos out; a starved core slot is relaxed", () => {
  const pieces = [P("t1", "tee", 350, "white"), P("t9", "tee", 350, "black", { family: "f-t1" }), P("t3", "tee", 350, "grey", { vec: [0, 1, 0] }),
    P("b1", "bottoms", 500, "blue denim"), P("s5", "sneakers", 700, "white")];
  const blocks = ls.ledgerBlocks(L, "2026-11-02");
  const { pool, relaxed } = ls.poolOf(pieces, blocks, { recentVecs: [{ slot: "tee", vec: [0, 1, 0.01] }] });
  // Every tee is ledgered (t1 worn, t9 its colourway, t3 a near-duplicate photo),
  // so the slot is relaxed: the never-worn ones come back first, the worn one last.
  // t3 (never worn, its own family) first; t9 is t1's colourway, so it is as recent as t1.
  assert.equal(pool.filter((p) => p.slot === "tee")[0].pid, "t3");
  assert.deepEqual(pool.filter((p) => p.slot === "tee").map((p) => p.pid).sort(), ["t1", "t3", "t9"]);
  const strict = ls.poolOf(pieces.concat(P("t4", "tee", 350, "navy", { vec: [0, 0, 1] })), blocks, { recentVecs: [{ slot: "tee", vec: [0, 1, 0.01] }] });
  assert.deepEqual(strict.pool.filter((p) => p.slot === "tee").map((p) => p.pid), ["t4"], "with one clean tee nothing is relaxed");
  assert.deepEqual(relaxed.sort(), ["bottoms", "tee"]);
  assert.ok(pool.some((p) => p.pid === "b1"), "the least recently worn bottoms are offered when none are unworn");
});

test("paletteRefusal: one hero colour, a neutral, one statement", () => {
  assert.equal(ls.paletteRefusal([P("a", "tee", 1, "white"), P("b", "bottoms", 1, "blue denim"), P("c", "sneakers", 1, "red")]), null);
  assert.match(ls.paletteRefusal([P("a", "tee", 1, "green"), P("b", "bottoms", 1, "black"), P("c", "sneakers", 1, "orange")]), /two hero colours/);
  assert.match(ls.paletteRefusal([P("a", "tee", 1, "red"), P("b", "bottoms", 1, "burgundy"), P("c", "sneakers", 1, "pink")]), /two hero colours/);
  assert.match(ls.paletteRefusal([P("a", "tee", 1, "white", { statement: 0.9 }), P("b", "bottoms", 1, "black"), P("c", "sneakers", 1, "white", { statement: 0.8 })]), /two statement/);
  assert.equal(ls.paletteRefusal([P("a", "tee", 1, "olive"), P("b", "bottoms", 1, "khaki"), P("c", "sneakers", 1, "cream")]), null, "earth tones are one family");
});

test("shortlistOutfits: under the ceiling, no repeated pairing, palette passes, real alternatives", () => {
  const pool = [
    P("t1", "tee", 350, "white"), P("t2", "tee", 350, "black"), P("t3", "tee", 350, "green"),
    P("b1", "bottoms", 750, "blue denim"), P("b2", "bottoms", 500, "khaki"), P("b3", "bottoms", 1500, "black"),
    P("s1", "sneakers", 700, "white"), P("s2", "sneakers", 850, "orange"), P("s3", "sneakers", 1200, "black"),
    P("h1", "hat", 180, "white"),
  ];
  const blocks = { pids: new Set(), families: new Set(), pairs: new Set(["t1+b1"]), lastUsed: new Map() };
  const { options } = ls.shortlistOutfits(pool, { blocks, saDate: "2026-11-02" });
  assert.ok(options.length >= 3);
  for (const o of options) {
    assert.ok(o.total <= ls.PRICE_CEILING, `R${o.total}`);
    assert.equal(ls.paletteRefusal(o.pieces), null);
    assert.notEqual(ls.pairKey(o.pieces), "t1+b1");
    assert.ok(["tee", "bottoms", "sneakers"].every((s) => o.pieces.some((p) => p.slot === s)));
  }
  const share = {};
  for (const o of options) for (const p of o.pieces) share[p.pid] = (share[p.pid] || 0) + 1;
  assert.ok(Object.values(share).every((n) => n <= 2), "no piece in more than two options");
  // A different day is a different order (the jitter), never first-match forever.
  const other = ls.shortlistOutfits(pool, { blocks, saDate: "2026-11-09" }).options.map((o) => o.pieces.map((p) => p.pid).join("+"));
  assert.ok(other.length >= 3);
});

// ── Gemma's answer and the cloud hand-off ──────────────────────────────────
const offerOf = (pieces) => ({ pieces, slots: ls.SLOT_ORDER, core: ls.CORE, minPieces: 3, maxPieces: 6, season: "summer", knownBrands: ["Nike", "Adidas", "Diesel"] });
const pieces3 = [P("t1", "tee", 350, "white"), P("b1", "bottoms", 750, "blue denim"), P("s1", "sneakers", 700, "white")];
const goodJson = { option: 1, formula: "blue-denim", theme: "Blue Denim", hero_pid: "s1", colours: ["white", "blue denim"], caption: "Clean white Nike tee, blue jeans and white Nike sneakers. Durban easy.\n#marathonclub #streetwear", why: "White on denim lets the sneakers lead.", caption_theme: "clean summer denim", scores: { colour: 9, formality: 8, theme: 9, caption: 8 } };

test("validateLocal: a good answer passes; a wrong option, theme or a price in the caption is rejected", () => {
  const options = [{ pieces: pieces3, total: 1800 }];
  const v = ls.validateLocal(goodJson, options, offerOf(pieces3));
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.deepEqual(v.answer.pids, ["t1", "b1", "s1"]);
  assert.match(ls.validateLocal({ ...goodJson, option: 3 }, options, offerOf(pieces3)).problems[0], /not one of/);
  assert.equal(ls.validateLocal({ ...goodJson, theme: "Denim Vibes" }, options, offerOf(pieces3)).answer.theme, "Blue Denim");
  assert.ok(ls.validateLocal({ ...goodJson, formula: "no-such", theme: "Nice Fit" }, options, offerOf(pieces3)).problems.some((p) => /formula/.test(p)));
  assert.ok(ls.validateLocal({ ...goodJson, caption: "Only R1,800 for the lot!" }, options, offerOf(pieces3)).problems.some((p) => /price/.test(p)));
  const blocks = ls.ledgerBlocks({ entries: [{ date: "2026-11-01", kind: "outfit", status: "posted", pids: ["s1"], families: [], pair: null }] }, "2026-11-02");
  assert.ok(ls.validateLocal(goodJson, options, offerOf(pieces3), { blocks }).problems.some((p) => /worn in the last 14 days/.test(p)));
  const dear = [P("t1", "tee", 350, "white"), P("b1", "bottoms", 950, "blue denim"), P("s1", "sneakers", 900, "white")];
  assert.ok(ls.validateLocal(goodJson, [{ pieces: dear, total: 2200 }], offerOf(dear)).problems.some((p) => /over R2000/.test(p)));
});

test("fitFromPick: a fresh pick becomes the fit; a missing, stale or sold-out pick is a skip; never a cost", () => {
  const rec = { saDate: "2026-11-02", kind: "lookbook", model: "gemma4:12b-it-qat", answer: { ...goodJson, pids: ["t1", "b1", "s1"] }, scores: goodJson.scores };
  const ok = ls.fitFromPick(rec, offerOf(pieces3), { saDate: "2026-11-02" });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.costUSD, 0);
  assert.equal(ok.fit.theme, "Blue Denim");
  assert.equal(ok.verdict.scores.colour, 9);
  assert.match(ls.fitFromPick(null, offerOf(pieces3), { saDate: "2026-11-02" }).reason, /did not run/);
  assert.match(ls.fitFromPick(rec, offerOf(pieces3), { saDate: "2026-11-04" }).reason, /is for 2026-11-02/);
  const sold = ls.fitFromPick(rec, offerOf(pieces3.slice(0, 2)), { saDate: "2026-11-02" });
  assert.equal(sold.ok, false);
  assert.match(sold.reason, /not in the catalogue/);
  assert.deepEqual(ls.pickPids(rec, "2026-11-02"), ["t1", "b1", "s1"]);
  assert.deepEqual(ls.pickPids(rec, "2026-11-03"), []);
});

test("localFitAgentFor reads social_stylist/picks/{saDate}/{kind} once", async () => {
  let reads = 0;
  const rec = { saDate: "2026-11-02", answer: { ...goodJson, pids: ["t1", "b1", "s1"] }, scores: goodJson.scores };
  const db = { ref: (p) => ({ once: async () => { reads++; assert.equal(p, "social_stylist/picks/2026-11-02/lookbook"); return { val: () => rec }; } }) };
  const agent = localFitAgentFor({ db, saDate: "2026-11-02", kind: "lookbook" });
  assert.deepEqual(await agent.wants(), ["t1", "b1", "s1"]);
  const r = await agent.build(offerOf(pieces3));
  assert.equal(r.ok, true);
  assert.equal(r.source, "local");
  assert.equal(reads, 1);
});

test("the local prompt lists every option's pieces with prices and asks for the schema", () => {
  const text = ls.localPrompt({ options: [{ pieces: pieces3, total: 1800 }], kind: "lookbook", season: "summer", formulas: ["blue-denim"], avoidFormulas: ["monochrome-black"], feedback: ["no neutral"] });
  assert.match(text, /Outfit 1 — R1800/);
  assert.match(text, /t1 \| tee/);
  assert.match(text, /monochrome-black/);
  assert.match(text, /no neutral/);
});

test("formulaProblems: the theme must be what the photos show", () => {
  const plain = [P("t1", "tee", 350, "black"), P("b1", "bottoms", 750, "grey"), P("s1", "sneakers", 750, "white")];
  assert.match(ls.formulaProblems("clean-luxe", plain)[0], /luxury/);
  assert.deepEqual(ls.formulaProblems("clean-luxe", [...plain.slice(0, 2), { ...P("s2", "sneakers", 1300, "white"), brand: "CHRISTIAN LOUBOUTIN" }]), []);
  assert.deepEqual(ls.formulaProblems("grey-scale", plain), []);
  assert.equal(ls.formulaProblems("earth-tone-street", plain).length, 1);
  assert.deepEqual(ls.formulaProblems("blue-denim", [P("t", "tee", 1, "white"), P("b", "bottoms", 1, "blue denim"), P("s", "sneakers", 1, "white")]), []);
  assert.deepEqual(ls.formulaProblems("colour-pop", plain), []);
});

test("validateLocal corrects a stray hero and a theme that names another formula, then validates", () => {
  const options = [{ pieces: pieces3, total: 1800 }];
  const v = ls.validateLocal({ ...goodJson, hero_pid: "Nike sneaker", formula: "court-classic", theme: "Blue Denim" }, options, offerOf(pieces3));
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.answer.hero_pid, "s1");
  assert.equal(v.answer.formula, "blue-denim");
  const reds = [P("t1", "tee", 350, "white"), P("b1", "bottoms", 750, "blue denim"), P("s1", "sneakers", 700, "red")];
  const pop = ls.validateLocal({ ...goodJson, formula: "court-classic", theme: "Red Pop", colours: ["red", "white", "blue denim"], caption: "Red sneakers, white tee, denim.\n#marathonclub" }, [{ pieces: reds, total: 1800 }], offerOf(reds));
  assert.equal(pop.answer.formula, "colour-pop");
});

test("formulaProblems: white only on the shoe for Monochrome Black; a Pop is never a neutral", () => {
  const whiteShorts = [P("t", "tee", 1, "black"), P("b", "bottoms", 1, "white"), P("s", "sneakers", 1, "black")];
  assert.equal(ls.formulaProblems("monochrome-black", whiteShorts).length, 1);
  assert.deepEqual(ls.formulaProblems("monochrome-black", [P("t", "tee", 1, "black"), P("b", "bottoms", 1, "black"), P("s", "sneakers", 1, "white")]), []);
  assert.match(ls.formulaProblems("colour-pop", whiteShorts, "White Pop")[0], /not an accent/);
  assert.deepEqual(ls.formulaProblems("colour-pop", [...whiteShorts.slice(0, 2), P("s", "sneakers", 1, "red")], "Red Pop"), []);
});

test("a Pop theme names a colour, not a shoe", () => {
  const x = [P("t", "tee", 1, "white"), P("b", "bottoms", 1, "blue denim"), P("s", "sneakers", 1, "light blue")];
  assert.equal(ls.formulaProblems("colour-pop", x, "Retro Equality Pop").length, 1);
  assert.deepEqual(ls.formulaProblems("colour-pop", x, "Light Blue Pop"), []);
});

test("a valid formula with a stray theme prints the formula's own name", () => {
  const v = ls.validateLocal({ ...goodJson, formula: "blue-denim", theme: "White and Black Pop" }, [{ pieces: pieces3, total: 1800 }], offerOf(pieces3));
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.answer.theme, "Blue Denim");
});

test("an outfit whose only fault is its formula's name is renamed to a formula the photos pass", () => {
  const greys = [P("t1", "tee", 350, "black"), P("b1", "bottoms", 750, "grey"), P("s1", "sneakers", 700, "white")];
  const v = ls.validateLocal({ ...goodJson, formula: "blue-denim", theme: "Blue Denim", hero_pid: "s1" }, [{ pieces: greys, total: 1800 }], offerOf(greys));
  assert.equal(v.ok, true, v.problems.join("; "));
  assert.equal(v.answer.formula, "grey-scale");
  assert.equal(v.answer.theme, "Grey Scale");
  const loud = [P("t1", "tee", 350, "orange"), P("b1", "bottoms", 750, "black"), P("s1", "sneakers", 700, "orange")];
  assert.equal(ls.validateLocal({ ...goodJson, formula: "blue-denim", theme: "Blue Denim", hero_pid: "s1" }, [{ pieces: loud, total: 1800 }], offerOf(loud)).ok, false);
});

test("'Red Heart Pop' reads as Red Pop; a caption may name the product's real brand", () => {
  const red = [P("t1", "tee", 350, "white"), P("b1", "bottoms", 750, "black"), P("s1", "sneakers", 700, "red")];
  const v = ls.validateLocal({ ...goodJson, formula: "colour-pop", theme: "Red Heart Pop", hero_pid: "s1", colours: ["red", "white", "black"], caption: "Red heart high-tops with a white tee.\n#marathonclub" }, [{ pieces: red, total: 1800 }], offerOf(red));
  assert.equal(v.answer.theme, "Red Pop");
  const gd = [{ ...P("t1", "tee", 350, "white"), brand: "GALLERY", displayName: "Distressed cotton crewneck tee", tillName: "Gallery Dept. White Distressed T-Shirt" }, P("b1", "bottoms", 750, "blue denim"), P("s1", "sneakers", 700, "white")];
  const offer = { ...offerOf(gd), knownBrands: ["Gallery Dept", "Nike"] };
  const ok = ls.validateLocal({ ...goodJson, caption: "Gallery Dept tee, denim and white kicks.\n#gallerydept" }, [{ pieces: gd, total: 1800 }], offer);
  assert.equal(ok.problems.some((p) => /brand/.test(p)), false, ok.problems.join("; "));
});

test("a Pop names a colour the pieces carry and is the only loud one", () => {
  const sage = [P("t1", "tee", 350, "white"), P("b1", "bottoms", 750, "green"), P("s1", "sneakers", 700, "white")];
  assert.ok(ls.formulaProblems("colour-pop", sage, "Red Pop").length);
  assert.deepEqual(ls.formulaProblems("colour-pop", sage, "Green Pop"), []);
});

test("Monochrome Black refuses a coloured shoe; a two-colour Pop is not guessed", () => {
  assert.equal(ls.formulaProblems("monochrome-black", [P("t", "tee", 1, "black"), P("b", "bottoms", 1, "black"), P("s", "sneakers", 1, "red")]).length, 1);
  const red = [P("t1", "tee", 350, "white"), P("b1", "bottoms", 750, "black"), P("s1", "sneakers", 700, "red")];
  const v = ls.validateLocal({ ...goodJson, formula: "colour-pop", theme: "Orange Red Pop", hero_pid: "s1" }, [{ pieces: red, total: 1800 }], offerOf(red));
  assert.notEqual(v.answer.theme, "Orange Pop");
});
