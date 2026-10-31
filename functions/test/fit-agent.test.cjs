// ─── THE STYLIST AND CRITIC LOOP, AND THE HOUSE MODEL, ON FAKE CALLS ────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fa = require("../lookbook/fit-agent.cjs");
const hm = require("../lookbook/house-models.cjs");
const fr = require("../lib/fit-rules.cjs");

const T = (over = {}) => ({ dominant: "black", pattern: "solid", silhouette: "regular", family: "streetwear", formality: 3, ...over });
const P = (pid, slot, brand, name, tags = {}) => ({ pid, slot, brand, name, displayName: `${brand} ${name}`, price: 500, tags: T(tags), sizes: { inStock: 3, sizes: 4 }, photoUrl: `https://x/${pid}.jpg` });
const OFFER = {
  pieces: [
    P("tee-w", "tee", "Hugo Boss", "Plain white tee", { dominant: "white" }),
    P("tee-g", "tee", "Sonic", "Washed black graphic tee", { pattern: "graphic" }),
    P("jean-b", "bottoms", "Diesel", "Slim black jeans"),
    P("loub", "sneakers", "Christian Louboutin", "Brown suede spiked low-top", { dominant: "brown" }),
  ],
  slots: ["hat", "jacket", "tee", "bottoms", "bag", "sneakers"], core: [["tee"], ["bottoms"], ["sneakers"]], optional: [],
  minPieces: 3, maxPieces: 6, season: "summer", kind: "lookbook", knownBrands: ["Diesel", "Hugo Boss", "Christian Louboutin", "Nike"],
};
const FIT = (over = {}) => ({ formula: "clean-luxe", theme: "Clean Luxe", hero_pid: "loub", pids: ["tee-w", "jean-b", "loub"], colours: ["white", "black", "brown"], caption: "Brown suede Louboutins, a plain white Hugo Boss tee and slim black Diesel jeans. #MarathonClub", why: "Quiet base, loud shoe.", ...over });
const CRIT = (c, f, t, cap, fix = "") => ({ colour: { score: c, reason: "colour ok" }, formality: { score: f, reason: "graphic band tee with studded designer shoes" }, theme: { score: t, reason: "t" }, caption: { score: cap, reason: "cap" }, seen: [], fix });

/** A fake model: answers in order, each costing `usd`; records the requests. */
function fake(answers, usd = 0.01, { cachedTokens } = {}) {
  const reqs = [];
  const call = async (req) => {
    reqs.push(req);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return { json: a, costUSD: usd, ...(cachedTokens ? { cachedTokens: cachedTokens(req) } : {}) };
  };
  return { call, reqs, photo: async () => ({ base64: "eA==", mediaType: "image/jpeg" }) };
}

