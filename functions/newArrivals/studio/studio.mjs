// ── ONE GENERATION, START TO FINISH ─────────────────────────────────────────
// Junid taps Generate; this makes ONE photo from the ORIGINAL staff photo —
// never from an earlier generation — and reports what Gemini is doing while it
// works. One tap, one photo; nothing here starts by itself (EVERYTHING IS MANUAL,
// 4 Oct). Since 20–22 Nov 2026 the photo is checked against the staff photo
// before it lands (driftGuard) and a garment may get ONE steam-and-press pass
// or ONE remake — see "THE DRIFT GUARD AND THE GARMENT GATE" below.
//
// Every side effect is injected (deps), so the whole path runs in tests with
// no network, no Storage and no key.
import sharp from "sharp";
import {
  kindFor, UNKNOWN_FRAMING, brandKey, placementText, layoutGuideImage, genFrameOf,
  RATIOS, closestAspect, toMaster, forModel, inputOf,
} from "./compose.mjs";
import { studioPrompt, setupName } from "./prompt.mjs";
import { imagePart, textPart } from "./gemini-stream.mjs";
import { objectiveMeasurements } from "./measure.mjs";
import { correctFootwear } from "./correct.mjs";
import sourcePhoto from "../sourcePhoto.cjs";
import staging from "./staging.cjs";
import { isGarment, garmentFixNote, garmentFlagNote, betterGarment, finishOnly, GARMENT_FINISH, GARMENT_RETOUCH } from "../../lib/style-kit-catalogue.mjs";

export const METHODS = Object.freeze(["full", "split"]);
export const PROVIDERS = Object.freeze(["gemini", "openai"]);
const PROVIDER_NAME = { gemini: "Gemini", openai: "OpenAI" };

/** The engine for this generation: the tap's choice, else the item's, else the default (Gemini). Pure. */
export function providerFor(item, { asked = null, defaultProvider = "gemini" } = {}) {
  if (PROVIDERS.includes(asked)) return asked;
  if (PROVIDERS.includes(item?.provider)) return item.provider;
  return PROVIDERS.includes(defaultProvider) ? defaultProvider : "gemini";
}

/** The method for this generation: the tap's choice, else the item's, else the default. Pure. */
export function methodFor(item, { asked = null, defaultMethod = "full" } = {}) {
  if (METHODS.includes(asked)) return asked;
  if (METHODS.includes(item?.method)) return item.method;
  return METHODS.includes(defaultMethod) ? defaultMethod : "full";
}

/** Is the hi-res source still the photo the product shows? Pure. */
export function sourceFresh(product) {
  if (!product?.photoSourceUrl) return false;
  const made = Number(product.photoSourceUpdatedAt || product.newArrivalAt || product.createdBy?.at) || 0;
  return !(Number(product.photoUpdatedAt) > made + 60_000);
}

/**
 * The photo to generate from: the product's CURRENT staff photo (its hi-res
 * upload copy while that is still the photo staff took) — read from the
 * product now, never a copy pinned on the item, never a generated photo. Pure.
 */
export function originalUrlOf(item, product) {
  return (sourceFresh(product) && product.photoSourceUrl) || sourcePhoto.currentSourceUrl(item?.pid, product, item);
}

// What the extra example photos are — and are not — to the model.
export const EXAMPLES_LABEL = "MORE EXAMPLES OF THE SAME COMPOSITION — finished photos of OTHER products on this same backdrop: one shoe side-on on the white pedestal, toe to the right. Take nothing from them but the layout: the shoe in the result comes only from the SHOE PHOTO, and a box only as THE BOX rule above says — never a shoe, box or logo copied from these examples:";

/** A plain-words refusal: nothing was generated, nothing was paid. */
export class StudioRefusal extends Error {
  constructor(message) { super(message); this.studioRefusal = true; }
}

