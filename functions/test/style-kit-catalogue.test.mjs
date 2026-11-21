// The Style Kit Catalogue (Junid, 20 Nov 2026): routing, counts, prompts, the drift guard and the kit path
// of the shared generator. No network, no Firebase, no key.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  BUILTIN_KITS, CATEGORY_KIT, kitChain, resolveKit, coveringKit, kitCounts, kitDefs, defaultTemplate, defaultCategoryKit,
  promptFor, HOUSE_PROMPT_GENERIC, HOUSE_PROMPT_SNEAKER, HOUSE_PROMPT_CLOTHING, parseDriftAnswer, slugKitKey, enabledRefs,
} from "../lib/style-kit-catalogue.mjs";
import { driftGuard, generate, KIT_REFS_LABEL, DRIFT_NOTE } from "../newArrivals/studio/studio.mjs";

const ref = (n, extra = {}) => ({ url: `https://firebasestorage.googleapis.com/r${n}.jpg`, enabled: true, addedAt: n, ...extra });
const withRefs = (...n) => ({ refs: Object.fromEntries(n.map((i) => [`r${i}`, ref(i)])) });

test("every category Junid named has a kit, and every live taxonomy category routes somewhere", () => {
  const keys = BUILTIN_KITS.map((k) => k.key);
  for (const k of ["sneaker", "clothing", "caps", "beanies", "sunglasses", "perfumes", "bags", "belts", "jerseys", "slides", "tracksuits", "accessories"]) assert.ok(keys.includes(k), k);
  const live = ["bags", "baseball-shirts", "basketball-vests", "belts", "boots", "caps-beanies", "cargo-pants", "chains-bracelets", "designer-shoes", "dresses", "fitted-caps", "gloves", "golf-t-shirts", "hoodies", "iphone", "jackets", "jeans", "kids-shoes", "ladies-tracksuits", "loafers", "pants", "perfumes", "running-shoes", "shirts", "shorts", "slides", "sneakers", "soccer-boots", "soccer-jerseys", "suits", "sunglasses", "sweaters", "t-shirts", "tracksuits", "underwear", "watches"];
  for (const k of live) assert.ok(keys.includes(CATEGORY_KIT[k]), `${k} → ${CATEGORY_KIT[k]}`);
});

test("the house-style default is EXACTLY the pre-Catalogue choice", () => {
  assert.equal(defaultTemplate({ category: "Clothing" }), "clothing");
  assert.equal(defaultTemplate({ productType: "clothing", category: "Accessories" }), "clothing");
  assert.equal(defaultTemplate({ category: "Perfume" }), "sneaker"); // perfume had the sneaker template before
  assert.equal(defaultTemplate({ category: "Footwear", productType: "sneaker" }), "sneaker");
});

test("an empty kit never changes a generation: with only Sneakers/Clothing filled, every product resolves as before", () => {
  const node = { sneaker: withRefs(1), clothing: withRefs(2) };
  const cases = [
    [{ categoryKey: "caps-beanies", category: "Clothing", productType: "clothing", name: "NY cap" }, "clothing"],
    [{ categoryKey: "bags", category: "Accessories", productType: "clothing", name: "Gucci bag" }, "clothing"],
    [{ categoryKey: "perfumes", category: "Perfume", name: "Dior Sauvage EDP" }, "sneaker"],
    [{ categoryKey: "sneakers", category: "Footwear", productType: "sneaker" }, "sneaker"],
    [{ categoryKey: "soccer-jerseys", category: "Clothing", productType: "clothing" }, "clothing"],
  ];
  for (const [p, want] of cases) {
    const r = resolveKit(p, "p1", node);
    assert.equal(r.kit, want, JSON.stringify(p));
    assert.equal(r.dedicated, false);
  }
});

test("most specific first: product assignment → category kit → parent → house default", () => {
  const node = {
    clothing: withRefs(1), caps: withRefs(2), accessories: withRefs(3), bags: {},
    trucker: { label: "Trucker", parent: "caps", ...withRefs(4) },
    _routes: { products: { pT: "trucker" } },
  };
  const cap = { categoryKey: "caps-beanies", category: "Clothing", productType: "clothing", name: "Trucker cap" };
  assert.deepEqual(kitChain(cap, "pT", node), ["trucker", "caps", "clothing"]);
  assert.equal(resolveKit(cap, "pT", node).kit, "trucker");
  assert.equal(resolveKit(cap, "pOther", node).kit, "caps");
  const bag = { categoryKey: "bags", category: "Accessories", productType: "clothing", name: "Gucci bag" };
  assert.deepEqual(kitChain(bag, "pB", node), ["bags", "accessories", "clothing"]);
  assert.equal(resolveKit(bag, "pB", node).kit, "accessories", "an empty Bags kit falls to its parent");
  assert.equal(coveringKit(bag, "pB", node), "bags", "but the bag is still COVERED by the Bags kit");
});

