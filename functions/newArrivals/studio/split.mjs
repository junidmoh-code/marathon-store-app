// ── THE SPLIT METHOD ────────────────────────────────────────────────────────
// "Gemini gets the PRODUCT right and the placement and background wrong."
// So here Gemini makes the PRODUCT ONLY — steamed / studio-lit, on plain light
// grey (split-prompts.mjs, its own locked prompt) — and code does the rest:
// cuts it out, places it on Junid's real plate at the measured layout, and
// adds a soft shadow. The plate is never redrawn, so the fence, rails and
// pedestal are pixel-for-pixel Junid's photo.
//
// ONE Gemini call, as always. From the moment it answers the image is paid
// for: if the cut-out or the placement cannot be done, Gemini's own photo is
// kept as the generation and the card says so — never a throw, never a retry.
import sharp from "sharp";
import { productOnlyPrompt, SPLIT_ASPECT, SPLIT_PROMPT_VERSION } from "./split-prompts.mjs";
import { cutOut, toeDirection, CUTOUT_METHOD } from "./cutout.mjs";
import { classifyFootwear, composeOnPlate, unionPieces, trimPng, fitShoe } from "./place.mjs";
export { fitShoe };
import { inputOf } from "./compose.mjs";
import { imagePart, textPart } from "./gemini-stream.mjs";
import { withRetries, keepDraft, expectedBox, SOURCE_BOX } from "./studio.mjs";
import { objectiveMeasurements } from "./measure.mjs";
import sourcePhoto from "../sourcePhoto.cjs";

// A cut-out that keeps almost nothing, or almost everything, did not find the
// product's edge (a pale-grey product on the grey, or a background that was
// not plain): the placement is not attempted.
export const COVERAGE_MIN = 0.04;
export const COVERAGE_MAX = 0.9;

