// ─── AI STUDIO — THE SHARED PHOTO-REGENERATOR CORE ───────────────────────────
// The photo regenerator was built inside the AI Studio view (App.jsx) and it
// works: two style presets, a set of one-tap fix chips, a free-text
// instruction, and one Cloud Function that does the generating. Shopify
// Publishing needs the SAME tool on the product page, and the way to give it
// that is not to write a second one — it is to take the parts that are not
// visual out of App.jsx and let both surfaces import them.
//
// WHAT LIVES HERE: the preset vocabulary, the fix-chip vocabulary, how a note
// is composed, how the callable is invoked, and how its answer is read. All
// pure — no React, no Firebase, no styling. Both callers pass their own
// httpsCallable-bound function in, so this module never imports the app's
// Firebase instance and stays unit-testable.
//
// WHAT DOES NOT LIVE HERE: the two surfaces' chrome. AI Studio is a dark-glass
// panel with its own blues and purples; the Shopify page is built from
// stock/ui.js tokens. Re-skinning one to look like the other would be a much
// larger change than sharing the logic, and it is not what was asked for.
//
// ── THE TWO PRESETS, READ FROM THE FUNCTION, NOT FROM THEIR NAMES ────────────
// Junid calls them "house" and "normal". In the code they are the `style`
// argument to generateProductPhotos:
//
//   "white"  (his "normal") — the classic studio re-shoot: the product alone
//            on pure #FFFFFF, then trimmed, centred on a uniform 1500² square
//            and contrast-strengthened so a grid of them looks even. Runs on
//            gemini-3.1-flash-image ("Nano Banana 2") for Footwear and
//            Clothing, OpenAI gpt-image-1 otherwise, unless an engine is
//            forced. ~$0.067 an image on Gemini.
//
//   "house"  — the Marathon scene. The product is sent to
//            gemini-3-pro-image ("Nano Banana Pro") ALONGSIDE the enabled
//            Style Kit reference photographs for its template (sneaker or
//            clothing), so the output is conditioned on the shop's real
//            backdrop, lighting and layout rather than described in words.
//            Sneakers also get their own box shot when one is saved. The
//            generated scene is kept as-is (only resized) — the white
//            pipeline's trim-and-square passes would mangle the backdrop.
//            ~$0.134 an image, and it FAILS LOUDLY rather than generating
//            ungrounded if the template has no enabled references.
//
// The engine picker is a separate thing from the preset and applies only to
// "normal": house always runs on Nano Banana Pro and the function ignores an
// engine override on that path.
//
// ── NOTHING GENERATED IS EVER USED WITHOUT A HUMAN SAYING SO ─────────────────
// The function writes the image to its own new Storage object and records a
// PROPOSAL. It never edits the product, never edits the publishing set, and
// never touches the original. Every caller here is expected to show the
// result beside the original and wait for an explicit accept.

/** The `style` values generateProductPhotos understands. */
export const STYLE_WHITE = "white";
export const STYLE_HOUSE = "house";

/**
 * The two presets, in the order they are offered. `costUSD` is the per-image
 * figure the function itself uses as its flat fallback (GEMINI_FLAT_IMAGE_USD
 * and NBPRO_FLAT_IMAGE_USD in functions/index.js) — shown so nobody taps a
 * generate button without knowing what it costs.
 */
export const PHOTO_PRESETS = [
  {
    key: STYLE_WHITE,
    label: "Normal",
    hint: "Studio re-shoot on plain white, squared and evened up",
    costUSD: 0.067,
  },
  {
    key: STYLE_HOUSE,
    label: "House",
    hint: "Re-shot in the Marathon scene from the Style Kit photos",
    costUSD: 0.134,
  },
];

/** Engine choices for the "normal" preset. House ignores these. */
// The hints describe what the router ACTUALLY does. defaultEngineFor() sends
// Footwear AND Clothing to Gemini and everything else (accessories, perfume) to
// OpenAI — so the long-standing "OpenAI · best for clothing" label described a
// route that has never existed. Corrected here, for both surfaces at once.
export const PHOTO_ENGINES = [
  ["auto", "Auto", "shoes & clothing → Gemini, the rest → OpenAI"],
  ["gemini", "Gemini", "flat per-image price"],
  ["openai", "OpenAI", "billed per token, rises with quality"],
];

/**
 * The engine the function will actually use, given the preset, an explicit
 * choice, and the product. Mirrors defaultEngineFor() in functions/index.js —
 * a UI that prices a button has to know which provider will be billed.
 */
export function resolveEngine({ style = STYLE_WHITE, engine = "auto", product = null } = {}) {
  if (style === STYLE_HOUSE) return "nbpro";
  if (engine === "gemini" || engine === "openai") return engine;
  const c = product && product.category;
  return c === "Footwear" || c === "Clothing" ? "gemini" : "openai";
}

/**
 * What the button may honestly claim. Gemini and Nano Banana Pro have a flat
 * documented per-image price; OpenAI gpt-image-1 is billed on tokens and rises
 * with quality, so there is no single number to show and the label says so
 * instead of showing a figure that belongs to a different provider.
 */
