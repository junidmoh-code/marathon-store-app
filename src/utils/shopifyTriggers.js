// ─── BRAND-TRIGGER ENGINE v2 — the Shopify compliance chokepoint ──────────────
// Marathon Club cannot list goods as branded: the payment gateway keyword-flags
// brand terms in ANY pushed field and a hit triggers a documentation review.
// This module is the ONE place that knows what a "brand trigger" is. Everything
// that builds or checks Shopify-bound text — the push scripts, the pre-flight
// payload validator, and the home-page card's live input check — imports from
// here. Pure functions, no I/O, browser- and Node-safe.
//
// THREE trigger categories (owner spec 2026-08-13, REVERSING the earlier
// "line marks stay" decision — Air Jordan / Jordan / NOCTA are stripped now):
//   (a) parent brands  — Nike, adidas, Gucci, … incl. every misspelling that
//       actually occurs in the live catalogue (Lacoster, Guccie, Kelvin Klein…)
//   (b) sub-labels & collabs — NOCTA, Essentials/Fear of God, Yeezy, Off-White,
//       Travis Scott / Cactus Jack, Supreme, Palace, Stussy, Kith, CPFM, …
//   (c) MODEL / SILHOUETTE names — Air Force, Air Max, Dunk, Samba, Gazelle,
//       Predator, Mercurial, 9060, 550, Chuck Taylor, Old Skool, Gripshot, …
//
// MATCHING CONTRACT. No trigger may survive in output, including inside
// hyphenated or concatenated tokens, matched case- and space-insensitively
// ("airforce", "Air-Force", "AIRFORCE1"). Two match modes:
//   • "squash" (default) — the trigger's letters, ignoring case and every
//     non-alphanumeric char, appearing ANYWHERE in the equally-squashed text.
//     Catches "NikeAirMax", "off-white", "walk'n'dior", "Jordan1".
//   • "word" — exact word-sequence only. For short or collision-prone terms
//     where squash matching would shred innocent words: "ck" is inside
//     "black", "asics" inside "classics", "alo" inside "aloha", "air" inside
//     "fair". Word mode still matches case-insensitively across "-"/spaces.
// The list was seeded from the mandated set, then EXTENDED from a 2026-08-13
// census of all 4,166 live names (411 distinct brand-field values, token and
// bigram frequency) — every extension is annotated inline.
//
// DELIBERATE BOUNDARIES (unchanged from slice 1, not reversed by the owner):
//   • Obscure supplier house-marks (YOMO, Shouzhan, Bangouluo…) are NOT
//     triggers — for those lines the mark effectively IS the product identity
//     and no payment gateway keys on them.
//   • Football club / team / country names (Arsenal, Barcelona, Red Sox…)
//     stay — they are the product, not the maker. EXCEPTIONS: "Arizona" and
//     "Boston" ARE triggers (Birkenstock silhouettes, 14 of 18 live uses);
//     the 2-3 team caps that lose their city word get a dull-but-safe name.
//   • "Polo" alone is a garment, never stripped. Only "Polo Ralph (Lauren)".
//   • "On" (On Running) is only stripped as the LEADING word before its own
//     model vocabulary; its model names (Cloud*) are triggers in their own
//     right.

// T(spec, opts) — spec is the canonical word sequence, space-separated.
// alts: alternative spellings/misspellings folded onto the same label.
const T = (spec, { mode = "squash", cat = "model", alts = [], label } = {}) => ({
  label: label ?? spec,
  cat,
  mode,
  variants: [spec, ...alts].map((v) => ({
    words: v.toLowerCase().split(" "),
    sq: v.toLowerCase().replace(/[^a-z0-9]+/g, ""),
  })),
});