const draftJpeg = (buf) => sharp(buf).rotate().resize(1280, 1280, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();

/**
 * deps: {
 *   fetchBytes(url) → { buffer }, loadPlate(kind), loadReference(kind) → { buffer, width, height, file } | null,
 *   libraryBox(brandKey) → { buffer, kind } | null, spec, generation ({ imageModel, imageSize, layers }),
 *   correct? (the footwear correction — correct.mjs by default),
 *   conditionClause, image(model, parts, imageConfig, { onEvent }) (gemini-stream.streamImage with the key bound),
 *   upload(path, buffer, mime) → { path, url }, now(), log?(text), split? (the split method)
 * }
 * emit({ type, … }) — progress for the card; never throws.
 * → { generated, kind, method, promptVersion, layersUsed, box, trace, draftFiles, usage }
 */
export async function generateOne({ item, product, genId, method = "full", provider = "gemini", input = "photo", placeNote = false, secondRef = null, fix = null, deps, emit = () => {} }) {
  // The engine: its model and its name for the card's progress line. Everything else is the same for both.
  const model = provider === "openai" ? deps.generation.openaiModel : deps.generation.imageModel;
  const engine = PROVIDER_NAME[provider] || "Gemini";
  const say = (ev) => { try { emit(ev); } catch { /* the card's view never affects the generation */ } };
  let kind = kindFor(product || { categoryKey: item.categoryKey });
  // A clothing item with no category key: one garment on the single fence (a set has its own category).
  if (kind === UNKNOWN_FRAMING) kind = "single";
  if (!kind) throw new StudioRefusal(`there is no background for "${product?.categoryKey || item.categoryKey || "this category"}" — only footwear and clothing have Junid's plates`);
  const originalUrl = originalUrlOf(item, product);
  if (!originalUrl) throw new StudioRefusal("the product has no photo to work from");
  const categoryKey = product?.categoryKey || item.categoryKey || null;
  const { generation } = deps;
  const layers = generation.layers || {};

  say({ type: "status", text: "Reading the original photo…" });
  const { raw, orig } = await sourceFor({ deps, originalUrl, input, say });
  const ref2 = await secondRefFor({ deps, secondRef });

  // The box (footwear): its own box photo, else the brand's library box, else none.
  let box = null, boxMode = "none", boxSource = null, boxFrom = null, boxNote = null, libraryBoxPng = null;
  const brand = kind === "footwear" ? brandKey(product?.brand) : null;
  if (kind === "footwear") {
    if (product?.photoBoxUrl) {
      try {
        // A blip is tried again; a box photo that still cannot be read (gone,
        // not in the app's storage, too large) gives way to the brand library —
        // the shoe is never held back for its box. Said in the log and on the record.
        box = await forModel((await withRetries(() => deps.fetchBytes(product.photoBoxUrl), { tries: 2 })).buffer);
        boxMode = "own"; boxSource = "own"; boxFrom = { url: product.photoBoxUrl };
      } catch (e) {
        boxNote = `its own box photo could not be read (${String(e.message).slice(0, 80)})`;
        deps.log?.(boxNote);
      }
    }
    // No own box photo: the brand's library box (a clean cut-out of that brand's
    // box). Full Gemini is shown it only under the footwearBox rule; Split places
    // it by code, untouched.
    if (!box && deps.libraryBox && (layers.footwearBox || method === "split")) {
      const lib = await deps.libraryBox(brand).catch(() => null);
      if (lib?.buffer) {
        libraryBoxPng = lib.buffer;
        if (layers.footwearBox) { box = await forModel(lib.buffer); boxMode = "library"; boxSource = lib.kind || "library"; boxFrom = { file: `brand library box (${brand}, ${lib.kind || "?"})` }; }
      }
    }
  }

  if (method === "split") {
    if (!deps.split) throw new StudioRefusal("the split method is not installed");
    return deps.split({ item, product, genId, kind, categoryKey, orig, originalUrl, box, boxMode, boxSource, boxFrom, brand, libraryBoxPng, provider, model, engine, deps, say });
  }

  const plate = await deps.loadPlate(kind), ref = await deps.loadReference(kind);
  const spec = deps.spec?.[kind];
  if (!spec) throw new Error(`no layout spec for ${kind}`);
  // With no box, the box leaves the spec too: nothing is placed on the rail.
  // (The box rule may still mount the box standing in the shoe photo: the prompt says where — on the middle rail.)
  const effSpec = kind === "footwear" && boxMode === "none" ? { ...spec, box: undefined } : spec;
  const prompt = studioPrompt({ kind, categoryKey, productName: product?.name || item.name, conditionClause: deps.conditionClause,
    placement: placementText(kind, effSpec), layers, boxMode });
  const plateJ = plate.forModel || await forModel(plate.buffer);
  const refJ = ref ? (ref.forModel || await forModel(ref.buffer)) : null;
  // The frame asked for: the engine's nearest supported ratio (gpt-image-1 makes 2:3, 3:2 or 1:1 only); the
  // layout diagram is drawn in that frame and the result is cover-cropped to the plate, as for Gemini.
  const aspect = closestAspect(plate.width, plate.height, provider === "openai" ? ["2:3", "3:2", "1:1"] : null);
  const frame = genFrameOf(plate.width, plate.height, RATIOS[aspect]);
  // NO LAYOUT DIAGRAM FOR A GARMENT (Junid, 21 Nov 2026 — "no rectangles, frame lines, borders, boxes"): Gemini kept
  // drawing the diagram's dashed box into the wall (the brown knit polo; 3 of 9 first attempts in the proof run),
  // while every attempt sent without it was placed right by the PLACEMENT percentages alone. Footwear keeps it.
  const noDiagram = kind !== "footwear";
  const guideJ = noDiagram ? null : await forModel(await layoutGuideImage(kind, effSpec, plate.buffer, frame));

  // LAYER footwearExamples: more of Junid's own photos of the same composition
  // (other shoes, other boxes) — so the layout is learnt, not the one reference's shoe.
  // If they cannot be loaded the photo is still made, without them — said in the log and on the record.
  const examples = kind === "footwear" && layers.footwearExamples && deps.loadExamples
    ? await deps.loadExamples(kind, { brand }).catch((e) => { deps.log?.(`the example photos could not be loaded (${String(e.message).slice(0, 80)}) — generating without them`); return []; }) : [];
  const layersUsed = [...prompt.layers, ...(examples.length ? ["footwearExamples"] : [])];
  const inputs = await Promise.all([
    inputOf("plate", plateJ, { file: plate.file || null }),
    ...(refJ ? [inputOf("reference", refJ, { file: ref.file || null })] : []),
    ...examples.map((e) => inputOf("example", e.forModel, { file: e.file })),
    ...(guideJ ? [inputOf("layoutDiagram", guideJ, { file: "drawn from config/layout-spec.json" })] : []),
    inputOf("source", orig, { url: originalUrl }),
    ...(box ? [inputOf("box", box, boxFrom || {})] : []),
  ]);
  // THE 2 OCT BASELINE REQUEST, exactly: the prompt, plate, reference, layout
  // diagram, then the product photo (and box).
  const fixText = fix?.note || null;
  const parts = [
    textPart(prompt.text),
    ...(fixText ? [textPart(fixText)] : []),
    textPart("BACKGROUND PLATE — use exactly:"), imagePart(plateJ),
    ...(refJ ? [textPart("REFERENCE — the target composition and look:"), imagePart(refJ)] : []),
    ...(examples.length ? [textPart(EXAMPLES_LABEL), ...examples.map((e) => imagePart(e.forModel))] : []),
    ...(noDiagram ? [textPart(NO_DIAGRAM_NOTE)] : []),
    ...(guideJ ? [textPart("LAYOUT DIAGRAM — NOT part of the photo: the dashed box(es) on this grey diagram show where and how large the product goes on the canvas. Never draw boxes, outlines, labels or grey into the result. FIDELITY COMES FIRST: never change the product in any way to make it fit the box — only move it and scale it uniformly:"), imagePart(guideJ)] : []),
    ...(placeNote ? [textPart(PLACE_NOTE)] : []),
    textPart(kind === "footwear" ? "SHOE PHOTO — the real shoe:" : "GARMENT PHOTO — the real garment(s):"), imagePart(orig),
    ...(ref2 ? [textPart(SECOND_REF_LABEL), imagePart(ref2)] : []),
    ...(box ? [textPart(boxMode === "own" ? "BOX PHOTO — this shoe's own box:" : "BOX PHOTO — a box of this shoe's brand:"), imagePart(box)] : []),
  ];
  const imageConfig = { aspectRatio: aspect, imageSize: generation.imageSize };

  say({ type: "status", text: `${engine} is working…` });
  const draftFiles = [];
  const draftJobs = [];
  const gen = await deps.image(model, parts, imageConfig, {
    onEvent: (ev) => {
      if (ev.type === "thought") say({ type: "thought", text: ev.text });
      // A draft is shown as soon as it is stored; a failed upload never costs the photo.
      if (ev.type === "draft") draftJobs.push(keepDraft({ deps, pid: item.pid, genId, n: ev.n, draft: ev.draft, draftFiles, say }));
    },
  });
  await Promise.all(draftJobs);
  // The original given back (Junid, 20 Nov): never stored, never shown — the caller cleans the input and tries again.
  await refuseEcho({ out: gen.buffer, raw, sent: orig, plate, usage: gen.usage });

  // ── THE PHOTO IS PAID FOR. From here nothing may lose it: every step is
  // retried, and if the finishing step itself fails the photo is kept exactly
  // as Gemini made it. A failure below is marked `paid` for the caller.
  say({ type: "status", text: "Finishing the photo…" });
  let generated, gm = {}, finishNote = null, measured = gen.buffer, uncorrected = null, correction = null, note = null, placedSpec = null;
  try {
    gm = await sharp(gen.buffer).metadata().catch(() => ({}));
    // An answer that is not a readable image is not a photo: it is never stored or shown as one.
    if (!gm.width || !gm.height) throw new Error("the image model's answer was not a readable image");
    let out, mime = "image/jpeg";
    // THE ONE FINISHING STEP (20 Nov 2026): the master at the model's full resolution, JPEG q92 — for every caller.
    try { out = await toMaster(gen.buffer, plate); }
    catch (e) { out = gen.buffer; mime = gen.mime || "image/png"; finishNote = `kept as ${engine} made it — the finishing step failed (${String(e.message).slice(0, 80)})`; }
    measured = out;
    const stamp = deps.now();
    // (A footwear photo the finishing step could not even resize is kept as Gemini made it — and the card says so.)
    if (kind === "footwear" && generation.footwearCorrection && finishNote) {
      correction = { applied: false, problem: "the finishing step failed" };
      note = `Not placed on your backdrop — the finishing step failed. The photo shown is ${engine}'s own, so its pedestal and background are not your fixed plate; tap Regenerate to try again.`;
    }
    // THE PLATE LOCK (footwear): everything but the shoe and its box comes from the ONE fixed plate. The shoe
    // and box are lifted out of Gemini's photo, scaled uniformly to the measured layout and placed on the
    // untouched plate; Gemini's pedestal and background are discarded. If they cannot be lifted, Gemini's
    // photo is kept and the card says so. The correction can never cost the paid photo.
    if (kind === "footwear" && generation.footwearCorrection && !finishNote) {
      say({ type: "status", text: "Placing it on your backdrop…" });
      let fixed = null;
      // (Switched off since 20 Nov 2026 — generation.json footwearCorrection. When on, it places by the G-0102 layout.)
      try { fixed = await (deps.correct || correctFootwear)({ photoBuf: gen.buffer, plate, spec: deps.spec?.footwearPlateLock || spec }); }
      catch (e) { fixed = { problem: `the correction step failed (${String(e.message || e).slice(0, 80)})` }; }
      if (fixed?.buffer) {
        // Gemini's own photo is kept beside it, as a thumbnail on the card and on the record.
        try { const u = await withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${stamp}-uncorrected.${mime === "image/jpeg" ? "jpg" : "png"}`, out, mime)); uncorrected = { url: u.url, path: u.path || null }; }
        catch { /* the corrected photo is still shown; the record says the thumbnail is missing */ }
        out = fixed.buffer; measured = out;
        mime = "image/jpeg";
        if (fixed.fittedSpec) placedSpec = fixed.fittedSpec;
        correction = { applied: true, ...(uncorrected ? {} : { thumbnailMissing: true }), version: fixed.version, how: fixed.how, found: fixed.found, placed: fixed.placed, deviations: fixed.deviations || null, ...(fixed.fitted ? { fitted: fixed.fitted } : {}) };
        // Gemini was given a box but none could be found in its photo: the corrected photo has no box — said, never silent.
        if (boxMode !== "none" && !fixed.placed?.box) {
          correction.boxMissing = true;
          note = `The box could not be found on its own in ${engine}'s photo, so it was not placed — check this photo. ${engine}'s own photo is the small one below; tap Regenerate to try again.`;
        }
      } else {
        const why = fixed?.problem || "the correction gave no photo";
        correction = { applied: false, problem: why };
        note = `Not placed on your backdrop — ${why}. The photo shown is ${engine}'s own, so its pedestal and background are not your fixed plate; tap Regenerate to try again.`;
      }
    }
    try {
      generated = await withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${stamp}.${mime === "image/jpeg" ? "jpg" : "png"}`, out, mime));
    } catch (e) {
      // The corrected photo could not be stored, but Gemini's own already was: that one is shown, and it is said.
      if (!uncorrected) throw e;
      generated = uncorrected; uncorrected = null; measured = gen.buffer; placedSpec = null;
      correction = { applied: false, problem: "the corrected photo could not be stored" };
      note = `Not placed on your backdrop — the corrected photo could not be stored. The photo shown is ${engine}'s own, so its pedestal and background are not your fixed plate; tap Regenerate to try again.`;
    }
  } catch (e) {
    // The caller still counts what Gemini charged for it.
    e.paid = true;
    e.usage = gen.usage || null;
    throw e;
  }
  // Pixel measurements for the learning log (no model call): the product is
  // looked for where the layout puts it. Never a reason to lose the photo.
  let measurements = null;
  try {
    measurements = await objectiveMeasurements({ kind, out: measured, outBox: expectedBox(kind, placedSpec || effSpec, correction?.placed?.shoe || null), exclude: [], plate: plate.buffer, src: orig, srcBox: SOURCE_BOX, checker: null });
  } catch { /* no numbers for this one */ }
  // The final image is never also listed as a draft.
  const finalData = gen.buffer.toString("base64");
  const kept = draftFiles.filter((d) => d.data !== finalData).sort((a, b) => a.n - b.n).map(({ url, path }) => ({ url, path }));
  return {
    generated, kind, plateFile: plate.file || null, method: "full", provider, model, input, ...(placeNote ? { placeNote: true } : {}), ...(ref2 ? { secondRef: secondRef.url } : {}),
    ...(uncorrected ? { uncorrected } : {}), ...(correction ? { corrected: correction.applied } : {}), ...(note ? { note } : {}),
    // The product photo this was made from: a later re-shoot makes the generation out of date.
    // (Always the product's photo address — the same one the list compares with — even when the
    // bytes came from its hi-res upload copy.)
    sourceUrl: sourcePhoto.currentSourceUrl(item.pid, product, item),
    promptVersion: `${setupName(layersUsed)} (${prompt.version})`, layersUsed,
    box: kind === "footwear" ? { mode: boxMode, brand, source: boxSource } : null,
    draftFiles: kept, usage: gen.usage || null, measurements,
    trace: {
      promptText: prompt.text, inputs, layers: Object.fromEntries(layersUsed.map((k) => [k, true])),
      request: gen.request || null, usage: gen.usage || null, requestMs: gen.requestMs ?? null,
      thoughts: gen.thoughts ?? null, thoughtImages: gen.thoughtImages || 0, thoughtsUnsupported: gen.thoughtsUnsupported || null,
      draftFiles: kept, resolution: gm.width ? { width: gm.width, height: gm.height } : null,
      ...(gen.cutShort ? { streamCutShort: gen.cutShort } : {}), ...(finishNote ? { finishNote } : {}), ...(boxNote ? { boxNote } : {}),
      ...(correction ? { correction } : {}), ...(noDiagram ? { noLayoutDiagram: true } : {}), ...(fixText ? { qualityFix: { note: fixText } } : {}),
    },
  };
}

// ── THE ONE SHARED GENERATOR (Junid, 20 Nov 2026) ───────────────────────────
// EVERY in-app Generate (New Arrivals' newArrivalsStudio, Black Friday's bfGenerate) calls THIS function and
// nothing else: one model (generation.imageModel), one size (generation.imageSize), one finishing step
// (toMaster: the model's full resolution, JPEG q92). Footwear and clothing get the last-good New Arrivals
// request (generateOne, studio-2026-10-04.1); a kind with no New Arrivals plate (caps, perfume, bags …),
// named by the caller as `look`, gets its staging (staging.cjs) on Junid's same plates through the same
// model, size and finishing. functions/test/shared-generator.test.cjs fails if any path drifts from this.
export const SHARED_FINISH = "master-jpeg-q92";

/** One photo for one product, whatever the card. `look`: a staging kind (staging.cjs) for a product with no
 *  New Arrivals plate; omitted, the product's own category decides (footwear / clothing → generateOne). */
export async function generate({ item, product, genId, method = "full", provider = "gemini", look = null, input = "photo", placeNote = false, secondRef = null, deps, emit = () => {} }) {
  // THE STYLE KIT CATALOGUE (Junid, 20 Nov 2026): the kit for this product's catalogue category. A dedicated
  // kit with enabled reference photos (Caps, Perfumes, Bags, a sub-category …) drives the photo (generateKit);
  // a product that falls through to the house-style default keeps the request below, unchanged.
  let kit = null;
  if (deps.styleKitFor) {
    try { const k = await deps.styleKitFor(product || { categoryKey: item.categoryKey, name: item.name }, item.pid); if (k?.dedicated && k.refs?.length) kit = k; }
    catch (e) { deps.log?.(`the Style Kit could not be read (${String(e.message).slice(0, 80)}) — using the house look`); }
  }
  // THE GARMENT GATE (Junid, 21–22 Nov 2026): clothing is checked for finish as well as drift; see driftGuard.
  // (A product made through a staging `look` gets no garment finish, so it is never judged as a garment either.)
  // A kit in the clothing family (a category Junid re-routed there included) gets the finish, so it gets the check.
  const garment = kit ? (kit.promptFamily === "clothing" || isGarment(product || { categoryKey: item.categoryKey }))
    : isGarment(product || { categoryKey: item.categoryKey }) && !(look && staging.hasStaging(look));
  // (The retry's drafts get their own names: the first attempt's are already stored and Storage never overwrites.)
  const runAs = (inp, gid, fix = null) => (kit
    ? generateKit({ item, product, genId: gid, kit, input: inp, placeNote, secondRef, fix, garment, deps, emit })
    : look && staging.hasStaging(look)
      ? generateOther({ item, product, genId: gid, kind: look, input: inp, placeNote, deps, emit })
      : generateOne({ item, product, genId: gid, method, provider, input: inp, placeNote, secondRef, fix, deps, emit }));
  // THE ORIGINAL GIVEN BACK (Junid, 20 Nov 2026): when the model hands back the staff photo, the input is cleaned
  // — the product cut out of the staff photo (background removal) and put on plain white — and the SAME request
  // (prompt, plate, model, size) is made ONCE more with that cut-out in place of the raw photo. Never more than once.
  const attempt = async (gid, fix = null) => {
    try { return await runAs(input, gid, fix); }
    catch (e) {
      if (!e.echo || input === "cutout" || !deps.cutout) throw e;
      try { emit({ type: "status", text: "It gave back the original photo — cleaning the photo and trying once more…" }); } catch { /* view only */ }
      let res;
      try { res = await runAs("cutout", `${gid}-cutout`, fix); }
      catch (e2) {
        // No clean cut-out could be made: the first answer's refusal stands, and the card is told why.
        if (e2.noCutout) { e.cutoutFailed = true; throw e; }
        e2.wastedUsages = [e.usage || null, ...(e2.wastedUsages || [])]; throw e2;
      }
      return { ...res, echoFallback: { firstDiff: e.diff ?? null }, wastedUsages: [e.usage || null] };
    }
  };
  const startedMs = Date.now();
  const first = withKit(await attempt(genId), kit);
  // (Split places the product by code from Gemini's cut-out — nothing for the check to judge against a scene.)
  if (first?.method === "split") return first;
  return driftGuard({ first, again: async (fix) => withKit(await attempt(`${genId}-drift`, fix), kit), item, product, garment, deps, emit, startedMs,
    // The steam-and-press pass (a garment whose only fault is its finish): one more call over the photo just made.
    retouch: garment ? (res, raw) => pressGarment({ res, raw, item, deps, emit }) : null });
}

/** Stamp which Style Kit made the photo on its result (and so on the record). Pure. */
function withKit(res, kit) {
  return kit ? { ...res, styleKit: { kit: kit.kit, label: kit.label, refs: kit.refIds?.length ?? kit.refs.length } } : res;
}

// ── THE DRIFT GUARD (Junid, 20 Nov 2026) AND THE GARMENT GATE (21–22 Nov 2026) ─
// Every generated photo is compared with the ORIGINAL staff photo.
//   NOT A GARMENT — drifted (a different colour, logo, shape or product) → ONE more generation; drifted again →
//     the product cut out of its own photo, on white.
//   A GARMENT — the gate (crease score, flatness score, logos, colour, product, drawn lines, tilt). Failed → ONE
//     retry: the steam-and-press pass over the photo when its only fault is its finish (creased, flat), else the
//     photo made again told the fix. Failed again → THE BETTER OF THE TWO IS KEPT AND FLAGGED (Junid, 22 Nov 2026).
//     Never the cut-out: that is the creased garment itself, on white.
// A check that cannot run is never a fail; the guard can never lose a photo that was made.
export const DRIFT_NOTE = "The generated photo changed the product twice, so this is the product cut out of its own photo — tap Regenerate to try again.";
// The callables run for at most 540 s: a retry is only started while there is clearly time for it.
export const DRIFT_RETRY_BUDGET_MS = 240_000;
export const GARMENT_UNCHECKED_NOTE = "FLAGGED — the first photo failed the quality check and the second could not be checked. Check it by eye, or tap Regenerate.";
export async function driftGuard({ first, again, retouch = null, item, product, garment = false, deps, emit = () => {}, startedMs = Date.now(), clockMs = () => Date.now() }) {
  if (!deps.driftCheck || !first?.generated?.url) return first;
  const say = (text) => { try { emit({ type: "status", text }); } catch { /* view only */ } };
  let raw;
  try { raw = (await deps.fetchBytes(originalUrlOf(item, product))).buffer; } catch { return first; }
  const check = async (res) => {
    try { return await deps.driftCheck(raw, (await deps.fetchBytes(res.generated.url)).buffer, ...(garment ? [{ garment: true }] : [])); }
    catch (e) { return { checked: false, drift: false, issues: String(e.message || e).slice(0, 80) }; }
  };
  const tag = (d) => (d.checked ? (d.drift ? "drifted" : "same") : "unchecked");
  say(garment ? "Quality check: steamed and pressed, full shape, same logos and colour…" : "Checking the product against the original photo…");
  const d1 = await check(first);
  const faultsOf = (d) => (garment && Array.isArray(d.faults) ? { faults: d.faults } : {});
  // The gate's scores, kept on the record (0 = perfect, 10 = worst).
  const scoresOf = (d, pre = "") => { if (!garment || !Number.isFinite(d?.crease)) return {}; const k = (n) => (pre ? `${pre}${n[0].toUpperCase()}${n.slice(1)}` : n);
    return { [k("crease")]: d.crease, ...(Number.isFinite(d.carried) ? { [k("carried")]: d.carried } : {}), ...(Number.isFinite(d.flat) ? { [k("flat")]: d.flat } : {}) }; };
  if (!d1.drift) return { ...first, drift: { first: tag(d1), ...(garment ? { check: "garment", ...scoresOf(d1) } : {}) } };
  // A garment that is right in everything but its finish: the retry is the steam-and-press pass over this photo.
  const press = garment && !!retouch && finishOnly(d1.faults);
  deps.log?.(`the photo ${garment ? `failed the quality check [${(d1.faults || []).join(", ")}; crease ${d1.crease ?? "?"}, carried ${d1.carried ?? "?"}, flat ${d1.flat ?? "?"}]` : "drifted from the original"} (${d1.issues}) — ${press ? "steaming and pressing it" : "trying once more"}`);
  // The retry is told exactly what to fix.
  const fix = garment ? { note: garmentFixNote(d1.faults) } : null;
  // Every image paid for along the way, so the caller books all of them and nothing twice.
  const paid = [...(first.wastedUsages || []), first.usage || null];
  let second = null, retry = "skipped";
  if (clockMs() - startedMs < DRIFT_RETRY_BUDGET_MS) {
    say(press ? "It still looks creased — steaming and pressing the garment…" : garment ? "The photo failed the quality check — trying once more with the fix…" : "The product changed in the photo — trying once more…");
    try { second = press ? await retouch(first, raw) : await again(fix); retry = "made"; }
    catch (e) {
      // The retry failed outright: anything it was charged is still booked.
      paid.push(...(e.wastedUsages || []), ...(e.paid || e.echo ? [e.usage || null] : []));
      retry = "failed"; deps.log?.(`the ${press ? "steam-and-press pass" : "drift retry"} failed (${String(e.message).slice(0, 80)})`);
    }
  } else deps.log?.(garment ? "no time left for a retry — keeping the photo, flagged" : "no time left for a drift retry — using the cut-out");
  let d2 = null;
  if (second) {
    d2 = await check(second);
    // A retry the gate could NOT check has not passed: after a failed first photo it is kept, but flagged.
    if (!d2.drift && !(garment && !d2.checked)) {
      return { ...second, drift: { first: "drifted", issues: d1.issues || "", ...faultsOf(d1), ...scoresOf(d1), retry: tag(d2), ...(garment ? { check: "garment", how: press ? "pressed" : "remade", ...scoresOf(d2, "retry") } : {}) }, wastedUsages: [...paid, ...(second.wastedUsages || [])] };
    }
    d1.retryIssues = d2.issues || "";
    if (garment) d1.retryFaults = d2.faults || [];
    if (garment && !d2.checked) d1.retryUnchecked = true;
    paid.push(...(second.wastedUsages || []), second.usage || null);
  }
  const driftRec = { first: "drifted", issues: d1.issues || "", ...faultsOf(d1), ...scoresOf(d1), retry: second ? (d1.retryUnchecked ? "unchecked" : "drifted") : retry, ...(d1.retryIssues ? { retryIssues: d1.retryIssues } : {}),
    ...(d1.retryFaults ? { retryFaults: d1.retryFaults } : {}), ...(garment ? { check: "garment", ...(second ? { how: press ? "pressed" : "remade" } : {}), ...scoresOf(d2, "retry") } : {}) };
  // The LAST paid image is this result's own cost; the rest are wasted — the total booked is exactly what was paid.
  const ownUsage = paid.length ? paid[paid.length - 1] : null;
  const wastedUsages = paid.slice(0, -1);
  if (garment) {
    // KEEP THE BEST VERSION AND FLAG IT (Junid, 22 Nov 2026). Both photos are stored; the better one is the photo.
    const kept = second && betterGarment(d1, d2) === "retry" ? "retry" : "first";
    const keep = kept === "retry" ? second : first;
    const verdict = kept === "retry" ? d2 : d1;
    say("It did not pass the quality check twice — keeping the better photo, flagged…");
    const out = { ...keep, usage: ownUsage, wastedUsages, qcFlagged: true, note: kept === "retry" && d1.retryUnchecked ? GARMENT_UNCHECKED_NOTE : garmentFlagNote(verdict), drift: { ...driftRec, kept, flagged: true } };
    const other = kept === "retry" ? first : second;
    if (other?.generated?.url) out.qcOther = { url: other.generated.url, path: other.generated.path || null };
    return out;
  }
  const base = second || first;
  say("It changed the product again — using the product cut out of its own photo…");
  try {
    const up = await cutoutResult({ raw, item, deps });
    const out = { ...base, generated: up, usage: ownUsage, driftFallback: "cutout", note: DRIFT_NOTE, draftFiles: [], drift: driftRec, wastedUsages };
    delete out.uncorrected; delete out.corrected; // the cut-out is not a corrected generation
    return out;
  } catch (e) {
    // No clean cut-out: keep the generated photo (it was paid for) and say plainly that it drifted.
    deps.log?.(`no cut-out for the drift fallback (${String(e.message).slice(0, 80)})`);
    return { ...base, usage: ownUsage, drift: { ...driftRec, fallback: "no-cutout" }, wastedUsages,
      note: "The check says this photo may not match the real product (colour, logo or shape) and no clean cut-out could be made — check it by eye." };
  }
}

/** Was this result judged by the garment gate at all (a product that is not a garment never is)? Pure. */
export const garmentGated = (res) => !!res?.drift && res.drift.check === "garment";

/** Did this result pass the garment gate (checked, and "same" on the first try or on the retry)? Pure. */
export function passedGarmentGate(res) {
  const d = res?.drift;
  if (!d || d.check !== "garment" || res.qcFlagged) return false;
  return d.first === "same" || (d.first === "drifted" && d.retry === "same");
}

// ── THE STEAM-AND-PRESS PASS (Junid, 22 Nov 2026) ───────────────────────────
// The gate's retry for a garment photo that is right in everything but its finish. ONE more image call, through
// the same model, size and finishing step as the photo itself: it is handed the finished photo and the staff
// photo and one job (lib/style-kit-catalogue.mjs GARMENT_RETOUCH). The gate judges the result like any other photo.
export async function pressGarment({ res, raw, item, deps, emit = () => {} }) {
  const say = (ev) => { try { emit(ev); } catch { /* the card's view never affects the generation */ } };
  const { generation } = deps;
  const photo = (await deps.fetchBytes(res.generated.url)).buffer;
  const m = await sharp(photo).metadata();
  if (!m.width || !m.height) throw new Error("the photo to steam could not be read");
  const parts = [
    textPart([GARMENT_RETOUCH, deps.conditionClause].filter(Boolean).join("\n\n")),
    textPart("IMAGE 1 — the photograph to retouch:"), imagePart(await forModel(photo)),
    textPart("IMAGE 2 — the real garment (details only):"), imagePart(await forModel(raw)),
  ];
  const imageConfig = { aspectRatio: closestAspect(m.width, m.height), imageSize: generation.imageSize };
  say({ type: "status", text: "Steaming and pressing the garment…" });
  const gen = await deps.image(generation.imageModel, parts, imageConfig, { onEvent: (ev) => { if (ev && ev.type === "thought" && ev.text) say({ type: "thought", text: ev.text }); } });
  let generated, gm = {};
  try {
    gm = await sharp(gen.buffer).metadata().catch(() => ({}));
    if (!gm.width || !gm.height) throw new Error("the image model's answer was not a readable image");
    // THE ONE FINISHING STEP: full resolution, JPEG q92, cropped (never stretched) to the photo's own frame.
    const out = await toMaster(gen.buffer, { width: m.width, height: m.height });
    generated = await withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${deps.now()}.jpg`, out, "image/jpeg"));
  } catch (e) { e.paid = true; e.usage = gen.usage || null; throw e; }
  const out = { ...res, generated, usage: gen.usage || null, wastedUsages: [], draftFiles: [], pressed: true, measurements: null,
    // The record describes THIS call (the one that made the stored photo); the composing call it started from is kept under `composed`.
    trace: { ...(res.trace || {}), promptText: GARMENT_RETOUCH, request: gen.request || null, usage: gen.usage || null, requestMs: gen.requestMs ?? null, thoughts: gen.thoughts ?? null,
      resolution: { width: gm.width, height: gm.height }, draftFiles: [],
      press: { from: res.generated.path || res.generated.url },
      composed: { promptText: res.trace?.promptText || null, request: res.trace?.request || null, usage: res.trace?.usage || null, requestMs: res.trace?.requestMs ?? null, resolution: res.trace?.resolution || null } } };
  delete out.uncorrected; delete out.corrected;
  return out;
}

/** The product cut out of the staff photo, on white, at full resolution — stored like any generated photo. */
async function cutoutResult({ raw, item, deps }) {
  if (!deps.cutout) throw new Error("no cut-out tool");
  const c = await deps.cutout(raw);
  if (!c?.png) throw new Error("the product could not be cut out cleanly");
  const solid = await cleanCutout(c.png);
  const m = await sharp(solid).metadata();
  const pad = Math.round(Math.max(m.width, m.height) * 0.08);
  const out = await sharp(solid).flatten({ background: "#ffffff" }).extend({ top: pad, bottom: pad, left: pad, right: pad, background: "#ffffff" })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
  return withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${deps.now()}.jpg`, out, "image/jpeg"));
}

/**
 * A product whose catalogue category has its OWN Style Kit (Caps, Perfumes, Bags, Sunglasses, a sub-category …):
 * one image call with the kit's locked prompt, the real product photo (and its box, outside clothing) and the
 * kit's first 6 enabled reference photos — the references set scene, angle, lighting and framing only. Same
 * model, size and finishing (toMaster: full resolution, JPEG q92) as every other shared generation.
 */
export const KIT_REFS_LABEL = "STYLE REFERENCES — copy ONLY the scene, backdrop, camera angle, lighting and framing from these. The products in them are DIFFERENT items: never copy their design, colour, logo or shape. The product in the result comes only from the PRODUCT photo above:";
export async function generateKit({ item, product, genId, kit, input = "photo", placeNote = false, secondRef = null, fix = null, garment = false, deps, emit = () => {} }) {
  const say = (ev) => { try { emit(ev); } catch { /* the card's view never affects the generation */ } };
  const { generation } = deps;
  const model = generation.imageModel;
  const originalUrl = originalUrlOf(item, product);
  if (!originalUrl) throw new StudioRefusal("the product has no photo to work from");
  say({ type: "status", text: `Reading the original photo… (Style Kit: ${kit.label})` });
  const { raw, orig } = await sourceFor({ deps, originalUrl, input, say });
  let box = null;
  if (kit.promptFamily !== "clothing" && product?.photoBoxUrl) {
    try { box = await forModel((await withRetries(() => deps.fetchBytes(product.photoBoxUrl), { tries: 2 })).buffer); }
    catch (e) { deps.log?.(`its own box photo could not be read (${String(e.message).slice(0, 80)})`); }
  }
  const refsJ = await Promise.all(kit.refs.map((b) => forModel(b)));
  const ref2 = await secondRefFor({ deps, secondRef }); // a clean catalogue photo of THIS item, for detail only
  const name = product?.name || item.name || "";
  // A garment (Junid, 21 Nov 2026) gets the garment finish after the kit's prompt, and a retry its fix — before the
  // condition clause, which still overrides everything.
  const garmentKit = garment || kit.promptFamily === "clothing";
  const promptText = [kit.prompt, name ? `The product is: ${name}.` : "", garmentKit ? GARMENT_FINISH : "", fix?.note || "", deps.conditionClause].filter(Boolean).join("\n\n");
  const parts = [
    textPart(promptText),
    ...(placeNote ? [textPart("The PRODUCT photo below is a cut-out on plain white, NOT a finished photo: place this exact item in the reference scene.")] : []),
    textPart("PRODUCT — the real item to photograph:"), imagePart(orig),
    ...(ref2 ? [textPart(SECOND_REF_LABEL), imagePart(ref2)] : []),
    ...(box ? [textPart("PRODUCT'S BOX — reproduce this exact box:"), imagePart(box)] : []),
    textPart(KIT_REFS_LABEL), ...refsJ.map((r) => imagePart(r)),
  ];
  const rm = await sharp(kit.refs[0]).metadata().catch(() => ({}));
  const frame = rm.width && rm.height ? { width: rm.width, height: rm.height } : { width: 1, height: 1 };
  const imageConfig = { aspectRatio: closestAspect(frame.width, frame.height), imageSize: generation.imageSize };
  say({ type: "status", text: "Gemini is working…" });
  const gen = await deps.image(model, parts, imageConfig, { onEvent: (ev) => { if (ev && ev.type === "thought" && ev.text) say({ type: "thought", text: ev.text }); } });
  await refuseEcho({ out: gen.buffer, raw, sent: orig, plate: null, usage: gen.usage });
  say({ type: "status", text: "Finishing the photo…" });
  let generated, gm = {};
  try {
    gm = await sharp(gen.buffer).metadata().catch(() => ({}));
    if (!gm.width || !gm.height) throw new Error("the image model's answer was not a readable image");
    // THE ONE FINISHING STEP: full resolution, JPEG q92, cropped (never stretched) to the asked frame.
    const out = await toMaster(gen.buffer, { width: RATIOS[imageConfig.aspectRatio] * 1000, height: 1000 });
    const stamp = deps.now();
    generated = await withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${stamp}.jpg`, out, "image/jpeg"));
  } catch (e) { e.paid = true; e.usage = gen.usage || null; throw e; }
  return {
    generated, kind: `kit-${kit.kit}`, method: "full", provider: "gemini", model, input,
    sourceUrl: sourcePhoto.currentSourceUrl(item.pid, product, item),
    promptVersion: `stylekit-${kit.kit}`, layersUsed: [], box: box ? { mode: "own", brand: null, source: "own" } : null, draftFiles: [], usage: gen.usage || null, measurements: null,
    trace: { promptText, request: gen.request || null, usage: gen.usage || null, requestMs: gen.requestMs ?? null, resolution: gm.width ? { width: gm.width, height: gm.height } : null, styleKit: { kit: kit.kit, refIds: kit.refIds || [] } },
  };
}

// ── THE CLEANED INPUT AND THE ECHO CHECK (20 Nov 2026) ──────────────────────
export const PLACE_NOTE = "PLACE IT ON THE BACKDROP: the GARMENT PHOTO below is a cut-out on plain white, NOT a finished photo. Hang this exact garment on the fence of the BACKGROUND PLATE as the brief above says — the result is the plate with the garment on it, never the cut-out on white and never the photo it was cut from.";
export const NO_DIAGRAM_NOTE = "NO LAYOUT DIAGRAM is sent for a garment: place it by the PLACEMENT percentages above alone. The result holds only the BACKGROUND PLATE and the garment — never a rectangle, frame, border, box, dashed or guide line, or any text.";
export const SECOND_REF_LABEL = "SECOND REFERENCE — a clean catalogue photo of this exact item (the same club, season and colourway). Use it ONLY to read detail the GARMENT PHOTO shows unclearly (badges, sponsor, trims); the result must be the item in the GARMENT PHOTO — never a different version:";
export const ECHO_DIFF = 12;        // 64x64 grey mean difference: under this, the output is the input picture
export const PLATE_EDGE_DIFF = 12;  // the backdrop either side this close to the plate: it IS on the plate, never an echo

/** Mean absolute difference (0-255) of two photos at 64x64 greyscale; `edges`: the left and right eighths only. */
export async function picDiff(a, b, { edges = false } = {}) {
  const g = (x) => sharp(x).rotate().resize(64, 64, { fit: "fill" }).greyscale().raw().toBuffer();
  const [x, y] = await Promise.all([g(a), g(b)]);
  let t = 0, n = 0;
  for (let i = 0; i < x.length; i++) { const c = i % 64; if (edges && c >= 8 && c < 56) continue; t += Math.abs(x[i] - y[i]); n++; }
  return t / n;
}

/** Throws { echo } when `out` is the photo that was sent (or the staff photo) and does not carry the plate. */
export async function refuseEcho({ out, raw, sent, plate, usage }) {
  let d = null;
  try { d = Math.min(await picDiff(out, raw), sent ? await picDiff(out, sent) : Infinity); } catch { return; }
  if (!(d < ECHO_DIFF)) return;
  if (plate?.buffer) {
    let pe = null;
    try { pe = await picDiff(out, plate.buffer, { edges: true }); } catch { pe = null; }
    if (pe !== null && pe <= PLATE_EDGE_DIFF) return;
  }
  const err = new Error(`the model returned the original photo (difference ${d.toFixed(1)})`);
  err.echo = true; err.diff = d; err.usage = usage || null;
  throw err;
}

/** The product photo to send: the staff photo, or (input "cutout") the product cut out of it on plain white. */
export async function sourceFor({ deps, originalUrl, input, say = () => {} }) {
  const raw = (await deps.fetchBytes(originalUrl)).buffer;
  if (input !== "cutout") return { raw, orig: await forModel(raw) };
  say({ type: "status", text: "Cutting the product out of the photo…" });
  const c = deps.cutout ? await deps.cutout(raw).catch(() => null) : null;
  if (!c?.png) { const e = new StudioRefusal("the product could not be cut out of its photo cleanly"); e.noCutout = true; throw e; }
  const solid = await cleanCutout(c.png);
  const m = await sharp(solid).metadata();
  const pad = Math.round(Math.max(m.width, m.height) * 0.06);
  const white = await sharp(solid).flatten({ background: "#ffffff" }).extend({ top: pad, bottom: pad, left: pad, right: pad, background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
  return { raw, orig: await forModel(white), cutout: true };
}

/**
 * A background-removal matte made fit to send (measured 20 Nov on the Ajax, Tottenham and Real Madrid jerseys):
 *  · the TAIL: the rows below the lowest solid row (mean alpha 97%+), when they are 4%–20% of the height
 *    and only partly opaque on average (under 90%) — the display fence showing under a hem — are cut away;
 *  · semi-transparent product areas (a white shirt's pale panel) are lifted back to solid (alpha × 3);
 *  · holes the background cannot reach from the edges are filled.
 * The product's own pixels are kept everywhere it is. → PNG with alpha.
 */
export async function cleanCutout(png, { lift = 3, floor = 0.06 } = {}) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, N = w * h;
  const rowMean = (y) => { let l = -1, r = -1; for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 40) { if (l < 0) l = x; r = x; } if (l < 0) return null; let t = 0; for (let x = l; x <= r; x++) t += data[(y * w + x) * 4 + 3]; return t / (r - l + 1) / 2.55; };
  const means = Array.from({ length: h }, (_, yy) => rowMean(yy));
  let cut = h, y = h - 1;
  while (y >= 0 && !(means[y] >= 97)) y--; // the lowest solid row
  if (y >= 0 && h - 1 - y >= 0.04 * h && h - 1 - y <= 0.2 * h) {
    const tail = means.slice(y + 1).filter((m) => m !== null);
    if (tail.length && tail.reduce((t, m) => t + m, 0) / tail.length < 90) cut = y + 1;
  }
  const a = new Float32Array(N);
  for (let i = 0; i < N; i++) a[i] = i >= cut * w ? 0 : Math.min(1, (data[i * 4 + 3] / 255) * lift);
  const bg = new Uint8Array(N), st = new Int32Array(N); let sp = 0;
  const push = (i) => { if (!bg[i] && a[i] < floor) { bg[i] = 1; st[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let yy = 0; yy < h; yy++) { push(yy * w); push(yy * w + w - 1); }
  while (sp) { const i = st[--sp], x = i % w; if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (i >= w) push(i - w); if (i < N - w) push(i + w); }
  const out = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    out[i * 4] = data[i * 4]; out[i * 4 + 1] = data[i * 4 + 1]; out[i * 4 + 2] = data[i * 4 + 2];
    out[i * 4 + 3] = bg[i] ? 0 : Math.round((a[i] < floor ? 1 : a[i]) * 255);
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).trim({ threshold: 1 }).png().toBuffer().catch(() => sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer());
}

async function secondRefFor({ deps, secondRef }) {
  if (!secondRef?.url) return null;
  return forModel((await deps.fetchBytes(secondRef.url)).buffer);
}

/**
 * A kind with no New Arrivals plate: one image call with Junid's plate, the product photo (and, for perfume,
 * its box). deps as for generateOne, plus loadPlateFile(file) → { buffer, width, height, file, forModel }.
 */
export async function generateOther({ item, product, genId, kind, input = "photo", placeNote = false, deps, emit = () => {} }) {
  const say = (ev) => { try { emit(ev); } catch { /* the card's view never affects the generation */ } };
  const { generation } = deps;
  const model = generation.imageModel;
  const st = staging.stagingFor(kind);
  const originalUrl = originalUrlOf(item, product);
  if (!originalUrl) throw new StudioRefusal("the product has no photo to work from");
  const plate = await deps.loadPlateFile(st.plate);
  say({ type: "status", text: "Reading the original photo…" });
  const { raw, orig } = await sourceFor({ deps, originalUrl, input, say });
  let box = null;
  if (kind === "perfume" && product?.photoBoxUrl) { try { box = await forModel((await deps.fetchBytes(product.photoBoxUrl)).buffer); } catch { box = null; } }
  const promptText = staging.promptFor(kind, { hasBox: !!box, conditionClause: deps.conditionClause });
  const plateJ = plate.forModel || await forModel(plate.buffer);
  const parts = [textPart(promptText), imagePart(plateJ), ...(placeNote ? [textPart(PLACE_NOTE)] : []), imagePart(orig), ...(box ? [imagePart(box)] : [])];
  const imageConfig = { aspectRatio: closestAspect(plate.width, plate.height), imageSize: generation.imageSize };
  say({ type: "status", text: "Gemini is working…" });
  const gen = await deps.image(model, parts, imageConfig, { onEvent: (ev) => { if (ev && ev.type === "thought" && ev.text) say({ type: "thought", text: ev.text }); } });
  await refuseEcho({ out: gen.buffer, raw, sent: orig, plate, usage: gen.usage });
  say({ type: "status", text: "Finishing the photo…" });
  let generated, gm = {};
  try {
    gm = await sharp(gen.buffer).metadata().catch(() => ({}));
    if (!gm.width || !gm.height) throw new Error("the image model's answer was not a readable image");
    const out = await toMaster(gen.buffer, plate);
    const stamp = deps.now();
    generated = await withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${stamp}.jpg`, out, "image/jpeg"));
  } catch (e) { e.paid = true; e.usage = gen.usage || null; throw e; }
  return {
    generated, kind, look: kind, plateFile: st.plate, method: "full", provider: "gemini", model, input,
    sourceUrl: sourcePhoto.currentSourceUrl(item.pid, product, item),
    promptVersion: `staging-${kind}`, layersUsed: [], box: null, draftFiles: [], usage: gen.usage || null, measurements: null,
    trace: { promptText, request: gen.request || null, usage: gen.usage || null, requestMs: gen.requestMs ?? null, resolution: gm.width ? { width: gm.width, height: gm.height } : null },
  };
}

