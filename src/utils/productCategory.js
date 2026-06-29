// ─── PRODUCT CATEGORY CLASSIFIER — single source of truth ─────────────────────
// One pure function, used by BOTH (a) auto-assign on product create (Add Product +
// bulk-load scripts) and (b) the one-time backfill of the 2,241 existing products.
// Same input → same output everywhere, so the catalogue can never drift between
// the two jobs.
//
// HOW IT DECIDES (priority order):
//   1. Size-agnostic keyword overrides — accessories (bag/belt/glove/balaclava) and
//      caps. These win over size because a Nike balaclava or a one-size cap would
//      otherwise be mis-shelved by its size set.
//   2. SIZE CLASS — the reliable signal (the /products `category`/`productType`
//      fields are empty on ~98% of records, but sizes are present): numeric UK/US
//      sizes → FOOTWEAR; letter / waist sizes → CLOTHING; one-size → PERFUME.
//   3. NAME KEYWORDS sub-type within footwear / clothing.
//   4. Unmatched clothing → "Clothing — Uncategorized" (the manual-review bucket).
//
// Returns { category, subcategory, brand }. `category` is the top level the POS
// browses; `subcategory` the leaf; `brand` parsed from the brand-first name.

// ── The category tree (also drives the POS browse chips + the review dropdown) ──
export const CATEGORY_TREE = {
  Footwear:    ["Sneakers", "Soccer Boots", "Sandals & Slides", "Boots"],
  Clothing:    ["T-Shirts", "Caps & Hats", "Tracksuits & Sets", "Jeans & Denim", "Polos",
                "Hoodies & Sweatshirts", "Jackets & Coats", "Cargos & Pants", "Shorts & Vests",
                "Clothing — Uncategorized"],
  Accessories: ["Bags", "Belts", "Gloves", "Balaclavas & Masks"],
  Perfume:     ["Perfume"],
};
export const TOP_CATEGORIES = Object.keys(CATEGORY_TREE);
export const UNCATEGORIZED = "Clothing — Uncategorized";

// ── Size class (mirrors the POS src/shared/sizeClass.js contract) ──────────────
const CLOTHING_LETTER_RE = /^(XS|S|M|L|X+L|[2-9]X+L)$/;
const WAIST_MIN = 28; // numeric ≥ 28 is a pants waist (clothing); below is a shoe.

function sizeArray(sizes) {
  if (Array.isArray(sizes)) return sizes.map((s) => String(s).trim()).filter(Boolean);
  if (sizes && typeof sizes === "object") return Object.values(sizes).map((s) => String(s).trim()).filter(Boolean);
  return [];
}

// "footwear" | "clothing" | "onesize" | "none"
export function sizeClass(sizes) {
  const arr = sizeArray(sizes);
  if (!arr.length) return "none";
  if (arr.length === 1 && (arr[0] === "_" || arr[0] === "")) return "onesize";
  let letter = 0, shoe = 0;
  for (const s of arr) {
    const u = s.toUpperCase();
    if (CLOTHING_LETTER_RE.test(u)) { letter++; continue; }
    if (/^\d+(\.\d+)?$/.test(u)) {
      if (Number(u) >= WAIST_MIN) letter++;   // waist → clothing
      else shoe++;                            // UK/US shoe number
    }
  }
  if (letter === 0 && shoe === 0) return "onesize"; // only "_"/unknown tokens
  return shoe > letter ? "footwear" : "clothing";
}

// ── Brand (parsed from the brand-first cleaned names) ──────────────────────────
// Multi-word / alias brands first; otherwise the first name token. Returns null
// for code-only / unbranded supplier names (e.g. "Lx:1222", "Barley 8290").
const BRAND_ALIASES = [
  [/^air jordan\b/, "Jordan"], [/^jordan\b/, "Jordan"],
  [/^hugo boss\b/, "Boss"], [/^boss\b/, "Boss"],
  [/^karl lagerfeld\b/, "Karl Lagerfeld"],
  [/^g[\s-]?star\b/, "G-Star"],
  [/^new balance\b/, "New Balance"],
  [/^fear of god\b/, "Fear of God"],
  [/^loro piana\b/, "Loro Piana"],
  [/^louis vuitton\b/, "Louis Vuitton"],
  [/^dolce ?(&|and)? ?gabbana\b/, "Dolce & Gabbana"],
  [/^(emporio |armani exchange|armani)\b/, "Armani"],
  [/^under armour\b/, "Under Armour"],
  [/^alo( yoga)?\b/, "Alo"],
  [/^calvin klein\b/, "Calvin Klein"],
  [/^tommy( hilfiger)?\b/, "Tommy Hilfiger"],
  [/^the north face\b/, "The North Face"],
  [/^off[\s-]?white\b/, "Off-White"],
  [/^true religion\b/, "True Religion"],
  [/^stone island\b/, "Stone Island"],
  [/^ralph lauren\b|^polo ralph\b/, "Ralph Lauren"],
];

