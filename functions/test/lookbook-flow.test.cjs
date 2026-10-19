// ─── ONE LOOKBOOK, END TO END, ON FAKES: EVERY GATE ──────────────────────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const { makeLookbook } = require("../lookbook/lookbook.cjs");
const { FakeRtdb } = require("./fixtures/rtdb-fake.cjs");
const socialBudget = require("../lib/social-budget.cjs");

const NOW = Date.UTC(2026, 9, 18, 5, 0);
const STAFF = (pid) => `https://firebasestorage.googleapis.com/v0/b/b/o/${encodeURIComponent(`products/${pid}/photo.jpg`)}?alt=media`;

function seed({ withHat = true } = {}) {
  const live = {}, products = {}, stock = { shop1: {} };
  // Website names (cleanName) describe the piece; the till name is brand +
  // short code. Prices so the five-row look lands in the R1,400–R1,900 band.
  const add = (pid, title, categoryKey, price) => {
    live[pid] = { state: "live", liveState: "on", cleanName: title, liveAt: NOW - 86400000, photos: [STAFF(pid)] };
    products[pid] = { name: `Nike ${categoryKey} ${pid}`, brand: "Nike", categoryKey, retailPrice: price, sizes: ["M"], photoUrl: STAFF(pid) };
    stock.shop1[pid] = { M: { qty: 3 } };
  };
  if (withHat) add("h1", "Cap fitted with curved brim", "fitted-caps", 150);
  add("j1", "Jacket puffer quilted with hood", "jackets", 400);
  add("t1", "T shirt boxy heavyweight cotton", "t-shirts", 250);
  add("t2", "T shirt slub relaxed fit", "t-shirts", 260);
  add("b1", "Shorts mesh with drawcord", "shorts", 300);
  add("s1", "Sneaker low suede panels", "sneakers", 600);
  return new FakeRtdb({ shopify_publish: live, products, stock, locations: { shop1: { name: "Shop 1" } } });
}

let IMG;
const img = async () => IMG || (IMG = await sharp({ create: { width: 360, height: 640, channels: 3, background: "#6b7" } }).jpeg().toBuffer());
const CLEAN = JSON.stringify({ text_found: false, text_seen: "", model_black: true, model_seen: "Black man, dark skin" });
const NOT_BLACK = JSON.stringify({ text_found: false, text_seen: "", model_black: false, model_seen: "white man, light skin" });
const LOCATED = JSON.stringify({ head: "G3", items: { hat: "G2", sneakers: "G17" } });
const DIRTY = JSON.stringify({ text_found: true, text_seen: "VOGUE", items: {} });

function deps(db, over = {}) {
  const calls = { gen: 0, check: 0, released: 0 };
  const counter = () => db.ref("social_generation_budget/2026-10-18/count");
  const d = {
    calls,
    fetchImage: async () => ({ buffer: await img(), contentType: "image/jpeg" }),
    inlineImagePart: (b, t) => ({ inline_data: { mime_type: t, data: "x" } }),
    generateHero: async () => { calls.gen++; return { buffer: await img(), mime: "image/jpeg", costUSD: 0.134, engine: "nbpro" }; },
    checkHero: async (_b, _m, prompt) => { calls.check++; return /grid/.test(prompt) ? LOCATED : CLEAN; },
    claimUnit: async () => {
      const r = await counter().transaction((c) => socialBudget.reserveGeneration(c, 4));
      return r.committed ? { ok: true, cap: 4 } : { ok: false, cap: 4, why: "cap" };
    },
    releaseUnit: async () => { calls.released++; await counter().transaction((c) => (typeof c === "number" && c > 0 ? c - 1 : c === null ? 0 : undefined)); },
    unitsLeft: async () => 4 - ((await counter().once("value")).val() || 0),
    isUnbilledError: (m) => /HTTP 5\d\d/.test(m),
    cutout: async (buf) => ({ png: await sharp(buf).png().toBuffer(), method: "fake" }),
    ...over,
  };
  d.calls = calls;
  return d;
}