export const TRIGGERS = [
  // ── (a) PARENT BRANDS ──────────────────────────────────────────────────────
  T("nike", { cat: "parent" }),                       // squash: also ENike, Nikeairmax
  T("adidas", { cat: "parent" }),
  T("puma", { cat: "parent" }),
  T("new balance", { cat: "parent" }),
  T("jordan", { cat: "parent" }),                     // REVERSED line-mark keep; squash catches "Jordan1"
  T("gucci", { cat: "parent", alts: ["guccie", "guccl"] }),
  T("louis vuitton", { cat: "parent" }),
  T("lv", { cat: "parent", mode: "word" }),
  T("rolex", { cat: "parent" }),
  T("hugo boss", { cat: "parent" }),
  T("boss", { cat: "parent", mode: "word", alts: ["boos", "hugo", "higo"] }), // word: "embossed"
  T("calvin klein", { cat: "parent", alts: ["kelvin klein"] }),
  T("ck", { cat: "parent", mode: "word" }),
  T("lacoste", { cat: "parent", alts: ["lacoster", "lacosta", "locoste"] }),
  T("ralph lauren", { cat: "parent", alts: ["polo ralph lauren", "polo ralph"] }),
  T("on running", { cat: "parent", mode: "word" }),   // word: squash is inside "…ton running…"; leading-"On" handled separately
  T("asics", { cat: "parent", mode: "word" }),        // word: inside "classics"/"basics"
  T("reebok", { cat: "parent" }),
  T("converse", { cat: "parent" }),
  T("vans", { cat: "parent", mode: "word" }),         // word: inside "caravans"
  T("under armour", { cat: "parent", alts: ["under armor"] }),
  T("fila", { cat: "parent", mode: "word" }),         // word: inside "profilaxis"-shaped tokens
  T("timberland", { cat: "parent", alts: ["timbalend"] }),
  T("crocs", { cat: "parent" }),
  T("birkenstock", { cat: "parent", alts: ["birkestock"] }),
  T("dr martens", { cat: "parent", alts: ["doc martens", "martens"] }),
  T("new era", { cat: "parent" }),
  T("59fifty", { cat: "parent" }),                    // New Era trademark (census: 27 caps)
  T("karl lagerfeld", { cat: "parent", alts: ["kalr lagerfeld"] }),
  T("karl", { cat: "parent", mode: "word", alts: ["kalr"] }),
  T("lagerfeld", { cat: "parent" }),
  T("g star", { cat: "parent", label: "g-star" }),
  T("fear of god", { cat: "sublabel" }),
  T("essentials", { cat: "sublabel", alts: ["essential", "essentially"] }),
  T("loro piana", { cat: "parent" }),
  T("dolce gabbana", { cat: "parent", alts: ["dolce and gabbana", "dolce & gabbana"] }),
  T("d g", { cat: "parent", mode: "word", label: "d&g" }),
  T("armani", { cat: "parent", alts: ["armai", "emporio", "glorgio", "giorgio armani", "empirio"] }),
  T("alo", { cat: "parent", mode: "word" }),          // word: inside "aloha" (2 live records)
  T("alo yoga", { cat: "parent" }),
  T("tommy hilfiger", { cat: "parent" }),
  T("tommy", { cat: "parent", mode: "word" }),
  T("north face", { cat: "parent", alts: ["the north face"] }),
  T("true religion", { cat: "parent" }),
  T("stone island", { cat: "parent" }),
  T("daniel wellington", { cat: "parent", alts: ["deniel wellington", "wellington"] }), // census: bare "wellington" only ever the watch brand
  T("michael kors", { cat: "parent" }),
  T("saint laurent", { cat: "parent" }),
  T("ysl", { cat: "parent", mode: "word" }),
  T("alexander mcqueen", { cat: "parent", alts: ["mcqueen", "alexander"] }), // census: bare "Alexander" is always this brand
  T("brunello cucinelli", { cat: "parent", alts: ["brunello", "cucinelli"] }),
  T("comme des garcons", { cat: "parent" }),
  T("cdg", { cat: "parent", mode: "word" }),
  T("philipp plein", { cat: "parent", alts: ["phillip plein", "plein", "philipp", "phillip"] }),
  T("bottega veneta", { cat: "parent", alts: ["bottega"] }),
  T("dsquared", { cat: "parent", alts: ["dsquared2"] }),
  T("bape", { cat: "parent", alts: ["a bathing ape"] }),
  T("levis", { cat: "parent", label: "levi's" }),     // squash folds levi's/levi’s
  T("diesel", { cat: "parent", alts: ["diesal"] }),
  T("replay", { cat: "parent" }),
  T("versace", { cat: "parent" }),
  T("amiri", { cat: "parent" }),
  T("dior", { cat: "parent" }),                       // squash: also walk'n'dior
  T("prada", { cat: "parent", alts: ["planda", "pranda"] }),
  T("balenciaga", { cat: "parent" }),
  T("givenchy", { cat: "parent", alts: ["giavceye"] }),
  T("umbro", { cat: "parent" }),
  T("balr", { cat: "parent", mode: "word" }),
  T("moncler", { cat: "parent" }),
  T("ugg", { cat: "parent", mode: "word" }),          // word: inside "luggage"
  T("valentino", { cat: "parent" }),
  T("chanel", { cat: "parent" }),
  T("coco", { cat: "parent", mode: "word" }),         // census: "Coco Chanel" perfume
  T("swarovski", { cat: "parent" }),
  T("hoka", { cat: "parent" }),
  T("rhude", { cat: "parent" }),
  T("iceberg", { cat: "parent" }),
  T("represent", { cat: "parent", mode: "word" }),
  T("loewe", { cat: "parent" }),
  T("celine", { cat: "parent", mode: "word" }),       // word: "clearance lines" squashes to contain it
  T("hermes", { cat: "parent", alts: ["hemes"] }),
  T("skechers", { cat: "parent" }),
  T("stussy", { cat: "parent", alts: ["stssy"] }),
  T("zara", { cat: "parent" }),
  T("burberry", { cat: "parent" }),
  T("paul shark", { cat: "parent", label: "paul & shark" }), // census: 4 tees
  T("saint michael", { cat: "parent" }),              // census: 9 records (Saint Mxxxxxx line)
  T("purple brand", { cat: "parent", alts: ["purple bland"] }), // census: denim brand + its live misspelling
  T("fendi", { cat: "parent" }),
  T("kappa", { cat: "parent" }),
  T("hummel", { cat: "parent" }),
  T("benetton", { cat: "parent" }),
  T("cartier", { cat: "parent" }),
  T("tiffany", { cat: "parent" }),
  T("patek", { cat: "parent" }),
  T("tag heuer", { cat: "parent" }),
  T("miu miu", { cat: "parent" }),
  T("ray ban", { cat: "parent", label: "ray-ban" }),
  T("zanotti", { cat: "parent" }),
  T("lululemon", { cat: "parent" }),
  T("descente", { cat: "parent" }),
  T("affliction", { cat: "parent" }),
  T("havaianas", { cat: "parent", alts: ["havanas"] }),
  T("labubu", { cat: "parent" }),                     // Pop Mart character mark (1 live record)
  T("vlone", { cat: "parent" }),
  T("creed", { cat: "parent", mode: "word" }),        // fragrance house (census: perfume names)
  T("rodriguez", { cat: "parent" }),                  // Narciso Rodriguez ("Rodriguez for Her")
  T("louboutin", { cat: "parent", alts: ["christian louboutin"] }),
  T("louis", { cat: "parent", mode: "word" }),        // Louboutin "Louis Junior" / LV fragment
  T("corteiz", { cat: "parent" }),
  T("gallery dept", { cat: "parent" }),
  T("lotto", { cat: "parent", mode: "word" }),        // sportswear brand (census: jerseys)
  T("starter", { cat: "parent", mode: "word" }),      // Starter brand (census: 1)

  // ── (b) SUB-LABELS & COLLABS ───────────────────────────────────────────────
  T("nocta", { cat: "sublabel" }),                    // REVERSED line-mark keep
  T("certified lover boy", { cat: "sublabel" }),      // Drake collab designation (census: 2 AF1s)
  T("yeezy", { cat: "sublabel" }),
  T("off white", { cat: "sublabel", label: "off-white" }),
  T("travis scott", { cat: "sublabel" }),
  T("cactus jack", { cat: "sublabel" }),
  T("cactus plant flea market", { cat: "sublabel" }), // census: 3 CPFM records
  T("supreme", { cat: "sublabel" }),
  T("palace", { cat: "sublabel", mode: "word" }),
  T("kith", { cat: "sublabel" }),                     // census: "Samba Kith Classics"
  T("jumpman", { cat: "sublabel" }),
  T("swoosh", { cat: "sublabel" }),                   // Nike trademark (census: 10 names)

  // ── (c) MODEL / SILHOUETTE NAMES ───────────────────────────────────────────
  T("air force"),                                     // squash catches AIRFORCE1's prefix; orphan digits are dropped by the rebuild
  T("air max"),
  T("air jordan"),
  T("air", { mode: "word" }),                         // bare Nike Air; word: inside "fair"/"hair"
  T("max", { mode: "word" }),                         // census: 118 uses, all Air Max family
  T("dunk"),                                          // + SB Dunk via squash
  T("sb", { mode: "word" }),
  T("og", { mode: "word" }),                          // sneaker-culture "Retro High OG" marker
  T("cortez"),
  T("blazer"),
  T("pegasus"),
  T("vomero"),
  T("zoom"),                                          // Nike Zoom line (census: 36)
  T("shox"),                                          // census: 14
  T("vapor"),                                         // squash: also Vapormax / Vaporfly (census: 13)
  T("tailwind"),                                      // census: Air Max Tailwind
  T("waffle"),                                        // Nike Waffle (census: 7)
  T("footscape"),                                     // census: 5
  T("alphafly"),                                      // census: 5
  T("metcon"),                                        // census: 12
  T("windrunner"),                                    // Nike jacket model (census: 10)
  T("tech fleece"),                                   // Nike line (census: 41)
  T("dri fit", { label: "dri-fit" }),                 // Nike trademark (census: 21)
  T("phantom"),                                       // Nike boot silhouette (census: 13)
  T("superfly"),                                      // census: 8
  T("tiempo"),
  T("mercurial"),
  T("samba"),                                         // squash: also Sambarose
  T("gazelle"),
  T("superstar"),
  T("campus"),
  T("forum"),
  T("stan smith"),
  T("ultraboost"),
  T("nmd"),
  T("copa"),
  T("predator"),
  T("f50", { mode: "word" }),                         // census: 23
  T("adizero"),                                       // census: 12
  T("nemeziz"),
  T("morelia"),
  T("cloud"),                                         // On's model family; squash: also Cloudsurfer/-monster/-venture
  T("cloudsurfer"),
  T("cloudmonster"),
  T("suede"),                                         // mandated (Puma Suede) — the material word is sacrificed
  T("rs x", { label: "rs-x" }),
  T("9060", { mode: "word" }),
  T("550", { mode: "word" }),
  T("990", { mode: "word" }),
  T("2002r", { mode: "word", alts: ["2002"] }),
  T("327", { mode: "word" }),
  T("574", { mode: "word" }),
  T("530", { mode: "word" }),                         // census: NB 530 (8 records)
  T("fresh foam"),                                    // NB line (census: 7)
  T("chuck taylor"),
  T("old skool"),
  T("classic leather"),
  T("club c", { mode: "word" }),                      // word: squash "clubc" is inside e.g. "club couture"
  T("hovr"),                                          // UA line (census: 9)
  T("ea7"),                                           // Armani sub-line (census: EA7 tracksuits)
  T("total 90", { alts: ["total90"] }),               // Nike boot line (census)
  T("versair"),                                       // Nike model (census)
  T("spiridon"),                                      // Nike Air Zoom Spiridon (census)
  T("invincible run"),                                // Nike ZoomX model (census)
  T("flyknit"),                                       // Nike trademark tech (census)
  T("undftd", { cat: "sublabel", alts: ["undefeated"] }), // Undefeated collab (census)
  T("montreal 76"),                                   // adidas model (census)
  T("t clip"),                                        // Lacoste T-Clip model (census: 9)
  T("kobe", { cat: "sublabel", alts: ["kobe bryant"] }), // Nike signature line (census)
  T("spezial", { alts: ["handball spezial"] }),       // adidas model (census)
  T("nizza"),                                         // adidas model (census)
  T("arena", { mode: "word" }),                       // Balenciaga Arena (census)
  T("tn", { mode: "word" }),                          // Nike Air Max Plus TN (census: 5)
  T("uptempo"),                                       // Nike Air More Uptempo (census)
  T("floatzig"),                                      // Reebok model (census)
  T("sevastos"),                                      // Louboutin model (census)
  T("nrg", { mode: "word" }),                         // Nike collab designation (census)
  T("gripshot"),                                      // Lacoste model (census: 20)
  T("powercourt"),                                    // Lacoste model (census: 11)
  T("court cage"),                                    // Lacoste model (census: 9)
  T("guard breaker"),                                 // Lacoste model (census: 14)
  T("kapri"),                                         // Karl Lagerfeld model (census: 16)
  T("ikonik"),                                        // Karl Lagerfeld line (census: 9)
  T("airlift"),                                       // Alo model (census: 7)
  T("arizona", { mode: "word" }),                     // Birkenstock silhouette (11 of 13 uses)
  T("boston", { mode: "word" }),                      // Birkenstock silhouette (3 of 5 uses)
  T("portofino"),                                     // Dolce & Gabbana silhouette (census: 7)
  T("time out", { mode: "word" }),                    // Louis Vuitton silhouette (census: 9)
  T("aventus"),                                       // Creed fragrance name (census: 2)
  T("rouge 540"),                                     // MFK Baccarat Rouge 540 dupe naming
  T("baccarat"),
  T("l1212", { label: "l.12.12" }),                   // Lacoste fragrance code (squash of L.12.12)
  T("l12", { mode: "word" }),
];

