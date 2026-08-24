// ─── SOCIAL — CAPTIONS AND SCENE PROMPTS ─────────────────────────────────────
// Two prompt builders and one response reader, all pure. The Cloud Function
// does the calling; nothing here touches a network or a key.
//
// ── CAPTIONS NAME PRODUCTS NORMALLY ──────────────────────────────────────────
// The brand-stripping rule that governs everything pushed to Shopify does NOT
// apply here, by explicit owner ruling (2026-08-22): the payment gateway
// keyword-scans the SHOPIFY CATALOGUE, and a social caption is not the
// catalogue. A caption forbidden from naming what it is selling is a caption
// nobody can read.
//
// So this module deliberately does not import shopifyTriggers.js, and
// social-caption.test.cjs asserts that it never starts to. The plausible
// mistake here is not a missing safeguard — it is a future reader noticing the
// asymmetry with compliance.mjs and "fixing" it.
//
// What it DOES enforce is the things a caption must not be regardless: empty,
// a wall of hashtags, a model apologising, a markdown code fence, or 4,000
// characters of enthusiasm.
"use strict";

const CAPTION_MIN = 12;
const CAPTION_MAX = 2200;   // Instagram's own limit — the tightest of the three
// A caption is allowed hashtags; it is not allowed to BE hashtags. Beyond this
// the model has stopped writing and started stuffing.
const MAX_HASHTAGS = 8;

// ── THE PHOTO POLICY, AS A PROMPT CLAUSE ─────────────────────────────────────
// Owner ruling: Junid's own painted backdrop is the default look for ordinary
// posts; clean white is for ADVERTISING only. That is a decision about what
// the shop looks like, so it is expressed as a scene instruction rather than
// left to whoever is composing a call — a caller that forgets to pass a style
// gets the backdrop, because the backdrop is the default in the function
// signature below, not a value the caller supplies.
//
// The backdrop itself is never described in words. It is CONDITIONED on the
// Style Kit's real photographs of it, exactly as the house-style product
// pipeline does — a scene the model is shown beats a scene the model is told
// about, and the shop's backdrop is a specific painted thing no adjective
// reaches.
const SCENE_HOUSE = [
  "The STYLE REFERENCE images show our real shop's painted backdrop and lighting.",
  "Recreate that scene precisely: the same backdrop, the same surface, the same lighting",
  "direction, softness and colour grade. The output must look like it was photographed in",
  "that spot, on the same day, with the same lighting.",
].join(" ");

const SCENE_WHITE = [
  "Photograph the products on a clean, seamless pure-white studio background with soft,",
  "even, shadowless lighting — an advertising still, not a room.",
].join(" ");

// Every generated scene carries this, after and above anything else in the
// prompt. Same rule the product pipeline settled on 2026-08-20: transient dirt
// may go, actual wear stays. A social post is still a picture of a real item a
// customer will receive, and a scuff quietly healed by an image model is a
// customer complaint with our own photograph as the evidence.
const CONDITION_CLAUSE = [
  "ABSOLUTE RULE, overriding everything above: keep each product EXACTLY as it is.",
  "Identical shape, proportions, colourway, materials, patterns, logos and text.",
  "Dust, smudges and packing creases may be cleaned up. Anything set in by WEAR stays —",
  "scuffs, scratches, fading, worn soles, frayed stitching are part of the item and must",
  "survive unchanged. Never repair, restore, re-colour or redesign. Render every wordmark",
  "crisply and correctly spelled; never invent branding the item does not carry.",
].join(" ");

const KIND_SCENE = {
  single:
    "Photograph ONE product as the hero of the frame — filling most of it, sharply lit, " +
    "shot slightly above eye level.",
  flatlay:
    "Arrange ALL of the supplied products as a flat-lay, shot straight down from above: " +
    "evenly spaced, none overlapping another's branding, all at the same scale relative to " +
    "each other, with generous even margins.",
  outfit:
    "Arrange ALL of the supplied products as ONE complete outfit laid out together — the " +
    "way a person would set out what they are wearing tomorrow. Shot straight down from " +
    "above, pieces touching but not overlapping, every product fully visible.",
  // new_arrivals generates nothing: it is a carousel of the products' existing
  // photographs. There is no scene to describe.
};

