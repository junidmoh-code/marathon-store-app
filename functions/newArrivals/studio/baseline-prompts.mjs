// ── THE LOCKED BASELINE (Junid, 3 Oct) ───────────────────────────────────────
// The EXACT generation prompt of 2 Oct (commit c16080e) that made the cream knit
// vest Junid called perfect: copied verbatim, frozen. Its fingerprint is pinned
// in config/baseline.lock.json and test/baseline.test.mjs fails if this file,
// the image model or the image size changes without Junid's sign-off there.
// Later rules are LAYERS (config/generation.json), each switched on only once a
// test generation proved it does not degrade quality.
const COMPOSE = {
  footwear: [
    "Make ONE professional studio product photograph by placing the real products into the BACKGROUND PLATE,",
    "composed exactly like the REFERENCE photo. Use the plate as the background EXACTLY — same fence, rails,",
    "pedestal, lighting and framing; add nothing else to the scene.",
    "The SHOE from the SHOE PHOTO stands on the white pedestal like the reference: side-on, the RIGHT shoe,",
    "its OUTER side to the camera, TOE POINTING RIGHT.",
    "The BOX from the BOX PHOTO — this product's own box, the very same box — is mounted on the middle rail",
    "above, like the reference, its front panel square to the camera.",
    "NEVER mirror, flip or rotate the shoe or the box: every logo and every letter must read exactly as in the",
    "photos, never reversed. If the shoe photo shows the shoe toe-left, do not fix it by mirroring.",
  ],
  single: [
    "Make ONE professional studio product photograph by hanging the real garment from the GARMENT PHOTO on the",
    "fence of the BACKGROUND PLATE: on a hanger, front facing, full length, centred, filling the LAYOUT DIAGRAM's box as described in the PLACEMENT below.",
    "Use the plate as the background EXACTLY — same fence, zoom and lighting; add nothing else. One garment only.",
    "Never mirror or flip the garment: all print and text reads correctly.",
  ],
  twopiece: [
    "Make ONE professional studio product photograph by hanging BOTH pieces of the set from the GARMENT PHOTO on the",
    "fence of the BACKGROUND PLATE, side by side, composed exactly like the REFERENCE photo: each on its hanger,",
    "front facing, full length, the top on the left and the bottoms on the right as in the reference. Use the plate",
    "as the background EXACTLY — same fence, zoom and lighting; add nothing else. The REFERENCE shows the layout",
    "only: its garments are a DIFFERENT product and must not appear. Never mirror or flip: all text reads correctly.",
  ],
};

const ENHANCE = [
  "STUDIO QUALITY — a poor staff photo must not make the product look bad. Light the product like the plate",
  "(soft studio light, consistent direction and white balance), tack-sharp focus, clean crisp edges, true-to-life",
  "colour, and a natural contact shadow where it touches the pedestal or hangs against the fence. Remove what is",
  "merely ON the photo, not part of the product: dust, lint, smudges, glare, stray threads, staff fingers and",
  "hands, price tags and swing tags, and any bleed of the original background. Footwear: laces neat and",
  "symmetrical. Garments: presented smoothly, keeping their real cut and fit.",
].join(" ");

const NEVER_CHANGE = [
  "NEVER CHANGE THE PRODUCT: its shape, silhouette, proportions, colourway, materials and textures, logos, text,",
  "stitching layout, sole pattern, hardware and every design element stay exactly as in the photo. Never invent",
  "detail that is not visible in the source — sharpen what exists, do not hallucinate what does not. The result",
  "must look like a real photograph of THIS item, not CGI, not plastic, not a render.",
].join(" ");

export function baselinePrompt({ kind, productName, conditionClause, placement }) {
  if (kind === "apparel") kind = "single";
  if (!COMPOSE[kind]) throw new Error(`unknown product kind ${kind}`);
  if (!conditionClause) throw new Error("a generation prompt needs the CONDITION_CLAUSE");
  return [
    COMPOSE[kind].join(" "),
    `This product is: ${String(productName || "").slice(0, 160)}.`,
    placement || "",
    ENHANCE,
    NEVER_CHANGE,
    conditionClause,
  ].filter(Boolean).join("\n\n");
}

export const BASELINE_TEXT = Object.freeze({ COMPOSE, ENHANCE, NEVER_CHANGE });