test("a beanie in 'Caps & Beanies' goes to Beanies; legacy products route by subcategory or name", () => {
  assert.equal(defaultCategoryKit({ categoryKey: "caps-beanies", name: "Nike Beanie Black" }), "beanies");
  assert.equal(defaultCategoryKit({ categoryKey: "caps-beanies", name: "New Era 9Forty" }), "caps");
  assert.equal(defaultCategoryKit({ subcategory: "Eyewear", category: "Accessories" }), "sunglasses");
  assert.equal(defaultCategoryKit({ name: "Versace Eros EDT 100ml" }), "perfumes");
  assert.equal(defaultCategoryKit({ category: "Footwear" }), "sneaker");
});

test("the no-photos fallback is the house default even when it sits mid-chain", () => {
  const node = { _routes: { products: { pX: "clothing" } } };
  const cap = { categoryKey: "caps-beanies", category: "Clothing", productType: "clothing", name: "cap" };
  assert.deepEqual(kitChain(cap, "pX", node), ["clothing", "caps"]);
  assert.equal(resolveKit(cap, "pX", node).kit, "clothing");
});

test("Junid's category re-assignment wins over the default map, and a dropped kit is ignored", () => {
  const node = { tees: { label: "Tees", parent: "clothing", ...withRefs(5) }, _routes: { categories: { "t-shirts": "tees", jeans: "nope" } } };
  assert.equal(resolveKit({ categoryKey: "t-shirts", productType: "clothing" }, "p", node).kit, "tees");
  assert.equal(coveringKit({ categoryKey: "jeans", productType: "clothing" }, "p", node), "clothing");
});

test("kit defs: built-ins plus Junid's sub-categories; _routes and junk are not kits", () => {
  const defs = kitDefs({ trucker: { label: "Trucker", parent: "caps" }, _routes: { products: {} }, junk: { refs: {} }, orphan: { label: "O", parent: "gone" } });
  assert.ok(defs.trucker && defs.trucker.custom && defs.trucker.parent === "caps");
  assert.ok(!defs._routes && !defs.junk);
  assert.equal(defs.orphan.parent, null);
  assert.equal(slugKitKey("Caps > Trucker"), "caps-trucker");
});

test("prompts: under Sneakers/Clothing inherit that default; others get the generic one; a saved prompt wins down the chain", () => {
  assert.equal(promptFor({}, "slides").prompt, HOUSE_PROMPT_SNEAKER);
  assert.equal(promptFor({}, "jerseys").family, "clothing");
  assert.equal(promptFor({}, "jerseys").prompt, HOUSE_PROMPT_CLOTHING);
  assert.equal(promptFor({}, "caps").prompt, HOUSE_PROMPT_GENERIC);
  assert.equal(promptFor({ caps: { prompt: "CAP RULES" }, trucker: { label: "T", parent: "caps" } }, "trucker").prompt, "CAP RULES");
  assert.match(HOUSE_PROMPT_GENERIC, /references set ONLY the scene, the angle, the lighting and the framing/);
});

test("counts: every live product is counted once, under the kit that covers it", () => {
  const products = { a: { categoryKey: "bags" }, b: { categoryKey: "caps-beanies", name: "beanie" }, c: { categoryKey: "sneakers" }, d: { categoryKey: "sneakers", deleted: true } };
  assert.deepEqual(kitCounts(products, {}), { bags: 1, beanies: 1, sneaker: 1 });
});

test("enabled refs: oldest first, disabled and url-less ones out", () => {
  const node = { caps: { refs: { b: ref(2), a: ref(1), off: ref(0, { enabled: false }), nourl: { enabled: true, addedAt: 3 } } } };
  assert.deepEqual(enabledRefs(node, "caps").map((r) => r.id), ["a", "b"]);
});

