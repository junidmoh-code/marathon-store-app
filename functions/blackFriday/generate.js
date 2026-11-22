// ─── BLACK FRIDAY 2026 — Generate (one AI photo, on Junid's tap) ─────────────
// bfGenerate  Junid taps Generate / Regenerate on ONE product of the Black
//             Friday card. One tap = one photo. Never automatic, never retried.
//
// ONE SHARED GENERATOR (Junid, 20 Nov 2026): every product, whatever its kind,
// is made by studio.generate (functions/newArrivals/studio/studio.mjs) — the
// SAME function New Arrivals' Generate calls, with the same deps: the
// last-good New Arrivals request (studio-2026-10-04.1: model, prompt text,
// references, layout, Gemini composing the whole photo — no plate-lock paste),
// generation.json's model and size (4K), and one finishing step (the master at
// the model's full resolution, JPEG q92). There is no Black Friday prompt, size
// or finishing of its own here. A kind with no New Arrivals plate (caps,
// perfume, bags …) is handed over as `look`, and the shared generator stages it
// (studio/staging.cjs) through that same model, size and finishing.
// A result that is really the original photo is never shown as generated: the
// shared generator refuses it before it is stored and tries ONCE more with the
// product cut out of the staff photo onto plain white (20 Nov 2026). Only if
// that is refused too does the card say "Failed, tap to retry". Junid can also
// ask for the cleaned input directly (data.input "cutout"), with an explicit
// place-it note (data.place) or a clean catalogue photo already in Storage as
// a second reference (data.secondRefUrl).
// The New Arrivals generation pause stops this too.
//
// GENERATE ON EVERY PRODUCT (Junid, 20 Nov 2026): every kind, every tab —
// New Arrivals not in the build included (their row is made from the product
// now). FROM HIS OWN PHOTO: when the product has a source photo on the card
// (photos/{pid}/srcId — Replace photo or Find online), the shared generator is
// handed THAT photo as the product photo, in place of the app's; nothing else
// about the request changes (same prompt, model, size, finishing — the prompt
// already keeps the product exactly as the photo shows it: colour, logos,
// details). An APPROVED product keeps posting its approved photo: a new photo
// is added beside it until Junid picks it.
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

// A New Arrival not in the build (lazy: New Arrivals' module is only loaded when needed).
const naRow = (db, pid) => require("./na.cjs").campaignRowOfNa(db, pid, Date.now(), require("../newArrivals/newArrivals.js"));

let engineP = null;
const engine = () => (engineP ||= Promise.resolve().then(() => require("../newArrivals/studio.js").engine));
const val = async (db, path) => (await db.ref(path).once("value")).val();

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

/** The product after a finished photo: added to its generations and made the photo it shows (unless keepChoice). Pure. */
function landed(base, { genId, gen, claimAt, keepChoice = false }) {
  const p = base || {};
  const next = keepChoice ? { ...p, gens: { ...(p.gens || {}), [genId]: gen } } : { ...p, gens: { ...(p.gens || {}), [genId]: gen }, genId, use: "generated" };
  delete next.failed; // a photo landed: no longer "Failed, tap to retry"
  if (p.generating && p.generating.at === claimAt) delete next.generating;
  return core.withRev(next, base);
}

/**
 * deps (injectable for tests): { bucket, apiKey, now(), engine?, image?, fetchBytes?, assets?, correct?, sharp?, fx? }
 * → { ok, pid, genId, kind, costZar, width, height, mime }
 */
/**
 * hold (the clothing regeneration run of 22 Nov 2026, never a tap on the card): the photo the card shows is left in
 * place unless the new one PASSED the garment gate — a flagged or unchecked photo is only added beside it.
 */
