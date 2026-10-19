// ─── THE LOOKBOOK POSTER: WHAT GOES IN IT, AND WHICH DAY IT RUNS ─────────────
//
// The daily still alternates between two formats (owner addendum, 2026-10-17):
// day A is the current designed still (generateOnePost, story + feed twin,
// untouched), day B is the Lookbook poster. This file is the pure half of the
// lookbook: the outfit picker, the price and photo resolver, the rotation, the
// hero prompt and the reading of the no-text check. No RTDB, no network, no
// clock of its own; functions/lookbook/lookbook.cjs does the I/O.
//
// ── EVERY NUMBER ON THE POSTER COMES FROM /products ──────────────────────────
// The price on a row is products/{pid}/retailPrice, rounded to whole rand, and
// the TOTAL is the sum of the rows actually drawn. A product without a usable
// price is not drawn with a gap. It is skipped and the next one in its slot is
// tried, and if the slot runs dry the row is dropped. A poster that cannot
// reach MIN_ROWS is not made: the day posts the current style instead.
"use strict";

const { isGeneratedPhoto } = require("../newArrivals/sourcePhoto.cjs");
const { fitsWith } = require("./social-select.cjs");

// ── THE SIX ROWS, HEAD TO TOE ────────────────────────────────────────────────
// `keys` are products/{pid}/categoryKey values from the live catalogue (the
// same vocabulary social-select.cjs SLOT_MATCHERS was counted against).
// `guess` is only a READ-ORDER hint over the storefront title. It decides which
// products are worth reading first. The record's categoryKey decides the slot.
//
// `anchor` is where the model-side dot of the leader line sits when the vision
// check gives no position for the item. It is a fraction of the generated photo, and
// the hero prompt pins the composition (full length, body at 58% of the
// width, the top of the head ~4% from the top, soles ~11% above the bottom:
// the body fills ~85% of the height, owner go-live brief 19 Oct) so these
// land on the body. The renderer still orders the dots top to bottom against
// the rows (lookbook-render planLeaders), so the lines never cross.
const LOOKBOOK_SLOTS = [
  { slot: "hat",      label: "hat",      keys: ["caps-beanies", "fitted-caps", "visors"],
    guess: /\b(cap|caps|beanie|bucket|visor|fitted|snapback|hat)\b/i, anchor: { x: 0.58, y: 0.06 } },
  { slot: "jacket",   label: "jacket",   keys: ["jackets", "hoodies"],
    guess: /\b(jackets?|hoodies?|puffer|windbreaker|windrunner|anorak|bomber|sweaters?|pullover|cardigan|quarter-zip)\b/i, anchor: { x: 0.53, y: 0.24 } },
  { slot: "tee",      label: "tee",      keys: ["t-shirts", "golf-t-shirts"],
    guess: /\b(t-shirts?|tees?|t|polo|henley|shirt|top)\b/i, anchor: { x: 0.60, y: 0.30 } },
  { slot: "bottoms",  label: "bottoms",  keys: ["shorts", "pants", "jeans"],
    guess: /\b(shorts?|pants|jeans?|cargo|trousers?|joggers?|chinos?)\b/i, anchor: { x: 0.55, y: 0.53 } },
  { slot: "bag",      label: "bag",      keys: ["bags"],
    guess: /\b(bag|backpack|crossbody|sling|pouch|tote|duffel|messenger)\b/i, anchor: { x: 0.72, y: 0.58 } },
  { slot: "sneakers", label: "sneakers", keys: ["sneakers"],
    guess: /\b(sneakers?|low-top|mid-top|high-top|trainers?|runners?)\b/i, anchor: { x: 0.58, y: 0.855 } },
];
// The body in the hero column (owner go-live brief, 19 Oct): the model fills
// ~85% of the height, the top of his head ~4% below the top edge. The prompt
// asks for it and the renderer crops to it when the model came out smaller.
const BODY_FILL = 0.85;
const BODY_TOP = 0.04;
// The hero's long side at the model's native maximum: Nano Banana Pro and
// Flash at 9:16 4K both return 3072x5504 (measured 18 Oct). Anything under
// this was not made at the maximum.
const HERO_MIN_LONG_SIDE = 5000;
const SLOT_KEYS = LOOKBOOK_SLOTS.map((s) => s.slot);
const SLOT_BY_KEY = new Map(LOOKBOOK_SLOTS.map((s) => [s.slot, s]));

// Clean product shots generated per SA day (functions/lookbook/thumbs.cjs).
// A poster needs at most six, and a re-picked slot a few more; this is a
// ceiling on a runaway, not a plan. Its own counter, social_lookbook/
// thumbBudget/{saDate}: a thumbnail never takes one of the day's four hero
// and scene units.
const THUMBS_PER_DAY = 12;

// Fewer than four rows is not a lookbook, it is a pairing with a big panel.
const MIN_ROWS = 4;
// The TOTAL lands in this band, inclusive (owner go-live brief, 19 Oct). The
// picker chooses products to hit it; a price is never altered to fit.
const PRICE_BAND = { min: 1400, max: 1900 };
// Every look has something on top, on the legs and on the feet.
const CORE_SLOTS = [["tee", "jacket"], ["bottoms"], ["sneakers"]];
// How many of each slot's best the band search combines. 7^6 leaves at most,
// cut down hard by the band's ceiling.
const BAND_PER_SLOT = 6;
// "Not used in the last 14 lookbooks".
const HISTORY_DEPTH = 14;
// How many of each guessed slot the loader reads per round. Six slots at eight
// is 48 product reads, which is less than the 80 the reel shortlist reads.
const READS_PER_SLOT = 8;

/** Which lookbook row a product fills, or null. Pure. */
function lookbookSlot(product) {
  const key = String((product && product.categoryKey) || "").toLowerCase();
  if (!key) return null;
  for (const s of LOOKBOOK_SLOTS) if (s.keys.includes(key)) return s.slot;
  return null;
}

/** The slot a storefront title SUGGESTS, for read ordering only. Pure. */
// Never a lookbook row, whatever else the title says: a suit jacket is
// categorised "suits" and a tracksuit is top AND bottom. Reading them first
// starved the jacket slot on the first live dry run (2026-10-17).
const NOT_A_ROW = /\b(suit|suits|tracksuits?|two-piece|set)\b/i;

