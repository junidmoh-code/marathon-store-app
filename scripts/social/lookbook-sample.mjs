// ─── LOOKBOOK POSTER: A SAMPLE RENDER THAT SPENDS NOTHING ────────────────────
// Renders the Lookbook poster through the exact production renderer
// (functions/lib/lookbook-render.cjs) with PLACEHOLDER garments and a
// PLACEHOLDER hero drawn here in SVG, so the layout can be checked without a
// generation. The garment placeholders are drawn on studio-grey backgrounds,
// so the same background removal the real poster uses runs on them.
//
//   node scripts/social/lookbook-sample.mjs            → docs/lookbook-sample*.jpg
//   node scripts/social/lookbook-sample.mjs --compare  → also docs/lookbook-compare.jpg
//
// No database, no network, no model call.
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const sharp = require("sharp");
const R = require("./lib/lookbook-render.cjs");
const LB = require("./lib/social-lookbook.cjs");
const type = require("./lib/lookbook-type.cjs");

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const DOCS = join(ROOT, "docs");

// ── PLACEHOLDER HERO: 9:16, the aspect the real generation asks for ──────────
function heroSvg(W = 1536, H = 2752) {
  const cx = W * 0.58;
  const y = (f) => H * f;
  const palm = (x, top, s) => `<g fill="#2f3b2a" opacity="0.85"><rect x="${x - 9 * s}" y="${top}" width="${18 * s}" height="${H}" fill="#5b5446"/>${
    [-70, -35, 0, 35, 70, 110, -110].map((a) => `<ellipse cx="${x}" cy="${top}" rx="${190 * s}" ry="${34 * s}" transform="rotate(${a} ${x} ${top}) translate(${120 * s} 0)"/>`).join("")}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9ccc4"/><stop offset="0.55" stop-color="#9aa592"/><stop offset="1" stop-color="#7c8774"/></linearGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${palm(W * 0.18, y(0.08), 1.2)}${palm(W * 0.86, y(0.04), 1.4)}${palm(W * 0.42, y(0.18), 0.9)}
  <rect x="0" y="${y(0.42)}" width="${W}" height="${y(0.3)}" fill="#4d5a43"/>
  ${Array.from({ length: 40 }, (_, i) => `<circle cx="${(i * 97) % W}" cy="${y(0.44) + ((i * 53) % 300)}" r="${70 + (i % 5) * 18}" fill="#3e4b36" opacity="0.8"/>`).join("")}
  <rect x="${W * 0.06}" y="${y(0.62)}" width="${W * 0.3}" height="${y(0.035)}" fill="#a9a497"/><rect x="${W * 0.08}" y="${y(0.655)}" width="${W * 0.04}" height="${y(0.05)}" fill="#8f8a7e"/><rect x="${W * 0.3}" y="${y(0.655)}" width="${W * 0.04}" height="${y(0.05)}" fill="#8f8a7e"/>
  <rect x="0" y="${y(0.7)}" width="${W}" height="${y(0.3)}" fill="#b9b4a8"/>
  ${Array.from({ length: 9 }, (_, i) => `<line x1="${(i * W) / 8}" y1="${y(0.7)}" x2="${(i * W) / 8 + (i - 4) * 120}" y2="${H}" stroke="#a29d91" stroke-width="5"/>`).join("")}
  ${[0.76, 0.84, 0.93].map((f) => `<line x1="0" y1="${y(f)}" x2="${W}" y2="${y(f)}" stroke="#a29d91" stroke-width="5"/>`).join("")}
  <!-- a placeholder figure: head 0.105–0.19, feet at 0.86 -->
  <g transform="translate(0 ${y(0.02)})">
  <ellipse cx="${cx}" cy="${y(0.85)}" rx="180" ry="26" fill="#000" opacity="0.18"/>
  <rect x="${cx - 70}" y="${y(0.165)}" width="140" height="70" fill="#b98d6f"/>
  <ellipse cx="${cx}" cy="${y(0.14)}" rx="78" ry="96" fill="#b98d6f"/>
  <path d="M ${cx - 92} ${y(0.125)} Q ${cx} ${y(0.085)} ${cx + 92} ${y(0.125)} L ${cx + 130} ${y(0.13)} L ${cx - 92} ${y(0.135)} Z" fill="#1d1d1d"/>
  <path d="M ${cx - 230} ${y(0.2)} L ${cx + 230} ${y(0.2)} L ${cx + 250} ${y(0.47)} L ${cx - 250} ${y(0.47)} Z" fill="#26313f"/>
  <rect x="${cx - 70}" y="${y(0.2)}" width="140" height="${y(0.25)}" fill="#ece9e2"/>
  <rect x="${cx - 300}" y="${y(0.21)}" width="80" height="${y(0.28)}" rx="30" fill="#26313f"/><rect x="${cx + 220}" y="${y(0.21)}" width="80" height="${y(0.28)}" rx="30" fill="#26313f"/>
  <path d="M ${cx - 220} ${y(0.46)} L ${cx + 220} ${y(0.46)} L ${cx + 240} ${y(0.62)} L ${cx + 20} ${y(0.62)} L ${cx} ${y(0.55)} L ${cx - 20} ${y(0.62)} L ${cx - 240} ${y(0.62)} Z" fill="#8a8170"/>
  <rect x="${cx - 200}" y="${y(0.62)}" width="110" height="${y(0.2)}" fill="#b98d6f"/><rect x="${cx + 90}" y="${y(0.62)}" width="110" height="${y(0.2)}" fill="#b98d6f"/>
  <rect x="${cx + 250}" y="${y(0.5)}" width="200" height="230" rx="30" fill="#141414"/><line x1="${cx + 280}" y1="${y(0.5)}" x2="${cx + 230}" y2="${y(0.25)}" stroke="#141414" stroke-width="16"/>
  <path d="M ${cx - 250} ${y(0.82)} h 190 v 60 h -230 q -10 -40 40 -60 Z" fill="#f2f2f2"/><path d="M ${cx + 60} ${y(0.82)} h 190 q 50 20 40 60 h -230 Z" fill="#f2f2f2"/>
  </g>
</svg>`;
}

