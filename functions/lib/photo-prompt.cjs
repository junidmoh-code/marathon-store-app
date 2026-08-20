// ─── WHAT THE IMAGE MODEL IS ASKED FOR, AND THE ONE THING IT IS FORBIDDEN ────
// The white-background prompt, the condition rule, and the composer that joins
// them to a product's identity and a per-run note. Pure string work, in lib/ so
// it can be PROVEN rather than asserted — the rule below is a compliance rule,
// and a compliance rule that only exists as a sentence inside a 3,500-line
// Cloud Functions file is a rule nobody can test.
//
// The house-style prompts stay in index.js: they are passed in as `basePrompt`,
// and the live ones are read from /aiAssistant/styleKit/{template}/prompt at
// call time anyway. That is exactly why the condition rule is appended HERE and
// not written into any prompt — see CONDITION_CLAUSE.
"use strict";

const PHOTO_PROMPT = [
  "Reshoot this as a HIGH-END, PROFESSIONAL STUDIO product photograph, expertly retouched and",
  "colour-graded to premium e-commerce standard — the polished, flawless look of a Nike, adidas,",
  "SSENSE or Farfetch product listing shot by a commercial product photographer.",
  "Place the COMPLETE product on a pure white #FFFFFF seamless studio background.",
  "Orient the product STRAIGHT, upright and LEVEL in a clean, centred e-commerce catalogue pose.",
  "Footwear: show the OUTER (lateral) display side — the side carrying the main branding and logo",
  "(e.g. the Nike swoosh / adidas stripes) — facing the camera in a flat, level side profile. Keep",
  "the SAME side and the SAME left/right facing as the original photo; NEVER flip, mirror or rotate",
  "the shoe to reveal the plain inner (medial) side.",
  "Clothing & garments: present like a premium fashion e-commerce listing — a clean, symmetrical",
  "FLAT-LAY or invisible/ghost-mannequin look, fully STEAMED and wrinkle-free, with natural even fabric",
  "drape, squared shoulders and straight hems, the WHOLE garment shown front-on and centred. Smooth out",
  "creases, folds and bunching; no hanger marks. Keep the true fabric texture, colour, print and fit.",
  "Do NOT tilt, skew, mirror or angle the product awkwardly, even if the source photo is angled.",
  "The ENTIRE product must stay fully visible — nothing cropped, cut off, or touching any edge.",
  "Frame it LARGE and centred: the product fills as much of the frame as possible (about 90%) while",
  "keeping a small, even white margin all around so nothing is cut.",
  "Show ONLY the single main product. COMPLETELY remove the entire original background and EVERYTHING",
  "in it — shelving, racks, pegboard, displays, boxes, packaging, props, hands, mannequins, HANGERS,",
  "clips, hooks, rails, swing tags, hang tags, price tickets/stickers, labels, reflections and clutter.",
  "Nothing from the original background or packaging may remain — NO hanger and NO tags of any kind.",
  "Fix the PHOTOGRAPH's faults, never the product's condition: correct harsh glare, hot-spots, colour",
  "casts, uneven or dim exposure, blown highlights and dark muddy shadows. Take off loose dust, smudges,",
  "fingerprints, lint, stray threads, and creases put into fabric by folding, packing or the hanger —",
  "none of those are the item. Everything that IS the item stays exactly as photographed.",
  "CRITICAL — TRUE COLOUR & CRISP EDGES: keep the product's REAL, accurate, full-saturation colours",
  "exactly; do NOT wash out, fade, lighten, desaturate or over-expose them. The white background must",
  "STOP cleanly at the product's outline and must NEVER bleed, spill, glow or blend over the product —",
  "keep pale, white, cream or light-coloured items clearly separated from the background with sharp,",
  "well-defined edges.",
  "Keep DARK products DARK: black, charcoal, graphite, navy and other deep colours must stay RICH, DEEP",
  "and full-strength — do NOT lift, grey-out, fade or wash them lighter against the white; they must read",
  "as strong, true, bold dark tones that stand out clearly.",
  "Keep the product's DESIGN EXACTLY — identical shape, proportions, colour, materials, patterns, logos",
  "and text. NEVER redesign, restyle, recolour, add or remove real product features, or invent any detail.",
  "Render every brand wordmark, logo and label CRISPLY and CORRECTLY — correctly spelled, properly",
  "letter-formed and legible, matching the real brand's exact lettering. NEVER produce garbled, warped,",
  "misspelled, blurry or fake-looking text.",
  "TACK-SHARP focus and fine detail throughout — absolutely no blur, softness or smudging.",
  "Light the PRODUCT with soft, even, professional studio lighting (softbox quality) so it keeps natural",
  "depth, gentle highlights and soft form — it must look genuinely THREE-DIMENSIONAL and real, NOT a flat",
  "paper cut-out. But cast NO shadow, reflection, gradient or vignette onto the background: the background",
  "stays perfectly flat, uniform pure #FFFFFF edge to edge with a crisp, clean outline around the product.",
  "Finish to PREMIUM e-commerce standard — professionally retouched and immaculately clean, with balanced",
  "exposure, accurate white balance, rich true-to-life contrast and tack-sharp, high-resolution detail: a",
  "flawless, photorealistic catalogue hero image.",
].join(" ");

