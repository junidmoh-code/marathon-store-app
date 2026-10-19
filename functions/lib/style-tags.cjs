// ─── WHAT A PRODUCT LOOKS LIKE, TO THE STYLIST ───────────────────────────────
// Every product the stylist can put in an outfit carries one set of tags:
//
//   dominant    the colour covering most of the item (a palette name)
//   secondary   the next most visible colour, or null
//   pattern     solid | print | logo-heavy
//   silhouette  slim | regular | oversized | n/a (hats, bags, shoes, scent)
//   family      a style family from the guide (streetwear, athleisure, …)
//   formality   1–5
//   season      summer | winter | all
//
// They come from ONE vision call on the product's approved photo, made once
// and cached at social_lookbook/styleTags/{pid} (functions/lookbook/
// style-tags-io.cjs). A product with tags is never tagged again. When there is
// no photo tag, nameTags() reads the same fields from the product's name,
// brand and category; those are never cached, so the photo tag can still
// replace them. This file is pure: prompts, the answer's reading, the fallback.
"use strict";

const GUIDE = require("./style-guide.json");

const TAG_VERSION = 1;
const PATTERNS = ["solid", "print", "logo-heavy"];
const SILHOUETTES = ["slim", "regular", "oversized", "n/a"];
const PIECE_SEASONS = ["summer", "winter", "all"];
// The cheapest vision model on the account: $0.10 per million input tokens,
// $0.40 output (Gemini API pricing, Oct 2026). A 384 px photo is 258 tokens.
const TAG_MODEL = "gemini-2.5-flash-lite";
const TAG_FALLBACK_MODEL = "gemini-3.1-flash-lite";
const TAG_IN_PER_MTOK = 0.10;
const TAG_OUT_PER_MTOK = 0.40;
const TAG_FALLBACK_IN_PER_MTOK = 0.25;
const TAG_FALLBACK_OUT_PER_MTOK = 1.50;
const TAG_IMAGE_PX = 384;

// What the vision answer is held to (Gemini responseSchema, OpenAPI subset).
function tagSchema(guide = GUIDE) {
  const colours = Object.keys(guide.palette);
  return {
    type: "OBJECT",
    properties: {
      dominant: { type: "STRING", enum: colours },
      secondary: { type: "STRING", enum: [...colours, "none"] },
      pattern: { type: "STRING", enum: PATTERNS },
      silhouette: { type: "STRING", enum: SILHOUETTES },
      family: { type: "STRING", enum: Object.keys(guide.families) },
      formality: { type: "INTEGER" },
      season: { type: "STRING", enum: PIECE_SEASONS },
    },
    required: ["dominant", "secondary", "pattern", "silhouette", "family", "formality", "season"],
  };
}

/** The tagging prompt for one product. `p` is { brand, name, categoryKey }. Pure. */
function buildTagPrompt(p = {}, guide = GUIDE) {
  const colours = Object.entries(guide.palette)
    .map(([c, v]) => `${c}${v.aliases.length ? ` (${v.aliases.join(", ")})` : ""}`).join("; ");
  const fams = Object.entries(guide.families)
    .map(([f, v]) => `${f} (e.g. ${v.brands.slice(0, 5).join(", ")})`).join("; ");
  return [
    "You are a menswear stylist tagging ONE product from its shop photo, for an outfit builder.",
    `Product: ${[p.brand, p.name].filter(Boolean).join(" — ") || "unknown"}${p.categoryKey ? ` (category: ${p.categoryKey})` : ""}.`,
    "Look only at the product itself: ignore the background, the floor, a hanger, a box, a hand, a swing tag or a price label.",
    `dominant: the colour covering most of the product (for shoes: the upper). Choose from: ${colours}.`,
    "secondary: the second most visible colour on the product (a sole, a logo, a stripe, a trim), from the same list, or \"none\" when it is one colour.",
    "pattern: \"solid\" (one or two plain colours, small or tonal logo), \"print\" (graphic print, camo, check, stripes, tie-dye, all-over pattern), or \"logo-heavy\" (a big logo, monogram or wordmark is the main design).",
    "silhouette: for tops and bottoms only — \"slim\" (fitted, skinny, tapered), \"regular\" (straight, classic), or \"oversized\" (boxy, baggy, wide, dropped shoulder). For hats, bags, shoes and fragrance: \"n/a\".",
    `family: the style world it belongs to — ${fams}.`,
    "formality: 1 gym/pitch, 2 sport-casual (tracksuits, hoodies, caps), 3 casual (tees, jeans, cargos, clean sneakers), 4 smart-casual (polos, chinos, leather sneakers), 5 dressed (tailoring, loafers, designer shoes).",
    "season: \"summer\" (shorts, tees, light fabrics, slides), \"winter\" (puffers, heavy knits, beanies, fleece), or \"all\".",
    "Answer with ONLY the JSON object.",
  ].join("\n");
}