/**
 * The image prompt for one generated post.
 *
 * @param kind        "single" | "flatlay" | "outfit"
 * @param productNames the listing names, in the order the images are attached
 * @param style       "house" (the painted backdrop — the default for ordinary
 *                    posts) or "white" (advertising only)
 * @param styleNotes  free-text notes from the Style Reference Library entries
 *                    that were sent with this generation. Notes only — the
 *                    IMAGES are attached separately by the caller and are what
 *                    actually carries the look.
 */
// ── THE MARATHON CLUB GRAPHIC DESIGN RULE ────────────────────────────────────
// Owner's standing art direction, 2026-08-24, quoted as given. It governs the
// LOOK of every image this engine makes.
//
// It replaces a single sentence that used to close the scene prompt:
//
//     "No text, no graphics, no watermark, no logo overlay added to the image."
//
// That sentence forbade the exact thing the reference templates are made of,
// which is why they never produced anything like them: the references were
// being read as mood boards for lighting while the prompt banned the design.
const DESIGN_RULE = [
  "MARATHON CLUB GRAPHIC DESIGN RULE:",
  "Treat every image as a premium editorial photograph first and a branded graphic second.",
  "Preserve the original photography, realism, composition, lighting and atmosphere.",
  "Do not force the same layout, typography placement or graphic elements onto every image.",
  "Instead, intelligently adapt the Marathon Club identity to the natural composition of each",
  "photograph. Use minimal, sophisticated typography, strong spacing, subtle alignment, thin rules",
  "and restrained branding only where they naturally fit. Graphics should feel intentionally placed",
  "within the photograph's negative space or architecture rather than layered on top as an",
  "advertisement. Sometimes use product names and prices, sometimes a small logo, sometimes a short",
  "statement, sometimes no graphic information at all. The design should always feel effortless,",
  "premium, urban and editorial. Avoid clutter, excessive text, decorative effects, gradients,",
  "badges, boxes, oversized promotional elements or generic e-commerce graphics. The photograph",
  "always comes first; the Marathon identity should be recognizable through restraint, consistency",
  "and art direction rather than repetition.",
  "MARATHON CLUB = minimal, confident, contemporary, athletic, street, premium, understated.",
  "Do not add graphics simply because the image needs branding. First analyze the image and",
  "determine what graphic treatment, if any, would make the photograph look more like a high-end",
  "Marathon Club campaign. If the image is already strong, use almost no graphics.",
].join(" ");

// ── WHAT THE PHOTOGRAPHER IS STILL NOT ALLOWED TO DO ─────────────────────────
// The design rule decides WHERE and WHETHER type appears. It does not change
// where the words come from, and the owner was explicit about that in the same
// instruction: "Prices and product names still come from the real records and
// are composited as real text — never drawn by the model."
//
// Those two requirements pull against each other at exactly one point. If the
// image model is left free to render letterforms, it renders them badly — this
// is the defect that produced garbled lettering and would invent a price, and a
// wrong price on a public post is a promise the shop has to honour. So the ban
// is not lifted wholesale; it is narrowed to its real target:
//
//   · FORBIDDEN, still: the model drawing letters, words, numbers or a logo.
//   · REQUIRED, new: the model composing FOR type — leaving the calm negative
//     space, the wall, the architecture that typography can later sit inside.
//
// The photograph is art-directed to receive the design; the design layer sets
// the type from /products. Neither half draws the other's part.
const TYPE_IS_COMPOSITED = [
  "COMPOSITION FOR TYPOGRAPHY, NOT TYPOGRAPHY ITSELF.",
  "Every word, number, price and logo on the finished post is composited afterwards as real text",
  "from our product records. You therefore must NOT render any lettering, words, numbers, prices,",
  "labels, watermarks or logos into the image — imagined lettering is always wrong and a wrong",
  "price is a promise we would have to honour.",
  "What you must do instead is COMPOSE FOR IT: follow the design rule above and leave the calm,",
  "uncluttered negative space — wall, sky, road, shadow, floor — where that typography will sit,",
  "in the place the composition naturally wants it rather than the same corner every time.",
  "A photograph that leaves nowhere for type to live has not followed this instruction.",
].join(" ");

