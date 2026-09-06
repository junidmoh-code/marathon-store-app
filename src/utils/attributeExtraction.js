// ─── ATTRIBUTE EXTRACTION — the prompt, and what comes back ──────────────────
//
// The vision namer's twin, and deliberately its SUCCESSOR rather than its
// sibling. The namer asks one photo for two answers: an identity, and prose. It
// works, and it has two limits this replaces:
//
//   1. The prose is a SEPARATE judgement from the identity in the same
//      response — one photo, two readings, free to disagree.
//   2. Prose cannot be matched. "Woven jacquard low-top sneaker in black" and
//      "Brushed leather low-top trainer in tonal navy" are good names and score
//      zero against each other, so nothing built on them can rank.
//
// So this asks for STRUCTURE instead, from the closed vocabularies in
// productAttributes.js, and the name is then derived from the structure
// (nameFromAttributes). One reading of the photo, one set of facts, and a name
// that is a function of the facts behind the suggestion.
//
// ── WHAT IT DOES NOT ASK FOR ─────────────────────────────────────────────────
// brand and category are on 100% of the 1,410 live sneaker records and are READ,
// never asked. colourFamily and priceBand are arithmetic. Asking the model for
// something the database already knows spends money to introduce disagreement.
//
// ── REFUSAL IS THE DEFAULT ───────────────────────────────────────────────────
// Every value is checked against its vocabulary and an illegal one is DROPPED,
// not corrected to the nearest legal value. A product whose required fields do
// not all survive is left unenriched and is simply absent from suggestions —
// there is no manual lane, by owner constraint, so "roughly right" here has no
// human to catch it and would go straight to a customer.
//
// PURE. No network, no firebase, no I/O. The transport is visionCall.mjs and
// the writes are in the runner.
import {
  SILHOUETTES, UPPER_MATERIALS, COLOURS, PATTERNS, TOE_SHAPES, STYLE_TAGS,
  MAX_STYLE_TAGS, VISION_FIELDS, ATTRIBUTE_FIELDS, isLegalAttribute,
} from "./productAttributes.js";
import { GEMINI_INPUT_PER_TOKEN, GEMINI_OUTPUT_PER_TOKEN, USD_TO_ZAR } from "./visionNaming.js";

const list = (xs) => xs.join(" | ");

// ── The prompt ───────────────────────────────────────────────────────────────
// The vocabularies are INTERPOLATED from the frozen constants rather than
// re-typed here. A prompt that lists different words from the ones the
// validator accepts is the exact failure the naming build paid for twice: it
// suggested "suede", the validator refused it as a PUMA model, and every name
// that took the prompt's own advice was refused, regenerated at full price,
// then refused for good. There is now no second copy of any vocabulary to
// drift.
export const ATTRIBUTE_PROMPT = `You are looking at ONE photo of a single second-hand shoe that a resale shop is listing.

Answer with STRICT JSON and nothing else. No markdown, no code fence, no commentary.

{
  "silhouette": "...",       // one of: ${list(SILHOUETTES)}
  "upperMaterial": "...",    // one of: ${list(UPPER_MATERIALS)}
  "primaryColour": "...",    // one of the COLOURS below — the colour that dominates the upper
  "secondaryColour": "...",  // one of the COLOURS below, or "" if the shoe is one colour
  "pattern": "...",          // one of: ${list(PATTERNS)}
  "toeShape": "...",         // one of: ${list(TOE_SHAPES)}, or "" if you cannot tell
  "soleColour": "...",       // one of the COLOURS below, or "" if you cannot tell
  "styleTags": ["..."],      // 0 to ${MAX_STYLE_TAGS} of: ${list(STYLE_TAGS)}
  "confidence": {            // YOUR honest confidence, 0.0-1.0, PER FIELD
    "silhouette": 0.0, "upperMaterial": 0.0, "primaryColour": 0.0,
    "secondaryColour": 0.0, "pattern": 0.0, "toeShape": 0.0, "soleColour": 0.0,
    "styleTags": 0.0
  }
}

COLOURS — use one of these exact words and nothing else:
${list(COLOURS)}

RULES
- Every value MUST be copied exactly from the list for that field. Do not invent
  a word, do not hyphenate differently, do not pluralise. A word that is not on
  the list is discarded, and a discarded field can make this shoe unusable.
- If you genuinely cannot tell, return "" for that field (or [] for styleTags)
  and a low confidence. An honest blank is far more useful than a guess — a
  guess here is shown to a customer as a recommendation.
- "primaryColour" is the colour that covers most of the UPPER. Ignore the sole,
  the laces and the background of the photo.
- "secondaryColour" is a real second colour on the upper, not a shade of the
  first and not a small logo. One-colour shoe → "".
- "pattern": solid = one colour; two-tone = two clear blocks; multi = three or
  more; print = a repeating graphic, animal print or camouflage.
- "confidence" is per field and they are independent. Being sure of the colour
  says nothing about the material.

BE DISCRIMINATING. These attributes are what tells this shoe apart from the next
one on the shelf. Two black shoes that differ in material, sole colour or toe
shape must not come back identical — look at the photo and say what is actually
different about this one.

Return the JSON object only.`;