function guessSlot(cleanName) {
  const name = String(cleanName || "");
  if (NOT_A_ROW.test(name)) return null;
  // The catalogue's titles are "<adjectives> <noun> in <colour> with <detail>",
  // so the noun is the LAST slot word before the first in/with/and/on/for:
  // "Textured knit runner in orange" is a runner, not a knit.
  const head = name.split(/\s+(?:in|with|and|on|for)\s+/i)[0];
  const lastHit = (text) => {
    let best = null, at = -1;
    for (const s of LOOKBOOK_SLOTS) {
      const re = new RegExp(s.guess.source, "gi");
      let m;
      while ((m = re.exec(text))) if (m.index >= at) { at = m.index; best = s.slot; }
    }
    return best;
  };
  return lastHit(head) || lastHit(name);
}

/**
 * The retail price as whole rand, or null when the record has none.
 * Never typed and never guessed: products/{pid}/retailPrice is the only source,
 * and anything that is not a positive finite number is "no price". Pure.
 */
function priceOf(product) {
  const raw = product && product.retailPrice;
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v);
}

/**
 * "R1,399": a comma for thousands and no decimals. The ONLY place a lookbook
 * price becomes text. Written out rather than taken from toLocaleString,
 * whose separator for en-ZA is a narrow no-break space that depends on the
 * ICU build. Pure.
 */
function formatRand(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return null;
  return "R" + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ── THE NAME ON A ROW: BRAND LINE + NAME LINE ────────────────────────────────
// Sample 01 printed "G" over "STAR RAW CARGO JEANS FG3546#", "HUGO" over "BOSS
// BEANIE RED" and "ALEXANDER" over "MCQUEEN OVERSIZED": the shared splitName
// only knows single-word and exact-spelling brands, so it fell back to the
// first word. The catalogue's own spellings ("G star raw", "Hugo boss",
// "Alexander McQueen") are matched here, longest first, and the brand is set
// in its proper form. A style code ("FG3546#", "#2506") is an internal
// reference and never printed.
const POSTER_BRANDS = [
  ["G-Star Raw", /^g[\s-]*star(?:[\s-]+raw)?\b/i],
  ["Hugo Boss", /^hugo[\s-]+boss\b/i],
  // Bare "Alexander", "Karl" and "Tommy" are these brands in this catalogue
  // (the 2026-08-13 census in alt-shared/shopifyTriggers.js), but never when
  // the next word names a different house.
  ["Alexander McQueen", /^alexander(?:[\s-]+mc[\s-]*queen\b|(?![\s-]+(?:wang|mcq)\b))/i],
  ["Karl Lagerfeld", /^karl(?:[\s-]+lagerfeld\b|(?![\s-]+kani\b))/i],
  ["The North Face", /^(?:the[\s-]+)?north[\s-]+face\b/i],
  ["Tommy Hilfiger", /^tommy(?:[\s-]+hilfiger\b|(?![\s-]+bahama\b))/i],
  ["Calvin Klein", /^calvin[\s-]+klein\b/i],
  ["Polo Ralph Lauren", /^polo[\s-]+ralph(?:[\s-]+lauren)?\b/i],
  ["Ralph Lauren", /^ralph[\s-]+lauren\b/i],
  ["Michael Kors", /^michael[\s-]+kors\b/i],
  ["Stone Island", /^stone[\s-]+island\b/i],
  ["True Religion", /^true[\s-]+religion\b/i],
  ["Dolce & Gabbana", /^dolce[\s-]*(?:&|and)?[\s-]*gabbana\b/i],
  ["Emporio Armani", /^emporio[\s-]+armani\b/i],
  ["Off-White", /^off[\s-]*white\b/i],
  ["Fear of God", /^fear[\s-]+of[\s-]+god\b/i],
  ["Palm Angels", /^palm[\s-]+angels\b/i],
  ["Philipp Plein", /^phil+ip+[\s-]+plein\b/i],
  ["Saint Laurent", /^saint[\s-]+laurent\b/i],
  ["Louis Vuitton", /^louis[\s-]+vuitton\b/i],
  ["Bottega Veneta", /^bottega(?:[\s-]+veneta)?\b/i],
  ["Daniel Wellington", /^daniel[\s-]+wellington\b/i],
  ["Brunello Cucinelli", /^brunello(?:[\s-]+cucinelli)?\b/i],
  ["Loro Piana", /^loro[\s-]+piana\b/i],
  ["New Balance", /^new[\s-]+balance\b/i],
  ["New Era", /^new[\s-]+era\b/i],
  // "Under Amour" is how the till spells it on several records.
  ["Under Armour", /^under[\s-]+a(?:r)?mou?r\b/i],
  ["Air Jordan", /^air[\s-]+jordan\b/i],
  ["Comme des Garçons", /^comme[\s-]+des[\s-]+gar[cç]ons\b/i],
  ["Marathon Club", /^marathon[\s-]+club\b/i],
];
// "FG3546#", "FD1299#", "#2506", "#Y8161-1": a '#' first, or a letter-led
// code with two or more digits and a '#' last. "Air Max 90#" is a model name
// with a stray '#', not a code, and keeps its 90.
const STYLE_CODE = /(?:^|\s)(?:#\S+|[A-Za-z]+\d{2,}[\w-]*#)(?=\s|$)/g;

/** A display name without its internal style codes. Pure. */
function stripStyleCodes(name) {
  return String(name || "").replace(STYLE_CODE, " ").replace(/\s+/g, " ").trim();
}

/**
 * The poster's two lines for a product: { brand, rest }, upper case. `brand`
 * is "" when the name has no brand line (the whole name then goes on the bold
 * line). `fallbackSplit` is social-design's splitName, used for any brand
 * this table does not know; `isCategory(word)` says a first word is a garment
 * ("Jacket brown"), which is never a brand. Pure.
 */
function posterName(displayName, { fallbackSplit, isCategory = () => false } = {}) {
  const name = stripStyleCodes(displayName);
  if (!name) return { brand: "", rest: "" };
  for (const [brand, re] of POSTER_BRANDS) {
    const m = re.exec(name);
    if (m) {
      const rest = name.slice(m[0].length).replace(/^[\s,.-]+/, "").trim();
      return rest ? { brand: brand.toUpperCase(), rest: rest.toUpperCase() } : { brand: "", rest: brand.toUpperCase() };
    }
  }
  const split = fallbackSplit ? fallbackSplit(name) : { brand: name.split(" ")[0].toUpperCase(), rest: name.split(" ").slice(1).join(" ").toUpperCase() };
  if (split.rest && !isCategory(split.brand)) return { brand: split.brand, rest: split.rest };
  return { brand: "", rest: name.toUpperCase() };
}

// ── THE PANEL'S TWO LINES, FROM THE WEBSITE (owner go-live brief, 19 Oct) ───
// Brand line: the product's brand. Name line: the product's WEBSITE name,
// shopify_publish/{pid}/cleanName, the title the Shopify publisher writes
// (already brand-stripped for the payment gateway), cleaned. Never the till's
// inventory string ("Jacket black #5926") and never a colour-only name
// ("Jacket Black", "Bag Green"). A product without a brand or without a
// usable website name is not eligible for the lookbook at all.
const GARMENT_WORDS = new Set([
  "jacket", "jackets", "hoodie", "hoodies", "sweater", "sweaters", "jumper", "pullover", "top", "tops",
  "tee", "tees", "t-shirt", "t-shirts", "tshirt", "shirt", "shirts", "polo", "pants", "pant", "jeans", "jean",
  "trousers", "shorts", "short", "joggers", "cargo", "cargos", "bag", "bags", "backpack", "pouch",
  "sneaker", "sneakers", "shoe", "shoes", "boot", "boots", "trainer", "trainers", "runner", "runners",
  "beanie", "beanies", "cap", "caps", "hat", "hats", "bucket", "visor", "item", "product",
]);
const COLOUR_WORDS = new Set([
  "black", "white", "grey", "gray", "brown", "beige", "cream", "khaki", "navy", "blue", "green", "olive",
  "red", "maroon", "burgundy", "pink", "purple", "orange", "yellow", "gold", "silver", "tan", "taupe",
  "camel", "charcoal", "stone", "sand", "mint", "teal", "lilac", "ivory", "nude", "multi", "multicolour",
  "multicolor", "colour", "color", "light", "dark", "pale", "off-white", "brownish", "greyish", "greenish",
  "bluish", "and", "with", "in", "&", "on", "stripes", "striped",
]);
// A bare stock code left in a website name: "FG3551", "FD1299", "FG3535-1",
// and the same glued to a word ("jeanFG3551" is "jean"). Two digits is a model
// ("59FIFTY", "Air Max 90"), never stripped.
const stripBareCodes = (s) => String(s || "").replace(/([a-z])([A-Z]{1,3}\d{3,})/g, "$1 $2")
  .replace(/(^|\s)[A-Za-z]{1,3}\d{3,}[\w-]*(?=\s|$)/g, " ");
const words = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9&\s-]+/g, " ").split(/\s+/).filter(Boolean);

