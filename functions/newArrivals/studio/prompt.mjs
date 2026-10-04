// ── THE PROMPT: the locked baseline, plus proven layers ─────────────────────
// baseline-prompts.mjs is the signed-off text (its sha256 is pinned in
// config/baseline.lock.json and by the test). A later rule is a LAYER: its own
// paragraph, inserted just before the baseline's studio brief, switched on in
// config/generation.json. With every layer off the prompt is byte-for-byte
// the baseline; with only `packaging` on it is byte-for-byte what the Mac mini
// sent (composePrompt in marathon-group-poster).
import { baselinePrompt, BASELINE_TEXT } from "./baseline-prompts.mjs";
import { PACKAGING_LAYER } from "./compose.mjs";

export const PROMPT_VERSION = "studio-2026-10-04.1";

// T-shirts already come out right on the bare baseline (Junid, 4 Oct): they —
// and the other printed jersey tops cut like them — get no clothing layer at
// all on Full Gemini, so they cannot regress.
export const BASELINE_ONLY_KEYS = Object.freeze(["t-shirts", "golf-t-shirts", "basketball-vests", "baseball-shirts", "soccer-jerseys"]);

/**
 * LAYER steam (clothing except the tee-like tops): steaming is the priority —
 * the creases of packing and storage out, studio light, true colour — and
 * NOTHING that is designed into the garment touched.
 */
export const STEAM_LAYER = [
  "STEAMED AND PRESSED — the most important thing for this garment. It must look freshly steamed, as in a brand's",
  "own studio photograph: remove the packing creases, fold lines and crumpling that storage and handling left in",
  "the staff photo, and any place where it was squashed flat in a bag.",
  "Remove ONLY those. Everything made into the garment stays exactly as made: its shape, cut, length, fit and",
  "volume — never inflated, stretched, straightened, levelled or resized; pleats and pressed creases; gathers,",
  "elastic and ribbing; quilting; crinkle, washed, faded or distressed finishes; the real texture and loft of knit",
  "and fleece — smooth, never ironed flat or shiny.",
  "Every print, logo, label, embroidery, stitch line, seam, pocket, zip and button stays exactly where and as it is,",
  "and the colour stays true — never lighter, darker or more saturated. Light it as the plate is lit.",
].join(" ");

/**
 * LAYER footwearBox (replaces `packaging` when on): every shoe is shown with
 * ONE box on the rail, like Junid's reference photos — its own box photo, else
 * the box standing in the shoe photo, else the brand's library box; never an
 * invented one. Each mode says plainly which earlier sentence it overrides, so
 * the model is never told two things.
 */
export function footwearBoxLayer(boxMode) {
  const which = boxMode === "own"
    ? "The BOX PHOTO is this shoe's own box: use that box. If the SHOE PHOTO shows the same box, it is the same box — show it once."
    : boxMode === "library"
    ? "Here the BOX PHOTO is a box of this shoe's BRAND, not its own — the sentence above calling it \"this product's own box\" does not apply. If the SHOE PHOTO itself shows this shoe's own box, use THAT very box — taken from the shoe photo, its branding, colours and text exact — and ignore the BOX PHOTO. Only if the SHOE PHOTO shows no box, use the brand's box from the BOX PHOTO, reproduced exactly."
    : "NO BOX PHOTO is given, so the sentence above about \"the BOX from the BOX PHOTO\" does not apply, and the boxes in the REFERENCE and in any example photo are NOT this shoe's. If the SHOE PHOTO itself shows this shoe's own box, mount THAT very box on the middle rail — taken from the shoe photo, its branding, colours and text exact. If the SHOE PHOTO shows no box, the result has NO box at all: the rail above the shoe stays empty, exactly as in the BACKGROUND PLATE. Never invent a box.";
  return [
    "THE BOX — the photo shows ONE box at most. When there is one it is mounted on the middle rail above the shoe as in",
    "the REFERENCE: upright, its front panel square to the camera, centred on the rail, its logo and every letter reading correctly.",
    which,
    "The box's branding, colours and text are never redrawn, restyled or changed, and a box's logo is never invented.",
    "It is part of the product shot — NOT \"something else\" added to the scene and NOT among the things to remove below.",
    "Never two boxes; never a box, bag or anything else on the pedestal beside the shoe.",
  ].join(" ");
}

/** LAYER footwearPose: ONE shoe, on the pedestal, as in Junid's references. Position and size stay the PLACEMENT's. */
export const FOOTWEAR_POSE_LAYER = [
  "THE SHOE — ONE shoe only (if the photo shows a pair, the RIGHT shoe), side-on with its outer side to the camera",
  "and its toe pointing right, standing level with its whole sole on the white pedestal, at the position and size",
  "the PLACEMENT above gives, sharp from heel to toe.",
  "The pedestal, the rails and the mesh wall stay exactly as in the BACKGROUND PLATE.",
].join(" ");

/** The layers that apply to this item, in prompt order: [{ name, text }]. Pure. */
export function layersFor({ kind, categoryKey = null, layers = {}, boxMode = "none" }) {
  const k = kind === "apparel" ? "single" : kind;
  const out = [];
  if (k === "footwear") {
    if (layers.footwearBox) out.push({ name: "footwearBox", text: footwearBoxLayer(boxMode) });
    else if (layers.packaging) out.push({ name: "packaging", text: PACKAGING_LAYER });
    if (layers.footwearPose) out.push({ name: "footwearPose", text: FOOTWEAR_POSE_LAYER });
  } else if (layers.steam && !BASELINE_ONLY_KEYS.includes(String(categoryKey || ""))) {
    out.push({ name: "steam", text: STEAM_LAYER });
  }
  return out;
}

/**
 * The full-method prompt. Pure.
 * → { text, layers: [names used], version }
 */
export function studioPrompt({ kind, categoryKey = null, productName, conditionClause, placement, layers = {}, boxMode = "none" }) {
  const base = baselinePrompt({ kind, productName, conditionClause, placement });
  const used = layersFor({ kind, categoryKey, layers, boxMode });
  if (!used.length) return { text: base, layers: [], version: PROMPT_VERSION };
  const at = base.indexOf(BASELINE_TEXT.ENHANCE);
  const text = `${base.slice(0, at)}${used.map((l) => `${l.text}\n\n`).join("")}${base.slice(at)}`;
  return { text, layers: used.map((l) => l.name), version: PROMPT_VERSION };
}

/** "baseline-2026-10-02" or "baseline-2026-10-02+steam" — which setup made a photo. Pure. */
export const setupName = (used) => (used && used.length ? `baseline-2026-10-02+${used.join("+")}` : "baseline-2026-10-02");