function buildScenePrompt({ kind, productNames = [], style = "house", styleNotes = [] } = {}) {
  const scene = KIND_SCENE[kind];
  if (!scene) throw new Error(`buildScenePrompt: no scene for kind "${kind}"`);
  const parts = [
    "You are photographing products for our shop's social media.",
    scene,
    style === "white" ? SCENE_WHITE : SCENE_HOUSE,
  ];
  if (productNames.length) {
    parts.push(
      `The attached PRODUCT images are, in order: ${productNames.map((n, i) => `(${i + 1}) ${n}`).join("; ")}. ` +
      "Every one of them must appear in the output, and no product that is not attached may appear."
    );
  }
  const notes = styleNotes.map((n) => String(n || "").trim()).filter(Boolean);
  if (notes.length) {
    // The library's notes are Junid's own words about what he liked. They are
    // a hint, explicitly subordinate to the reference photographs and to the
    // condition rule — a note reading "make them look new" must not win.
    parts.push(`Styling notes from our reference library (guidance only): ${notes.slice(0, 6).join(" · ")}`);
  }
  parts.push(CONDITION_CLAUSE);
  parts.push(DESIGN_RULE);
  parts.push(TYPE_IS_COMPOSITED);
  parts.push(
    "Photorealistic, tack-sharp, correctly exposed — indistinguishable from a real photograph " +
    "of THESE items."
  );
  return parts.join("\n\n");
}

/**
 * The caption prompt. Deliberately short and concrete: the model is told who
 * the shop is, what is in the picture (with real prices), and what a caption
 * for this shop sounds like.
 */
function buildCaptionPrompt({ kind, products = [], link = "", styleNotes = [] } = {}) {
  // ── NO PRICES IN THE CAPTION ───────────────────────────────────────────────
  // Owner rule, 2026-08-23: the price belongs ON THE ARTWORK, beside the
  // product, composited as real text from the product record — not written into
  // caption prose by a language model. So the model is not TOLD the prices at
  // all. Withholding them is stronger than asking it not to use them: it cannot
  // quote, round or mistype a number it never saw, and a caption reading
  // "R1 350" can no longer drift from what the image says.
  const lines = products.map((p) => {
    const slot = p.slot ? ` [${p.slot}]` : "";
    return `· ${p.name}${slot}`;
  });
  const kindLine = {
    single: "This post shows ONE product.",
    flatlay: "This post is a flat-lay of several products photographed together.",
    new_arrivals: "This post is a carousel of products that JUST went live on the online store.",
    outfit: "This post is one complete outfit — the pieces listed below, put together.",
  }[kind] || "This post shows the products listed below.";

  const notes = styleNotes.map((n) => String(n || "").trim()).filter(Boolean).slice(0, 6);

  return [
    // The old wording named "Three physical stores", and the model dutifully
    // wrote "in-store and online". The online business is separate from the
    // shops and nothing published may send anyone to one, so the brief no
    // longer contains a shop for it to mention.
    "You write the Instagram, Facebook and TikTok captions for Marathon Club, an ONLINE " +
    "sneaker and streetwear store shipping across South Africa.",
    "",
    kindLine,
    "",
    "In the picture:",
    ...lines,
    "",
    notes.length ? `The look we go for, in our own words: ${notes.join(" · ")}` : "",
    "",
    "Write ONE caption. Rules:",
    "· Written for a person, not for a search engine. Two or three short lines.",
    "· Name the products the way a customer would say them. Brand names are fine and expected.",
    "· South African English, South African rands, no American slang.",
    "· NEVER mention a physical shop, branch, address or opening hours. Never write " +
    "\"in store\", \"in-store\", \"visit us\", \"come see us\", \"pop in\" or any branch name. " +
    "This is an ONLINE store only. A caption that mentions a shop is REFUSED and the post " +
    "cannot go out.",
    "· NEVER write a price. Prices appear on the artwork, placed next to the product. " +
    "Do not write any rand amount, and do not say a product is cheap, on sale or discounted.",
    "· No emoji spam — at most two, and only if they earn their place.",
    `· At most ${MAX_HASHTAGS} hashtags, on their own final line. No hashtag walls.`,
    "· Do NOT write the link — it is appended automatically.",
    "· Do not mention that this was generated, and do not describe the photograph.",
    "",
    "Reply with the caption text and nothing else — no preamble, no quotes, no markdown.",
  ].filter((l) => l !== null).join("\n");
}

