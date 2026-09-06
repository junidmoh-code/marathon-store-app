// ─── PRODUCT ATTRIBUTES — one controlled schema per sneaker ──────────────────
//
// WHY THIS EXISTS. A shop assistant taps size 8, the chip says ✕, and the sale
// walks out of the door. To answer "not that one — but these, right now" the
// app has to know what a shoe LOOKS LIKE, and today it knows almost nothing:
// measured on the 1,410 live sneaker products (2026-09-06),
//
//   brand           100.0%      <- already there, never extract it again
//   category        100.0%      <- already there
//   categoryKey      97.7%      <- already there
//   retailPrice     100.0%      <- already there; priceBand is ARITHMETIC
//   colour / color / colourway   0.0%     ← nothing. Not one record.
//   dominantColours   3.6%      ← RGB swatches, too sparse to match on
//   productType      44.1%      ← and unreliable (footwearLine.js:26-30)
//
// So colour, silhouette, material, pattern, toe shape and sole colour are the
// only things worth spending a vision call on. Everything else is READ.
//
// ── WHY THE VOCABULARY IS CLOSED ─────────────────────────────────────────────
// Free text does not match. "off-white", "cream", "bone", "ecru" and "eggshell"
// are one shoe colour and five strings, and a similarity score over strings
// scores them all zero against each other. Every field below is an enum, and
// colour additionally rolls up to a FAMILY so "burgundy" and "oxblood" can rank
// together without being called the same colour. An extraction that lands
// outside the vocabulary is REFUSED, not coerced — a coerced value is a wrong
// value that looks right, and it would surface as a suggestion a customer is
// shown.
//
// ── WHY THE NAMER MOVES IN HERE ──────────────────────────────────────────────
// The lexicon namer strips the brand and rebuilds a title from what is left,
// which is how four different shoes all became "Sneaker Black" and how 178
// publish nodes ended up blocked on handle collisions ("sneaker-white" x12,
// "sneaker-black" x11). The vision namer that replaced it writes good prose but
// as a SEPARATE judgement from the identity in the same response — two readings
// of one photo that can disagree. Here the name is DERIVED from the attributes
// (nameFromAttributes), so a name and the data behind a suggestion can never
// say different things, and two shoes get the same name only if every visible
// attribute of them is identical.
//
// ── WHERE IT IS STORED, AND WHY NOT ON /products ─────────────────────────────
// /product_attributes/{pid}. The app holds a full onValue subscription to
// /products (App.jsx:559) — 3.92 MB streamed to every device on every session —
// and this record is EXTRACTION data that no client ever reads: only the
// neighbour-building script and the admin surfaces want it. Parking ~350 bytes
// x 1,410 on the hot node would cost every till and phone that traffic forever
// for data they never open.
//
// The NEIGHBOUR LIST is the opposite case and does live on the product record
// (see productNeighbours.js): the ✕ sheet needs it the instant a chip is
// tapped, and a per-tap fetch is a spinner in front of a customer.
//
// ── ADDITIVE AND VERSIONED ───────────────────────────────────────────────────
// A human-confirmed value is NEVER overwritten by a machine one. The two live
// in separate children (`a` machine, `confirmed` human) and resolveAttributes
// prefers `confirmed` field by field, so a re-run at any version cannot touch a
// correction someone made. EXTRACTOR_VERSION makes a run diffable and makes
// resuming free: a product already carrying the current version is skipped
// without re-billing.
//
// PURE. No firebase, no network, no I/O — the runner supplies the photo and the
// writes. Everything decidable without an API key is decided and tested here.

import { triggersInText } from "./shopifyTriggers.js";

// ─── VERSION ─────────────────────────────────────────────────────────────────
// Bump when the SCHEMA or the PROMPT changes in a way that makes an old
// extraction not comparable to a new one. A bump makes every product eligible
// again; leaving it alone makes a crashed run resume for free.
// v2 (2026-09-06) — WIDENED AFTER THE PILOT MEASURED IT TOO COARSE. On 205
// products v1 produced 190 distinct attribute signatures but only 188 distinct
// handles, with 12 colliding groups over 29 products (one group of six: six
// different shoes that were all "leather low-top black solid round-toe"). The
// existing prose namer collided ZERO times on the same 205, so v1 would have
// been a regression on the very thing this build exists to fix.
//
// The pilot also showed WHY: toeShape is 82.9% "round" across the catalogue —
// a true fact about sneakers and therefore nearly useless for telling them
// apart, and it was the namer's FIRST escalation tier. So v2 adds the three
// things that are highly visible in a product photo and actually vary
// (soleType, closure, finish) and re-orders the tiers to spend them first.
export const EXTRACTOR_VERSION = 2;