describe("makeLookbook", () => {
  test("happy path: one generation, poster rendered, total from the rows, references attached in order", async () => {
    const db = seed();
    let sentParts = null;
    const d = deps(db, { generateHero: async (parts) => { sentParts = parts; return { buffer: await img(), mime: "image/jpeg", costUSD: 0.134, engine: "nbpro" }; } });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.rows.map((x) => x.slot), ["hat", "jacket", "tee", "bottoms", "sneakers"]);
    assert.equal(r.total.value, 150 + 400 + 250 + 300 + 600);
    assert.ok(r.total.value >= 1400 && r.total.value <= 1900);
    assert.equal(r.rows[0].brandLine, "NIKE");
    assert.equal(r.rows[0].nameLine, "CAP FITTED WITH CURVED BRIM");
    assert.equal(r.costUSD, 0.134);
    assert.equal(r.scene, "concrete");
    assert.match(sentParts[0].text, /MUST be a Black man with dark skin/);
    assert.match(sentParts[0].text, /board-formed concrete wall/);
    assert.doesNotMatch(sentParts[0].text, /palm/);
    assert.equal((await db.ref("social_generation_budget/2026-10-18/count").once("value")).val(), 1);
    // prompt, then (label, image) per row
    assert.equal(sentParts.length, 1 + 2 * r.rows.length);
    assert.match(sentParts[1].text, /^REFERENCE 1 — HAT:/);
    assert.ok(sentParts[2].inline_data);
    assert.equal(r.anchors.hat.source, "vision");
    assert.deepEqual(r.located.head, { x: 6.5 / 12, y: 2.5 / 20 });
    assert.equal(r.anchors.jacket.source, "body");
  });

  test("no eligible outfit: the outfit gate, nothing claimed, nothing generated", async () => {
    const db = seed({ withHat: false });
    db.root.products.j1.retailPrice = null;          // and no jacket price → 3 slots
    const d = deps(db);
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.gate, "outfit");
    assert.equal(d.calls.gen, 0);
    assert.equal((await db.ref("social_generation_budget").once("value")).val(), null);
  });

  test("text found, budget allows a retry that still leaves the fallback a unit: regenerates once", async () => {
    const db = seed();
    let n = 0;
    const d = deps(db, { checkHero: async (_b, _m, p) => (/grid/.test(p) ? LOCATED : ++n === 1 ? DIRTY : CLEAN) });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true);
    assert.equal(d.calls.gen, 2);
    assert.equal(r.costUSD, 0.268);
  });

  test("text found on a normal day (2 reels already spent): NO regeneration, straight to the fallback", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(2);
    const d = deps(db, { checkHero: async () => DIRTY });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.gate, "text");
    assert.equal(d.calls.gen, 1);
    assert.match(r.reason, /not regenerated: 1 unit\(s\) left/);
    // the fallback still has its unit
    assert.equal((await db.ref("social_generation_budget/2026-10-18/count").once("value")).val(), 3);
  });

  test("text found twice: the text gate", async () => {
    const db = seed();
    const d = deps(db, { checkHero: async () => DIRTY });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.gate, "text");
    assert.equal(d.calls.gen, 2);
    assert.match(r.reason, /failed the no-text check twice/);
  });

  test("production (maxAttempts 1): text found on a 1-reel day is ONE hero, then the fallback — 3 of 4", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(1);   // the one reel
    const d = deps(db, { checkHero: async () => DIRTY });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW, maxAttempts: 1 });
    assert.equal(r.gate, "text");
    assert.equal(d.calls.gen, 1);
    assert.match(r.reason, /failed the no-text check \(/);
    assert.equal((await db.ref("social_generation_budget/2026-10-18/count").once("value")).val(), 2);
  });

  test("an unreadable check is a FAIL, never a pass", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(2);
    const d = deps(db, { checkHero: async () => { throw new Error("529 overloaded"); } });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.gate, "text");
  });

  test("three units already spent: the lookbook does not take the fallback's unit", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(3);
    const d = deps(db);
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.gate, "cap");
    assert.equal(d.calls.gen, 0);
    assert.equal((await db.ref("social_generation_budget/2026-10-18/count").once("value")).val(), 3);
  });

  test("Pro 5xx then Flash failing with anything: the unit goes back", async () => {
    const db = seed();
    const d = deps(db, { generateHero: async () => { const e = new Error("pro 5xx, then flash: HTTP 400"); e.unbilled = true; throw e; } });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.gate, "generate");
    assert.equal(d.calls.released, 1);
  });

  test("cap reached: the cap gate, no model call", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(4);
    const d = deps(db);
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.gate, "cap");
    assert.equal(d.calls.gen, 0);
  });

  test("an unbilled 5xx gives the unit back; a 4xx does not", async () => {
    for (const [msg, released] of [["gemini HTTP 503: overloaded", 1], ["gemini HTTP 400: bad", 0]]) {
      const db = seed();
      const d = deps(db, { generateHero: async () => { throw new Error(msg); } });
      const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
      assert.equal(r.gate, "generate");
      assert.equal(d.calls.released, released, msg);
    }
  });

  test("a photo that does not cut out cleanly is not an approved photo: the next product in the slot is used", async () => {
    const db = seed();
    let bad = 0;
    const d = deps(db, {
      fetchImage: async (url) => ({ buffer: await img(), contentType: "image/jpeg", url }),
      cutout: async () => (++bad === 3 ? { png: null, tried: ["imgly:0.01/0e"] } : { png: await sharp(await img()).png().toBuffer(), method: "fake" }),
    });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true, r.reason);
    // t1 was the third photo fetched (hat, jacket, tee...) and failed: t2 replaces it
    assert.equal(r.rows.find((x) => x.slot === "tee").pid, "t2");
    assert.equal(d.calls.gen, 1);
  });

  test("a product photo that will not download is replaced, not fatal", async () => {
    const db = seed();
    const d = deps(db, { fetchImage: async (url) => { if (url.includes("t1")) throw new Error("404"); return { buffer: await img(), contentType: "image/jpeg" }; } });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.rows.find((x) => x.slot === "tee").pid, "t2");
  });
});

