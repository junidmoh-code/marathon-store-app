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

/** The ORIGINAL to generate from — never a generated photo. Pure. */
export function originalUrlOf(item, product) {
  return (sourceFresh(product) && product.photoSourceUrl) || item?.originalUrl || product?.photoUrlOriginal || product?.photoUrl || null;
}

/** A plain-words refusal: nothing was generated, nothing was paid. */
export class StudioRefusal extends Error {
  constructor(message) { super(message); this.studioRefusal = true; }
}

const draftJpeg = (buf) => sharp(buf).rotate().resize(1280, 1280, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();

/**
 * deps: {
 *   fetchBytes(url) → { buffer }, loadPlate(kind), loadReference(kind) → { buffer, width, height, file } | null,
 *   libraryBox(brandKey) → { buffer, kind } | null, spec, generation ({ imageModel, imageSize, layers }),
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
  let box = null, boxMode = "none", boxSource = null, boxFrom = null, boxNote = null;
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
    if (!box && layers.footwearBox && deps.libraryBox) {
      const lib = await deps.libraryBox(brand).catch(() => null);
      if (lib?.buffer) { box = await forModel(lib.buffer); boxMode = "library"; boxSource = lib.kind || "library"; boxFrom = { file: `brand library box (${brand}, ${lib.kind || "?"})` }; }
    }
  }

  if (method === "split") {
    if (!deps.split) throw new StudioRefusal("the split method is not installed");
    return deps.split({ item, product, genId, kind, categoryKey, orig, originalUrl, box, boxMode, boxSource, boxFrom, brand, deps, say });
  }

  const plate = await deps.loadPlate(kind), ref = await deps.loadReference(kind);
  const spec = deps.spec?.[kind];
  if (!spec) throw new Error(`no layout spec for ${kind}`);
  // With no box, the box leaves the spec too: nothing is placed on the rail.
  const effSpec = kind === "footwear" && boxMode === "none" && !layers.footwearBox ? { ...spec, box: undefined } : spec;
  const prompt = studioPrompt({ kind, categoryKey, productName: product?.name || item.name, conditionClause: deps.conditionClause,
    placement: placementText(kind, effSpec), layers, boxMode });
  const plateJ = plate.forModel || await forModel(plate.buffer);
  const refJ = ref ? (ref.forModel || await forModel(ref.buffer)) : null;
  const aspect = closestAspect(plate.width, plate.height);
  const frame = genFrameOf(plate.width, plate.height, RATIOS[aspect]);
  const guideJ = await forModel(await layoutGuideImage(kind, effSpec, plate.buffer, frame));

  const inputs = await Promise.all([
    inputOf("plate", plateJ, { file: plate.file || null }),
    ...(refJ ? [inputOf("reference", refJ, { file: ref.file || null })] : []),
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
  let generated, gm = {}, finishNote = null;
  try {
    gm = await sharp(gen.buffer).metadata().catch(() => ({}));
    let out, mime = "image/jpeg";
    try { out = await toCanvas(gen.buffer, plate); }
    catch (e) { out = gen.buffer; mime = gen.mime || "image/png"; finishNote = `kept as Gemini made it — the finishing step failed (${String(e.message).slice(0, 80)})`; }
    generated = await withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${deps.now()}.${mime === "image/jpeg" ? "jpg" : "png"}`, out, mime));
  } catch (e) {
    // The caller still counts what Gemini charged for it.
    e.paid = true;
    e.usage = gen.usage || null;
    throw e;
  }
  // The final image is never also listed as a draft.
  const finalData = gen.buffer.toString("base64");
  const kept = draftFiles.filter((d) => d.data !== finalData).sort((a, b) => a.n - b.n).map(({ url, path }) => ({ url, path }));
  return {
    generated, kind, method: "full",
    promptVersion: `${setupName(prompt.layers)} (${prompt.version})`, layersUsed: prompt.layers,
    box: kind === "footwear" ? { mode: boxMode, brand, source: boxSource } : null,
    draftFiles: kept, usage: gen.usage || null,
    trace: {
      promptText: prompt.text, inputs, layers: Object.fromEntries(prompt.layers.map((k) => [k, true])),
      request: gen.request || null, usage: gen.usage || null, requestMs: gen.requestMs ?? null,
      thoughts: gen.thoughts ?? null, thoughtImages: gen.thoughtImages || 0, thoughtsUnsupported: gen.thoughtsUnsupported || null,
      draftFiles: kept, resolution: gm.width ? { width: gm.width, height: gm.height } : null,
      ...(gen.cutShort ? { streamCutShort: gen.cutShort } : {}), ...(finishNote ? { finishNote } : {}), ...(boxNote ? { boxNote } : {}),
    },
  };
}

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
