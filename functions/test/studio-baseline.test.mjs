// THE LOCKED BASELINE (Junid, 3 Oct; moved into the Cloud Function 4 Oct).
// Fails if the image model, its size, the baseline prompt, the store's
// condition clause, the request body or a plate changes without the signed-off
// lock file changing with it — never silently.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { studioPrompt, layersFor, BASELINE_ONLY_KEYS } from "../newArrivals/studio/prompt.mjs";
import { baselinePrompt } from "../newArrivals/studio/baseline-prompts.mjs";
import { placementText, ROLES, kindFor, closestAspect } from "../newArrivals/studio/compose.mjs";
import { requestBody, THINKING_CONFIG } from "../newArrivals/studio/gemini-stream.mjs";

const require = createRequire(import.meta.url);
const at = (f) => new URL(`../newArrivals/studio/${f}`, import.meta.url);
const json = (f) => JSON.parse(fs.readFileSync(at(f), "utf8"));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const lock = json("config/baseline.lock.json");
const gen = json("config/generation.json");
const spec = json("config/layout-spec.json");
const plates = json("config/plates.lock.json");
const { CONDITION_CLAUSE } = require("../lib/photo-prompt.cjs");

test("the baseline prompt file is exactly the signed-off one", () => {
  assert.equal(sha(fs.readFileSync(at("baseline-prompts.mjs"))), lock.baselinePromptSha256,
    "studio/baseline-prompts.mjs changed — needs Junid's sign-off in config/baseline.lock.json");
});

test("the store's CONDITION_CLAUSE (part of every prompt) is the signed-off one", () => {
  assert.equal(sha(CONDITION_CLAUSE), lock.conditionClauseSha256);
});

test("the image model and size are exactly the signed-off ones — and there is no other image model", () => {
  assert.equal(gen.imageModel, lock.imageModel);
  assert.equal(gen.imageModel, "gemini-3-pro-image");
  assert.equal(gen.imageSize, lock.imageSize);
  assert.equal(gen.imageSize, "2K");
  assert.deepEqual(gen.layers, lock.layers);
  assert.equal(lock.approvedBy, "Junid");
  for (const f of ["studio.mjs", "gemini-stream.mjs", "prompt.mjs"]) {
    assert.doesNotMatch(fs.readFileSync(at(f), "utf8"), /imageFallback|fallbackImage|imageModels\s*[:=]|flash-image/, f);
  }
  assert.doesNotMatch(fs.readFileSync(new URL("../newArrivals/studio.js", import.meta.url), "utf8"), /imageFallback|fallbackImage|flash-image/);
});

test("with every layer off the prompt is byte-for-byte the baseline", () => {
  for (const kind of ["footwear", "single", "twopiece"]) {
    const args = { kind, productName: "Test Product", conditionClause: CONDITION_CLAUSE, placement: placementText(kind, spec[kind]) };
    assert.equal(studioPrompt({ ...args, layers: {} }).text, baselinePrompt(args));
  }
});

test("the prompts the baseline photos were made with (pinned fingerprints)", () => {
  const p = (kind, layers) => studioPrompt({ kind, layers, productName: "Test Product", conditionClause: CONDITION_CLAUSE, placement: placementText(kind, spec[kind]) });
  // Footwear: the baseline + the packaging layer, with the PLACEMENT measured from G-0102 said outright
  // (Junid's footwear-consistency brief of 5 Oct — baseline.lock.json footwearLayout). Until then the
  // fingerprint was 31ad98f1…, as the Mac mini sent it on 4 Oct; only the placement sentence differs.
  assert.equal(sha(p("footwear", { packaging: true }).text), "b5e25b848b028aa3a0be2f5fe6a27b1127684cf74d1a91afd5c5178dea627fab");
  assert.equal(lock.footwearLayout.requestedBy, "Junid");
  // The cream knit vest's class (one garment) and the two-piece: the bare baseline.
  assert.equal(sha(p("single", { packaging: true }).text), "42bd6d5ec625f712fa96281fdb6c33e71dc7319dc5306203284da3584a6251aa");
  assert.equal(sha(p("twopiece", {}).text), "3dbbc9e9a8a38765a16d748bf90133c70619d86ab3fa1e76995f3b8516f309e5");
});

