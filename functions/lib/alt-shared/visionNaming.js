// ─── VISION NAMING — one photo, two answers ──────────────────────────────────
// The lexicon path strips every brand, sub-label and silhouette term from a
// product's name and rebuilds a title from what is left. That is compliant and
// it is also almost content-free, because the words it removes are the ones
// that said what the shoe was. Measured on the live storefront, 2026-08-17:
//
//   372 of 373 live titles come from the lexicon path
//   257 of them (69%) begin with the single word "Sneaker"
//   41 of them (11%) carry ONE descriptive word or fewer
//
//   "Nike Air Force 1 Tiffany & Co. 1837"  →  "Sneaker Co"
//   "New Balance 1000 Gold"                →  "Sneaker Gold"
//   "New Balance 1000 Pink"                →  "Sneaker Pink"
//   "New Balance 1000 Silver"              →  "Sneaker Silver"
//
// Four different shoes, and the only thing telling them apart is a colour word.
// No duplicates — just nothing to choose between.
//
// So this reads the PHOTO instead of the name, and asks for two things at once.
//
// ── TWO OUTPUTS, ONE CALL, ONE COST ──────────────────────────────────────────
//   1. IDENTITY  — what the item actually IS: brand, model or silhouette,
//      colourway. Internal. Goes to /product_identity so search can find it,
//      NEVER to Shopify. This is a GUESS and is recorded as one, with the
//      model's own confidence, ranked below supplier data (searchIdentity.js).
//   2. PUBLIC NAME — a natural retail name describing the garment: colour and
//      colour blocking, cut, panel and trim detail, material where obvious.
//      Compliant, validated, and PROPOSED — never applied.
//
// ── WHY IDENTITY AND PUBLIC NAME MUST COME FROM ONE CALL ─────────────────────
// Not just cost. The model has to know what it is looking at to describe it
// well, and asking twice invites two different readings of the same photo — an
// identity that says one shoe and a description that says another.
//
// ── A WRONG GUESS SHOWS A CUSTOMER THE WRONG BRAND ───────────────────────────
// That is the failure mode, and it is contained in three ways, none of which is
// "trust the model": identity is ranked below supplier data so it can only fill
// gaps; it is marked vision-sourced and carries a confidence; and it is
// reviewable and correctable in the same surface where names are reviewed.
// If the model cannot identify the item, it says so and NOTHING is written. No
// invented identity, ever.
//
// PURE. No I/O, no network, no Firebase — the transport lives in the runner
// (scripts/shopify/vision-name.mjs) and the browser card. Everything decidable
// without an API key is decided here, and tested.
import { triggersInText, isTriggerFree } from "./shopifyTriggers.js";

/** The cleanNameSource value a vision proposal carries. */
export const VISION_NAME_SOURCE = "vision";

/** Where a proposal waits for review. NOT cleanName — that is the applied name. */
export const NAME_PROPOSAL_KEY = "nameProposal";

// ── The model ────────────────────────────────────────────────────────────────
// PINNED, with an env override. This is not a preference: `gemini-2.5-flash`
// was the original choice and Google retired it for new API keys mid-build —
// every call came back HTTP 404 "no longer available to new users", which is
// why the pin is explicit and why overriding it must not need a code change.
// (2026-08-17.)
export const VISION_MODEL_DEFAULT = "gemini-3.7-flash";
export function visionModel(env = {}) {
  return String(env.GEMINI_VISION_MODEL || "").trim() || VISION_MODEL_DEFAULT;
}

// THINKING IS OFF, and it is a cost decision backed by a measurement. These
// models think by default and thinking tokens are billed at the OUTPUT rate.
// Measured on a real 67 KB product photo, same prompt, same photo:
//
//   thinking OFF : 1578 in ·  55 answer ·  66 thinking  →  $0.001637
//   thinking ON  : 1578 in ·  47 answer · 274 thinking  →  $0.002387
//
// 46% more expensive for an answer of the same quality — both read the shoe
// correctly and both wrote a usable name. (thinkingBudget 0 still leaves a ~66
// token floor; it is a cap, not a switch.)
export const THINKING_CONFIG = Object.freeze({ thinkingBudget: 0 });

