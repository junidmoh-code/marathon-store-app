// ─── STYLE KIT CATALOGUE — ONE KIT PER CATALOGUE CATEGORY (Junid, 20 Nov 2026) ─
// The single source of truth for "which Style Kit does this product use".
// Imported by the app (the Style Kit Catalogue: counts, assignment), by the
// Shopify / AI Studio publisher (functions/index.js generateProductPhotos) and
// by the ONE shared generator New Arrivals and Black Friday call
// (newArrivals/studio/studio.mjs) — so the three can never route differently.
//
// PURE. No I/O, no Firebase, no network.
//
// WHERE IT LIVES (RTDB, super-admin only — database.rules.json aiAssistant/styleKit):
//   /aiAssistant/styleKit/{kitKey} = { label?, parent?, prompt?, refs:{refId:{url,path,enabled,addedAt,…}} }
//   /aiAssistant/styleKit/_routes/categories/{categoryKey} = kitKey   (Junid's re-assignment of a category)
//   /aiAssistant/styleKit/_routes/products/{pid}           = kitKey   (Junid's assignment of one product)
// "sneaker" and "clothing" are the two kits that existed before the Catalogue;
// their keys, refs and prompts are unchanged.
//
// ROUTING (every Generate): the product's own assignment, else its category's
// kit, then that kit's parent chain, then the house-style default (the old
// sneaker/clothing choice, byte-for-byte). A kit with NO ENABLED REFERENCES is
// skipped — a new, empty kit never changes a single generation until Junid has
// put photos in it.

export const ROUTES_KEY = "_routes";
export const MAX_REFS_SENT = 6; // KEEP IN SYNC with HOUSE_MAX_REFS (functions/index.js) — "first 6 sent"

/** The two kits that were the whole Style Kit before the Catalogue. Their behaviour is the default. */
export const BASE_KITS = Object.freeze(["sneaker", "clothing"]);

// The built-in kits, one per catalogue category Junid named (and the ones the
// live taxonomy holds). `parent` is the next kit tried when this one has no
// enabled references; null = straight to the house-style default.
export const BUILTIN_KITS = Object.freeze([
  { key: "sneaker",    label: "Sneakers",    parent: null },
  { key: "slides",     label: "Slides",      parent: "sneaker" },
  { key: "boots",      label: "Boots",       parent: "sneaker" },
  { key: "clothing",   label: "Clothing",    parent: null },
  { key: "jerseys",    label: "Jerseys",     parent: "clothing" },
  { key: "tracksuits", label: "Tracksuits",  parent: "clothing" },
  { key: "caps",       label: "Caps",        parent: null },
  { key: "beanies",    label: "Beanies",     parent: null },
  { key: "sunglasses", label: "Sunglasses",  parent: "accessories" },
  { key: "perfumes",   label: "Perfumes",    parent: null },
  { key: "bags",       label: "Bags",        parent: "accessories" },
  { key: "belts",      label: "Belts",       parent: "accessories" },
  { key: "watches",    label: "Watches",     parent: "accessories" },
  { key: "jewellery",  label: "Jewellery",   parent: "accessories" },
  { key: "accessories", label: "Accessories", parent: null },
].map(Object.freeze));
const BUILTIN = Object.fromEntries(BUILTIN_KITS.map((k) => [k.key, k]));

// Every catalogue category (taxonomy categoryKey) → its kit. A key not listed
// falls back on the product's legacy fields below.
export const CATEGORY_KIT = Object.freeze({
  "sneakers": "sneaker", "running-shoes": "sneaker", "kids-shoes": "sneaker", "designer-shoes": "sneaker",
  "loafers": "sneaker", "soccer-boots": "sneaker",
  "boots": "boots",
  "slides": "slides", "sandals": "slides",
  "soccer-jerseys": "jerseys", "baseball-shirts": "jerseys",
  "tracksuits": "tracksuits", "ladies-tracksuits": "tracksuits",
  "caps-beanies": "caps", "fitted-caps": "caps", "caps": "caps", "visors": "caps",
  "beanies": "beanies",
  "sunglasses": "sunglasses",
  "perfumes": "perfumes",
  "bags": "bags",
  "belts": "belts",
  "watches": "watches",
  "chains-bracelets": "jewellery",
  "gloves": "accessories", "iphone": "accessories",
  "t-shirts": "clothing", "golf-t-shirts": "clothing", "hoodies": "clothing", "sweaters": "clothing",
  "jackets": "clothing", "pants": "clothing", "jeans": "clothing", "shorts": "clothing",
  "cargo-pants": "clothing", "basketball-vests": "clothing", "dresses": "clothing", "underwear": "clothing",
  "shirts": "clothing", "suits": "clothing",
});

