// ─── MODEL FAMILY — which shoes are the same model ───────────────────────────
//
// WHY (2026-10-09). The catalogue holds the same model under many spellings:
// "Air force white", "Nike Air force1 white", "Nike Air Force 1 White", "Nike
// Air force1", "Nike airforce 1 Green", "Air force blue" — and the
// alternatives ranking had no idea they were one shoe. So a customer refused a
// size of one Air Force 1 was not reliably shown the other Air Force 1s in
// that size. A family groups them: one id per model, whatever the record calls
// it, so tier a of the ranking ("same model, closest colourway first") can
// find every one.
//
// ── WHERE THE FAMILY COMES FROM, in order ────────────────────────────────────
//   1. the product NAME, read against the rule table below;
//   2. the vision namer's `model` (/product_identity/{pid}.model);
//   3. the model name printed on the box label (`labelModelName`);
//   4. a STYLE-CODE SIBLING: a Nike/Jordan code is a 6-character model base
//      plus a 3-digit colourway ("CW2288-111" → CW2288), so another product
//      on the same base is the same model — the trigger looks one up through
//      the /products styleCodeNormalised index and passes its family in;
//   5. a FALLBACK from the name: brand + the first word that is not a colour
//      or filler ("Lacoste Gripshot Black" → lacoste-gripshot), so a line
//      with no rule still groups with its own colourways.
//
// The rules are ORDERED: the first that matches wins, so a more specific
// model sits above the one it contains ("Court Vision" above "Air Force",
// because "Nike Airforce Court Vision Alta" is a Court Vision).
//
// PURE. Shared byte-for-byte with functions/lib/alt-shared/ (parity test).