// "On" (On Running): leading word only, in front of its own model vocabulary.
const ON_LEADING = /^on[\s-]+(?=cloud|running\b)/i;
// "Palace" stays when it is Crystal Palace FC (team names are the product).
const CRYSTAL_PALACE = /crystal[\s-]+palace/i;

const WINDOW_MAX = 5; // longest trigger is 4 words; +1 slack for split tokens

const tokenize = (text) => String(text ?? "").match(/[A-Za-z0-9'’]+/g) || [];
const squash = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const wordOf = (tok) => tok.toLowerCase().replace(/[^a-z0-9]+/g, "");

// Exact word-sequence present anywhere in `words` (word-mode variants).
// The palace guard lives here: "crystal palace" is a football club, not the
// skate label — a "palace" window directly preceded by "crystal" doesn't count.
function wordSeqIn(words, variant, label) {
  for (let i = 0; i + variant.words.length <= words.length; i++) {
    if (variant.words.every((w, k) => words[i + k] === w)) {
      if (label === "palace" && words[i - 1] === "crystal") continue;
      return true;
    }
  }
  return false;
}

/**
 * Every trigger present in `text` (canonical labels, deduped) — the DETECTION
 * side, used by the payload validator and the card's live input check.
 * Deliberately STRICTER than removal: squash-mode triggers match across word
 * joins ("cloud monster" → "cloudmonster"), so text that removal could not
 * fully clean still gets refused rather than shipped.
 */
export function triggersInText(text) {
  const raw = String(text ?? "");
  const sq = squash(raw);
  const words = tokenize(raw).map(wordOf).filter(Boolean);
  const hits = [];
  for (const t of TRIGGERS) {
    const hit = t.variants.some((v) =>
      t.mode === "squash" ? v.sq && sq.includes(v.sq) : wordSeqIn(words, v, t.label)
    );
    if (hit) hits.push(t.label);
  }
  if (ON_LEADING.test(raw.trim())) hits.push("On");
  return [...new Set(hits)];
}

/** True when `text` is free of every trigger — the pass/fail the validator uses. */
export function isTriggerFree(text) {
  return triggersInText(text).length === 0;
}

// ── Removal + rebuild ─────────────────────────────────────────────────────────
// Mark-and-drop over the name's tokens. A squash-mode trigger marks a token
// window whose squashed join EQUALS the trigger, or a single token that merely
// CONTAINS it ("AIRFORCE1", "Sambarose", "walk'n'dior" are killed whole).
// Word-mode marks exact word windows only. After any removal, residual
// pure-digit tokens are dropped too — they are model numbers ("Air Force 1" →
// "1", "Gucci 1977" → "1977") that mean nothing once the mark is gone.
function stripTriggerTokens(name) {
  let raw = String(name ?? "").trim().replace(ON_LEADING, "");
  const tokens = tokenize(raw);
  const words = tokens.map(wordOf);
  const sqs = tokens.map((t) => squash(t));
  const drop = new Array(tokens.length).fill(false);
  let removed = false;

  for (const t of TRIGGERS) {
    for (const v of t.variants) {
      if (t.mode === "squash") {
        for (let i = 0; i < tokens.length; i++) {
          if (v.sq && sqs[i].includes(v.sq)) {                 // inside one token
            if (t.label === "palace") continue;
            drop[i] = true; removed = true; continue;
          }
          // Multi-token windows: the squashed join CONTAINING the trigger marks
          // the window — provided the match actually starts inside token i
          // (otherwise the smaller window starting at i+1 owns it; marking here
          // would over-drop an innocent leading token) — so boundary-spanning
          // spellings ("LGuard Breaker", "karpri konik") die whole.
          let joined = sqs[i];
          for (let j = i + 1; j < Math.min(tokens.length, i + WINDOW_MAX); j++) {
            const prev = joined;
            joined += sqs[j];
            if (v.sq && joined.includes(v.sq) && !prev.includes(v.sq)) {
              if (joined.slice(sqs[i].length).includes(v.sq)) break; // starts after token i
              if (t.label === "palace") break;
              for (let k = i; k <= j; k++) drop[k] = true;
              removed = true;
              break;
            }
          }
        }
      } else {
        for (let i = 0; i + v.words.length <= words.length; i++) {
          if (v.words.every((w, k) => words[i + k] === w)) {
            if (t.label === "palace" && words[i - 1] === "crystal") continue;
            for (let k = 0; k < v.words.length; k++) drop[i + k] = true;
            removed = true;
          }
        }
      }
    }
  }
  if (!removed) return { residue: tokens, removed };
  const residue = tokens.filter((tok, i) => !drop[i] && !/^\d+$/.test(wordOf(tok)));
  return { residue, removed };
}

// ── Composition vocabulary — derived from the catalogue, never invented ──────
// Product nouns that make a residue self-describing (the rebuilt title keeps
// the residue untouched when one of these survives the strip).
const PRODUCT_NOUNS = new Set([
  "sneaker", "sneakers", "shoe", "shoes", "boot", "boots", "slide", "slides",
  "sandal", "sandals", "slipper", "slippers", "clog", "clogs", "loafer",
  "loafers", "trainer", "trainers", "runners", "cleats",
  "shirt", "shirts", "tshirt", "tshirts", "tee", "tees", "polo", "polos",
  "hoodie", "hoodies", "sweatshirt", "sweater", "jumper", "pullover",
  "jacket", "jackets", "coat", "puffer", "bomber", "parka", "gilet", "vest",
  "tracksuit", "tracksuits", "jersey", "jerseys", "jeans", "jean", "shorts", "short",
  "sweatshorts", "cargos", "pants", "trousers", "joggers", "sweatpants",
  "dress", "skirt", "top", "tops",
  "cap", "caps", "hat", "hats", "beanie", "beanies", "snapback", "visor",
  "balaclava", "bag", "bags", "backpack", "handbag", "pouch", "tote", "sling",
  "slidebag", "bagpack", "paperbag", "belt", "belts", "watch", "watches",
  "glasses", "sunglasses", "shades", "necklace", "bracelet", "gloves",
  "socks", "boxers", "briefs", "underwear",
  "perfume", "fragrance", "parfum", "set",
]);

// The silhouette noun a subcategory contributes when no product noun survives
// the strip. Values are the catalogue's own vocabulary (CATEGORY_TREE leaves),
// singularised for a listing title.
const SUBCATEGORY_NOUN = {
  "Sneakers": "sneaker",
  "Soccer Boots": "soccer boots",
  "Sandals & Slides": "sandal",
  "Boots": "boots",
  "T-Shirts": "t-shirt",
  "Jerseys": "jersey",
  "Caps & Hats": "cap",
  "Tracksuits & Sets": "tracksuit",
  "Jeans & Denim": "jeans",
  "Polos": "polo shirt",
  "Hoodies & Sweatshirts": "hoodie",
  "Jackets & Coats": "jacket",
  "Cargos & Pants": "pants",
  "Shorts & Vests": "shorts",
  "Underwear & Socks": "underwear",
  "Clothing — Uncategorized": "garment",
  "Bags": "bag",
  "Belts": "belt",
  "Watches": "watch",
  "Eyewear": "sunglasses",
  "Jewellery": "jewellery",
  "Gloves": "gloves",
  "Balaclavas & Masks": "balaclava",
  "Perfume": "fragrance",
};
const CATEGORY_NOUN = {
  Footwear: "shoes",
  Clothing: "garment",
  Accessories: "accessory",
  Perfume: "fragrance",
};

// Footwear profile adjectives: a surviving "low"/"high"/"mid" token becomes the
// listing's profile word ("Low-top sneaker …").
const PROFILE = { low: "Low-top", high: "High-top", mid: "Mid-top" };

const tidy = (s) => {
  const out = String(s).replace(/\s+/g, " ").trim();
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : "";
};

/**
 * The one title builder for the Shopify push.
 * product: { name, category, subcategory } (a /products record or equivalent).
 *
 * → { title, source: "original" | "lexicon", needsAI, reason, triggers }
 *
 * • Name already trigger-free → ships as-is (source "original").
 * • Triggers present → strip them, then rebuild a GENERIC DESCRIPTIVE title:
 *   the residue if it still names the product, otherwise silhouette noun (from
 *   the record's own subcategory/category — no invented facts) + residue
 *   descriptors ("Nike Air Force 1 low black" → "Low-top sneaker black").
 * • Guards — never empty, never digit-leading, never under 3 chars, never
 *   containing a trigger. A guard violation returns needsAI: true with NO
 *   usable title; the caller routes it to the AI pass / manual naming. The
 *   original name is NEVER shipped for a triggered product (v1 did — that
 *   contract is gone).
 */
export function cleanTitleFor(product) {
  const name = String(product?.name ?? "").trim();
  const triggers = triggersInText(name);
  if (triggers.length === 0) {
    const reason =
      name === "" ? "empty name"
      : /^\d/.test(name) ? "digit-leading name"
      : name.length < 3 ? "name under 3 chars"
      : null;
    return reason
      ? { title: null, source: null, needsAI: true, reason, triggers }
      : { title: name, source: "original", needsAI: false, reason: null, triggers };
  }

  const { residue } = stripTriggerTokens(name);
  const residueWords = residue.map(wordOf);
  let title;
  if (residueWords.some((w) => PRODUCT_NOUNS.has(w))) {
    title = tidy(residue.join(" "));
  } else {
    const isFootwear = product?.category === "Footwear";
    let profile = null;
    let rest = residue;
    if (isFootwear) {
      const pi = residueWords.findIndex((w) => PROFILE[w]);
      if (pi !== -1) {
        profile = PROFILE[residueWords[pi]];
        rest = residue.filter((_, i) => i !== pi);
      }
    }
    const noun =
      SUBCATEGORY_NOUN[product?.subcategory] ?? CATEGORY_NOUN[product?.category] ?? null;
    if (!noun) {
      return { title: null, source: null, needsAI: true, reason: "no silhouette noun (uncategorised)", triggers };
    }
    title = tidy([profile ? `${profile} ${noun}` : noun, ...rest].join(" "));
  }

  const reason =
    title === "" ? "empty after strip"
    : /^\d/.test(title) ? "digit-leading after strip"
    : title.length < 3 ? "under 3 chars after strip"
    : !isTriggerFree(title) ? "trigger survived rebuild"
    : null;
  return reason
    ? { title: null, source: null, needsAI: true, reason, triggers }
    : { title, source: "lexicon", needsAI: false, reason: null, triggers };
}
