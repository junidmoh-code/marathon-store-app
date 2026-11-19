// ─── BLACK FRIDAY 2026 — Generate (one AI photo, on Junid's tap) ─────────────
// bfGenerate  Junid taps Generate / Regenerate on ONE product of the Black
//             Friday card. One tap = one photo. Never automatic, never retried.
//
// THE LOOK IS CHOSEN BY THE PRODUCT'S KIND (styles.cjs): sneakers and clothing
// use the New Arrivals engine and house look exactly as New Arrivals does
// (functions/newArrivals/studio); every other kind (caps & beanies, perfume,
// bags, belts, sunglasses, watches, chains …) gets its own staging on Junid's
// same backdrop plates. The sneaker formula is never used for anything else.
// The product is kept exactly as photographed.
//
// Highest quality: Gemini at its MAXIMUM size ("4K"); the photo kept WITHOUT
// recompression — cropped to the plate's shape at the model's own resolution
// and stored as PNG, or the model's bytes untouched when no crop is needed.
// New Arrivals is not touched. The New Arrivals generation pause stops this too.
//
// Writes only /bf_campaign_2026/photos/{pid} and stats; photos go to
// products/{pid}/black_friday/. Deploy BY NAME: firebase deploy --only functions:bfGenerate
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const core = require("./core.cjs");
const styles = require("./styles.cjs");
const pauseSwitch = require("../newArrivals/pause.cjs");
const { isSuperAdminToken } = require("../lib/super-admins.cjs");

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const BF_IMAGE_SIZE = "4K";

let engineP = null;
const engine = () => (engineP ||= Promise.resolve().then(() => require("../newArrivals/studio.js").engine));
const val = async (db, path) => (await db.ref(path).once("value")).val();

/** Crop to the plate's shape at the model's own resolution, lossless; untouched bytes when the shape already matches. */
function losslessFinish(sharp) {
  return async (buf, plate) => {
    const m = await sharp(buf).metadata();
    const r = plate.width / plate.height;
    let w = m.width, h = Math.round(m.width / r);
    if (h > m.height) { h = m.height; w = Math.round(m.height * r); }
    if (Math.abs(w - m.width) <= 1 && Math.abs(h - m.height) <= 1) {
      return { buffer: buf, mime: m.format === "jpeg" ? "image/jpeg" : m.format === "webp" ? "image/webp" : "image/png" };
    }
    return { buffer: await sharp(buf).resize(w, h, { fit: "cover", position: "centre" }).png().toBuffer(), mime: "image/png" };
  };
}

async function claim(db, pid, uid, nowMs) {
  const ref = db.ref(`${core.ROOT}/photos/${pid}`);
  const pre = (await ref.once("value")).val();
  const out = {};
  const res = await ref.transaction((cur) => {
    out.refusal = null;
    const base = cur === null ? pre : cur;
    const p = base || {};
    if (p.generating && nowMs - Number(p.generating.at) < core.CLAIM_MS) { out.refusal = "a photo is already being made for it"; return undefined; }
    return core.withRev({ ...p, generating: { at: nowMs, by: uid || null } }, base);
  });
  const v = res && res.committed && res.snapshot && res.snapshot.val();
  if (out.refusal || !v || !v.generating || v.generating.at !== nowMs) throw new HttpsError("failed-precondition", `Can't generate — ${out.refusal || "not saved"}.`);
}

async function release(db, pid, claimAt) {
  try {
    const ref = db.ref(`${core.ROOT}/photos/${pid}`);
    const pre = (await ref.once("value")).val();
    await ref.transaction((cur) => {
      const base = cur === null ? pre : cur;
      if (!base || !base.generating || base.generating.at !== claimAt) return undefined;
      const { generating, ...rest } = base; // eslint-disable-line no-unused-vars
      return core.withRev(rest, base);
    });
  } catch (e) { console.error(`bfGenerate: ${pid} not released — ${e.message}`); }
}

/** The product after a finished photo: added to its generations and made the photo it shows. Pure. */
function landed(base, { genId, gen, claimAt }) {
  const p = base || {};
  const next = { ...p, gens: { ...(p.gens || {}), [genId]: gen }, genId, use: "generated" };
  if (p.generating && p.generating.at === claimAt) delete next.generating;
  return core.withRev(next, base);
}