/** Where an extraction lives. Sibling of /products, never inside it. */
export const ATTRIBUTES_PATH = "product_attributes";

/**
 * The `nameProposal.source` an attribute-derived name carries.
 *
 * It is what keeps the two namers from overwriting each other for ever:
 * vision-name.mjs (the prose namer, scheduled nightly on the mini) skips any
 * node already carrying one of these, so a product the attribute namer could
 * name belongs to the attribute namer, and everything else — clothing,
 * accessories, unenriched sneakers, and the shoes whose attributes cannot
 * separate them from another shoe — stays the prose namer's.
 */
export const ATTRIBUTE_NAME_SOURCE = "attributes";

// ─── THE CONTROLLED VOCABULARIES ─────────────────────────────────────────────
// Order is meaningless; membership is everything. Every list is frozen so a
// caller cannot quietly widen the vocabulary at runtime and produce values the
// validator would have refused.

// The silhouettes the brief names, plus the two the live catalogue actually
// needs: "sandal" (64 slides + open sandals share a categoryKey) and
// "soccer-boot" (80 live products, a cleat is not a boot and must never be
// suggested as an alternative to one).
export const SILHOUETTES = Object.freeze([
  "low-top", "mid", "high-top", "runner", "slide", "sandal",
  "boot", "soccer-boot", "loafer", "dress",
]);

export const UPPER_MATERIALS = Object.freeze([
  "leather", "nubuck", "patent", "canvas", "mesh", "knit", "synthetic",
  "rubber", "denim", "corduroy", "calf-hair", "textile-mix",
]);

// ── COLOUR: the closed list, and the family every colour rolls up to ─────────
// The FAMILY is what ranking uses. The colour itself is what the name uses.
// A shopper refused a black shoe will look at another black shoe; they will not
// look at a yellow one, and no scoring weight should let them.
export const COLOUR_FAMILY_OF = Object.freeze({
  black: "black", "off-black": "black", charcoal: "black",
  // "off-white" is DELIBERATELY absent: Off-White is a label and
  // shopifyTriggers.js refuses it, so a colour by that name would produce a
  // listing title the publish path can never accept. "cream" and "bone" cover
  // the same shoe. Proved by nameVocabularyTriggers() and pinned by a test.
  white: "white", cream: "white", bone: "white", eggshell: "white",
  grey: "grey", "light-grey": "grey", silver: "grey",
  navy: "blue", blue: "blue", "royal-blue": "blue", "light-blue": "blue", teal: "blue",
  red: "red", burgundy: "red", maroon: "red", rust: "red",
  pink: "pink", rose: "pink",
  orange: "orange", coral: "orange",
  yellow: "yellow", gold: "yellow", mustard: "yellow",
  green: "green", olive: "green", mint: "green",
  brown: "brown", tan: "brown", sand: "brown", beige: "brown", chocolate: "brown",
  purple: "purple", lilac: "purple",
  multicolour: "multicolour",
});
export const COLOURS = Object.freeze(Object.keys(COLOUR_FAMILY_OF));
export const COLOUR_FAMILIES = Object.freeze([...new Set(Object.values(COLOUR_FAMILY_OF))]);