/** Why this cut-out cannot be placed, or null. Pure. */
export function cutProblem(cut) {
  if (!cut.pieces.length) return "the product could not be told apart from the grey background";
  if (cut.coverage < COVERAGE_MIN) return "almost nothing was left after removing the grey background";
  if (cut.coverage > COVERAGE_MAX) return "the grey background could not be removed (the product is too close to it in colour)";
  return null;
}

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * ctx: what generateOne prepared — { item, product, genId, kind, categoryKey, orig, originalUrl, box, boxMode,
 *       boxSource, boxFrom, brand, libraryBoxPng (the brand's cut-out box, or null), deps, say }
 * → the same shape generateOne returns for the full method, with method "split".
 */
export async function splitGenerate(ctx) {
  const { item, product, genId, kind, orig, originalUrl, box, boxMode, boxFrom, brand, deps, say } = ctx;
  const { generation } = deps;
  const plate = await deps.loadPlate(kind);
  const spec = deps.spec?.[kind];
  if (!spec) throw new Error(`no layout spec for ${kind}`);
  const prompt = productOnlyPrompt({ kind, productName: product?.name || item.name, conditionClause: deps.conditionClause });
  // Only the shoe's OWN box photo is shown to Gemini; a brand-library box is
  // already a clean cut-out and is placed by code, never redrawn.
  const ownBox = boxMode === "own" ? box : null;
  const parts = [
    textPart(prompt),
    textPart(kind === "footwear" ? "SHOE PHOTO — the real shoe:" : "GARMENT PHOTO — the real garment(s):"), imagePart(orig),
    ...(ownBox ? [textPart("BOX PHOTO — this shoe's own box:"), imagePart(ownBox)] : []),
  ];
  const inputs = await Promise.all([inputOf("source", orig, { url: originalUrl }), ...(ownBox ? [inputOf("box", ownBox, boxFrom || {})] : [])]);
  const imageConfig = { aspectRatio: SPLIT_ASPECT[kind], imageSize: generation.imageSize };

  say({ type: "status", text: "Gemini is making the product…" });
  const draftFiles = [];
  const draftJobs = [];
  const gen = await deps.image(generation.imageModel, parts, imageConfig, {
    onEvent: (ev) => {
      if (ev.type === "thought") say({ type: "thought", text: ev.text });
      if (ev.type === "draft") draftJobs.push(keepDraft({ deps, pid: item.pid, genId, n: ev.n, draft: ev.draft, draftFiles, say }));
    },
  });
  await Promise.all(draftJobs);

  // ── PAID FOR FROM HERE ──
  const split = { cutout: CUTOUT_METHOD };
  let generated, gm = {}, measuredBuf = null;
  try {
    gm = await sharp(gen.buffer).metadata().catch(() => ({}));
    const stamp = deps.now();
    // Gemini's own product photo is kept too: the record shows what code started from.
    const productJpeg = await sharp(gen.buffer).jpeg({ quality: 92 }).toBuffer();
    const productImage = await withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${stamp}-product.jpg`, productJpeg, "image/jpeg"));
    split.productImage = { url: productImage.url, path: productImage.path || null };
    generated = productImage;
    say({ type: "status", text: "Placing it on your backdrop…" });
    try {
      const placed = await place({ kind, gen, plate, spec, boxMode, ctx, split });
      if (placed) generated = await withRetries(() => deps.upload(`products/${item.pid}/new_arrivals/gen_${stamp}.jpg`, placed, "image/jpeg"));
      if (placed) measuredBuf = placed;
    } catch (e) {
      split.placed = null;
      split.deviations = null;
      split.notPlaced = `placing it failed (${String(e.message || e).slice(0, 100)})`;
    }
  } catch (e) {
    e.paid = true;
    e.usage = gen.usage || null;
    throw e;
  }
  let measurements = null;
  if (measuredBuf) {
    // Measured where the product was actually put (a tall shoe is fitted narrower than the layout).
    try { measurements = await objectiveMeasurements({ kind, out: measuredBuf, outBox: expectedBox(kind, split.fittedSpec || spec), exclude: [], plate: plate.buffer, src: orig, srcBox: SOURCE_BOX, checker: null }); }
    catch { /* no numbers for this one */ }
  }
  const finalData = gen.buffer.toString("base64");
  const kept = draftFiles.filter((d) => d.data !== finalData).sort((a, b) => a.n - b.n).map(({ url, path }) => ({ url, path }));
  const libraryPlaced = split.box === "library";
  // What code itself put in the photo is on the record too.
  // (Bookkeeping only: it can never cost the paid photo.)
  try {
    inputs.push(await inputOf("plate (placed by code)", plate.forModel || plate.buffer, { file: plate.file || null }));
    if (libraryPlaced) inputs.push(await inputOf("box (brand library, placed by code)", ctx.libraryBoxPng, { file: `brand library box (${brand})` }));
  } catch { /* recorded without them */ }
  return {
    generated, kind, method: "split",
    sourceUrl: sourcePhoto.currentSourceUrl(item.pid, product, item),
    promptVersion: `${SPLIT_PROMPT_VERSION} (split)`, layersUsed: [],
    packaging: split.packaging || null,
    // What Junid needs to know when the product could not be placed: the photo shown is Gemini's own, on grey.
    ...(split.notPlaced ? { note: `Split could not place this one — ${split.notPlaced}. The photo shown is Gemini's product on grey; try Full Gemini for this item.` } : {}),
    box: kind === "footwear" ? { mode: split.box === "own" ? "own" : libraryPlaced ? "library" : "none", brand, source: split.box || null } : null,
    draftFiles: kept, usage: gen.usage || null, measurements,
    trace: {
      promptText: prompt, inputs, layers: {}, split: (({ fittedSpec, ...kept }) => kept)(split),
      request: gen.request || null, usage: gen.usage || null, requestMs: gen.requestMs ?? null,
      thoughts: gen.thoughts ?? null, thoughtImages: gen.thoughtImages || 0, thoughtsUnsupported: gen.thoughtsUnsupported || null,
      draftFiles: kept, resolution: gm.width ? { width: gm.width, height: gm.height } : null,
      ...(gen.cutShort ? { streamCutShort: gen.cutShort } : {}),
    },
  };
}

/** Cut the product out of Gemini's photo and compose it on the plate. → JPEG buffer, or null (split.notPlaced says why). */
async function place({ kind, gen, plate, spec: layout, boxMode, ctx, split }) {
  let spec = layout;
  const cut = await cutOut(gen.buffer, { pieces: kind === "single" ? 1 : 2, matte: ctx.deps.matte });
  split.coverage = r3(cut.coverage);
  split.pieces = cut.pieces.map((p) => ({ width: p.width, height: p.height, fill: r3(p.fill) }));
  const problem = cutProblem(cut);
  if (problem) { split.notPlaced = problem; return null; }
  let parts;
  if (kind === "footwear") {
    const c = classifyFootwear(cut.pieces);
    split.packaging = c.packaging ? "kept" : "none";
    if (c.pair) split.pair = true;
    // TOE RIGHT is asked of Gemini; a toe-left shoe is never mirrored (its text
    // would flip) and never refused — Junid sees it as made.
    split.toe = toeDirection(c.shoe);
    // The box on the rail, like Junid's reference: the one Gemini kept (its own
    // box), else the brand's library box — a ready cut-out, placed untouched.
    let boxPng = c.packaging ? await trimPng(c.packaging) : null;
    split.box = boxPng ? (boxMode === "own" ? "own" : "in the shoe photo") : null;
    if (!boxPng && ctx.libraryBoxPng) { boxPng = await sharp(ctx.libraryBoxPng).ensureAlpha().png().toBuffer(); split.box = "library"; }
    const shoePng = await trimPng(c.shoe);
    parts = { shoe: shoePng, ...(boxPng ? { box: boxPng } : {}) };
    // A TALL shoe (a boot, a high-top) scaled to the layout's width would run up
    // into the box or off the top: it is fitted by its height instead, centred
    // on the pedestal, its sole on the same line.
    const m = await sharp(shoePng).metadata();
    spec = fitShoe(spec, { width: m.width, height: m.height }, { width: plate.width, height: plate.height }, !!boxPng);
    if (spec.shoe.fitted) { split.shoeFitted = spec.shoe.fitted; split.fittedSpec = spec; }
  } else if (kind === "twopiece" && cut.pieces.length >= 2) {
    // The top on the left, as asked.
    parts = { pieces: await Promise.all(cut.pieces.slice(0, 2).sort((a, b) => a.left - b.left).map(trimPng)) };
  } else {
    parts = { garment: await trimPng(kind === "twopiece" ? unionPieces(cut.pieces) : cut.pieces[0]) };
  }
  const composed = await composeOnPlate({ kind, plate, spec, packagingAt: "rail", parts });
  // Nothing may hang off the canvas: a product that does is not shown as finished.
  for (const r of [composed.placed.shoe, composed.placed.garment, composed.placed.box, composed.placed.packaging, ...(composed.placed.pieces || [])].filter(Boolean)) {
    if (r.left < -0.002 || r.top < -0.002 || r.right > 1.002 || r.bottom > 1.002) { split.notPlaced = "the product does not fit the backdrop at the measured layout"; return null; }
  }
  split.placed = composed.placed;
  split.deviations = composed.deviations;
  return composed.buffer;
}

