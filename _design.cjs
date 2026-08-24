// ─── THE DESIGN LAYER: EVERY WORD ON THE POST, DRAWN BY US ───────────────────
// PROTOTYPE. Pure string work: takes the real product rows and returns an SVG
// to composite over the photograph. It never calls a model and never sees one's
// output, which is the entire point.
//
// ── WHY TYPOGRAPHY IS NOT GENERATED ──────────────────────────────────────────
// The image model garbles lettering and would invent prices. A wrong price on a
// public post is a promise the shop has to honour, so no number on the image may
// ever originate from a model. Every string below comes from /products/{pid} —
// `name` and `retailPrice` — and the TOTAL is summed here, in code, from those
// same numbers. The scene prompt separately forbids the model from rendering any
// text at all, so the two halves cannot collide.
//
// ── WHY THE TRUE NAME, NOT THE STOREFRONT NAME ───────────────────────────────
// social-select.cjs deliberately uses `shopify_publish/{pid}/cleanName` — the
// brand-stripped title — because that is what the payment gateway scans on the
// Shopify catalogue. That constraint does not reach Instagram. On the image and
// in the caption we use the TRUE `products/{pid}/name`, while the link and
// handle stay derived from cleanName so the storefront URL is unchanged.
"use strict";

const W = 1080, H = 1350;

// Slot → where that item sits on a full-body standing model, as a fraction of
// the frame. A leader line is drawn from the rail to this point.
//
// These are ANCHORS, not detections. The scene prompt pins the composition
// (one model, head-to-toe, centred, head near the top, shoes near the bottom),
// which makes a slot's vertical position predictable within a few percent —
// close enough for a line that only has to land on the garment. Nothing here
// depends on the model reporting where it drew anything, because it cannot be
// trusted to.
const SLOT_ANCHOR = {
  headwear: { x: 0.50, y: 0.115 },
  cap:      { x: 0.50, y: 0.115 },
  top:      { x: 0.46, y: 0.340 },
  outerwear:{ x: 0.42, y: 0.330 },
  bottom:   { x: 0.48, y: 0.590 },
  bag:      { x: 0.36, y: 0.700 },
  fragrance:{ x: 0.55, y: 0.520 },
  accessory:{ x: 0.55, y: 0.540 },
  shoe:     { x: 0.50, y: 0.880 },
};
const SLOT_ORDER = ["headwear", "cap", "outerwear", "top", "bottom", "bag", "accessory", "fragrance", "shoe"];

// Brands worth splitting onto their own line, longest-first so "New Era" wins
// before "New". Presentational only — it changes line breaks, never the words.
const BRANDS = [
  "Nike x Stüssy", "New Era", "Air Jordan", "Nike", "adidas", "Adidas", "Puma", "Jordan",
  "Converse", "Vans", "Reebok", "Fila", "Lacoste", "Stüssy", "Champion", "Under Armour",
  "The North Face", "Carhartt", "Levi's", "Polo", "Tommy Hilfiger", "Marathon Club",
];

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** "R2,180" — the only place a price becomes text. */
function rand(n) {
  const v = Math.round(Number(n) || 0);
  return "R" + v.toLocaleString("en-ZA").replace(/ /g, ",");
}

/** Split a true product name into a brand line and a descriptor line. */
function splitName(raw) {
  const name = String(raw || "").trim().replace(/\s+/g, " ");
  for (const b of BRANDS.slice().sort((a, z) => z.length - a.length)) {
    if (name.toLowerCase().startsWith(b.toLowerCase())) {
      const rest = name.slice(b.length).trim();
      return { brand: b.toUpperCase(), rest: (rest || b).toUpperCase() };
    }
  }
  const i = name.indexOf(" ");
  return i === -1
    ? { brand: name.toUpperCase(), rest: "" }
    : { brand: name.slice(0, i).toUpperCase(), rest: name.slice(i + 1).toUpperCase() };
}

/** Wrap to at most `max` chars per line, at most `lines` lines, ellipsis if over. */
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
    out[lines - 1] = out[lines - 1].replace(/.{0,2}$/, "…");
  }
  return out.slice(0, lines);
}

// The laurel-M monogram, drawn as paths so it needs no font and no asset.
function monogram(cx, cy, r, colour) {
  const leaves = [];
  for (let side of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const t = 0.18 + i * 0.108;
      const a = Math.PI * (0.5 + side * t);
      const px = cx + Math.cos(a) * r * 0.82;
      const py = cy - Math.sin(a) * r * 0.82 + r * 0.10;
      const rot = (side * (t * 150 + 20));
      leaves.push(`<ellipse cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" rx="${(r*0.20).toFixed(1)}" ry="${(r*0.085).toFixed(1)}" fill="${colour}" opacity="0.92" transform="rotate(${rot.toFixed(1)} ${px.toFixed(1)} ${py.toFixed(1)})"/>`);
    }
  }
  return `<g>${leaves.join("")}<text x="${cx}" y="${cy + r * 0.30}" font-family="Avenir Next Condensed, Helvetica Neue, Arial" font-weight="800" font-size="${(r * 1.15).toFixed(0)}" fill="${colour}" text-anchor="middle">M</text></g>`;
}