/** The brand line: the catalogue spelling in its proper form, else the record's brand. Pure. */
function posterBrand(product) {
  const p = product || {};
  const brand = typeof p.brand === "string" ? p.brand.trim() : "";
  // A brand that is itself a garment ("Jacket") is the till's placeholder.
  if (!brand || GARMENT_WORDS.has(brand.toLowerCase()) || guessSlot(brand)) return null;
  const name = stripStyleCodes(p.name);
  for (const [proper, re] of POSTER_BRANDS) {
    if (re.test(brand)) return proper.toUpperCase();
    // "Boss" over "Hugo boss beanie", "Under" over "Under Amour bag": the name
    // carries the full brand when the record's brand field is short of it.
    const m = re.exec(name);
    if (m && m[0].toLowerCase().includes(brand.toLowerCase().split(/[\s-]+/)[0])) return proper.toUpperCase();
  }
  return brand.toUpperCase();
}

/**
 * The website name for the panel, or { name: null, why }. `websiteName` is
 * shopify_publish/{pid}/cleanName; `product` the /products record. Pure.
 */
function panelName(websiteName, product, brandLine = "") {
  const raw = typeof websiteName === "string" ? websiteName.trim() : "";
  if (!raw) return { name: null, why: "no website name" };
  let name = stripBareCodes(stripStyleCodes(raw))
    .replace(/[!?]+/g, " ").replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();
  // Brand stripped (the publisher already strips it; this is the backstop).
  for (const b of [brandLine, product && product.brand].filter(Boolean)) {
    const re = new RegExp(`^${String(b).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s-]+/g, "[\\s-]+")}\\b[\\s,-]*`, "i");
    name = name.replace(re, "").trim();
  }
  if (!name) return { name: null, why: "no website name" };
  const w = words(name);
  // Colour-only: a garment word and colours, nothing that describes it.
  if (w.every((t) => GARMENT_WORDS.has(t) || COLOUR_WORDS.has(t) || /^\d+$/.test(t))) {
    return { name: null, why: `colour-only website name "${name}"` };
  }
  // The till's string re-dressed: every descriptive word is already in the
  // inventory name ("Jacket black white stripes #1552", "Raw cargo jeans
  // FD3554" for "G star raw cargo jeans FD3554#").
  const inv = new Set(words(stripBareCodes(stripStyleCodes(product && product.name))));
  const own = w.filter((t) => !GARMENT_WORDS.has(t) && !COLOUR_WORDS.has(t));
  if (inv.size && own.every((t) => inv.has(t))) return { name: null, why: `website name "${name}" is the inventory string` };
  return { name: name.charAt(0).toUpperCase() + name.slice(1) };
}

/**
 * The approved photo for a product: the New Arrivals studio photo where one
 * exists, else the storefront's lead photo, else the record's hero. An
 * approved studio photo REPLACES products/{pid}/photoUrl (see
 * newArrivals/sourcePhoto.cjs), so "studio" is photoUrl being a generated one.
 * Returns { url, studio } or null. Pure.
 */
function approvedPhoto(product, node) {
  const p = product || {};
  if (p.photoUrl && isGeneratedPhoto(p.photoUrl)) return { url: String(p.photoUrl), studio: true };
  const photos = Array.isArray(node && node.photos)
    ? node.photos
    : node && node.photos && typeof node.photos === "object" ? Object.values(node.photos) : [];
  const lead = photos.find((u) => typeof u === "string" && u.trim());
  if (lead) return { url: lead, studio: false };
  if (typeof p.photoUrl === "string" && p.photoUrl.trim()) return { url: p.photoUrl, studio: false };
  return null;
}

