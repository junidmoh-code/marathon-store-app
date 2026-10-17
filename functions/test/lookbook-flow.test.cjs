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
  const add = (pid, title, categoryKey, price) => {
    live[pid] = { state: "live", liveState: "on", cleanName: title, liveAt: NOW - 86400000, photos: [STAFF(pid)] };
    products[pid] = { name: `Nike ${title}`, categoryKey, retailPrice: price, sizes: ["M"], photoUrl: STAFF(pid) };
    stock.shop1[pid] = { M: { qty: 3 } };
  };
  if (withHat) add("h1", "Cap fitted", "fitted-caps", 499);
  add("j1", "Jacket puffer", "jackets", 1899);
  add("t1", "T shirt box", "t-shirts", 599);
  add("t2", "T shirt slub", "t-shirts", 649);
  add("b1", "Shorts mesh", "shorts", 799);
  add("s1", "Sneaker low", "sneakers", 2399);
  return new FakeRtdb({ shopify_publish: live, products, stock, locations: { shop1: { name: "Shop 1" } } });
}

let IMG;
const img = async () => IMG || (IMG = await sharp({ create: { width: 360, height: 640, channels: 3, background: "#6b7" } }).jpeg().toBuffer());
const CLEAN = JSON.stringify({ text_found: false, text_seen: "", head: { x: 0.58, y: 0.16 }, items: { hat: { x: 0.58, y: 0.13 } } });
const DIRTY = JSON.stringify({ text_found: true, text_seen: "VOGUE", items: {} });

function deps(db, over = {}) {
  const calls = { gen: 0, check: 0, released: 0 };
  const counter = () => db.ref("social_generation_budget/2026-10-18/count");
  const d = {
    calls,
    fetchImage: async () => ({ buffer: await img(), contentType: "image/jpeg" }),
    inlineImagePart: (b, t) => ({ inline_data: { mime_type: t, data: "x" } }),
    generateHero: async () => { calls.gen++; return { buffer: await img(), mime: "image/jpeg", costUSD: 0.134, engine: "nbpro" }; },
    checkHero: async () => { calls.check++; return CLEAN; },
    claimUnit: async () => {
      const r = await counter().transaction((c) => socialBudget.reserveGeneration(c, 4));
      return r.committed ? { ok: true, cap: 4 } : { ok: false, cap: 4, why: "cap" };
    },
    releaseUnit: async () => { calls.released++; await counter().transaction((c) => (typeof c === "number" && c > 0 ? c - 1 : c === null ? 0 : undefined)); },
    unitsLeft: async () => 4 - ((await counter().once("value")).val() || 0),
    isUnbilledError: (m) => /HTTP 5\d\d/.test(m),
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
    const r = await makeLookbook(db, d, { nowMs: NOW });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.rows.map((x) => x.slot), ["hat", "jacket", "tee", "bottoms", "sneakers"]);
    assert.equal(r.total.value, 499 + 1899 + 599 + 799 + 2399);
    assert.equal(r.costUSD, 0.134);
    assert.equal((await db.ref("social_generation_budget/2026-10-18/count").once("value")).val(), 1);
    // prompt, then (label, image) per row
    assert.equal(sentParts.length, 1 + 2 * r.rows.length);
    assert.match(sentParts[1].text, /^REFERENCE 1 — HAT:/);
    assert.ok(sentParts[2].inline_data);
    assert.equal(r.anchors.hat.source, "vision");
  });

  test("no eligible outfit: the outfit gate, nothing claimed, nothing generated", async () => {
    const db = seed({ withHat: false });
    db.root.products.j1.retailPrice = null;          // and no jacket price → 3 slots
    const d = deps(db);
    const r = await makeLookbook(db, d, { nowMs: NOW });
    assert.equal(r.gate, "outfit");
    assert.equal(d.calls.gen, 0);
    assert.equal((await db.ref("social_generation_budget").once("value")).val(), null);
  });

  test("text found, budget allows a retry that still leaves the fallback a unit: regenerates once", async () => {
    const db = seed();
    let n = 0;
    const d = deps(db, { checkHero: async () => (++n === 1 ? DIRTY : CLEAN) });
    const r = await makeLookbook(db, d, { nowMs: NOW });
    assert.equal(r.ok, true);
    assert.equal(d.calls.gen, 2);
    assert.equal(r.costUSD, 0.268);
  });

  test("text found on a normal day (2 reels already spent): NO regeneration, straight to the fallback", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(2);
    const d = deps(db, { checkHero: async () => DIRTY });
    const r = await makeLookbook(db, d, { nowMs: NOW });
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
    const r = await makeLookbook(db, d, { nowMs: NOW });
    assert.equal(r.gate, "text");
    assert.equal(d.calls.gen, 2);
    assert.match(r.reason, /failed the no-text check twice/);
  });

  test("an unreadable check is a FAIL, never a pass", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(2);
    const d = deps(db, { checkHero: async () => { throw new Error("529 overloaded"); } });
    const r = await makeLookbook(db, d, { nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.gate, "text");
  });

  test("cap reached: the cap gate, no model call", async () => {
    const db = seed();
    await db.ref("social_generation_budget/2026-10-18/count").set(4);
    const d = deps(db);
    const r = await makeLookbook(db, d, { nowMs: NOW });
    assert.equal(r.gate, "cap");
    assert.equal(d.calls.gen, 0);
  });

  test("an unbilled 5xx gives the unit back; a 4xx does not", async () => {
    for (const [msg, released] of [["gemini HTTP 503: overloaded", 1], ["gemini HTTP 400: bad", 0]]) {
      const db = seed();
      const d = deps(db, { generateHero: async () => { throw new Error(msg); } });
      const r = await makeLookbook(db, d, { nowMs: NOW });
      assert.equal(r.gate, "generate");
      assert.equal(d.calls.released, released, msg);
    }
  });

  test("a product photo that will not download is replaced, not fatal", async () => {
    const db = seed();
    const d = deps(db, { fetchImage: async (url) => { if (url.includes("t1")) throw new Error("404"); return { buffer: await img(), contentType: "image/jpeg" }; } });
    const r = await makeLookbook(db, d, { nowMs: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.rows.find((x) => x.slot === "tee").pid, "t2");
  });
});