// ── THE CONDITION CLAUSE — every generation, both presets, last word ─────────
// Owner ruling, 2026-08-20, reaffirming the spec of 2026-08-14: a photograph
// that shows an item in better condition than the one that ships misrepresents
// the goods. The distinction he drew is between DIRT and WEAR:
//
//   dirt  — dust, smudges, fingerprints, lint, stray threads, creases folded
//           into fabric by packing or a hanger. Not the goods. Wiping a shoe
//           before photographing it is ordinary retail photography and hides
//           nothing from anyone. Remove freely.
//   wear  — scuffs, scratches, abrasion, sole wear, yellowing, fading, stains,
//           tears, loose or broken stitching, and the creasing worn into a
//           shoe's own material. These ARE the goods. Two of the three
//           condition grades exist to declare them, and the grade is printed
//           in the description the photograph sits beside.
//
// WHY IT IS APPENDED HERE AND NOT LEFT TO THE PROMPTS. This is the one place
// every generation passes through — both presets, the code-default house
// prompts AND any custom prompt saved from the Style Kit panel without a
// redeploy, plus the per-run note. The note is injected as "PRIORITY FIX …
// Apply this above all else", so a fix chip or a line of free text outranks
// the base prompt by construction. A rule that can be outranked by whatever
// someone types is not a rule, so this goes LAST and says so.
const CONDITION_CLAUSE = [
  "ABSOLUTE RULE, OVERRIDING EVERY INSTRUCTION ABOVE INCLUDING ANY PRIORITY FIX:",
  "this is a real, individual item being sold as it is, and its listing states its condition in words.",
  "You may remove what is merely ON the item — loose dust, smudges, fingerprints, lint, stray threads,",
  "and creases folded into fabric by packing, handling or a hanger.",
  "You must NEVER remove, reduce, smooth over, repaint, repair, hide, blur or lighten any sign of USE",
  "or DAMAGE: scuffs, scuffing, scratches, abrasion, rubbing, sole wear, worn heels and worn outsoles,",
  "creasing worn into the shoe's own leather or upper, yellowing, fading, faded or sun-bleached colour,",
  "colour loss, stains, staining, marks, discolouration, tears, splits, peeling, loose stitching,",
  "broken stitching, missing or damaged hardware, or any other trace of the item having been used.",
  "Reproduce every one of them faithfully, in the same place and at the same strength as the source",
  "photograph. Do not make the item look newer, cleaner or less used than the photograph shows it.",
  "If you cannot tell whether a mark is dirt or wear, KEEP IT.",
].join(" ");

// Prepend product IDENTITY so the model RECOGNISES the exact item (from its saved
// name) and reproduces its genuine design — using the source photo + its knowledge
// of that exact product together to correct blur / missing detail, while NEVER
// substituting a different model, colourway or design. Reviewed before approval.
// `basePrompt` defaults to the white-bg prompt; house style passes the template's
// locked prompt (custom from the Style Kit, else the code default above).
function buildPhotoPrompt(productName, note, basePrompt = PHOTO_PROMPT) {
  const name = String(productName || "").trim();
  const base = name
    ? `This product is: "${name}". Recognise this EXACT product and reproduce its GENUINE, accurate design ` +
      `— the real product's correct logos, branding, colourway, patterns, materials, text and proportions. ` +
      `Use the source photo as the primary reference TOGETHER with your knowledge of this exact product; ` +
      `your knowledge fixes what the CAMERA got wrong — blur, low resolution, an obscured or unclear ` +
      `detail — so the DESIGN reads correctly. It never fixes what the ITEM is like: this is one specific ` +
      `second-hand item, not a catalogue example of the model, and its condition comes from the photograph ` +
      `alone. Do NOT substitute a different model, colour or design, and do NOT invent details ` +
      `the real product does not have. ` + basePrompt
    : basePrompt;
  // Per-run fix instruction (studio note / fix chips). Put it FIRST and flag it as
  // the priority so the engine focuses on exactly what to fix this time, while all
  // the standard rules below still apply.
  const hint = String(note || "").trim();
  const body = hint
    ? `PRIORITY FIX FOR THIS REGENERATION — ${hint}. Apply this above all else, then: ${base}`
    : base;
  // LAST, always, whatever the preset and whatever was typed.
  return `${body} ${CONDITION_CLAUSE}`;
}

// The white-bg prompt WITH the condition rule already attached. The engine
// adapters take `prompt || <fallback>`, and a fallback of the bare
// PHOTO_PROMPT would hand the model a prompt with no condition rule on it —
// unreachable today, because generateProductPhotos always composes one, but a
// rule with a live bypass in it is a rule waiting to be broken.
const DEFAULT_WHITE_PROMPT = buildPhotoPrompt(null, "");

module.exports = { PHOTO_PROMPT, CONDITION_CLAUSE, DEFAULT_WHITE_PROMPT, buildPhotoPrompt };