test("a layer is its own paragraph just before the studio brief; the baseline text around it is untouched", () => {
  const args = { kind: "footwear", productName: "X", conditionClause: CONDITION_CLAUSE, placement: placementText("footwear", spec.footwear) };
  const base = baselinePrompt(args);
  const withLayer = studioPrompt({ ...args, layers: { packaging: true } });
  assert.deepEqual(withLayer.layers, ["packaging"]);
  const cut = withLayer.text.indexOf("PACKAGING:");
  assert.equal(withLayer.text.slice(0, cut), base.slice(0, cut));
  assert.ok(withLayer.text.endsWith(base.slice(cut)));
});

test("t-shirts never get a clothing layer (they already look right)", () => {
  for (const key of BASELINE_ONLY_KEYS) {
    assert.deepEqual(layersFor({ kind: "single", categoryKey: key, layers: { steam: true, packaging: true } }), []);
  }
  assert.deepEqual(BASELINE_ONLY_KEYS, ["t-shirts", "golf-t-shirts", "basketball-vests", "baseball-shirts", "soccer-jerseys"]);
  assert.deepEqual(layersFor({ kind: "single", categoryKey: "hoodies", layers: { steam: true } }).map((l) => l.name), ["steam"]);
  assert.deepEqual(layersFor({ kind: "twopiece", categoryKey: "tracksuits", layers: { steam: true } }).map((l) => l.name), ["steam"]);
  // A footwear layer never reaches a garment, nor a clothing layer a shoe.
  assert.deepEqual(layersFor({ kind: "footwear", categoryKey: "sneakers", layers: { steam: true } }), []);
  assert.deepEqual(layersFor({ kind: "single", categoryKey: "hoodies", layers: { footwearBox: true, footwearPose: true } }), []);
});

test("the request body is the baseline's: IMAGE+TEXT, the image config, thought summaries", () => {
  const body = requestBody([{ text: "p" }], { aspectRatio: "3:4", imageSize: "2K" });
  assert.deepEqual(body, {
    contents: [{ parts: [{ text: "p" }] }],
    generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: "3:4", imageSize: "2K" }, thinkingConfig: { includeThoughts: true } },
  });
  assert.deepEqual(THINKING_CONFIG, { includeThoughts: true });
  assert.equal("thinkingConfig" in requestBody([], {}, { includeThoughts: false }).generationConfig, false);
});

test("the plates are Junid's locked files, and the layout spec was measured from them", () => {
  for (const kind of Object.keys(ROLES)) {
    const p = plates[ROLES[kind].plate];
    assert.ok(p && /^[0-9a-f]{64}$/.test(p.sha256), `${kind} plate is locked`);
    assert.equal(spec[kind].plateSha, p.sha256, `${kind}: the spec belongs to this plate`);
    if (ROLES[kind].reference) assert.ok(plates[ROLES[kind].reference], `${kind} reference is locked`);
  }
  // The generation aspect asked of the model: the supported ratio nearest each plate.
  assert.equal(closestAspect(plates["footwear-plate.png"].width, plates["footwear-plate.png"].height), "3:4");
  assert.equal(closestAspect(plates["fence-single.png"].width, plates["fence-single.png"].height), "3:4");
});

test("the category decides the plate: all footwear (slides too) on the pedestal, sets on the two-piece fence", () => {
  for (const k of ["sneakers", "slides", "sandals", "boots", "soccer-boots"]) assert.equal(kindFor({ categoryKey: k }), "footwear");
  assert.equal(kindFor({ categoryKey: "tracksuits" }), "twopiece");
  assert.equal(kindFor({ categoryKey: "hoodies" }), "single");
  assert.equal(kindFor({ categoryKey: "perfume" }), null);
});

// ── THE LAYERS SWITCHED ON 4 OCT (Junid's rebuild brief, constraint 6) ───────
import { STEAM_LAYER, footwearBoxLayer, FOOTWEAR_POSE_LAYER } from "../newArrivals/studio/prompt.mjs";
import { EXAMPLES_LABEL } from "../newArrivals/studio/studio.mjs";
import { productOnlyPrompt, SPLIT_PROMPT_VERSION } from "../newArrivals/studio/split-prompts.mjs";