/**
 * A candidate (social-select buildCandidates row) resolved to a poster row, or
 * { skip } saying exactly why it cannot be one. Pure.
 */
function resolveRow(candidate) {
  const c = candidate || {};
  const slot = lookbookSlot(c.product);
  if (!slot) return { skip: "no lookbook slot for its category" };
  const price = priceOf(c.product);
  if (price === null) return { skip: "no retail price" };
  const photo = approvedPhoto(c.product, c.node);
  if (!photo) return { skip: "no approved photo" };
  const brandLine = posterBrand(c.product);
  if (!brandLine) return { skip: "no brand" };
  const named = panelName(c.name, c.product, brandLine);
  if (!named.name) return { skip: named.why };
  return {
    row: {
      pid: c.pid, slot, price, priceText: formatRand(price),
      brandLine, nameLine: named.name.toUpperCase(),
      photoUrl: photo.url, studio: photo.studio,
      displayName: c.displayName || c.name || "",
      name: c.name || null, handle: c.handle || null, link: c.link || null,
      liveAt: Number(c.liveAt) || 0,
      newNorm: Number(c.newNorm) || 0,
      score: Number(c.score) || 0,
    },
  };
}

/**
 * The pids used in the last HISTORY_DEPTH lookbooks.
 *
 * `history` is the value of social_lookbook/history as RTDB hands it back:
 * { [saDate]: { pids: [...], at } }. RTDB DELETES an empty array, so a day
 * with no pids comes back with no `pids` key at all, not `pids: []`. It can
 * also turn an array into an object { "0": ..., "1": ... } when keys are
 * sparse. Both are read here, and anything else is ignored. Pure.
 */
function recentLookbookPids(history, depth = HISTORY_DEPTH) {
  const out = new Set();
  if (!history || typeof history !== "object") return out;
  const days = Object.keys(history).sort().slice(-depth);
  for (const d of days) {
    const entry = history[d];
    const raw = entry && entry.pids;
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
    for (const pid of list) if (typeof pid === "string" && pid) out.add(pid);
  }
  return out;
}

/**
 * Pick the outfit: at most one product per slot, head to toe, whose TOTAL
 * lands in PRICE_BAND (owner go-live brief, 19 Oct).
 *
 * Every look has a top (tee or jacket), bottoms and sneakers; hat, bag and the
 * second top are finishing pieces. Among the looks inside the band the most
 * rows wins (six, then five, then four: "drop to 4 rows"), then the best
 * summed bias. Bias per product, in order of weight: not in the last 14
 * lookbooks, then an approved New Arrivals studio photo (it cuts out cleanly
 * and is the best reference the model can be given), then newness, then the
 * shared sales and newness score. Ties break on the pids so two runs on the
 * same data agree. Prices are never altered: a product either fits the band
 * with the others or is not chosen.
 *
 * Pieces that do not share a wardrobe context (social-select fitsWith: no
 * soccer boot with jeans) are never combined.
 *
 * @param candidates  social-select buildCandidates rows (live, in stock)
 * @param opts.recent Set of pids used in recent lookbooks
 * @param opts.used   Set of pids already spoken for today (never picked)
 * @param opts.band   { min, max } rand, inclusive (default PRICE_BAND)
 * @returns { rows, total, reason, band?, skipped: [{ pid, slot, why }], missing }
 *          `band: true` on a refusal means looks existed but none in the band.
 */
function pickLookbookOutfit(candidates, { recent = new Set(), used = new Set(), band = PRICE_BAND } = {}) {
  const skipped = [];
  const bySlot = new Map(SLOT_KEYS.map((k) => [k, []]));
  for (const c of candidates || []) {
    if (!c || !c.pid || used.has(c.pid)) continue;
    const r = resolveRow(c);
    if (r.skip) {
      if (lookbookSlot(c.product)) skipped.push({ pid: c.pid, slot: lookbookSlot(c.product), why: r.skip });
      continue;
    }
    bySlot.get(r.row.slot).push({ row: r.row, candidate: c });
  }
  const rank = (e) => (recent.has(e.row.pid) ? 0 : 4) + (e.row.studio ? 1 : 0)
    + e.row.newNorm + 0.5 * e.row.score;
  for (const list of bySlot.values()) {
    list.sort((a, b) => rank(b) - rank(a) || (a.row.pid < b.row.pid ? -1 : 1));
    list.splice(BAND_PER_SLOT);
  }

  // The core of the look first (what is on the body), then the finishing
  // pieces, so the search prunes on the big prices early.
  const ORDER = ["tee", "bottoms", "sneakers", "jacket", "hat", "bag"];
  const hasCore = (slots) => CORE_SLOTS.every((any) => any.some((k) => slots.has(k)));
  let best = null, nearest = null, looks = 0;
  const better = (a, b) => !b || a.n > b.n || (a.n === b.n && (a.score > b.score + 1e-9
    || (Math.abs(a.score - b.score) <= 1e-9 && a.key < b.key)));
  const walk = (i, chosen, sum, score) => {
    if (i === ORDER.length) {
      if (chosen.length < MIN_ROWS || !hasCore(new Set(chosen.map((e) => e.row.slot)))) return;
      looks++;
      if (sum >= band.min && sum <= band.max) {
        const cand = { n: chosen.length, score, key: chosen.map((e) => e.row.pid).sort().join(","), chosen: chosen.slice() };
        if (better(cand, best)) best = cand;
      } else {
        const off = sum < band.min ? band.min - sum : sum - band.max;
        if (!nearest || off < nearest.off) nearest = { off, sum, n: chosen.length };
      }
      return;
    }
    for (const e of bySlot.get(ORDER[i])) {
      if (sum + e.row.price > band.max) continue;
      if (!fitsWith(chosen.map((x) => x.candidate), e.candidate)) continue;
      chosen.push(e);
      walk(i + 1, chosen, sum + e.row.price, score + rank(e));
      chosen.pop();
    }
    walk(i + 1, chosen, sum, score);
  };
  walk(0, [], 0, 0);
  // No look at all under the ceiling: say why, with the cheapest look's price.
  if (!best && !looks) {
    const filled = SLOT_KEYS.filter((k) => bySlot.get(k).length);
    const missing = SLOT_KEYS.filter((k) => !bySlot.get(k).length);
    if (filled.length < MIN_ROWS || !hasCore(new Set(filled))) {
      return {
        rows: [], total: 0, skipped,
        reason: `no eligible outfit — only ${filled.length} of the six slots could be filled (nothing for: ${missing.join(", ")}); a lookbook needs ${MIN_ROWS} with a top, bottoms and sneakers`,
      };
    }
  }
  if (!best) {
    return {
      rows: [], total: 0, skipped, band: true,
      reason: `no outfit of ${MIN_ROWS}–6 rows totals ${formatRand(band.min)}–${formatRand(band.max)}${nearest ? ` (closest: ${formatRand(nearest.sum)} with ${nearest.n} rows)` : " (every look is over the ceiling)"}`,
    };
  }
  const chosen = new Map(best.chosen.map((e) => [e.row.slot, e.row]));
  const rows = SLOT_KEYS.filter((k) => chosen.has(k)).map((k) => chosen.get(k));
  const missing = SLOT_KEYS.filter((k) => !chosen.has(k));
  return { rows, total: rows.reduce((s, r) => s + r.price, 0), reason: null, skipped, missing };
}