/** Lower-case, punctuation to spaces, one space between words, padded. */
export function familyText(s) {
  return ` ${String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/'/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** low / mid / high from the words of a name, or "". */
export function cutFromName(name) {
  const s = familyText(name);
  if (/ (high|hi) /.test(s)) return "high";
  if (/ mid /.test(s)) return "mid";
  if (/ low /.test(s)) return "low";
  return "";
}

// ── THE RULES ────────────────────────────────────────────────────────────────
// id: the family id (also the profile slot). label: what the sheet prints.
// re: tested against familyText(...) — words are space-separated and padded.
// sil: the silhouette the model is when nothing else says (a cut word in the
// name overrides a trainer's low/mid/high).
const R = (id, label, re, sil = "") => Object.freeze({ id, label, re, sil });
export const FAMILY_RULES = Object.freeze([
  // ── Nike — the specific before the general ──
  R("nike-court-vision", "Court Vision", / court vision /, "low-top"),
  R("nike-air-force-1", "Air Force 1", / (air ?force ?(1|one)?|af ?1|airforce ?1?|air force1|airforce1) /, "low-top"),
  R("nike-dunk", "Dunk", / dunk /, "low-top"),
  R("nike-air-max-plus", "Air Max Plus", / (air max plus|air max tn|tn plus|tn) /, "runner"),
  R("nike-air-max-90", "Air Max 90", / air max 90 /, "runner"),
  R("nike-air-max-95", "Air Max 95", / air max 95 /, "runner"),
  R("nike-air-max-97", "Air Max 97", / air max 97 /, "runner"),
  R("nike-air-max-270", "Air Max 270", / air max 270 /, "runner"),
  R("nike-air-max-dn", "Air Max Dn", / air max dn /, "runner"),
  R("nike-air-max-portal", "Air Max Portal", / (air max portal|air portal) /, "runner"),
  R("nike-air-max-1", "Air Max 1", / air max 1 /, "runner"),
  R("nike-air-max", "Air Max", / air max /, "runner"),
  R("nike-vomero", "Vomero", / (zoom )?vomero /, "runner"),
  R("nike-pegasus", "Pegasus", / pegasus /, "runner"),
  R("nike-shox", "Shox", / shox /, "runner"),
  R("nike-p-6000", "P-6000", / p ?6000 /, "runner"),
  R("nike-v2k", "V2K", / v2k /, "runner"),
  R("nike-blazer", "Blazer", / blazer /, "high-top"),
  R("nike-cortez", "Cortez", / cortez /, "low-top"),
  R("nike-killshot", "Killshot", / killshot /, "low-top"),
  R("nike-air-flightposite", "Flightposite", / flightposite /, "high-top"),
  R("nike-uptempo", "Uptempo", / uptempo /, "high-top"),
  R("nike-presto", "Presto", / presto /, "runner"),
  R("nike-huarache", "Huarache", / huarache /, "runner"),
  R("nike-metcon", "Metcon", / metcon /, "runner"),
  R("nike-footscape", "Footscape", / footscape /, "low-top"),
  R("nike-waffle", "Waffle", / waffle /, "runner"),
  R("nike-mercurial", "Mercurial", / mercurial /, "soccer-boot"),
  R("nike-tiempo", "Tiempo", / tiempo /, "soccer-boot"),
  R("nike-phantom", "Phantom", / nike phantom | phantom (gx|gt|luna|6|venom) /, "soccer-boot"),
  // ── Jordan — the number is the model ──
  R("jordan-1", "Air Jordan 1", / (air )?jordan (retro )?1 | aj ?1 /, "high-top"),
  R("jordan-3", "Air Jordan 3", / (air )?jordan (retro )?3 | aj ?3 /, "mid"),
  R("jordan-4", "Air Jordan 4", / (air )?jordan (retro )?4 | aj ?4 /, "mid"),
  R("jordan-5", "Air Jordan 5", / (air )?jordan (retro )?5 | aj ?5 /, "mid"),
  R("jordan-6", "Air Jordan 6", / (air )?jordan (retro )?6 | aj ?6 /, "mid"),
  R("jordan-11", "Air Jordan 11", / (air )?jordan (retro )?11 | aj ?11 /, "mid"),
  R("jordan-12", "Air Jordan 12", / (air )?jordan (retro )?12 | aj ?12 /, "mid"),
  R("jordan-13", "Air Jordan 13", / (air )?jordan (retro )?13 | aj ?13 /, "mid"),
  // ── adidas ──
  R("adidas-samba", "Samba", / samba(rose)? /, "low-top"),
  R("adidas-gazelle", "Gazelle", / gazelle /, "low-top"),
  R("adidas-campus", "Campus", / campus /, "low-top"),
  R("adidas-superstar", "Superstar", / superstar /, "low-top"),
  R("adidas-stan-smith", "Stan Smith", / stan smith /, "low-top"),
  R("adidas-forum", "Forum", / forum /, "low-top"),
  R("adidas-spezial", "Spezial", / spezial /, "low-top"),
  R("adidas-sl-72", "SL 72", / sl 72 /, "low-top"),
  R("adidas-yeezy-slide", "Yeezy Slide", / yeezy (slide|foam) /, "slide"),
  R("adidas-yeezy-350", "Yeezy 350", / yeezy (boost )?350 /, "runner"),
  R("adidas-yeezy-700", "Yeezy 700", / yeezy (boost )?700 /, "runner"),
  R("adidas-yeezy", "Yeezy", / yeezy /, "runner"),
  R("adidas-ultraboost", "Ultraboost", / ultra ?boost /, "runner"),
  R("adidas-adizero", "Adizero", / adizero /, "runner"),
  R("adidas-nmd", "NMD", / nmd /, "runner"),
  R("adidas-adilette", "Adilette", / adilette /, "slide"),
  R("adidas-f50", "F50", / f50 /, "soccer-boot"),
  R("adidas-predator", "Predator", / predator /, "soccer-boot"),
  R("adidas-copa", "Copa", / copa /, "soccer-boot"),
  // ── New Balance — the number is the model ──
  R("nb-9060", "New Balance 9060", / 9060 /, "runner"),
  R("nb-2002r", "New Balance 2002R", / 2002 ?r /, "runner"),
  R("nb-1906r", "New Balance 1906R", / 1906 ?r? /, "runner"),
  R("nb-550", "New Balance 550", / (nb|new balance|bb) ?550 /, "low-top"),
  R("nb-530", "New Balance 530", / (nb|new balance|mr) ?530 /, "runner"),
  R("nb-990", "New Balance 990", / (nb|new balance|m) ?99[0-3] /, "runner"),
  R("nb-327", "New Balance 327", / (nb|new balance|ms) ?327 /, "runner"),
  R("nb-574", "New Balance 574", / (nb|new balance|ml) ?574 /, "runner"),
  R("nb-1000", "New Balance 1000", / (nb|new balance|m) ?1000 /, "runner"),
  R("nb-fresh-foam", "Fresh Foam", / fresh foam /, "runner"),
  R("nb-fuelcell", "FuelCell", / fuel ?cell /, "runner"),
  // ── On ──
  R("on-cloudsurfer", "Cloudsurfer", / cloud ?surfer /, "runner"),
  R("on-cloudmonster", "Cloudmonster", / cloud ?monster /, "runner"),
  R("on-cloudhorizon", "Cloudhorizon", / cloud ?horizon /, "runner"),
  R("on-cloudventure", "Cloudventure", / cloud ?venture /, "runner"),
  R("on-cloudtilt", "Cloudtilt", / cloud ?tilt /, "runner"),
  R("on-cloudnova", "Cloudnova", / cloud ?nova /, "runner"),
  R("on-cloud", "On Cloud", / on cloud |^ cloud (x|5|6) /, "runner"),
  // ── Lacoste ──
  R("lacoste-l-guard", "L-Guard", / l ?guard /, "low-top"),
  R("lacoste-gripshot", "Gripshot", / gripshot /, "low-top"),
  R("lacoste-powercourt", "Powercourt", / power ?court /, "low-top"),
  R("lacoste-carnaby", "Carnaby", / carnaby /, "low-top"),
  R("lacoste-court-cage", "Court Cage", / court cage /, "low-top"),
  R("lacoste-t-clip", "T-Clip", / t ?clip /, "low-top"),
  R("lacoste-missouri", "Missouri", / missouri /, "mid"),
  // ── everyone else with a model people ask for by name ──
  R("timberland-6-inch", "Timberland 6-Inch", / (6 ?inch|premium 6) /, "boot"),
  R("timberland-motion-6", "Motion 6", / motion 6 /, "boot"),
  R("timberland-field-trekker", "Field Trekker", / field trekker /, "boot"),
  R("mcqueen-oversized", "Oversized Sneaker", / oversized /, "low-top"),
  R("lv-trainer", "LV Trainer", / (lv|louis vuitton) trainer /, "low-top"),
  R("lv-time-out", "Time Out", / time ?out /, "low-top"),
  R("dior-b23", "B23", / b23 /, "high-top"),
  R("dior-b22", "B22", / b22 /, "runner"),
  R("dior-b30", "B30", / b30 /, "runner"),
  R("dior-walk-n-dior", "Walk'n'Dior", / walk n( dior)? /, "low-top"),
  R("balenciaga-triple-s", "Triple S", / triple s /, "runner"),
  R("balenciaga-track", "Track", / balenciaga track /, "runner"),
  R("gucci-ace", "Ace", / gucci ace /, "low-top"),
  R("gucci-rhyton", "Rhyton", / rhyton /, "low-top"),
  R("dg-portofino", "Portofino", / portofino /, "low-top"),
  R("karl-kapri", "Kapri", / kapri /, "low-top"),
  R("birkenstock-arizona", "Arizona", / arizona /, "sandal"),
  R("birkenstock-boston", "Boston", / boston /, "loafer"),
  R("ugg-tasman", "Tasman", / tasman /, "loafer"),
  R("converse-chuck-70", "Chuck 70", / chuck (taylor )?70 /, "high-top"),
  R("converse-all-star", "All Star", / (chuck taylor|all star) /, "high-top"),
  R("vans-old-skool", "Old Skool", / old skool /, "low-top"),
  R("vans-sk8", "Sk8", / sk8 /, "high-top"),
  R("puma-suede", "Suede", / puma suede /, "low-top"),
  R("puma-speedcat", "Speedcat", / speedcat /, "low-top"),
  R("puma-palermo", "Palermo", / palermo /, "low-top"),
  R("asics-gel-kayano", "Gel-Kayano", / gel ?kayano /, "runner"),
  R("asics-gel-1130", "Gel-1130", / gel ?1130 /, "runner"),
  R("asics-gel-nyc", "Gel-NYC", / gel ?nyc /, "runner"),
  R("hoka-clifton", "Clifton", / clifton /, "runner"),
  R("hoka-bondi", "Bondi", / bondi /, "runner"),
  R("drmartens-1460", "Dr. Martens 1460", / 1460 /, "boot"),
  R("amiri-ma-runner", "MA Runner", / ma runner /, "runner"),
  R("amiri-skel-top", "Skel Top", / skel( top)? /, "low-top"),
  R("ua-hovr-phantom", "HOVR Phantom", / hovr phantom /, "runner"),
  R("loro-piana-summer-walk", "Summer Walk", / summer (charms )?walk /, "loafer"),
  R("reebok-club-c", "Club C", / club c /, "low-top"),
]);

const RULE_BY_ID = new Map(FAMILY_RULES.map((r) => [r.id, r]));

/** A family id → the words the sheet prints ("Air Force 1"), or "" for a fallback family. */
export function familyLabel(id) {
  return RULE_BY_ID.get(String(id ?? ""))?.label || "";
}

/** The rule a piece of text names, or null. */
export function familyRuleFor(text) {
  const s = familyText(text);
  if (s.trim() === "") return null;
  for (const r of FAMILY_RULES) if (r.re.test(s)) return r;
  return null;
}

// ── STYLE CODE — the model base ──────────────────────────────────────────────
// Nike and Jordan: two letters, four digits, three-digit colourway
// ("FV7613100" normalised). Nothing else is read — adidas codes name a single
// colourway and a prefix of one says nothing about another.
const NIKE_CODE = /^([A-Z]{2}\d{4})\d{3}$/;
/** The model base of a normalised style code, or "". */
export function styleBase(styleCodeNormalised) {
  const m = NIKE_CODE.exec(String(styleCodeNormalised ?? "").trim().toUpperCase());
  return m ? m[1] : "";
}

// ── FALLBACK — brand + the first word that says which line ───────────────────
const FILLER = new Set([
  "sneaker", "sneakers", "shoe", "shoes", "trainer", "trainers", "low", "mid", "high", "hi", "top",
  "retro", "og", "qs", "sp", "prm", "premium", "mens", "men", "womens", "women", "wmns", "kids",
  "the", "and", "end", "with", "x", "new", "original", "edition", "leather", "suede", "classic",
  "white", "black", "grey", "gray", "cream", "blue", "navy", "red", "green", "pink", "brown", "tan",
  "beige", "yellow", "orange", "purple", "silver", "gold", "olive", "multi", "multicolor",
  "multicolour", "triple", "sail", "bone", "off", "light", "dark", "royal", "full", "all",
]);
const slug = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** brand-word family for a name no rule covers, or "". */
export function fallbackFamily(name, brand) {
  const b = slug(brand);
  if (!b) return "";
  const brandWords = new Set(familyText(brand).trim().split(" "));
  // "L-Guard", "S-Ukiyo", "T-Clip": a lone letter hyphened to a word is one word.
  const text = String(name ?? "").replace(/\b([A-Za-z])-([A-Za-z]{2,})/g, "$1$2");
  for (const w of familyText(text).trim().split(" ")) {
    if (!w || brandWords.has(w) || FILLER.has(w)) continue;
    if (w.length < 3 && !/\d/.test(w)) continue;
    const id = `${b}-${w}`.slice(0, 48).replace(/-+$/, "");
    return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : "";
  }
  return "";
}

/**
 * The family of a product.
 *
 * @returns { fam, src, cut, sil } — fam "" when nothing could be said.
 *   src: "name" | "identity" | "label" | "stylecode" | "fallback" | ""
 *   sil: the rule's silhouette, adjusted by a cut word, or ""
 */
export function modelFamilyOf({ name = "", brand = "", identityModel = "", labelModelName = "", siblingFamily = "" } = {}) {
  const cut = cutFromName(name) || cutFromName(identityModel);
  const sources = [["name", name], ["identity", identityModel], ["label", labelModelName]];
  for (const [src, text] of sources) {
    const rule = familyRuleFor(text);
    if (rule) return { fam: rule.id, src, cut, sil: silFor(rule.sil, cut) };
  }
  const sib = String(siblingFamily ?? "").trim();
  if (sib && /^[a-z0-9][a-z0-9-]{0,47}$/.test(sib)) {
    const rule = RULE_BY_ID.get(sib);
    return { fam: sib, src: "stylecode", cut, sil: silFor(rule?.sil || "", cut) };
  }
  const fb = fallbackFamily(name, brand);
  return fb ? { fam: fb, src: "fallback", cut, sil: "" } : { fam: "", src: "", cut, sil: "" };
}

// A trainer's cut word decides low/mid/high; nothing else is overridden.
const TRAINER = new Set(["low-top", "mid", "high-top"]);
function silFor(sil, cut) {
  if (!TRAINER.has(sil) || !cut) return sil;
  return cut === "high" ? "high-top" : cut === "mid" ? "mid" : "low-top";
}

