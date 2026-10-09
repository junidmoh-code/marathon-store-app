// ─── THE ALTERNATIVES PROFILE — what the live ranking knows about a shoe ─────
//
// WHY IT EXISTS (2026-10-09). Until today the sheet could only offer the twelve
// neighbours written onto a product by the offline build. Two things broke
// that on the shop floor (Junid's Ducks of a Feather report, size 8):
//
//   • the twelve are chosen by LOOK, then filtered by SIZE at tap time — so a
//     colourful shoe's twelve were other colourful shoes, none in an 8, while
//     thirty Air Force 1s sat on the Hub 1 shelf in an 8 (315 of the 472
//     empty sheets measured on 2026-10-09);
//   • a shoe created after the attribute run had no list at all (157 more).
//
// The sheet now builds its list from EVERY shoe sellable in the asked size
// right now, and ranks that pool (alternativesCore.js). Ranking needs to know
// what each shoe is — and the attributes live at /product_attributes, which no
// device reads. So the few facts the ranking needs ride on the product record
// as ONE short string, `altProfile`, kept current by a trigger
// (functions: alternativesProfile).
//
// ── WHY A STRING ─────────────────────────────────────────────────────────────
// /products is streamed to every device. A JSON object of fifteen named keys
// is ~300 bytes a product; the same facts pipe-joined are ~70. Every value is
// from a closed vocabulary that cannot contain "|" or ",", and decode
// re-checks each one against that vocabulary — a hand-edited or corrupt string
// degrades to "unknown", never to a wrong value.
//
// ── NEVER MISSING ────────────────────────────────────────────────────────────
// profileOfProduct falls back to a NAME-ONLY profile when the stored one is
// absent, stale or unreadable, so a product the trigger has not reached yet
// still ranks by brand, price, and what its name says — and is still OFFERED.
// Absence of a profile never removes a shoe from the pool.
//
// PURE. Shared byte-for-byte with functions/lib/alt-shared/ (parity test).

import {
  SILHOUETTES, UPPER_MATERIALS, COLOURS, PATTERNS, TOE_SHAPES, SOLE_TYPES, CLOSURES,
  FINISHES, STYLE_TAGS, MAX_STYLE_TAGS, colourFamily, priceBandOf,
} from "./productAttributes.js";
import { silhouetteGroup } from "./productNeighbours.js";
import { modelFamilyOf, cutFromName } from "./modelFamily.js";

export { cutFromName };

/** Where the string lives on the product record. */
export const ALT_PROFILE_FIELD = "altProfile";
/** Bump when the slot layout changes; an older string then reads as absent. */
export const ALT_PROFILE_VERSION = 1;

// A model-family id: lower-case words joined by "-", short. Written by the
// family deriver (modelFamily.js) and nothing else.
const FAMILY_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const FAMILY_SOURCES = Object.freeze(["name", "identity", "label", "stylecode", "fallback", ""]);
export const CUTS = Object.freeze(["low", "mid", "high", ""]);

// ── THE SLOTS, in order ──────────────────────────────────────────────────────
// Each slot names its vocabulary; decode refuses anything outside it.
const SLOTS = Object.freeze([
  ["fam", null],                 // model family id (FAMILY_ID)
  ["famSrc", FAMILY_SOURCES],    // where the family came from
  ["cut", CUTS],                 // low / mid / high, when the name or model says
  ["sil", SILHOUETTES],
  ["col", COLOURS],              // primary colour
  ["col2", COLOURS],             // secondary colour
  ["mat", UPPER_MATERIALS],
  ["pat", PATTERNS],
  ["sole", SOLE_TYPES],
  ["soleCol", COLOURS],
  ["fin", FINISHES],
  ["clo", CLOSURES],
  ["toe", TOE_SHAPES],
  ["tags", STYLE_TAGS],          // comma-joined, at most MAX_STYLE_TAGS
  ["en", ["0", "1"]],            // 1 = the vision attributes are in here
]);

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The empty profile — every slot unknown. */
export function emptyAltProfile() {
  const p = {};
  for (const [k] of SLOTS) p[k] = k === "tags" ? [] : "";
  p.en = false;
  return p;
}

/** Profile → the stored string. Illegal values are written as empty. */
export function encodeAltProfile(profile) {
  const clean = sanitise(profile);
  const parts = [String(ALT_PROFILE_VERSION)];
  for (const [k] of SLOTS) {
    if (k === "tags") parts.push(clean.tags.join(","));
    else if (k === "en") parts.push(clean.en ? "1" : "0");
    else parts.push(clean[k]);
  }
  return parts.join("|");
}

/** The stored string → a profile, or null when absent / another version / malformed. */
export function decodeAltProfile(value) {
  if (typeof value !== "string" || !value) return null;
  const parts = value.split("|");
  if (parts.length !== SLOTS.length + 1) return null;
  if (parts[0] !== String(ALT_PROFILE_VERSION)) return null;
  const raw = {};
  SLOTS.forEach(([k], i) => { raw[k] = parts[i + 1]; });
  raw.tags = raw.tags ? raw.tags.split(",") : [];
  raw.en = raw.en === "1";
  return sanitise(raw);
}

// Every slot checked against its vocabulary — the closed vocabulary is
// enforced where the words are USED, not only where they are written.
function sanitise(p) {
  const out = emptyAltProfile();
  if (!p || typeof p !== "object") return out;
  for (const [k, vocab] of SLOTS) {
    if (k === "tags") {
      const tags = Array.isArray(p.tags) ? p.tags : [];
      out.tags = [...new Set(tags.filter((t) => STYLE_TAGS.includes(t)))].slice(0, MAX_STYLE_TAGS);
      continue;
    }
    if (k === "en") { out.en = p.en === true; continue; }
    const v = typeof p[k] === "string" ? p[k].trim() : "";
    if (k === "fam") { out.fam = FAMILY_ID.test(v) ? v : ""; continue; }
    out[k] = vocab.includes(v) ? v : "";
  }
  return out;
}

