// ─── BLACK FRIDAY 2026 — Generate (one Gemini photo, on Junid's tap) ─────────
// bfGenerate  Junid taps Generate / Regenerate on ONE item of the Black Friday
//             card. One tap = one photo. Never automatic, never retried.
//
// THE SAME ENGINE AND HOUSE LOOK as New Arrivals (functions/newArrivals/studio
// — Junid's plates, references, brand boxes and locked prompt), with two
// Black Friday settings (Junid, 19 Nov: highest quality everywhere):
//   · Gemini at its MAXIMUM size ("4K"), and
//   · the photo kept WITHOUT recompression: cropped to the plate's shape at
//     the model's own resolution and stored as PNG (lossless) — or the
//     model's bytes untouched when no crop is needed. A footwear photo is
//     placed on Junid's fixed footwear plate, so it has the plate's own
//     resolution (also PNG).
// New Arrivals' photos and settings are not touched. The New Arrivals
// generation pause switch stops this too.
//
// Writes only /bf_campaign_2026/photos/{pid} and stats; the photo goes to
// Storage at products/{pid}/black_friday/. Deploy BY NAME:
//   firebase deploy --only functions:bfGenerate
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const core = require("./core.cjs");
const pauseSwitch = require("../newArrivals/pause.cjs");
const { isSuperAdminToken } = require("../lib/super-admins.cjs");

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const CLAIM_MS = 10 * 60 * 1000;
const BF_IMAGE_SIZE = "4K";

let engineP = null;
const engine = () => (engineP ||= Promise.resolve().then(() => require("../newArrivals/studio.js").engine));

const val = async (db, path) => (await db.ref(path).once("value")).val();

/**
 * The Black Friday finish: crop to the plate's shape at the model's own
 * resolution, lossless. Untouched bytes when the shape already matches.
 */
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