// ── Cost ─────────────────────────────────────────────────────────────────────
// MEASURED, replaced by the real figure once the pilot has run — the naming
// build's first constant was a guess off list prices and was 2.6x wrong. Until
// then it is derived the honest way: the prompt's own token count at the
// published rate, plus the observed image cost. The runner prints what a batch
// ACTUALLY cost from usageMetadata at the end of every run, so drift is visible.
//
//   image (600x800 product photo, measured on the naming runs) ~1,100 tokens
//   prompt text                                                 ~  720 tokens
//   output (structured JSON + per-field confidence)             ~  180 tokens
//
//   input  : 1820 x $0.75/1M  = $0.001365
//   output :  180 x $3.75/1M  = $0.000675
//                             = $0.002040 per product  (~R0.037)
export const COST_PER_EXTRACTION_USD = 0.00204;

/** What a run of `n` extractions will cost, for the quote shown BEFORE it starts. */
export function projectExtractionCost(n) {
  const usd = n * COST_PER_EXTRACTION_USD;
  return {
    products: n,
    usd: Number(usd.toFixed(4)),
    zar: Number((usd * USD_TO_ZAR).toFixed(2)),
    perProductUsd: COST_PER_EXTRACTION_USD,
  };
}

export { GEMINI_INPUT_PER_TOKEN, GEMINI_OUTPUT_PER_TOKEN };

// ── Parsing ──────────────────────────────────────────────────────────────────
/**
 * Read the model's answer. Models wrap JSON in fences however much you ask them
 * not to, so the obvious wrappers are stripped; anything else is a hard parse
 * failure and never a salvage attempt — a half-read answer is worse than none.
 *
 * → { ok, vision, dropped: [], error }
 *
 * `dropped` names every field the model returned that the vocabulary refused.
 * It is REPORTED rather than swallowed: a run where 300 products all dropped
 * "upperMaterial" is a prompt problem, and it is invisible unless counted.
 */
export function parseAttributeResponse(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "empty response", dropped: [] };
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = (fenced ? fenced[1] : text).trim();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: "response was not JSON", dropped: [] };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, error: "response was not a JSON object", dropped: [] };
  }

  const vision = {};
  const dropped = [];
  for (const k of VISION_FIELDS) {
    const spec = ATTRIBUTE_FIELDS[k];
    let v = json[k];
    if (spec.list) {
      // A non-array where a list belongs is not a list. Normalise the one shape
      // that is plainly an accident (a single string) and refuse the rest.
      if (typeof v === "string") v = v ? [v] : [];
      if (!Array.isArray(v)) { if (v !== undefined && v !== null) dropped.push(k); continue; }
      const legal = v.map((x) => String(x ?? "").trim().toLowerCase()).filter((x) => STYLE_TAGS.includes(x));
      if (legal.length !== v.length) dropped.push(k);
      // Deduplicated: a model that returns ["retro","retro","retro"] has said
      // one thing, and storing it three times would spend the whole tag budget
      // on it.
      if (legal.length) vision[k] = [...new Set(legal)].slice(0, MAX_STYLE_TAGS);
      continue;
    }
    const s = String(v ?? "").trim().toLowerCase();
    if (!s) continue;                                  // an honest blank
    if (!isLegalAttribute(k, s)) { dropped.push(k); continue; }
    vision[k] = s;
  }

  // Per-field confidence. A flat number (a model ignoring the shape) is spread
  // across every field it reported — that is what it meant, and refusing the
  // whole extraction over the shape of a confidence block would be theatre.
  const c = json.confidence;
  const confidence = {};
  if (c && typeof c === "object" && !Array.isArray(c)) {
    for (const k of VISION_FIELDS) {
      const n = Number(c[k]);
      if (Number.isFinite(n)) confidence[k] = Math.min(1, Math.max(0, n));
    }
  } else if (Number.isFinite(Number(c))) {
    const n = Math.min(1, Math.max(0, Number(c)));
    for (const k of VISION_FIELDS) if (vision[k] !== undefined) confidence[k] = n;
  }
  vision.confidence = confidence;

  // The REQUIRED vision fields. Without all of them the product cannot be named
  // or ranked, so this is a refusal, not a partial success. (colourFamily and
  // priceBand are required too but are derived, so they are never missing here.)
  const missing = VISION_FIELDS.filter((k) => ATTRIBUTE_FIELDS[k].required && vision[k] === undefined);
  if (missing.length) {
    return { ok: false, error: `missing required attribute(s): ${missing.join(", ")}`, dropped, vision };
  }
  return { ok: true, vision, dropped };
}

/**
 * The retry instruction after a refusal. It NAMES what was wrong, because a
 * bare "try again" gets the same answer back — the model has no way to know
 * which field was the problem. (Same lesson as regenerationNote in
 * visionNaming.js, and the same reason.)
 */
export function attributeRetryNote({ error, dropped }) {
  const parts = [];
  if (error) parts.push(error);
  if (dropped?.length) parts.push(`these fields used words that are not on their list: ${[...new Set(dropped)].join(", ")}`);
  return `Your previous answer was rejected — ${parts.join("; ") || "it did not match the required shape"}. ` +
    `Answer again, copying every value EXACTLY from the list given for that field, and returning "" ` +
    `(or [] for styleTags) for anything you genuinely cannot tell rather than choosing a near-miss word. ` +
    `Return the same strict JSON object.`;
}
