"use strict";
// Commit 1 of the local stylist (1 Nov 2026): why every fit wore the same
// jeans and the same tee, and the mechanical fixes.
const test = require("node:test");
const assert = require("node:assert/strict");
const lookbook = require("../lib/social-lookbook.cjs");
const fr = require("../lib/fit-rules.cjs");
const { rotationOffset } = require("../lookbook/load.cjs");

test("styleFamily: colourways of one garment collide, different designs do not", () => {
  const f = (n, b) => lookbook.styleFamily(n, b);
  assert.equal(f("Nike Just do it t shirt black w553", "NIKE"), f("Nike Just do it t shirt white w553", "NIKE"));
  assert.equal(f("Diesel Cargo Jean Y8156-2 Grey", "DIESEL"), f("Diesel cargo jean Y8156 black", "DIESEL"));
  assert.equal(f("G STAR RAW CARGO JEANS INDIGO GS 5233", "G-STAR RAW"), f("G STAR RAW CARGO JEANS DARK INDIGO GS-5233", "G-STAR RAW"));
  assert.notEqual(f("Nike T shirt white w683", "NIKE"), f("Nike T shirt white w671", "NIKE"));
  assert.equal(f("Boss T shirt 658#", "BOSS"), "boss|t shirt 658");
});

test("guessSlot: sweatshorts, jorts and denim titles are read as bottoms", () => {
  assert.equal(lookbook.guessSlot("Sweatshorts Light Grey"), "bottoms");
  assert.equal(lookbook.guessSlot("Denim distressed jorts with buckle waist detail"), "bottoms");
  assert.equal(lookbook.guessSlot("Distressed and ripped slim denim in washed blue"), "bottoms");
  assert.equal(lookbook.guessSlot("Leather low-top in white"), "sneakers");
});

test("rotationOffset: stable for a key, different across days", () => {
  assert.equal(rotationOffset("2026-11-02|tee", 40), rotationOffset("2026-11-02|tee", 40));
  const days = new Set(["01", "02", "03", "04", "05", "06", "07"].map((d) => rotationOffset(`2026-11-${d}|bottoms`, 100)));
  assert.ok(days.size >= 5, "a week of days starts the queue at different points");
  assert.equal(rotationOffset("x", 0), 0);
});

test("fit-rules trimOptional keeps every pid in a keep Set", () => {
  const pieces = Array.from({ length: 9 }, (_, i) => ({ pid: `h${i}`, slot: "hat", fresh: 1 - i / 10 }));
  const out = fr.trimOptional(pieces, [["tee"]], { keep: new Set(["h8"]) });
  assert.equal(out.length, 7);
  assert.ok(out.some((p) => p.pid === "h8"));
  assert.equal(fr.trimOptional(pieces, [["tee"]], { keep: "h7" }).filter((p) => p.pid === "h7").length, 1);
});