/** The history entry a finished lookbook writes. Pure. */
function historyEntry(rows, atMs) {
  return { pids: (rows || []).map((r) => r.pid), at: atMs };
}

// ── THE ROTATION ─────────────────────────────────────────────────────────────
const STILL_FORMAT_KEYS = ["current", "lookbook"];
const DEFAULT_STILL_FORMATS = ["current", "lookbook"];

/**
 * STILL_FORMATS as configured: a JSON array of format names, in rotation
 * order. A name may repeat to weight it (["current","lookbook","lookbook"]).
 * Unknown names are dropped. LOOKBOOK_ENABLED=false removes "lookbook". An
 * unreadable value falls back to the default rather than turning the still
 * off, because a typo should not silently cost a post a day. An explicit "[]"
 * does turn it off. Pure.
 */
function parseStillFormats(raw, { lookbookEnabled = true } = {}) {
  let list = DEFAULT_STILL_FORMATS;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) list = v;
    } catch { /* default */ }
  } else if (Array.isArray(raw)) {
    list = raw;
  }
  return list
    .map((s) => String(s || "").trim().toLowerCase())
    .filter((s) => STILL_FORMAT_KEYS.includes(s))
    .filter((s) => lookbookEnabled || s !== "lookbook");
}

// ── WHICH DAYS ARE LOOKBOOK DAYS ─────────────────────────────────────────────
// Owner brief, 2026-10-18: the lookbook takes the photo-post slot THREE days a
// week, Monday, Wednesday and Friday, and the current style the other four.
// The days are config (LOOKBOOK_DAYS in functions/.env, a JSON list of day
// names), so they change with a redeploy and no code. This replaced the strict
// day-A/day-B alternation of 17 Oct: a weekday is a fact of the date, so a
// missed or re-run day can never shift the week.
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DEFAULT_LOOKBOOK_DAYS = ["mon", "wed", "fri"];

/**
 * LOOKBOOK_DAYS as configured: day names ("mon", "Monday", "MON" all read as
 * mon), deduplicated, in week order. Unknown names are dropped. An unreadable
 * value falls back to the default for the same reason parseStillFormats does;
 * an explicit "[]" means no lookbook days. Pure.
 */
function parseLookbookDays(raw) {
  let list = DEFAULT_LOOKBOOK_DAYS;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) list = v;
    } catch { /* default */ }
  } else if (Array.isArray(raw)) {
    list = raw;
  }
  const want = new Set(list.map((s) => String(s || "").trim().toLowerCase().slice(0, 3)));
  return WEEKDAYS.filter((d) => want.has(d));
}

/** Is `raw` a JSON array? For warning about a malformed switch. Pure. */
function isJsonList(raw) {
  try { return Array.isArray(JSON.parse(raw)); } catch { return false; }
}

/** "2026-10-19" -> "mon". The SA date is a calendar date, so UTC is exact. Pure. */
function weekdayOf(saDate) {
  return WEEKDAYS[new Date(`${saDate}T12:00:00Z`).getUTCDay()];
}

/**
 * The still's format for an SA date: "lookbook" on a lookbook day when
 * STILL_FORMATS allows it, otherwise "current" when allowed, otherwise
 * whatever STILL_FORMATS still holds; null when there is no daily still. Pure.
 */
function plannedStillFormat(saDate, formats, lookbookDays) {
  if (!formats || !formats.length) return null;
  if (formats.includes("lookbook") && (lookbookDays || []).includes(weekdayOf(saDate))) return "lookbook";
  return formats.includes("current") ? "current" : formats[0];
}

/** The next `days` days of the still from `todayDate`, by weekday. Pure. */
function stillCalendar(todayDate, formats, lookbookDays, days = 7) {
  const out = [];
  const start = new Date(`${todayDate}T00:00:00Z`).getTime();
  for (let i = 0; i < days; i++) {
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10);
    out.push({ date, day: weekdayOf(date), format: plannedStillFormat(date, formats, lookbookDays) });
  }
  return out;
}

// ── THE TWO LOCATIONS ────────────────────────────────────────────────────────
// Owner review of sample 01 (2026-10-18): two locations, alternating per
// lookbook day, concrete first. LOOKBOOK_SCENES in functions/.env is the order
// (a JSON list of scene keys); unknown keys are dropped, an unreadable value
// is the default, and an empty list is the default too (a poster needs a
// location). Each scene is the only part of the hero prompt that changes.
const LOOKBOOK_SCENE_DEFS = {
  concrete: {
    key: "concrete",
    floor: "the concrete floor",
    location: "Location: he stands on a poured concrete floor in a raw concrete space. Behind him is a board-formed concrete wall, the grain of the timber boards printed in it. No plants, no furniture, no props, no windows in frame.",
    light: "Light: soft directional daylight from one side, as from a large window out of frame, falling off gently across the wall; soft shadows. Grade: muted grey, cool and neutral, editorial, natural skin tones.",
    calm: "Keep the upper-left of the frame calm and uncluttered (plain concrete wall only) and the floor below his shoes plain concrete.",
  },
  garden: {
    key: "garden",
    floor: "the paving",
    location: "Location: he stands on large pale stone paving slabs in a lush garden — tall palm trees and dense tropical greenery behind him, a weathered stone bench to one side.",
    light: "Light: soft overcast daylight, no hard shadows. Grade: muted, editorial, slightly desaturated greens, natural skin tones.",
    calm: "Keep the upper-left of the frame calm and uncluttered — soft foliage and sky only — and the paving below his shoes plain.",
  },
};
const LOOKBOOK_SCENE_KEYS = Object.keys(LOOKBOOK_SCENE_DEFS);
// Concrete only since go-live (owner, 19 Oct): the garden stays defined and
// LOOKBOOK_SCENES='["concrete","garden"]' brings the alternation back.
const DEFAULT_LOOKBOOK_SCENES = ["concrete"];

