// ─── THE DESIGN LAYER: EVERY WORD AND NUMBER ON THE POST, DRAWN BY US ────────
// Pure string work. Takes the real product rows and the photograph's measured
// brightness, and returns an SVG to composite over the image. It never calls a
// model and never sees one's output.
//
// ── WHY TYPOGRAPHY IS NOT GENERATED ──────────────────────────────────────────
// Owner rule: "A model-drawn price is a number I have to honour and it has
// already garbled text once." Every string here comes from /products — `name`
// (the TRUE name, not the brand-stripped storefront title) and `retailPrice` —
// and the outfit TOTAL is summed in this file, in code, from those same
// numbers. The scene prompt separately forbids the model from rendering type at
// all, so the two halves cannot collide or contradict.
//
// ── WHY THERE ARE NO CONNECTOR LINES ─────────────────────────────────────────
// The master direction asks for thin lines linking a callout to its product,
// "intelligently routed so they don't unnecessarily cross other products".
// Routing a line to a product requires knowing where that product IS, and in a
// free composition — the model now chooses its own surface, angle and
// arrangement — nothing tells us. Guessing produces lines that point at empty
// concrete or across two other items, which is worse than no line at all.
//
// Owner ruling: "don't hold up the build for them... place the callouts in the
// negative space without connectors — my first two examples do exactly that and
// they look right." So callouts sit in a rail, and connectors wait for either a
// vision pass that locates each product or a composition we pin ourselves.
//
// ── WHAT THIS FILE DOES NOT DECIDE ───────────────────────────────────────────
// Not which products are in the picture (social-select), not whether they are
// live and in stock (social-select refuses otherwise), and not what the
// photograph looks like (the model, under DESIGN_RULE). It decides where type
// goes and renders it.
"use strict";

// ── THE TYPEFACE IS BUNDLED, NOT BORROWED ────────────────────────────────────
// The overlay is rendered by librsvg inside sharp, which resolves font families
// through fontconfig. Cloud Functions runs a minimal Linux image with no
// Helvetica and no Arial, and a family that is not present does not fail — it
// falls back silently to whatever survives in the base image. Every post would
// then come out in a typeface nobody chose, changing the moment the base image
// changes, with nothing to notice it by.
//
// So Archivo ships with the function (SIL OFL 1.1, in assets/fonts) and
// FONTCONFIG_PATH is pointed at it here, at module load, before sharp renders
// anything. Archivo is a grotesque drawn for editorial and print rather than
// for screens — closer to the Helvetica-family look of the reference layouts
// than a UI face like Inter, and it carries the wide letter-spaced caps the
// wordmark needs without going thin.
const path = require("path");
const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");
if (!process.env.FONTCONFIG_PATH) process.env.FONTCONFIG_PATH = FONT_DIR;

// One family, named explicitly. The fallbacks stay for a local machine that has
// them, but fonts.conf aliases them to Archivo anyway so the rendered result is
// the same everywhere.
const FONT = "Archivo, Helvetica Neue, Helvetica, Arial, sans-serif";

const W = 1080, H = 1350;

// ── THE TWO CANVASES ─────────────────────────────────────────────────────────
// A feed post is 4:5 and a story or a reel is 9:16. They are not the same
// design at different sizes: a story is held in one hand, read in about two
// seconds and has the top and bottom eighth covered by Instagram's own chrome —
// the avatar and progress bars above, the reply box below. Type placed there is
// type nobody sees.
//
// So the vertical layout is authored separately rather than scaled from the
// feed one. Everything ELSE is shared: the same prices from the same records,
// the same total summed the same way, the same typeface, the same refusal to
// print a price that is not in the catalogue.
//
// The vertical safe area is no longer just Instagram's story chrome (250/260):
// the same story picture is shown on the feed in a 4:5 frame, so every word of
// a vertical layout sits inside SAFE_BAND, y 345..1575. See verticalLayout.
const CANVAS = {
  feed:  { w: 1080, h: 1350, safeTop: 60,  safeBottom: 90 },
  story: { w: 1080, h: 1920, safeTop: 345, safeBottom: 345 },
  reel:  { w: 1080, h: 1920, safeTop: 345, safeBottom: 345 },
};
const FORMATS = Object.keys(CANVAS);
const canvasFor = (format) => CANVAS[format] || CANVAS.feed;
const isVertical = (format) => canvasFor(format).h > canvasFor(format).w * 1.5;