/** The family a colour rolls up to, or "" for anything outside the vocabulary. */
export function colourFamily(colour) {
  // Own-property only — COLOUR_FAMILY_OF["__proto__"] is Object.prototype,
  // which is truthy and not a family. See `word` below for the same hazard.
  const k = String(colour ?? "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(COLOUR_FAMILY_OF, k) ? COLOUR_FAMILY_OF[k] : "";
}

export const PATTERNS = Object.freeze(["solid", "two-tone", "multi", "print"]);

// MEASURED 82.9% "round" on the 205-product pilot. Kept — the owner brief names
// it, and the 17% that are not round are genuinely told apart by it — but it is
// the LAST thing the namer reaches for, not the first, and it carries a small
// weight. A field that is one value four times in five cannot carry a name.
export const TOE_SHAPES = Object.freeze(["round", "almond", "square", "pointed", "open"]);

// ── THE v2 WIDENING ──────────────────────────────────────────────────────────
// The three things a person picks a shoe out of a row by, that v1 did not ask
// for. All optional: a shoe whose sole the photo does not show still enriches,
// it just discriminates less.
export const SOLE_TYPES = Object.freeze([
  "cup", "gum", "chunky", "platform", "wedge", "vulcanised", "rocker",
  "cushioned", "cleated", "flat",
]);
export const CLOSURES = Object.freeze([
  "laced", "slip-on", "strap", "buckle", "zip", "elastic", "velcro",
]);
export const FINISHES = Object.freeze([
  "plain", "matte", "glossy", "metallic", "distressed", "perforated",
  "quilted", "textured", "woven",
]);

// The style tags. SMALL and deliberately so: a tag vocabulary that grows past
// what a person can hold in their head stops being a controlled vocabulary and
// becomes free text with extra steps.
export const STYLE_TAGS = Object.freeze([
  "retro", "minimal", "chunky", "technical", "luxury", "skate",
  "basketball", "running", "formal", "outdoor", "casual",
]);

// ─── PRICE BANDS — arithmetic, never a vision call ───────────────────────────
// Cut from the live distribution of the 1,410 sneakers (all 100% priced):
// p10 R550 · p25 R700 · median R750 · p75 R800 · p90 R1,100 · max R6,009.
// The mass sits between 700 and 800, so the bands have to be tight down there
// or every shoe lands in one band and the term does no ranking work at all.
export const PRICE_BANDS = Object.freeze(["budget", "core", "mid", "premium", "luxury"]);
export const PRICE_BAND_CUTS = Object.freeze([600, 760, 1000, 1800]);

/** The band a rand price falls in, or "" when the product carries no price. */
export function priceBandOf(retailPrice) {
  const r = Number(retailPrice);
  if (!Number.isFinite(r) || r <= 0) return "";
  const i = PRICE_BAND_CUTS.findIndex((cut) => r < cut);
  return i === -1 ? PRICE_BANDS[PRICE_BANDS.length - 1] : PRICE_BANDS[i];
}

// ─── THE SCHEMA ──────────────────────────────────────────────────────────────
// Every field, what it is allowed to hold, and who fills it. `from` is the
// honest answer to "did we pay for this?": "record" and "derived" cost nothing,
// "vision" is the only thing a call buys.
export const ATTRIBUTE_FIELDS = Object.freeze({
  brand:           { from: "record",  vocab: null,            required: false },
  category:        { from: "record",  vocab: null,            required: false },
  silhouette:      { from: "vision",  vocab: SILHOUETTES,     required: true },
  upperMaterial:   { from: "vision",  vocab: UPPER_MATERIALS, required: true },
  primaryColour:   { from: "vision",  vocab: COLOURS,         required: true },
  secondaryColour: { from: "vision",  vocab: COLOURS,         required: false },
  colourFamily:    { from: "derived", vocab: COLOUR_FAMILIES, required: true },
  pattern:         { from: "vision",  vocab: PATTERNS,        required: true },
  toeShape:        { from: "vision",  vocab: TOE_SHAPES,      required: false },
  soleColour:      { from: "vision",  vocab: COLOURS,         required: false },
  soleType:        { from: "vision",  vocab: SOLE_TYPES,      required: false },
  closure:         { from: "vision",  vocab: CLOSURES,        required: false },
  finish:          { from: "vision",  vocab: FINISHES,        required: false },
  priceBand:       { from: "derived", vocab: PRICE_BANDS,     required: false },
  styleTags:       { from: "vision",  vocab: STYLE_TAGS,      required: false, list: true },
});
export const ATTRIBUTE_KEYS = Object.freeze(Object.keys(ATTRIBUTE_FIELDS));

/** The fields a vision call is actually asked for — the only ones it can set. */
export const VISION_FIELDS = Object.freeze(
  ATTRIBUTE_KEYS.filter((k) => ATTRIBUTE_FIELDS[k].from === "vision")
);

// At most this many tags. Three is what a person can read on one line, and an
// unbounded list would let the model tag every shoe with every tag, which
// scores identically to tagging none of them.
export const MAX_STYLE_TAGS = 3;

/**
 * Is `value` legal for `field`? Empty is legal for an optional field and never
 * for a required one. Outside the vocabulary is ALWAYS illegal — no coercion,
 * no nearest match. (See the header: a coerced value is a wrong value that
 * looks right, and it reaches a customer.)
 */
export function isLegalAttribute(field, value) {
  const spec = ATTRIBUTE_FIELDS[field];
  if (!spec) return false;
  if (spec.list) {
    if (!Array.isArray(value)) return !spec.required && (value === undefined || value === null);
    if (value.length > MAX_STYLE_TAGS) return false;
    return value.every((v) => spec.vocab.includes(v));
  }
  const s = value === undefined || value === null ? "" : String(value).trim();
  if (s === "") return !spec.required;
  if (!spec.vocab) return true;             // brand / category — free, from the record
  return spec.vocab.includes(s);
}

// ─── RESOLUTION — human first, machine second, always ────────────────────────
/**
 * The attribute values to actually USE for a product. `confirmed` wins field by
 * field over `a`; a confirmed value survives every re-run at every version,
 * because nothing in the extractor path ever writes to `confirmed`.
 *
 * Returns a plain object over ATTRIBUTE_KEYS with "" (or []) for anything
 * neither side supplied — so a caller never has to test for undefined.
 */
export function resolveAttributes(node) {
  const machine = node?.a || {};
  const human = node?.confirmed || {};
  const out = {};
  for (const k of ATTRIBUTE_KEYS) {
    const spec = ATTRIBUTE_FIELDS[k];
    const h = human[k];
    const m = machine[k];
    const pick = (spec.list ? Array.isArray(h) && h.length : h !== undefined && h !== null && h !== "")
      ? h : m;
    out[k] = spec.list ? (Array.isArray(pick) ? pick : []) : (pick === undefined || pick === null ? "" : String(pick));
  }
  return out;
}

/** Which fields came from a person. Drives the "confirmed" marks in admin. */
export function confirmedFields(node) {
  const human = node?.confirmed || {};
  return ATTRIBUTE_KEYS.filter((k) => {
    const v = human[k];
    return ATTRIBUTE_FIELDS[k].list ? Array.isArray(v) && v.length > 0 : v !== undefined && v !== null && v !== "";
  });
}

/**
 * Is this product's extraction current? A resumable run skips every product
 * this returns true for, which is what makes a crashed run cost nothing to
 * restart. A DIFFERENT version is not current — that is the point of the stamp.
 */
export function isCurrentExtraction(node, version = EXTRACTOR_VERSION) {
  return Number(node?.v) === Number(version) && !!node?.a;
}

/**
 * Everything needed to rank and to name, or null when the product is not
 * usable. Deliberately returns null rather than a half-filled object: a
 * product that cannot be enriched stays unenriched and is simply ABSENT from
 * suggestions (owner constraint — nobody hand-tags anything).
 */
export function usableAttributes(node) {
  if (!node?.a) return null;
  const r = resolveAttributes(node);
  for (const k of ATTRIBUTE_KEYS) {
    if (ATTRIBUTE_FIELDS[k].required && !(r[k] && String(r[k]).length)) return null;
  }
  return r;
}

// ─── THE RECORD THE EXTRACTOR WRITES ─────────────────────────────────────────
/**
 * Build the /product_attributes/{pid} payload. `confirmed` is NEVER included —
 * this function cannot produce it, which is the structural reason a re-run
 * cannot clobber a human correction.
 *
 * `at` is supplied by the caller rather than read from Date.now() here: this
 * module is pure, and the app's rule is that every timestamp it writes is
 * server-anchored — serverNowMs() from a browser, and from a script the RTDB
 * server sentinel itself.
 *
 * WHICH IS WHY `at` IS NOT COERCED WITH Number(). It was, and the first 205
 * records went in carrying `at: 0`: the Admin SDK's ServerValue.TIMESTAMP is
 * the OBJECT {".sv":"timestamp"}, Number() of it is NaN, and `|| 0` turned
 * every extraction's timestamp into zero. The value looked plausible in the
 * code and was wrong in the database, which is the only place it matters.
 * A sentinel object is passed through untouched; a real number is kept when it
 * is positive; anything else is 0.
 *
 * RTDB CANNOT STORE AN EMPTY ARRAY — writing [] deletes the child and it reads
 * back null. So an empty styleTags is OMITTED rather than written empty, and
 * every reader treats absent as [] (resolveAttributes does).
 */
/**
 * A timestamp this module is allowed to store. A POSITIVE NUMBER (a client's
 * serverNowMs) or an RTDB server sentinel object, which is opaque here on
 * purpose — this module has no firebase import and must not grow one.
 */
export function serverStamp(at) {
  if (at && typeof at === "object") return at;      // {".sv":"timestamp"}
  const n = Number(at);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function buildAttributeRecord({
  vision, product, model, at, version = EXTRACTOR_VERSION, previousVersion = null,
}) {
  const a = {};
  const conf = {};
  const from = {};

  // From the RECORD. Free, already 100% filled, and never worth a token.
  if (product?.brand) { a.brand = String(product.brand).trim(); from.brand = "record"; }
  if (product?.category) { a.category = String(product.category).trim(); from.category = "record"; }

  // From the VISION call. Only the fields it was asked for, only legal values.
  for (const k of VISION_FIELDS) {
    let v = vision?.[k];
    // A LIST is capped BEFORE it is judged. MAX_STYLE_TAGS is a display limit
    // ("what fits on one line"), not a vocabulary rule — a model that returns
    // four legal tags has told the truth, and throwing the whole field away for
    // that would lose three good tags to punish one extra.
    if (ATTRIBUTE_FIELDS[k].list && Array.isArray(v)) v = v.slice(0, MAX_STYLE_TAGS);
    if (!isLegalAttribute(k, v)) continue;
    if (ATTRIBUTE_FIELDS[k].list) {
      if (Array.isArray(v) && v.length) { a[k] = v; from[k] = "vision"; }
      continue;                                   // [] omitted — see the header
    }
    const s = String(v ?? "").trim();
    if (!s) continue;
    a[k] = s;
    from[k] = "vision";
  }

  // DERIVED. Arithmetic over what we already hold — never a call.
  const fam = colourFamily(a.primaryColour);
  if (fam) { a.colourFamily = fam; from.colourFamily = "derived"; }
  const band = priceBandOf(product?.retailPrice);
  if (band) { a.priceBand = band; from.priceBand = "derived"; }

  // PER-FIELD CONFIDENCE. The model reports one number per vision field; a
  // field it did not report gets no entry rather than a fabricated 0 — absent
  // and "certainly wrong" are different claims.
  for (const k of VISION_FIELDS) {
    if (a[k] === undefined) continue;
    const c = Number(vision?.confidence?.[k]);
    if (Number.isFinite(c)) conf[k] = Math.min(1, Math.max(0, c));
  }

  return {
    v: version,
    at: serverStamp(at),
    model: model || null,
    a,
    from,
    ...(Object.keys(conf).length ? { conf } : {}),
    // What this extraction REPLACED, so a bad version is diffable rather than
    // merely gone. Null (not omitted) so a stale stamp from an older run can
    // never be mistaken for this one's.
    supersededV: previousVersion === null || previousVersion === version ? null : Number(previousVersion),
  };
}

// ─── THE NAME, DERIVED FROM THE ATTRIBUTES ───────────────────────────────────
// Not a second judgement about the photo — a function of the data behind the
// suggestion, so the two can never disagree.
//
// The shape is deliberately fixed and the SPECIFICITY comes from the
// attributes, not from sentence variety: what made "Sneaker Black" collide was
// missing information, not a repeated template. A shoe with a material, a
// silhouette, a pattern, two colours, a toe shape and a sole colour has
// 12 x 10 x 4 x 27 x 27 x 5 x 27 distinguishable states before brand is even
// considered, and the namer spends them from most to least discriminating
// until the name is specific enough to stand alone.
//
// COMPLIANCE IS INHERITED, NOT RE-ARGUED. Every word this can emit comes from
// a frozen vocabulary above, and assertNameVocabularyIsTriggerFree() below
// proves at import time that not one of them is a brand/model trigger — so a
// derived name cannot be refused by validateVisionName for a word this module
// chose. (The suede lesson: the old prompt SUGGESTED a word its own validator
// refused, and every name that took the advice was refused, regenerated at full
// price, then refused for good.)

const PATTERN_WORD = Object.freeze({ solid: "", "two-tone": "two-tone", multi: "colour-block", print: "printed" });
const SILHOUETTE_WORD = Object.freeze({
  "low-top": "low-top", mid: "mid-top", "high-top": "high-top", runner: "runner",
  slide: "slide", sandal: "sandal", boot: "boot", "soccer-boot": "moulded-stud boot",
  loafer: "loafer", dress: "dress shoe",
});
const MATERIAL_WORD = Object.freeze({
  leather: "leather", nubuck: "nubuck", patent: "patent", canvas: "canvas", mesh: "mesh",
  knit: "knit", synthetic: "coated", rubber: "rubber", denim: "denim",
  corduroy: "corduroy", "calf-hair": "calf-hair", "textile-mix": "textile",
});
const TOE_WORD = Object.freeze({ round: "round-toe", almond: "almond-toe", square: "squared-toe", pointed: "pointed-toe", open: "open-toe" });

// v2. "plain" and "laced" emit NOTHING: they are the defaults, and a word that
// is true of most of the catalogue lengthens a name without telling anyone
// anything — which is exactly what 82.9%-round "round-toe" was doing at tier 1.
const FINISH_WORD = Object.freeze({
  plain: "", matte: "matte", glossy: "glossy", metallic: "metallic",
  distressed: "distressed", perforated: "perforated", quilted: "quilted",
  textured: "textured", woven: "woven",
});
const SOLE_WORD = Object.freeze({
  cup: "cup sole", gum: "gum sole", chunky: "chunky sole", platform: "platform sole",
  wedge: "wedge sole", vulcanised: "vulcanised sole", rocker: "rocker sole",
  // NOT "air-cushioned": "Air" is a brand token in the compliance lexicon (and
  // a live `brand` value on 15 products), so that phrasing would be refused.
  cushioned: "cushioned sole", cleated: "studded sole", flat: "flat sole",
});
const CLOSURE_WORD = Object.freeze({
  // Every clause is a "with …" phrase so it reads after the sole clause rather
  // than colliding with it — "on a cup sole slip-on" is not a sentence.
  laced: "", "slip-on": "with no laces", strap: "with a strap", buckle: "with a buckle",
  zip: "with a zip", elastic: "with elastic panels", velcro: "with a hook-and-loop strap",
});

// The publish path's own ceiling (shopifyPublishCore.checkCleanName,
// visionNaming.validateVisionName). Named here rather than repeated as a magic
// 80 so the two can be seen to be the same number.
export const MAX_NAME_LENGTH = 80;

// ── LOOK A WORD UP WITHOUT INHERITING ONE ────────────────────────────────────
// `MAP[key] || ""` is wrong for any key that comes from data. `MAP["__proto__"]`
// returns Object.prototype — truthy, not a string, and `|| ""` does not catch
// it — so titleCase() then reads [0] of an object and throws, taking the namer
// down. Found by the property fuzz feeding "__proto__" as an attribute value,
// which is reachable: a `confirmed` value is written by a person straight into
// RTDB and is not vocabulary-checked on the way out.
//
// Own-property only, and it must actually be a string. Every word map in this
// file goes through it.
const word = (map, key) =>
  (typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key)
    && typeof map[key] === "string") ? map[key] : "";

const titleCase = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
// IN-VOCABULARY ONLY. Anything else is dropped rather than printed: a
// `confirmed` value is written by a person straight into RTDB and is not
// vocabulary-checked on the way out, so a colour of "UNKNOWN" reached a
// customer-facing listing title verbatim — and was then refused by the publish
// path for being ALL CAPS (found by the fuzz). The closed vocabulary has to be
// enforced where the words are USED, not only where they are written.
const colourWord = (c) => (COLOURS.includes(c) ? String(c).replace(/-/g, " ") : "");

/**
 * The public listing name for a set of attributes. Returns "" when the required
 * attributes are not all present — an unenriched product keeps whatever name it
 * has, and is never given a worse one.
 *
 * `opts.discriminate` adds the lower-value terms (toe shape, sole colour, a
 * style tag) that a bare name does not need but a COLLIDING one does. The
 * caller escalates; this function does not guess how crowded the catalogue is.
 */
export function nameFromAttributes(attrs, opts = {}) {
  if (!attrs) return "";
  // THE REQUIRED FIELDS MUST BE PRESENT *AND* LEGAL. Presence alone was not
  // enough: resolveAttributes prefers `confirmed`, which nothing validates on
  // the way out, so a hand-written value outside the vocabulary reached the
  // name. isLegalAttribute is the same test the writer applies — one rule, both
  // ends.
  const need = ["silhouette", "upperMaterial", "primaryColour", "pattern"];
  if (need.some((k) => !attrs[k] || !isLegalAttribute(k, attrs[k]))) return "";

  const level = Number(opts.discriminate) || 0;
  const words = [];
  // The index in `words` of each escalation clause, so an over-long name can
  // drop them lowest-value-first (see the 80-character trim below).
  const optional = [];

  // 1. PATTERN and FINISH lead, then MATERIAL. These are the three terms that
  //    most often differ between two shoes a colour word alone would merge —
  //    and FINISH is the v2 addition that broke the six-way "leather low-top
  //    black" tie the pilot found.
  // The colours are decided FIRST because the pattern word depends on them:
  // "Two-tone … in black and white" says the same thing twice, and those nine
  // characters are exactly what a discriminating clause needs later (measured —
  // a two-colour base name reaches 74 of the 80 allowed, leaving no room for
  // the escalation that was supposed to break its tie).
  const c1 = colourWord(attrs.primaryColour);
  const c2 = attrs.secondaryColour && attrs.secondaryColour !== attrs.primaryColour
    ? colourWord(attrs.secondaryColour) : "";
  const pat = attrs.pattern === "two-tone" && c2 ? "" : (word(PATTERN_WORD, attrs.pattern));
  if (pat) words.push(titleCase(pat));
  const fin = word(FINISH_WORD, attrs.finish);
  if (fin) words.push(words.length ? fin : titleCase(fin));
  const mat = word(MATERIAL_WORD, attrs.upperMaterial);
  if (mat) words.push(words.length ? mat : titleCase(mat));

  // 2. SILHOUETTE — always. It is what the item IS.
  const sil = word(SILHOUETTE_WORD, attrs.silhouette);
  if (sil) words.push(words.length ? sil : titleCase(sil));

  // 3. COLOUR. Both when there are two, because a two-colour shoe named for one
  //    of its colours is exactly the collision this build exists to end.
  if (c1) words.push(c2 ? `in ${c1} and ${c2}` : `in ${c1}`);

  // ── ESCALATION, IN MEASURED ORDER OF USEFULNESS ────────────────────────────
  // v1 spent toe shape first and it is "round" 82.9% of the time, so tier 1
  // bought almost nothing and the tiers below it were reached with the name
  // already long. v2 spends the SOLE first (highly visible, well spread), then
  // the CLOSURE, and only then the toe and a style tag.

  // Tier 1 — the sole, named by type and, when it differs from the upper, by
  // colour too. "black sole" on a black shoe distinguishes nothing.
  if (level >= 1) {
    const st = word(SOLE_WORD, attrs.soleType);
    const sc = attrs.soleColour && attrs.soleColour !== attrs.primaryColour && attrs.soleColour !== attrs.secondaryColour
      ? colourWord(attrs.soleColour) : "";
    const clause = st && sc ? `on a ${sc} ${st}` : st ? `on a ${st}` : sc ? `on a ${sc} sole` : "";
    if (clause) { optional.push(words.length); words.push(clause); }
  }

  // Tier 2 — how it fastens. Silent for "laced", which is the default and true
  // of most of the catalogue.
  if (level >= 2 && word(CLOSURE_WORD, attrs.closure)) {
    optional.push(words.length);
    words.push(word(CLOSURE_WORD, attrs.closure));
  }

  // Tier 3 — the toe shape (skipped when "round", for the reason above) and, as
  // the very last resort, a style tag.
  if (level >= 3) {
    if (attrs.toeShape && attrs.toeShape !== "round" && word(TOE_WORD, attrs.toeShape)) {
      // The article follows the word, not a guess: "almond-toe" and "open-toe"
      // both start with a vowel and "an squared-toe" is not English.
      const t = word(TOE_WORD, attrs.toeShape);
      optional.push(words.length); words.push(`with ${/^[aeiou]/.test(t) ? "an" : "a"} ${t} shape`);
    }
    if (Array.isArray(attrs.styleTags) && attrs.styleTags[0]) {
      optional.push(words.length); words.push(`with a ${attrs.styleTags[0]} finish`);
    }
  }

  // Tier 4 — EVERY style tag, not just the first. The last thing available, and
  // it exists because the pilot proved the earlier tiers are not always enough:
  // five groups of shoes came back with byte-identical attributes, and under
  // the compliance rules (no brand, no sub-label, no model, no collaboration)
  // two different makers' black leather platform low-tops are genuinely
  // describable the same way. The full tag set is the last honest distinction
  // left. Anything still colliding after this is handed to the prose namer
  // rather than given a manufactured difference — see distinctNamesFor.
  if (level >= 4 && Array.isArray(attrs.styleTags) && attrs.styleTags.length > 1) {
    // Replaces tier 3's single-tag clause rather than stacking on it.
    const i = optional[optional.length - 1];
    if (i !== undefined && String(words[i]).startsWith("with a ") && String(words[i]).endsWith(" finish")) words.splice(i, 1);
    optional.push(words.length);
    words.push(`with ${attrs.styleTags.join(", ")} styling`);
  }

  // ── THE 80-CHARACTER CEILING IS A PUBLISH GATE, NOT A PREFERENCE ───────────
  // checkCleanName / validateVisionName both refuse a name over 80 characters,
  // and a refused name is not a name — it is a product blocked from the
  // storefront. Fully escalated, the longest a shoe can be is
  //   "Two-tone leather round-toe low-top in black and white on a cream sole
  //    with a retro finish"  = 89 characters
  // so the ceiling is reachable and had to be handled rather than hoped about
  // (caught by the exhaustive validator test, not by reading).
  //
  // ── AND THE CLAUSE THAT SURVIVES IS THE ONE BEING SPENT ───────────────────
  // The first version dropped clauses NEWEST-first, reasoning that the last
  // thing added was the least valuable. That is backwards here and the pilot
  // showed it: escalation adds a clause precisely BECAUSE the earlier terms
  // failed to separate two shoes, so the newest clause is the whole point of
  // the name and the older ones are what should make room for it. Measured, a
  // two-colour base name reached 74 characters and every escalation tier was
  // trimmed straight back off — the tie-break never happened at all.
  //
  // So: oldest optional clause first. Only if the name STILL does not fit does
  // the newest go too, because an over-long name is not a name — the publish
  // path refuses it at 80 characters.
  const assemble = (drop) => words.filter((_, i) => !drop.has(i)).join(" ").replace(/\s+/g, " ").trim();
  const drop = new Set();
  let name = assemble(drop);
  for (let i = 0; i < optional.length - 1 && name.length > MAX_NAME_LENGTH; i++) {
    drop.add(optional[i]);
    name = assemble(drop);
  }
  for (let i = optional.length - 1; i >= 0 && name.length > MAX_NAME_LENGTH; i--) {
    drop.add(optional[i]);
    name = assemble(drop);
  }
  // ── AND IF THE BASE ITSELF DOES NOT FIT, THERE IS NO NAME ─────────────────
  // Only optional clauses can be dropped, so a base name over the ceiling
  // survives every trim and is returned. It is then REFUSED by the publish
  // path, which is the failure this build exists to end. Measured (CodeRabbit
  // ran the combinatorics rather than reading them): the longest base name
  // reachable is 81 characters — "Colour-block distressed calf-hair
  // moulded-stud boot in light grey and multicolour" — one over, on exactly
  // one corner of the vocabulary.
  //
  // "" means "these attributes cannot name this product", which every caller
  // already handles: distinctNamesFor drops it, name-from-attributes.mjs never
  // proposes for it, and the shoe keeps whatever name it has and goes to the
  // prose namer. Refusing beats emitting a name that cannot be published.
  return name.length > MAX_NAME_LENGTH ? "" : name;
}

/**
 * The storefront handle a name produces. Mirrors Shopify's own slug rule, which
 * is what the 178 blocked publish nodes actually collided on ("sneaker-black"
 * x11, "sneaker-white" x12) — so two names are only distinct if their HANDLES
 * are, and the proof has to check the handle, not the prose.
 */
export function handleFromName(name) {
  return String(name ?? "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * A distinct name for every product in a set, escalating specificity ONLY where
 * a handle actually collides. Products are processed in a stable order so a
 * re-run assigns the same names to the same products.
 *
 * Returns a Map pid -> { name, handle, level }. A product whose attributes
 * cannot produce a name is ABSENT from the map (never given a fallback) — the
 * unenriched stay unenriched.
 */
export function distinctNamesFor(entries) {
  const rows = [...entries]
    .map(([pid, attrs]) => ({ pid, attrs, name: nameFromAttributes(attrs), level: 0 }))
    .filter((r) => r.name)
    .sort((a, b) => a.pid.localeCompare(b.pid));

  // Escalate tier by tier, but only the rows still colliding. A name that was
  // already unique never gains a word it did not need — the whole point of the
  // tiers is that specificity is spent where it buys something.
  for (let level = 1; level <= 4; level++) {
    const byHandle = new Map();
    for (const r of rows) {
      const h = handleFromName(r.name);
      byHandle.set(h, (byHandle.get(h) || 0) + 1);
    }
    const colliding = rows.filter((r) => byHandle.get(handleFromName(r.name)) > 1);
    if (!colliding.length) break;
    for (const r of colliding) {
      const next = nameFromAttributes(r.attrs, { discriminate: level });
      if (next && next !== r.name) { r.name = next; r.level = level; }
    }
  }

  // ── WHAT IS STILL COLLIDING IS REFUSED, NOT FUDGED ────────────────────────
  // After every tier, some shoes are genuinely indistinguishable in attribute
  // space: the compliance rules forbid the brand, the sub-label, the model and
  // the collaboration, and two makers' black leather platform low-tops are then
  // describable identically and honestly. Measured on the 199-product pilot: 5
  // groups, 12 products.
  //
  // Proposing one of those names anyway would produce a handle the publish path
  // REFUSES — which is the exact failure this build exists to end, recreated by
  // the fix. So they are left out of the map entirely and keep whatever name
  // they have; the existing prose namer (vision-name.mjs) is the lane for them,
  // and it is still there. Refusing beats guessing, as everywhere else here.
  const finalCount = new Map();
  for (const r of rows) {
    const h = handleFromName(r.name);
    finalCount.set(h, (finalCount.get(h) || 0) + 1);
  }
  const out = new Map();
  for (const r of rows) {
    const handle = handleFromName(r.name);
    if (finalCount.get(handle) > 1) continue;
    out.set(r.pid, { name: r.name, handle, level: r.level });
  }
  return out;
}

// ─── THE IMPORT-TIME PROOF ───────────────────────────────────────────────────
// Every word nameFromAttributes can emit, checked against the compliance
// lexicon ONCE, here, rather than discovered one refused proposal at a time.
// "suede" is a PUMA model in shopifyTriggers.js and is deliberately absent from
// UPPER_MATERIALS for exactly that reason; this is what stops the next such
// word getting in unnoticed.
export function nameVocabularyTriggers() {
  const words = [
    ...Object.values(PATTERN_WORD), ...Object.values(SILHOUETTE_WORD),
    ...Object.values(MATERIAL_WORD), ...Object.values(TOE_WORD),
    ...Object.values(FINISH_WORD), ...Object.values(SOLE_WORD), ...Object.values(CLOSURE_WORD),
    ...COLOURS.map(colourWord), ...STYLE_TAGS,
    "in", "and", "on a", "sole", "with a", "with an", "shape", "finish",
  ].filter(Boolean);
  const hits = [];
  for (const w of words) {
    const t = triggersInText(w);
    if (t.length) hits.push(`${w} → ${t.join(", ")}`);
  }
  return hits;
}
