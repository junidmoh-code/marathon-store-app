// ─── THE LOOKBOOK POSTER, DRAWN IN CODE ──────────────────────────────────────
// The hero photograph is the only thing a model makes. Everything else on the
// poster is drawn here, from the product records: the wordmark, the taglines,
// the laurel badge, the vertical line, the shop box, the trust strip, the
// leader lines, the paper panel, every row's cut-out, brand, name and price,
// and the TOTAL.
//
// ── THREE EXPORTS, TWO LAYOUTS ───────────────────────────────────────────────
//   master  1600x2400 (2:3)  the layout as authored at 1200x1800, drawn at
//                            RENDER_SCALE (4/3) so the master is 2400 px
//                            tall: the type is vector and the hero is 4K, so
//                            nothing is stretched (owner review, 2026-10-18;
//                            it was 1200x1800 before)
//   feed    1080x1350 (4:5)  the SAME design laid out natively at 1200x1500,
//                            drawn at 1600x2000, then scaled down. The photograph is cropped from the
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
const { formatRand, guessSlot, posterName, BODY_FILL, BODY_TOP } = require("./social-lookbook.cjs");

const PAPER = "#E9E6DF";
const INK = "#141414";
const OFF_WHITE = "#F3F0EA";
const RULE = "#BDB7AC";
const HERO_FRAC = 0.68;
// Every layout number below is in the 1200-wide design space. RENDER_SCALE is
// applied only when the canvas is drawn.
const MASTER = { w: 1200, h: 1800 };
const RENDER_SCALE = 4 / 3;
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
// A window of the generated photograph, scaled to the hero column. Without a
// known body it is the cover fit, cropped from the top. With one (`body`, the
// top of the head and the soles as fractions) the window is cut so the model
// fills BODY_FILL of the column with his head BODY_TOP below its top edge
// (owner go-live brief, 19 Oct). The window is never smaller than the column
// in pixels: the photograph is only ever scaled DOWN, never upscaled. A body
// already that tall keeps the full height.
// Horizontally the subject (the model's centre, from the vision check, else
// 0.58 of the frame as the prompt asks) is placed at 62% of the column, which
// leaves the wordmark's corner to the scene.
function heroFrame(gw, gh, heroW, heroH, subjectX = 0.58, targetX = 0.62, body = null) {
  const aspect = heroW / heroH;
  let wh = gh;
  if (body && body.bottom > body.top) wh = Math.min(gh, Math.max(heroH, ((body.bottom - body.top) * gh) / BODY_FILL));
  let ww = wh * aspect;
  if (ww > gw) { ww = gw; wh = ww / aspect; }
  const scale = heroW / ww;
  const sw = Math.round(gw * scale), sh = Math.round(gh * scale);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const top = body ? clamp(Math.round((body.top * gh - BODY_TOP * wh) * scale), 0, sh - heroH) : 0;
  const left = clamp(Math.round(subjectX * sw - targetX * heroW), 0, sw - heroW);
  return {
    scale, sw, sh, left, top, window: { w: ww, h: wh },
    toPx: (fx, fy) => ({ x: fx * sw - left, y: fy * sh - top }),
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
function buildPosterSvg({ W, H, rows, total, anchorsPx, headPx, scale = 1 }) {
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
    // A brand line only for a real brand. "Jacket brown" has none, and must
    // not be set as brand JACKET over name BROWN (spec review L18): the
    // whole name goes on the bold line instead.
    // Multi-word brands in their proper form ("G-STAR RAW", "HUGO BOSS"),
    // style codes never printed (lib/social-lookbook.cjs posterName).
    // The picker's brand line + website name (social-lookbook resolveRow); a
    // row without them (an older caller) falls back to the display name.
    const split = r.brandLine && r.nameLine ? { brand: r.brandLine, rest: r.nameLine }
      : posterName(r.displayName, { fallbackSplit: splitName, isCategory: (w) => Boolean(guessSlot(w)) });
    const known = Boolean(split.brand);
    const brand = known ? split.brand : split.rest;
    const rest = known ? split.rest : "";
    const bFit = type.wrap(brand, { font: "archivo", weight: 800, size: 19, minSize: 14, letterSpacing: 1, maxWidth: textW, maxLines: known ? 1 : 2 });
    const nFit = type.wrap(rest, { font: "archivo", weight: 500, size: 12.5, minSize: 10, letterSpacing: 0.8, maxWidth: textW, maxLines: 3 });
    const bCap = type.capHeight("archivo", bFit.size, 800);
    const nCap = type.capHeight("archivo", nFit.size, 500);
    const nLead = nFit.size * 1.38;
    const priceSize = 22, pCap = type.capHeight("archivo", priceSize, 800);
    const bLead = bFit.size * 1.25;
    const hasName = nFit.lines.length > 0;
    const blockH = bCap + bLead * (bFit.lines.length - 1) + (hasName ? 10 + nCap + nLead * (nFit.lines.length - 1) : 0) + 14 + pCap;
    let y = box.cy - blockH / 2 + bCap;
    bFit.lines.forEach((line, j) => out.push(T(line, { font: "archivo", weight: 800, size: bFit.size, letterSpacing: 1, x: textX, y: y + j * bLead, fill: INK })));
    y += bLead * (bFit.lines.length - 1);
    if (hasName) {
      y += 10 + nCap;
      nFit.lines.forEach((line, j) => out.push(T(line, { font: "archivo", weight: 500, size: nFit.size, letterSpacing: 0.8, x: textX, y: y + j * nLead, fill: "#3a3a3a" })));
      y += nLead * (nFit.lines.length - 1);
    }
    y += 14 + pCap;
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
  // so the dot sits on the photograph's edge, where white reads. The dots are
  // handed out top to bottom in the panel's row order (planLeaders), so no two
  // lines ever cross (owner go-live brief, 19 Oct).
  const withDot = rows.map((r, i) => ({ a: anchorsPx[r.slot], end: { x: heroW - 9, y: P.rows[i].cy } })).filter((l) => l.a);
  const planned = planLeaders(withDot.map((l) => l.a), withDot.map((l) => l.end));
  const leaders = withDot.map((l, i) => ({ a: planned[i], end: l.end }));
  for (const { a, end } of leaders) {
    out.push(`<line x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${end.x}" y2="${f1(end.y)}" stroke="#000" stroke-opacity="0.25" stroke-width="3"/>`);
    out.push(`<line x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${end.x}" y2="${f1(end.y)}" stroke="#fff" stroke-width="1.3"/>`);
    for (const [x, y] of [[a.x, a.y], [end.x, end.y]]) {
      out.push(`<circle cx="${f1(x)}" cy="${f1(y)}" r="4.6" fill="#fff" stroke="#000" stroke-opacity="0.35" stroke-width="1"/>`);
    }
  }

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W * scale)}" height="${Math.round(H * scale)}" viewBox="0 0 ${W} ${H}">${out.join("")}</svg>`,
    thumbs, heroW, panelX, layout: P, markW, leaders,
  };
}

