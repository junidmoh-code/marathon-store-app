// ─── THE STYLE TAGS: READING, THE NAME FALLBACK, THE CACHE ───────────────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const st = require("../lib/style-tags.cjs");
const io = require("../lookbook/style-tags-io.cjs");
const { FakeRtdb } = require("./fixtures/rtdb-fake.cjs");

const ANSWER = { dominant: "black", secondary: "white", pattern: "solid", silhouette: "regular", family: "athleisure", formality: 2, season: "all" };

describe("readTags", () => {
  test("a good answer, normalised", () => {
    const r = st.readTags("```json\n" + JSON.stringify({ ...ANSWER, dominant: "Black" }) + "\n```");
    assert.equal(r.ok, true);
    assert.deepEqual(r.tags, ANSWER);
  });
  test("secondary none, or the same as dominant, is null", () => {
    assert.equal(st.readTags(JSON.stringify({ ...ANSWER, secondary: "none" })).tags.secondary, null);
    assert.equal(st.readTags(JSON.stringify({ ...ANSWER, secondary: "black" })).tags.secondary, null);
  });
  test("anything outside the guide's vocabulary is refused", () => {
    for (const bad of [{ dominant: "chartreuse" }, { pattern: "stripy" }, { silhouette: "huge" }, { family: "goth" }, { formality: 7 }, { formality: 2.5 }, { season: "spring" }]) {
      assert.equal(st.readTags(JSON.stringify({ ...ANSWER, ...bad })).ok, false, JSON.stringify(bad));
    }
    assert.equal(st.readTags("I think it is black").ok, false);
  });
  test("the schema offers only palette colours and the guide's families", () => {
    const s = st.tagSchema();
    assert.ok(s.properties.dominant.enum.includes("olive"));
    assert.ok(s.properties.secondary.enum.includes("none"));
    assert.deepEqual(s.properties.family.enum.sort(), ["athleisure", "prep", "smart-casual", "streetwear"]);
  });
  test("the prompt names the product and the vocabulary", () => {
    const p = st.buildTagPrompt({ brand: "Nike", name: "Tech fleece hoodie", categoryKey: "hoodies" });
    assert.match(p, /Nike — Tech fleece hoodie \(category: hoodies\)/);
    assert.match(p, /olive \(military green, sage\)/);
    assert.match(p, /ignore the background/);
  });
});

describe("nameTags (the fallback)", () => {
  test("colours in reading order, longest wording first", () => {
    assert.deepEqual(st.coloursIn("Light wash jeans in black"), ["denim-light", "black"]);
    assert.deepEqual(st.coloursIn("Tee in off-white with grey print"), ["off-white", "grey"]);
  });
  test("family from the brand, then the category", () => {
    assert.equal(st.nameTags({ name: "Lacoste polo navy", brand: "Lacoste", categoryKey: "golf-t-shirts" }).family, "prep");
    assert.equal(st.nameTags({ name: "Shorts black", brand: "Unknown Co", categoryKey: "shorts" }).family, "athleisure");
  });
  test("silhouette, pattern and season from the words", () => {
    const t = st.nameTags({ websiteName: "Oversized graphic tee in sand", brand: "Represent", categoryKey: "t-shirts" });
    assert.equal(t.silhouette, "oversized");
    assert.equal(t.pattern, "print");
    assert.equal(t.season, "summer");
    assert.equal(t.dominant, "beige");
    assert.equal(t.source, "name");
    assert.equal(st.nameTags({ name: "Air Max 90 white", categoryKey: "sneakers" }).silhouette, "n/a");
    assert.equal(st.nameTags({ name: "Monogram hoodie", categoryKey: "hoodies" }).pattern, "logo-heavy");
  });
  test("jeans with no colour word are mid denim", () => {
    assert.equal(st.nameTags({ name: "Straight jeans", categoryKey: "jeans" }).dominant, "denim-mid");
  });
});