// Where the product is expected (fractions of the canvas): the layout's own box.
export function expectedBox(kind, spec, placedShoe = null) {
  // A corrected shoe is measured exactly where code put it; otherwise where a typical shoe would stand
  // (guideTopY — the layout's own topY is G-0102's low slide).
  if (kind === "footwear" && placedShoe) return { left: placedShoe.left, right: placedShoe.right, top: placedShoe.top, bottom: placedShoe.bottom };
  if (kind === "footwear" && spec?.shoe) return { left: spec.shoe.heelX, right: spec.shoe.toeX, top: spec.shoe.guideTopY ?? spec.shoe.topY, bottom: spec.shoe.soleY };
  if (spec?.garment) return { left: spec.garment.left, right: spec.garment.right, top: spec.garment.topY, bottom: spec.garment.hemY };
  return null;
}
// The staff photo is not measured for position: its middle is taken as the product.
export const SOURCE_BOX = Object.freeze({ left: 0.15, right: 0.85, top: 0.15, bottom: 0.85 });

/** Run fn up to `tries` times, a little longer apart each time; the last error is thrown. */
export async function withRetries(fn, { tries = 3, waitMs = 400, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { last = e; if (i < tries - 1) await sleep(waitMs * (i + 1)); }
  }
  throw last;
}

/** Store one interim draft beside the generation and show it on the card. Never throws. */
export async function keepDraft({ deps, pid, genId, n, draft, draftFiles, say }) {
  try {
    const up = await deps.upload(`products/${pid}/new_arrivals/${genId}-draft-${n}.jpg`, await draftJpeg(Buffer.from(draft.data, "base64")), "image/jpeg");
    if (!up?.url) return;
    draftFiles.push({ n, url: up.url, path: up.path || null, data: draft.data });
    say({ type: "draft", n, url: up.url });
  } catch { /* a draft is never a reason to lose the paid photo */ }
}