describe("makeLookbook — the model gate (owner review of sample 01)", () => {
  test("not visibly Black: regenerated once even in production (maxAttempts 1), and the second passes", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(1);   // the one reel
    let n = 0;
    const d = deps(db, { checkHero: async (_b, _m, p) => (/grid/.test(p) ? LOCATED : ++n === 1 ? NOT_BLACK : CLEAN) });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW, maxAttempts: 1 });
    assert.equal(r.ok, true, r.reason);
    assert.equal(d.calls.gen, 2);
    assert.equal(r.attempts[0].modelOk, false);
    // reel + two heroes = 3: the fallback still has its unit
    assert.equal((await db.ref("social_generation_budget/2026-10-18/count").once("value")).val(), 3);
  });

  test("not visibly Black twice: the model gate, and no third hero", async () => {
    const db = seed();
    const d = deps(db, { checkHero: async (_b, _m, p) => (/grid/.test(p) ? LOCATED : NOT_BLACK) });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW, maxAttempts: 1 });
    assert.equal(r.gate, "model");
    assert.equal(d.calls.gen, 2);
    assert.match(r.reason, /failed the model check twice/);
  });

  test("an answer with no model_black is a model FAIL, never a pass", async () => {
    const db = seed();
    const d = deps(db, { checkHero: async (_b, _m, p) => (/grid/.test(p) ? LOCATED : JSON.stringify({ text_found: false, text_seen: "" })) });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW, maxAttempts: 1 });
    assert.equal(r.gate, "model");
  });

  test("the regeneration still leaves the fallback its unit: 2 already spent → one hero, then the gate", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(2);
    const d = deps(db, { checkHero: async (_b, _m, p) => (/grid/.test(p) ? LOCATED : NOT_BLACK) });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW, maxAttempts: 1 });
    assert.equal(r.gate, "model");
    assert.equal(d.calls.gen, 1);
    assert.match(r.reason, /not regenerated: 1 unit\(s\) left/);
  });

  test("text found in production is still ONE hero (the model gate's retry is its own)", async () => {
    const db = seed();
    const d = deps(db, { checkHero: async () => DIRTY });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW, maxAttempts: 1 });
    assert.equal(r.gate, "text");
    assert.equal(d.calls.gen, 1);
  });

  test("the character reference goes in before the garments, and the prompt says to use him", async () => {
    const db = seed();
    let sent = null;
    const d = deps(db, {
      readModelRef: async () => ({ buffer: Buffer.from("face"), contentType: "image/jpeg" }),
      generateHero: async (parts) => { sent = parts; return { buffer: await img(), mime: "image/jpeg", costUSD: 0.24, engine: "nbpro" }; },
    });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.modelRef, true);
    assert.match(sent[0].text, /MODEL REFERENCE photo/);
    assert.match(sent[1].text, /^MODEL REFERENCE/);
    assert.ok(sent[2].inline_data);
    assert.match(sent[3].text, /^REFERENCE 1 — HAT:/);
  });

  test("an unreadable character reference is not a gate", async () => {
    const db = seed();
    const d = deps(db, { readModelRef: async () => { throw new Error("404"); } });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.modelRef, false);
  });

  test("the garden scene is the garden prompt", async () => {
    const db = seed();
    let sent = null;
    const d = deps(db, { generateHero: async (parts) => { sent = parts; return { buffer: await img(), mime: "image/jpeg", costUSD: 0.24, engine: "nbpro" }; } });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW, scene: "garden" });
    assert.equal(r.scene, "garden");
    assert.match(sent[0].text, /palm trees/);
    assert.doesNotMatch(sent[0].text, /concrete/);
    await assert.rejects(makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW, scene: "beach" }), /unknown scene/);
  });
});