test("drift answer: only an explicit verdict counts; anything unreadable is unchecked, never a drift", () => {
  assert.deepEqual(parseDriftAnswer('{"verdict":"drifted","issues":"logo missing"}'), { drift: true, issues: "logo missing" });
  assert.deepEqual(parseDriftAnswer('```json\n{"verdict":"same","issues":""}\n```'), { drift: false, issues: "" });
  assert.equal(parseDriftAnswer("maybe"), null);
  assert.equal(parseDriftAnswer('{"verdict":"unsure"}'), null);
});

// ── the drift guard ────────────────────────────────────────────────────────
const png = (c) => sharp({ create: { width: 120, height: 160, channels: 4, background: c } }).extend({ top: 10, bottom: 10, left: 10, right: 10, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
function guardWorld(verdicts) {
  const uploads = [], checks = [];
  let clock = 1000;
  const deps = {
    now: () => (clock += 1),
    fetchBytes: async (url) => ({ buffer: Buffer.from(url) }),
    driftCheck: async (orig, gen) => { checks.push(String(gen)); const v = verdicts.shift(); return v === "x" ? { checked: false, drift: false, issues: "down" } : { checked: true, drift: v === "drift", issues: v === "drift" ? "colour changed" : "" }; },
    cutout: async () => ({ png: await png({ r: 200, g: 10, b: 10, alpha: 1 }) }),
    upload: async (p) => { uploads.push(p); return { path: p, url: `https://u/${p}` }; },
  };
  const item = { pid: "p1" }, product = { photoUrl: "https://firebasestorage.googleapis.com/orig.jpg" };
  const res = (n) => ({ generated: { url: `https://gen/${n}` }, usage: { n }, kind: "kit-caps" });
  return { deps, uploads, checks, item, product, res };
}

test("drift guard: same → the first photo, stamped", async () => {
  const w = guardWorld(["same"]);
  let again = 0;
  const r = await driftGuard({ first: w.res(1), again: async () => { again++; return w.res(2); }, item: w.item, product: w.product, deps: w.deps });
  assert.equal(r.generated.url, "https://gen/1"); assert.equal(again, 0); assert.deepEqual(r.drift, { first: "same" });
});

test("drift guard: drifted → ONE retry; the retry is kept when it matches; the first image counts as wasted", async () => {
  const w = guardWorld(["drift", "same"]);
  let again = 0;
  const r = await driftGuard({ first: w.res(1), again: async () => { again++; return w.res(2); }, item: w.item, product: w.product, deps: w.deps });
  assert.equal(again, 1); assert.equal(r.generated.url, "https://gen/2");
  assert.equal(r.drift.first, "drifted"); assert.equal(r.drift.retry, "same");
  assert.deepEqual(r.wastedUsages, [{ n: 1 }]);
});

test("drift guard: drifted twice → the product cut out of its own photo, both images wasted, never a third generation", async () => {
  const w = guardWorld(["drift", "drift"]);
  let again = 0;
  const r = await driftGuard({ first: w.res(1), again: async () => { again++; return w.res(2); }, item: w.item, product: w.product, deps: w.deps });
  assert.equal(again, 1);
  assert.equal(r.driftFallback, "cutout"); assert.equal(r.note, DRIFT_NOTE);
  assert.match(r.generated.path, /^products\/p1\/new_arrivals\/gen_\d+\.jpg$/);
  // Booked exactly once each: the last image as the result's own cost, the first as wasted — no phantom estimate.
  assert.deepEqual(r.usage, { n: 2 }); assert.deepEqual(r.wastedUsages, [{ n: 1 }]);
});

test("drift guard: a retry that fails after being charged is still booked, and the cut-out is used", async () => {
  const w = guardWorld(["drift"]);
  const r = await driftGuard({ first: w.res(1), again: async () => { const e = new Error("stored failed"); e.paid = true; e.usage = { n: 2 }; throw e; }, item: w.item, product: w.product, deps: w.deps });
  assert.equal(r.driftFallback, "cutout"); assert.equal(r.drift.retry, "failed");
  assert.deepEqual(r.usage, { n: 2 }); assert.deepEqual(r.wastedUsages, [{ n: 1 }]);
});

test("drift guard: with no time left for a retry, it goes straight to the cut-out", async () => {
  const w = guardWorld(["drift"]);
  let again = 0;
  const r = await driftGuard({ first: w.res(1), again: async () => { again++; return w.res(2); }, item: w.item, product: w.product, deps: w.deps, startedMs: 0, clockMs: () => 600_000 });
  assert.equal(again, 0); assert.equal(r.driftFallback, "cutout"); assert.equal(r.drift.retry, "skipped");
  assert.deepEqual(r.usage, { n: 1 }); assert.deepEqual(r.wastedUsages, []);
});

test("drift guard: a check that cannot run is never a drift — no retry, no extra spend", async () => {
  const w = guardWorld(["x"]);
  let again = 0;
  const r = await driftGuard({ first: w.res(1), again: async () => { again++; return w.res(2); }, item: w.item, product: w.product, deps: w.deps });
  assert.equal(again, 0); assert.equal(r.generated.url, "https://gen/1"); assert.equal(r.drift.first, "unchecked");
});

// ── the kit path of the shared generator ───────────────────────────────────
test("a product with its own filled kit is generated from the kit: prompt, product, refs labelled scene-only; same model and size", async () => {
  const src = await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 30, g: 60, b: 160 } } }).jpeg().toBuffer();
  const answer = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: { r: 230, g: 230, b: 225 } } }).composite([{ input: await sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 30, g: 60, b: 160 } } }).png().toBuffer(), left: 550, top: 550 }]).jpeg().toBuffer();
  const refBuf = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
  const calls = [];
  const deps = {
    generation: { imageModel: "gemini-3-pro-image", imageSize: "4K", layers: {} }, conditionClause: "CONDITION.",
    fetchBytes: async () => ({ buffer: src }),
    image: async (model, parts, imageConfig) => { calls.push({ model, parts, imageConfig }); return { buffer: answer, mime: "image/jpeg", usage: { promptTokenCount: 1 } }; },
    upload: async (p) => ({ path: p, url: `https://firebasestorage.googleapis.com/${p}` }),
    now: () => 42,
    styleKitFor: async () => ({ kit: "caps", label: "Caps", dedicated: true, prompt: "KIT PROMPT", promptFamily: "generic", refs: [refBuf, refBuf], refIds: ["a", "b"] }),
  };
  const res = await generate({ item: { pid: "p9", categoryKey: "caps-beanies", name: "NY cap" }, product: { photoUrl: "https://firebasestorage.googleapis.com/o.jpg", categoryKey: "caps-beanies", name: "NY cap" }, genId: "g1", look: "headwear", deps });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "gemini-3-pro-image"); assert.equal(calls[0].imageConfig.imageSize, "4K"); assert.equal(calls[0].imageConfig.aspectRatio, "1:1");
  const texts = calls[0].parts.filter((p) => p.text).map((p) => p.text);
  assert.match(texts[0], /^KIT PROMPT/); assert.match(texts[0], /NY cap/); assert.match(texts[0], /CONDITION\./);
  assert.ok(texts.includes(KIT_REFS_LABEL));
  assert.equal(calls[0].parts.filter((p) => !p.text).length, 3, "the product + two references; no plate");
  assert.deepEqual(res.styleKit, { kit: "caps", label: "Caps", refs: 2 });
  assert.equal(res.promptVersion, "stylekit-caps");
});