// Brands worth splitting onto their own line, longest first so "New Era" wins
// before "New". Presentational only — it changes line breaks, never the words.
const BRANDS = [
  "Nike x Stüssy", "Dolce & Gabbana", "Calvin Klein", "The North Face", "Under Armour",
  "Tommy Hilfiger", "New Balance", "Air Jordan", "New Era", "EA7", "Nike", "adidas",
  "Adidas", "Puma", "Jordan", "Converse", "Vans", "Reebok", "Fila", "Lacoste", "Stüssy",
  "Champion", "Carhartt", "Levi's", "Polo", "Diesel", "Replay", "Armani", "Creed",
  "Timberland", "Marathon Club",
];

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * "R1,899" — the ONLY place in this program where a price becomes text.
 * Returns null for anything that is not a usable price, so a missing price is
 * omitted rather than rendered as "R0" or "RNaN". The master direction is
 * explicit: "If a product has no listed price, omit it or flag it — never
 * invent one."
 */
function rand(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return "R" + Math.round(v).toLocaleString("en-ZA").replace(/ |\s/g, ",");
}

/** Split a true product name into a brand line and a descriptor line. */
function splitName(raw) {
  const name = String(raw || "").trim().replace(/\s+/g, " ");
  if (!name) return { brand: "", rest: "" };
  for (const b of BRANDS.slice().sort((a, z) => z.length - a.length)) {
    if (name.toLowerCase().startsWith(b.toLowerCase())) {
      const rest = name.slice(b.length).trim();
      return { brand: b.toUpperCase(), rest: rest.toUpperCase() };
    }
  }
  const i = name.indexOf(" ");
  return i === -1
    ? { brand: name.toUpperCase(), rest: "" }
    : { brand: name.slice(0, i).toUpperCase(), rest: name.slice(i + 1).toUpperCase() };
}

// ── A NAME IS MEASURED, NEVER COUNTED — AND NEVER CUT ────────────────────────
// This used to be `wrap(text, 26, 1)`: a CHARACTER count, and when the name ran
// past it the last character became "…". That shipped "NOCTA TRACKSUITS HOT
// CURR…" on a live advert — a product nobody can search for, on a post whose
// whole job is to name it.
//
// Widths now come from Archivo's own advance widths (archivo-metrics.json,
// generated from the bundled font by scripts/social/gen-archivo-metrics.cjs),
// at the weight actually drawn, plus librsvg's letter-spacing per glyph. A
// character the table does not know counts as the WIDEST glyph in the font, so
// an unknown character can only make the estimate too generous, never too tight.
// Kerning is ignored for the same reason: it only ever narrows a line.
const METRICS = require("./archivo-metrics.json");

function metricsFor(weight) {
  const have = Object.keys(METRICS.weights).map(Number);
  const w = Number(weight) || 400;
  const nearest = have.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
  return METRICS.weights[nearest];
}

/** Rendered width of one line of text, in canvas pixels. */
function textWidth(text, { size, weight = 400, letterSpacing = 0 }) {
  const table = metricsFor(weight);
  let units = 0, glyphs = 0;
  for (const ch of String(text == null ? "" : text)) {
    units += Object.prototype.hasOwnProperty.call(table.advance, ch) ? table.advance[ch] : table.fallback;
    glyphs++;
  }
  return (units * size) / METRICS.unitsPerEm + letterSpacing * glyphs;
}