// ── Cost ─────────────────────────────────────────────────────────────────────
// MEASURED, not estimated. The first version of this constant was $0.00062 from
// Gemini 2.5 Flash list prices and a guess at the image's token cost. Both were
// wrong: 3.x Flash is $0.75/1M in and $3.75/1M out (paid tier, through
// 2026-12-31), and a 600x800 product photo is ~1,100 input tokens — so the
// prompt is 1,578 tokens, not the ~450 assumed.
//
//   input : 1578 x $0.75/1M = $0.001184
//   output: (55 + 66) x $3.75/1M = $0.000454
//                                 = $0.001637 per name  (~R0.029)
//
// 2.6x the original estimate. Deliberately a CONSTANT and not a live lookup: a
// batch runner has to quote a total BEFORE it spends anything. The runner also
// prints the ACTUAL measured cost from usageMetadata at the end of every run,
// so drift between this number and reality is visible rather than assumed.
export const COST_PER_NAME_USD = 0.001637;
export const GEMINI_INPUT_PER_TOKEN = 0.75 / 1e6;
export const GEMINI_OUTPUT_PER_TOKEN = 3.75 / 1e6;

/** Cost of one call from its own reported usage — the honest after-the-fact number. */
export function costFromUsage(usage) {
  const inTok = Number(usage?.promptTokenCount) || 0;
  const outTok = (Number(usage?.candidatesTokenCount) || 0) + (Number(usage?.thoughtsTokenCount) || 0);
  return inTok * GEMINI_INPUT_PER_TOKEN + outTok * GEMINI_OUTPUT_PER_TOKEN;
}
export const USD_TO_ZAR = 18.0; // for the operator-facing quote only

/** What a run of `n` names will cost, for the quote shown BEFORE it starts. */
export function projectCost(n) {
  const usd = n * COST_PER_NAME_USD;
  return {
    names: n,
    usd: Number(usd.toFixed(4)),
    zar: Number((usd * USD_TO_ZAR).toFixed(2)),
    perNameUsd: COST_PER_NAME_USD,
  };
}

// ── The prompt ───────────────────────────────────────────────────────────────
// Asks for strict JSON with both answers. The compliance rules are stated, but
// the model is NEVER trusted to police itself — validateVisionName is what
// actually holds the line, and it runs on every output.
//
// THE PROMPT MUST NOT SUGGEST A WORD THE VALIDATOR REFUSES. It did: the
// material list read "leather, suede, mesh, canvas, knit, denim" and worked
// example A was "Brushed suede low-top in sand". "suede" is a SILHOUETTE in
// shopifyTriggers.js (the PUMA model), so every name that took the prompt's
// own advice was refused, regenerated at full price, and — when the second
// attempt reached for the same obvious word — refused for good. Measured
// across the 663 proposals the first runs produced before this was found:
// see the PR. Nothing else in the material list, and no other word in any of
// the eight worked examples, is a trigger — checked, not assumed.
export const VISION_PROMPT = `You are looking at ONE photo of a single second-hand item of clothing, footwear or an accessory that a resale shop is about to list.

Answer with STRICT JSON and nothing else. No markdown, no code fence, no commentary.

{
  "identified": true | false,
  "brand": "...",        // the maker, if you can actually read or recognise it
  "model": "...",        // the model or silhouette name, if you recognise it
  "colourway": "...",    // the colourway as the maker would name it
  "confidence": 0.0-1.0, // YOUR honest confidence in brand + model together
  "publicName": "..."    // see the rules below
}

IDENTIFICATION RULES
- Only set "identified": true if you genuinely recognise the item or can read a
  visible mark. A plausible guess is not recognition.
- If you cannot identify it, set "identified": false and leave brand, model and
  colourway as empty strings. Do NOT invent a brand. An honest "I don't know" is
  far more useful than a wrong answer.
- "confidence" must reflect brand AND model together. If you are sure of the
  brand but not the model, that is not high confidence.

PUBLIC NAME RULES — this is a shop listing title a customer reads.
- Describe the ITEM, not its maker. Say what it looks like: the colour and any
  colour blocking, the cut or profile, panel and trim detail, and the material
  when it is obvious (leather, nubuck, mesh, canvas, knit, denim, corduroy).
- It must contain NO brand name, NO sub-label, NO collaboration name, NO model
  or silhouette name, NO logo wording, and NO team, city or athlete name.
- Natural retail English, 3 to 9 words, no ALL CAPS, no punctuation beyond
  ordinary hyphens, and it must not start with a digit.
- The word "suede" is a MODEL name in this shop's compliance lexicon and is
  refused like any brand term. Say "nubuck", "brushed leather" or "napped
  leather" instead. This is the only ordinary material word that is barred.
- Do not mention condition, wear, price, size or availability.

VARY THE SENTENCE SHAPE. This is a hard requirement, not a preference. Hundreds
of these names are written for one shop and they must not all read alike. In
particular do NOT begin every name with the product type. Choose whichever of
these shapes the item actually calls for:

  A. material first        "Brushed nubuck low-top in sand"
  B. colour first          "Oxblood leather derby with brogue detail"
  C. the standout detail    "Contrast-stitch panel runner in bone and rust"
  D. silhouette first       "High-top basketball silhouette in cracked white"
  E. the pattern or print   "Leopard-print calf hair slip-on"
  F. construction           "Cup-sole canvas trainer in faded navy"
  G. the trim or hardware   "Gum-sole mesh runner with reflective piping"
  H. the finish             "Patent black loafer with a squared toe"

MAKE IT SPECIFIC TO THIS ITEM. Two black bags must not get the same name. Reach
for the thing that would let someone pick this one out of a row of similar
items: the exact shade, the panel layout, the hardware, the stitching, the sole
colour, the texture. A name that could describe fifty other items in the shop is
a failed name.

Return the JSON object only.`;