test("the layers in force are exactly the signed-off ones, each with its approval on record", () => {
  assert.deepEqual(gen.layers, { boxRules: false, reshootBrief: false, socialsRequest: false, framingCorrection: false, packaging: false,
    steam: true, footwearBox: true, footwearPose: true, footwearExamples: false });
  // Each layer in force is on record as Junid's — approved, or requested by him and marked
  // provisional until he has seen a photo made with it — and its exact wording is pinned.
  const texts = { steam: STEAM_LAYER, footwearBox: ["own", "library", "none"].map(footwearBoxLayer).join("\n"), footwearPose: FOOTWEAR_POSE_LAYER, footwearExamples: EXAMPLES_LABEL };
  for (const [name, on] of Object.entries(gen.layers)) {
    if (!on) continue;
    const a = lock.layerApprovals[name];
    assert.ok(a && (a.approvedBy === "Junid" || (a.requestedBy === "Junid" && a.provisional === true)), `${name} is on record as Junid's`);
    assert.equal(sha(texts[name]), a.layerTextSha256, `${name}: the wording changed — update baseline.lock.json with Junid's word on it`);
  }
  assert.equal(gen.defaultMethod, "full");
});

test("a T-SHIRT is still generated on the bare baseline — byte for byte — with every layer on", () => {
  for (const key of ["t-shirts", "golf-t-shirts"]) {
    const args = { kind: "single", productName: "Plain Tee", conditionClause: CONDITION_CLAUSE, placement: placementText("single", spec.single) };
    assert.equal(studioPrompt({ ...args, categoryKey: key, layers: gen.layers }).text, baselinePrompt(args));
  }
});

test("CLOTHING (not tees): the steam paragraph sits before the studio brief; nothing else of the baseline moves", () => {
  const args = { kind: "single", productName: "Fleece Hoodie", conditionClause: CONDITION_CLAUSE, placement: placementText("single", spec.single) };
  const out = studioPrompt({ ...args, categoryKey: "hoodies", layers: gen.layers });
  assert.deepEqual(out.layers, ["steam"]);
  assert.equal(out.text.replace(`${STEAM_LAYER}\n\n`, ""), baselinePrompt(args));
  assert.ok(out.text.indexOf("STEAMED AND PRESSED") < out.text.indexOf("STUDIO QUALITY"));
  // Steaming never licenses a change to the garment itself.
  assert.match(STEAM_LAYER, /Every print, logo, label, embroidery, stitch line, seam, pocket, zip and button stays exactly/);
  assert.match(STEAM_LAYER, /colour stays true/);
  // …nor to its shape or to anything designed into it.
  assert.match(STEAM_LAYER, /Remove ONLY those/);
  assert.match(STEAM_LAYER, /shape, cut, length, fit and\s+volume — never inflated, stretched, straightened, levelled or resized/);
  assert.match(STEAM_LAYER, /pleats and pressed creases; gathers,\s+elastic and ribbing/);
  // It does not fight the baseline's lighting.
  assert.doesNotMatch(STEAM_LAYER, /key light/);
  // A two-piece set gets it too.
  assert.deepEqual(studioPrompt({ kind: "twopiece", categoryKey: "tracksuits", productName: "Set", conditionClause: CONDITION_CLAUSE, placement: placementText("twopiece", spec.twopiece), layers: gen.layers }).layers, ["steam"]);
});

