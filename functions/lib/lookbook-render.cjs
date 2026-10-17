// ─── THE LOOKBOOK POSTER, DRAWN IN CODE ──────────────────────────────────────
// The hero photograph is the only thing a model makes. Everything else on the
// poster is drawn here, from the product records: the wordmark, the taglines,
// the laurel badge, the vertical line, the shop box, the trust strip, the
// leader lines, the paper panel, every row's cut-out, brand, name and price,
// and the TOTAL.
//
// ── THREE EXPORTS, TWO LAYOUTS ───────────────────────────────────────────────
//   master  1200x1800 (2:3)  the layout as authored
//   feed    1080x1350 (4:5)  the SAME design laid out natively at 1200x1500,
//                            then scaled. The photograph is cropped from the
//                            TOP (never the head or the hat). The panel and
//                            the strip re-space to the shorter canvas instead
//                            of being cut off: a literal 300 px crop of the
//                            master would remove the TOTAL block and the trust
//                            strip. That is the crop docs/SOCIAL-SAFE-ZONE.md
//                            exists to prevent.
//   story   1080x1920 (9:16) the master, letterboxed on the paper colour.
//
// sharp only: the type is outlines from lib/lookbook-type.cjs, composited as
// one SVG over the photograph.
"use strict";

const fs = require("fs");
const path = require("path");
const type = require("./lookbook-type.cjs");
const { splitName } = require("./social-design.cjs");
const { formatRand } = require("./social-lookbook.cjs");

const PAPER = "#E9E6DF";
const INK = "#141414";
const OFF_WHITE = "#F3F0EA";
const RULE = "#BDB7AC";
const HERO_FRAC = 0.68;
const MASTER = { w: 1200, h: 1800 };
const FEED_LAYOUT = { w: 1200, h: 1500 };
const FEED = { w: 1080, h: 1350 };
const STORY = { w: 1080, h: 1920 };

const WREATH = fs.readFileSync(path.join(__dirname, "..", "assets", "lookbook", "laurel-wreath.svg"), "utf8")
  .replace(/^[\s\S]*?<g id="wreath"/, "<g")
  .replace(/<\/svg>\s*$/, "");

const f1 = (n) => Math.round(n * 10) / 10;

// ── ICONS (24×24, stroked, drawn for this poster) ────────────────────────────
const ICONS = {
  truck: '<path d="M1.5 6.5h12v9h-12z M13.5 9.5h4.2l3.3 3.3v2.7h-7.5z" fill="none" stroke-linejoin="round"/><circle cx="6" cy="17.3" r="1.9" fill="none"/><circle cx="17" cy="17.3" r="1.9" fill="none"/>',
  rosette: '<circle cx="12" cy="9" r="5.6" fill="none"/><circle cx="12" cy="9" r="2.6" fill="none"/><path d="M8.3 13.2 6.6 21l3.2-1.7 2.2 2.4 1-6.8 M15.7 13.2 17.4 21l-3.2-1.7-2.2 2.4" fill="none" stroke-linejoin="round"/>',
  arrows: '<path d="M4.5 10a7.5 7.5 0 0 1 13.2-3.6 M19.5 14a7.5 7.5 0 0 1-13.2 3.6" fill="none" stroke-linecap="round"/><path d="M18.3 2.8v4.1h-4.1 M5.7 21.2v-4.1h4.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  globe: '<circle cx="12" cy="12" r="9" fill="none"/><ellipse cx="12" cy="12" rx="3.9" ry="9" fill="none"/><path d="M3 12h18 M4.6 7.5h14.8 M4.6 16.5h14.8" fill="none"/>',
};
function icon(name, x, y, size, color, strokeWidth = 1.5) {
  const s = size / 24;
  return `<g transform="translate(${f1(x)} ${f1(y)}) scale(${s})" stroke="${color}" stroke-width="${f1(strokeWidth / s)}" fill="none">${ICONS[name]}</g>`;
}

// ── WHERE THE PHOTOGRAPH SITS ────────────────────────────────────────────────
// Cover-fit into the hero column, cropped from the top. Horizontally the
// subject (the model's centre, from the vision check, else 0.58 of the frame
// as the prompt asks) is placed at 62% of the column, which leaves the
// wordmark's corner to the garden.
function heroFrame(gw, gh, heroW, heroH, subjectX = 0.58, targetX = 0.62) {
  const scale = Math.max(heroW / gw, heroH / gh);
  const sw = Math.round(gw * scale), sh = Math.round(gh * scale);
  const left = Math.max(0, Math.min(sw - heroW, Math.round(subjectX * sw - targetX * heroW)));
  return {
    scale, sw, sh, left, top: 0,
    toPx: (fx, fy) => ({ x: fx * sw - left, y: fy * sh }),
  };
}

