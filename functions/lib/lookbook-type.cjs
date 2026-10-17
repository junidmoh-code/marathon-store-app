// ─── LOOKBOOK TYPE, SET AS GLYPH OUTLINES ────────────────────────────────────
// Every word on the poster is drawn as an SVG <path> made from the bundled
// font's own outlines (fontkit), not as an SVG <text> left for the rasteriser
// to resolve.
//
// Why: sharp's librsvg resolves <text> through pango, and pango picks its
// font backend per platform. On Linux (Cloud Functions) that is fontconfig and
// the bundled fonts are found (social-design.cjs relies on it). On macOS it is
// CoreText, which ignores FONTCONFIG_PATH entirely, so the Mac mini and every
// local proof render silently set the poster in Helvetica. A layout checked
// on one machine and shipped from another is not checked. Outlines are the
// same bytes everywhere, and the widths used to lay a line out are the widths
// drawn.
//
// The faces (all SIL OFL 1.1, in functions/assets/fonts):
//   Anton            the MARATHON wordmark and the TOTAL numerals
//   Archivo          everything else (variable: weight 400–900)
//   Playfair Display the serif M on the badge and the left edge
"use strict";

const path = require("path");
const fontkit = require("fontkit");

const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");
const FILES = {
  anton: "Anton-Regular.ttf",
  archivo: "Archivo.ttf",
  playfair: "PlayfairDisplay.ttf",
};

const cache = new Map();
/** A fontkit font, with a variable face pinned to `weight` where it has one. */
function face(name, weight) {
  const key = `${name}:${weight || ""}`;
  if (cache.has(key)) return cache.get(key);
  const base = fontkit.openSync(path.join(FONT_DIR, FILES[name]));
  const f = weight && base.variationAxes && base.variationAxes.wght
    ? base.getVariation({ wght: weight, ...(base.variationAxes.wdth ? { wdth: 100 } : {}) })
    : base;
  cache.set(key, f);
  return f;
}

/** Laid-out glyphs for one line: kerning on, letter-spacing added per glyph. */
function layout(text, { font = "archivo", weight, size, letterSpacing = 0 }) {
  const f = face(font, weight);
  const run = f.layout(String(text == null ? "" : text));
  const s = size / f.unitsPerEm;
  const glyphs = [];
  let x = 0;
  run.glyphs.forEach((g, i) => {
    const p = run.positions[i];
    glyphs.push({ glyph: g, x: x + p.xOffset * s, y: -p.yOffset * s });
    x += p.xAdvance * s + letterSpacing;
  });
  // Trailing letter-spacing is not part of the visible line.
  const width = Math.max(0, x - (glyphs.length ? letterSpacing : 0));
  return { glyphs, width, scale: s, face: f };
}

/** The drawn width of a line, in px. */
function measure(text, opts) {
  return layout(text, opts).width;
}

/** Cap height of a face at `size`, in px. */
function capHeight(font, size, weight) {
  const f = face(font, weight);
  return (f.capHeight / f.unitsPerEm) * size;
}

/**
 * One line as an SVG path. (x, y) is the BASELINE; `anchor` is start, middle
 * or end, the same meanings as SVG text-anchor.
 */
function textPath(text, { x = 0, y = 0, anchor = "start", fill = "#fff", opacity = 1, ...opts }) {
  const { glyphs, width, scale } = layout(text, opts);
  const x0 = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
  let d = "";
  for (const g of glyphs) {
    const p = g.glyph.path.scale(scale, -scale).translate(x0 + g.x, y + g.y);
    d += p.toSVG();
  }
  if (!d) return { svg: "", width };
  const op = opacity < 1 ? ` fill-opacity="${opacity}"` : "";
  return { svg: `<path d="${d}" fill="${fill}"${op}/>`, width };
}

/**
 * Greedy word wrap by measured width, then step the size down until it fits in
 * `maxLines`. A single word wider than the box is set at the minimum size and
 * allowed to run long rather than being cut. A name is never truncated
 * (the rule social-design.cjs learnt from "NOCTA TRACKSUITS HOT CURR…").
 */
function wrap(text, { maxWidth, size, minSize = size * 0.7, maxLines = 2, ...opts }) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [], size };
  for (let s = size; s >= minSize - 1e-9; s -= 0.5) {
    const lines = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (!cur || measure(next, { ...opts, size: s }) <= maxWidth) cur = next;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length <= maxLines && lines.every((l) => measure(l, { ...opts, size: s }) <= maxWidth)) return { lines, size: s };
  }
  // Too long at the floor: keep every word, over as many lines as it takes.
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || measure(next, { ...opts, size: minSize }) <= maxWidth) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return { lines, size: minSize };
}

/** The size at which `text` is exactly `width` wide (single line). */
function sizeForWidth(text, width, opts) {
  const at100 = measure(text, { ...opts, size: 100, letterSpacing: 0 });
  const glyphs = [...String(text)].length;
  const ls = opts.letterSpacing || 0;
  return at100 > 0 ? ((width - ls * Math.max(0, glyphs - 1)) / at100) * 100 : opts.size || 12;
}

module.exports = { face, layout, measure, capHeight, textPath, wrap, sizeForWidth, FONT_DIR };
