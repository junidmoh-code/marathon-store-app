// ── THE SPLIT METHOD'S PRODUCT-ONLY PROMPT (Junid, 3 Oct) ────────────────────
// "Gemini gets the PRODUCT right and the placement and background wrong." So
// in the split method Gemini makes the PRODUCT ONLY — on a plain light-grey
// studio background — and code places it on Junid's real plate.
// Derived from the LOCKED 2 Oct baseline text (src/baseline-prompts.mjs, which
// is NOT changed): its product rules (right shoe, outer side, toe right, own
// box, never mirror; garment on a hanger, front facing, full length; the
// studio-quality brief and NEVER CHANGE THE PRODUCT, verbatim) with every
// plate, reference, layout and placement part taken out, and Junid's reshoot
// words added (steamed/pressed, studio-lit, crisp, true colour, every text,
// logo and label exact). 4 Oct (Junid): the shoe's own branded box OR BAG in
// the photo is kept, apart from the shoe (code cuts them apart), never invented
// when there is none. A separate, named, versioned prompt: its fingerprint
// is pinned in config/split.lock.json by test/split.test.mjs.
import { BASELINE_TEXT } from "./baseline-prompts.mjs";

export const SPLIT_PROMPT_VERSION = "split-product-2026-10-04.1";

// The plain studio background Gemini is asked for (code cuts the product out of it).
export const STUDIO_GREY = "plain, seamless, evenly lit light-grey studio background (a flat neutral light grey, no gradient, no texture, no floor line)";

const PRODUCT = {
  footwear: [
    "Make ONE professional studio product photograph of the real products from the SHOE PHOTO, alone on a",
    `${STUDIO_GREY}.`,
    "The SHOE: side-on, the RIGHT shoe, its OUTER side to the camera, TOE POINTING RIGHT, standing level on its sole.",
    "PACKAGING — this product's own branded box or bag, the very same one (from the BOX PHOTO, or standing in the",
    "shoe photo), is part of the product: keep it, its branding, colours and text exact, never redrawn or changed. It",
    "stands upright beside the shoe, its front panel square to the camera. The shoe and the packaging stand apart,",
    "never touching or overlapping, with plain grey between them; both are shown whole.",
    "If there is no BOX PHOTO and the shoe photo shows no box or bag, show the shoe alone — never add one.",
    "NEVER mirror, flip or rotate the shoe or its packaging: every logo and every letter must read exactly as in the",
    "photos, never reversed. If the shoe photo shows the shoe toe-left, do not fix it by mirroring.",
    "Nothing else in the picture: no floor, no props, no hands, no other objects (its own box or bag is part of the product, not another object).",
  ],
  single: [
    "Make ONE professional studio product photograph of the real garment from the GARMENT PHOTO, alone on a",
    `${STUDIO_GREY}: on a plain hanger, front facing, full length, the whole garment and the whole hanger visible.`,
    "One garment only. Never mirror or flip the garment: all print and text reads correctly.",
    "Nothing else in the picture: no props, no hands, no other objects.",
  ],
  twopiece: [
    "Make ONE professional studio product photograph of BOTH pieces of the set from the GARMENT PHOTO, alone on a",
    `${STUDIO_GREY}: each piece on its own plain hanger, front facing, full length, side by side — the top on the`,
    "left and the bottoms on the right — never touching or overlapping, with plain grey between them; both whole.",
    "Never mirror or flip: all text reads correctly. Nothing else in the picture: no props, no hands, no other objects.",
  ],
};

// The baseline's studio brief minus its plate words ("light the product like the
// plate", "contact shadow where it touches the pedestal or hangs against the
// fence" — code adds the shadow), plus Junid's reshoot words.
const ENHANCE = [
  "STUDIO QUALITY — a poor staff photo must not make the product look bad. Light the product with soft studio",
  "light (a key light and a soft fill, consistent direction, neutral white balance), tack-sharp focus, clean crisp",
  "edges, true-to-life colour. Remove what is merely ON the photo, not part of the product (a shoe's own box or",
  "bag IS part of it — keep it): dust, lint, smudges,",
  "glare, stray threads, staff fingers and hands, price tags and swing tags, and any bleed of the original",
  "background. Footwear: laces neat and symmetrical. Garments: steamed and pressed — no packing creases or fold",
  "lines — presented smoothly, keeping their real cut and fit. Every text, logo and label exact, character for",
  "character.",
].join(" ");

/**
 * The product-only prompt. Pure.
 *   kind: footwear | single | twopiece (apparel → single)
 */
export function productOnlyPrompt({ kind, productName, conditionClause }) {
  if (kind === "apparel") kind = "single";
  if (!PRODUCT[kind]) throw new Error(`unknown product kind ${kind}`);
  if (!conditionClause) throw new Error("a generation prompt needs the CONDITION_CLAUSE");
  return [
    PRODUCT[kind].join(" "),
    `This product is: ${String(productName || "").slice(0, 160)}.`,
    ENHANCE,
    BASELINE_TEXT.NEVER_CHANGE,
    conditionClause,
  ].join("\n\n");
}

// The generation aspect for the product alone (the plate's aspect no longer matters:
// code places the cut-out). Shoe beside its box: landscape; one garment: portrait.
export const SPLIT_ASPECT = Object.freeze({ footwear: "4:3", single: "3:4", twopiece: "4:3" });

export const SPLIT_TEXT = Object.freeze({ PRODUCT, ENHANCE, STUDIO_GREY });