// ── LEADER LINES THAT NEVER CROSS ────────────────────────────────────────────
/** Do segments p1→p2 and q1→q2 properly cross (touching ends do not count)? Pure. */
function segmentsCross(p1, p2, q1, q2) {
  const o = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  const d1 = o(q1, q2, p1), d2 = o(q1, q2, p2), d3 = o(p1, p2, q1), d4 = o(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}
/**
 * The dots for the rows: the points sorted top to bottom and given to the rows
 * in order (`ends` are the panel ends, top to bottom). Two lines can still
 * cross when one dot is far left of the other; the left dot then moves level
 * with the right one (same x, so their order at both ends agrees and they
 * cannot cross). As a last resort every dot shares the rightmost x. Pure.
 */
function planLeaders(points, ends) {
  const p = points.map((q) => ({ x: q.x, y: q.y })).sort((a, b) => a.y - b.y || a.x - b.x);
  const crossing = () => {
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) {
      if (segmentsCross(p[i], ends[i], p[j], ends[j])) return [i, j];
    }
    return null;
  };
  for (let n = 0; n < p.length * p.length; n++) {
    const c = crossing();
    if (!c) return p;
    const [i, j] = c;
    if (p[i].x < p[j].x) p[i].x = p[j].x; else p[j].x = p[i].x;
  }
  if (crossing()) { const x = Math.max(...p.map((q) => q.x)); for (const q of p) q.x = x; }
  return p;
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
// Two mattes the repo already uses, best first:
//   1. @imgly/background-removal-node: the local ONNX matte the Mac mini's
//      group poster runs (marathon-group-poster src/cutout.mjs, IoU 0.99 on
//      Junid's real items). The shop's photos are taken on the mesh display
//      wall, and only a segmentation model can take that away. It is imported
//      lazily, so no other function in this codebase loads it.
//   2. greyMatte from the New Arrivals studio: a flood of a plain light
//      background, no model.
// A matte is accepted only when it looks like a product: 4%–92% of the frame
// kept, touching at most two of the image's edges. makeLookbook treats a photo
// no matte accepts as NOT an approved photo and picks the next product in the
// slot. The MULTIPLY placement below is only for callers that pass no cut-out.
let greyModule = null;
async function imglyMatte(buffer) {
  const sharp = require("sharp");
  const { removeBackground } = await import("@imgly/background-removal-node");
  const png = await sharp(buffer).png().toBuffer();
  // publicPath defaults to node_modules/ under the process's CWD, which is not
  // where a Cloud Function or a script started elsewhere has it. Point it at
  // the package's own dist/, where its weights ship.
  const publicPath = `file://${path.dirname(require.resolve("@imgly/background-removal-node"))}/`;
  const blob = await removeBackground(new Blob([png], { type: "image/png" }), { publicPath, model: "medium", output: { format: "image/png", quality: 1 } });
  return Buffer.from(await blob.arrayBuffer());
}
async function greyMatte(buffer) {
  greyModule = greyModule || await import("../newArrivals/studio/cutout.mjs");
  return greyModule.greyMatte(buffer);
}
// What a matte kept: the share of the frame, and how many image edges the kept
// region touches. A product photographed on a wall is a shape in the middle; a
// cluttered phone photo (bags, plastic, another product) runs off the edges.
async function measureMatte(png) {
  const sharp = require("sharp");
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let kept = 0, left = w, right = -1, top = h, bottom = -1;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] <= 127) continue;
    kept++;
    const x = i % w, y = (i - x) / w;
    if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
  }
  const m = 2;
  const edges = kept ? [left <= m, top <= m, right >= w - 1 - m, bottom >= h - 1 - m].filter(Boolean).length : 0;
  return { coverage: kept / (w * h), edges };
}

