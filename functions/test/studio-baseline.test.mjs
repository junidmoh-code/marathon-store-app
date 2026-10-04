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
  // Footwear on the 4 Oct setup: the baseline + the packaging layer, as the Mac mini sent it.
  assert.equal(sha(p("footwear", { packaging: true }).text), "31ad98f10f79ba412cd76c8061070a866355015d416dd240ed3bcb203e42b402");
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