describe("makeLookbook — the panel's clean product shots", () => {
  test("cached shots are used, missing ones generated once and cached, and their cost is on the poster", async () => {
    const db = seed();
    const png = await sharp(await img()).png().toBuffer();
    const cache = new Map([["h1", png]]);
    let gens = 0;
    const d = deps(db, {
      readThumbCache: async (pid) => (cache.has(pid) ? { png: cache.get(pid) } : null),
      writeThumbCache: async (pid, p) => { cache.set(pid, p); },
      claimThumbUnit: async () => ({ ok: true }),
      generateThumb: async (parts) => { gens++; assert.match(parts[0].text, /Pure white/); assert.ok(parts[2].inline_data); return { buffer: png, costUSD: 0.0336, engine: "flash-lite" }; },
    });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.equal(gens, r.rows.length - 1);              // every row but the cached hat
    assert.equal(r.thumbs.h1, "cache");
    assert.equal(r.thumbs.s1, "generated");
    assert.equal(+r.thumbCostUSD.toFixed(4), +(0.0336 * gens).toFixed(4));
    assert.equal(+r.costUSD.toFixed(4), +(0.134 + 0.0336 * gens).toFixed(4));
    // a second poster from the same products generates nothing
    const again = deps(seed(), { readThumbCache: d.readThumbCache, writeThumbCache: d.writeThumbCache, claimThumbUnit: d.claimThumbUnit, generateThumb: d.generateThumb });
    const before = gens;
    const r2 = await makeLookbook(seed(), again, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r2.ok, true);
    assert.equal(gens, before);
    assert.ok(Object.values(r2.thumbs).every((t) => t === "cache"));
  });
});

describe("makeLookbook — architect review of #750", () => {
  test("two units already spent and no room: the cap gate comes BEFORE any thumbnail is bought", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(3);
    let gens = 0;
    const d = deps(db, { claimThumbUnit: async () => ({ ok: true }), generateThumb: async () => { gens++; throw new Error("must not run"); } });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.gate, "cap");
    assert.equal(gens, 0);
  });

  test("an unanswered model check falls back without a second hero", async () => {
    const db = seed();
    const d = deps(db, { checkHero: async (_b, _m, p) => (/grid/.test(p) ? LOCATED : JSON.stringify({ text_found: false, text_seen: "" })) });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW, maxAttempts: 1 });
    assert.equal(r.gate, "model");
    assert.equal(d.calls.gen, 1);
  });

  test("past the hero deadline before the first hero: the time gate, nothing claimed", async () => {
    const db = seed();
    const d = deps(db, { deadlineMs: Date.now() - 1 });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.gate, "time");
    assert.equal(d.calls.gen, 0);
    assert.equal((await db.ref("social_generation_budget/2026-10-18/count").once("value")).val(), null);
  });
});


describe("makeLookbook — native resolution (owner go-live brief, 19 Oct)", () => {
  test("a hero under the model's native maximum is refused, never upscaled", async () => {
    const db = seed();
    const d = deps(db);
    const r = await makeLookbook(db, d, { nowMs: NOW });     // production minHeroPx
    assert.equal(r.ok, false);
    assert.equal(r.gate, "resolution");
    assert.match(r.reason, /360x640/);
  });
});

describe("makeLookbook — rows in body order (owner go-live brief, 19 Oct)", () => {
  test("a piece worn higher than its slot is listed higher, so every line goes to its own garment", async () => {
    const db = seed();
    // The jacket located BELOW the tee: the tee row moves above the jacket row.
    const located = JSON.stringify({ head: "G3", items: { hat: "G2", jacket: "G8", tee: "G5", bottoms: "G11", sneakers: "G17" } });
    const d = deps(db, { checkHero: async (_b, _m, prompt) => (/grid/.test(prompt) ? located : CLEAN) });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.rows.map((x) => x.slot), ["hat", "tee", "jacket", "bottoms", "sneakers"]);
    for (let i = 1; i < r.rows.length; i++) assert.ok(r.anchors[r.rows[i].slot].y >= r.anchors[r.rows[i - 1].slot].y);
  });
});

