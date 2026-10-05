// ── ONE GENERATION, START TO FINISH ─────────────────────────────────────────
// Junid taps Generate; this makes ONE photo from the ORIGINAL staff photo —
// never from an earlier generation — and reports what Gemini is doing while it
// works. No source check, no checker, no measuring call, no retry: the only
// Gemini call is the image call (EVERYTHING IS MANUAL, 4 Oct).
//
// Every side effect is injected (deps), so the whole path runs in tests with
// no network, no Storage and no key.
import sharp from "sharp";
import {
  kindFor, UNKNOWN_FRAMING, brandKey, placementText, layoutGuideImage, genFrameOf,
  RATIOS, closestAspect, toCanvas, forModel, inputOf,
} from "./compose.mjs";
import { studioPrompt, setupName } from "./prompt.mjs";
import { imagePart, textPart } from "./gemini-stream.mjs";
import { objectiveMeasurements } from "./measure.mjs";
import { correctFootwear } from "./correct.mjs";
import sourcePhoto from "../sourcePhoto.cjs";

export const METHODS = Object.freeze(["full", "split"]);

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
export async function generateOne({ item, product, genId, method = "full", deps, emit = () => {} }) {
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
  const orig = await forModel((await deps.fetchBytes(originalUrl)).buffer);

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
    return deps.split({ item, product, genId, kind, categoryKey, orig, originalUrl, box, boxMode, boxSource, boxFrom, brand, libraryBoxPng, deps, say });
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
  const aspect = closestAspect(plate.width, plate.height);
  const frame = genFrameOf(plate.width, plate.height, RATIOS[aspect]);
  const guideJ = await forModel(await layoutGuideImage(kind, effSpec, plate.buffer, frame));

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
    inputOf("layoutDiagram", guideJ, { file: "drawn from config/layout-spec.json" }),
    inputOf("source", orig, { url: originalUrl }),
    ...(box ? [inputOf("box", box, boxFrom || {})] : []),
  ]);
  // THE 2 OCT BASELINE REQUEST, exactly: the prompt, plate, reference, layout
  // diagram, then the product photo (and box).
  const parts = [
    textPart(prompt.text),
    textPart("BACKGROUND PLATE — use exactly:"), imagePart(plateJ),
    ...(refJ ? [textPart("REFERENCE — the target composition and look:"), imagePart(refJ)] : []),
    ...(examples.length ? [textPart(EXAMPLES_LABEL), ...examples.map((e) => imagePart(e.forModel))] : []),
    textPart("LAYOUT DIAGRAM — NOT part of the photo: the dashed box(es) on this grey diagram show where and how large the product goes on the canvas. Never draw boxes, outlines, labels or grey into the result. FIDELITY COMES FIRST: never change the product in any way to make it fit the box — only move it and scale it uniformly:"), imagePart(guideJ),
    textPart(kind === "footwear" ? "SHOE PHOTO — the real shoe:" : "GARMENT PHOTO — the real garment(s):"), imagePart(orig),
    ...(box ? [textPart(boxMode === "own" ? "BOX PHOTO — this shoe's own box:" : "BOX PHOTO — a box of this shoe's brand:"), imagePart(box)] : []),
  ];
  const imageConfig = { aspectRatio: aspect, imageSize: generation.imageSize };

  say({ type: "status", text: "Gemini is working…" });
  const draftFiles = [];
  const draftJobs = [];
  const gen = await deps.image(generation.imageModel, parts, imageConfig, {
    onEvent: (ev) => {
      if (ev.type === "thought") say({ type: "thought", text: ev.text });
      // A draft is shown as soon as it is stored; a failed upload never costs the photo.
      if (ev.type === "draft") draftJobs.push(keepDraft({ deps, pid: item.pid, genId, n: ev.n, draft: ev.draft, draftFiles, say }));
    },
  });
  await Promise.all(draftJobs);

  // ── THE PHOTO IS PAID FOR. From here nothing may lose it: every step is
  // retried, and if the finishing step itself fails the photo is kept exactly
  // as Gemini made it. A failure below is marked `paid` for the caller.
  say({ type: "status", text: "Finishing the photo…" });
  let generated, gm = {}, finishNote = null, measured = gen.buffer, uncorrected = null, correction = null, note = null, placedSpec = null;
  try {
    gm = await sharp(gen.buffer).metadata().catch(() => ({}));
    let out, mime = "image/jpeg";
    try { out = await toCanvas(gen.buffer, plate); }
    catch (e) { out = gen.buffer; mime = gen.mime || "image/png"; finishNote = `kept as Gemini made it — the finishing step failed (${String(e.message).slice(0, 80)})`; }
    measured = out;
    const stamp = deps.now();
    // (A footwear photo the finishing step could not even resize is kept as Gemini made it — and the card says so.)
    if (kind === "footwear" && generation.footwearCorrection && finishNote) {
      correction = { applied: false, problem: "the finishing step failed" };
      note = "Not placed on your backdrop — the finishing step failed. The photo shown is Gemini's own, so its pedestal and background are not your fixed plate; tap Regenerate to try again.";
    }
    // THE PLATE LOCK (footwear): everything but the shoe and its box comes from the ONE fixed plate. The shoe
    // and box are lifted out of Gemini's photo, scaled uniformly to the measured layout and placed on the
    // untouched plate; Gemini's pedestal and background are discarded. If they cannot be lifted, Gemini's
    // photo is kept and the card says so. The correction can never cost the paid photo.
    if (kind === "footwear" && generation.footwearCorrection && !finishNote) {
      say({ type: "status", text: "Placing it on your backdrop…" });
      let fixed = null;
      try { fixed = await (deps.correct || correctFootwear)({ photoBuf: gen.buffer, plate, spec }); }
      catch (e) { fixed = { problem: `the correction step failed (${String(e.message || e).slice(0, 80)})` }; }
      if (fixed?.buffer) {
        // Gemini's own photo is kept beside it, as a thumbnail on the card and on the record.
        try { const u = await withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${stamp}-uncorrected.jpg`, out, "image/jpeg")); uncorrected = { url: u.url, path: u.path || null }; }
        catch { /* the corrected photo is still shown; the record says the thumbnail is missing */ }
        out = fixed.buffer; measured = out;
        if (fixed.fittedSpec) placedSpec = fixed.fittedSpec;
        correction = { applied: true, ...(uncorrected ? {} : { thumbnailMissing: true }), version: fixed.version, how: fixed.how, found: fixed.found, placed: fixed.placed, deviations: fixed.deviations || null, ...(fixed.fitted ? { fitted: fixed.fitted } : {}) };
        // Gemini was given a box but none could be found in its photo: the corrected photo has no box — said, never silent.
        if (boxMode !== "none" && !fixed.placed?.box) {
          correction.boxMissing = true;
          note = "The box could not be found in Gemini's photo, so this photo has none. Gemini's own photo is the small one below; tap Regenerate to try again.";
        }
      } else {
        const why = fixed?.problem || "the correction gave no photo";
        correction = { applied: false, problem: why };
        note = `Not placed on your backdrop — ${why}. The photo shown is Gemini's own, so its pedestal and background are not your fixed plate; tap Regenerate to try again.`;
      }
    }
    try {
      generated = await withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${stamp}.${mime === "image/jpeg" ? "jpg" : "png"}`, out, mime));
    } catch (e) {
      // The corrected photo could not be stored, but Gemini's own already was: that one is shown, and it is said.
      if (!uncorrected) throw e;
      generated = uncorrected; uncorrected = null; measured = gen.buffer; placedSpec = null;
      correction = { applied: false, problem: "the corrected photo could not be stored" };
      note = "Not placed on your backdrop — the corrected photo could not be stored. The photo shown is Gemini's own, so its pedestal and background are not your fixed plate; tap Regenerate to try again.";
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
    generated, kind, method: "full",
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
      ...(correction ? { correction } : {}),
    },
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
