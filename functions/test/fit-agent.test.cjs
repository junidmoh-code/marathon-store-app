// ─── THE STYLIST AND CRITIC LOOP, AND THE HOUSE MODEL, ON FAKE CALLS ────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fa = require("../lookbook/fit-agent.cjs");
const hm = require("../lookbook/house-model.cjs");
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
function fake(answers, usd = 0.01) {
  const reqs = [];
  const call = async (req) => {
    reqs.push(req);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return { json: a, costUSD: usd };
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
    const f = fake([FIT(), CRIT(7, 9, 9, 9), FIT(), CRIT(9, 7, 9, 9), FIT(), CRIT(9, 9, 7, 9)]);
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

describe("the house model", () => {
  const C = (score) => ({ path: `aiStudio/social/lookbook/model/house-${score}.jpg`, score, contentType: "image/jpeg" });
  const HM = (over = {}) => ({ generatedAt: 0, decideBy: 1000, candidates: { 1: C(7), 2: C(9), 3: C(8), 4: C(9) }, ...over });
  test("before a pick and before the deadline: the best-scoring candidate stands in, nothing written", async () => {
    let wrote = null;
    const r = await hm.resolveRef(HM(), null, { nowMs: 500, pick: async (u) => { wrote = u; } });
    assert.equal(r.house, "2");
    assert.equal(r.provisional, true);
    assert.equal(wrote, null);
  });
  test("24 hours with no reply: the best-scoring one is picked, and written as the model", async () => {
    let wrote = null;
    const r = await hm.resolveRef(HM(), null, { nowMs: 1000, pick: async (u) => { wrote = u; } });
    assert.equal(r.house, "2");
    assert.equal(wrote["social_lookbook/houseModel/picked"], "2");
    assert.equal(wrote["social_lookbook/houseModel/pickedBy"], "auto");
    assert.equal(wrote["social_lookbook/model"].path, C(9).path);
  });
  test("Junid's pick wins, and after it the model node is the reference", async () => {
    const u = hm.pickUpdates(HM(), 3, { by: "junid", nowMs: 5 });
    assert.equal(u["social_lookbook/model"].house, "3");
    const r = await hm.resolveRef(HM({ picked: "3" }), u["social_lookbook/model"], { nowMs: 99999 });
    assert.equal(r.path, C(8).path);
    assert.equal(r.provisional, false);
    assert.throws(() => hm.pickUpdates(HM(), 7, { by: "junid", nowMs: 5 }), /no house-model candidate 7/);
  });
  test("a tie on the score goes to the higher sum of the part-scores", () => {
    const r = hm.rankCandidates({ candidates: { 1: { ...C(8), parts: { age: 7, hair: 8 } }, 2: { ...C(8), parts: { age: 9, hair: 8 } } } });
    assert.equal(r[0].n, "2");
  });
  test("candidates with no recorded deadline are never auto-picked", async () => {
    let wrote = null;
    const r = await hm.resolveRef(HM({ decideBy: undefined }), null, { nowMs: 9e12, pick: async (u) => { wrote = u; } });
    assert.equal(r.provisional, true);
    assert.equal(wrote, null);
  });
  test("a candidate outside the model folder is never used", () => {
    assert.deepEqual(hm.rankCandidates({ candidates: { 1: { path: "elsewhere/x.jpg", score: 10 } } }), []);
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
