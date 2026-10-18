// ─── THE LOOKBOOK RENDERER ───────────────────────────────────────────────────
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");
const R = require("../lib/lookbook-render.cjs");
const type = require("../lib/lookbook-type.cjs");

const grey = (fill) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#e6e6e4"/>${fill}</svg>`)).png().toBuffer();
const hero = () => sharp({ create: { width: 900, height: 1600, channels: 3, background: "#6d7a62" } }).jpeg().toBuffer();
const ROWS = async () => [
  { slot: "hat", displayName: "New Era Cap Black", price: 499, priceText: "R499", thumb: await grey('<rect x="100" y="150" width="200" height="100" fill="#111"/>') },
  { slot: "tee", displayName: "Nike Tee White", price: 599, priceText: "R599", thumb: await grey('<rect x="100" y="100" width="200" height="200" fill="#c22"/>') },
  { slot: "bottoms", displayName: "Carhartt Short", price: 1299, priceText: "R1,299", thumb: await grey('<rect x="120" y="80" width="160" height="240" fill="#875"/>') },
  { slot: "sneakers", displayName: "Nike Air Force 1", price: 2399, priceText: "R2,399", thumb: await sharp({ create: { width: 300, height: 300, channels: 3, background: "#e6e6e4" } }).png().toBuffer() },
];

