// ─── NEW ARRIVALS — THE PHOTO STUDIO (one streaming callable) ────────────────
// newArrivalsStudio   Junid taps Generate / Regenerate on ONE item. This calls
//                     Gemini directly and answers on the same connection: the
//                     thought summary and the interim drafts while it works,
//                     then the finished photo. No request queue, no Mac mini.
//
// EVERYTHING IS MANUAL (Junid, 4 Oct): Gemini is called here and only here,
// once per tap. No checker, no verdict, no retry, no automatic anything.
//
// The generation code is studio/*.mjs (ES modules, loaded on first use). The
// plates, references and brand boxes are Junid's own photos, read from Storage
// (new_arrivals/assets/…) and verified against studio/config/plates.lock.json.
//
// Deploy BY NAME, never a bare --only functions:
//   firebase deploy --only functions:newArrivalsStudio --project=marathon-club
"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("node:crypto");
const core = require("./core.cjs");
const na = require("./newArrivals.js");
const { CONDITION_CLAUSE } = require("../lib/photo-prompt.cjs");

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const BUCKET = "marathon-club.firebasestorage.app";
const ASSETS = "new_arrivals/assets";

const generation = require("./studio/config/generation.json");
const spec = require("./studio/config/layout-spec.json");
const prices = require("./studio/config/prices.json");
const platesLock = require("./studio/config/plates.lock.json");

// The ES modules, loaded once per instance.
let modsP = null;
const mods = () => (modsP ||= Promise.all([
  import("./studio/studio.mjs"), import("./studio/gemini-stream.mjs"), import("./studio/record.mjs"), import("./studio/compose.mjs"),
]).then(([studio, gemini, record, compose]) => ({ studio, gemini, record, compose })));

const val = async (db, path) => (await db.ref(path).once("value")).val();
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ── storage ──────────────────────────────────────────────────────────────────
const downloadUrl = (bucketName, objectPath, token) =>
  `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;

/** Upload bytes with a Firebase download token; never overwrites. → { path, url } */
async function uploadImmutable(bucket, objectPath, buffer, contentType) {
  const token = crypto.randomUUID();
  await bucket.file(objectPath).save(buffer, {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { contentType, cacheControl: "public, max-age=31536000, immutable", metadata: { firebaseStorageDownloadTokens: token } },
  });
  return { path: objectPath, url: downloadUrl(bucket.name, objectPath, token) };
}

async function fetchBytes(url, { timeoutMs = 60_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`fetch ${res.status} for ${String(url).slice(0, 80)}`);
  return { buffer: Buffer.from(await res.arrayBuffer()) };
}

// Junid's plates and references: read once per instance, verified against the
// lock (a changed file is refused, never used), their model-sized copy kept.
const assetCache = new Map();
function loadRoleFile(bucket, file, forModel) {
  if (!assetCache.has(file)) {
    assetCache.set(file, (async () => {
      const entry = platesLock[file];
      if (!entry) throw new Error(`${file} is not one of Junid's locked plates`);
      const [buffer] = await bucket.file(`${ASSETS}/plates/${file}`).download();
      if (sha256(buffer) !== entry.sha256) throw new Error(`${file} in Storage is not the locked plate — refusing to use it`);
      return { buffer, width: entry.width, height: entry.height, file, sha256: entry.sha256, forModel: await forModel(buffer) };
    })().catch((e) => { assetCache.delete(file); throw e; }));
  }
  return assetCache.get(file);
}

// The brand box library: sources.json names each brand's box file.
let boxIndexP = null;
async function libraryBox(bucket, key) {
  if (!key) return null;
  boxIndexP ||= bucket.file(`${ASSETS}/boxes/sources.json`).download().then(([b]) => JSON.parse(b.toString("utf8"))).catch((e) => { boxIndexP = null; throw e; });
  let index;
  try { index = await boxIndexP; } catch { return null; } // unreadable index: no box, never a wrong one
  const e = index[key];
  if (!e) return null;
  const file = e.file || `${key}.png`;
  const k = `box:${file}`;
  if (!assetCache.has(k)) {
    assetCache.set(k, bucket.file(`${ASSETS}/boxes/${file}`).download().then(([buffer]) => ({ buffer, kind: e.kind || "library" })).catch(() => { assetCache.delete(k); return null; }));
  }
  return assetCache.get(k);
}

