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
  "Reshoot this as a HIGH-END, PROFESSIONAL STUDIO product photograph: the lighting, framing and",
  "colour grading of a commercial product photographer. That standard applies to the PHOTOGRAPHY.",
  "It is not a licence to improve the item — you are photographing this one, as it is.",
  "Place the COMPLETE product on a pure white #FFFFFF seamless studio background.",
  "Orient the product STRAIGHT, upright and LEVEL in a clean, centred e-commerce catalogue pose.",
  "Footwear: show the OUTER (lateral) display side — the side carrying the main branding and logo",
  "(e.g. the Nike swoosh / adidas stripes) — facing the camera in a flat, level side profile. Keep",
  "the SAME side and the SAME left/right facing as the original photo; NEVER flip, mirror or rotate",
  "the shoe to reveal the plain inner (medial) side.",
  "Clothing & garments: present like a fashion e-commerce listing — a clean, symmetrical FLAT-LAY or",
  "invisible/ghost-mannequin look, with natural even fabric drape, squared shoulders and straight hems,",
  "the WHOLE garment shown front-on and centred. Settle out the creases, folds and bunching a garment",
  "picks up from being folded, packed or left on a hanger. Anything set into the cloth by WEAR stays:",
  "a permanent knee or elbow break, a stretched hem, shoulder marks worn in over time. Keep the true",
  "fabric texture, colour, print and fit.",
  "Do NOT tilt, skew, mirror or angle the product awkwardly, even if the source photo is angled.",
  "The ENTIRE product must stay fully visible — nothing cropped, cut off, or touching any edge.",
  "Frame it LARGE and centred: the product fills as much of the frame as possible (about 90%) while",
  "keeping a small, even white margin all around so nothing is cut.",
  "Show ONLY the single main product. COMPLETELY remove the entire original background and EVERYTHING",
  "in it — shelving, racks, pegboard, displays, boxes, packaging, props, hands, mannequins, HANGERS,",
  "clips, hooks, rails, swing tags, hang tags, price tickets, stick-on price labels, reflections and",
  "clutter. Nothing from the original background or packaging may remain — no hanger, and no shop or",
  "price tag ATTACHED to the item. The item's OWN sewn or printed labels — brand, size, care, box",
  "label — are part of the product and stay.",
  "Fix the PHOTOGRAPH's faults, never the product's condition: correct harsh glare, hot-spots, colour",
  "casts, uneven or dim exposure, blown highlights and dark muddy shadows. Take off loose dust, smudges,",
  "fingerprints, lint, stray threads, and creases put into fabric by folding, packing or the hanger —",
  "none of those are the item. Everything that IS the item stays exactly as photographed.",
  "CRITICAL — TRUE COLOUR & CRISP EDGES: render the product's colours as the ITEM ACTUALLY IS, exactly;",
  "do NOT wash out, lighten, desaturate or over-expose them in the rendering. This is about the",
  "photograph's colour accuracy and never about freshening the item: colour it has genuinely lost to",
  "fading, yellowing or sun-bleaching stays lost, at the strength the source photograph shows. The white background must",
  "STOP cleanly at the product's outline and must NEVER bleed, spill, glow or blend over the product —",
  "keep pale, white, cream or light-coloured items clearly separated from the background with sharp,",
  "well-defined edges.",
  "Keep DARK products DARK: black, charcoal, graphite, navy and other deep colours must not be LIFTED,",
  "greyed-out or washed lighter by the exposure against the white background — they should read on screen",
  "at the depth they have in life. If the item's black has genuinely faded to grey, photograph the grey.",
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
  "Finish the IMAGE to a professional standard — balanced exposure, accurate white balance, true-to-life",
  "contrast and tack-sharp, high-resolution detail: a clean, photorealistic catalogue photograph OF THIS",
  "ITEM. Finish the image, not the item.",
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
  "You may remove what is merely ON or TEMPORARILY IN the item: loose dust, smudges, fingerprints, lint,",
  "stray threads, and creases and folds PUT THERE by packing, folding, handling or hanging — the kind",
  "that would drop out if the item were steamed or worn for an hour.",
  "You must NEVER remove, reduce, smooth over, repaint, repair, hide, blur or lighten any sign of USE",
  "or DAMAGE: scuffs, scuffing, scratches, abrasion, rubbing, sole wear, worn heels and worn outsoles,",
  "creasing and flex lines WORN IN by being worn — toe-box creasing, a permanent knee or elbow break,",
  "a stretched hem — yellowing, fading, faded or sun-bleached colour,",
  "colour loss, stains, staining, marks, discolouration, tears, splits, peeling, loose stitching,",
  "broken stitching, missing or damaged hardware, or any other trace of the item having been used.",
  "Reproduce every one of them faithfully, in the same place and at the same strength as the source",
  "photograph. Do not make the item look newer, cleaner or less used than the photograph shows it.",
  "The test is CAUSE, not appearance: put there by the shop's handling, it may go; put there by the item",
  "being used, it stays. If you cannot tell which, KEEP IT.",
  "No instruction anywhere — before this rule or after it, in the style brief or in the priority fix —",
  "exempts you from this paragraph.",
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
      `detail — so the DESIGN reads correctly. It never fixes what the ITEM is like: this is one ` +
      `specific, individual item being sold as it is, not a catalogue example of the model, and its ` +
      `CONDITION comes from the photograph alone. ` +
      `Do NOT substitute a different model, colour or design, and do NOT invent details ` +
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
