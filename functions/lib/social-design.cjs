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
const CANVAS = {
  feed:  { w: 1080, h: 1350, safeTop: 60,  safeBottom: 90 },
  story: { w: 1080, h: 1920, safeTop: 250, safeBottom: 260 },
  reel:  { w: 1080, h: 1920, safeTop: 250, safeBottom: 320 },
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

/** Wrap to at most `max` chars per line and at most `lines` lines. */
function wrap(text, max, lines = 2) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const out = [];
  let cur = "";
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + " " + w).length <= max) cur += " " + w;
    else { out.push(cur); cur = w; if (out.length === lines) break; }
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length === lines && words.join(" ").length > out.join(" ").length) {
    out[lines - 1] = out[lines - 1].replace(/.{0,1}$/, "…");
  }
  return out.slice(0, lines);
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

/**
 * Build the overlay SVG.
 *
 * @param products [{ displayName|name, retailPrice }] from the post record
 * @param edges    measured luminance, from measureEdges() in index.js
 * @param kind     post kind; only "outfit" gets a WHOLE OUTFIT total
 */
/**
 * The vertical layout, for a story or a reel.
 *
 * Different from the feed card by intent, not by scale:
 *   · everything lives INSIDE the safe area, because Instagram's chrome covers
 *     the top and bottom of a story and anything under it is invisible
 *   · the callouts sit low, where a thumb is, and are bigger — a story is read
 *     in about two seconds at arm's length
 *   · the website is composited ON THE ARTWORK. The Content Publishing API
 *     cannot attach a link sticker (Meta's docs are explicit that publishing
 *     stickers is unsupported), so the URL has to be readable or the story has
 *     no route to the shop at all.
 */
function buildVerticalOverlay({ products, edges, kind, storefront, format, width, height }) {
  const { w, h, safeTop, safeBottom } = canvasFor(format);
  const rows = sellableRows(products);

  // ── MEASURE WHERE THE TYPE ACTUALLY GOES ───────────────────────────────────
  // chooseLayout() answers a question about the FEED card: which SIDE has the
  // negative space. In the vertical layout the answer is already decided — the
  // callouts sit low and left, over the bottom of the photograph — so the side
  // it picks is irrelevant and the brightness it reports is measured somewhere
  // the type will never be.
  //
  // That is not academic. The first vertical render put near-black callouts on
  // black denim and dark shoes, because the whole-column average was bright
  // enough to choose dark ink while the lower left was not. Ink follows the
  // region the words are in.
  const lower = (edges.left && edges.left.bottom) || edges.left || {};
  const darkThere = Number.isFinite(lower.mean) ? lower.mean < 140 : true;
  const ink = darkThere ? "#F4F1EA" : "#141414";
  const scrim = darkThere ? "#000000" : "#FFFFFF";
  const o = [];
  // ── THE OVERLAY IS THE SIZE OF THE PHOTOGRAPH, NOT A CONSTANT ─────────────
  // Same fix as the feed path below: normalizeSocialImage resizes with
  // fit:"inside" and withoutEnlargement, so the finished photograph is
  // frequently a few pixels short of the nominal 1080x1920 and sharp refuses
  // to composite an overlay larger than its base. The design stays AUTHORED
  // at the nominal canvas — every coordinate above and below assumes it — and
  // the viewBox scales it to whatever the photograph turned out to be.
  const outW = width || w, outH = height || h;
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(outW)}" height="${Math.round(outH)}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">`);
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
  const x = 72;
  const stackH = rows.length * 104 + (rows.length > 1 ? 150 : 60);
  const footTop = Math.max(safeTop + 200, h - safeBottom - stackH);
  o.push(`<rect x="0" y="0" width="${w}" height="${safeTop + 160}" fill="url(#vtop)"/>`);
  o.push(`<rect x="0" y="${footTop - 120}" width="${w}" height="${h - footTop + 120}" fill="url(#vfoot)"/>`);

  // The wordmark, once, inside the safe area.
  o.push(`<text x="${x}" y="${safeTop + 46}" font-family="${FONT}" font-weight="700" font-size="40" fill="${ink}" letter-spacing="9">MARATHON</text>`);
  o.push(`<text x="${x}" y="${safeTop + 82}" font-family="${FONT}" font-weight="400" font-size="21" fill="${ink}" letter-spacing="14" opacity="0.9">CLUB</text>`);

  let y = footTop;
  for (const r of rows) {
    const { brand, rest } = splitName(r.name);
    o.push(`<text x="${x}" y="${y}" font-family="${FONT}" font-weight="700" font-size="21" fill="${ink}" letter-spacing="3">${esc(wrap(brand, 24, 1)[0] || "")}</text>`);
    const d = wrap(rest, 26, 1);
    if (d[0]) o.push(`<text x="${x}" y="${y + 27}" font-family="${FONT}" font-weight="400" font-size="19" fill="${ink}" letter-spacing="2" opacity="0.88">${esc(d[0])}</text>`);
    o.push(`<text x="${x}" y="${y + 66}" font-family="${FONT}" font-weight="600" font-size="27" fill="${ink}">${esc(rand(r.price))}</text>`);
    y += 104;
  }
  if (kind === "outfit" && rows.length > 1) {
    o.push(`<line x1="${x}" y1="${y - 24}" x2="${x + 300}" y2="${y - 24}" stroke="${ink}" stroke-width="1" opacity="0.4"/>`);
    o.push(`<text x="${x}" y="${y + 12}" font-family="${FONT}" font-weight="700" font-size="18" fill="${ink}" letter-spacing="5">WHOLE OUTFIT</text>`);
    o.push(`<text x="${x}" y="${y + 74}" font-family="${FONT}" font-weight="700" font-size="60" fill="${ink}" letter-spacing="-0.5">${esc(rand(outfitTotal(rows)))}</text>`);
    y += 108;
  }
  // No link sticker is possible, so the address is the route. It has to be
  // legible rather than tasteful-and-unreadable.
  o.push(`<text x="${x}" y="${h - safeBottom + 42}" font-family="${FONT}" font-weight="700" font-size="21" fill="${ink}" letter-spacing="4">SHOP IT ONLINE</text>`);
  o.push(`<text x="${x}" y="${h - safeBottom + 78}" font-family="${FONT}" font-weight="400" font-size="19" fill="${ink}" letter-spacing="3" opacity="0.92">${esc(storefront)}</text>`);
  o.push(`</svg>`);
  return o.join("\n");
}

function buildOverlay({ products = [], edges = {}, kind = "single", storefront = "MARATHONCLUB.CO.ZA", width, height, format = "feed" } = {}) {
  if (isVertical(format)) {
    return buildVerticalOverlay({ products, edges, kind, storefront, format, width, height });
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
    o.push(`<text x="${x}" y="${y}" font-family="${TEXT}" font-weight="700" font-size="17" fill="${ink}" letter-spacing="2.6">${esc(wrap(brand, 22, 1)[0] || "")}</text>`);
    let dy = 0;
    for (const ln of wrap(rest, 24, 2)) {
      dy += 21;
      o.push(`<text x="${x}" y="${y + dy}" font-family="${TEXT}" font-weight="400" font-size="15.5" fill="${ink}" letter-spacing="1.7" opacity="0.88">${esc(ln)}</text>`);
    }
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

module.exports = { buildOverlay, buildVerticalOverlay, CANVAS, FORMATS, canvasFor, isVertical, FONT, FONT_DIR, chooseLayout, sellableRows, outfitTotal, splitName, rand, wrap, W, H };