export function priceLabelFor(resolved) {
  if (resolved === "nbpro") return "~$0.134";
  if (resolved === "gemini") return "~$0.067";
  return "billed per token";
}

// One-tap fix shortcuts: a short label the reviewer taps → the clear, expanded
// instruction the image engine actually understands. Tap several to combine;
// free text is added on top. MOVED here from App.jsx so the two surfaces can
// never drift into offering different fixes.
// ── FOUR OF THESE USED TO ASK FOR WEAR REMOVAL WITHOUT SAYING SO ─────────────
// Audited against the owner ruling of 2026-08-20. The chips are injected as
// "PRIORITY FIX … Apply this above all else", so an instruction here outranks
// the base prompt by construction — which makes a loose phrase here more
// dangerous than the same phrase in the prompt body. What was wrong:
//
//   "Wrong shape"    "the authentic product's true shape and proportions" — a
//                    worn shoe's shape IS deformed by wear, so "true shape"
//                    reads as "the shape it had when new".
//   "Colour off"     "restore the product's true, full-strength colours" — a
//                    sun-faded garment's true colour IS faded; "restore" reads
//                    as un-fading it.
//   "Blacks weak"    same failure: a genuinely faded black tee would be
//                    "made richer and deeper" back to how it left the factory.
//   "Design detail"  "fix the ... stitching to match the authentic product" —
//                    on a shoe with burst or frayed stitching, that is a
//                    repair.
//
// Each offending phrase is now GONE rather than caveated. Caveating each chip
// was the first attempt and it was wrong: the qualifiers pushed three chips
// past 200 characters, and with a 240-character cap that means tapping one
// leaves room for nothing else — the tool loses its combinability to defend a
// rule the CONDITION_CLAUSE in buildPhotoPrompt already enforces absolutely,
// after and above everything typed here. So the chips just stop asking, and
// stay short enough to combine.
export const FIX_PRESETS = [
  ["Wrong shape",   "the rendered shape and silhouette are wrong for this model — correct the proportions to the real model's"],
  ["Wrong side",    "the wrong side is showing — show the OUTER branded display side, do not flip to the plain inner side"],
  ["Colour off",    "exposure and white balance are off — correct the PHOTOGRAPH's colour rendering, not the item's own colour"],
  ["Blacks weak",   "the darks are lifted and grey from exposure — correct the PHOTOGRAPH's tone so blacks and navy read true"],
  ["Blurry",        "it looks blurry or soft — make it tack-sharp with crisp clean edges and fine detail throughout"],
  ["Design detail", "the design is rendered wrongly — fix the logos, patterns, stitch PATTERN and text to match the real model"],
  ["Framing",       "framing is off — centre the product straight and level with an even margin, fully visible and not cut off"],
  ["Remove bg",     "remove every trace of the original background and props — show only the single product on flat pure white"],
];

/** The server's own cap on a run note (functions/index.js). Mirrored so the
 *  box can show a real character count instead of silently losing the tail. */
export const NOTE_MAX = 240;

/**
 * Toggle one fix instruction in and out of a note, preserving whatever free
 * text is already there. The instructions are joined with "; " because that is
 * how they read as one sentence to the model.
 */
export function toggleFix(note, instruction) {
  const t = String(note ?? "").trim();
  if (t.includes(instruction)) {
    return t
      .replace(instruction, "")
      .replace(/;\s*;/g, ";")
      .replace(/^;\s*|;\s*$/g, "")
      .trim();
  }
  // ── DO NOT TRUNCATE AN INSTRUCTION ───────────────────────────────────────
  // The old `.slice(0, NOTE_MAX)` here was worse than a lost tail. The chips
  // are 100-103 characters, so a third one lands exactly on the 240 cap and
  // gets cut mid-sentence: "…the colours are off or washed out" — with
  // the corrective half of a chip — e.g. the fix that follows "the colours are
  // off" — leaving the paid prompt asserting a fault and never asking for it
  // to be fixed
  // gone. The paid prompt then TELLS the model the colours are wrong and
  // never says to fix them, which is the opposite of what was tapped. And
  // because `note.includes(instruction)` is then false, the chip renders
  // unticked and tapping it again just re-truncates: permanently stuck off,
  // with a fragment only hand-editing could remove.
  //
  // A chip that does not fit is not added. The caller sees no tick, which is
  // the truth: the instruction is not in the note.
  const next = t ? `${t}; ${instruction}` : instruction;
  return next.length > NOTE_MAX ? t : next;
}

/** Would this fix chip fit? Lets a UI dim what it cannot add, instead of
 *  offering a tap that silently does nothing. */
export function fixFits(note, instruction) {
  const t = String(note ?? "").trim();
  if (t.includes(instruction)) return true;   // already on — untapping always fits
  return (t ? `${t}; ${instruction}` : instruction).length <= NOTE_MAX;
}

