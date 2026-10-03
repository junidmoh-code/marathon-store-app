// ── THE BRAND LIST — the only place a product's brand comes from ─────────────
// Junid, 3 Oct: a name whose brand is not recognised gets NO brand (and a
// flag for review), never its first word. Before this, brandOf stored the
// first word of any name it did not know — first names ("Christian",
// "Alexander", "Daniel"), garment words ("T-shirt", "Denim"), colours
// ("Black") — about a fifth of the catalogue.
//
// Each entry: canonical brand, the spellings that mean it (staff typos seen in
// the data included), and `start: true` for brands that are also ordinary words
// ("On", "Alo", "Represent"): those count only as the FIRST word of a name.
// Matching is on whole words, case-insensitive, punctuation-folded.
export const BRANDS = Object.freeze([
  // Sub-brand rules first: an Air Jordan is a Jordan even with "Nike" in the name.
  { brand: "Jordan", aliases: ["air jordan", "jordan", "jordan1", "jumpman"] },
  { brand: "Nike", aliases: ["nike", "air force", "airforce", "air max", "nikeairmax", "nike sb", "air nike"] },
  { brand: "Adidas", aliases: ["adidas", "yeezy"] },
  { brand: "Adidas", aliases: ["samba"], start: true },
  { brand: "Lacoste", aliases: ["lacoste", "lacoster", "lacosta", "locoste"] },
  { brand: "Boss", aliases: ["hugo boss", "boss", "boos", "higo boss"] },
  { brand: "Boss", aliases: ["hugo", "higo"], start: true },
  { brand: "Karl Kani", aliases: ["karl kani"] },
  { brand: "Karl Lagerfeld", aliases: ["karl lagerfeld", "kalr lagerfeld"] },
  { brand: "Karl Lagerfeld", aliases: ["karl", "kalr"], start: true },
  { brand: "Christian Louboutin", aliases: ["christian louboutin", "louboutin", "loubiton", "christina louboutin", "christians louboutin"] },
  { brand: "Alexander McQueen", aliases: ["alexander mcqueen", "alexander mc queen", "mcqueen", "mc queen", "alexandra maqueen", "maqueen"] },
  { brand: "Louis Vuitton", aliases: ["louis vuitton", "lv"] },
  { brand: "Dolce & Gabbana", aliases: ["dolce & gabbana", "dolce and gabbana", "dolce&gabbana", "dolce gabbana", "d&g"] },
  { brand: "Armani", aliases: ["giorgio armani", "glorgio armani", "emporio armani", "empirio armani", "armani exchange", "armani", "armai"] },
  { brand: "Diesel", aliases: ["diesel", "diesal"] },
  { brand: "Gucci", aliases: ["gucci", "guccie", "guccl"] },
  { brand: "Dior", aliases: ["christian dior", "dior"] },
  { brand: "Prada", aliases: ["prada", "plada", "planda", "pranda"] },
  { brand: "Hermès", aliases: ["hermes", "hermès", "hemes"] },
  { brand: "Timberland", aliases: ["timberland", "timbalend"] },
  { brand: "Birkenstock", aliases: ["birkenstock", "birkestock"] },
  { brand: "Calvin Klein", aliases: ["calvin klein", "kelvin klein"] },
  { brand: "Calvin Klein", aliases: ["ck"], start: true },
  { brand: "Michael Kors", aliases: ["michael kors", "micheal kors"] },
  { brand: "Daniel Wellington", aliases: ["daniel wellington", "deniel wellington"] },
  { brand: "Philipp Plein", aliases: ["philipp plein", "phillip plein", "phillip plain", "philipp-plein"] },
  { brand: "Loro Piana", aliases: ["loro piana", "lori piano", "loro piano", "rolo piana"] },
  { brand: "Brunello Cucinelli", aliases: ["brunello cucinelli", "brunello"] },
  { brand: "Dr. Martens", aliases: ["dr martens", "dr. martens", "doc martens"] },
  { brand: "Under Armour", aliases: ["under armour", "under amour"] },
  { brand: "Ray-Ban", aliases: ["ray-ban", "ray ban", "rayban"] },
  { brand: "Bottega Veneta", aliases: ["bottega veneta", "bottega"] },
  { brand: "Comme des Garçons", aliases: ["comme des garcons", "comme des garçons", "cdg"] },
  { brand: "Montblanc", aliases: ["montblanc", "mont blanc", "montblaknc"] },
  { brand: "Saint Michael", aliases: ["saint michael"] },
  { brand: "Paul & Shark", aliases: ["paul & shark", "paul and shark", "paul&shark"] },
  { brand: "Gallery Dept.", aliases: ["gallery dept", "gallery dept."] },
  { brand: "Enfants Riches Déprimés", aliases: ["enfants riches deprimes", "enfants riches déprimés", "infants riches deprimes"] },
  { brand: "BAPE", aliases: ["bape", "a bathing ape", "bapesta"] },
  { brand: "Patek Philippe", aliases: ["patek philippe", "patek"] },
  { brand: "Tiffany & Co.", aliases: ["tiffany & co", "tiffany and co"] },
  // Never bare "tiffany": it is also a colourway ("Tiffany blue Nike Dunk").
  { brand: "Matin Kim", aliases: ["matin kim"] },
  { brand: "John Richmond", aliases: ["john richmond"] },
  { brand: "Fear of God", aliases: ["fear of god"] },
  { brand: "Fear of God", aliases: ["essentials", "essential", "essentially"], start: true },
  { brand: "New Balance", aliases: ["new balance"] },
  { brand: "New Era", aliases: ["new era", "59fifty", "9fifty"] },
  { brand: "G-Star", aliases: ["g-star", "g star", "gstar"] },
  { brand: "The North Face", aliases: ["the north face", "north face"] },
  { brand: "Ralph Lauren", aliases: ["ralph lauren", "polo ralph"] },
  { brand: "Tommy Hilfiger", aliases: ["tommy hilfiger"] },
  { brand: "Tommy Hilfiger", aliases: ["tommy"], start: true },
  { brand: "Off-White", aliases: ["off-white", "off white"] },
  { brand: "True Religion", aliases: ["true religion"] },
  { brand: "Stone Island", aliases: ["stone island"] },
  { brand: "Levi's", aliases: ["levi's", "levis", "levi’s"] },
  { brand: "Levi's", aliases: ["levi"], start: true },
  { brand: "Stüssy", aliases: ["stussy", "stüssy"] },
  { brand: "Purple Brand", aliases: ["purple brand", "purple-brand", "purple bland", "purple-bland"] },
  // Never the bare word "on" ("On sale", "On feet"): only the shoe lines.
  { brand: "On", aliases: ["on running", "on cloud", "cloudmonster", "cloudsurfer", "cloudnova"] },
  { brand: "Alo", aliases: ["alo yoga", "alo"], start: true },
  { brand: "Represent", aliases: ["represent"], start: true },
  { brand: "Replay", aliases: ["replay"], start: true },
  { brand: "Iceberg", aliases: ["iceberg"], start: true },
  { brand: "Giuseppe Zanotti", aliases: ["giuseppe zanotti", "zanotti"] },
  { brand: "Onitsuka Tiger", aliases: ["onitsuka tiger", "onitsuka"] },
  { brand: "DC", aliases: ["dc shoes"] },
  { brand: "Zara", aliases: ["zara"], start: true },
  { brand: "Fila", aliases: ["fila"], start: true },
  { brand: "Vans", aliases: ["vans"], start: true },
  // Brands that are not ordinary words — recognised anywhere in the name.
  ...["Versace", "Amiri", "Puma", "Balenciaga", "Givenchy", "Converse", "Umbro", "Dsquared2", "Reebok", "Valentino", "BALR",
    "UGG", "Moncler", "Swarovski", "Chanel", "Celine", "Rolex", "Hoka", "Loewe", "Nocta", "Rhude", "Miu Miu", "Fendi", "Burberry",
    "Lululemon", "Vlone", "Kappa", "Hummel", "Skechers", "Benetton", "Cartier", "Descente", "Affliction",
    "Supreme", "Havaianas", "Vialli", "Moschino", "Balmain", "Kenzo", "Asics", "Salomon", "Crocs", "Golden Goose", "Jacquemus",
    "Ami Paris", "Palm Angels", "Trapstar", "Corteiz", "Hellstar", "Chrome Hearts", "Casablanca", "Barrow"].map((b) => ({
    brand: b, aliases: b === "Dsquared2" ? ["dsquared2", "dsquared"] : b === "Havaianas" ? ["havaianas", "havanas"] : b === "Descente" ? ["descente"] : [b.toLowerCase()],
  })),
]);

