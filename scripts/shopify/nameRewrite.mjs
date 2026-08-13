// ── Brand-strip name rewriting for the Shopify push ──────────────────────────
// Shopify listing titles carry no PARENT-brand word — the maker's mark (Nike,
// adidas, Hugo Boss, Calvin Klein, …) is removed, leaving colourway and model
// detail. LINE marks are kept (owner decision, 2026-08-13): a product-line name
// that functions as the model's identity survives the strip — "Air Jordan 1
// Retro Low OG …" keeps "Air Jordan", the Drake NOCTA collab keeps "NOCTA",
// even while "Nike" in the same title is stripped. The kept line marks live in
// the LINE MARKS note below; extending that list is a data decision, not code.
// Pure functions, no I/O.
//
// How the brand list was derived (2026-08-13, read-only):
//   1. Seeded from the app's own curated brand lexicon, BRAND_ALIASES in
//      src/utils/productCategory.js:102-122 (20 alias rules built for this
//      exact catalogue).
//   2. Extended from a census of the live `brand` field: 411 distinct values
//      across 3,921 branded records. Kept trademarked consumer marks; dropped
//      descriptors that the brand-guesser mis-filed (colours, garment words,
//      countries, football clubs, supplier codes like "Bs-8022").
//   3. Added the misspellings that actually occur in live names: Lacoster,
//      Lacosta, Guccie, Guccl, Kelvin Klein, Armai, Glorgio, Kalr,
//      Essentially, Giavceye, plus curly-apostrophe Levi’s.
//
// Deliberate boundaries:
//   • Obscure supplier house-marks (YOMO, Shouzhan, Bangouluo, …) are NOT
//     stripped — for those lines the mark effectively IS the model identity.
//   • Football club / team names (Arsenal, Barcelona, …) stay — they are the
//     product, not the maker.
//   • "Polo" alone is a garment, never stripped (matches the app's own guard,
//     productCategory.js). Only "Polo Ralph (Lauren)" is brand.
//   • "On" (On Running) is only stripped as the LEADING word of a Cloud*/
//     Running name — a bare \bon\b rule would shred ordinary names.
//
// LINE MARKS (kept, never stripped — deliberately ABSENT from the list below):
//   • "Air Jordan" / "Jordan" — Nike's line brand; on this catalogue's Jordan
//     records the mark IS the model identity ("Air Jordan 1 Retro Low OG …",
//     "Jordan backpack white").
//   • "NOCTA" — the Nike × Drake line; same reasoning.
// Adding a mark here means REMOVING its pattern from BRAND_PATTERNS; the tests
// pin both directions.
//
// Ordered longest-phrase-first; each pattern removes every occurrence.
const P = (s) => new RegExp(`\\b(?:${s})\\b`, "gi");
export const BRAND_PATTERNS = [
  // multi-word phrases and their fragments/misspellings first
  P("new balance"),
  P("new era"),
  P("hugo boss|boss|hugo"),
  P("karl lagerfeld|kalr lagerfeld|karl|kalr"),
  P("g[\\s-]?star"),
  P("fear of god|essentials|essentially|essential"),
  P("loro piana"),
  P("louis vuitton|lv"),
  P("dolce ?(?:&|and)? ?gabbana|d&g"),
  P("emporio armani|armani exchange|giorgio armani|armani|armai|emporio|glorgio"),
  P("under armou?r"),
  P("alo yoga|alo"),
  P("calvin klein|kelvin klein|ck"),
  P("tommy hilfiger|tommy"),
  P("the north face|north face"),
  P("off[\\s-]?white"),
  P("true religion"),
  P("stone island"),
  P("ralph lauren|polo ralph(?: lauren)?"),
  P("daniel wellington"),
  P("dr\\.? martens?"),
  P("michael kors"),
  P("saint laurent|ysl"),
  P("alexander mcqueen|mcqueen"),
  P("brunello cucinelli"),
  P("comme des gar[cç]ons|cdg"),
  P("philipp plein|phillip plein|plein"),
  P("bottega veneta|bottega"),
  P("dsquared2|dsquared"),
  P("a bathing ape|bape"),
  P("levi[’']?s?"),
  // single-word marks (incl. live misspellings)
  P("nike"),
  P("adidas"),
  P("puma"),
  P("lacoste|lacoster|lacosta"),
  P("gucci|guccie|guccl"),
  P("diesel"),
  P("timberland"),
  P("replay"),
  P("versace"),
  P("amiri"),
  P("dior"),
  P("birkenstock"),
  P("prada"),
  P("balenciaga"),
  P("converse"),
  P("givenchy|giavceye"),
  P("umbro"),
  P("reebok"),
  P("balr"),
  P("moncler"),
  P("ugg"),
  P("valentino"),
  P("vans"),
  P("chanel"),
  P("swarovski"),
  P("hoka"),
  P("rhude"),
  P("iceberg"),
  P("represent"),
  P("loewe"),
  P("celine"),
  P("rolex"),
  P("hermes"),
  P("skechers"),
  P("stussy|stüssy"),
  P("zara"),
  P("asics"),
  P("burberry"),
];

// "On" (On Running): leading word only, and only in front of its own model
// vocabulary, so ordinary uses of "on" survive.
const ON_LEADING = /^on\s+(?=cloud|running\b)/i;

// Tidy what brand removal leaves behind: collapse whitespace, drop orphaned
// separators, re-capitalise the first letter. Never invents words.
function tidy(s) {
  let out = s
    .replace(/\s+/g, " ")
    .replace(/\s+([:,])/g, "$1")
    .replace(/^[\s\-–—:,/&.]+/, "")
    .replace(/[\s\-–—:,/&]+$/, "")
    .replace(/(\s)[-–—](\s)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : "";
}

// Strip every brand word from a product name. Returns "" when the name was
// nothing but brand (e.g. "Louis Vuitton") — the caller must flag those for
// manual naming rather than push an empty title.
export function stripBrandFromName(name) {
  let s = String(name ?? "");
  s = s.replace(ON_LEADING, "");
  for (const re of BRAND_PATTERNS) s = s.replace(re, " ");
  return tidy(s);
}

// ── Title guards: never ship a broken title ──────────────────────────────────
// The strip can gut a name whose identity WAS the brand ("Louis Vuitton " → "")
// or leave a fragment that reads wrong as a listing ("New balance 9060 creem"
// → "9060 creem", digit-leading). A violating rewrite is not repaired — the
// ORIGINAL name ships unchanged (whitespace-trimmed only) and the product is
// flagged for manual naming via the report list.
//
// This is the one entry point the Shopify push uses; stripBrandFromName stays
// exported for tests/reporting but callers building payloads go through here.
export function shopifyTitle(name) {
  const original = String(name ?? "").trim();
  const stripped = stripBrandFromName(original);
  const reason =
    stripped === "" ? "empty after strip"
    : /^\d/.test(stripped) ? "digit-leading after strip"
    : stripped.length < 3 ? "shorter than 3 chars after strip"
    : null;
  return reason
    ? { title: original, flagged: true, reason }
    : { title: stripped, flagged: false, reason: null };
}

// The brand words present in a name (canonical spelling of each match) —
// used by tests to prove no brand survives, and by reporting.
export function brandsIn(name) {
  const s = String(name ?? "");
  const hits = [];
  if (ON_LEADING.test(s)) hits.push("On");
  for (const re of BRAND_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(s)) hits.push(re.source.replace(/^\\b\(\?:/, "").split("|")[0]);
  }
  return hits;
}