// ── PLACEHOLDER GARMENTS on studio grey ───────────────────────────────────────
const G = {
  hat: '<path d="M170 470 Q400 170 630 470 Z" fill="#1d1d1d"/><path d="M560 465 Q700 470 720 520 L 480 520 Z" fill="#1d1d1d"/>',
  jacket: '<path d="M250 180 L550 180 L650 640 L150 640 Z" fill="#26313f"/><rect x="110" y="200" width="110" height="420" rx="40" fill="#26313f"/><rect x="580" y="200" width="110" height="420" rx="40" fill="#26313f"/><line x1="400" y1="190" x2="400" y2="640" stroke="#c9c4b8" stroke-width="6"/>',
  tee: '<path d="M260 170 L540 170 L700 290 L620 380 L560 330 L560 650 L240 650 L240 330 L180 380 L100 290 Z" fill="#f4f1ea" stroke="#d8d3c8" stroke-width="4"/>',
  bottoms: '<path d="M200 170 L600 170 L640 600 L430 600 L400 380 L370 600 L160 600 Z" fill="#8a8170"/>',
  bag: '<rect x="220" y="320" width="360" height="320" rx="40" fill="#141414"/><path d="M290 330 Q400 120 510 330" fill="none" stroke="#141414" stroke-width="26"/>',
  sneakers: '<path d="M120 520 L 140 400 Q 260 360 360 330 L 470 420 Q 620 440 690 500 L 690 560 L 120 560 Z" fill="#f7f7f7" stroke="#bdbdbd" stroke-width="5"/><path d="M120 560 L690 560 L690 590 L120 590 Z" fill="#2a2a2a"/>',
};
const garment = (slot) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#e6e6e4"/>${G[slot]}</svg>`)).jpeg({ quality: 92 }).toBuffer();

// Placeholder rows: realistic lengths, clearly not real stock.
const SAMPLE = [
  { slot: "hat", displayName: "New Era 9FORTY Essential Cap Black", price: 499 },
  { slot: "jacket", displayName: "Nike Sportswear Club Coaches Jacket Navy", price: 1899 },
  { slot: "tee", displayName: "Marathon Club Heavyweight Tee Off White", price: 599 },
  { slot: "bottoms", displayName: "Carhartt Single Knee Short Tobacco", price: 1299 },
  { slot: "bag", displayName: "The North Face Explore Bardu II Black", price: 1249 },
  { slot: "sneakers", displayName: "Nike Air Force 1 '07 Triple White", price: 2399 },
];

export async function renderSample() {
  const hero = await sharp(Buffer.from(heroSvg())).jpeg({ quality: 90 }).toBuffer();
  const rows = await Promise.all(SAMPLE.map(async (r) => ({ ...r, priceText: LB.formatRand(r.price), thumb: await garment(r.slot) })));
  // Where the placeholder figure's garments are, standing in for the vision
  // check's answer (production asks the model where each item is).
  const anchors = LB.anchorsFor(rows, {
    hat: { x: 0.58, y: 0.132 }, jacket: { x: 0.47, y: 0.32 }, tee: { x: 0.58, y: 0.38 },
    bottoms: { x: 0.52, y: 0.57 }, bag: { x: 0.81, y: 0.58 }, sneakers: { x: 0.53, y: 0.85 },
  });
  return R.renderLookbookPoster({ hero, rows, anchors, subject: { x: 0.58, y: 0.16 } });
}