test("SNEAKERS: one box on the rail — its own, else the one in the shoe photo, else the brand's; the shoe on the pedestal", () => {
  const args = { kind: "footwear", categoryKey: "sneakers", productName: "Nike AF1", conditionClause: CONDITION_CLAUSE, placement: placementText("footwear", spec.footwear), layers: gen.layers };
  for (const boxMode of ["own", "library", "none"]) {
    const out = studioPrompt({ ...args, boxMode });
    assert.deepEqual(out.layers, ["footwearBox", "footwearPose"]);
    assert.equal(out.text.replace(`${footwearBoxLayer(boxMode)}\n\n${FOOTWEAR_POSE_LAYER}\n\n`, ""), baselinePrompt(args), `${boxMode}: the baseline text is untouched`);
    assert.doesNotMatch(out.text, /PACKAGING:/, "the packaging layer is replaced, not stacked");
  }
  assert.match(footwearBoxLayer("own"), /this shoe's own box: use that box/);
  assert.match(footwearBoxLayer("library"), /If the SHOE PHOTO itself shows this shoe's own box, use THAT very box/);
  assert.match(footwearBoxLayer("library"), /Only if the SHOE PHOTO shows no box, use the brand's box/);
  assert.match(footwearBoxLayer("none"), /the result has NO box at all: the rail above the shoe stays empty/);
  // Each mode names the baseline sentence it overrides, so the model is never told two things.
  assert.match(footwearBoxLayer("none"), /the sentence above about "the BOX from the BOX PHOTO" does not apply/);
  assert.match(footwearBoxLayer("none"), /boxes in the REFERENCE and in any example photo are NOT this shoe's/);
  assert.match(footwearBoxLayer("library"), /the sentence above calling it "this product's own box" does not apply/);
  // With no box photo the placement names no box and the diagram draws none.
  assert.doesNotMatch(placementText("footwear", { ...spec.footwear, box: undefined }), /the box centred/);
  for (const m of ["own", "library", "none"]) assert.match(footwearBoxLayer(m), /never redrawn, restyled or changed/);
  // Slides are footwear: the same rules.
  assert.deepEqual(studioPrompt({ ...args, categoryKey: "slides", boxMode: "none" }).layers, ["footwearBox", "footwearPose"]);
  // The baseline already says right shoe, outer side, toe right — the pose layer adds the pedestal and "one shoe".
  assert.match(baselinePrompt(args), /the RIGHT shoe, its OUTER side to the camera, TOE POINTING RIGHT/);
  assert.match(FOOTWEAR_POSE_LAYER, /ONE shoe only .* outer side to the camera\s+and its toe pointing right, .* whole sole on the white pedestal, at the position and size\s+the PLACEMENT above gives/s);
});

test("the example photos are for the layout only; a product is never shown an example of its own brand; all five are locked", () => {
  assert.match(EXAMPLES_LABEL, /Take nothing from them but the layout/);
  assert.match(EXAMPLES_LABEL, /never a shoe, box or logo copied from these examples/);
  const ex = json("config/examples.lock.json");
  assert.equal(Object.keys(ex).length, 5);
  for (const e of Object.values(ex)) { assert.match(e.sha256, /^[0-9a-f]{64}$/); assert.ok(e.brand); }
  const { exampleFiles } = require("../newArrivals/studio.js")._internals;
  assert.deepEqual(exampleFiles("puma"), ["footwear-example-nike-af1.jpg", "footwear-example-new-balance-1000.jpg"]);
  assert.deepEqual(exampleFiles(null), ["footwear-example-nike-af1.jpg", "footwear-example-new-balance-1000.jpg"]);
  for (const brand of ["nike", "new-balance", "timberland", "adidas"]) {
    const files = exampleFiles(brand);
    assert.equal(files.length, 2);
    for (const f of files) assert.notEqual(ex[f].brand, brand, `${brand} is never shown ${f}`);
  }
});

test("NEVER CHANGE the product is in every prompt — full and split — whatever the layers", () => {
  const never = /NEVER CHANGE THE PRODUCT: its shape, silhouette, proportions, colourway, materials and textures, logos, text,\s+stitching layout/;
  for (const [kind, categoryKey] of [["footwear", "sneakers"], ["single", "hoodies"], ["single", "t-shirts"], ["twopiece", "tracksuits"]]) {
    assert.match(studioPrompt({ kind, categoryKey, productName: "X", conditionClause: CONDITION_CLAUSE, placement: placementText(kind, spec[kind]), layers: gen.layers, boxMode: "library" }).text, never);
    assert.match(productOnlyPrompt({ kind, productName: "X", conditionClause: CONDITION_CLAUSE }), never);
  }
});

test("the split prompt is exactly the signed-off one; it asks for steamed, studio-lit product on plain grey", () => {
  const split = json("config/split.lock.json");
  assert.equal(sha(fs.readFileSync(at("split-prompts.mjs"))), split.splitPromptSha256);
  assert.equal(SPLIT_PROMPT_VERSION, split.splitPromptVersion);
  const p = productOnlyPrompt({ kind: "single", productName: "X", conditionClause: CONDITION_CLAUSE });
  assert.match(p, /steamed and pressed — no packing creases or fold\s+lines/);
  assert.match(p, /light-grey studio background/);
});