// ── Lead-shape rotation ──────────────────────────────────────────────────────
// The prompt lists eight shapes; a model left to choose freely still converges
// on one. Measured on the first real batch of 20: THIRTEEN opened with
// "Low-top leather sneaker(s) in" — the lexicon's monotony reproduced with a
// different template, which is also a handle-collision generator.
//
// So the runner rotates a PREFERRED shape across the batch. It is a preference,
// not a command: an item the shape genuinely does not fit gets a different one,
// because a forced shape reads worse than a repeated one. Rotation is by index
// so a batch spreads deterministically rather than by chance.
export const LEAD_SHAPES = [
  "A (material first)", "C (the standout detail)", "B (colour first)",
  "G (the trim or hardware)", "F (construction)", "E (the pattern or print)",
  "D (silhouette first)", "H (the finish)",
];

export function leadShapeHint(index) {
  const shape = LEAD_SHAPES[index % LEAD_SHAPES.length];
  return `For THIS item, prefer sentence shape ${shape} unless it genuinely does not suit what you can see — in which case pick a different shape from the list, but do not default to leading with the product type.`;
}

/**
 * The retry instruction after a refusal. It NAMES the offending terms, because
 * a bare "try again" gets the same answer back — the model has no way to know
 * which word was the problem.
 */
export function regenerationNote(offendingTerms) {
  const terms = (offendingTerms || []).filter(Boolean);
  return `Your previous "publicName" was rejected because it contained ${
    terms.length ? `these forbidden terms: ${terms.join(", ")}` : "a forbidden brand or model term"
  }. Those are brand, sub-label or model/silhouette names and they may never appear in a listing title. Write a new "publicName" that describes only what the item LOOKS LIKE — colour, colour blocking, cut, panels, trim, material — and contains none of those words or any other maker or model name. Return the same strict JSON object.`;
}