// Faint matte ghosts (a hint of the mesh wall left at 10–30% alpha) are cleared,
// and so are detached scraps: a hanger pole or a price-gun tag beside the
// product. Pieces under a quarter of the largest piece go (the New Arrivals
// studio's own components()); a shoe's box, which is a real part of the
// product shot, is usually bigger than that and stays.
async function clearGhosts(png) {
  const sharp = require("sharp");
  greyModule = greyModule || await import("../newArrivals/studio/cutout.mjs");
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 96) data[i] = 0;
  const { labels, comps } = greyModule.components(data, w, h);
  if (comps.length > 1) {
    const keep = new Set(comps.filter((c) => c.area >= comps[0].area * 0.25).map((c) => c.id));
    for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] && !keep.has(labels[i])) data[i * 4 + 3] = 0;
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

async function cutout(buffer, { mattes = [["imgly", imglyMatte], ["greyMatte", greyMatte]] } = {}) {
  const sharp = require("sharp");
  const small = await sharp(buffer).rotate().resize(900, 900, { fit: "inside", withoutEnlargement: true }).toBuffer();
  const tried = [];
  for (const [method, matte] of mattes) {
    try {
      const png = await clearGhosts(await matte(small));
      const { coverage, edges } = await measureMatte(png);
      tried.push(`${method}:${coverage.toFixed(2)}/${edges}e`);
      if (coverage < 0.04 || coverage > 0.92 || edges >= 3) continue;
      const trimmed = await sharp(png).trim({ threshold: 1 }).png().toBuffer();
      return { png: trimmed, method, coverage };
    } catch (e) {
      tried.push(`${method}:error ${String(e && e.message).slice(0, 60)}`);
    }
  }
  return { png: null, method: "multiply", tried };
}

