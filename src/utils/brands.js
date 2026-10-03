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
  { brand: "Adidas", aliases: ["adidas", "yeezy", "samba"] },
  { brand: "Lacoste", aliases: ["lacoste", "lacoster", "lacosta", "locoste"] },
  { brand: "Boss", aliases: ["hugo boss", "boss", "boos", "hugo", "higo boss", "higo"] },
  { brand: "Karl Lagerfeld", aliases: ["karl lagerfeld", "kalr lagerfeld", "karl", "kalr"] },
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
  { brand: "Tiffany & Co.", aliases: ["tiffany & co", "tiffany"] },
  { brand: "Matin Kim", aliases: ["matin kim"] },
  { brand: "John Richmond", aliases: ["john richmond"] },
  { brand: "Fear of God", aliases: ["fear of god"] },
  { brand: "Fear of God", aliases: ["essentials", "essential", "essentially"], start: true },
  { brand: "New Balance", aliases: ["new balance"] },
  { brand: "New Era", aliases: ["new era", "59fifty", "9fifty"] },
  { brand: "G-Star", aliases: ["g-star", "g star", "gstar"] },
  { brand: "The North Face", aliases: ["the north face", "north face"] },
  { brand: "Ralph Lauren", aliases: ["ralph lauren", "polo ralph"] },
  { brand: "Tommy Hilfiger", aliases: ["tommy hilfiger", "tommy"] },
  { brand: "Off-White", aliases: ["off-white", "off white"] },
  { brand: "True Religion", aliases: ["true religion"] },
  { brand: "Stone Island", aliases: ["stone island"] },
  { brand: "Levi's", aliases: ["levi's", "levis", "levi’s", "levi"] },
  { brand: "Stüssy", aliases: ["stussy", "stüssy"] },
  { brand: "Purple Brand", aliases: ["purple brand", "purple-brand", "purple bland", "purple-bland"] },
  { brand: "On", aliases: ["on running", "on cloud", "on"], start: true },
  { brand: "Alo", aliases: ["alo yoga", "alo"], start: true },
  { brand: "Represent", aliases: ["represent"], start: true },
  { brand: "Replay", aliases: ["replay"], start: true },
  { brand: "Iceberg", aliases: ["iceberg"], start: true },
  { brand: "Vans", aliases: ["vans"], start: true },
  { brand: "DC", aliases: ["dc"], start: true },
  // Brands that are not ordinary words — recognised anywhere in the name.
  ...["Versace", "Amiri", "Puma", "Balenciaga", "Givenchy", "Converse", "Umbro", "Dsquared2", "Reebok", "Valentino", "BALR",
    "UGG", "Moncler", "Swarovski", "Chanel", "Celine", "Rolex", "Hoka", "Loewe", "Nocta", "Rhude", "Miu Miu", "Fendi", "Burberry",
    "Lululemon", "Vlone", "Fila", "Kappa", "Hummel", "Skechers", "Zara", "Benetton", "Cartier", "Descente", "Affliction",
    "Supreme", "Havaianas", "Vialli", "Moschino", "Balmain", "Kenzo", "Asics", "Salomon", "Crocs", "Golden Goose", "Jacquemus",
    "Ami Paris", "Palm Angels", "Trapstar", "Corteiz", "Hellstar", "Chrome Hearts", "Casablanca", "Barrow"].map((b) => ({
    brand: b, aliases: b === "Dsquared2" ? ["dsquared2", "dsquared"] : b === "Havaianas" ? ["havaianas", "havanas"] : b === "Descente" ? ["descente", "descent"] : [b.toLowerCase()],
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

const fold = (s) => ` ${String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’'`.]/g, "").replace(/[^a-z0-9&]+/g, " ").trim()} `;

/**
 * The brand in a product name: { brand, flag }.
 *   brand  the canonical brand, or null
 *   flag   null, or "unrecognised" when the name names no known brand and does
 *          not lead with a known supplier label (someone should set the brand)
 * The EARLIEST brand in the name wins ("Supreme x Nike" → Supreme), except that
 * list order decides between overlapping spellings ("air jordan" before "nike").
 * Pure.
 */
export function brandInfo(name) {
  const t = fold(name);
  if (t.trim() === "") return { brand: null, flag: null };
  let best = null;
  for (const [order, b] of BRANDS.entries()) {
    for (const a of b.aliases) {
      const fa = fold(a);
      const at = b.start ? (t.startsWith(fa) ? 0 : -1) : t.indexOf(fa);
      if (at < 0) continue;
      if (!best || at < best.at || (at === best.at && order < best.order)) best = { at, order, brand: b.brand };
    }
  }
  // An Air Jordan named "Nike Air Jordan" is a Jordan.
  if (best && best.brand === "Nike" && / (air jordan|jordan ?1?) /.test(t)) return { brand: "Jordan", flag: null };
  if (best) return { brand: best.brand, flag: null };
  const first = t.trim().split(" ")[0];
  if (SUPPLIER_LABELS.includes(first) || /^[a-z]{1,4}\d/.test(first) || /^\d/.test(first)) return { brand: null, flag: null };
  return { brand: null, flag: "unrecognised" };
}

/** Is this stored value one of the canonical brands? Pure. */
export const isCanonicalBrand = (v) => BRANDS.some((b) => b.brand === v);