// ── Parsing ──────────────────────────────────────────────────────────────────
// Models wrap JSON in fences however much you ask them not to. Strip the
// obvious wrappers, then parse; anything else is a hard parse failure, never a
// salvage attempt — a half-read answer is worse than none.
export function parseVisionResponse(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "empty response" };
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = (fenced ? fenced[1] : text).trim();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: "response was not JSON" };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, error: "response was not a JSON object" };
  }

  const publicName = String(json.publicName ?? "").trim();
  if (!publicName) return { ok: false, error: "no publicName in the response" };

  // "identified" must be explicit. A missing flag with a brand filled in is a
  // model ignoring the contract, and the safe reading is "not identified" —
  // never write a brand nobody asked it to be sure about.
  const identified = json.identified === true;
  const brand = identified ? String(json.brand ?? "").trim() : "";
  const model = identified ? String(json.model ?? "").trim() : "";
  const colourway = identified ? String(json.colourway ?? "").trim() : "";
  const rawConf = Number(json.confidence);
  const confidence = Number.isFinite(rawConf) ? Math.min(1, Math.max(0, rawConf)) : 0;

  // Identity needs SOMETHING nameable. "identified: true" with every field
  // blank is not an identification.
  const identity = identified && (brand || model)
    ? { brand, model, colourway, confidence }
    : null;

  return { ok: true, publicName, identity, identified };
}

/**
 * Is this generated public name shippable? The model never polices itself.
 * → { ok, problems: [], triggers: [] }
 *
 * The guards are deliberately the SAME ones the publish path applies to a
 * hand-typed name (shopifyPublishCore.checkCleanName), plus the brand-trigger
 * check, so a generated name cannot get in through a softer door than a typed
 * one.
 */
export function validateVisionName(input) {
  const name = String(input ?? "").trim();
  const problems = [];
  const triggers = triggersInText(name);
  if (name === "") problems.push("name is empty");
  else {
    if (/^\d/.test(name)) problems.push("cannot start with a digit");
    if (name.length < 3) problems.push("under 3 characters");
    if (name.length > 80) problems.push("over 80 characters");
    if (name === name.toUpperCase() && /[A-Z]{4,}/.test(name)) problems.push("is ALL CAPS");
    if (triggers.length) problems.push(`brand trigger: ${triggers.join(", ")}`);
  }
  return { ok: problems.length === 0, problems, triggers };
}

/**
 * The identity text stored for search: the brand-first sentence a shopper would
 * type. Built from the structured fields rather than from the model's prose, so
 * it is predictable.
 */
export function identityTextFrom(identity) {
  if (!identity) return "";
  return [identity.brand, identity.model, identity.colourway]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The proposal record written for review. NOT applied — `cleanName` is
 * untouched until Junid approves.
 *
 * `previousName` is what makes a bad batch revertible: it records exactly what
 * the product would have shipped as before this proposal existed.
 */
export function buildNameProposal({
  publicName, identity, previousName, model, at, attempts = 1, refusedFor = null,
}) {
  return {
    name: publicName || null,
    source: VISION_NAME_SOURCE,
    previousName: previousName || null,
    identity: identity
      ? {
          brand: identity.brand || null,
          model: identity.model || null,
          colourway: identity.colourway || null,
          confidence: identity.confidence,
          text: identityTextFrom(identity),
        }
      : null,
    // A proposal the validator refused is KEPT, with the reason, in its own
    // lane. It is never auto-approved and never silently dropped — an operator
    // needs to see that the model produced something unusable for this product,
    // because that is often a sign the photo is wrong.
    refusedFor: refusedFor || null,
    attempts,
    visionModel: model || null,
    proposedAt: at,
    status: refusedFor ? "refused" : "pending",
  };
}

/** Proposals awaiting a decision — the review grid's worklist. */
export function isPendingProposal(node) {
  const p = node?.[NAME_PROPOSAL_KEY];
  return !!p && p.status === "pending";
}

/** Proposals the validator refused — surfaced SEPARATELY, never bulk-approved. */
export function isRefusedProposal(node) {
  const p = node?.[NAME_PROPOSAL_KEY];
  return !!p && p.status === "refused";
}

/**
 * May this product be re-named by a vision run?
 * The one hard exclusion: a name Junid set BY HAND is his decision and is never
 * overwritten (owner spec). Everything else — lexicon names, AI names, and
 * products with no name at all — is fair game, which is the point: the lexicon
 * names are the problem being fixed.
 */
export function mayProposeFor(node) {
  if (node?.cleanNameSource === "manual") return false;
  return true;
}
