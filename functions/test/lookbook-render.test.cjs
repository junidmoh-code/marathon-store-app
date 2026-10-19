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

  test("at 4/3 the model's position is converted back to design units: the wordmark narrows exactly as at scale 1", async () => {
    const rows = (await ROWS()).map((r) => ({ ...r, cutout: null }));
    const subject = { x: 0.45, y: 0.14 };       // a head that rises into the MARATHON block
    const one = await R.renderLookbookPoster({ hero: await hero(), rows, subject, scale: 1 });
    const big = await R.renderLookbookPoster({ hero: await hero(), rows, subject });
    assert.ok(one.markW < 440, `narrowed at scale 1 (${one.markW})`);
    assert.ok(Math.abs(big.markW - one.markW) < 1, `${big.markW} vs ${one.markW}`);
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
  test("rows re-space between header and total for 3..6 rows, in both canvases", () => {
    for (const H of [1800, 1500]) for (const n of [3, 4, 5, 6]) {
      const P = R.panelLayout(n, H);
      assert.equal(P.rows.length, n);
      assert.ok(P.rows[0].top >= P.header.top + P.header.h);
      assert.ok(P.rows[n - 1].top + P.rows[n - 1].h <= P.total.top);
      assert.ok(P.total.top + P.total.h < P.deliveryY);
    }
  });

  test("a short look fills the panel instead of floating in it (Junid, 19 Oct)", () => {
    for (const H of [1800, 1500]) for (const n of [3, 4]) {
      const P = R.panelLayout(n, H);
      assert.ok(Math.abs(P.rows[0].top - P.rowsTop) < 1e-6, "no empty band above");
      assert.ok(Math.abs(P.rows[n - 1].top + P.rows[n - 1].h - P.rowsBottom) < 1e-6, "no empty band below");
      assert.ok(P.thumb > R.panelLayout(6, H).thumb, `${n} rows: a larger cut-out than six`);
    }
    assert.equal(R.panelLayout(3, 1800).stacked, true);
    assert.equal(R.panelLayout(4, 1800).stacked, false);
    // Three rows stack: the cut-out is centred and inside its own row.
    const rows = ["tee", "bottoms", "sneakers"].map((slot) => ({ slot, brandLine: "NIKE", nameLine: "A LONG ENOUGH NAME TO WRAP ONTO A SECOND LINE", priceText: "R650" }));
    for (const H of [1800, 1500]) {
      const built = R.buildPosterSvg({ W: 1200, H, rows, total: { text: "R1,950" }, anchorsPx: {}, headPx: null });
      const P = R.panelLayout(3, H);
      built.thumbs.forEach((t, i) => {
        assert.ok(t.y >= P.rows[i].top && t.y + t.size <= P.rows[i].top + P.rows[i].h, `row ${i} at H ${H}`);
        assert.ok(Math.abs(t.x + t.size / 2 - (1200 * R.HERO_FRAC + 24 + (1200 - 1200 * R.HERO_FRAC - 48) / 2)) <= 1, "centred");
      });
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
    assert.equal(R.buildPosterSvg({ ...base, headPx: { x: 506, y: 360 } }).markW, 440);
    assert.ok(R.buildPosterSvg({ ...base, headPx: { x: 566, y: 244 } }).markW <= 566 - 0.055 * 1800 - 28 - 50);
    assert.ok(R.buildPosterSvg({ ...base, headPx: { x: 470, y: 150 } }).markW < 440);
  });

  test("type is drawn as outlines, never <text> left to the platform's font backend", () => {
    const rows = [{ slot: "hat", displayName: "A B", priceText: "R1" }, { slot: "tee", displayName: "A B", priceText: "R1" }, { slot: "bottoms", displayName: "A B", priceText: "R1" }, { slot: "sneakers", displayName: "A B", priceText: "R1" }];
    const { svg } = R.buildPosterSvg({ W: 1200, H: 1800, rows, total: { text: "R4" }, anchorsPx: {}, headPx: null });
    assert.doesNotMatch(svg, /<text/);
    assert.ok(type.measure("MARATHON", { font: "anton", size: 100 }) > 300);
  });
});

// ── GO-LIVE FIXES (owner brief, 19 Oct) ──────────────────────────────────────
describe("go-live: hero framing, leader lines, thumbnail scale", () => {
  test("body fit: the model fills ~85% of the column, head ~4% from the top, never upscaled", () => {
    // A 4K hero with the model from 0.12 to 0.85 (the old composition).
    const gw = 3072, gh = 5504, cw = 1088, ch = 2400;
    const f = R.heroFrame(gw, gh, cw, ch, 0.58, 0.62, { top: 0.12, bottom: 0.85 });
    assert.ok(f.scale <= 1, `scale ${f.scale}`);
    const top = f.toPx(0.58, 0.12).y, bottom = f.toPx(0.58, 0.85).y;
    assert.ok(Math.abs((bottom - top) / ch - 0.85) < 0.01, String((bottom - top) / ch));
    assert.ok(Math.abs(top / ch - 0.04) < 0.01, String(top / ch));
    assert.ok(f.top + ch <= f.sh && f.left + cw <= f.sw && f.top >= 0 && f.left >= 0);
    // A tiny body would need more than native pixels: the window stops at the column's size.
    const g = R.heroFrame(gw, gh, cw, ch, 0.58, 0.62, { top: 0.4, bottom: 0.6 });
    assert.ok(Math.abs(g.scale - 1) < 1e-9);
    // A body already taller than 85% keeps the full height (scale = cover).
    const h = R.heroFrame(gw, gh, cw, ch, 0.58, 0.62, { top: 0.02, bottom: 0.98 });
    assert.equal(h.sh, ch);
  });

  test("leader lines: dots handed out top to bottom in row order, and no two lines ever cross", () => {
    // The vision order inverted (tee above jacket, bag above bottoms).
    const ends = [100, 300, 500, 700, 900, 1100].map((y) => ({ x: 800, y }));
    const pts = [{ x: 420, y: 150 }, { x: 400, y: 520 }, { x: 380, y: 480 }, { x: 410, y: 900 }, { x: 600, y: 860 }, { x: 420, y: 1500 }];
    const p = R.planLeaders(pts, ends);
    for (let i = 1; i < p.length; i++) assert.ok(p[i].y >= p[i - 1].y);
    // Randomised: whatever the dots, the plan never crosses.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 500; n++) {
      const k = 4 + Math.floor(rnd() * 3);
      const e = Array.from({ length: k }, (_, i) => ({ x: 816, y: 200 + i * 250 }));
      const q = Array.from({ length: k }, () => ({ x: 200 + rnd() * 600, y: 50 + rnd() * 1650 }));
      const plan = R.planLeaders(q, e);
      for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
        assert.equal(R.segmentsCross(plan[i], e[i], plan[j], e[j]), false, JSON.stringify({ q, plan }));
      }
    }
  });

  test("the drawn poster's lines do not cross even when the vision order is upside down", () => {
    const rows = ["hat", "jacket", "tee", "bottoms", "bag", "sneakers"].map((slot) => ({ slot, brandLine: "NIKE", nameLine: "A PIECE", priceText: "R1" }));
    const anchorsPx = { hat: { x: 500, y: 200 }, jacket: { x: 520, y: 700 }, tee: { x: 450, y: 600 }, bottoms: { x: 470, y: 1100 }, bag: { x: 300, y: 1000 }, sneakers: { x: 480, y: 1500 } };
    const b = R.buildPosterSvg({ W: 1200, H: 1800, rows, total: { text: "R6" }, anchorsPx, headPx: null });
    const L = b.leaders;
    assert.equal(L.length, 6);
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) assert.equal(R.segmentsCross(L[i].a, L[i].end, L[j].a, L[j].end), false);
    for (let i = 1; i < L.length; i++) assert.ok(L[i].a.y >= L[i - 1].a.y);
  });

  test("thumbnails: every cut-out fits the same padded box, centred", () => {
    const size = 200, inner = size * (1 - 2 * R.THUMB_PAD);
    for (const [w, h] of [[900, 300], [300, 900], [500, 500], [640, 820], [40, 30]]) {
      const f = R.thumbFit(w, h, size);
      assert.ok(f.w <= Math.round(inner) && f.h <= Math.round(inner), `${w}x${h} → ${f.w}x${f.h}`);
      // the long side or the area cap decides: nothing is tiny next to its neighbours
      assert.ok(Math.max(f.w, f.h) >= inner * 0.84 - 1, `${w}x${h} → ${f.w}x${f.h}`);
    }
  });

  test("thumbnails: a transparent margin around a cut-out does not shrink it", async () => {
    const sharp = require("sharp");
    const solid = await sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }).png().toBuffer();
    const padded = await sharp(solid).extend({ top: 300, bottom: 300, left: 300, right: 300, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const t = await R.alphaTrim(padded);
    assert.deepEqual([t.w, t.h], [100, 100]);
  });
});