// ── NAME READING — the fallback when there is no vision record ───────────────
// Conservative on purpose: only whole words that mean one thing. "Ducks" is not
// a colour; "white" is. A word the vocabulary does not hold is ignored.
const NAME_COLOUR_WORDS = Object.freeze({
  white: "white", black: "black", grey: "grey", gray: "grey", cream: "cream", sail: "cream",
  bone: "bone", silver: "silver", navy: "navy", blue: "blue", teal: "teal", red: "red",
  burgundy: "burgundy", maroon: "maroon", pink: "pink", orange: "orange", yellow: "yellow",
  gold: "gold", green: "green", olive: "olive", mint: "mint", brown: "brown", tan: "tan",
  beige: "beige", chocolate: "chocolate", purple: "purple", lilac: "lilac",
  multicolor: "multicolour", multicolour: "multicolour", multi: "multicolour",
});

/** The colours a product NAME states, in the order it states them (max 2). */
export function coloursFromName(name) {
  const words = String(name ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const out = [];
  for (const w of words) {
    if (!own(NAME_COLOUR_WORDS, w)) continue;
    const c = NAME_COLOUR_WORDS[w];
    if (!out.includes(c)) out.push(c);
    if (out.length === 2) break;
  }
  return out;
}

const SIL_BY_CATEGORY = Object.freeze({ slides: "slide", "soccer-boots": "soccer-boot", boots: "boot", loafers: "loafer", "running-shoes": "runner" });

/** A silhouette the NAME or category states plainly, or "". */
export function silhouetteFromName(product) {
  const key = String(product?.categoryKey || "").trim();
  if (own(SIL_BY_CATEGORY, key)) return SIL_BY_CATEGORY[key];
  const s = ` ${String(product?.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  if (/ (slide|slides|slipper|slippers|flip flop|flip flops) /.test(s)) return "slide";
  if (/ (sandal|sandals) /.test(s)) return "sandal";
  if (/ (fg|sg|ag|firm ground|soft ground|soccer|football boot|football boots) /.test(s)) return "soccer-boot";
  if (/ (boot|boots|chelsea) /.test(s)) return "boot";
  if (/ (loafer|loafers|moccasin) /.test(s)) return "loafer";
  const cut = cutFromName(product?.name);
  if (cut === "high") return "high-top";
  if (cut === "mid") return "mid";
  return "";
}

/**
 * Build the profile for one product.
 *
 * @param product  the /products record
 * @param attrs    resolveAttributes(...) output for it, or null when it has no
 *                 usable vision record
 * @param family   { fam, src, cut, sil } from the family deriver, or null
 */
export function deriveAltProfile(product, { attrs = null, family = null } = {}) {
  const p = emptyAltProfile();
  const named = coloursFromName(product?.name);
  const hasVision = !!(attrs && attrs.silhouette && attrs.primaryColour);
  p.fam = family?.fam || "";
  p.famSrc = p.fam ? (family?.src || "") : "";
  p.cut = family?.cut || cutFromName(product?.name);
  p.sil = (hasVision && attrs.silhouette) || silhouetteFromName(product) || family?.sil || "";
  p.col = (hasVision && attrs.primaryColour) || named[0] || "";
  p.col2 = (hasVision ? attrs.secondaryColour : named[1]) || "";
  if (hasVision) {
    p.mat = attrs.upperMaterial || "";
    p.pat = attrs.pattern || "";
    p.sole = attrs.soleType || "";
    p.soleCol = attrs.soleColour || "";
    p.fin = attrs.finish || "";
    p.clo = attrs.closure || "";
    p.toe = attrs.toeShape || "";
    p.tags = Array.isArray(attrs.styleTags) ? attrs.styleTags : [];
  }
  p.en = hasVision;
  return sanitise(p);
}

// One profile per product OBJECT: the screen re-renders often and the product
// records it holds are replaced, never mutated, when they change.
const cache = new WeakMap();

/**
 * The profile the ranking uses for a product: the stored one when it reads,
 * otherwise one derived from the record alone. Never null for a real product.
 * Adds the facts that are read live from the record (brand, category, price
 * band) rather than stored, so a price edit re-ranks without waiting on the
 * trigger.
 */
export function profileOfProduct(product) {
  if (!product || typeof product !== "object") return null;
  const hit = cache.get(product);
  if (hit) return hit;
  const stored = decodeAltProfile(product[ALT_PROFILE_FIELD]);
  const base = stored || deriveAltProfile(product, { family: deriveFamilyHook(product) });
  const out = {
    ...base,
    pid: String(product.id || ""),
    brand: String(product.brand || "").trim().toLowerCase(),
    categoryKey: String(product.categoryKey || "").trim(),
    band: priceBandOf(product.retailPrice),
    cf: colourFamily(base.col),
    grp: silhouetteGroup(base.sil),
    stored: !!stored,
  };
  cache.set(product, out);
  return out;
}

// A record with no stored profile reads its family from what it carries: the
// name and the box label's model name. (The trigger also has the vision
// namer's model and style-code siblings, and stores the result.)
function deriveFamilyHook(product) {
  return modelFamilyOf({ name: product?.name, brand: product?.brand, labelModelName: product?.labelModelName });
}