test("a product that falls through to the house default keeps the restored request (styleKitFor dedicated:false)", async () => {
  let generateOneReached = false;
  const deps = {
    generation: { imageModel: "m", imageSize: "4K" },
    styleKitFor: async () => ({ kit: "sneaker", dedicated: false, refs: [] }),
    // generateOne's first move is kindFor; a product with no plate kind is refused there — proof it went that way.
  };
  await assert.rejects(generate({ item: { pid: "p1", categoryKey: "perfumes" }, product: { categoryKey: "perfumes" }, genId: "g", deps }), (e) => { generateOneReached = /only footwear and clothing/.test(e.message); return true; });
  assert.ok(generateOneReached);
});

// ── THE GARMENT FINISH + CHECK (Junid, 21 Nov 2026) ─────────────────────────
import { isGarment, parseGarmentAnswer, garmentFixNote, GARMENT_FINISH, GARMENT_CHECK_PROMPT, GARMENT_FAULTS } from "../lib/style-kit-catalogue.mjs";
import { checkDrift } from "../lib/style-kit-drift.mjs";

test("garments: clothing by category, product type or catalogue key; never footwear or accessories", () => {
  for (const p of [{ category: "Clothing" }, { productType: "clothing" }, { categoryKey: "golf-t-shirts" }, { categoryKey: "soccer-jerseys" }, { categoryKey: "tracksuits" }, { categoryKey: "hoodies" }])
    assert.equal(isGarment(p), true, JSON.stringify(p));
  for (const p of [{ category: "Footwear", categoryKey: "sneakers" }, { categoryKey: "caps-beanies" }, { categoryKey: "bags" }, { category: "Clothing", categoryKey: "caps-beanies" }, {}, null])
    assert.equal(isGarment(p), false, JSON.stringify(p));
});