// ── the day's USD/ZAR rate ───────────────────────────────────────────────────
// One lookup a day (ECB reference rates, frankfurter.app — public, no key),
// kept at new_arrivals/fx/{day}. A failed lookup uses the configured rate and
// is NOT kept, so the next generation tries again.
async function usdZarToday(db, nowMs, fetchImpl = fetch) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const ref = db.ref(`${core.ROOT}/fx/${day}`);
  const cached = (await ref.once("value")).val();
  if (cached && Number(cached.rate) > 0) return cached;
  try {
    const r = await fetchImpl("https://api.frankfurter.app/latest?from=USD&to=ZAR", { signal: AbortSignal.timeout(8_000) });
    const j = await r.json();
    const rate = Number(j?.rates?.ZAR);
    if (!(rate > 5 && rate < 50)) throw new Error(`implausible rate ${rate}`);
    const out = { rate, day, source: `ECB via frankfurter.app (${j.date})` };
    await ref.set(out);
    return out;
  } catch (e) {
    return { rate: prices.usdToZar, day, source: `configured fallback (rate lookup failed: ${String(e.message).slice(0, 60)})`, fallback: true };
  }
}

// ── the claim ────────────────────────────────────────────────────────────────
// Marks the item "a photo is being made" (generateRequest, stamped studio) so
// Approve and Use-this-one wait and a second tap is refused. The item keeps
// its lane and every photo it has.
async function claim(db, pid, uid, nowMs) {
  const out = {};
  let prev = null;
  const res = await db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => {
    // Cold-cache null: commit nothing; the server's compare-and-retry supplies the item.
    if (!cur) { out.refusal = "it is not in the New Arrivals queue"; return null; }
    if (!core.SELECT_LANES.includes(cur.status)) { out.refusal = `it is ${cur.status}, not on the New tab`; return undefined; }
    if (core.requestPending(cur, nowMs)) { out.refusal = "a photo is already being made for it"; return undefined; }
    out.refusal = null;
    prev = cur;
    const fresh = cur.status === "new" && !cur.currentGen;
    const next = {
      ...cur,
      generateRequest: { at: nowMs, by: uid || "unknown", studio: true, ...(fresh ? {} : { regenerate: true }) },
      ...(fresh ? {} : { ...na._internals.NEW_LAP, rejection: cur.rejection || null, lastRejection: cur.rejection || cur.lastRejection || null }),
    };
    for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
    return next;
  });
  const item = res && res.committed && res.snapshot && res.snapshot.val();
  if (!item || out.refusal || !item.generateRequest || item.generateRequest.at !== nowMs) {
    throw new HttpsError("failed-precondition", `Can't generate — ${out.refusal || "not saved"}.`);
  }
  return { item, prev };
}

/** Give the item back after a failed generation: the request cleared, a plain note left. Never throws. */
async function release(db, pid, claimAt, nowMs, reason) {
  try {
    await db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => {
      if (!cur) return null;
      if (!cur.generateRequest || cur.generateRequest.at !== claimAt) return undefined;
      const next = { ...cur, lastAttempt: { at: nowMs, failed: true, reason } };
      delete next.generateRequest;
      return next;
    });
  } catch (e) { console.error(`newArrivalsStudio: ${pid} not released — ${e.message}`); }
}