// Products with no categoryKey: the legacy subcategory, then the top category.
const SUBCATEGORY_KIT = Object.freeze({
  "Sneakers": "sneaker", "Soccer Boots": "sneaker", "Boots": "boots", "Sandals & Slides": "slides", "Slides": "slides",
  "Jerseys": "jerseys", "Tracksuits & Sets": "tracksuits",
  "Caps & Hats": "caps", "Caps": "caps", "Hats": "caps", "Beanies": "beanies",
  "Eyewear": "sunglasses", "Perfume": "perfumes", "Bags": "bags", "Belts": "belts",
  "Watches": "watches", "Jewellery": "jewellery", "Gloves": "accessories", "Balaclavas & Masks": "accessories",
});
const TOP_KIT = Object.freeze({ Footwear: "sneaker", Clothing: "clothing", Accessories: "accessories", Perfume: "perfumes" });
const NAME_KIT = Object.freeze([
  [/\b(perfume|eau de|edp|edt|cologne|fragrance)\b/i, "perfumes"],
  [/\bbeanies?\b/i, "beanies"],
  [/\b(caps?|snapback|trucker|visors?|bucket hat)\b/i, "caps"],
  [/\b(sunglass(es)?|shades|eyewear)\b/i, "sunglasses"],
  [/\bbelts?\b/i, "belts"],
  [/\bwatch(es)?\b/i, "watches"],
  [/\b(chains?|bracelets?|necklaces?|pendants?)\b/i, "jewellery"],
  [/\b(bags?|backpacks?|pouch|sling bag|duffel)\b/i, "bags"],
]);
const BEANIE_RE = /\bbeanies?\b/i;

const str = (v) => (typeof v === "string" ? v.trim() : "");
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** The house-style default — EXACTLY the choice generateProductPhotos made before the Catalogue. Pure. */
export function defaultTemplate(product) {
  const p = product || {};
  return p.category === "Clothing" || p.productType === "clothing" ? "clothing" : "sneaker";
}

/** The kit a product's CATEGORY maps to by default (no Junid override). null = none. Pure. */
export function defaultCategoryKit(product) {
  const p = product || {};
  const key = str(p.categoryKey);
  const name = str(p.name);
  let kit = key ? CATEGORY_KIT[key] || null : null;
  if (!kit && !key) kit = SUBCATEGORY_KIT[str(p.subcategory)] || null;
  if (!kit && !key) {
    for (const [re, k] of NAME_KIT) if (re.test(name)) { kit = k; break; }
  }
  if (!kit) kit = TOP_KIT[str(p.category)] || null;
  // "Caps & Beanies" is one taxonomy category: a beanie goes to Beanies.
  if (kit === "caps" && BEANIE_RE.test(name)) kit = "beanies";
  return kit;
}