/** Greedy word wrap by measured width; null when a single word is too wide. */
function wrapToWidth(words, maxWidth, style) {
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (textWidth(w, style) > maxWidth) return null;
    const next = cur ? `${cur} ${w}` : w;
    if (!cur || textWidth(next, style) <= maxWidth) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Break one over-long word into pieces that each fit — the last resort. */
function breakWord(word, maxWidth, style) {
  const out = [];
  let cur = "";
  for (const ch of word) {
    if (cur && textWidth(cur + ch, style) > maxWidth) { out.push(cur); cur = ch; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Fit a string into `maxWidth`: every word kept, nothing elided.
 *
 * In order of preference —
 *   1. one line, shrinking at most to 85% of `size` (a small shrink is invisible)
 *   2. up to `maxLines` lines, shrinking from `size` down to `minSize`
 *   3. at `minSize`, as many lines as it takes, breaking any single word that is
 *      wider than the whole column
 * Step 3 always succeeds, so the function always returns every character of the
 * input. The caller reserves vertical space from `lines.length`, so a third
 * line pushes the stack rather than overlapping it.
 *
 * @returns { lines: string[], size: number }
 */
function fitLines(text, { maxWidth, size, minSize = size * 0.6, weight = 400, letterSpacing = 0, maxLines = 2 }) {
  const words = String(text == null ? "" : text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [], size };
  // Letter-spacing is authored at the base size and scales with the type.
  const at = (s) => ({ size: s, weight, letterSpacing: letterSpacing * (s / size) });
  const STEP = 0.5;
  for (let s = size; s >= size * 0.85; s -= STEP) {
    const one = words.join(" ");
    if (textWidth(one, at(s)) <= maxWidth) return { lines: [one], size: s };
  }
  for (let s = size; s >= minSize; s -= STEP) {
    const lines = wrapToWidth(words, maxWidth, at(s));
    if (lines && lines.length <= maxLines) return { lines, size: s };
  }
  const style = at(minSize);
  const pieces = words.flatMap((w) => (textWidth(w, style) > maxWidth ? breakWord(w, maxWidth, style) : [w]));
  return { lines: wrapToWidth(pieces, maxWidth, style), size: minSize };
}

/**
 * Only products that can honestly be named and priced.
 *
 * The master direction: "Only products that are live and in stock get named,
 * priced or counted in the total." social-select has already refused anything
 * not live and not in stock, so what remains here is the price rule — a row
 * with no usable price is dropped rather than shown at zero, and therefore also
 * leaves the TOTAL, which must be the cost of what is actually named.
 */
function sellableRows(products = []) {
  return products
    .map((p) => ({ name: p.displayName || p.name, price: Number(p.retailPrice) }))
    .filter((p) => p.name && Number.isFinite(p.price) && p.price > 0);
}

/** The sum of what is NAMED. Never of what is merely in the picture. */
function outfitTotal(rows) {
  return rows.reduce((s, r) => s + r.price, 0);
}

/**
 * Which side the callout rail goes on, and what ink to use.
 *
 * The master direction forbids a fixed layout: "Do not automatically place the
 * logo in the top-left, the product list on the right... Study the composition
 * first." We cannot study it the way an art director does, but we can measure
 * it: `edges` carries the mean luminance of the left and right thirds and of
 * the top and bottom bands, sampled from the actual photograph.
 *
 * The rail goes on the side with the FLATTER, emptier tone — a low-variance
 * region is negative space, a busy one has product in it. Ink follows the
 * chosen side's brightness so type never sits dark-on-dark.
 */
function chooseLayout(edges = {}) {
  const L = edges.left || {}, R = edges.right || {};
  const lVar = Number.isFinite(L.stdev) ? L.stdev : 999;
  const rVar = Number.isFinite(R.stdev) ? R.stdev : 999;
  // A clear winner needs a real difference; otherwise prefer the right, which
  // is where a reader's eye lands last in a vertical crop.
  const side = Math.abs(lVar - rVar) < 3 ? "right" : (lVar < rVar ? "left" : "right");
  const col = side === "left" ? L : R;
  const dark = Number.isFinite(col.mean) ? col.mean < 128 : true;

  // ── WHERE IN THE COLUMN, NOT JUST WHICH COLUMN ─────────────────────────────
  // Measuring the column over its FULL height hides a product that intrudes
  // into part of it. That is not hypothetical: the first render put the WHOLE
  // OUTFIT block straight over a perfume box sitting low in an otherwise empty
  // left column — the column averaged flat, the bottom of it was not.
  //
  // So the column is measured in a top and a bottom half, and the stack starts
  // in the flatter one. Absent those numbers it starts high, which is the safer
  // default for a vertical crop.
  const top = col.top || {}, bottom = col.bottom || {};
  const tVar = Number.isFinite(top.stdev) ? top.stdev : null;
  const bVar = Number.isFinite(bottom.stdev) ? bottom.stdev : null;
  let anchor = "top";
  if (tVar !== null && bVar !== null && Math.abs(tVar - bVar) >= 3) {
    anchor = tVar < bVar ? "top" : "bottom";
  }
  return { side, anchor, ink: dark ? "#F4F1EA" : "#141414", scrim: dark ? "#000000" : "#FFFFFF" };
}

// ── ONE DESIGN, TWO RENDERS: THE SAFE BAND ───────────────────────────────────
// A story's picture also goes on the feed (social-twin.cjs), and the feed shows
// a 4:5 frame: 1080x1350, which is the central 1350 rows of a 1080x1920 story —
// 285 rows gone from the top and 285 from the bottom. The first vertical layout
// put the wordmark at y 266..296 and the website at y 1686..1738, so on the feed
// the MARATHON wordmark was sliced in half and the address was not there at all
// (the 4 Sep NIKE NOCTA post; measurements in docs/SOCIAL-SAFE-ZONE.md).
//
// So the layout is authored ONCE, in story coordinates, and every word of it
// lives inside SAFE_BAND — y 345..1575, the feed frame less a 60px margin. The
// story render draws it as it is; the feed render is the same elements shifted
// up by FEED_CROP_TOP over the same photograph's central rows. The outer bands
// of a story carry photograph (and the soft edge of a scrim) and never type, so
// even a story file posted to the feed by mistake keeps its wordmark whole.
//
// The band also survives the reel's Ken Burns move: reel.mjs zooms 8% about the
// centre, which carries y 345 to 296 and y 1575 to 1624 — still inside 285..1635.
const FEED_CROP_TOP = (1920 - 1350) / 2;                                   // 285
const SAFE_MARGIN = 60;
const SAFE_BAND = { top: FEED_CROP_TOP + SAFE_MARGIN, bottom: 1920 - FEED_CROP_TOP - SAFE_MARGIN }; // 345..1575
const V_X = 72;
const V_TEXT_W = 1080 - 2 * V_X;

// Where a line's pixels actually are, as a fraction of its size. Archivo's caps
// rise 0.686em and an accented capital (Ü, É) nearly 0.9em; nothing drawn here
// drops more than 0.21em below the baseline. Generous on both sides, because
// these turn a baseline into the box the band check is made against.
const ASCENT = 0.95;
const DESCENT = 0.25;

const V_STYLE = {
  wordmark:   { size: 40, weight: 700, letterSpacing: 9 },
  club:       { size: 21, weight: 400, letterSpacing: 14, opacity: 0.9 },
  brand:      { size: 21, weight: 700, letterSpacing: 3 },
  name:       { size: 19, weight: 400, letterSpacing: 2, opacity: 0.88 },
  price:      { size: 27, weight: 600, letterSpacing: 0 },
  totalLabel: { size: 18, weight: 700, letterSpacing: 5 },
  total:      { size: 60, weight: 700, letterSpacing: -0.5 },
  cta:        { size: 21, weight: 700, letterSpacing: 4 },
  url:        { size: 19, weight: 400, letterSpacing: 3, opacity: 0.92 },
};

const scaled = (style, s) => ({ ...style, size: style.size * s, letterSpacing: style.letterSpacing * s });

/** The callout stack at scale `s`, with y measured from the stack's own top. */
function verticalStack(rows, kind, s) {
  const texts = [];
  const rules = [];
  let cursor = 0;   // top of the next line's box
  const line = (role, text, style, lineHeight) => {
    texts.push({ role, text, x: V_X, y: cursor + style.size * ASCENT, ...style });
    cursor += style.size * lineHeight;
  };
  const fitted = (role, text, base, { maxLines, minScale, lineHeight }) => {
    const f = fitLines(text, { maxWidth: V_TEXT_W, ...base, minSize: base.size * minScale, maxLines });
    const style = { ...base, size: f.size, letterSpacing: base.letterSpacing * (f.size / base.size) };
    for (const ln of f.lines) line(role, ln, style, lineHeight);
  };

  rows.forEach((r, i) => {
    if (i) cursor += 30 * s;
    const { brand, rest } = splitName(r.name);
    if (brand) fitted("brand", brand, scaled(V_STYLE.brand, s), { maxLines: 1, minScale: 0.7, lineHeight: 1.3 });
    if (rest) fitted("name", rest, scaled(V_STYLE.name, s), { maxLines: 2, minScale: 0.7, lineHeight: 1.35 });
    cursor += 8 * s;
    line("price", rand(r.price), scaled(V_STYLE.price, s), 1.2);
  });
  if (kind === "outfit" && rows.length > 1) {
    cursor += 34 * s;
    rules.push({ x1: V_X, x2: V_X + 300, y: cursor - 14 * s });
    line("total", "WHOLE OUTFIT", scaled(V_STYLE.totalLabel, s), 1.5);
    line("total", rand(outfitTotal(rows)), scaled(V_STYLE.total, s), 1.1);
  }
  const height = texts.reduce((m, t) => Math.max(m, t.y + t.size * DESCENT), 0);
  return { texts, rules, height };
}

/**
 * The vertical layout as data: every text element with its role, position and
 * style, in 1080x1920 story coordinates. Pure. Throws if anything it placed
 * would fall outside SAFE_BAND or past the column — which fitLines and the
 * scaling below make unreachable, and which is checked anyway, because "it
 * cannot happen" is what the 26-character wrap looked like too.
 */
function verticalLayout({ products = [], kind = "single", storefront = "MARATHONCLUB.CO.ZA" } = {}) {
  const rows = sellableRows(products);
  const texts = [];
  const at = (role, text, y, style) => texts.push({ role, text, x: V_X, y, ...style });

  // The wordmark, once, at the top of the band.
  const wmY = SAFE_BAND.top + Math.ceil(V_STYLE.wordmark.size * ASCENT);
  at("wordmark", "MARATHON", wmY, V_STYLE.wordmark);
  const clubY = wmY + 36;
  at("wordmark", "CLUB", clubY, V_STYLE.club);
  const headBottom = clubY + V_STYLE.club.size * DESCENT;

  // No link sticker is possible (the Content Publishing API cannot attach
  // one), so the address is the route to the shop. At the foot of the band.
  const urlY = SAFE_BAND.bottom - Math.ceil(V_STYLE.url.size * DESCENT);
  const ctaY = urlY - 36;
  const footTop = ctaY - V_STYLE.cta.size * ASCENT;

  // The callouts sit low, where a thumb is, just above the address. A long
  // flat-lay is scaled down as a block rather than allowed to climb into the
  // wordmark.
  const GAP = 80;
  const room = (footTop - GAP) - (headBottom + GAP);
  let stack = verticalStack(rows, kind, 1);
  for (let s = 0.95; stack.height > room && s >= 0.5; s -= 0.05) stack = verticalStack(rows, kind, s);
  const stackTop = Math.max(headBottom + GAP, footTop - GAP - stack.height);
  for (const t of stack.texts) texts.push({ ...t, y: t.y + stackTop });
  const rules = stack.rules.map((r) => ({ ...r, y: r.y + stackTop }));

  at("cta", "SHOP IT ONLINE", ctaY, V_STYLE.cta);
  at("url", String(storefront || ""), urlY, V_STYLE.url);

  const layout = {
    band: { ...SAFE_BAND },
    texts,
    rules,
    scrims: { topEnd: headBottom + 160, footStart: stackTop - 120 },
    stack: { top: stackTop, bottom: stackTop + stack.height, footTop, headBottom },
  };
  assertLayoutFits(layout);
  return layout;
}

/** The pixel box one text element occupies, from its measured width. */
function textBox(t) {
  const w = textWidth(t.text, t);
  return { x0: t.x, x1: t.x + w, y0: t.y - t.size * ASCENT, y1: t.y + t.size * DESCENT };
}

function assertLayoutFits(layout) {
  const { band, texts, stack } = layout;
  for (const t of texts) {
    const b = textBox(t);
    if (b.y0 < band.top || b.y1 > band.bottom) {
      throw new Error(`social-design: "${t.text}" (${t.role}) spans y ${b.y0.toFixed(1)}..${b.y1.toFixed(1)}, outside the safe band ${band.top}..${band.bottom}`);
    }
    if (b.x0 < V_X || b.x1 > V_X + V_TEXT_W) {
      throw new Error(`social-design: "${t.text}" (${t.role}) is ${Math.ceil(b.x1 - b.x0)}px wide; the column is ${V_TEXT_W}px`);
    }
  }
  if (stack && (stack.top < stack.headBottom || stack.bottom > stack.footTop)) {
    throw new Error("social-design: the callouts do not fit between the wordmark and the address");
  }
}

/**
 * Draw a vertical layout. `surface` is "story" (1080x1920) or "feed" (1080x1350,
 * the same design moved up by FEED_CROP_TOP). `layers` exists for the proof in
 * scripts/social/proof-safe-zone.mjs: "scrim" draws only the shading, so the
 * pixels type adds on top can be isolated by difference.
 */
function renderVerticalSvg(layout, { surface = "story", width, height, ink, scrim, layers = "all" } = {}) {
  const feed = surface === "feed";
  const vbH = feed ? 1350 : 1920;
  const outW = width || 1080, outH = height || vbH;
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(outW)}" height="${Math.round(outH)}" viewBox="0 0 1080 ${vbH}" preserveAspectRatio="xMidYMid slice">`);
  o.push(`<defs>
    <linearGradient id="vfoot" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="${scrim}" stop-opacity="0.86"/>
      <stop offset="0.55" stop-color="${scrim}" stop-opacity="0.45"/>
      <stop offset="1" stop-color="${scrim}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="vtop" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${scrim}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${scrim}" stop-opacity="0"/>
    </linearGradient>
  </defs>`);
  o.push(`<g transform="translate(0 ${feed ? -FEED_CROP_TOP : 0})">`);
  if (layers !== "text") {
    const { topEnd, footStart } = layout.scrims;
    o.push(`<rect x="0" y="0" width="1080" height="${topEnd.toFixed(1)}" fill="url(#vtop)"/>`);
    o.push(`<rect x="0" y="${footStart.toFixed(1)}" width="1080" height="${(1920 - footStart).toFixed(1)}" fill="url(#vfoot)"/>`);
  }
  if (layers !== "scrim") {
    for (const r of layout.rules) {
      o.push(`<line data-role="total" x1="${r.x1}" y1="${r.y.toFixed(1)}" x2="${r.x2}" y2="${r.y.toFixed(1)}" stroke="${ink}" stroke-width="1" opacity="0.4"/>`);
    }
    for (const t of layout.texts) {
      const op = t.opacity != null ? ` opacity="${t.opacity}"` : "";
      o.push(`<text data-role="${t.role}" x="${t.x}" y="${t.y.toFixed(1)}" font-family="${FONT}" font-weight="${t.weight}" font-size="${+t.size.toFixed(2)}" fill="${ink}" letter-spacing="${+t.letterSpacing.toFixed(2)}"${op}>${esc(t.text)}</text>`);
    }
  }
  o.push(`</g>`);
  o.push(`</svg>`);
  return o.join("\n");
}

/**
 * The vertical layout, for a story or a reel.
 *
 * Different from the feed card by intent, not by scale:
 *   · everything lives inside SAFE_BAND, which clears Instagram's story chrome
 *     AND the 4:5 frame the same picture is shown in on the feed
 *   · the callouts sit low, where a thumb is, and are bigger — a story is read
 *     in about two seconds at arm's length
 *   · the website is composited ON THE ARTWORK, because the Content Publishing
 *     API cannot attach a link sticker
 *
 * `surface: "feed"` renders the SAME layout for the 1080x1350 feed file.
 */
function buildVerticalOverlay({ products, edges = {}, kind, storefront, width, height, surface = "story", layers = "all" }) {
  // ── INK FOLLOWS THE REGION THE WORDS ARE IN ────────────────────────────────
  // The callouts sit low and left, so the brightness that matters is the lower
  // left. The first vertical render put near-black type on black denim because
  // the whole-column average was bright enough. Measured once, on the story
  // photograph, and used for both renders — they are one design.
  const lower = (edges.left && edges.left.bottom) || edges.left || {};
  const darkThere = Number.isFinite(lower.mean) ? lower.mean < 140 : true;
  const ink = darkThere ? "#F4F1EA" : "#141414";
  const scrim = darkThere ? "#000000" : "#FFFFFF";
  const layout = verticalLayout({ products, kind, storefront });
  return renderVerticalSvg(layout, { surface, width, height, ink, scrim, layers });
}

/**
 * Build the overlay SVG.
 *
 * @param products [{ displayName|name, retailPrice }] from the post record
 * @param edges    measured luminance, from measureEdges() in social-render.cjs
 * @param kind     post kind; only "outfit" gets a WHOLE OUTFIT total
 */
function buildOverlay({ products = [], edges = {}, kind = "single", storefront = "MARATHONCLUB.CO.ZA", width, height, format = "feed", surface = "story", layers = "all" } = {}) {
  if (isVertical(format)) {
    return buildVerticalOverlay({ products, edges, kind, storefront, width, height, surface, layers });
  }
  width = width || W;
  height = height || H;
  const rows = sellableRows(products);
  const { side, anchor, ink, scrim } = chooseLayout(edges);
  const DISPLAY = FONT;
  const TEXT = FONT;
  const o = [];
  // ── THE OVERLAY IS THE SIZE OF THE PHOTOGRAPH, NOT A CONSTANT ─────────────
  // normalizeSocialImage resizes with fit:"inside" and withoutEnlargement, so
  // the finished photograph is frequently SMALLER than 1080x1350 — 1080x1341 is
  // typical, nine pixels short. sharp refuses to composite an overlay larger
  // than its base ("Image to composite must have same dimensions or smaller"),
  // so a fixed-size overlay failed on every real generation while passing every
  // local test, which rendered at exactly 1080x1350.
  //
  // The design is still AUTHORED at 1080x1350 — every coordinate below assumes
  // it — and the viewBox scales it to whatever the photograph turned out to be.
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">`);

  // A scrim only under the rail and the foot, at low opacity — enough to hold
  // type, never enough to read as a panel. "Avoid ... unnecessary borders."
  const railW = 372;
  const railX = side === "left" ? 0 : W - railW;
  o.push(`<defs>
    <linearGradient id="rail" x1="${side === "left" ? 0 : 1}" y1="0" x2="${side === "left" ? 1 : 0}" y2="0">
      <stop offset="0" stop-color="${scrim}" stop-opacity="0.5"/>
      <stop offset="1" stop-color="${scrim}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="foot" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="${scrim}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${scrim}" stop-opacity="0"/>
    </linearGradient>
  </defs>`);
  o.push(`<rect x="${railX}" y="0" width="${railW}" height="${H}" fill="url(#rail)"/>`);
  o.push(`<rect x="0" y="${H - 260}" width="${W}" height="260" fill="url(#foot)"/>`);

  // ── The lockup. Restrained, once, never repeated. ──────────────────────────
  const x = side === "left" ? 56 : W - railW + 40;
  o.push(`<text x="${x}" y="88" font-family="${DISPLAY}" font-weight="700" font-size="34" fill="${ink}" letter-spacing="7">MARATHON</text>`);
  o.push(`<text x="${x}" y="118" font-family="${DISPLAY}" font-weight="400" font-size="18" fill="${ink}" letter-spacing="12" opacity="0.9">CLUB</text>`);

  // ── Callouts, in the negative space, no connectors. ────────────────────────
  // Height the stack will occupy, so a bottom anchor can be placed rather than
  // guessed: each callout is roughly 120px, plus the total block when shown.
  const stackH = rows.length * 120 + ((kind === "outfit" && rows.length > 1) ? 110 : 0);
  let y = anchor === "bottom" ? Math.max(250, H - 210 - stackH) : 250;
  for (const r of rows) {
    const { brand, rest } = splitName(r.name);
    o.push(`<line x1="${x}" y1="${y - 26}" x2="${x + 34}" y2="${y - 26}" stroke="${ink}" stroke-width="1.4" opacity="0.75"/>`);
    // Measured into the rail, never cut: see fitLines.
    const RAIL_TEXT_W = 300;
    const bf = fitLines(brand, { maxWidth: RAIL_TEXT_W, size: 17, minSize: 12, weight: 700, letterSpacing: 2.6, maxLines: 1 });
    let dy = -21;
    for (const ln of bf.lines) {
      dy += 21;
      o.push(`<text data-role="brand" x="${x}" y="${y + dy}" font-family="${TEXT}" font-weight="700" font-size="${bf.size}" fill="${ink}" letter-spacing="${+(2.6 * bf.size / 17).toFixed(2)}">${esc(ln)}</text>`);
    }
    const nf = fitLines(rest, { maxWidth: RAIL_TEXT_W, size: 15.5, minSize: 11, weight: 400, letterSpacing: 1.7, maxLines: 2 });
    for (const ln of nf.lines) {
      dy += 21;
      o.push(`<text data-role="name" x="${x}" y="${y + dy}" font-family="${TEXT}" font-weight="400" font-size="${nf.size}" fill="${ink}" letter-spacing="${+(1.7 * nf.size / 15.5).toFixed(2)}" opacity="0.88">${esc(ln)}</text>`);
    }
    dy = Math.max(dy, 0);
    // Price: information, "visually secondary to the photograph", never boxed.
    o.push(`<text x="${x}" y="${y + dy + 30}" font-family="${DISPLAY}" font-weight="600" font-size="22" fill="${ink}" letter-spacing="0.8">${esc(rand(r.price))}</text>`);
    y += dy + 78;
  }

  // ── The whole look. More prominent, still restrained, never a discount. ────
  if (kind === "outfit" && rows.length > 1) {
    const total = rand(outfitTotal(rows));
    o.push(`<line x1="${x}" y1="${y - 22}" x2="${x + 250}" y2="${y - 22}" stroke="${ink}" stroke-width="1" opacity="0.4"/>`);
    o.push(`<text x="${x}" y="${y + 6}" font-family="${TEXT}" font-weight="700" font-size="15" fill="${ink}" letter-spacing="4">WHOLE OUTFIT</text>`);
    o.push(`<text x="${x}" y="${y + 56}" font-family="${DISPLAY}" font-weight="700" font-size="46" fill="${ink}" letter-spacing="-0.5">${esc(total)}</text>`);
    y += 96;
  }

  // ── Where to buy it. A direction, not a button. ────────────────────────────
  // The wording follows what is actually shown. "SHOP THE WHOLE OUTFIT" on a
  // post of one pair of jeans is a small lie, and it is the kind that makes a
  // reader trust the rest of the layout less.
  const cta = (kind === "outfit" && rows.length > 1) ? "SHOP THE WHOLE OUTFIT  →"
            : rows.length > 1 ? "SHOP THESE  →"
            : "SHOP IT ONLINE  →";
  o.push(`<text x="56" y="${H - 96}" font-family="${TEXT}" font-weight="700" font-size="16" fill="${ink}" letter-spacing="3.4">${esc(cta)}</text>`);
  o.push(`<text x="56" y="${H - 64}" font-family="${TEXT}" font-weight="400" font-size="14" fill="${ink}" letter-spacing="2.6" opacity="0.85">${esc(storefront)}</text>`);
  o.push(`</svg>`);
  return o.join("\n");
}

module.exports = {
  buildOverlay, buildVerticalOverlay, verticalLayout, renderVerticalSvg, textBox,
  CANVAS, FORMATS, canvasFor, isVertical, FONT, FONT_DIR, chooseLayout, sellableRows, outfitTotal,
  splitName, rand, fitLines, textWidth, SAFE_BAND, FEED_CROP_TOP, ASCENT, DESCENT, W, H,
};