describe("buildFit", () => {
  test("a fit the critic passes is returned after one round, with the photos attached", async () => {
    const f = fake([FIT(), CRIT(9, 9, 8, 9)]);
    const r = await fa.buildFit(OFFER, f);
    assert.equal(r.ok, true);
    assert.equal(r.rounds.length, 1);
    assert.deepEqual(r.rounds[0].scores, { colour: 9, formality: 9, theme: 8, caption: 9 });
    assert.equal(f.reqs[1].messages[0].content.filter((b) => b.type === "image").length, 3);
    assert.equal(r.costUSD, 0.02);
  });
  test("a score under 8 rebuilds with the critic's reasons; the second fit passes", async () => {
    const f = fake([FIT({ pids: ["tee-g", "jean-b", "loub"], caption: "Brown suede Louboutins, a washed black graphic tee and slim black Diesel jeans. #MarathonClub" }), CRIT(8, 3, 8, 9, "swap the band tee for a plain one"), FIT(), CRIT(9, 9, 9, 9)]);
    const r = await fa.buildFit(OFFER, f);
    assert.equal(r.ok, true);
    assert.equal(r.rounds.length, 2);
    assert.equal(r.rounds[0].min, 3);
    const retry = f.reqs[2].messages[0].content.map((b) => b.text || "").join("\n");
    assert.match(retry, /formality 3\/10 \(graphic band tee with studded designer shoes\)/);
    assert.match(retry, /swap the band tee for a plain one/);
  });
  test("three rounds under 8: the fit is skipped", async () => {
    // The API reports the cached prefix (the rulebook, and the catalogue for the
    // stylist): ~2,900 and ~2,400 tokens since the South African sections (30 Oct).
    const f = fake([FIT(), CRIT(7, 9, 9, 9), FIT(), CRIT(9, 7, 9, 9), FIT(), CRIT(9, 9, 7, 9)], 0.01, { cachedTokens: (req) => (req.schema === fr.STYLIST_SCHEMA ? 2900 : 2400) });
    const r = await fa.buildFit(OFFER, f);
    assert.equal(r.ok, false);
    assert.equal(r.rounds.length, 3);
    assert.match(r.reason, /no fit scored 8\+ on all four after 3 rounds/);
  });
  test("an answer the code checks refuse is a round, and its problems go back", async () => {
    const f = fake([FIT({ theme: "Earth Tone Street" }), FIT(), CRIT(9, 9, 9, 9)]);
    const r = await fa.buildFit(OFFER, f);
    assert.equal(r.ok, true);
    assert.match(r.rounds[0].problems.join(" "), /not the clean-luxe formula's name/);
    assert.match(f.reqs[1].messages[0].content[1].text, /refused by the checks/);
  });
  test("the budget: a call whose worst case would pass $0.15 is not made", async () => {
    const f = fake([FIT(), CRIT(7, 9, 9, 9), FIT(), CRIT(9, 9, 9, 9)], 0.06);
    const r = await fa.buildFit(OFFER, f);
    assert.equal(r.ok, false);
    assert.match(r.reason, /budget/);
    assert.ok(r.costUSD <= fr.BUDGET_USD);
  });
  test("an API error or a refusal is a skip, never another model", async () => {
    const r = await fa.buildFit(OFFER, fake([new Error("529 overloaded")]));
    assert.equal(r.ok, false);
    assert.match(r.reason, /stylist call failed: 529 overloaded/);
  });
  test("criticRecord keeps the final scores and every round", async () => {
    const r = await fa.buildFit(OFFER, fake([FIT(), CRIT(7, 9, 9, 9, "fix"), FIT(), CRIT(9, 9, 9, 9)]));
    const rec = fa.criticRecord(r);
    assert.equal(rec.model, "claude-opus-5-5");
    assert.equal(rec.passed, true);
    assert.equal(rec.rounds, 2);
    assert.deepEqual(rec.history.map((h) => h.scores && h.scores.colour), [7, 9]);
  });
});

describe("the three house models (Junid, 30 Oct 2026)", () => {
  const C = (slot, n, score, parts = {}) => ({ path: `aiStudio/social/lookbook/models/${slot}-1-${n}.jpg`, score, parts, contentType: "image/jpeg" });
  const node = (slot, over = {}) => ({ generatedAt: 0, decideBy: 1000, candidates: { 1: C(slot, 1, 7), 2: C(slot, 2, 9), 3: C(slot, 3, 8) }, picked: null, ...over });
  const all = (over = {}) => Object.fromEntries(hm.ORDER.map((s) => [s, node(s, over[s] || {})]));

  test("three models: Black, white and Coloured, each early-to-mid 20s, very tall (1.90 m) and slim, a skin fade or buzz cut", () => {
    assert.deepEqual(hm.ORDER, ["black", "white", "coloured"]);
    for (const s of hm.ORDER) {
      assert.match(hm.MODELS[s].description, /early-to-mid 20s, very tall \(about 1\.90 m, 6 ft 3 in\) and slim with a runway model's build: proper wide, broad, square shoulders over a slim waist[^:]*?, long legs \(more than half his height\), a long neck and a small head, about eight and a half heads tall, a sharp defined face and a strong jawline, a very short clean haircut \(a skin fade or a buzz cut/);
      assert.ok(hm.MODELS[s].skin && hm.MODELS[s].suits);
    }
    assert.match(hm.MODELS.black.description, /Black South African/);
    assert.match(hm.MODELS.white.description, /white South African/);
    assert.match(hm.MODELS.coloured.description, /Coloured South African/);
  });

  test("nothing posts until Junid approves: an unpicked model, or picks without approval, are refused", () => {
    assert.match(hm.gateFor(all(), null).reason, /no face picked yet for the black, white, coloured models/);
    const picked = all({ black: { picked: "2" }, white: { picked: "1" }, coloured: { picked: "3" } });
    assert.match(hm.gateFor(picked, null).reason, /not approved/);
    assert.match(hm.gateFor(picked, { approved: "yes" }).reason, /not approved/);
    const faces = hm.approvalFaces(picked);
    assert.equal(faces.black, C("black", 2, 9).path);
    assert.equal(hm.gateFor(picked, { approved: true, faces }).ok, true);
    // An approval with no faces, or a face changed after it, opens nothing (review of #822).
    assert.match(hm.gateFor(picked, { approved: true }).reason, /changed after Junid's approval/);
    const swapped = { ...picked, black: node("black", { picked: "3" }) };
    assert.match(hm.gateFor(swapped, { approved: true, faces }).reason, /the black face changed after Junid's approval: approve again/);
    const replaced = { ...picked, white: { ...node("white", { picked: "1" }), candidates: { 1: C("white", 9, 8) } } };
    assert.match(hm.gateFor(replaced, { approved: true, faces }).reason, /white face changed/);
    assert.match(hm.gateFor({ ...picked, white: node("white") }, { approved: true, faces }).reason, /white model/);
  });

  test("24 hours with no pick: the highest score is picked by \"auto\" (and only past the deadline)", () => {
    assert.deepEqual(hm.duePicks(all(), 999).picked, []);
    const due = hm.duePicks(all({ white: { picked: "3", pickedBy: "junid" } }), 1000);
    assert.deepEqual(due.picked.map((p) => `${p.slot}${p.n}`), ["black2", "coloured2"]);
    assert.equal(due.updates["social_lookbook/models/black/picked"], "2");
    assert.equal(due.updates["social_lookbook/models/black/pickedBy"], "auto");
    assert.equal(due.updates["social_lookbook/models/white/picked"], undefined);
    assert.deepEqual(hm.duePicks(all({ black: { decideBy: undefined } }), 9e12).picked.map((p) => p.slot), ["white", "coloured"]);
  });

  test("Junid's pick, a tie broken on the part-scores, and only faces in the models folder", () => {
    const u = hm.pickUpdates("coloured", node("coloured"), 3, { by: "junid", nowMs: 5 });
    assert.deepEqual(u, { "social_lookbook/models/coloured/picked": "3", "social_lookbook/models/coloured/pickedBy": "junid", "social_lookbook/models/coloured/pickedAt": 5 });
    assert.throws(() => hm.pickUpdates("black", node("black"), 7, { by: "junid", nowMs: 5 }), /no black candidate 7/);
    assert.throws(() => hm.pickUpdates("asian", node("black"), 1, { by: "junid", nowMs: 5 }), /no house model "asian"/);
    const tie = { candidates: { 1: C("black", 1, 8, { age: 7 }), 2: C("black", 2, 8, { age: 9 }) } };
    assert.equal(hm.rankCandidates(tie)[0].n, "2");
    const stray = { candidates: { 1: { path: "aiStudio/social/lookbook/rejected/2026-10-30/house-2.jpg", score: 10 } } };
    assert.equal(hm.rankCandidates(stray).length, 0);
    assert.equal(hm.chosenFor(stray, { allowProvisional: true }), null);
  });

  test("the stand-in is only for the proof samples: chosenFor gives no face to an unpicked model unless asked", () => {
    assert.equal(hm.chosenFor(node("black")), null);
    assert.equal(hm.chosenFor(node("black"), { allowProvisional: true }).n, "2");
    assert.equal(hm.chosenFor(node("black"), { allowProvisional: true }).provisional, true);
    assert.equal(hm.chosenFor(node("black", { picked: "3" })).n, "3");
  });

  test("the rotation: black, white, coloured, black …", () => {
    assert.equal(hm.nextSlot(null), "black");
    assert.equal(hm.nextSlot({ last: "black" }), "white");
    assert.equal(hm.nextSlot({ last: "white" }), "coloured");
    assert.equal(hm.nextSlot({ last: "coloured" }), "black");
  });
});
describe("buildFit — the budget and the photo notes", () => {
  test("a piece the critic says to replace is refused if the stylist brings it back", async () => {
    const f = fake([FIT({ pids: ["tee-g", "jean-b", "loub"], caption: "Brown suede Louboutins, a washed black graphic tee and slim black Diesel jeans. #MarathonClub" }), { ...CRIT(8, 3, 8, 9, "swap the tee"), replace: ["tee-g", "loub"] },
      FIT({ pids: ["tee-g", "jean-b", "loub"], caption: "Brown suede Louboutins, a washed black graphic tee and slim black Diesel jeans. #MarathonClub" }), FIT(), CRIT(9, 9, 9, 9)]);
    const r = await fa.buildFit({ ...OFFER, heroPid: "loub" }, f);
    assert.equal(r.ok, true);
    assert.match(r.rounds[1].problems.join(" "), /replace tee-g: they cannot be used again/);
    assert.match(f.reqs[2].messages[0].content[1].text, /must NOT be used again: tee-g, loub/);
    assert.ok(!r.rounds[1].problems.join(" ").includes("loub"), "the fixed hero is never banned");
  });
  test("a round is not started when its stylist and critic together could pass the budget", async () => {
    const f = fake([FIT(), CRIT(7, 9, 9, 9)], 0.07);
    const r = await fa.buildFit(OFFER, f);
    assert.equal(r.ok, false);
    assert.equal(f.reqs.length, 2, "round 2's stylist is never called, so nothing is spent on an answer nobody scores");
    assert.match(r.reason, /round 2: a stylist call and its critic do not fit/);
  });
  test("adversarial: every call bills its full worst case, the fit never passes — the total still never exceeds $0.15", async () => {
    const reqs = [];
    let n = 0;
    const call = async (req) => {
      reqs.push(req);
      const json = (n++ % 2 === 0) ? FIT() : CRIT(7, 7, 7, 7);
      return { json, costUSD: fr.worstCaseUSD(req), cachedTokens: 0 };
    };
    const r = await fa.buildFit(OFFER, { call, photo: async () => ({ base64: "eA==", mediaType: "image/jpeg" }) });
    assert.equal(r.ok, false);
    assert.ok(r.costUSD <= fr.BUDGET_USD + 1e-9, `spent ${r.costUSD}`);
    assert.ok(reqs.every((q) => q.maxTokens >= fr.MIN_OUT_TOKENS));
  });
  test("the prefix a call just cached is priced at the cache-read rate", () => {
    const req = fr.stylistRequest(OFFER);
    assert.ok(fr.worstCaseUSD(req, { cachedTokens: 5000 }) < fr.worstCaseUSD(req) - 0.02);
  });
  test("what the critic saw in each photo is handed to remember(), for the next catalogues", async () => {
    const f = fake([FIT(), { ...CRIT(9, 9, 9, 9), seen: [{ pid: "loub", colour: "taupe", what: "suede low-top with silver spikes" }] }]);
    let got = null;
    await fa.buildFit(OFFER, { ...f, remember: async (seen, pieces) => { got = { seen, pids: pieces.map((p) => p.pid) }; } });
    assert.deepEqual(got.seen[0], { pid: "loub", colour: "taupe", what: "suede low-top with silver spikes" });
    assert.deepEqual(got.pids, ["tee-w", "jean-b", "loub"]);
    assert.match(fr.catalogueText([{ ...OFFER.pieces[3], seen: "taupe suede low-top with silver spikes" }], ["sneakers"]), /photo: taupe suede low-top with silver spikes/);
  });
});

describe("buildFit — the cache is trusted only while it lives (CodeRabbit on #801)", () => {
  test("a rebuild more than four minutes after the last call is priced as a cache miss", async () => {
    let t = 0;
    const reqs = [];
    const answers = [FIT(), CRIT(7, 9, 9, 9), FIT(), CRIT(9, 9, 9, 9)];
    const call = async (req) => { reqs.push(req); t += 5 * 60 * 1000; return { json: answers.shift(), costUSD: 0.01, cachedTokens: 8000 }; };
    await fa.buildFit(OFFER, { call, photo: async () => ({ base64: "eA==", mediaType: "image/jpeg" }), now: () => t });
    const fresh = [];
    t = 0;
    const answers2 = [FIT(), CRIT(7, 9, 9, 9), FIT(), CRIT(9, 9, 9, 9)];
    await fa.buildFit(OFFER, { call: async (req) => { fresh.push(req); return { json: answers2.shift(), costUSD: 0.01, cachedTokens: 8000 }; }, photo: async () => ({ base64: "eA==", mediaType: "image/jpeg" }), now: () => t });
    assert.ok(reqs[2].maxTokens <= fresh[2].maxTokens, "a stale cache never buys a bigger ceiling");
  });
});

describe("buildFit — a cold morning still gets its rebuild (lookbook, Wed 28 Oct)", () => {
  test("round 1 at $0.077 with both caches written: round 2 is made, its critic reserve priced warm", async () => {
    const reqs = [];
    const answers = [FIT(), CRIT(8, 7, 8, 7), FIT(), CRIT(9, 9, 9, 9)];
    // The day's real numbers, with the cached prefixes grown by the rulebook's
    // South African sections (30 Oct: ~790 tokens for the stylist, ~540 for the critic).
    // Each answer carries its usage, as every real answer does (makeOpusCall), so round 2 is
    // priced from round 1's real token counts (#812).
    const usage = [
      { costUSD: 0.045, cachedTokens: 8590, usage: { input_tokens: 16, cache_creation_input_tokens: 8590, cache_read_input_tokens: 0, output_tokens: 600 } },
      { costUSD: 0.032, cachedTokens: 3580, usage: { input_tokens: 1000, cache_creation_input_tokens: 3580, cache_read_input_tokens: 0, output_tokens: 450 } },
      { costUSD: 0.016, cachedTokens: 8590, usage: { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 8590, output_tokens: 600 } },
      { costUSD: 0.014, cachedTokens: 3580, usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 3580, output_tokens: 450 } },
    ];
    const call = async (req) => { reqs.push(req); return { json: answers.shift(), ...usage.shift() }; };
    // A production-sized catalogue (44 pieces with real-length names and photo notes).
    const big = { ...OFFER, pieces: [...OFFER.pieces, ...Array.from({ length: 40 }, (_, i) => ({ ...P(`p17929${String(i).padStart(7, "0")}`, ["tee", "bottoms", "sneakers"][i % 3], "G-STAR RAW", "Raw cargo jeans indigo with zip pockets"), displayName: "G star raw cargo jean indigo 5233#", seen: "mid-blue cargo jeans with zip pockets" }))] };
    const r = await fa.buildFit(big, { call, photo: async () => ({ base64: "eA==", mediaType: "image/jpeg" }) });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.rounds.length, 2);
    assert.ok(reqs[2].maxTokens >= fr.MIN_OUT_TOKENS);
  });
});

describe("buildFit — round 2 priced from round 1's real token counts (Louboutin rebuild, 29 Oct)", () => {
  test("round 1 at $0.084 on cold caches: round 2 is still made", async () => {
    const big = { ...OFFER, pieces: [...OFFER.pieces, ...Array.from({ length: 40 }, (_, i) => ({ ...P(`p17929${String(i).padStart(7, "0")}`, ["tee", "bottoms", "sneakers"][i % 3], "G-STAR RAW", "Raw cargo jeans indigo with zip pockets"), displayName: "G star raw cargo jean indigo 5233#", seen: "mid-blue cargo jeans with zip pockets" }))] };
    const answers = [FIT(), CRIT(9, 7, 9, 8), FIT(), CRIT(9, 9, 9, 9)];
    const usage = [
      { costUSD: 0.050, cachedTokens: 8300, usage: { input_tokens: 16, cache_creation_input_tokens: 4800, cache_read_input_tokens: 3500, output_tokens: 700 } },
      { costUSD: 0.034, cachedTokens: 3100, usage: { input_tokens: 990, cache_creation_input_tokens: 3100, cache_read_input_tokens: 0, output_tokens: 600 } },
      { costUSD: 0.018, cachedTokens: 8300, usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 8300, output_tokens: 700 } },
      { costUSD: 0.015, cachedTokens: 3100, usage: { input_tokens: 990, cache_creation_input_tokens: 0, cache_read_input_tokens: 3100, output_tokens: 500 } },
    ];
    const reqs = [];
    const r = await fa.buildFit(big, { call: async (req) => { reqs.push(req); return { json: answers.shift(), ...usage.shift() }; }, photo: async () => ({ base64: "eA==", mediaType: "image/jpeg" }) });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.rounds.length, 2);
    assert.ok(r.costUSD <= fr.BUDGET_USD);
  });
});