async function bfGenerate(db, { pid, section, input = "photo", place = false, secondRefUrl = null, hold = false }, uid, deps, emit = () => {}) {
  if (!["photo", "cutout"].includes(input)) throw new HttpsError("invalid-argument", "input is photo or cutout.");
  if (await pauseSwitch.isPaused(db, "generation")) throw new HttpsError("failed-precondition", "Paused — generation is switched off on the New Arrivals card.");
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Not a product id.");
  const order = core.SECTIONS.includes(section) ? [section, ...core.SECTIONS.filter((s) => s !== section)] : core.SECTIONS;
  let item = null;
  for (const s of order) { item = await val(db, `${core.ROOT}/items/${s}/${pid}`); if (item) break; }
  // A New Arrival not in the build: its row made from the product now.
  if (!item && deps.naRow) item = await deps.naRow(pid).catch(() => null);
  if (!item) throw new HttpsError("invalid-argument", "That product is not in the campaign.");
  const product0 = await val(db, `products/${pid}`);
  if (!product0) throw new HttpsError("failed-precondition", "Can't generate — the product record no longer exists.");
  // His own photo, when he chose one: the shared generator's source rule picks it up as the product photo.
  const photoNode = await val(db, `${core.ROOT}/photos/${pid}`);
  const source = core.sourceOf(photoNode);
  const product = source ? { ...product0, photoUrl: source.url, photoUrlOriginal: null, photoSourceUrl: null } : product0;
  // Approved now with the photo it shows: the new photo waits beside it (the approved photo keeps posting).
  const pickNow = await val(db, `${core.ROOT}/picks/${pid}`);
  const keepChoice = !!pickNow && pickNow.state === "approved" && (pickNow.src === "na" || core.isApproved(pickNow, photoNode));
  const kind = item.kind || "clothing";
  const e = deps.engine || await engine();
  const mods = await e.mods();
  const { studio, gemini, record, compose } = mods;
  const sharp = deps.sharp || require("sharp");
  const now = deps.now || (() => Date.now());
  const fxAt = (t) => (deps.fx ? deps.fx(t) : e.usdZarToday(db, t)).catch(() => ({ rate: e.prices.usdToZar, fallback: true }));
  const keepFailedCost = async (usages) => {
    for (const u of usages) {
      if (!u) continue;
      const c = record.generationCost({ model: e.generation.imageModel, usage: u, prices: e.prices, fx: await fxAt(now()), imageSize: e.generation.imageSize });
      if (Number.isFinite(c.zar) && c.zar > 0) await db.ref(`${core.ROOT}/stats`).update({ failedZar: admin.database.ServerValue.increment(c.zar) }).catch(() => {});
    }
  };
  const t0 = now();
  await claim(db, pid, uid, t0);
  const genId = `g${t0}`;
  const model = e.generation.imageModel;
  const bucket = deps.bucket;
  let res, final = null;
  const finals = new Map(); // each stored photo's own size, by path: the KEPT one is read after generate (it may be the first of two)
  try {
    // Sneakers and clothing: the product's own category whenever New Arrivals can frame it; only an unknown
    // one is mapped to a plate. Every other kind: the shared generator's staging for that kind (`look`).
    const established = styles.ESTABLISHED.includes(kind);
    const asProduct = !established || compose.kindFor(product) ? product
      : { ...product, categoryKey: kind === "sneakers" ? "sneakers" : styles.clothingKeyFor(product.categoryKey) };
    const upload = async (p, buf, mime) => {
      const bfPath = String(p).replace("/new_arrivals/", "/black_friday/");
      const r = await e.uploadImmutable(bucket, bfPath, buf, mime);
      if (/\/gen_\d+\.(png|jpg|webp)$/.test(bfPath)) { const m = await sharp(buf).metadata().catch(() => ({})); final = { width: m.width || null, height: m.height || null, mime, bytes: buf.length }; finals.set(r.path || bfPath, final); }
      return r;
    };
    res = await studio.generate({
      item: { pid, categoryKey: asProduct.categoryKey || null, name: product.name || null }, product: asProduct, genId, method: "full", provider: "gemini",
      look: established ? null : kind, input, placeNote: place === true, secondRef: secondRefUrl ? { url: String(secondRefUrl) } : null, emit,
      deps: {
        fetchBytes: deps.fetchBytes || e.fetchBytes,
        loadPlate: (k) => e.loadRoleFile(bucket, compose.ROLES[k].plate, compose.forModel),
        loadReference: (k) => (compose.ROLES[k].reference ? e.loadRoleFile(bucket, compose.ROLES[k].reference, compose.forModel) : null),
        loadPlateFile: (file) => e.loadRoleFile(bucket, file, compose.forModel),
        libraryBox: (k) => e.libraryBox(bucket, k),
        loadExamples: (k, { brand = null } = {}) => e.loadExamples(bucket, compose.forModel, brand),
        ...(deps.assets || {}),
        // New Arrivals' own settings: the same objects New Arrivals' Generate passes. Nothing of Black Friday's.
        spec: e.spec, generation: e.generation, conditionClause: e.CONDITION_CLAUSE,
        ...(deps.correct ? { correct: deps.correct } : {}),
        image: e.atModelCall(db, deps.image || ((m, p, c, o) => gemini.streamImage(m, p, c, { ...o, apiKey: deps.apiKey }))),
        cutout: deps.cutout || e.cutout,
        upload, now, log: (m) => console.warn(`bfGenerate: ${pid} — ${m}`),
        // The Style Kit Catalogue + the drift check (studio/kit.mjs) — the same two deps New Arrivals passes.
        ...(deps.kit === true ? mods.kit.studioKitDeps({ db, apiKey: deps.apiKey, fetchBytes: deps.fetchBytes || e.fetchBytes, log: (m) => console.warn(`bfGenerate: ${pid} — ${m}`) }) : (deps.kit || {})),
      },
    });
  } catch (err) {
    const status = Number(err.status) || 0;
    const reason = err.echo ? (err.cutoutFailed ? "Failed, tap to retry — the model gave back the original photo and it could not be cut out cleanly to try again, so nothing was charged" : "Failed, tap to retry — the model gave back the original photo, even from the cleaned cut-out, so nothing was charged")
      : err.paid ? "the photo was made but could not be stored — it was charged; tap Generate to make another"
      : err.studioRefusal ? err.message
      : err.refusal ? "Gemini declined to make this photo"
      : status === 402 ? "the Gemini prepaid credit has run out — top it up in Google AI Studio, then tap Generate again"
      : status === 429 || status === 503 ? "the photo service is busy — tap Generate again"
      : "the photo could not be made — tap Generate again";
    await release(db, pid, t0);
    console.error(`bfGenerate: ${pid} (${kind}) failed${err.paid ? " AFTER the image was made" : ""} — ${err.message}`);
    // The card shows "Failed, tap to retry" from this mark; the next successful photo clears it.
    await db.ref(`${core.ROOT}/photos/${pid}/failed`).set({ at: now(), reason: String(reason).slice(0, 200) }).catch(() => {});
    if (err.echo || err.wastedUsages) {
      // Nothing charged to the item or the card's AI spend; the provider's real cost (a whole image each) is kept apart.
      await keepFailedCost([...(err.wastedUsages || []), ...(err.echo ? [err.usage] : [])]);
    }
    if (!err.echo && (err.paid || err.usage)) {
      const fx = await fxAt(now());
      const lost = err.paid ? record.generationCost({ model, usage: err.usage, prices: e.prices, fx, imageSize: e.generation.imageSize }) : null;
      const zar = lost ? lost.zar : record.failedCallZar({ model, usage: err.usage, prices: e.prices, fx });
      if (Number.isFinite(zar) && zar > 0) await db.ref(`${core.ROOT}/stats`).update({ spentZar: admin.database.ServerValue.increment(zar) }).catch(() => {});
    }
    throw new HttpsError(err.studioRefusal ? "failed-precondition" : status === 402 ? "resource-exhausted" : status === 429 || status === 503 ? "unavailable" : "internal", `No photo — ${reason}.`);
  }

  if (res.generated && finals.has(res.generated.path)) final = finals.get(res.generated.path);
  await keepFailedCost(res.wastedUsages || []);
  // What the tries before the kept photo cost (booked apart as failedZar above) — reported to the caller.
  let wastedZar = 0;
  for (const u of res.wastedUsages || []) { if (!u) continue; const c = record.generationCost({ model, usage: u, prices: e.prices, fx: await fxAt(now()), imageSize: e.generation.imageSize }); if (Number.isFinite(c.zar)) wastedZar += c.zar; }
  const at = now();
  const cost = record.generationCost({ model, usage: res.usage, prices: e.prices, fx: await fxAt(at), imageSize: e.generation.imageSize });
  const gen = {
    url: res.generated.url, path: res.generated.path || null, at, model, imageSize: e.generation.imageSize, kind,
    pipeline: "shared", finish: studio.SHARED_FINISH, ...(res.look ? { look: res.look } : {}),
    input: res.input || "photo", ...(res.echoFallback ? { echoFallback: true } : {}), ...(res.placeNote ? { placeNote: true } : {}), ...(res.secondRef ? { secondRef: res.secondRef } : {}),
    costZar: Number.isFinite(cost.zar) ? cost.zar : null, costEstimated: !!cost.estimated,
    ...(final || {}), ...(res.note ? { note: res.note } : {}),
    ...(source ? { fromSrc: source.id, fromSrcKind: source.src } : {}),
    ...(res.styleKit ? { styleKit: res.styleKit } : {}), ...(res.drift ? { drift: res.drift } : {}), ...(res.driftFallback ? { driftFallback: res.driftFallback } : {}),
    // The garment gate (22 Nov 2026): steamed by the second pass; kept as the better of two failed tries, FLAGGED.
    ...(res.pressed ? { pressed: true } : {}), ...(res.qcFlagged ? { flagged: true } : {}), ...(res.qcOther ? { qcOther: res.qcOther } : {}),
  };
  // Did it pass the garment gate? (Only a garment is gated; an unchecked photo did not pass.)
  const passed = studio.passedGarmentGate(res);
  // Only a photo the gate judged can be held: a product that is not gated as a garment lands as on any tap.
  const held = hold === true && studio.garmentGated(res) && !passed;
  for (const [k, v] of Object.entries(gen)) if (v === null || v === undefined) delete gen[k];
  const ref = db.ref(`${core.ROOT}/photos/${pid}`);
  const pre = (await ref.once("value")).val();
  let saved = null;
  try {
    const done = await studio.withRetries(() => ref.transaction((cur) => {
      const base = cur === null ? pre : cur;
      if (base && base.gens && base.gens[genId]) return undefined;
      return landed(base, { genId, gen, claimAt: t0, keepChoice: keepChoice || held });
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
  return { ok: true, pid, genId, kind, url: gen.url, costZar: gen.costZar || null, width: gen.width || null, height: gen.height || null, mime: gen.mime || null, ...(source ? { fromSrc: source.id } : {}), ...(keepChoice ? { keptApproved: true } : {}),
    ...(res.qcFlagged ? { flagged: true, note: gen.note || null } : {}), ...(held ? { held: true } : {}), passed, drift: gen.drift || null, wastedZar };
}

const bfGenerateFn = onCall(
  { region: "europe-west1", memory: "2GiB", cpu: 2, timeoutSeconds: 540, concurrency: 3, maxInstances: 3, secrets: [geminiApiKey], invoker: "public" },
  async (request, response) => {
    if (!isSuperAdminToken(request.auth && request.auth.token)) throw new HttpsError("permission-denied", "The Black Friday card is Junid's.");
    const emit = request.acceptsStreaming && response ? (ev) => { response.sendChunk(ev); } : () => {};
    const d = request.data || {};
    const e = await engine();
    return bfGenerate(admin.database(), { pid: d.pid, section: d.section, input: d.input === "cutout" ? "cutout" : "photo", place: d.place === true, secondRefUrl: typeof d.secondRefUrl === "string" ? d.secondRefUrl : null }, request.auth.uid,
      { bucket: admin.storage().bucket(e.BUCKET), apiKey: geminiApiKey.value(), naRow: (pid) => naRow(admin.database(), pid), kit: true }, emit);
  },
);

module.exports = { bfGenerate: bfGenerateFn, _internals: { bfGenerate, landed, claim, release } };