/**
 * Read a model's caption reply into something postable, or refuse it.
 * Returns { ok, caption, reason }.
 *
 * Refusing is the point. An unusable caption that reaches the queue wastes
 * Junid's review time on something he has to rewrite anyway, and — because the
 * image was already paid for — a silent pass-through hides a broken prompt
 * behind a generation that "worked".
 */
function readCaption(raw) {
  let text = String(raw || "");
  // Models fence prose surprisingly often when the prompt contains a bulleted
  // spec. Strip a whole-body fence; leave an inline backtick alone.
  const fence = text.match(/^\s*```[a-z]*\n([\s\S]*?)\n?```\s*$/i);
  if (fence) text = fence[1];
  text = text
    .replace(/\r\n/g, "\n")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length < CAPTION_MIN) return { ok: false, caption: null, reason: "the model returned an empty or near-empty caption" };
  if (/^(i'm sorry|i cannot|i can't|as an ai|unfortunately, i)/i.test(text)) {
    return { ok: false, caption: null, reason: "the model refused instead of writing a caption" };
  }
  const hashtags = text.match(/#[\p{L}\p{N}_]+/gu) || [];
  if (hashtags.length > MAX_HASHTAGS) {
    // Trim rather than refuse — the caption body is usually fine and the tail
    // is the only problem. Keep the first MAX_HASHTAGS in the order written.
    let kept = 0;
    text = text.replace(/#[\p{L}\p{N}_]+/gu, (m) => (++kept <= MAX_HASHTAGS ? m : "")).replace(/[ \t]{2,}/g, " ").trim();
  }
  if (text.length > CAPTION_MAX) {
    const hard = text.slice(0, CAPTION_MAX - 1);
    text = `${hard.replace(/\s+\S*$/, "").trimEnd()}…`;
  }
  return { ok: true, caption: text, reason: null };
}

/**
 * The fallback caption, used when the caption model is unreachable or refuses.
 *
 * It exists so that a paid image generation is never thrown away for want of
 * words — the post lands in the queue as a draft with a plain, honest caption
 * Junid can rewrite in ten seconds, which is strictly better than losing the
 * picture. It is deliberately plain: nobody should mistake it for the
 * generated one, and the record marks it (captionSource: "fallback").
 */
function fallbackCaption({ kind, products = [] }) {
  const names = products.map((p) => p.name).filter(Boolean);
  if (kind === "new_arrivals") return `Just landed in store and online.\n\n${names.slice(0, 5).join("\n")}`;
  if (kind === "outfit") return `One fit, head to toe.\n\n${names.join("\n")}`;
  if (kind === "flatlay") return `A few of our favourites right now.\n\n${names.join("\n")}`;
  return names[0] ? `${names[0]} — in store and online now.` : "In store and online now.";
}

module.exports = {
  CAPTION_MIN, CAPTION_MAX, MAX_HASHTAGS,
  SCENE_HOUSE, SCENE_WHITE, CONDITION_CLAUSE, KIND_SCENE,
  buildScenePrompt, buildCaptionPrompt, readCaption, fallbackCaption,
  DESIGN_RULE, TYPE_IS_COMPOSITED,
};