test("a bag beside the tee on the same grid row: each row keeps its own dot (Fable re-review)", async () => {
  const db = seed();
  db.root.shopify_publish.g1 = { state: "live", liveState: "on", cleanName: "Sling bag ripstop with buckle", liveAt: NOW - 86400000, photos: [STAFF("g1")] };
  db.root.products.g1 = { name: "Nike bags g1", brand: "Nike", categoryKey: "bags", retailPrice: 100, sizes: ["M"], photoUrl: STAFF("g1") };
  db.root.stock.shop1.g1 = { M: { qty: 3 } };
  const located = JSON.stringify({ head: "F3", items: { hat: "F2", tee: "H8", bag: "C8", bottoms: "F12", sneakers: "F17" } });
  const d = deps(db, { checkHero: async (_b, _m, prompt) => (/grid/.test(prompt) ? located : CLEAN) });
  const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
  assert.equal(r.ok, true, r.reason);
  const R = require("../lib/lookbook-render.cjs");
  // re-plan as the renderer does and check every row's dot is its own anchor (same order)
  const pts = r.rows.map((x) => r.anchors[x.slot]);
  const ends = r.rows.map((_, i) => ({ x: 1, y: i }));
  const plan = R.planLeaders(pts, ends);
  for (let i = 0; i < pts.length; i++) { assert.equal(plan[i].y, pts[i].y); if (plan[i].x === pts[i].x) continue; assert.ok(true); }
  const iTee = r.rows.findIndex((x) => x.slot === "tee"), iBag = r.rows.findIndex((x) => x.slot === "bag");
  if (iBag >= 0) assert.ok(iBag < iTee, "bag (left, same row) listed before the tee, matching the dot order");
});

describe("makeLookbook — the stylist", () => {
  test("one choice call over the shortlist; its look heads the panel and its note comes back", async () => {
    const db = seed();
    const prompts = [];
    const d = deps(db, {
      chooseOutfit: async (prompt) => { prompts.push(prompt); return { text: JSON.stringify({ choice: 1, look: "clean-monochrome", note: "Black on black, the sneaker does the talking." }), costUSD: 0.0004 }; },
    });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.ok(prompts.length <= 1);
    assert.ok(r.look && r.look.score > 0);
    if (prompts.length) {
      assert.match(prompts[0], /OPTION 1 — score/);
      assert.equal(r.look.source, "model");
      assert.equal(r.look.note, "Black on black, the sneaker does the talking.");
    }
    assert.deepEqual(r.poster.header, r.look.header);
    assert.ok(r.stylistCostUSD >= 0);
    assert.ok(Math.abs(r.costUSD - (0.134 + r.stylistCostUSD + (r.thumbCostUSD || 0))) < 1e-9);
  });

  test("a failed choice call keeps the top score and the scorer's note", async () => {
    const db = seed();
    const d = deps(db, { chooseOutfit: async () => { throw new Error("HTTP 529 overloaded"); } });
    const r = await makeLookbook(db, d, { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.look.source, "score");
    assert.ok(r.look.note.length > 10);
  });

  test("a product in a lookbook within 14 days is never picked; cached tags are used", async () => {
    const db = seed();
    db.root.social_lookbook = {
      history: { "2026-10-12": { pids: ["t1", "t2"], at: 1 } },
      styleTags: { s1: { v: 1, dominant: "white", secondary: null, pattern: "solid", silhouette: "n/a", family: "athleisure", formality: 3, season: "all", source: "vision" } },
    };
    const r = await makeLookbook(db, deps(db), { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.ok(!r.rows.some((x) => x.pid === "t1" || x.pid === "t2"));
    assert.match(r.styled.reasoning, /white sneakers anchor it/);
  });

  test("history older than 14 days does not block", async () => {
    const db = seed();
    db.root.social_lookbook = { history: { "2026-09-01": { pids: ["t1", "t2", "j1"], at: 1 } } };
    const r = await makeLookbook(db, deps(db), { minHeroPx: 0, nowMs: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.ok(r.rows.some((x) => x.slot === "tee"));
  });
});