describe("cost", () => {
  test("3.1 Flash-Lite at $0.25/$1.50 per million, thinking tokens billed as output", () => {
    assert.equal(+st.tagCostUSD({ promptTokenCount: 1000000, candidatesTokenCount: 1000000 }).toFixed(4), 1.75);
    assert.equal(+st.tagCostUSD({ promptTokenCount: 944, candidatesTokenCount: 64 }).toFixed(6), 0.000332);
    assert.equal(+st.tagCostUSD({ promptTokenCount: 0, candidatesTokenCount: 10, thoughtsTokenCount: 10 }, "gemini-3.5-flash-lite").toFixed(6), 0.00005);
  });
});

const okFetch = (answer, calls) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 60 } }) };
};
const PNG = async () => {
  const sharp = require("sharp");
  return { buffer: await sharp({ create: { width: 800, height: 600, channels: 3, background: "#000" } }).png().toBuffer(), contentType: "image/png" };
};

describe("ensureStyleTags", () => {
  test("cached tags are read, never re-tagged; missing ones tagged once and cached", async () => {
    const db = new FakeRtdb({ social_lookbook: { styleTags: { p1: { v: 1, ...ANSWER, source: "vision" } } } });
    const calls = [];
    const fetchImpl = okFetch({ ...ANSWER, dominant: "olive", family: "streetwear" }, calls);
    const items = [
      { pid: "p1", photoUrl: "u1", product: { brand: "Nike", name: "a", categoryKey: "hoodies" } },
      { pid: "p2", photoUrl: "u2", product: { brand: "Carhartt", name: "b", categoryKey: "pants" } },
    ];
    const deps = { geminiApiKey: "k", fetchImage: PNG };
    // visionTags gets fetch through a wrapper so the test owns the network.
    const orig = global.fetch;
    global.fetch = fetchImpl;
    try {
      const r = await io.ensureStyleTags(db, items, deps, { nowMs: 5 });
      assert.equal(r.tagged, 1);
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /gemini-3\.1-flash-lite:generateContent/);
      assert.equal(calls[0].body.generationConfig.mediaResolution, "MEDIA_RESOLUTION_LOW");
      assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
      assert.equal(r.tags.get("p1").dominant, "black");
      assert.equal(r.tags.get("p2").dominant, "olive");
      const rec = db._get(["social_lookbook", "styleTags", "p2"]);
      assert.equal(rec.source, "vision");
      assert.equal(rec.model, "gemini-3.1-flash-lite");
      assert.equal(rec.src, "u2");
      // A second run spends nothing.
      const again = await io.ensureStyleTags(db, items, deps, { nowMs: 6 });
      assert.equal(again.tagged, 0);
      assert.equal(calls.length, 1);
    } finally { global.fetch = orig; }
  });

  test("past the ceiling, or with no key, the name is read and nothing is cached", async () => {
    const db = new FakeRtdb({});
    const items = [{ pid: "p3", photoUrl: "u", product: { brand: "Lacoste", name: "Lacoste polo navy", categoryKey: "golf-t-shirts" } }];
    const r = await io.ensureStyleTags(db, items, {}, {});
    assert.equal(r.named, 1);
    assert.equal(r.tags.get("p3").source, "name");
    assert.equal(r.tags.get("p3").dominant, "navy");
    assert.equal(db._get(["social_lookbook", "styleTags", "p3"]), undefined);
  });

  test("an unusable answer from both models is not cached", async () => {
    const db = new FakeRtdb({});
    const calls = [];
    const orig = global.fetch;
    global.fetch = okFetch({ ...ANSWER, dominant: "chartreuse" }, calls);
    try {
      const r = await io.ensureStyleTags(db, [{ pid: "p4", photoUrl: "u", product: { name: "x", categoryKey: "t-shirts" } }], { geminiApiKey: "k", fetchImage: PNG, log: () => {} });
      assert.equal(calls.length, 2, "3.1 Flash-Lite, then 3.5 Flash-Lite");
      assert.equal(r.tags.get("p4").source, "name");
      assert.ok(r.costUSD > 0);
      assert.equal(db._get(["social_lookbook", "styleTags", "p4"]), undefined);
    } finally { global.fetch = orig; }
  });
});