/** Claim photos/{pid}: one generation at a time per item. */
async function claim(db, pid, uid, nowMs) {
  const ref = db.ref(`${core.ROOT}/photos/${pid}`);
  const pre = (await ref.once("value")).val();
  const out = {};
  const res = await ref.transaction((cur) => {
    out.refusal = null;
    const base = cur === null ? pre : cur;
    const p = base || {};
    if (p.generating && nowMs - Number(p.generating.at) < CLAIM_MS) { out.refusal = "a photo is already being made for it"; return undefined; }
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

/** The item after a finished photo: added to its generations and made the photo it shows. Pure. */
function landed(base, { genId, gen, claimAt }) {
  const p = base || {};
  const next = { ...p, gens: { ...(p.gens || {}), [genId]: gen }, genId, use: "generated" };
  if (p.generating && p.generating.at === claimAt) delete next.generating;
  return core.withRev(next, base);
}

async function addSpend(db, zar) {
  if (!(Number.isFinite(zar) && zar > 0)) return;
  try { await db.ref(`${core.ROOT}/stats`).update({ spentZar: admin.database.ServerValue.increment(zar) }); }
  catch (e) { console.error(`bfGenerate: spend of R${zar} not counted — ${e.message}`); }
}

/**
 * deps (injectable for tests): { bucket, apiKey, now(), engine?, image?, fetchBytes?, assets?, correct?, sharp?, fx? }
 * → { ok, pid, genId, costZar, width, height, mime, item }
 */
async function bfGenerate(db, { key, pid }, uid, deps, emit = () => {}) {
  if (await pauseSwitch.isPaused(db, "generation")) throw new HttpsError("failed-precondition", "Paused — generation is switched off on the New Arrivals card.");
  if (!core.KEY_RE.test(String(key || ""))) throw new HttpsError("invalid-argument", "Which group?");
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Not a product id.");
  const inGroup = await val(db, `${core.ROOT}/groups/${key}/items/${pid}`);
  if (!inGroup) throw new HttpsError("invalid-argument", "That item is not in this group.");
  const product = await val(db, `products/${pid}`);
  if (!product) throw new HttpsError("failed-precondition", "Can't generate — the product record no longer exists.");
  const e = deps.engine || await engine();
  const { studio, gemini, record, compose } = await e.mods();
  const sharp = deps.sharp || require("sharp");
  const now = deps.now || (() => Date.now());
  const fxAt = (t) => (deps.fx ? deps.fx(t) : e.usdZarToday(db, t)).catch(() => ({ rate: e.prices.usdToZar, fallback: true }));
  const t0 = now();
  await claim(db, pid, uid, t0);
  const genId = `g${t0}`;
  const generation = { ...e.generation, imageSize: BF_IMAGE_SIZE };
  const model = generation.imageModel;
  const bucket = deps.bucket;
  let final = null;
  const upload = async (p, buf, mime) => {
    // Everything Black Friday makes lives under black_friday/, never beside New Arrivals' photos.
    const bfPath = String(p).replace("/new_arrivals/", "/black_friday/");
    const r = await e.uploadImmutable(bucket, bfPath, buf, mime);
    if (/\/gen_\d+\.(png|jpg|webp)$/.test(bfPath)) {
      const m = await sharp(buf).metadata().catch(() => ({}));
      final = { width: m.width || null, height: m.height || null, mime, bytes: buf.length };
    }
    return r;
  };
  let res;
  try {
    res = await studio.generateOne({
      item: { pid, categoryKey: product.categoryKey || null }, product, genId, method: "full", provider: "gemini", emit,
      deps: {
        fetchBytes: deps.fetchBytes || e.fetchBytes,
        loadPlate: (kind) => e.loadRoleFile(bucket, compose.ROLES[kind].plate, compose.forModel),
        loadReference: (kind) => (compose.ROLES[kind].reference ? e.loadRoleFile(bucket, compose.ROLES[kind].reference, compose.forModel) : null),
        libraryBox: (k) => e.libraryBox(bucket, k),
        loadExamples: (kind, { brand = null } = {}) => e.loadExamples(bucket, compose.forModel, brand),
        ...(deps.assets || {}),
        spec: e.spec, generation, conditionClause: e.CONDITION_CLAUSE,
        ...(deps.correct ? { correct: deps.correct } : {}),
        finish: losslessFinish(sharp), lossless: true,
        image: e.atModelCall(db, deps.image || ((m, parts, imageConfig, opts) => gemini.streamImage(m, parts, imageConfig, { ...opts, apiKey: deps.apiKey }))),
        upload, now,
        log: (m) => console.warn(`bfGenerate: ${pid} — ${m}`),
      },
    });
  } catch (err) {
    const status = Number(err.status) || 0;
    const reason = err.paid ? "the photo was made but could not be stored — it was charged; tap Generate to make another"
      : err.studioRefusal ? err.message
      : err.refusal ? "Gemini declined to make this photo"
      : status === 402 ? "the Gemini prepaid credit has run out — top it up in Google AI Studio, then tap Generate again"
      : status === 429 || status === 503 ? "the photo service is busy — tap Generate again"
      : "the photo could not be made — tap Generate again";
    await release(db, pid, t0);
    console.error(`bfGenerate: ${pid} failed${err.paid ? " AFTER the image was made" : ""} — ${err.message}`);
    if (err.paid || err.usage) {
      const fx = await fxAt(now());
      const lost = err.paid ? record.generationCost({ model, usage: err.usage, prices: e.prices, fx }) : null;
      await addSpend(db, lost ? lost.zar : record.failedCallZar({ model, usage: err.usage, prices: e.prices, fx }));
    }
    throw new HttpsError(err.studioRefusal ? "failed-precondition" : status === 402 ? "resource-exhausted" : status === 429 || status === 503 ? "unavailable" : "internal", `No photo — ${reason}.`);
  }

  const at = now();
  const fx = await fxAt(at);
  const cost = record.generationCost({ model, usage: res.usage, prices: e.prices, fx });
  const gen = {
    url: res.generated.url, path: res.generated.path || null, at, model, imageSize: BF_IMAGE_SIZE,
    costZar: Number.isFinite(cost.zar) ? cost.zar : null, costEstimated: !!cost.estimated,
    ...(final || {}), kind: res.kind || null,
    ...(res.note ? { note: res.note } : {}), ...(res.corrected !== undefined ? { corrected: !!res.corrected } : {}),
  };
  for (const [k, v] of Object.entries(gen)) if (v === null || v === undefined) delete gen[k];
  const ref = db.ref(`${core.ROOT}/photos/${pid}`);
  const pre = (await ref.once("value")).val();
  let saved = null;
  try {
    const done = await studio.withRetries(() => ref.transaction((cur) => {
      const base = cur === null ? pre : cur;
      if (base && base.gens && base.gens[genId]) return undefined; // an earlier try landed it
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
  await db.ref(`${core.ROOT}/decisions`).push().set({ at: t0, by: uid || null, action: "generate", key, pid, genId }).catch(() => {});
  return { ok: true, pid, genId, costZar: gen.costZar || null, width: gen.width || null, height: gen.height || null, mime: gen.mime || null };
}

const bfGenerateFn = onCall(
  // 2 vCPU for sharp; a 4K generation holds a few hundred MB of images. Not retried.
  { region: "europe-west1", memory: "2GiB", cpu: 2, timeoutSeconds: 540, concurrency: 3, maxInstances: 3, secrets: [geminiApiKey], invoker: "public" },
  async (request, response) => {
    if (!isSuperAdminToken(request.auth && request.auth.token)) throw new HttpsError("permission-denied", "The Black Friday card is Junid's.");
    const emit = request.acceptsStreaming && response ? (ev) => { response.sendChunk(ev); } : () => {};
    const d = request.data || {};
    const e = await engine();
    return bfGenerate(admin.database(), { key: d.key, pid: d.pid }, request.auth.uid,
      { bucket: admin.storage().bucket(e.BUCKET), apiKey: geminiApiKey.value() }, emit);
  },
);

module.exports = { bfGenerate: bfGenerateFn, _internals: { bfGenerate, losslessFinish, landed, claim, release, BF_IMAGE_SIZE } };