// ── THE PANEL'S CUT-OUTS AT ONE SCALE (owner go-live brief, 19 Oct) ────────
// Every cut-out is trimmed to what it actually shows (alpha above THUMB_ALPHA,
// so a faint halo cannot pad one product out), then fitted into the same box:
// the thumbnail square less THUMB_PAD on every side, centred. Compact pieces
// (a beanie, a bag) are held to THUMB_AREA of the box by area, so a square
// item does not read twice the size of a long one.
const THUMB_PAD = 0.08;
const THUMB_AREA = 0.84;
const THUMB_ALPHA = 24;
async function alphaTrim(png) {
  const sharp = require("sharp");
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  let l = w, r = -1, t = h, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] <= THUMB_ALPHA) continue;
    if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y;
  }
  if (r < l || b < t) return { buffer: await sharp(png).ensureAlpha().png().toBuffer(), w, h };
  const buffer = await sharp(png).ensureAlpha().extract({ left: l, top: t, width: r - l + 1, height: b - t + 1 }).png().toBuffer();
  return { buffer, w: r - l + 1, h: b - t + 1 };
}
/** The size a w×h cut-out is drawn at inside a `size` box. Pure. */
function thumbFit(w, h, size) {
  const inner = size * (1 - 2 * THUMB_PAD);
  const k = Math.min(inner / w, inner / h, (inner * THUMB_AREA) / Math.sqrt(w * h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

async function thumbLayer(row, size) {
  const sharp = require("sharp");
  const c = row.cutout !== undefined ? row.cutout : (row.thumb ? await cutout(row.thumb) : { png: null });
  if (c && c.png) {
    const t = await alphaTrim(c.png);
    const fit = thumbFit(t.w, t.h, size);
    const fitted = await sharp(t.buffer).resize(fit.w, fit.h, { fit: "fill", kernel: "lanczos3" }).png().toBuffer();
    return { input: fitted, dx: Math.round((size - fit.w) / 2), dy: Math.round((size - fit.h) / 2), method: c.method };
  }
  if (!row.thumb) return null;
  const meta = await sharp(row.thumb).rotate().metadata();
  const fit = thumbFit(meta.width || size, meta.height || size, size);
  const fitted = await sharp(row.thumb).rotate().resize(fit.w, fit.h, { fit: "fill" }).flatten({ background: "#ffffff" }).png().toBuffer();
  return { input: fitted, dx: Math.round((size - fit.w) / 2), dy: Math.round((size - fit.h) / 2), blend: "multiply", method: "multiply" };
}

// ── THE LOCATE GRID ──────────────────────────────────────────────────────────
// A copy of the hero with social-lookbook's GRID drawn over it, labelled on all
// four edges, for the vision model to name cells on. Never published.
async function gridOverlay(buffer, grid) {
  const sharp = require("sharp");
  const base = await sharp(buffer).resize(1080, 1920, { fit: "inside" }).jpeg({ quality: 88 }).toBuffer();
  const { width: w, height: h } = await sharp(base).metadata();
  const cw = w / grid.cols, ch = h / grid.rows;
  const out = [];
  for (let c = 1; c < grid.cols; c++) out.push(`<line x1="${f1(c * cw)}" y1="0" x2="${f1(c * cw)}" y2="${h}" stroke="#ff2" stroke-opacity="0.75" stroke-width="1.5"/>`);
  for (let r = 1; r < grid.rows; r++) out.push(`<line x1="0" y1="${f1(r * ch)}" x2="${w}" y2="${f1(r * ch)}" stroke="#ff2" stroke-opacity="0.75" stroke-width="1.5"/>`);
  const label = (t, x, y) => `<rect x="${f1(x - 13)}" y="${f1(y - 13)}" width="26" height="26" fill="#000" fill-opacity="0.6"/>` +
    type.textPath(t, { font: "archivo", weight: 700, size: 15, x, y: y + 5.5, anchor: "middle", fill: "#ff2" }).svg;
  for (let c = 0; c < grid.cols; c++) { const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[c]; out.push(label(L, (c + 0.5) * cw, 14), label(L, (c + 0.5) * cw, h - 14)); }
  for (let r = 0; r < grid.rows; r++) out.push(label(String(r + 1), 14, (r + 0.5) * ch), label(String(r + 1), w - 14, (r + 0.5) * ch));
  return sharp(base).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${out.join("")}</svg>`) }]).jpeg({ quality: 88 }).toBuffer();
}

/**
 * Render one canvas.
 * @param hero      the generated photograph (any size; 9:16 is what is asked for)
 * @param rows      [{ slot, displayName, priceText, thumbLayer }] head to toe
 * @param total     { value, text }
 * @param anchors   { slot: {x,y} } fractions of the GENERATED photograph
 * @param subject   { x, y } fraction: the model's centre / head, or null
 */
async function renderCanvas({ hero, rows, total, anchors, subject, body = null, W, H, scale = RENDER_SCALE }) {
  const sharp = require("sharp");
  const meta = await sharp(hero).metadata();
  const heroW = Math.round(W * HERO_FRAC);
  // The layout is in design units (W x H); the pixels are design x scale.
  const PW = Math.round(W * scale), PH = Math.round(H * scale), pHeroW = Math.round(heroW * scale);
  const frame = heroFrame(meta.width, meta.height, pHeroW, PH, subject && Number.isFinite(subject.x) ? subject.x : 0.58, 0.62, body);
  const heroBuf = await sharp(hero)
    .resize(frame.sw, frame.sh, { kernel: "lanczos3" })
    .extract({ left: frame.left, top: frame.top, width: pHeroW, height: PH })
    .toBuffer();
  const toDesign = (p) => ({ x: p.x / scale, y: p.y / scale });
  const anchorsPx = {};
  for (const [slot, a] of Object.entries(anchors || {})) anchorsPx[slot] = toDesign(frame.toPx(a.x, a.y));
  const headPx = subject && Number.isFinite(subject.y) ? toDesign(frame.toPx(subject.x, subject.y)) : null;
  const built = buildPosterSvg({ W, H, rows, total, anchorsPx, headPx, scale });
  const layers = [
    { input: heroBuf, left: 0, top: 0 },
    { input: grain(PW - pHeroW, PH), raw: { width: PW - pHeroW, height: PH, channels: 4 }, left: pHeroW, top: 0 },
  ];
  for (const t of built.thumbs) {
    const row = rows.find((r) => r.slot === t.slot);
    const px = Math.round(t.size * scale);
    const layer = row && row.thumbLayers && row.thumbLayers[px];
    if (!layer) continue;
    layers.push({ input: layer.input, left: Math.round(t.x * scale) + layer.dx, top: Math.round(t.y * scale) + layer.dy, ...(layer.blend ? { blend: layer.blend } : {}) });
  }
  layers.push({ input: Buffer.from(built.svg), left: 0, top: 0 });
  const buffer = await sharp({ create: { width: PW, height: PH, channels: 3, background: PAPER } })
    .composite(layers)
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return { buffer, width: PW, height: PH, built, frame };
}

/**
 * The whole poster: master, feed and story.
 * `rows[i].thumb` is the product photo buffer; the cut-out is made once per
 * thumbnail size used.
 */
async function renderLookbookPoster({ hero, rows, anchors = {}, subject = null, body = null, scale = RENDER_SCALE }) {
  const sharp = require("sharp");
  if (!rows || !rows.length) throw new Error("renderLookbookPoster: no rows");
  const totalValue = rows.reduce((s, r) => s + r.price, 0);
  const total = { value: totalValue, text: formatRand(totalValue) };
  // Thumbnail layers in PIXELS (design size x scale), one per size used.
  const sizes = new Set([MASTER, FEED_LAYOUT].map((c) => Math.round(panelLayout(rows.length, c.h).thumb * scale)));
  const prepared = await Promise.all(rows.map(async (r) => {
    const thumbLayers = {};
    // One matte per product, shared by both canvases.
    const row = r.cutout !== undefined || !r.thumb ? r : { ...r, cutout: await cutout(r.thumb) };
    for (const size of sizes) thumbLayers[size] = await thumbLayer(row, size);
    return { ...row, thumbLayers };
  }));
  const master = await renderCanvas({ hero, rows: prepared, total, anchors, subject, body, W: MASTER.w, H: MASTER.h, scale });
  const feedNative = await renderCanvas({ hero, rows: prepared, total, anchors, subject, body, W: FEED_LAYOUT.w, H: FEED_LAYOUT.h, scale });
  const feed = await sharp(feedNative.buffer).resize(FEED.w, FEED.h, { kernel: "lanczos3" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
  const storyH = Math.round(MASTER.h * (STORY.w / MASTER.w));
  const padTop = Math.floor((STORY.h - storyH) / 2);
  const story = await sharp(master.buffer)
    .resize(STORY.w, storyH, { kernel: "lanczos3" })
    .extend({ top: padTop, bottom: STORY.h - storyH - padTop, left: 0, right: 0, background: PAPER })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
  return {
    master: { buffer: master.buffer, width: master.width, height: master.height },
    feed: { buffer: feed, width: FEED.w, height: FEED.h },
    story: { buffer: story, width: STORY.w, height: STORY.h },
    total,
    cutouts: Object.fromEntries(prepared.map((r) => [r.slot, Object.values(r.thumbLayers)[0]?.method || "none"])),
    markW: master.built.markW,
    // What the poster actually drew, for the gates and the report.
    heroScale: { master: master.frame.scale, feed: feedNative.frame.scale },
    leaders: { master: master.built.leaders, feed: feedNative.built.leaders },
    thumbBoxes: master.built.thumbs,
  };
}

module.exports = {
  renderLookbookPoster, buildPosterSvg, panelLayout, heroFrame, cutout, gridOverlay,
  planLeaders, segmentsCross, thumbFit, alphaTrim, THUMB_PAD,
  PAPER, HERO_FRAC, MASTER, FEED, FEED_LAYOUT, STORY, RENDER_SCALE,
};