test("garment answer: the named faults only, in fixed order; unreadable or no list → unchecked, never a fail", () => {
  assert.deepEqual(parseGarmentAnswer('{"faults":["Wrinkles","lines","nonsense"],"issues":"a box on the wall"}'), { drift: true, faults: ["lines", "wrinkles"], issues: "a box on the wall" });
  assert.deepEqual(parseGarmentAnswer('```json\n{"faults":[],"issues":""}\n```'), { drift: false, faults: [], issues: "" });
  assert.equal(parseGarmentAnswer('{"verdict":"same"}'), null);
  assert.equal(parseGarmentAnswer("looks fine"), null);
  assert.deepEqual(GARMENT_FAULTS, ["product", "colour", "lines", "wrinkles", "tilt"]);
  for (const f of GARMENT_FAULTS) assert.ok(GARMENT_CHECK_PROMPT.includes(`"${f}"`), f);
});

test("garment fix note: one sentence per fault found; nothing found → no note", () => {
  assert.equal(garmentFixNote([]), null); assert.equal(garmentFixNote(undefined), null);
  const n = garmentFixNote(["tilt", "colour"]);
  assert.match(n, /^FIX FROM THE LAST ATTEMPT/); assert.match(n, /COLOUR DRIFTED.*HUNG CROOKED/);
  assert.doesNotMatch(n, /WRINKLED|RECTANGLE/);
});

test("the check sends the garment prompt for a garment, the drift prompt otherwise, and reads each answer its own way", async () => {
  const sent = [];
  const fetchImpl = (answer) => async (url, init) => { sent.push(JSON.parse(init.body).contents[0].parts[0].text); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: answer }] } }] }) }; };
  const img = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#963" } }).jpeg().toBuffer();
  const g = await checkDrift({ original: img, generated: img }, { apiKey: "k", sharp, fetchImpl: fetchImpl('{"faults":["tilt"],"issues":"leans left"}'), garment: true });
  assert.deepEqual({ checked: g.checked, drift: g.drift, faults: g.faults }, { checked: true, drift: true, faults: ["tilt"] });
  assert.equal(sent[0], GARMENT_CHECK_PROMPT);
  const d = await checkDrift({ original: img, generated: img }, { apiKey: "k", sharp, fetchImpl: fetchImpl('{"verdict":"same","issues":""}') });
  assert.equal(d.drift, false); assert.equal(d.faults, undefined); assert.notEqual(sent[1], GARMENT_CHECK_PROMPT);
});

test("a clothing Style Kit photo carries the garment finish before the condition clause, and its retry the fix", async () => {
  const src = await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 100, g: 60, b: 30 } } }).jpeg().toBuffer();
  const answer = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: { r: 230, g: 230, b: 225 } } }).composite([{ input: await sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 100, g: 60, b: 30 } } }).png().toBuffer(), left: 550, top: 550 }]).jpeg().toBuffer();
  const refBuf = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
  const calls = [], checks = [["wrinkles"], []];
  const deps = {
    generation: { imageModel: "gemini-3-pro-image", imageSize: "4K", layers: {} }, conditionClause: "CONDITION.",
    fetchBytes: async () => ({ buffer: src }),
    image: async (model, parts, imageConfig) => { calls.push({ parts }); return { buffer: answer, mime: "image/jpeg", usage: { n: calls.length } }; },
    upload: async (p) => ({ path: p, url: `https://firebasestorage.googleapis.com/${p}` }),
    now: () => 42 + calls.length,
    styleKitFor: async () => ({ kit: "jerseys", label: "Jerseys", dedicated: true, prompt: "JERSEY KIT PROMPT", promptFamily: "clothing", refs: [refBuf], refIds: ["a"] }),
    driftCheck: async (o, g, opts) => { assert.deepEqual(opts, { garment: true }); const f = checks.shift(); return { checked: true, drift: f.length > 0, faults: f, issues: "" }; },
  };
  const res = await generate({ item: { pid: "p9", categoryKey: "soccer-jerseys", name: "Ajax away" }, product: { photoUrl: "https://firebasestorage.googleapis.com/o.jpg", categoryKey: "soccer-jerseys", name: "Ajax away" }, genId: "g1", deps });
  assert.equal(calls.length, 2);
  const first = calls[0].parts[0].text, second = calls[1].parts[0].text;
  assert.ok(first.includes(GARMENT_FINISH)); assert.ok(first.indexOf(GARMENT_FINISH) < first.indexOf("CONDITION."));
  assert.doesNotMatch(first, /FIX FROM THE LAST ATTEMPT/);
  assert.match(second, /FIX FROM THE LAST ATTEMPT.*LEFT WRINKLED/); assert.ok(second.endsWith("CONDITION."));
  assert.deepEqual(res.drift.faults, ["wrinkles"]); assert.equal(res.drift.retry, "same");
});