describe("renderLookbookPoster", () => {
  test("three exports at the exact sizes, total summed from the rows", async () => {
    const out = await R.renderLookbookPoster({ hero: await hero(), rows: (await ROWS()).map((r) => ({ ...r, cutout: null })), anchors: { hat: { x: 0.58, y: 0.13 } } });
    // The master is drawn at RENDER_SCALE: 2400 px tall (owner review, 18 Oct).
    for (const [k, w, h] of [["master", 1600, 2400], ["feed", 1080, 1350], ["story", 1080, 1920]]) {
      const m = await sharp(out[k].buffer).metadata();
      assert.equal(m.width, w, k); assert.equal(m.height, h, k);
    }
    assert.equal(out.total.value, 499 + 599 + 1299 + 2399);
    assert.equal(out.total.text, "R4,796");
    assert.equal(out.master.width, 1600);
    assert.equal(out.master.height, 2400);
  });

  test("scale 1 is the old 1200x1800 layout, and the 4/3 master is the same design, not a crop", async () => {
    const rows = (await ROWS()).map((r) => ({ ...r, cutout: null }));
    const one = await R.renderLookbookPoster({ hero: await hero(), rows, scale: 1 });
    assert.equal((await sharp(one.master.buffer).metadata()).height, 1800);
    const big = await R.renderLookbookPoster({ hero: await hero(), rows });
    // Downscaled to 1200x1800 the big master matches the small one closely.
    const a = await sharp(one.master.buffer).resize(300, 450).greyscale().raw().toBuffer();
    const b = await sharp(big.master.buffer).resize(300, 450).greyscale().raw().toBuffer();
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
    assert.ok(diff / a.length < 6, `mean difference ${diff / a.length}`);
  });

  test("the G-Star fix: a multi-word brand on the bold line, the style code never drawn", () => {
    const rows = [{ slot: "bottoms", displayName: "G star raw cargo jeans FG3546#", priceText: "R750" }];
    const drawn = [];
    const real = type.textPath;
    type.textPath = (text, o) => { drawn.push(String(text)); return real(text, o); };
    try { R.buildPosterSvg({ W: 1200, H: 1800, rows, total: { text: "R750" }, anchorsPx: {}, headPx: null }); } finally { type.textPath = real; }
    assert.ok(drawn.includes("G-STAR RAW"), drawn.join(" | "));
    assert.ok(drawn.includes("CARGO JEANS"), drawn.join(" | "));
    assert.ok(!drawn.some((t) => /FG3546|^G$|STAR RAW CARGO/.test(t)), drawn.join(" | "));
  });

  test("a photo that is all background falls back to multiply rather than an empty cut-out", async () => {
    const out = await R.renderLookbookPoster({ hero: await hero(), rows: await ROWS() });
    assert.notEqual(out.cutouts.hat, "multiply");
    assert.equal(out.cutouts.sneakers, "multiply");
  });

  test("the story is the master letterboxed on the paper colour", async () => {
    const out = await R.renderLookbookPoster({ hero: await hero(), rows: (await ROWS()).map((r) => ({ ...r, cutout: null })) });
    const { data } = await sharp(out.story.buffer).extract({ left: 500, top: 10, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    for (const [c, want] of [[data[0], 0xE9], [data[1], 0xE6], [data[2], 0xDF]]) assert.ok(Math.abs(c - want) <= 3);
  });

  test("deterministic: the same inputs give the same bytes", async () => {
    const rows = (await ROWS()).map((r) => ({ ...r, cutout: null })); const h = await hero();
    const a = await R.renderLookbookPoster({ hero: h, rows });
    const b = await R.renderLookbookPoster({ hero: h, rows });
    assert.ok(a.master.buffer.equals(b.master.buffer));
  });

  test("refuses to draw a poster with no rows", async () => {
    await assert.rejects(R.renderLookbookPoster({ hero: await hero(), rows: [] }));
  });
});

describe("cut-out acceptance", () => {
  test("a product shape in the middle is accepted; a frame of clutter is not", async () => {
    const centred = await grey('<rect x="120" y="120" width="160" height="160" fill="#c22"/>');
    const ok = await R.cutout(centred, { mattes: [["fake", async (b) => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect x="120" y="120" width="160" height="160" fill="#000"/></svg>')).png().toBuffer()]] });
    assert.equal(ok.method, "fake");
    const edgeToEdge = await R.cutout(centred, { mattes: [["fake", async () => sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect x="0" y="0" width="400" height="200" fill="#000"/><rect x="0" y="200" width="60" height="200" fill="#000"/></svg>')).png().toBuffer()]] });
    assert.equal(edgeToEdge.png, null);
    assert.match(edgeToEdge.tried[0], /3e|4e/);
  });
});

describe("layout", () => {
  test("rows re-space between header and total for 4..6 rows, in both canvases", () => {
    for (const H of [1800, 1500]) for (const n of [4, 5, 6]) {
      const P = R.panelLayout(n, H);
      assert.equal(P.rows.length, n);
      assert.ok(P.rows[0].top >= P.header.top + P.header.h);
      assert.ok(P.rows[n - 1].top + P.rows[n - 1].h <= P.total.top);
      assert.ok(P.total.top + P.total.h < P.deliveryY);
    }
  });

  test("the hero is cropped from the top and keeps the subject right of centre", () => {
    const f = R.heroFrame(1536, 2752, 816, 1800, 0.58);
    assert.equal(f.top, 0);
    assert.equal(f.sh, 1800);
    assert.ok(Math.abs(f.toPx(0.58, 0).x - 0.62 * 816) < 2);
  });

  test("the wordmark stays full width unless the head rises into it", () => {
    const rows = [{ slot: "hat", displayName: "A B", priceText: "R1" }, { slot: "tee", displayName: "A B", priceText: "R1" }, { slot: "bottoms", displayName: "A B", priceText: "R1" }, { slot: "sneakers", displayName: "A B", priceText: "R1" }];
    const base = { W: 1200, H: 1800, rows, total: { text: "R4" }, anchorsPx: {} };
    assert.equal(R.buildPosterSvg({ ...base, headPx: { x: 506, y: 300 } }).markW, 440);
    assert.ok(R.buildPosterSvg({ ...base, headPx: { x: 470, y: 150 } }).markW < 440);
  });

  test("type is drawn as outlines, never <text> left to the platform's font backend", () => {
    const rows = [{ slot: "hat", displayName: "A B", priceText: "R1" }, { slot: "tee", displayName: "A B", priceText: "R1" }, { slot: "bottoms", displayName: "A B", priceText: "R1" }, { slot: "sneakers", displayName: "A B", priceText: "R1" }];
    const { svg } = R.buildPosterSvg({ W: 1200, H: 1800, rows, total: { text: "R4" }, anchorsPx: {}, headPx: null });
    assert.doesNotMatch(svg, /<text/);
    assert.ok(type.measure("MARATHON", { font: "anton", size: 100 }) > 300);
  });
});