/** The fields a finished photo sets (the Mac mini worker's readyFields + generation). Pure. */
function landedFields(cur, { genId, gen, res, at }) {
  const n = (Number(cur.attempts) || 0) + 1;
  return {
    generations: { ...(cur.generations || {}), [genId]: gen },
    currentGen: genId,
    generatedUrl: res.generated.url, generatedPath: res.generated.path || null,
    plateId: `junid-${res.kind}`,
    boxInOriginal: res.box ? res.box.mode === "own" : false,
    boxUsed: res.box ? { mode: res.box.mode, source: res.box.source || null, brand: res.box.brand || null } : null,
    verdict: null, framingFlag: null, checker: null, layoutCheck: null, colourCheck: null,
    rejection: null,
    // The name suggester runs after Approve (the mini's naming job reads this).
    naming: { status: "pending", since: at, tries: 0, overloads: 0 },
    namePending: null, suggestedName: null, suggestedNameSource: null, nameProposedAt: null,
    attempts: n, attemptsSinceRetry: 0, infraErrors: null, busyAnswers: null,
    lastAttempt: { at, n, generatedUrl: res.generated.url },
    generateRequest: null,
  };
}

// ── one generation ───────────────────────────────────────────────────────────
/**
 * deps (all injectable for tests): { bucket, apiKey, now(), fetchBytes?, image?, fx?, assets? }
 * emit(ev): progress chunks for the card.
 * → { ok, pid, genId, code, seconds, item (as the card shows it) }
 */