const lower = (s) => String(s || "").trim().toLowerCase();

/**
 * The vision answer, read strictly: every field must be in the guide's
 * vocabulary or the answer is refused (and nothing is cached). Pure.
 * @returns { ok: true, tags } | { ok: false, reason }
 */
function readTags(text, guide = GUIDE) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  let v;
  try { v = a !== -1 && b > a ? JSON.parse(s.slice(a, b + 1)) : null; } catch { v = null; }
  if (!v || typeof v !== "object") return { ok: false, reason: "no JSON in the answer" };
  const dominant = lower(v.dominant), secondary = lower(v.secondary);
  if (!guide.palette[dominant]) return { ok: false, reason: `dominant "${v.dominant}" is not a palette colour` };
  if (secondary && secondary !== "none" && !guide.palette[secondary]) return { ok: false, reason: `secondary "${v.secondary}" is not a palette colour` };
  if (!PATTERNS.includes(lower(v.pattern))) return { ok: false, reason: `pattern "${v.pattern}"` };
  if (!SILHOUETTES.includes(lower(v.silhouette))) return { ok: false, reason: `silhouette "${v.silhouette}"` };
  if (!guide.families[lower(v.family)]) return { ok: false, reason: `family "${v.family}"` };
  const formality = Number(v.formality);
  if (!(Number.isInteger(formality) && formality >= 1 && formality <= 5)) return { ok: false, reason: `formality "${v.formality}"` };
  if (!PIECE_SEASONS.includes(lower(v.season))) return { ok: false, reason: `season "${v.season}"` };
  return {
    ok: true,
    tags: {
      dominant,
      secondary: secondary && secondary !== "none" && secondary !== dominant ? secondary : null,
      pattern: lower(v.pattern), silhouette: lower(v.silhouette), family: lower(v.family),
      formality, season: lower(v.season),
    },
  };
}

/** A cached record still usable by this guide (an old colour name is refused). Pure. */
function usableTags(rec, guide = GUIDE) {
  if (!rec || typeof rec !== "object" || rec.failed) return null;
  const r = readTags(JSON.stringify({ ...rec, secondary: rec.secondary || "none" }), guide);
  return r.ok ? { ...r.tags, source: rec.source || "vision" } : null;
}

// ── THE FALLBACK: TAGS FROM THE NAME ─────────────────────────────────────────
const NON_GARMENT_KEYS = new Set(["sneakers", "slides", "soccer-boots", "boots", "designer-shoes", "caps-beanies", "fitted-caps", "visors", "bags", "perfumes"]);
const FORMALITY_BY_KEY = {
  "soccer-jerseys": 1, "soccer-boots": 1, slides: 1, shorts: 2, tracksuits: 2, hoodies: 2, "caps-beanies": 2, "fitted-caps": 2, visors: 2,
  "t-shirts": 3, jeans: 3, sneakers: 3, bags: 3, jackets: 3, "golf-t-shirts": 4, pants: 3, boots: 4, "designer-shoes": 5, perfumes: 3,
};

/**
 * Every palette colour a phrase names, in reading order, longest wording
 * first where two overlap: "light wash jeans in black" → denim-light, black.
 * Pure.
 */