// ── THE SPEC WIREFRAME the sample is compared against ───────────────────────
// The reference poster named in the brief was not attached, so the comparison
// is against the written spec, drawn to the same proportions.
async function specWireframe() {
  const W = 1200, H = 1800, hw = Math.round(W * R.HERO_FRAC);
  const L = (t, x, y, o = {}) => type.textPath(t, { font: "archivo", weight: 600, size: 18, x, y, fill: "#333", ...o }).svg;
  const box = (x, y, w, h, label, fill = "none") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="#666" stroke-dasharray="8 6" stroke-width="2"/>${label ? L(label, x + 10, y + 26, { size: 15 }) : ""}`;
  const P = R.panelLayout(6, H);
  const parts = [
    `<rect width="${W}" height="${H}" fill="#f6f5f2"/>`,
    box(0, 0, hw, H, `HERO PHOTO — ${Math.round(R.HERO_FRAC * 100)}% WIDTH, FULL BLEED`, "#e4e7df"),
    `<rect x="${hw}" y="0" width="${W - hw}" height="${H}" fill="#E9E6DF"/>`,
    box(50, 54, 440, 100, "MARATHON (ANTON, OFF-WHITE)"), box(50, 170, 440, 30, "C L U B (WIDE TRACKED)"),
    box(50, 220, 260, 44, "BUILT DIFFERENT. / MADE TO MOVE."), box(44, 282, 92, 92, "LAUREL M"),
    box(12, 560, 30, 560, ""), L("VERTICAL LINE, RULE ABOVE, SERIF M BELOW", 60, 860, { size: 14 }),
    box(50, 1470, 300, 74, "SHOP ONLINE / [globe] MARATHONCLUB.CO.ZA"),
    box(0, 1594, hw, 206, "DARK STRIP: TRUCK | ROSETTE | ARROWS   ·   EST. 2024 | JOIN THE CLUB.", "rgba(0,0,0,0.12)"),
    `<line x1="480" y1="300" x2="${hw - 9}" y2="${P.rows[0].cy}" stroke="#333" stroke-width="2"/><circle cx="480" cy="300" r="6" fill="#333"/><circle cx="${hw - 9}" cy="${P.rows[0].cy}" r="6" fill="#333"/>`,
    L("LEADER LINES, DOT AT BOTH ENDS", 360, 520, { size: 14 }),
    box(hw + 24, P.header.top, W - hw - 48, P.header.h, "BLACK BAR: THE EVERYDAY / LEGACY COLLECTION"),
    ...P.rows.map((r, i) => box(hw + 24, r.top + 8, W - hw - 48, r.h - 16, ["HAT", "JACKET", "TEE", "BOTTOMS", "BAG", "SNEAKERS"][i] + " — CUT-OUT | BRAND / NAME / R PRICE")),
    box(hw + 24, P.total.top, W - hw - 48, P.total.h, "BLACK: TOTAL + R8,643 (CONDENSED)"),
    box(hw + 24, P.deliveryY - 20, W - hw - 48, 30, "TRUCK + FREE DELIVERY ON ORDERS OVER R999"),
  ];
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`)).jpeg({ quality: 90 }).toBuffer();
}

async function compare(sample) {
  const H = 1800, gap = 40, label = 70;
  const wire = await specWireframe();
  const feedUp = await sharp(sample.feed.buffer).resize(1200, 1500).toBuffer();
  const storyUp = await sharp(sample.story.buffer).resize(Math.round(1080 * (H / 1920)), H).toBuffer();
  const sw = Math.round(1080 * (H / 1920));
  const cols = [
    { buf: wire, w: 1200, h: H, t: "SPEC (reference not attached — drawn from the brief)" },
    { buf: sample.master.buffer, w: 1200, h: H, t: "SAMPLE · master 1200x1800 (2:3)" },
    { buf: feedUp, w: 1200, h: 1500, t: "SAMPLE · feed 1080x1350 (4:5)" },
    { buf: storyUp, w: sw, h: H, t: "SAMPLE · story 1080x1920 (9:16)" },
  ];
  const W = cols.reduce((s, c) => s + c.w, 0) + gap * (cols.length + 1);
  let x = gap;
  const layers = [];
  const titles = [];
  for (const c of cols) {
    layers.push({ input: c.buf, left: x, top: label + gap });
    titles.push(type.textPath(c.t, { font: "archivo", weight: 700, size: 26, x, y: label, fill: "#222" }).svg);
    x += c.w + gap;
  }
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + label + gap * 2}">${titles.join("")}</svg>`), left: 0, top: 0 });
  return sharp({ create: { width: W, height: H + label + gap * 2, channels: 3, background: "#ffffff" } })
    .composite(layers).jpeg({ quality: 85 }).toBuffer();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await mkdir(DOCS, { recursive: true });
  const s = await renderSample();
  await writeFile(join(DOCS, "lookbook-sample.jpg"), s.master.buffer);
  await writeFile(join(DOCS, "lookbook-sample-feed.jpg"), s.feed.buffer);
  await writeFile(join(DOCS, "lookbook-sample-story.jpg"), s.story.buffer);
  if (process.argv.includes("--compare")) await writeFile(join(DOCS, "lookbook-compare.jpg"), await compare(s));
  console.log(`sample: total ${s.total.text}; cut-outs ${JSON.stringify(s.cutouts)}; wordmark ${Math.round(s.markW)}px`);
}