async function studioGenerate(db, { pid, method }, uid, deps, emit = () => {}) {
  if (!core.PID_RE.test(String(pid || ""))) throw new HttpsError("invalid-argument", "Not a product id.");
  if (method !== undefined && method !== null && !core.METHODS.includes(method)) throw new HttpsError("invalid-argument", "Method is full or split.");
  pid = String(pid);
  const { studio, gemini, record, compose } = await mods();
  const now = deps.now || (() => Date.now());
  const t0 = now();
  const product = await val(db, `products/${pid}`);
  if (!product) throw new HttpsError("failed-precondition", "Can't generate — the product record no longer exists.");
  const { item, prev } = await claim(db, pid, uid, t0);
  const genId = `g${t0}`;
  const how = studio.methodFor(item, { asked: method || null, defaultMethod: generation.defaultMethod });
  const bucket = deps.bucket;
  let res;
  try {
    res = await studio.generateOne({
      item: { ...item, pid }, product, genId, method: how, emit,
      deps: {
        fetchBytes: deps.fetchBytes || fetchBytes,
        loadPlate: (kind) => loadRoleFile(bucket, compose.ROLES[kind].plate, compose.forModel),
        loadReference: (kind) => (compose.ROLES[kind].reference ? loadRoleFile(bucket, compose.ROLES[kind].reference, compose.forModel) : null),
        libraryBox: (key) => libraryBox(bucket, key),
        ...(deps.assets || {}),
        spec, generation, conditionClause: CONDITION_CLAUSE,
        image: deps.image || ((model, parts, imageConfig, opts) => gemini.streamImage(model, parts, imageConfig, { ...opts, apiKey: deps.apiKey })),
        upload: (p, buf, mime) => uploadImmutable(bucket, p, buf, mime),
        now,
        ...(deps.split ? { split: deps.split } : {}),
      },
    });
  } catch (e) {
    const busy = /\b(503|429|high demand|overloaded)\b/i.test(String(e.message));
    const reason = e.studioRefusal ? e.message
      : e.refusal ? `Gemini declined to make this photo (${String(e.message).slice(0, 140)})`
      : busy ? "the photo service is busy — tap Generate again"
      : `the photo could not be made (${String(e.message).slice(0, 140)}) — tap Generate again`;
    await release(db, pid, t0, now(), reason);
    console.error(`newArrivalsStudio: ${pid} failed — ${e.message}`);
    throw new HttpsError(e.studioRefusal ? "failed-precondition" : busy ? "unavailable" : "internal", `No photo — ${reason}.`);
  }

  // The photo exists and is paid for: from here nothing may lose it.
  const at = now();
  const fx = await (deps.fx ? deps.fx(at) : usdZarToday(db, at)).catch(() => ({ rate: prices.usdToZar, fallback: true }));
  const cost = record.generationCost({ model: generation.imageModel, usage: res.usage, prices, fx });
  let code = null;
  try {
    const seq = await db.ref(record.GENSEQ).transaction((cur) => (Number(cur) || 0) + 1);
    if (seq && seq.committed) code = record.formatCode(Number(seq.snapshot.val()));
  } catch (e) { console.error(`newArrivalsStudio: ${pid} has no code yet — ${e.message}`); }
  const reason = item.generateRequest.regenerate ? "regenerate" : "requested";
  const gen = record.generationEntry(res, { at, cost, model: generation.imageModel, reason, code, draftCount: res.draftFiles.length });

  const out = {};
  const landed = await db.ref(`${core.ITEMS}/${pid}`).transaction((cur) => {
    if (!cur) return null;
    out.from = cur.status;
    // Skipped while it was being made: the photo is kept on the item, the item stays skipped.
    const to = core.SELECT_LANES.includes(cur.status) ? "ready" : cur.status;
    const next = { ...cur, ...landedFields(cur, { genId, gen, res, at }), status: to, ...(to !== cur.status ? { statusAt: at } : {}) };
    if (cur.status === "rejected" && cur.rejection) next.lastRejection = cur.rejection;
    for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
    return next;
  });
  const final = landed && landed.committed && landed.snapshot && landed.snapshot.val();
  if (!final || !final.generations || !final.generations[genId]) {
    console.error(`newArrivalsStudio: ${pid} photo ${res.generated.path} made but not saved on the item`);
    throw new HttpsError("internal", "The photo was made but could not be saved on the item — tap Generate again.");
  }

  // ONE multi-path write: the lane index, Junid's ledger row, the learning log, the spend.
  const full = record.genlogRecord({ code, pid, genId, gen, trace: res.trace, totalMs: at - t0 });
  const paths = {
    ...core.indexMove(pid, out.from, final.status, final.enqueuedAt),
    ...await na._internals.decisionPaths(db, pid, { at: t0, uid, item: prev, action: prev.status === "new" && !prev.currentGen ? "generate" : "regenerate" }),
    ...(code ? { [`genlog/${code}`]: record.rtdbGenlog(full) } : {}),
    "stats/totalSpentZar": admin.database.ServerValue.increment(cost.zar),
    "stats/generations": admin.database.ServerValue.increment(1),
    ...(cost.estimated ? { "stats/estimatedPartZar": admin.database.ServerValue.increment(cost.zar) } : {}),
    "stats/updatedAt": at,
  };
  try { await db.ref(core.ROOT).update(paths); }
  catch (e) { console.error(`newArrivalsStudio: ${pid} bookkeeping write failed — ${e.message}`); }
  // The FULL record, prompt text included, kept beside the photo (never read by the card).
  try {
    await bucket.file(`products/${pid}/new_arrivals/${genId}.genlog.json`).save(Buffer.from(JSON.stringify(full, null, 1)), { resumable: false, metadata: { contentType: "application/json" } });
  } catch (e) { console.error(`newArrivalsStudio: ${pid} full record not stored — ${e.message}`); }

  return { ok: true, pid, genId, code, seconds: Math.round((now() - t0) / 100) / 10, costZar: cost.zar, costEstimated: cost.estimated, item: core.cardItem(final) };
}

const newArrivalsStudio = onCall(
  // 2 vCPU for sharp; one generation holds ~200 MB of images. Not retried, not scheduled.
  { region: "europe-west1", memory: "2GiB", cpu: 2, timeoutSeconds: 540, concurrency: 4, maxInstances: 5, secrets: [geminiApiKey] },
  async (request, response) => {
    await na._internals.assertNewArrivalsAccess(request);
    const emit = request.acceptsStreaming && response ? (ev) => { response.sendChunk(ev); } : () => {};
    const d = request.data || {};
    return studioGenerate(admin.database(), { pid: d.pid, method: d.method }, request.auth?.uid,
      { bucket: admin.storage().bucket(BUCKET), apiKey: geminiApiKey.value() }, emit);
  },
);

module.exports = {
  newArrivalsStudio,
  // for tests
  _internals: { studioGenerate, claim, release, landedFields, usdZarToday, uploadImmutable, mods },
};