// ── THE PANEL'S VERTICAL RHYTHM ──────────────────────────────────────────────
function panelLayout(n, H) {
  const k = H / MASTER.h;
  const header = { top: Math.round(40 * k), h: Math.round(132 * k) };
  const total = { h: Math.round(214 * k) };
  const deliveryY = H - Math.round(44 * k);
  total.top = deliveryY - Math.round(48 * k) - total.h;
  const rowsTop = header.top + header.h + Math.round(18 * k);
  const rowsBottom = total.top - Math.round(18 * k);
  const avail = rowsBottom - rowsTop;
  const rowH = Math.min(avail / n, 250 * k);
  const start = rowsTop + (avail - rowH * n) / 2;
  const rows = Array.from({ length: n }, (_, i) => ({ top: start + i * rowH, h: rowH, cy: start + i * rowH + rowH / 2 }));
  return { k, header, total, deliveryY, rows, rowsTop, rowsBottom, thumb: Math.round(Math.min(150, rowH - 30 * k)) };
}

/**
 * Lay out and draw the SVG layer for one canvas. Returns the SVG and the
 * thumbnail boxes the caller composites the cut-outs into.
 */
function buildPosterSvg({ W, H, rows, total, anchorsPx, headPx }) {
  const heroW = Math.round(W * HERO_FRAC);
  const panelX = heroW, panelW = W - heroW;
  const pad = 24;
  const k = H / MASTER.h;
  const P = panelLayout(rows.length, H);
  const out = [];
  const T = (text, o) => type.textPath(text, o).svg;

  // ── HERO SHADES: legibility for the wordmark and the strip ──────────────
  const stripH = Math.round(206 * k);
  const stripTop = H - stripH;
  out.push(`<defs>
    <linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.42"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
    <linearGradient id="strip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0b0b" stop-opacity="0"/><stop offset="0.42" stop-color="#0b0b0b" stop-opacity="0.78"/><stop offset="1" stop-color="#0b0b0b" stop-opacity="0.92"/></linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.28"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
  </defs>`);
  out.push(`<rect x="0" y="0" width="${heroW}" height="${Math.round(640 * k)}" fill="url(#top)"/>`);
  out.push(`<rect x="0" y="0" width="90" height="${H}" fill="url(#edge)"/>`);
  out.push(`<rect x="0" y="${stripTop - Math.round(60 * k)}" width="${heroW}" height="${stripH + Math.round(60 * k)}" fill="url(#strip)"/>`);

  // ── WORDMARK: MARATHON / CLUB, taglines, badge ───────────────────────────
  const mx = 50;
  // Full width unless the model's head actually rises into the MARATHON/CLUB
  // block; then the block narrows to stay clear of it (never below 300 px).
  const markTop = Math.round(54 * k);
  const blockBottom = (w) => {
    const sz = type.sizeForWidth("MARATHON", w, { font: "anton" });
    return markTop + type.capHeight("anton", sz) + 16 * k + type.capHeight("archivo", sz * 0.25, 600);
  };
  let markW = 440;
  if (headPx) {
    const headTop = headPx.y - 0.045 * H, headLeft = headPx.x - 0.034 * H;
    if (headTop < blockBottom(markW) + 14 && headLeft - 28 < mx + markW) {
      markW = Math.max(300, Math.min(440, headLeft - 28 - mx));
    }
  }
  const markSize = type.sizeForWidth("MARATHON", markW, { font: "anton" });
  const markCap = type.capHeight("anton", markSize);
  const markBase = markTop + markCap;
  out.push(T("MARATHON", { font: "anton", size: markSize, x: mx, y: markBase, fill: OFF_WHITE }));
  const clubSize = markSize * 0.25;
  const clubBare = type.measure("CLUB", { font: "archivo", weight: 600, size: clubSize });
  const clubLs = (markW - clubBare) / 3;
  const clubBase = markBase + 16 * k + type.capHeight("archivo", clubSize, 600);
  out.push(T("CLUB", { font: "archivo", weight: 600, size: clubSize, letterSpacing: clubLs, x: mx, y: clubBase, fill: OFF_WHITE }));
  const tagSize = 13.5;
  const tag1 = clubBase + 40 * k;
  out.push(T("BUILT DIFFERENT.", { font: "archivo", weight: 600, size: tagSize, letterSpacing: 3.6, x: mx, y: tag1, fill: OFF_WHITE }));
  out.push(T("MADE TO MOVE.", { font: "archivo", weight: 600, size: tagSize, letterSpacing: 3.6, x: mx, y: tag1 + 22, fill: OFF_WHITE }));
  const badge = Math.round(92 * k);
  const badgeY = tag1 + 22 + 26 * k;
  out.push(`<g transform="translate(${mx - 6} ${f1(badgeY)}) scale(${f1(badge / 200 * 1000) / 1000})" color="${OFF_WHITE}">${WREATH}${
    T("M", { font: "playfair", weight: 700, size: 70, x: 100, y: 100 + type.capHeight("playfair", 70, 700) / 2, anchor: "middle", fill: OFF_WHITE })}</g>`);

  // ── THE VERTICAL LINE ON THE LEFT EDGE ───────────────────────────────────
  const vText = "A MOVEMENT FOR THE ONES WHO NEVER STOP.";
  const vOpts = { font: "archivo", weight: 600, size: 11, letterSpacing: 3.4 };
  const vW = type.measure(vText, vOpts);
  const vCap = type.capHeight("archivo", 11, 600);
  const vx = 26;
  const vMid = H * 0.53;
  const vBottom = vMid + vW / 2, vTop = vMid - vW / 2;
  out.push(`<g transform="translate(${f1(vx + vCap / 2)} ${f1(vBottom)}) rotate(-90)">${T(vText, { ...vOpts, x: 0, y: 0, fill: OFF_WHITE })}</g>`);
  out.push(`<line x1="${vx}" y1="${f1(vTop - 18 - 70 * k)}" x2="${vx}" y2="${f1(vTop - 18)}" stroke="${OFF_WHITE}" stroke-width="1"/>`);
  out.push(T("M", { font: "playfair", weight: 700, size: 20, x: vx, y: vBottom + 18 + type.capHeight("playfair", 20, 700), anchor: "middle", fill: OFF_WHITE }));

  // ── SHOP ONLINE ──────────────────────────────────────────────────────────
  const shopBox = { x: mx, h: Math.round(46 * k) };
  shopBox.y = stripTop - Math.round(30 * k) - shopBox.h;
  const shopLabelY = shopBox.y - Math.round(12 * k);
  out.push(T("SHOP ONLINE", { font: "archivo", weight: 700, size: 12, letterSpacing: 3.6, x: mx, y: shopLabelY, fill: OFF_WHITE }));
  const urlOpts = { font: "archivo", weight: 700, size: 16, letterSpacing: 1.6 };
  const urlW = type.measure("MARATHONCLUB.CO.ZA", urlOpts);
  shopBox.w = Math.round(16 + 20 + 12 + urlW + 18);
  out.push(`<rect x="${shopBox.x}" y="${shopBox.y}" width="${shopBox.w}" height="${shopBox.h}" fill="none" stroke="${OFF_WHITE}" stroke-width="1.2"/>`);
  out.push(icon("globe", shopBox.x + 16, shopBox.y + shopBox.h / 2 - 10, 20, OFF_WHITE, 1.4));
  out.push(T("MARATHONCLUB.CO.ZA", { ...urlOpts, x: shopBox.x + 16 + 20 + 12, y: shopBox.y + shopBox.h / 2 + type.capHeight("archivo", 16, 700) / 2, fill: OFF_WHITE }));

  // ── THE TRUST STRIP ──────────────────────────────────────────────────────
  const items = [["truck", "NATIONWIDE", "DELIVERY"], ["rosette", "PREMIUM", "QUALITY"], ["arrows", "EASY", "RETURNS"]];
  const stripPad = 36;
  const colW = (heroW - stripPad * 2) / 3;
  const rowCy = H - Math.round(94 * k);
  const lblOpts = { font: "archivo", weight: 700, size: 12.5, letterSpacing: 1.8 };
  const lblCap = type.capHeight("archivo", 12.5, 700);
  items.forEach(([ic, a, b], i) => {
    const textW = Math.max(type.measure(a, lblOpts), type.measure(b, lblOpts));
    const groupW = 30 + 12 + textW;
    const gx = stripPad + colW * i + (colW - groupW) / 2;
    out.push(icon(ic, gx, rowCy - 15, 30, OFF_WHITE, 1.5));
    out.push(T(a, { ...lblOpts, x: gx + 42, y: rowCy - 4, fill: OFF_WHITE }));
    out.push(T(b, { ...lblOpts, x: gx + 42, y: rowCy + 4 + lblCap, fill: OFF_WHITE }));
    if (i > 0) out.push(`<line x1="${f1(stripPad + colW * i)}" y1="${rowCy - 24}" x2="${f1(stripPad + colW * i)}" y2="${rowCy + 24}" stroke="${OFF_WHITE}" stroke-opacity="0.5" stroke-width="1"/>`);
  });
  out.push(T("EST. 2024 | JOIN THE CLUB.", { font: "archivo", weight: 600, size: 10.5, letterSpacing: 3.2, x: heroW / 2, y: H - Math.round(30 * k), anchor: "middle", fill: OFF_WHITE, opacity: 0.85 }));

  // ── THE PANEL ────────────────────────────────────────────────────────────
  const px0 = panelX + pad, px1 = W - pad, innerW = px1 - px0;
  out.push(`<rect x="${px0}" y="${P.header.top}" width="${innerW}" height="${P.header.h}" fill="${INK}"/>`);
  const headOpts = { font: "archivo", weight: 800, letterSpacing: 3 };
  const headSize = Math.min(24, type.sizeForWidth("LEGACY COLLECTION", innerW - 44, { ...headOpts }));
  const hCap = type.capHeight("archivo", headSize, 800);
  const hMid = P.header.top + P.header.h / 2;
  out.push(T("THE EVERYDAY", { ...headOpts, size: headSize, x: px0 + innerW / 2, y: hMid - 7, anchor: "middle", fill: "#fff" }));
  out.push(T("LEGACY COLLECTION", { ...headOpts, size: headSize, x: px0 + innerW / 2, y: hMid + 7 + hCap, anchor: "middle", fill: "#fff" }));

  const thumbs = [];
  const textX = px0 + P.thumb + 18;
  const textW = px1 - textX;
  rows.forEach((r, i) => {
    const box = P.rows[i];
    thumbs.push({ slot: r.slot, x: Math.round(px0), y: Math.round(box.cy - P.thumb / 2), size: P.thumb });
    const { brand, rest } = splitName(r.displayName);
    const bFit = type.wrap(brand, { font: "archivo", weight: 800, size: 19, minSize: 14, letterSpacing: 1, maxWidth: textW, maxLines: 1 });
    const nFit = type.wrap(rest || brand, { font: "archivo", weight: 500, size: 12.5, minSize: 10, letterSpacing: 0.8, maxWidth: textW, maxLines: 3 });
    const bCap = type.capHeight("archivo", bFit.size, 800);
    const nCap = type.capHeight("archivo", nFit.size, 500);
    const nLead = nFit.size * 1.38;
    const priceSize = 22, pCap = type.capHeight("archivo", priceSize, 800);
    const blockH = bCap + 10 + nCap + nLead * (nFit.lines.length - 1) + 14 + pCap;
    let y = box.cy - blockH / 2 + bCap;
    for (const line of bFit.lines) out.push(T(line, { font: "archivo", weight: 800, size: bFit.size, letterSpacing: 1, x: textX, y, fill: INK }));
    y += 10 + nCap;
    nFit.lines.forEach((line, j) => out.push(T(line, { font: "archivo", weight: 500, size: nFit.size, letterSpacing: 0.8, x: textX, y: y + j * nLead, fill: "#3a3a3a" })));
    y += nLead * (nFit.lines.length - 1) + 14 + pCap;
    out.push(T(r.priceText, { font: "archivo", weight: 800, size: priceSize, letterSpacing: 0.4, x: textX, y, fill: INK }));
    if (i < rows.length - 1) {
      const ry = box.top + box.h;
      out.push(`<line x1="${px0}" y1="${f1(ry)}" x2="${px1}" y2="${f1(ry)}" stroke="${RULE}" stroke-width="1"/>`);
    }
  });

  // TOTAL
  out.push(`<rect x="${px0}" y="${P.total.top}" width="${innerW}" height="${P.total.h}" fill="${INK}"/>`);
  out.push(T("TOTAL", { font: "archivo", weight: 700, size: 15, letterSpacing: 6, x: px0 + 24, y: P.total.top + 30 * k + type.capHeight("archivo", 15, 700), fill: "#fff" }));
  const totalText = total.text;
  const maxTotalSize = 132 * k;
  const totalSize = Math.min(maxTotalSize, type.sizeForWidth(totalText, innerW - 48, { font: "anton" }));
  out.push(T(totalText, { font: "anton", size: totalSize, x: px0 + innerW / 2, y: P.total.top + P.total.h - 28 * k, anchor: "middle", fill: "#fff" }));
  const delOpts = { font: "archivo", weight: 700, size: 10.5, letterSpacing: 1.4 };
  const delText = "FREE DELIVERY ON ORDERS OVER R999";
  const delW = 20 + 8 + type.measure(delText, delOpts);
  const dx = px0 + (innerW - delW) / 2;
  out.push(icon("truck", dx, P.deliveryY - 14, 20, INK, 1.5));
  out.push(T(delText, { ...delOpts, x: dx + 28, y: P.deliveryY + type.capHeight("archivo", 10.5, 700) / 2 - 4, fill: INK }));

  // ── LEADER LINES ─────────────────────────────────────────────────────────
  // White, thin, a dot at both ends. The panel end stops just inside the hero
  // so the dot sits on the photograph's edge, where white reads.
  rows.forEach((r, i) => {
    const a = anchorsPx[r.slot];
    if (!a) return;
    const ex = heroW - 9, ey = P.rows[i].cy;
    out.push(`<line x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${ex}" y2="${f1(ey)}" stroke="#000" stroke-opacity="0.25" stroke-width="3"/>`);
    out.push(`<line x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${ex}" y2="${f1(ey)}" stroke="#fff" stroke-width="1.3"/>`);
    for (const [x, y] of [[a.x, a.y], [ex, ey]]) {
      out.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="4.6" fill="#fff" stroke="#000" stroke-opacity="0.35" stroke-width="1"/>`);
    }
  });

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out.join("")}</svg>`,
    thumbs, heroW, panelX, layout: P, markW,
  };
}

// ── PAPER GRAIN ──────────────────────────────────────────────────────────────
// Faint, and deterministic (a fixed-seed LCG), so two renders of the same
// poster are byte-identical and a test can compare them.
function grain(w, h, seed = 20241017) {
  const buf = Buffer.alloc(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < w * h; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const v = s >>> 24;
    const dark = v < 128;
    buf[i * 4] = buf[i * 4 + 1] = buf[i * 4 + 2] = dark ? 60 : 255;
    buf[i * 4 + 3] = Math.round((Math.abs(v - 128) / 128) * 16);
  }
  return buf;
}

// ── PRODUCT CUT-OUTS ─────────────────────────────────────────────────────────
// The New Arrivals studio's own background removal (greyMatte: a flood of the
// light background from the edges, no model call). Accepted only when the
// result looks like a product (between 4% and 92% of the frame kept).
// Otherwise the photo is placed with a MULTIPLY blend, under which a white or
// light-grey backdrop takes the paper's colour and disappears.
let cutoutModule = null;
async function cutout(buffer) {
  const sharp = require("sharp");
  try {
    cutoutModule = cutoutModule || await import("../newArrivals/studio/cutout.mjs");
    const small = await sharp(buffer).rotate().resize(700, 700, { fit: "inside", withoutEnlargement: true }).toBuffer();
    const png = await cutoutModule.greyMatte(small);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    let kept = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 127) kept++;
    const frac = kept / (info.width * info.height);
    if (frac < 0.04 || frac > 0.92) return { png: null, method: "multiply", coverage: frac };
    const trimmed = await sharp(png).trim({ threshold: 1 }).png().toBuffer();
    return { png: trimmed, method: "greyMatte", coverage: frac };
  } catch (e) {
    return { png: null, method: "multiply", reason: String(e && e.message) };
  }
}

async function thumbLayer(buffer, size) {
  const sharp = require("sharp");
  const c = await cutout(buffer);
  if (c.png) {
    const fitted = await sharp(c.png).resize(size, size, { fit: "inside" }).png().toBuffer();
    const m = await sharp(fitted).metadata();
    return { input: fitted, dx: Math.round((size - m.width) / 2), dy: Math.round((size - m.height) / 2), method: c.method };
  }
  const fitted = await sharp(buffer).rotate().resize(size, size, { fit: "inside" }).flatten({ background: "#ffffff" }).png().toBuffer();
  const m = await sharp(fitted).metadata();
  return { input: fitted, dx: Math.round((size - m.width) / 2), dy: Math.round((size - m.height) / 2), blend: "multiply", method: "multiply" };
}

/**
 * Render one canvas.
 * @param hero      the generated photograph (any size; 9:16 is what is asked for)
 * @param rows      [{ slot, displayName, priceText, thumbLayer }] head to toe
 * @param total     { value, text }
 * @param anchors   { slot: {x,y} } fractions of the GENERATED photograph
 * @param subject   { x, y } fraction: the model's centre / head, or null
 */
async function renderCanvas({ hero, rows, total, anchors, subject, W, H }) {
  const sharp = require("sharp");
  const meta = await sharp(hero).metadata();
  const heroW = Math.round(W * HERO_FRAC);
  const frame = heroFrame(meta.width, meta.height, heroW, H, subject && Number.isFinite(subject.x) ? subject.x : 0.58);
  const heroBuf = await sharp(hero)
    .resize(frame.sw, frame.sh)
    .extract({ left: frame.left, top: frame.top, width: heroW, height: H })
    .toBuffer();
  const anchorsPx = {};
  for (const [slot, a] of Object.entries(anchors || {})) anchorsPx[slot] = frame.toPx(a.x, a.y);
  const headPx = subject && Number.isFinite(subject.y) ? frame.toPx(subject.x, subject.y) : null;
  const built = buildPosterSvg({ W, H, rows, total, anchorsPx, headPx });
  const layers = [
    { input: heroBuf, left: 0, top: 0 },
    { input: grain(W - heroW, H), raw: { width: W - heroW, height: H, channels: 4 }, left: heroW, top: 0 },
  ];
  for (const t of built.thumbs) {
    const row = rows.find((r) => r.slot === t.slot);
    const layer = row && row.thumbLayers && row.thumbLayers[t.size];
    if (!layer) continue;
    layers.push({ input: layer.input, left: t.x + layer.dx, top: t.y + layer.dy, ...(layer.blend ? { blend: layer.blend } : {}) });
  }
  layers.push({ input: Buffer.from(built.svg), left: 0, top: 0 });
  const buffer = await sharp({ create: { width: W, height: H, channels: 3, background: PAPER } })
    .composite(layers)
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return { buffer, width: W, height: H, built, frame };
}

/**
 * The whole poster: master, feed and story.
 * `rows[i].thumb` is the product photo buffer; the cut-out is made once per
 * thumbnail size used.
 */
async function renderLookbookPoster({ hero, rows, anchors = {}, subject = null }) {
  const sharp = require("sharp");
  if (!rows || !rows.length) throw new Error("renderLookbookPoster: no rows");
  const totalValue = rows.reduce((s, r) => s + r.price, 0);
  const total = { value: totalValue, text: formatRand(totalValue) };
  const sizes = new Set([MASTER, FEED_LAYOUT].map((c) => panelLayout(rows.length, c.h).thumb));
  const prepared = await Promise.all(rows.map(async (r) => {
    const thumbLayers = {};
    for (const size of sizes) thumbLayers[size] = r.thumb ? await thumbLayer(r.thumb, size) : null;
    return { ...r, thumbLayers };
  }));
  const master = await renderCanvas({ hero, rows: prepared, total, anchors, subject, W: MASTER.w, H: MASTER.h });
  const feedNative = await renderCanvas({ hero, rows: prepared, total, anchors, subject, W: FEED_LAYOUT.w, H: FEED_LAYOUT.h });
  const feed = await sharp(feedNative.buffer).resize(FEED.w, FEED.h).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
  const storyH = Math.round(MASTER.h * (STORY.w / MASTER.w));
  const padTop = Math.floor((STORY.h - storyH) / 2);
  const story = await sharp(master.buffer)
    .resize(STORY.w, storyH)
    .extend({ top: padTop, bottom: STORY.h - storyH - padTop, left: 0, right: 0, background: PAPER })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return {
    master: { buffer: master.buffer, width: MASTER.w, height: MASTER.h },
    feed: { buffer: feed, width: FEED.w, height: FEED.h },
    story: { buffer: story, width: STORY.w, height: STORY.h },
    total,
    cutouts: Object.fromEntries(prepared.map((r) => [r.slot, Object.values(r.thumbLayers)[0]?.method || "none"])),
    markW: master.built.markW,
  };
}

module.exports = {
  renderLookbookPoster, buildPosterSvg, panelLayout, heroFrame, cutout,
  PAPER, HERO_FRAC, MASTER, FEED, FEED_LAYOUT, STORY,
};