/** A kit key Junid may create: lowercase letters, digits and dashes, not a reserved/built-in key. Pure. */
export function slugKitKey(label) {
  return str(label).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/**
 * Every kit the node knows: the built-ins (label/parent overridable) plus the
 * sub-categories Junid made (any non-reserved child carrying a label). Pure.
 * → { [key]: { key, label, parent, builtin, custom } }
 */
export function kitDefs(node) {
  const n = isObj(node) ? node : {};
  const out = {};
  for (const b of BUILTIN_KITS) {
    const v = isObj(n[b.key]) ? n[b.key] : {};
    out[b.key] = { key: b.key, label: str(v.label) || b.label, parent: b.parent, builtin: true, custom: false };
  }
  for (const [key, v] of Object.entries(n)) {
    if (key.startsWith("_") || out[key] || !isObj(v) || !str(v.label)) continue;
    out[key] = { key, label: str(v.label), parent: str(v.parent) || null, builtin: false, custom: true };
  }
  // A parent that does not exist (deleted) is dropped, never followed.
  for (const k of Object.values(out)) if (k.parent && !out[k.parent]) k.parent = null;
  return out;
}

/** The enabled references of one kit, oldest first (the order "first 6 sent" means). Pure. */
export function enabledRefs(node, kitKey) {
  const t = isObj(node) && isObj(node[kitKey]) ? node[kitKey] : {};
  return Object.entries(isObj(t.refs) ? t.refs : {})
    .filter(([, r]) => r && r.url && r.enabled !== false)
    .sort(([, a], [, b]) => (a.addedAt || 0) - (b.addedAt || 0))
    .map(([id, r]) => ({ id, ...r }));
}

/** The kit a category is assigned to: Junid's re-assignment, else the default map. Pure. */
export function categoryKitOf(node, categoryKey) {
  const defs = kitDefs(node);
  const routed = str(node?.[ROUTES_KEY]?.categories?.[categoryKey]);
  if (routed && defs[routed]) return routed;
  return CATEGORY_KIT[categoryKey] || null;
}

/**
 * The kits tried for this product, most specific first, ending with the
 * house-style default. Pure.
 *   1. Junid's assignment of THIS product
 *   2. its category's kit (Junid's re-assignment, else the default map / legacy fields)
 *   3. each kit's parent, in turn
 *   4. the house-style default (sneaker | clothing — the pre-Catalogue choice)
 */
export function kitChain(product, pid, node) {
  const defs = kitDefs(node);
  const chain = [];
  const push = (k) => { let cur = k, guard = 0; while (cur && defs[cur] && !chain.includes(cur) && guard++ < 10) { chain.push(cur); cur = defs[cur].parent; } };
  const own = str(pid) ? str(node?.[ROUTES_KEY]?.products?.[pid]) : "";
  if (own && defs[own]) push(own);
  const key = str(product?.categoryKey);
  const routedCat = key ? str(node?.[ROUTES_KEY]?.categories?.[key]) : "";
  push(routedCat && defs[routedCat] ? routedCat : defaultCategoryKit(product));
  const fallback = defaultTemplate(product);
  if (!chain.includes(fallback)) chain.push(fallback);
  return chain;
}

/** The kit a product is COVERED by (its first kit, whether or not it has photos yet). Pure. */
export function coveringKit(product, pid, node) {
  return kitChain(product, pid, node)[0];
}

/**
 * The kit that will actually drive this product's generation: the first in its
 * chain with at least one enabled reference, else the house-style default.
 * → { kit, label, chain, base, dedicated, refs (enabled, oldest first), prompt, promptFamily }
 *   dedicated: false when the result is one of the two pre-Catalogue kits.
 */
export function resolveKit(product, pid, node) {
  const defs = kitDefs(node);
  const chain = kitChain(product, pid, node);
  // The house-style default — never "whatever came last in the chain" (a product hand-assigned to Clothing
  // whose category kit is Caps would otherwise fall to an empty Caps).
  const fallback = defaultTemplate(product);
  const kit = chain.find((k) => enabledRefs(node, k).length > 0) || fallback;
  const { prompt, family } = promptFor(node, kit);
  return {
    kit, label: defs[kit]?.label || kit, chain, base: BASE_KITS.includes(kit) ? kit : null,
    dedicated: !BASE_KITS.includes(kit), refs: enabledRefs(node, kit), prompt, promptFamily: family,
  };
}

/**
 * The locked prompt for a kit: its own saved prompt; else the nearest parent's
 * saved prompt; a kit under Sneakers / Clothing inherits that kit's default;
 * any other kit gets the generic house prompt. Pure.
 * family: "sneaker" | "clothing" | "generic" — decides whether a box photo is sent.
 */
export function promptFor(node, kitKey) {
  const defs = kitDefs(node);
  let cur = kitKey, guard = 0, custom = null;
  while (cur && defs[cur] && guard++ < 10) {
    const saved = str(node?.[cur]?.prompt);
    if (!custom && saved) custom = saved;
    if (BASE_KITS.includes(cur)) return { prompt: custom || HOUSE_DEFAULT_PROMPTS[cur], family: cur };
    cur = defs[cur].parent;
  }
  return { prompt: custom || HOUSE_PROMPT_GENERIC, family: "generic" };
}

/** How many products each kit covers (coveringKit), for the Catalogue. Pure. → { [kit]: n } */
export function kitCounts(products, node) {
  const out = {};
  // A { pid: product } map (the server) or an array of { id, … } (the app's products list).
  const rows = Array.isArray(products) ? products.map((p) => [p && p.id, p]) : Object.entries(products || {});
  for (const [pid, p] of rows) {
    if (!p || p.deleted || p.archived) continue;
    const k = coveringKit(p, pid, node);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// ── THE PROMPTS ─────────────────────────────────────────────────────────────
// The sneaker and clothing defaults are the pre-Catalogue code defaults, moved
// here unchanged from functions/index.js (HOUSE_PROMPT_*) so the panel and the
// function read the SAME text (they were two hand-synced copies).
export const HOUSE_PROMPT_CLOTHING = [
  "You are re-shooting a product photo in our store's signature house style. The STYLE REFERENCE",
  "images show our exact studio scene — recreate that scene precisely: the same backdrop and wall,",
  "the same hangers and display hardware, the same lighting direction, softness and colour grade,",
  "the same camera height, distance, angle and framing, and the same layout and spacing. The output",
  "must look like it was shot in the SAME session, in the SAME spot, with the SAME lighting rig as",
  "the references.",
  "CRITICAL — the references define ONLY the scene and styling. The garments shown in the references",
  "are DIFFERENT products: none of their design, colour, fabric, branding or details may appear in",
  "the output.",
  "The PRODUCT image shows the actual item to photograph. Keep the product's design EXACTLY —",
  "identical shape, proportions, colour, materials, patterns, logos and text. Never redesign,",
  "restyle, recolour, or invent details the real product does not have. Render every brand wordmark",
  "and logo crisply and correctly — properly letter-formed, correctly spelled, matching the real",
  "brand's exact lettering; never garbled, warped or fake-looking.",
  "Present the garments as a coordinated SET, displayed exactly the way the reference sets are",
  "displayed — every piece visible in the product photo (e.g. hoodie and matching joggers) arranged",
  "together in the same configuration, on the same hangers, with the same spacing as the references.",
  "If the product photo shows a single piece, present just that piece in the identical scene and",
  "position. Settle out the creases a garment picks up from packing, folding or a hanger — but anything",
  "set into the cloth by WEAR stays. Natural drape, squared shoulders and straight hems; nothing cropped",
  "or cut off.",
  "Render the product's colours as the ITEM ACTUALLY IS — never washed out or over-exposed by the",
  "rendering, and never freshened either: colour genuinely lost to fading or yellowing stays lost. Darks",
  "must not be lifted or greyed by the exposure. Match the exposure and white balance of the reference",
  "scene so the product sits naturally in its lighting. Tack-sharp focus and fine detail throughout; a",
  "photorealistic result indistinguishable from a real photo of THIS item taken in our studio.",
].join(" ");

export const HOUSE_PROMPT_SNEAKER = [
  "You are re-shooting a product photo in our store's signature house style. The STYLE REFERENCE",
  "images show our exact studio scene — recreate it precisely: the same backdrop, surface, lighting",
  "direction, softness and colour grade, the same camera height, angle and framing, and the same",
  "shoe-and-box composition and spacing as the references. The output must look like it was shot in",
  "the SAME session, in the SAME spot, with the SAME lighting rig.",
  "CRITICAL — the references define ONLY the scene, layout and styling. The sneakers and boxes shown",
  "in them are DIFFERENT products: none of their design, colourway or branding may appear in the",
  "output.",
  "The PRODUCT image shows the actual sneaker to photograph. Keep its design EXACTLY — identical",
  "shape, proportions, colourway, materials, patterns, logos and text. Show the OUTER (lateral)",
  "branded display side facing the camera, keeping the SAME side and SAME left/right facing as the",
  "product photo — never flip, mirror or rotate to the plain inner side. Never redesign or invent",
  "details.",
  "Display the sneaker WITH its retail box, positioned exactly as the boxes are positioned in the",
  "references. If a BOX image is provided, reproduce that exact box — its true colours, graphics,",
  "logos and label text, correctly spelled and crisply rendered. If no box image is provided, show",
  "this exact model's authentic retail box using your knowledge of the real product; keep all box",
  "text and branding accurate and legible, and never invent box artwork that doesn't exist.",
  "Colours as the ITEM ACTUALLY IS — darks not lifted or greyed by the exposure, and colour genuinely",
  "lost to fading left lost; match the reference scene's exposure and white balance. Tack-sharp focus",
  "and detail; a photorealistic result indistinguishable from a real photo of THIS item in our studio.",
].join(" ");

// Every kit that is not under Sneakers or Clothing (Caps, Perfumes, Bags, …)
// until Junid saves its own prompt in the panel.
export const HOUSE_PROMPT_GENERIC = [
  "You are re-shooting a product photo in our store's signature house style. The STYLE REFERENCE",
  "images show exactly how we photograph this kind of product — recreate their scene precisely: the",
  "same backdrop, surface and display props, the same lighting direction, softness and colour grade,",
  "the same camera height, angle and distance, and the same framing and position of the product in",
  "the frame. The output must look like it was shot in the SAME session as the references.",
  "CRITICAL — the references set ONLY the scene, the angle, the lighting and the framing. The products",
  "shown in them are DIFFERENT items: never copy their design, colour, logo, text, shape or any detail",
  "into the output.",
  "The PRODUCT image shows the REAL item to photograph. Keep it EXACTLY — the same kind of product, the",
  "same colour or colours, the same logos and text, the same shape and proportions, the same materials,",
  "hardware, stitching and every detail. Never redesign, restyle, recolour, simplify or invent details,",
  "and never turn it into a different product. Render every logo and wordmark crisply and correctly",
  "spelled, matching the real brand's lettering.",
  "If a BOX image is provided, show that exact box beside the product the way the references show",
  "packaging; if none is provided, do not add a box or any object that is not in the product photo.",
  "Colours as the ITEM ACTUALLY IS — never washed out, brightened or shifted, darks not lifted or",
  "greyed; match the reference scene's exposure and white balance. Tack-sharp focus and fine detail; a",
  "photorealistic result indistinguishable from a real photo of THIS item in our studio.",
].join(" ");

export const HOUSE_DEFAULT_PROMPTS = Object.freeze({ clothing: HOUSE_PROMPT_CLOTHING, sneaker: HOUSE_PROMPT_SNEAKER });

// ── THE DRIFT CHECK (Junid, 20 Nov 2026) ────────────────────────────────────
// After every generation the result is compared with the ORIGINAL staff photo.
// Drifted → one retry; drifted again → the product's own cut-out is used.
export const DRIFT_MODEL = "gemini-3.7-flash";
export const DRIFT_PROMPT = [
  "You are checking an AI product photo for a shop. IMAGE 1 is the shop's own photo of the REAL product.",
  "IMAGE 2 is a new studio photo that must show THE SAME physical item.",
  "Ignore everything that is allowed to change: the background, the display props, the lighting, the camera",
  "angle, the framing, the size in the frame, creases, and any retail box or packaging.",
  "Judge ONLY the product itself: is it the same kind of product, with the same colour or colours, the same",
  "logos, text and graphics, the same shape and proportions, and the same distinctive details (straps,",
  "hardware, stitching, panels, lenses, cap, label)?",
  "Answer \"drifted\" ONLY for a clear difference a customer would notice — a different colour, a missing,",
  "changed or invented logo or graphic, a different shape, or a different product. Small rendering",
  "differences and details simply hidden by the new angle are \"same\".",
  "Reply with JSON only: {\"verdict\":\"same\"|\"drifted\",\"issues\":\"<one short sentence, empty if same>\"}",
].join(" ");

/** Read the drift model's text answer. Unreadable → null (unchecked, never a drift). Pure. */
export function parseDriftAnswer(text) {
  const t = String(text || "");
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const v = String(j.verdict || "").toLowerCase();
    if (v !== "same" && v !== "drifted") return null;
    return { drift: v === "drifted", issues: String(j.issues || "").slice(0, 200) };
  } catch { return null; }
}

// ── THE GARMENT FINISH + THE GARMENT QUALITY GATE (Junid, 21–22 Nov 2026) ───
// 21 Nov: a brown knit polo came out creased, crooked, with the layout diagram's
// rectangle drawn into the wall — every clothing generation got GARMENT_FINISH
// and a check after it. 22 Nov: the HUGO Boss shorts HB301# went through that
// very path and still came out creased and flat, and the check called it
// "same": the finish talked about collars and plackets (a polo), never about a
// waistband, a hem or the garment's body, and the check looked at two 768 px
// thumbnails and was only asked for faults "a customer would clearly notice".
// So:
//   · GARMENT_FINISH is now an explicit STYLING STEP in Junid's words — freshly
//     steamed and pressed, smooth wrinkle-free fabric, natural drape and full
//     shape (not flat or squashed), crisp hems and waistband, as professionally
//     styled for a catalogue — with the design frozen (colour, logos, prints,
//     text, drawstrings, every detail; nothing invented).
//   · THE GATE scores creases 0–10 and flatness 0–10 and confirms logos and
//     colour against the original. Failed → ONE retry with a stronger
//     instruction → failed again → THE BEST of the two is kept and FLAGGED
//     (never the creased original cut out on white, which is what the fallback
//     of 21 Nov handed back).
// Clothing only. Shoes are untouched by all of this.

/** Clothing — the products the garment finish and the garment gate apply to. Pure. */
export function isGarment(product) {
  const p = product || {};
  // A catalogue key that maps to a kit decides (a "Clothing" product filed under caps or bags is not a garment);
  // only a product with no such key falls back on its top category.
  const kit = CATEGORY_KIT[str(p.categoryKey)];
  if (kit) return kit === "clothing" || kit === "jerseys" || kit === "tracksuits";
  return p.category === "Clothing" || p.productType === "clothing";
}

export const GARMENT_FINISH = [
  "GARMENT FINISH — THE STYLIST'S STEP, DONE BEFORE THE PHOTOGRAPH. Before this picture was taken a professional",
  "stylist took this exact garment, steamed and pressed it, and dressed it on the hanger for a premium brand's",
  "catalogue. Photograph the garment in THAT state — never in the state the product photo shows it. This applies to",
  "every garment: shorts, T-shirts, polos, shirts, jerseys, hoodies, sweaters, jackets, tracksuits, jeans and trousers.",
  "1. FRESHLY STEAMED AND PRESSED — smooth, wrinkle-free fabric. Every wrinkle, crease, crumple, ripple, puckered",
  "patch and fold line in the product photo — including the straight line across or down a garment left by being",
  "folded in a bag — is from packing, storage and handling, never wear: the condition rule below lets it go, so it",
  "MUST go. Do not carry the photo's creases into the result, not even faintly. A seam, dart, pleat, panel join or",
  "stitched line is part of the garment and stays; an irregular line in the cloth is a crease and goes.",
  "2. NATURAL DRAPE AND FULL SHAPE — the garment hangs with the real weight and body of its fabric, full and",
  "three-dimensional, its legs, sleeves and body gently rounded like cloth with air in it. Never flat like a paper",
  "cut-out, never squashed, deflated, limp or pressed against the wall — and never inflated, stuffed or stretched.",
  "Its real cut, length and proportions are unchanged.",
  "3. CRISP HEMS AND WAISTBAND — hems straight, level and crisp; the waistband flat, level and even, its elastic",
  "gathers neat and regular; cuffs, ribbing and collar flat with sharp, even edges; the placket straight and its",
  "buttons aligned; drawstrings and cords hanging neatly.",
  "4. THE HANG — perfectly straight and centred on a straight hanger: shoulders or waistband level and symmetrical,",
  "both sleeves or both legs falling evenly. Never twisted, leaning, tilted, skewed or off-centre.",
  "5. THE DESIGN IS FROZEN — steaming changes the state of the cloth, never the garment. The exact colour, and every",
  "logo, print, graphic, word of text, label, badge, drawstring (its colour, length and tips), zip, button, pocket,",
  "seam, stitch line, trim and waistband stay exactly as in the product photo: the same place, size, colour and",
  "number. Invent NOTHING: no new logo, text, pocket, seam, pleat, pattern or detail. What is designed into the",
  "garment stays — pleats, gathers, ribbing, quilting, washed, faded, whiskered or distressed denim, crinkle",
  "fabric — and smooth never means shiny, plastic or ironed flat: the real knit, piqué, rib, fleece, denim or woven",
  "texture stays sharp and clearly visible.",
  "6. NO ARTEFACTS — the result holds only the backdrop and the garment: never a rectangle, frame line, border,",
  "box, dashed or guide line, grid, label or text taken from the layout diagram, the references or any other input",
  "image. The other images set the scene only.",
  "7. LIGHT — soft studio light with gentle depth and a subtle, soft shadow of the garment on the wall behind it,",
  "matching the house-style Marathon wall's lighting and colour grade.",
].join(" ");

// ── THE STEAM-AND-PRESS PASS (Junid, 22 Nov 2026) ───────────────────────────
// Telling the composing call to steam the garment was not enough: on HB301# it copied the cloth as photographed,
// twice, whatever the brief said (it is also told, rightly, never to change the product). A SECOND call that is
// handed the finished photo and ONE job — steam and press this garment, change nothing else — does it. This is the
// gate's retry for a photo whose only fault is its finish (creased, flat); a changed logo or colour is re-made.
export const GARMENT_RETOUCH = [
  "RETOUCH THIS PHOTOGRAPH — ONE JOB: STEAM AND PRESS THE GARMENT.",
  "IMAGE 1 is a finished studio photograph of a garment hanging on our shop's backdrop. Return the SAME photograph —",
  "the same backdrop, hanger, position, size, framing, light and colour — with ONE change: before the picture was",
  "taken, a professional stylist steamed and pressed this garment and dressed it on the hanger for a brand catalogue.",
  "So the cloth is now smooth and wrinkle-free over the whole garment — the body, each leg or sleeve, under the",
  "waistband or collar, down to the hems: every wrinkle, crease, ripple, puckered patch and fold line in IMAGE 1 is",
  "gone, including the straight vertical or horizontal lines left by being folded in a bag. The garment hangs with",
  "natural drape and its full shape, the cloth with real body and depth, never flat or squashed, never inflated;",
  "the hems are straight, level and crisp; the waistband or collar is flat, level and even, its elastic gathers neat",
  "and regular; drawstrings hang neatly.",
  "NOTHING ELSE CHANGES. It is the same garment: the exact colour, and every logo, print, graphic, word of text,",
  "label, badge, drawstring (its colour, length and tips), zip, button, pocket, seam, stitch line, trim and waistband",
  "exactly as in IMAGE 1 — the same place, size and colour. Invent nothing: no new logo, text, pocket, seam, pleat or",
  "pattern. Seams, stitch lines, pleats, ribbing, elastic gathers, designed fades or distressing and the fabric's",
  "real texture stay; smooth never means shiny, plastic or airbrushed. The backdrop, the hanger and the garment's",
  "soft shadow stay as they are. No rectangle, line, border or text is added anywhere.",
  "IMAGE 2 is the shop's own snapshot of the real garment: use it ONLY to confirm logos, text and details. Its",
  "creases are packing creases — never copy them.",
].join(" ");
/** Faults a steam-and-press pass can put right; anything else means the photo is made again. */
export const GARMENT_FINISH_FAULTS = Object.freeze(["wrinkles", "flat"]);
/** Is a failed garment photo right in everything but its finish (so the retry is the steam-and-press pass)? Pure. */
export const finishOnly = (faults) => Array.isArray(faults) && faults.length > 0 && faults.every((f) => GARMENT_FINISH_FAULTS.includes(f));

// The faults the gate may name. "product" and "colour" are the drift check's; "lines", "wrinkles" and "tilt" are
// Junid's 21 Nov list; "flat" (squashed, no body) is his of 22 Nov.
export const GARMENT_FAULTS = Object.freeze(["product", "colour", "lines", "wrinkles", "flat", "tilt"]);
/** Faults that mean the photo shows something other than the real product: these outrank any finish fault. */
export const GARMENT_IDENTITY_FAULTS = Object.freeze(["product", "colour"]);
// The scores a photo may carry and still pass (0 = perfect, 10 = worst). Calibrated on HB301# and ten others, 22 Nov.
export const GARMENT_CREASE_MAX = 3;
// "carried": how much of the ORIGINAL photo's creasing is still in the new photo (0 none, 10 all of it). The
// comparative question is the one the checker answers steadily: on HB301# it gave the un-steamed photos 6–7 every
// time and the steamed one 3 every time, while the absolute crease score hovered at 3–4 for all of them.
export const GARMENT_CARRIED_MAX = 3;
export const GARMENT_FLAT_MAX = 5;
// The gate looks at the photos large enough to see a crease (the drift check's 768 px could not).
export const GARMENT_CHECK_EDGE = 1536;

export const GARMENT_CHECK_PROMPT = [
  "You are the quality controller for a clothing shop's catalogue. IMAGE 1 is the shop's own snapshot of the REAL",
  "garment. IMAGE 2 is a new AI studio photo that must show THE SAME garment, freshly steamed and professionally",
  "styled. The background, hanger, lighting, framing and size in the frame are allowed to change. Be strict: this",
  "photo is only good enough if a brand would print it in its own catalogue. Judge IMAGE 2:",
  "\"crease\" — an integer 0 to 10 for wrinkles, creases, fold lines, ripples, puckering and crumpling in the cloth.",
  "0 = perfectly smooth, straight off the steamer. 2 = smooth, at most one or two faint soft ripples. 4 = a clear",
  "fold line (for example the straight line down or across a garment that was folded in a bag) or several visible",
  "creases. 6 = plainly creased, like a garment just unpacked. 8 to 10 = heavily crumpled. Look at the whole",
  "garment: the body, each leg or sleeve, the area under the waistband or collar, the hems. Do NOT count what is",
  "made into the garment: seams, stitch lines, darts, pleats, panel joins, ribbing, knit texture, quilting, the",
  "regular gathers of an elasticated waistband or cuff, designed fades or distressing. Do NOT count creasing worn",
  "into the fabric by use that IMAGE 1 also shows (a permanent knee or elbow break, a stretched hem).",
  "\"carried\" — an integer 0 to 10: how much of the creasing of IMAGE 1 is still in IMAGE 2. Find the wrinkles, fold",
  "lines and crumpled areas of the garment in IMAGE 1, then look for each one at the same place on the garment in",
  "IMAGE 2. 0 = none of them is there any more (it was steamed). 5 = about half are still there, or they are all",
  "there but fainter. 10 = all of them are still there, the cloth simply copied from IMAGE 1. If IMAGE 1 shows no",
  "creasing at all, answer 0.",
  "\"flat\" — an integer 0 to 10 for lifelessness. 0 = full, natural drape with real body and depth. 5 = rather flat.",
  "10 = looks like a flat paper cut-out stuck to the wall, squashed, deflated or limp.",
  "\"logos\" — \"same\" or \"changed\": every logo, print, graphic, word of text, label and badge visible in IMAGE 1 is",
  "in IMAGE 2 in the same place, spelled the same, the same colour; nothing added. A detail merely hidden by the",
  "new angle is \"same\".",
  "\"colour\" — \"same\" or \"changed\": the body colour, trims, waistband, drawstring and button colours match IMAGE 1",
  "(allow for the better lighting).",
  "\"product\" — \"same\" or \"changed\": it is the same garment — the same kind, cut, length, pockets, drawstrings and",
  "details; nothing invented, nothing removed.",
  "\"lines\" — true if the picture holds a rectangle, frame line, border, box outline, dashed or guide line, grid,",
  "label or text that is not part of the garment or the backdrop (the backdrop's own mesh, rails and posts are fine).",
  "\"tilt\" — true if the garment hangs tilted, leaning, twisted or clearly off-centre, or its shoulders, waistband",
  "or hem are not level.",
  "When an IMAGE 3 is given it is a close-up of the middle of IMAGE 2: look for creases there.",
  "Reply with JSON only: {\"crease\":<0-10>,\"carried\":<0-10>,\"flat\":<0-10>,\"logos\":\"same\"|\"changed\",\"colour\":\"same\"|\"changed\",",
  "\"product\":\"same\"|\"changed\",\"lines\":true|false,\"tilt\":true|false,",
  "\"issues\":\"<one short sentence naming what is wrong, empty if nothing>\"}",
].join(" ");

const score10 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : null; };

/**
 * Read the garment gate's answer. Unreadable → null (unchecked, never a fail).
 * → { drift (= failed), faults: [...], crease, carried, flat, issues }  Pure.
 * (The 21 Nov answer shape — {"faults":[…]} with no scores — is still read, so an in-flight answer never breaks.)
 */
export function parseGarmentAnswer(text) {
  const t = String(text || "");
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const issues = String(j.issues || "").slice(0, 200);
    const crease = score10(j.crease), flat = score10(j.flat), carried = score10(j.carried);
    if (crease === null) {
      if (!Array.isArray(j.faults)) return null;
      const faults = GARMENT_FAULTS.filter((f) => j.faults.map((x) => String(x).toLowerCase().trim()).includes(f));
      return { drift: faults.length > 0, faults, crease: null, carried: null, flat: null, issues };
    }
    const changed = (v) => String(v || "").toLowerCase().trim() === "changed";
    const found = {
      product: changed(j.product) || changed(j.logos), colour: changed(j.colour), lines: j.lines === true,
      wrinkles: crease > GARMENT_CREASE_MAX || (carried !== null && carried > GARMENT_CARRIED_MAX), flat: flat !== null && flat > GARMENT_FLAT_MAX, tilt: j.tilt === true,
    };
    const faults = GARMENT_FAULTS.filter((f) => found[f]);
    return { drift: faults.length > 0, faults, crease, carried, flat, issues };
  } catch { return null; }
}