test("a product made through a staging look is never checked as a garment (it got no garment finish)", async () => {
  const src = await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 30, g: 60, b: 160 } } }).jpeg().toBuffer();
  const plate = { buffer: await sharp({ create: { width: 543, height: 724, channels: 3, background: "#888" } }).jpeg().toBuffer(), width: 543, height: 724 };
  const answer = await sharp({ create: { width: 1086, height: 1448, channels: 3, background: "#777" } }).jpeg().toBuffer();
  const seen = [];
  const deps = {
    generation: { imageModel: "m", imageSize: "4K", layers: {} }, conditionClause: "C.",
    fetchBytes: async () => ({ buffer: src }), loadPlateFile: async () => plate,
    image: async () => ({ buffer: answer, mime: "image/jpeg", usage: null }),
    upload: async (p) => ({ path: p, url: `https://firebasestorage.googleapis.com/${p}` }), now: () => 7,
    driftCheck: async (o, g, opts) => { seen.push(opts || {}); return { checked: true, drift: false, issues: "" }; },
  };
  // A top-category "Clothing" product with no catalogue key, sent through the bags staging by its caller.
  const r = await generate({ item: { pid: "p" }, product: { category: "Clothing", name: "Tote", photoUrl: "https://firebasestorage.googleapis.com/o.jpg" }, genId: "g", look: "bags", deps });
  assert.equal(r.look, "bags");
  assert.deepEqual(seen, [{}], "the plain drift check, not the garment one");
  assert.equal(r.drift.check, undefined);
});

test("a category re-routed to a clothing-family kit gets the garment check as well as the finish", async () => {
  const src = await sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 100, g: 60, b: 30 } } }).jpeg().toBuffer();
  const answer = await sharp({ create: { width: 1600, height: 1600, channels: 3, background: { r: 230, g: 230, b: 225 } } }).composite([{ input: await sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 100, g: 60, b: 30 } } }).png().toBuffer(), left: 550, top: 550 }]).jpeg().toBuffer();
  const refBuf = await sharp({ create: { width: 1000, height: 1000, channels: 3, background: "#5a5a5a" } }).jpeg().toBuffer();
  const seen = [];
  const deps = {
    generation: { imageModel: "m", imageSize: "4K", layers: {} }, conditionClause: "C.",
    fetchBytes: async () => ({ buffer: src }), image: async () => ({ buffer: answer, mime: "image/jpeg", usage: null }),
    upload: async (p) => ({ path: p, url: `https://firebasestorage.googleapis.com/${p}` }), now: () => 9,
    styleKitFor: async () => ({ kit: "scarves", label: "Scarves", dedicated: true, prompt: "P", promptFamily: "clothing", refs: [refBuf], refIds: ["a"] }),
    driftCheck: async (o, g, opts) => { seen.push(opts || {}); return { checked: true, drift: false, issues: "" }; },
  };
  await generate({ item: { pid: "p" }, product: { categoryKey: "scarves", name: "Scarf", photoUrl: "https://firebasestorage.googleapis.com/o.jpg" }, genId: "g", deps });
  assert.deepEqual(seen, [{ garment: true }]);
});

test("the garment check keeps the condition rule: worn-in creasing is not a fault; packing/fold/hanger creases are", () => {
  assert.match(GARMENT_CHECK_PROMPT, /WORN INTO the fabric by use/);
  assert.match(GARMENT_CHECK_PROMPT, /packing creases, fold lines and hanger creases are ALWAYS faults/);
});