/** A kind with its own Black Friday staging: one image call with Junid's plate, the product photo (and its box). */
async function stagedGenerate({ kind, pid, product, genId, e, mods, deps, db, emit, sharp }) {
  const { studio, gemini, compose } = mods;
  const st = styles.stagingFor(kind);
  const bucket = deps.bucket;
  const plate = deps.assets?.loadPlateFile ? await deps.assets.loadPlateFile(st.plate) : await e.loadRoleFile(bucket, st.plate, compose.forModel);
  const fetchBytes = deps.fetchBytes || e.fetchBytes;
  const originalUrl = studio.originalUrlOf({ pid }, product);
  if (!originalUrl) { const err = new Error("the product has no photo to work from"); err.studioRefusal = true; throw err; }
  emit({ type: "status", text: "Reading the original photo…" });
  const orig = await compose.forModel((await fetchBytes(originalUrl)).buffer);
  let box = null;
  if (kind === "perfume" && product.photoBoxUrl) { try { box = await compose.forModel((await fetchBytes(product.photoBoxUrl)).buffer); } catch { box = null; } }
  const parts = [
    gemini.textPart(styles.promptFor(kind, { hasBox: !!box, conditionClause: e.CONDITION_CLAUSE })),
    gemini.imagePart(plate.forModel), gemini.imagePart(orig), ...(box ? [gemini.imagePart(box)] : []),
  ];
  const imageConfig = { aspectRatio: compose.closestAspect(plate.width, plate.height), imageSize: BF_IMAGE_SIZE };
  emit({ type: "status", text: "Making the photo…" });
  const image = e.atModelCall(db, deps.image || ((m, p, c, o) => gemini.streamImage(m, p, c, { ...o, apiKey: deps.apiKey })));
  const gen = await image(e.generation.imageModel, parts, imageConfig, { onEvent: (ev) => { if (ev && ev.type === "thought" && ev.text) emit({ type: "thought", text: ev.text }); } });
  try {
    const m = await sharp(gen.buffer).metadata();
    if (!m.width || !m.height) throw new Error("the image model's answer was not a readable image");
    const fin = await losslessFinish(sharp)(gen.buffer, plate);
    const stamp = (deps.now || Date.now)();
    const ext = fin.mime === "image/jpeg" ? "jpg" : fin.mime === "image/webp" ? "webp" : "png";
    const generated = await e.uploadImmutable(bucket, `products/${pid}/black_friday/gen_${stamp}.${ext}`, fin.buffer, fin.mime);
    const fm = await sharp(fin.buffer).metadata();
    return { generated, usage: gen.usage || null, kind, final: { width: fm.width, height: fm.height, mime: fin.mime, bytes: fin.buffer.length } };
  } catch (err) { err.paid = true; err.usage = gen.usage || null; throw err; }
}

/**
 * deps (injectable for tests): { bucket, apiKey, now(), engine?, image?, fetchBytes?, assets?, correct?, sharp?, fx? }
 * → { ok, pid, genId, kind, costZar, width, height, mime }
 */