/** LOOKBOOK_SCENES as configured, deduplicated, in the given order. Pure. */
function parseLookbookScenes(raw) {
  let list = DEFAULT_LOOKBOOK_SCENES;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) list = v;
    } catch { /* default */ }
  } else if (Array.isArray(raw)) {
    list = raw;
  }
  const out = [];
  for (const s of list) {
    const k = String(s || "").trim().toLowerCase();
    if (LOOKBOOK_SCENE_KEYS.includes(k) && !out.includes(k)) out.push(k);
  }
  return out.length ? out : DEFAULT_LOOKBOOK_SCENES.slice();
}

// The first lookbook day the scenes rotate from: Monday 19 Oct 2026, the
// first lookbook day after the owner's review, so it gets the first scene.
const SCENE_EPOCH = "2026-10-19";

/**
 * The scene for an SA date: the number of lookbook days between SCENE_EPOCH
 * and this date, modulo the scene list. Counted from the calendar, like the
 * lookbook days themselves, so a missed or re-run day never shifts the
 * alternation. A date that is not a lookbook day gets the scene the next
 * lookbook day would. Pure.
 */
function sceneFor(saDate, scenes, lookbookDays) {
  const list = scenes && scenes.length ? scenes : DEFAULT_LOOKBOOK_SCENES;
  const days = new Set(lookbookDays && lookbookDays.length ? lookbookDays : DEFAULT_LOOKBOOK_DAYS);
  const DAY = 86400000;
  const a = Date.parse(`${SCENE_EPOCH}T12:00:00Z`), b = Date.parse(`${saDate}T12:00:00Z`);
  if (!Number.isFinite(b)) return LOOKBOOK_SCENE_DEFS[list[0]];
  // Lookbook days in [epoch, date) going forward, or in [date, epoch) going back.
  let n = 0;
  if (b >= a) { for (let t = a; t < b; t += DAY) if (days.has(WEEKDAYS[new Date(t).getUTCDay()])) n++; }
  else { for (let t = b; t < a; t += DAY) if (days.has(WEEKDAYS[new Date(t).getUTCDay()])) n--; }
  const i = ((n % list.length) + list.length) % list.length;
  return LOOKBOOK_SCENE_DEFS[list[i]];
}

// ── THE MODEL ────────────────────────────────────────────────────────────────
// Owner review of sample 01: the model is a Black man, dark skin, athletic,
// in his 20s or 30s. A HARD requirement: it is in every hero prompt, and the
// vision check below refuses a hero where he is not visibly Black.
const MODEL_DESCRIPTION = "a Black man with dark skin, athletic build, in his mid-20s to early 30s";
const MODEL_REQUIREMENT = `The model MUST be ${MODEL_DESCRIPTION}. This is a hard requirement.`;

// ── THE HERO PROMPT ──────────────────────────────────────────────────────────
// The picture is the ONLY thing the model makes. Type, prices, the wordmark,
// the badge, the panel and the leader lines are all drawn in code. The
// composition is pinned so the category anchors land on the body.
// `modelRef`: a character reference image is attached before the garments,
// so every poster shows the same man.
function buildHeroPrompt(rows, { scene = LOOKBOOK_SCENE_DEFS[DEFAULT_LOOKBOOK_SCENES[0]], modelRef = false } = {}) {
  const sc = typeof scene === "string" ? LOOKBOOK_SCENE_DEFS[scene] : scene;
  const garments = (rows || []).map((r, i) =>
    `- ${SLOT_BY_KEY.get(r.slot).label.toUpperCase()}: ${r.displayName} — exactly as in REFERENCE ${i + 1}`).join("\n");
  return [
    "Editorial fashion photograph, portrait orientation, highest detail.",
    MODEL_REQUIREMENT,
    ...(modelRef ? ["He is the man in the MODEL REFERENCE photo: the same face, skin tone, hair and build. Take only the man from it, never its clothing, headwear or background."] : []),
    "He is full length, head to toe in frame, standing upright and relaxed, facing the camera at a slight three-quarter angle, arms loose at his sides.",
    `Composition: a tight full-length frame. He fills about ${Math.round(BODY_FILL * 100)}% of the frame height: the top of his head is about ${Math.round(BODY_TOP * 100)}% below the top edge and the soles of his shoes rest on ${sc.floor} about ${Math.round((1 - BODY_TOP - BODY_FILL) * 100)}% above the bottom edge. His body is centred at about 58% of the frame width (slightly right of centre). Nothing crops him: the whole head, any hat and both shoes are in frame.`,
    sc.location,
    sc.light,
    "He wears the complete outfit below, every garment reproduced faithfully from its attached reference photo — same colour, fabric, cut, graphics and logos as the real item:",
    garments,
    "Any item not listed is plain and unbranded (or absent).",
    sc.calm,
    "No text, no logos other than those on the garments, no captions, no watermark. No lettering, signage, numbers, borders, frames or graphic overlays of any kind.",
  ].join("\n");
}

// ── THE CHARACTER REFERENCE ──────────────────────────────────────────────────
// Made once (scripts/social/lookbook-model-ref.mjs) and attached to every hero.
function buildModelRefPrompt() {
  return [
    "Studio portrait photograph for a casting reference, portrait orientation.",
    MODEL_REQUIREMENT,
    "Head and shoulders to mid-chest, facing the camera, neutral relaxed expression, short natural hair, no headwear, no glasses, no jewellery.",
    "He wears a plain white crew-neck T-shirt with no logo.",
    "Plain mid-grey seamless studio backdrop, soft even studio light, natural skin texture.",
    "No text, no logos, no watermark.",
  ].join("\n");
}