function coloursIn(text, guide = GUIDE) {
  const t = ` ${lower(text).replace(/[^a-z0-9\s-]+/g, " ")} `;
  const hits = [];
  for (const [c, v] of Object.entries(guide.palette)) {
    for (const w of new Set([c.replace(/-/g, " "), c, ...v.aliases])) {
      let at = t.indexOf(` ${w} `);
      while (at !== -1) { hits.push({ c, at: at + 1, end: at + 1 + w.length }); at = t.indexOf(` ${w} `, at + 1); }
    }
  }
  hits.sort((a, b) => a.at - b.at || (b.end - b.at) - (a.end - a.at));
  const out = [];
  let reach = -1;
  for (const h of hits) {
    if (h.at < reach) continue;
    reach = h.end;
    if (!out.includes(h.c)) out.push(h.c);
  }
  return out;
}

/**
 * Tags read from the name, brand and category: what the stylist uses when a
 * product has no photo tag. Coarser than a photo, never cached. Pure.
 */
function nameTags({ name = "", websiteName = "", brand = "", categoryKey = "" } = {}, guide = GUIDE) {
  const text = `${websiteName} ${name}`;
  const key = lower(categoryKey);
  // Colours in the order they are written: "black and white" → black, white.
  const found = coloursIn(text, guide);
  const jeans = /\b(jeans?|denim)\b/i.test(text) || key === "jeans";
  const dominant = found[0] || (jeans ? "denim-mid" : "black");
  const b = lower(brand);
  let family = null;
  for (const [f, v] of Object.entries(guide.families)) {
    if (v.brands.some((x) => b && (b === lower(x) || b.startsWith(lower(x)) || lower(x).startsWith(b)))) { family = f; break; }
  }
  if (!family) for (const [f, v] of Object.entries(guide.families)) if (v.categories.includes(key)) { family = f; break; }
  const garment = !NON_GARMENT_KEYS.has(key);
  const silhouette = !garment ? "n/a"
    : /\b(oversized?|baggy|boxy|wide|relaxed|loose|parachute)\b/i.test(text) ? "oversized"
      : /\b(slim|skinny|fitted|tapered|muscle)\b/i.test(text) ? "slim" : "regular";
  const season = /\b(beanie|puffer|fleece|knit|wool|parka|padded|sherpa)\b/i.test(text) || key === "jackets" ? "winter"
    : ["shorts", "slides", "visors", "t-shirts", "soccer-jerseys"].includes(key) ? "summer" : "all";
  return {
    dominant,
    secondary: found[1] && found[1] !== dominant ? found[1] : null,
    pattern: /\b(monogram|logo|wordmark)\b/i.test(text) ? "logo-heavy"
      : /\b(print|printed|graphic|camo|check|checked|plaid|stripes?|striped|tie-dye|floral|paisley)\b/i.test(text) ? "print" : "solid",
    silhouette, family: family || "streetwear",
    formality: FORMALITY_BY_KEY[key] || 3, season,
    source: "name",
  };
}

/** The record cached at social_lookbook/styleTags/{pid}. Pure. */
function tagRecord(tags, { model, costUSD, src, nowMs }) {
  return {
    v: TAG_VERSION, ...tags, secondary: tags.secondary || null, source: "vision",
    model: model || null, costUSD: +Number(costUSD || 0).toFixed(6), src: src || null, at: nowMs,
  };
}

/** USD for one Gemini answer from its usageMetadata. Pure. */
function tagCostUSD(usage, model = TAG_MODEL) {
  const u = usage || {};
  const [inR, outR] = model === TAG_FALLBACK_MODEL ? [TAG_FALLBACK_IN_PER_MTOK, TAG_FALLBACK_OUT_PER_MTOK] : [TAG_IN_PER_MTOK, TAG_OUT_PER_MTOK];
  const out = (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0);
  return ((Number(u.promptTokenCount) || 0) * inR + out * outR) / 1e6;
}

module.exports = {
  TAG_VERSION, TAG_MODEL, TAG_FALLBACK_MODEL, TAG_IMAGE_PX, PATTERNS, SILHOUETTES, PIECE_SEASONS,
  tagSchema, buildTagPrompt, readTags, usableTags, nameTags, coloursIn, tagRecord, tagCostUSD,
};