export function brandOf(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  const low = n.toLowerCase();
  for (const [re, brand] of BRAND_ALIASES) if (re.test(low)) return brand;
  const tok = n.split(/\s+/)[0].replace(/[^A-Za-z0-9&'+-]/g, "");
  // Not a brand: empty, numeric-leading, no letters at all, or a supplier code
  // (short alpha prefix immediately followed by digits — "Lx1222", "GS5222", "Hb001").
  if (!tok || /^\d/.test(tok) || !/[A-Za-z]/.test(tok) || /^[A-Za-z]{1,3}\d/.test(tok)) return null;
  return tok.charAt(0).toUpperCase() + tok.slice(1);
}

// ── Keyword maps (order matters within each list — first hit wins) ─────────────
const ACCESSORY_KW = [
  ["Balaclavas & Masks", /\bbalaclava|ski[\s-]?mask|face[\s-]?mask|ninja[\s-]?mask/],
  ["Bags",  /\bbag\b|\bbags\b|backpack|\bduffel|\bduffle|holdall|\bpouch\b|\btote\b|crossbody|\bsling\b/],
  ["Belts", /\bbelt\b|\bbelts\b/],
  ["Gloves", /\bglove/],
];
const CAP_KW = /\bcap\b|\bcaps\b|snapback|\bbeanie|bucket\s?hat|\bhat\b/;

const FOOTWEAR_KW = [
  ["Soccer Boots", /\bsoccer\b|football boot|\bmercurial|\bsuperfly|\bpredator|\btiempo|\bmorelia|\bnemeziz|\bcopa\b|\bcleats?\b|\bphantom\b.*\b(fg|sg|ag|tf|ic|mg)\b|\b(fg|sg|ag|tf|mg)\b/],
  ["Sandals & Slides", /\bsandal|\bslides?\b|flip[\s-]?flop|birkenstock|\bslipper|\bclog/],
  ["Boots", /\bboots?\b|timberland|chelsea boot/],
];
const CLOTHING_KW = [
  ["T-Shirts", /\bt[\s-]?shirts?\b|\btee\b|\btees\b/],
  ["Polos", /\bpolo\b/],
  ["Jeans & Denim", /\bjeans?\b|\bdenim\b/],
  ["Shorts & Vests", /\bshorts?\b|sweatshort|\bvest\b|\btank\b/],
  ["Cargos & Pants", /\bcargo|\bchino/],
  ["Tracksuits & Sets", /track\s?suit|tracksuit|track\s?pant|\bjogger|tech\s?fleece|\bset\b|two[\s-]?piece|2[\s-]?piece/],
  ["Hoodies & Sweatshirts", /\bhoodie|hooded|sweat\s?shirt|sweatshirt|\bsweater|\bjumper|pullover|crew\s?neck|\bfleece\b/],
  ["Jackets & Coats", /\bjacket|\bcoat\b|windrunner|\bpuffer|\bbomber|\bparka|\bgilet|windbreak/],
  ["Cargos & Pants", /\bpants?\b|\btrouser/],
];

function firstMatch(map, low) {
  for (const [label, re] of map) if (re.test(low)) return label;
  return null;
}

// ── The classifier ─────────────────────────────────────────────────────────────
export function categorize(name, sizes) {
  const brand = brandOf(name);
  const low = String(name || "").toLowerCase();

  // 1. Size-agnostic overrides.
  const acc = firstMatch(ACCESSORY_KW, low);
  if (acc) return { category: "Accessories", subcategory: acc, brand };
  if (CAP_KW.test(low)) return { category: "Clothing", subcategory: "Caps & Hats", brand };

  // 2/3. Size class → sub-type.
  const cls = sizeClass(sizes);
  if (cls === "footwear") {
    return { category: "Footwear", subcategory: firstMatch(FOOTWEAR_KW, low) || "Sneakers", brand };
  }
  if (cls === "clothing") {
    return { category: "Clothing", subcategory: firstMatch(CLOTHING_KW, low) || UNCATEGORIZED, brand };
  }
  // onesize / none → Perfume (the only one-size class in this catalogue today).
  return { category: "Perfume", subcategory: "Perfume", brand };
}