// ── THE CLEAN PRODUCT SHOT FOR THE PANEL ─────────────────────────────────────
// Owner review of sample 01: the panel's pictures were crops of the shop's
// photos — a hand holding the beanie, a hanger on the jeans, a box under the
// shoe. Each product is redrawn on its own from its own photo (the reference
// keeps colour, logo and shape), on pure white, and then cut out.
const THUMB_VIEW = {
  hat: "the hat on its own, front-on, as if on an invisible head form",
  jacket: "the garment on its own, front-on, laid flat or on an invisible mannequin, sleeves relaxed",
  tee: "the garment on its own, front-on, laid flat or on an invisible mannequin",
  bottoms: "the garment on its own, front-on, full length, laid flat or on an invisible mannequin",
  bag: "the bag on its own, front-on, standing upright, its strap tucked neatly behind it",
  // Front-on, a pair of shoes is two toe caps; the pair at a slight angle is
  // how every shop shows them.
  sneakers: "the pair of shoes side by side, at a slight front three-quarter angle so the side profile shows",
};
function buildThumbPrompt(row) {
  const r = row || {};
  return [
    `Professional e-commerce product photograph of exactly the item in the reference photo: ${r.displayName || "the product"}.`,
    `Show ${THUMB_VIEW[r.slot] || "the item on its own, front-on"}, centred, filling about 80% of a square frame.`,
    "Nothing else: no hand, no person, no hanger, no hook, no box, no packaging, no tag, no price label, no stand, no display block, no props.",
    "The reference may show a swing tag, price tag, size sticker or label hanging from the item on a string or plastic loop: leave it OFF. Show the item as it looks once the tags are removed. Logos sewn or printed on the item stay.",
    "Studio lighting, soft and even. Pure white seamless background (#FFFFFF), no shadow, no reflection, no floor line.",
    "Reproduce the item faithfully from the reference: the same colour, fabric, shape, logo and every graphic. Change nothing about the product itself.",
    "No added text, no watermark.",
  ].join("\n");
}

// ── THE NO-TEXT CHECK ────────────────────────────────────────────────────────
// One vision call on the finished hero. It answers two questions: is there any
// lettering that is NOT printed on the clothing (a caption, a watermark, a
// sign, numbers, a frame)? And roughly where is each listed item? The second
// answer places the dots. The first is the gate.
const WHERE = {
  hat: "the hat itself, on the head",
  jacket: "the outer layer (jacket, hoodie or sweater), on the chest or upper arm",
  tee: "the top worn under or as the main layer, at the middle of the torso",
  bottoms: "the trousers, jeans or shorts, on the thigh",
  bag: "the BODY of the bag (not its strap, not the hand)",
  sneakers: "the shoes, on the nearer shoe",
};
function buildHeroCheckPrompt() {
  return [
    "You are checking an AI-generated fashion photograph before it is published.",
    "1. Does the image contain ANY text, letters, numbers, captions, watermarks, signatures, signage or graphic overlays that are NOT physically printed or embroidered on the model's clothing, shoes, hat or bag? Brand logos and wordmarks ON the garments do not count. Everything else counts, however small.",
    "2. Is the model visibly a Black man with dark skin? Answer true only if he clearly is.",
    "Answer with ONLY a JSON object, no prose:",
    '{"text_found": true|false, "text_seen": "what you saw, or empty", "model_black": true|false, "model_seen": "a few words describing the model"}',
  ].join("\n");
}

/**
 * The model check, read strictly: anything but an explicit true FAILS. Pure.
 * @returns { ok, seen, reason }
 */
function readModelCheck(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  let v = null;
  if (a !== -1 && b > a) { try { v = JSON.parse(s.slice(a, b + 1)); } catch { v = null; } }
  // `unreadable`: the check gave no answer, which is not evidence about the
  // picture. makeLookbook regenerates only on an explicit false.
  if (!v || typeof v.model_black !== "boolean") return { ok: false, unreadable: true, seen: "", reason: "the model check did not say whether the model is Black" };
  const seen = typeof v.model_seen === "string" ? v.model_seen.slice(0, 120) : "";
  return v.model_black
    ? { ok: true, seen, reason: null }
    : { ok: false, seen, reason: `the model is not visibly a Black man${seen ? ` (${seen})` : ""}` };
}

// ── WHERE EACH GARMENT IS: A LABELLED GRID, NOT RAW NUMBERS ─────────────────
// Asked for x/y fractions, the vision model put the same beanie at y 0.12,
// 0.21 and 0.17 on three looks at one picture. Asked for a CELL on a grid
// drawn over a copy of the picture, it answers what it can see. The grid copy
// is used for this question only. The text check above looks at the clean
// picture, so the grid's own labels can never fail it.
const GRID = { cols: 12, rows: 20 };
const COL_LETTERS = "ABCDEFGHIJKL";
function buildLocatePrompt(rows) {
  const items = (rows || []).map((r) => `"${r.slot}": ${WHERE[r.slot]}`).join("; ");
  return [
    `This photograph has a grid drawn over it: columns ${COL_LETTERS[0]}–${COL_LETTERS[GRID.cols - 1]} from left to right, rows 1–${GRID.rows} from top to bottom, labelled on the edges.`,
    `For each item the model is wearing, name the ONE grid cell that contains its visual centre. Items: ${items}. Also "head": the centre of the model's face.`,
    "Use null for anything you cannot see. Answer with ONLY a JSON object, no prose:",
    '{"head": "F5", "items": {"<slot>": "G9" | null}}',
  ].join("\n");
}

/** "G9" → the cell's centre as fractions, or null. Pure. */
function cellCentre(cell) {
  const m = /^\s*([A-Za-z])\s*(\d{1,2})\s*$/.exec(String(cell || ""));
  if (!m) return null;
  const c = COL_LETTERS.indexOf(m[1].toUpperCase()), r = Number(m[2]) - 1;
  if (c < 0 || r < 0 || r >= GRID.rows) return null;
  return { x: (c + 0.5) / GRID.cols, y: (r + 0.5) / GRID.rows };
}

/** The locate answer → { anchors, head }. Anything unreadable is simply absent. Pure. */
function readLocate(text, rows) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  let v = {};
  if (a !== -1 && b > a) { try { v = JSON.parse(s.slice(a, b + 1)); } catch { v = {}; } }
  const anchors = {};
  const items = v.items && typeof v.items === "object" ? v.items : {};
  for (const r of rows || []) {
    const p = cellCentre(items[r.slot]);
    if (p) anchors[r.slot] = p;
  }
  const head = cellCentre(v.head);
  return { anchors, head: head && head.y < 0.5 ? head : null };
}