/**
 * Build the overlay SVG.
 *
 * @param items   [{ slot, name, price }] — name is the TRUE product name
 * @param layout  "rail"  — left-hand list, hairline rules, no leader lines
 *                "lines" — right-hand rail with leader lines and a TOTAL block
 * @param theme   "light" (dark type on a light photo) | "dark" (cream on dark)
 */
function buildOverlay({ items = [], layout = "lines", theme = "dark", storefront = "MARATHONCLUB.CO.ZA", showTotal = true } = {}) {
  const ink   = theme === "dark" ? "#F2EFE6" : "#141414";
  const chip  = theme === "dark" ? "#0D0D0D" : "#141414";
  const chipT = "#F2EFE6";
  const DISPLAY = "Avenir Next Condensed, DIN Condensed, Impact, Helvetica Neue, Arial";
  const TEXT    = "Helvetica Neue, Helvetica, Arial";

  const rows = items
    .slice()
    .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
  const total = rows.reduce((s, r) => s + (Number(r.price) || 0), 0);

  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);

  // Scrims: only where type sits, so the photograph stays the subject.
  o.push(`<defs>
    <linearGradient id="topS" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${theme === "dark" ? "#000" : "#fff"}" stop-opacity="${theme === "dark" ? 0.62 : 0.55}"/>
      <stop offset="1" stop-color="${theme === "dark" ? "#000" : "#fff"}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="botS" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="${theme === "dark" ? "#000" : "#fff"}" stop-opacity="${theme === "dark" ? 0.68 : 0.6}"/>
      <stop offset="1" stop-color="${theme === "dark" ? "#000" : "#fff"}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="sideL" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${theme === "dark" ? "#000" : "#fff"}" stop-opacity="${theme === "dark" ? 0.60 : 0.55}"/>
      <stop offset="1" stop-color="${theme === "dark" ? "#000" : "#fff"}" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="sideS" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0" stop-color="${theme === "dark" ? "#000" : "#fff"}" stop-opacity="${theme === "dark" ? 0.55 : 0.5}"/>
      <stop offset="1" stop-color="${theme === "dark" ? "#000" : "#fff"}" stop-opacity="0"/>
    </linearGradient>
  </defs>`);
  o.push(`<rect x="0" y="0" width="${W}" height="330" fill="url(#topS)"/>`);
  o.push(`<rect x="0" y="${H - 300}" width="${W}" height="300" fill="url(#botS)"/>`);
  o.push(layout === "lines"
    ? `<rect x="${W - 430}" y="0" width="430" height="${H}" fill="url(#sideS)"/>`
    : `<rect x="0" y="0" width="470" height="${H}" fill="url(#sideL)"/>`);

  // ── The lockup ─────────────────────────────────────────────────────────────
  o.push(`<text x="52" y="126" font-family="${DISPLAY}" font-weight="800" font-size="104" fill="${ink}" letter-spacing="-1">MARATHON</text>`);
  o.push(`<text x="56" y="176" font-family="${DISPLAY}" font-weight="600" font-size="42" fill="${ink}" letter-spacing="19">CLUB</text>`);
  o.push(`<text x="56" y="228" font-family="${TEXT}" font-weight="700" font-size="19" fill="${ink}" letter-spacing="3.2" opacity="0.95">BUILT DIFFERENT.</text>`);
  o.push(monogram(W - 92, 96, 44, ink));

  if (layout === "lines") {
    // ── Right rail with leader lines ─────────────────────────────────────────
    const railX = W - 300;
    const top = 300, gap = Math.min(150, (H - 520 - top) / Math.max(1, rows.length - 1) + 60);
    rows.forEach((r, i) => {
      const y = top + i * gap;
      const a = SLOT_ANCHOR[r.slot] || { x: 0.5, y: 0.5 };
      const ax = a.x * W, ay = a.y * H;
      // elbow: out from the item, then straight to the rail
      const midX = railX - 46;
      o.push(`<path d="M ${ax.toFixed(0)} ${ay.toFixed(0)} L ${midX.toFixed(0)} ${(y - 16).toFixed(0)} L ${(railX - 12).toFixed(0)} ${(y - 16).toFixed(0)}" fill="none" stroke="${ink}" stroke-width="1.6" opacity="0.85"/>`);
      o.push(`<circle cx="${ax.toFixed(0)}" cy="${ay.toFixed(0)}" r="4" fill="${ink}" opacity="0.9"/>`);

      const { brand, rest } = splitName(r.name);
      o.push(`<text x="${railX}" y="${y - 22}" font-family="${TEXT}" font-weight="700" font-size="21" fill="${ink}" letter-spacing="2.2">${esc(wrap(brand, 18, 1)[0] || "")}</text>`);
      const descr = wrap(rest, 17, 2);
      descr.forEach((ln, k) => {
        o.push(`<text x="${railX}" y="${y + 4 + k * 25}" font-family="${TEXT}" font-weight="400" font-size="20" fill="${ink}" letter-spacing="1.6" opacity="0.92">${esc(ln)}</text>`);
      });
      // price in an outlined box, placed BELOW the descriptor it belongs to.
      // Fixed offset here meant a two-line name struck straight through the box.
      const pw = 122, ph = 42, py = y + 4 + descr.length * 25 + 6;
      o.push(`<rect x="${railX - 4}" y="${py}" width="${pw}" height="${ph}" fill="none" stroke="${ink}" stroke-width="1.8" opacity="0.95"/>`);
      o.push(`<text x="${railX - 4 + pw / 2}" y="${py + 30}" font-family="${DISPLAY}" font-weight="700" font-size="30" fill="${ink}" text-anchor="middle" letter-spacing="0.5">${esc(rand(r.price))}</text>`);
    });

    if (showTotal) {
      const bw = 396, bh = 156, bx = W - bw - 40, by = H - bh - 44;
      o.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${chip}"/>`);
      o.push(`<text x="${bx + 26}" y="${by + 46}" font-family="${TEXT}" font-weight="700" font-size="22" fill="${chipT}" letter-spacing="4">TOTAL</text>`);
      o.push(`<text x="${bx + 22}" y="${by + 128}" font-family="${DISPLAY}" font-weight="800" font-size="86" fill="${chipT}" letter-spacing="-1">${esc(rand(total))}</text>`);
    }
    o.push(`<text x="52" y="${H - 58}" font-family="${TEXT}" font-weight="700" font-size="20" fill="${ink}" letter-spacing="3.4">${esc(storefront)}</text>`);
  } else {
    // ── Left rail, hairline-separated list ───────────────────────────────────
    const x = 56;
    let y = 330;
    o.push(`<line x1="${x}" y1="${y - 46}" x2="${x + 46}" y2="${y - 46}" stroke="${ink}" stroke-width="2.4"/>`);
    rows.forEach((r) => {
      const { brand, rest } = splitName(r.name);
      o.push(`<text x="${x}" y="${y}" font-family="${TEXT}" font-weight="700" font-size="19" fill="${ink}" letter-spacing="2.6">${esc(wrap(brand, 22, 1)[0] || "")}</text>`);
      wrap(rest, 21, 1).forEach((ln) => {
        o.push(`<text x="${x}" y="${y + 25}" font-family="${TEXT}" font-weight="400" font-size="18" fill="${ink}" letter-spacing="1.8" opacity="0.9">${esc(ln)}</text>`);
      });
      o.push(`<text x="${x}" y="${y + 66}" font-family="${DISPLAY}" font-weight="800" font-size="34" fill="${ink}">${esc(rand(r.price))}</text>`);
      y += 96;
      o.push(`<line x1="${x}" y1="${y - 16}" x2="${x + 300}" y2="${y - 16}" stroke="${ink}" stroke-width="0.9" opacity="0.45"/>`);
      y += 22;
    });
    if (showTotal) {
      o.push(`<text x="${x}" y="${y + 14}" font-family="${TEXT}" font-weight="700" font-size="19" fill="${ink}" letter-spacing="3.4">TOTAL</text>`);
      o.push(`<text x="${x}" y="${y + 72}" font-family="${DISPLAY}" font-weight="800" font-size="64" fill="${ink}">${esc(rand(total))}</text>`);
    }
    o.push(`<text x="${x}" y="${H - 96}" font-family="${TEXT}" font-weight="700" font-size="22" fill="${ink}" letter-spacing="3.4">SHOP THE WHOLE OUTFIT</text>`);
    o.push(`<text x="${x}" y="${H - 58}" font-family="${TEXT}" font-weight="400" font-size="19" fill="${ink}" letter-spacing="2.6" opacity="0.92">${esc(storefront)}</text>`);
  }

  o.push(`</svg>`);
  return o.join("\n");
}

module.exports = { buildOverlay, splitName, rand, wrap, SLOT_ANCHOR, W, H };
