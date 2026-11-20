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
  const fallback = chain[chain.length - 1];
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