// Supplier / house labels: real labels, but NOT brands. A name that leads with
// one is unbranded — no brand, and no flag (nothing for anyone to look at).
export const SUPPLIER_LABELS = Object.freeze(["yomo", "yono", "shouzhan", "shouzhani", "shouzahani", "shou", "shambeen", "shambeent", "shabeen",
  "yishanhou", "yishanshou", "barley", "barley-damai", "bluremo", "bruremo", "bluerty", "rendttk", "paganism", "paganism-ete", "liaoxun",
  "giavceye", "bangouluo", "mojia", "chaolepai", "chaolpai", "aborfend", "bansongjin", "bansong", "blamacar", "blamahar", "wanchao",
  "jaja&nana", "canong", "agzian", "ceooo", "gongyi", "gongy", "parlamenter", "jie", "mf", "ms", "m", "mfour", "glfs", "lx", "bs", "ykk",
  "jinyaotong", "pattabon", "xds", "allaccess", "allaccese", "wululu", "ommf", "nakamajiang", "qiexu", "chaoxianxing", "csfgang", "bvtd",
  "borsod", "nsiminte", "extreme", "seventeen", "dkey", "hscp", "crv", "cvt", "aloha"]);

// A supplier code: "Lx:1222", "Bs-8022", "GS5222", "8290 Barley" — a digit
// first, or 1–2 letters then digits, or 3–4 letters glued to digits. Never a
// brand + model ("Nike 270", "Jordan 4").
const CODE_RE = /^(\d|[a-z]{1,2} ?\d|[a-z]{3,4}\d)/;
// Folded the same way names are, so "jaja&nana" matches "Jaja&Nana tee".
let SUPPLIER_FOLDED;
// Apostrophes vanish ("Levi’s" → "levis"); dots and "&" become separate words
// ("Dr.Martens" → "dr martens", "Tiffany&Co" → "tiffany & co").
const fold = (s) => ` ${String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[’'`]/g, "").replace(/&/g, " & ").replace(/[^a-z0-9&]+/g, " ").replace(/ +/g, " ").trim()} `;

/**
 * The brand in a product name: { brand, flag, source }.
 *   brand   the canonical brand, or null
 *   flag    null, or "unrecognised" when the name names no known brand and does
 *           not lead with a known supplier label (someone should set the brand)
 *   source  "list" (found in the name), "supplier" (a supplier label or code —
 *           unbranded on purpose), or null (nothing recognised)
 * Stored as products/{pid}/brand, brandFlag (omitted when null) and brandSource;
 * a brand set by hand is brandSource "manual" and is never re-derived.
 * The EARLIEST brand in the name wins ("Supreme x Nike" → Supreme), except that
 * list order decides between overlapping spellings ("air jordan" before "nike").
 * Pure.
 */
export function brandInfo(name) {
  const t = fold(name);
  if (t.trim() === "") return { brand: null, flag: null, source: null };
  // A name that LEADS with a supplier label or a code is unbranded — checked
  // before any brand ("Shambeen Nike tee" is a Shambeen tee with a print).
  if (SUPPLIER_FOLDED.some((l) => t.startsWith(` ${l} `)) || CODE_RE.test(t.trim())) return { brand: null, flag: null, source: "supplier" };
  let best = null;
  for (const [order, b] of BRANDS.entries()) {
    for (const a of b.aliases) {
      const fa = fold(a);
      const at = b.start ? (t.startsWith(fa) ? 0 : -1) : t.indexOf(fa);
      if (at < 0) continue;
      if (!best || at < best.at || (at === best.at && order < best.order)) best = { at, order, brand: b.brand };
    }
  }
  // An Air Jordan named "Nike Air Jordan" is a Jordan — but only the shoe line
  // ("air jordan", "jordan 1…"), never "Michael Jordan" on a Nike tee.
  if (best && best.brand === "Nike" && / (air jordan|jordan \d+) /.test(t)) return { brand: "Jordan", flag: null, source: "list" };
  if (best) return { brand: best.brand, flag: null, source: "list" };
  return { brand: null, flag: "unrecognised", source: null };
}

/**
 * The brand fields to write when a product's NAME changes: re-derived only when
 * the product has no brand or a flagged one — never over a brand that is set
 * (by the list, a correction or by hand). Returns null for "leave the brand". Pure.
 */
export function brandOnRename(product, newName) {
  if (!product || product.brandSource === "manual") return null;
  if (String(product.brand ?? "").trim()) return null; // a set brand is never re-derived, flagged or not
  const r = brandInfo(newName);
  return { brand: r.brand, brandFlag: r.flag, brandSource: r.source };
}

SUPPLIER_FOLDED = SUPPLIER_LABELS.map((l) => fold(l).trim());

/** Is a stored value a supplier label (unbranded on purpose)? Pure. */
export const isSupplierLabel = (v) => SUPPLIER_FOLDED.includes(fold(v).trim()) || CODE_RE.test(fold(v).trim());

/**
 * A brand read off a LABEL or LOGO (vision, a box): the whole read is the
 * brand mark, so an exact short mark counts ("DC", "ON", "Tiffany & Co") even
 * where the same word inside a product NAME would not. Falls back to brandInfo.
 * Pure.
 */
export function brandFromLabel(read) {
  const t = fold(read).trim();
  if (!t || t === "none" || t === "unclear") return null;
  for (const b of BRANDS) if (fold(b.brand).trim() === t || b.aliases.some((a) => fold(a).trim() === t)) return b.brand;
  return brandInfo(read).brand;
}

/** Is this stored value one of the canonical brands? Pure. */
export const isCanonicalBrand = (v) => BRANDS.some((b) => b.brand === v);