async function bfGenerate(db, { pid, section }, uid, deps, emit = () => {}) {
  if (await pauseSwitch.isPaused(db, "generation")) throw new HttpsError("failed-precondition", "Paused — generation is switched off on the New Arrivals card.");
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Not a product id.");
  const order = core.SECTIONS.includes(section) ? [section, ...core.SECTIONS.filter((s) => s !== section)] : core.SECTIONS;
  let item = null;
  for (const s of order) { item = await val(db, `${core.ROOT}/items/${s}/${pid}`); if (item) break; }
  if (!item) throw new HttpsError("invalid-argument", "That product is not in the campaign.");
  const product = await val(db, `products/${pid}`);
  if (!product) throw new HttpsError("failed-precondition", "Can't generate — the product record no longer exists.");
  const kind = item.kind || "clothing";
  const e = deps.engine || await engine();
  const mods = await e.mods();
  const { studio, gemini, record, compose } = mods;
  const sharp = deps.sharp || require("sharp");
  const now = deps.now || (() => Date.now());
  const fxAt = (t) => (deps.fx ? deps.fx(t) : e.usdZarToday(db, t)).catch(() => ({ rate: e.prices.usdToZar, fallback: true }));
  const t0 = now();
  await claim(db, pid, uid, t0);
  const genId = `g${t0}`;
  const model = e.generation.imageModel;
  const bucket = deps.bucket;
  let res, final = null;
  try {
    if (styles.ESTABLISHED.includes(kind)) {
      // Sneakers and clothing: the New Arrivals engine and house look, at 4K, lossless.
      const asProduct = kind === "clothing" ? { ...product, categoryKey: styles.clothingKeyFor(product.categoryKey) } : product;
      const upload = async (p, buf, mime) => {
        const bfPath = String(p).replace("/new_arrivals/", "/black_friday/");
        const r = await e.uploadImmutable(bucket, bfPath, buf, mime);
        if (/\/gen_\d+\.(png|jpg|webp)$/.test(bfPath)) { const m = await sharp(buf).metadata().catch(() => ({})); final = { width: m.width || null, height: m.height || null, mime, bytes: buf.length }; }
        return r;
      };
      res = await studio.generateOne({
        item: { pid, categoryKey: asProduct.categoryKey || null }, product: asProduct, genId, method: "full", provider: "gemini", emit,
        deps: {
          fetchBytes: deps.fetchBytes || e.fetchBytes,
          loadPlate: (k) => e.loadRoleFile(bucket, compose.ROLES[k].plate, compose.forModel),
          loadReference: (k) => (compose.ROLES[k].reference ? e.loadRoleFile(bucket, compose.ROLES[k].reference, compose.forModel) : null),
          libraryBox: (k) => e.libraryBox(bucket, k),
          loadExamples: (k, { brand = null } = {}) => e.loadExamples(bucket, compose.forModel, brand),
          ...(deps.assets || {}),
          spec: e.spec, generation: { ...e.generation, imageSize: BF_IMAGE_SIZE }, conditionClause: e.CONDITION_CLAUSE,
          ...(deps.correct ? { correct: deps.correct } : {}),
          finish: losslessFinish(sharp), lossless: true,
          image: e.atModelCall(db, deps.image || ((m, p, c, o) => gemini.streamImage(m, p, c, { ...o, apiKey: deps.apiKey }))),
          upload, now, log: (m) => console.warn(`bfGenerate: ${pid} — ${m}`),
        },
      });
    } else {
      res = await stagedGenerate({ kind, pid, product, genId, e, mods, deps: { ...deps, now }, db, emit, sharp });
      final = res.final;
    }
  } catch (err) {
    const status = Number(err.status) || 0;
    const reason = err.paid ? "the photo was made but could not be stored — it was charged; tap Generate to make another"
      : err.studioRefusal ? err.message
      : err.refusal ? "Gemini declined to make this photo"
      : status === 402 ? "the Gemini prepaid credit has run out — top it up in Google AI Studio, then tap Generate again"
      : status === 429 || status === 503 ? "the photo service is busy — tap Generate again"
      : "the photo could not be made — tap Generate again";
    await release(db, pid, t0);
    console.error(`bfGenerate: ${pid} (${kind}) failed${err.paid ? " AFTER the image was made" : ""} — ${err.message}`);
    if (err.paid || err.usage) {
      const fx = await fxAt(now());
      const lost = err.paid ? record.generationCost({ model, usage: err.usage, prices: e.prices, fx }) : null;
      const zar = lost ? lost.zar : record.failedCallZar({ model, usage: err.usage, prices: e.prices, fx });
      if (Number.isFinite(zar) && zar > 0) await db.ref(`${core.ROOT}/stats`).update({ spentZar: admin.database.ServerValue.increment(zar) }).catch(() => {});
    }
    throw new HttpsError(err.studioRefusal ? "failed-precondition" : status === 402 ? "resource-exhausted" : status === 429 || status === 503 ? "unavailable" : "internal", `No photo — ${reason}.`);
  }

  const at = now();
  const cost = record.generationCost({ model, usage: res.usage, prices: e.prices, fx: await fxAt(at) });
  const gen = {
    url: res.generated.url, path: res.generated.path || null, at, model, imageSize: BF_IMAGE_SIZE, kind,
    costZar: Number.isFinite(cost.zar) ? cost.zar : null, costEstimated: !!cost.estimated,
    ...(final || {}), ...(res.note ? { note: res.note } : {}),
  };
  for (const [k, v] of Object.entries(gen)) if (v === null || v === undefined) delete gen[k];
  const ref = db.ref(`${core.ROOT}/photos/${pid}`);
  const pre = (await ref.once("value")).val();
  let saved = null;
  try {
    const done = await studio.withRetries(() => ref.transaction((cur) => {
      const base = cur === null ? pre : cur;
      if (base && base.gens && base.gens[genId]) return undefined;
      return landed(base, { genId, gen, claimAt: t0 });
    }));
    saved = done && done.snapshot && done.snapshot.val();
  } catch (err) { console.error(`bfGenerate: ${pid} landing failed — ${err.message}`); }
  await db.ref(`${core.ROOT}/stats`).update({
    ...(Number.isFinite(cost.zar) && cost.zar > 0 ? { spentZar: admin.database.ServerValue.increment(cost.zar) } : {}),
    generations: admin.database.ServerValue.increment(1),
  }).catch((err) => console.error(`bfGenerate: ${pid} spend not counted — ${err.message}`));
  if (!saved || !saved.gens || !saved.gens[genId]) {
    await release(db, pid, t0);
    throw new HttpsError("internal", `No photo — the photo was made (${res.generated.path}) but could not be put on the card. It was charged; tap Generate to make another.`);
  }
  await db.ref(`${core.ROOT}/decisions`).push().set({ at: t0, by: uid || null, action: "generate", pid, genId, kind }).catch(() => {});
  return { ok: true, pid, genId, kind, url: gen.url, costZar: gen.costZar || null, width: gen.width || null, height: gen.height || null, mime: gen.mime || null };
}

const bfGenerateFn = onCall(
  { region: "europe-west1", memory: "2GiB", cpu: 2, timeoutSeconds: 540, concurrency: 3, maxInstances: 3, secrets: [geminiApiKey], invoker: "public" },
  async (request, response) => {
    if (!isSuperAdminToken(request.auth && request.auth.token)) throw new HttpsError("permission-denied", "The Black Friday card is Junid's.");
    const emit = request.acceptsStreaming && response ? (ev) => { response.sendChunk(ev); } : () => {};
    const d = request.data || {};
    const e = await engine();
    return bfGenerate(admin.database(), { pid: d.pid, section: d.section }, request.auth.uid,
      { bucket: admin.storage().bucket(e.BUCKET), apiKey: geminiApiKey.value() }, emit);
  },
);

module.exports = { bfGenerate: bfGenerateFn, _internals: { bfGenerate, losslessFinish, landed, claim, release, stagedGenerate, BF_IMAGE_SIZE } };
