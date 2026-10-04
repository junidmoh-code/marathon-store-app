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

// T-shirts already come out right on the bare baseline (Junid, 4 Oct): they
// get no clothing layer at all, so they cannot regress.
export const BASELINE_ONLY_KEYS = Object.freeze(["t-shirts", "golf-t-shirts"]);

/**
 * LAYER steam (clothing except t-shirts): steaming is the priority — creases,
 * squashing and fold lines out; the garment pressed and full; studio light;
 * true colour; nothing on the garment itself changed.
 */
export const STEAM_LAYER = [
  "STEAMED AND PRESSED — the most important thing for this garment. It must look freshly steamed and pressed, as in",
  "a brand's own studio photograph: remove every packing crease, fold line, wrinkle and squashed or flattened area",
  "the staff photo shows. The fabric hangs full and smooth with its natural weight and drape; the collar, cuffs,",
  "hem and waistband lie flat and even; sleeves and legs hang straight. Knits and fleece keep their real texture and",
  "loft — smooth, never ironed flat or shiny. Light it with soft studio light (a key light and a soft fill) so the",
  "fabric shows gentle natural shading, never flat.",
  "Creases are removed from the FABRIC only: every print, logo, label, embroidery, stitch line, seam, pocket, zip",
  "and button stays exactly where and as it is, and the colour stays true — never lighter, darker or more saturated.",
].join(" ");

/**
 * LAYER footwearBox (replaces `packaging` when on): every shoe is shown with
 * ONE box on the middle rail, like Junid's reference photos — its own box
 * photo, else the box standing in the shoe photo, else the brand's library
 * box; never an invented one.
 */
export function footwearBoxLayer(boxMode) {
  const which = boxMode === "own"
    ? "The BOX PHOTO is this shoe's own box: use that box. If the SHOE PHOTO shows the same box, it is the same box — show it once."
    : boxMode === "library"
    ? "If the SHOE PHOTO itself shows this shoe's own box, use THAT very box — taken from the shoe photo, its branding, colours and text exact — and ignore the BOX PHOTO. Only if the SHOE PHOTO shows no box, use the brand's box from the BOX PHOTO, reproduced exactly."
    : "No BOX PHOTO is given. If the SHOE PHOTO itself shows this shoe's own box, use THAT very box — taken from the shoe photo, its branding, colours and text exact. If it shows no box, leave the rail empty: never invent a box.";
  return [
    "THE BOX — the photo shows ONE box at most, mounted on the middle rail above the shoe exactly like the REFERENCE:",
    "upright, its front panel square to the camera, centred on the rail, its logo and every letter reading correctly.",
    which,
    "The box's branding, colours and text are never redrawn, restyled or changed, and a box's logo is never invented.",
    "It is part of the product shot — NOT \"something else\" added to the scene and NOT among the things to remove below.",
    "Never two boxes; never a box, bag or anything else on the pedestal beside the shoe.",
  ].join(" ");
}

/** LAYER footwearPose: ONE shoe, on the pedestal, as in Junid's references. */
export const FOOTWEAR_POSE_LAYER = [
  "THE SHOE — ONE shoe only (if the photo shows a pair, the RIGHT shoe), standing level with its whole sole on the",
  "white pedestal, centred on it, side-on with the toe pointing right, the whole shoe sharp from heel to toe.",
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