/**
 * The text check's answer, read strictly. Anything that cannot be read FAILS
 * the gate: "I could not tell whether there was text" is not a pass. Pure.
 * @returns { ok, hasText, seen, reason }
 */
function readHeroCheck(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b <= a) return { ok: false, hasText: true, seen: "", reason: "the text check gave no JSON answer" };
  let v;
  try { v = JSON.parse(s.slice(a, b + 1)); } catch { return { ok: false, hasText: true, seen: "", reason: "the text check answer was not valid JSON" }; }
  if (typeof v.text_found !== "boolean") return { ok: false, hasText: true, seen: "", reason: "the text check did not say whether text was found" };
  const seen = typeof v.text_seen === "string" ? v.text_seen.slice(0, 200) : "";
  return v.text_found
    ? { ok: false, hasText: true, seen, reason: `the hero contains text${seen ? `: ${seen}` : ""}` }
    : { ok: true, hasText: false, seen, reason: null };
}

/**
 * Where each row's leader line starts on the model. The vision position is
 * used when it is plausible for the slot (a hat in the top third, shoes in the
 * bottom quarter, and so on). Otherwise the slot's fixed anchor is used. Pure.
 */
const PLAUSIBLE_Y = {
  hat: [0.0, 0.22], jacket: [0.1, 0.5], tee: [0.12, 0.55],
  bottoms: [0.38, 0.8], bag: [0.25, 0.8], sneakers: [0.65, 0.98],
};
function anchorsFor(rows, visionAnchors = {}, head = null) {
  const out = {};
  // A hat is on the head.
  // On the first real poster the face was located to the cell every time and
  // the beanie wandered a cell above or below it, so a hat more than 0.03 from
  // "0.04 above the face" is put there.
  const HAT_ABOVE_FACE = 0.04;
  if (head && visionAnchors && visionAnchors.hat && Math.abs(visionAnchors.hat.y - (head.y - HAT_ABOVE_FACE)) > 0.03) {
    visionAnchors = { ...visionAnchors, hat: { x: head.x, y: Math.max(0.02, head.y - HAT_ABOVE_FACE) } };
  }
  // The category spots are a TEMPLATE of a body from face (y 0.09) to feet
  // (y 0.82) centred at x 0.58, the composition the prompt asks for. The model
  // does not always stand there (the first real hero put him ~10% lower), so
  // when the head is known the template is stretched onto the real body: head
  // to the vision feet, or to the same body height below the head.
  const T_HEAD = 0.09, T_FEET = SLOT_BY_KEY.get("sneakers").anchor.y, T_X = 0.58;
  const feetV = visionAnchors && visionAnchors.sneakers;
  const place = (fixed) => {
    if (!head) return fixed;
    const feet = feetV && feetV.y > head.y + 0.3 ? feetV.y : Math.min(0.97, head.y + (T_FEET - T_HEAD));
    const k = (feet - head.y) / (T_FEET - T_HEAD);
    return { x: Math.min(0.98, Math.max(0.08, fixed.x + (head.x - T_X))), y: head.y + (fixed.y - T_HEAD) * k };
  };
  // Two items answered with the same spot (the vest "found" on the bag that
  // covers it, spec review L13): the bag keeps it, the other item goes to its
  // place on the body.
  const near = (a, b) => a && b && Math.hypot(a.x - b.x, a.y - b.y) < 0.09;   // the same or a neighbouring grid cell
  const bagV = visionAnchors && visionAnchors.bag;
  for (const r of rows || []) {
    const fixed = place(SLOT_BY_KEY.get(r.slot).anchor);
    let v = visionAnchors && visionAnchors[r.slot];
    if (r.slot !== "bag" && near(v, bagV)) v = null;
    const band = PLAUSIBLE_Y[r.slot];
    out[r.slot] = v && v.y >= band[0] && v.y <= band[1] && v.x >= 0.08 && v.x <= 0.98
      ? { x: v.x, y: v.y, source: "vision" }
      : { x: fixed.x, y: fixed.y, source: head ? "body" : "category" };
  }
  return out;
}

/**
 * Where the body is in the hero, as fractions { top, bottom }, from the
 * located face (and hat) and shoes, or null when either end is unknown. The
 * top is the top of the head (a face cell centre sits ~0.04 below it), the
 * bottom the soles (a shoe cell centre sits ~0.02 above them). Pure.
 */
function bodyExtent(located, anchors) {
  const head = located && located.head;
  const feet = anchors && anchors.sneakers && anchors.sneakers.source === "vision" ? anchors.sneakers
    : located && located.anchors && located.anchors.sneakers;
  if (!head || !feet || !(feet.y > head.y + 0.3)) return null;
  const hat = anchors && anchors.hat && anchors.hat.source === "vision" ? anchors.hat.y : head.y;
  const top = Math.max(0, Math.min(head.y, hat) - 0.04);
  const bottom = Math.min(1, feet.y + 0.02);
  return bottom - top > 0.3 ? { top, bottom } : null;
}

module.exports = {
  PRICE_BAND, CORE_SLOTS, HERO_MIN_LONG_SIDE, BODY_FILL, BODY_TOP, bodyExtent, posterBrand, panelName,
  LOOKBOOK_SLOTS, SLOT_KEYS, MIN_ROWS, HISTORY_DEPTH, READS_PER_SLOT,
  STILL_FORMAT_KEYS, DEFAULT_STILL_FORMATS,
  lookbookSlot, guessSlot, priceOf, formatRand, approvedPhoto, resolveRow,
  recentLookbookPids, pickLookbookOutfit, historyEntry,
  parseStillFormats, stillCalendar,
  parseLookbookDays, isJsonList, weekdayOf, plannedStillFormat, DEFAULT_LOOKBOOK_DAYS,
  buildHeroPrompt, buildHeroCheckPrompt, readHeroCheck, readModelCheck, anchorsFor,
  buildModelRefPrompt, buildThumbPrompt, MODEL_DESCRIPTION,
  LOOKBOOK_SCENE_DEFS, LOOKBOOK_SCENE_KEYS, DEFAULT_LOOKBOOK_SCENES, SCENE_EPOCH, parseLookbookScenes, sceneFor,
  POSTER_BRANDS, stripStyleCodes, posterName, THUMBS_PER_DAY,
  GRID, buildLocatePrompt, cellCentre, readLocate,
};