/**
 * The exact sanitisation the function applies, run here too so what the box
 * shows is what the model will be given. Control characters out, whitespace
 * collapsed, capped.
 */
export function sanitiseNote(note) {
  return String(note ?? "")
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NOTE_MAX);
}

/**
 * Build the generateProductPhotos payload for ONE product.
 *
 * `sourceUrl` is the photo to re-shoot. Shopify Publishing needs it because
 * the publishing set is not the product record's photo list — the reviewer
 * picks a slot in the strip and expects THAT image re-shot. AI Studio omits
 * it and the function falls back to the record's hero, exactly as before.
 *
 * `reprocess: true` always: every caller here is asking for a specific
 * product on purpose, and the "skip anything already done" filter exists for
 * the unattended catalogue sweep, not for a deliberate tap.
 */
export function buildGenerateRequest({ productId, style = STYLE_WHITE, note = "", engine = "auto", quality = "medium", sourceUrl = null }) {
  if (!productId) throw new Error("buildGenerateRequest needs a productId");
  const clean = sanitiseNote(note);
  const houseStyle = style === STYLE_HOUSE;
  return {
    productIds: [productId],
    reprocess: true,
    quality,
    // House forces Nano Banana Pro server-side; sending an engine with it
    // would suggest a choice that does not exist.
    ...(!houseStyle && (engine === "gemini" || engine === "openai") ? { engine } : {}),
    ...(houseStyle ? { style: STYLE_HOUSE } : {}),
    ...(clean ? { note: clean } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

/** " · gemini $0.0390, openai $0.0461" from the function's per-engine split. */
export function costByEngineStr(cbe) {
  if (!cbe || typeof cbe !== "object") return "";
  const parts = Object.entries(cbe)
    .filter(([, v]) => Number(v) > 0)
    .map(([k, v]) => `${k} $${Number(v).toFixed(4)}`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
}

/**
 * Aggregate the function's per-product failure reasons into a short "why", so
 * a run that generated nothing is never silent. Empty when there were no
 * failures, or when an older deployed build returned no `failures` array.
 */
export function photoFailureSuffix(failures) {
  if (!Array.isArray(failures) || !failures.length) return "";
  const byReason = new Map();
  for (const f of failures) {
    const r = (f && f.reason) || "failed";
    byReason.set(r, (byReason.get(r) || 0) + 1);
  }
  return ` — why: ${[...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r} ×${n}`)
    .join("; ")}`;
}

/**
 * Read a single-product run's answer.
 *
 * → { ok: true, proposedUrl, engine, costUSD } when an image was made,
 * → { ok: false, problem } with the function's OWN reason when it was not.
 *
 * A `processed` count with no sample entry is treated as a failure rather than
 * silently returning undefined: the caller is about to show the reviewer a
 * picture, and there is nothing to show.
 */
export function readGenerateResult(data, productId) {
  const d = data || {};
  const hit = (Array.isArray(d.sample) ? d.sample : []).find((s) => s && s.id === productId);
  if (!hit || !hit.proposedUrl) {
    const why = photoFailureSuffix(d.failures);
    return {
      ok: false,
      problem: why
        ? `Nothing was generated${why}.`
        : "Nothing was generated, and the server gave no reason. Try again — if it keeps happening the image service is likely out of credit.",
    };
  }
  return {
    ok: true,
    proposedUrl: hit.proposedUrl,
    engine: hit.engine || null,
    // The image the SERVER actually read. Absent from any deployed build older
    // than the `sourceUrl` argument — which is the signal a caller needs to
    // refuse a side-by-side it cannot vouch for. Deliberately NOT defaulted to
    // the requested url: a missing echo must read as "unknown", never as
    // "yes, the one you asked for".
    usedSourceUrl: hit.sourceUrl ?? null,
    costUSD: Number(d.estCostUSD) || 0,
    costLine: costByEngineStr(d.costByEngine),
  };
}

/**
 * Does this condition grade tell the customer there are marks on the item?
 *
 * The first version of this test was `/marks|wear/i` against the grade string,
 * inline in the card. It fired on ALL THREE grades — including "Excellent — no
 * visible wear", which contains the word "wear" while saying the opposite. A
 * product cannot go live without a grade, so the warning fired on every
 * publishable product, and the copy beneath it then told the reviewer that
 * "the description tells the customer those marks are there" on an item graded
 * as having none. A banner that fires every time is the banner people learn to
 * click past, which is the opposite of a backstop.
 *
 * Matched on the grade's MEANING, against the three known strings, with an
 * explicit negation check so a future grade worded "no visible scuffs" cannot
 * re-open the same hole.
 */
export function gradeAdmitsWear(condition) {
  const c = String(condition ?? "").trim().toLowerCase();
  if (!c) return false;
  if (/\bno visible\b|\bno\s+\w*\s*(wear|marks)\b/.test(c)) return false;
  return /\bmarks?\b|\bwear\b|\bworn\b|\bscuff/.test(c);
}