/**
 * Which of two failed attempts is the better photo to keep (Junid, 22 Nov 2026: "keep the best version and flag
 * it"). The real product first (no changed logo, colour or garment), then no drawn lines, then the fewest faults,
 * then the lower crease scores (crease + carried), then the lower flatness. A tie keeps the retry (it was told the fix). Pure.
 * a, b: { faults, crease, flat } → "first" | "retry"
 */
export function betterGarment(first, retry) {
  const key = (d) => {
    const f = (d && d.faults) || [];
    return [f.filter((x) => GARMENT_IDENTITY_FAULTS.includes(x)).length, f.includes("lines") ? 1 : 0, f.length,
      (Number.isFinite(d?.crease) ? d.crease : 5) + (Number.isFinite(d?.carried) ? d.carried : 5), Number.isFinite(d?.flat) ? d.flat : 5];
  };
  const a = key(first), b = key(retry);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? "first" : "retry";
  return "retry";
}

const FIX_TEXT = Object.freeze({
  product: "it CHANGED THE GARMENT — this time the garment is exactly the one in the product photo: every logo, print, word of text, label, drawstring, pocket and detail as it is, in the same place, nothing added and nothing left out",
  colour: "the COLOUR DRIFTED — this time the body colour, trims, waistband, drawstrings and buttons are exactly the colours in the product photo",
  lines: "it DREW A RECTANGLE OR LINES into the picture — this time the picture holds only the backdrop and the garment, with no rectangle, frame line, border, box, guide line or text anywhere",
  wrinkles: "the garment was LEFT CREASED — it still carried the wrinkles and fold lines of the product photo. This time it is freshly steamed and pressed BEFORE the photograph: perfectly smooth, wrinkle-free cloth over the whole garment — the body, each leg or sleeve, under the waistband or collar, down to the hems — with no wrinkle, crease, ripple, puckering or fold line left anywhere, the fabric's real texture still sharp. Do not copy any crease from the product photo (every seam, panel line, stripe, collar, trim and elastic gather the garment is MADE with stays exactly as in the product photo)",
  flat: "the garment looked FLAT AND SQUASHED — this time it hangs with natural drape and its full shape, the cloth with real body and depth, gently rounded, crisp level hems and waistband, as a stylist dresses it for a catalogue; never a flat cut-out, never limp, and never inflated or stretched either",
  tilt: "the garment HUNG CROOKED — this time it hangs perfectly straight and centred, shoulders or waistband level and symmetrical, hem straight, sleeves or legs falling evenly",
});

/** The fix the retry is told, from the faults the gate found. null when there is nothing to fix. Pure. */
export function garmentFixNote(faults) {
  const fs = GARMENT_FAULTS.filter((f) => (faults || []).includes(f));
  if (!fs.length) return null;
  return `FIX FROM THE LAST ATTEMPT — THIS OUTRANKS EVERYTHING EXCEPT THE CONDITION RULE (the last attempt failed the quality check and was thrown away): ${fs.map((f) => FIX_TEXT[f]).join("; ")}. Everything else about the photograph stays as briefed.`;
}

/** What the card says about a photo that failed the gate twice and was kept as the best of the two. Pure. */
export function garmentFlagNote(d) {
  const f = (d && d.faults) || [];
  const say = { product: "a logo or detail may have changed", colour: "the colour may be off", lines: "there may be stray lines in the picture", wrinkles: "it still looks creased", flat: "it still looks flat", tilt: "it hangs crooked" };
  const what = GARMENT_FAULTS.filter((x) => f.includes(x)).map((x) => say[x]);
  return `FLAGGED — this photo did not pass the quality check after two tries${what.length ? ` (${what.join("; ")})` : ""}. It is the better of the two; check it by eye, or tap Regenerate.`;
}
